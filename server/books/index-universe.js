/**
 * Book A — Index Universe
 *
 * Strategy: Score all S&P 500 constituents. Hold the top composite scorers.
 * Ethics-first: woke score carries higher weight (starting at 0.65).
 *
 * Loop logic:
 *   1. Load book config (capital, current woke/financial weights)
 *   2. Get current positions from Alpaca
 *   3. Compute current portfolio value and cash
 *   4. Snapshot the portfolio
 *   5. Re-score current holdings; sell anything below thresholds or woke floor
 *   6. Scan S&P 500 universe for candidates
 *   7. If cash >= $10, score and buy the best candidates
 *   8. Adjust woke/financial weights based on recent P&L trend
 *
 * No pause checks. No cooldown calls. No hard-stop at TARGET_POSITIONS.
 * TARGET_POSITIONS is used only for position sizing math.
 */

const alpaca = require('../services/alpaca');
const scoring = require('../services/scoring');
const market = require('../services/market');
const guardrails = require('../services/guardrails');
const { getDb } = require('../db/index');
const { logDecision, snapshotPortfolio, getBookCash, adjustWeights } = require('./shared');

const BOOK_ID = 'index';
const TARGET_POSITIONS = 15;          // soft guide for position sizing (not a hard cap)
const SELL_COMPOSITE_THRESHOLD = 45;  // sell if composite drops below this
const BUY_COMPOSITE_THRESHOLD = 60;   // only buy if composite is above this
const CANDIDATES_TO_SCORE = 50;       // score top N by momentum before picking

async function runCycle(cycleCount) {
  const db = getDb();
  console.log(`[book:index] Starting cycle ${cycleCount}`);

  // 1. Load book config — includes current woke_weight and financial_weight
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(BOOK_ID);
  const wokeWeight = book.woke_weight || 0.65;
  const financialWeight = book.financial_weight || 0.35;
  console.log(`[book:index] Current weights — woke: ${wokeWeight}, financial: ${financialWeight}`);

  // 2. Get all Alpaca positions and filter to this book's holdings
  const alpacaPositions = await alpaca.getPositions();

  // Book A tracks its positions by trade history (net long shares per ticker)
  const myTrades = db.prepare(`
    SELECT ticker, SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares
    FROM trades WHERE book_id = ? GROUP BY ticker HAVING net_shares > 0.001
  `).all(BOOK_ID);
  const myTickers = myTrades.map(t => t.ticker);
  const myPositions = alpacaPositions.filter(p => myTickers.includes(p.symbol));

  // 3. Compute cash and total portfolio value
  const cash = await getBookCash(BOOK_ID, book.capital);
  const investedValue = myPositions.reduce((sum, p) => sum + parseFloat(p.market_value), 0);
  const totalValue = cash + investedValue;
  console.log(`[book:index] Portfolio — cash: $${cash.toFixed(0)}, invested: $${investedValue.toFixed(0)}, total: $${totalValue.toFixed(0)}`);

  // 4. Snapshot portfolio state for trend tracking and end-of-day reporting
  await snapshotPortfolio(BOOK_ID, totalValue, cash, investedValue, book.capital);

  // 5. Get market data for current holdings and evaluate each position
  let heldMetrics = [];
  if (myTickers.length > 0) {
    heldMetrics = await market.getTickerMetrics(myTickers);
  }

  for (const pos of myPositions) {
    const ticker = pos.symbol;
    const metricData = heldMetrics.find(m => m.ticker === ticker);
    if (!metricData) {
      console.log(`[book:index] No market data for held position ${ticker}, skipping evaluation.`);
      continue;
    }

    // Score the holding using this book's current weights
    const wokeScore = await scoring.getWokeScore(ticker);
    const financialScore = await scoring.getFinancialScore(ticker, metricData.metrics);
    const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);

    console.log(`[book:index] Evaluating ${ticker} — woke: ${wokeScore.score.toFixed(1)}, financial: ${financialScore.score.toFixed(1)}, composite: ${composite.toFixed(1)}`);

    // Check hard ethical floor and composite threshold
    const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);
    const shouldSell = !wokeCheck.allowed || composite < SELL_COMPOSITE_THRESHOLD;

    if (shouldSell) {
      const reason = !wokeCheck.allowed
        ? wokeCheck.reason
        : `Composite score ${composite.toFixed(1)} fell below threshold ${SELL_COMPOSITE_THRESHOLD}.`;

      console.log(`[book:index] SELL ${ticker}: ${reason}`);
      try {
        const qty = parseFloat(pos.qty);
        await alpaca.placeMarketOrder({ ticker, side: 'sell', qty });
        recordTrade(db, BOOK_ID, ticker, 'sell', qty, parseFloat(pos.current_price), reason, {
          composite, wokeScore: wokeScore.score, financialScore: financialScore.score,
        });
        logDecision(BOOK_ID, cycleCount, 'sell', ticker, reason);
      } catch (e) {
        console.error(`[book:index] Sell order failed for ${ticker}:`, e.message);
      }
    } else {
      // Hold — log the decision with current scores
      logDecision(BOOK_ID, cycleCount, 'hold', ticker,
        `Composite: ${composite.toFixed(1)} | Woke: ${wokeScore.score.toFixed(1)} | Financial: ${financialScore.score.toFixed(1)}`
      );
    }
  }

  // 6. Find new candidates from the full S&P 500 universe
  const currentHoldings = new Set(myTickers);
  const universe = market.getSP500Tickers();
  const universeTickers = universe.map(u => u.ticker).filter(t => !currentHoldings.has(t));

  // 7. Check cash before proceeding to buys
  // We use a fresh cash value here since sells above may have freed up capital
  const freshCash = await getBookCash(BOOK_ID, book.capital);
  if (freshCash < 10) {
    console.log(`[book:index] Cash $${freshCash.toFixed(2)} < $10. Skipping buys.`);
    logDecision(BOOK_ID, cycleCount, 'skip', null, `Cash $${freshCash.toFixed(2)} below minimum. No buys.`);
  } else {
    console.log(`[book:index] $${freshCash.toFixed(0)} available. Scanning ${universeTickers.length} candidates.`);

    // Get market data for all universe tickers, screen and rank by momentum
    const candidateMetrics = await market.getTickerMetrics(universeTickers);
    const screened = market.screenTickers(candidateMetrics);
    const ranked = market.rankByMomentum(screened).slice(0, CANDIDATES_TO_SCORE);

    console.log(`[book:index] Scoring top ${ranked.length} candidates by composite.`);

    // Score each candidate — ethics filter applied here
    const scoredCandidates = [];
    for (const candidate of ranked) {
      const sp500Entry = universe.find(u => u.ticker === candidate.ticker);
      const wokeScore = await scoring.getWokeScore(candidate.ticker, sp500Entry?.company);
      const financialScore = await scoring.getFinancialScore(candidate.ticker, candidate.metrics);
      const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);

      // Hard ethical floor — Book A refuses to hold unethical companies
      const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);
      if (!wokeCheck.allowed) {
        logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, wokeCheck.reason);
        continue;
      }

      if (composite >= BUY_COMPOSITE_THRESHOLD) {
        scoredCandidates.push({
          ...candidate,
          wokeScore: wokeScore.score,
          financialScore: financialScore.score,
          composite,
          wokeExplanation: wokeScore.explanation,
          financialExplanation: financialScore.explanation,
        });
      }
    }

    // Sort by composite score (best first) and buy as many as cash allows
    scoredCandidates.sort((a, b) => b.composite - a.composite);
    console.log(`[book:index] ${scoredCandidates.length} candidates cleared composite threshold.`);

    // Position sizing: use TARGET_POSITIONS as a denominator for sizing,
    // but we don't stop buying at that count — we stop when cash runs out.
    const slotsForSizing = Math.max(TARGET_POSITIONS - currentHoldings.size, 1);

    for (const candidate of scoredCandidates) {
      // Re-check available cash each iteration (may shrink as we buy)
      const availableCash = await getBookCash(BOOK_ID, book.capital);
      if (availableCash < 10) {
        console.log(`[book:index] Cash exhausted ($${availableCash.toFixed(2)}). Stopping buys.`);
        break;
      }

      // Size the position: divide available cash across remaining sizing slots,
      // capped by max_position_pct of total book value and max_trade_size setting
      const maxPosPct = Number(getSetting('max_position_pct')) || 0.10;
      const maxTradeSize = Number(getSetting('max_trade_size')) || 5000;
      const positionValue = Math.min(
        availableCash / slotsForSizing,
        totalValue * maxPosPct,
        maxTradeSize
      );

      if (positionValue < 10) {
        logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, 'Insufficient cash for position.');
        continue;
      }

      // Guardrails position size check
      const sizeCheck = guardrails.checkPositionSize(BOOK_ID, candidate.ticker, positionValue, totalValue);
      if (!sizeCheck.allowed) {
        logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, sizeCheck.reason);
        continue;
      }

      const reason = `Composite: ${candidate.composite.toFixed(1)} | Woke: ${candidate.wokeScore.toFixed(1)} | ${candidate.wokeExplanation}`;
      console.log(`[book:index] BUY ${candidate.ticker} $${positionValue.toFixed(0)}: ${reason}`);

      try {
        await alpaca.placeMarketOrder({ ticker: candidate.ticker, side: 'buy', notional: positionValue });
        const estShares = positionValue / candidate.metrics.price;
        recordTrade(db, BOOK_ID, candidate.ticker, 'buy', estShares, candidate.metrics.price, reason, candidate);
        logDecision(BOOK_ID, cycleCount, 'buy', candidate.ticker, reason);
      } catch (e) {
        console.error(`[book:index] Buy order failed for ${candidate.ticker}:`, e.message);
      }
    }
  }

  // 8. Adjust woke/financial weights based on recent P&L trend
  // This runs at the end of every cycle so the book continuously self-calibrates.
  adjustWeights(BOOK_ID);

  console.log(`[book:index] Cycle ${cycleCount} complete.`);
}

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function recordTrade(db, bookId, ticker, side, shares, price, reasoning, scores) {
  db.prepare(`
    INSERT INTO trades (book_id, ticker, side, shares, price, total_value, reasoning, composite_score, woke_score, financial_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bookId, ticker, side, shares, price, shares * price, reasoning,
    scores.composite || null, scores.wokeScore || null, scores.financialScore || null
  );
}

module.exports = { runCycle };
