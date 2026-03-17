/**
 * Book B — Screener Universe
 *
 * Strategy: Filter S&P 500 by financial criteria first, then apply woke scoring.
 * Performance-forward: financial momentum leads, ethics is a risk filter.
 * Starting weights: woke_weight=0.25, financial_weight=0.75.
 *
 * Loop logic:
 *   1. Load book config (capital, current woke/financial weights)
 *   2. Get current positions from Alpaca (filtered to this book's trades)
 *   3. Compute portfolio value and cash
 *   4. Snapshot portfolio
 *   5. Score holdings; sell underperformers or woke-floor violations
 *   6. Screen universe by financial criteria first, rank by momentum
 *   7. Score top financial candidates on woke AFTER financial ranking
 *   8. If cash >= $10, buy top composite scorers
 *   9. Adjust woke/financial weights based on recent P&L trend
 *
 * No pause checks. No cooldown calls. No hard-stop at TARGET_POSITIONS.
 */

const alpaca = require('../services/alpaca');
const scoring = require('../services/scoring');
const market = require('../services/market');
const guardrails = require('../services/guardrails');
const { getDb } = require('../db/index');
const { logDecision, snapshotPortfolio, getBookValue, adjustWeights } = require('./shared');

const BOOK_ID = 'screener';
const TARGET_POSITIONS = 15;            // soft guide for position sizing (not a hard cap)
const SELL_FINANCIAL_THRESHOLD = 35;    // sell if financial score drops below this
const SELL_COMPOSITE_THRESHOLD = 40;    // sell if composite drops below this
const TOP_FINANCIAL_CANDIDATES = 30;    // evaluate top N financial performers on woke
const MIN_FINANCIAL_SCORE_TO_BUY = 60; // must pass financial bar before woke scoring

async function runCycle(cycleCount) {
  const db = getDb();
  console.log(`[book:screener] Starting cycle ${cycleCount}`);

  // 1. Load book config — includes current woke_weight and financial_weight
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(BOOK_ID);
  const wokeWeight = book.woke_weight || 0.25;
  const financialWeight = book.financial_weight || 0.75;
  console.log(`[book:screener] Current weights — woke: ${wokeWeight}, financial: ${financialWeight}`);

  // 2. Get all Alpaca positions, then compute real cash + invested value from the API.
  // getBookValue calls alpaca.getAccount() for authoritative cash, splits 50/50 between books,
  // and filters positions to only those this book has traded via internal trade records.
  const alpacaPositions = await alpaca.getPositions();
  const { cash, investedValue, totalValue, myPositions } = await getBookValue(BOOK_ID, alpacaPositions);
  const myTickers = myPositions.map(p => p.symbol);

  // 4. Snapshot portfolio for trend tracking and end-of-day reporting
  await snapshotPortfolio(BOOK_ID, totalValue, cash, investedValue, book.capital);

  // 5. Score and evaluate each current holding
  let heldMetrics = [];
  if (myTickers.length > 0) {
    heldMetrics = await market.getTickerMetrics(myTickers);
  }

  for (const pos of myPositions) {
    const ticker = pos.symbol;
    const metricData = heldMetrics.find(m => m.ticker === ticker);
    if (!metricData) {
      console.log(`[book:screener] No market data for held position ${ticker}, skipping evaluation.`);
      continue;
    }

    // Score using this book's current weights
    const wokeScore = await scoring.getWokeScore(ticker);
    const financialScore = await scoring.getFinancialScore(ticker, metricData.metrics);
    const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);

    console.log(`[book:screener] Evaluating ${ticker} — financial: ${financialScore.score.toFixed(1)}, woke: ${wokeScore.score.toFixed(1)}, composite: ${composite.toFixed(1)}`);

    const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);
    const financialWeak = financialScore.score < SELL_FINANCIAL_THRESHOLD;
    const compositeWeak = composite < SELL_COMPOSITE_THRESHOLD;

    if (!wokeCheck.allowed || financialWeak || compositeWeak) {
      const reason = !wokeCheck.allowed
        ? wokeCheck.reason
        : financialWeak
          ? `Financial score ${financialScore.score.toFixed(1)} dropped below ${SELL_FINANCIAL_THRESHOLD}. Momentum gone.`
          : `Composite ${composite.toFixed(1)} below threshold ${SELL_COMPOSITE_THRESHOLD}.`;

      console.log(`[book:screener] SELL ${ticker}: ${reason}`);
      try {
        const qty = parseFloat(pos.qty);
        await alpaca.placeMarketOrder({ ticker, side: 'sell', qty });
        recordTrade(db, BOOK_ID, ticker, 'sell', qty, parseFloat(pos.current_price), reason, {
          composite, wokeScore: wokeScore.score, financialScore: financialScore.score,
        });
        logDecision(BOOK_ID, cycleCount, 'sell', ticker, reason);
      } catch (e) {
        console.error(`[book:screener] Sell order failed for ${ticker}:`, e.message);
      }
    } else {
      logDecision(BOOK_ID, cycleCount, 'hold', ticker,
        `Financial: ${financialScore.score.toFixed(1)} | Woke: ${wokeScore.score.toFixed(1)} | Composite: ${composite.toFixed(1)}`
      );
    }
  }

  // 6. Re-fetch cash from Alpaca before buys — sells above may have freed up real capital
  const { cash: freshCash } = await getBookValue(BOOK_ID, await alpaca.getPositions());
  if (freshCash < 10) {
    console.log(`[book:screener] Cash $${freshCash.toFixed(2)} < $10. Skipping buys.`);
    logDecision(BOOK_ID, cycleCount, 'skip', null, `Cash $${freshCash.toFixed(2)} below minimum. No buys.`);
  } else {
    // 7. Screen the universe: financial criteria first, then apply woke filter
    const currentHoldings = new Set(myTickers);
    const universe = market.getSP500Tickers();
    const universeTickers = universe.map(u => u.ticker).filter(t => !currentHoldings.has(t));

    console.log(`[book:screener] $${freshCash.toFixed(0)} available. Scanning ${universeTickers.length} candidates (financial-first).`);

    // Get metrics, screen for baseline quality, rank by financial momentum
    const candidateMetrics = await market.getTickerMetrics(universeTickers);
    const screened = market.screenTickers(candidateMetrics);
    const ranked = market.rankByMomentum(screened);

    // Score top financial candidates — woke scoring happens AFTER financial ranking
    const scored = [];
    let financiallyScoredCount = 0;

    for (const candidate of ranked) {
      if (financiallyScoredCount >= TOP_FINANCIAL_CANDIDATES) break;

      // Financial score first — this is Book B's primary filter
      const financialScore = await scoring.getFinancialScore(candidate.ticker, candidate.metrics);
      financiallyScoredCount++;

      if (financialScore.score < MIN_FINANCIAL_SCORE_TO_BUY) {
        // Doesn't clear the financial bar — skip without wasting an API call on woke scoring
        console.log(`[book:screener] ${candidate.ticker} financial score ${financialScore.score.toFixed(1)} < ${MIN_FINANCIAL_SCORE_TO_BUY}, skipping.`);
        continue;
      }

      // Passes financials — now check woke (as a risk filter, not the primary criterion)
      const sp500Entry = universe.find(u => u.ticker === candidate.ticker);
      const wokeScore = await scoring.getWokeScore(candidate.ticker, sp500Entry?.company);
      const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);

      if (!wokeCheck.allowed) {
        logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker,
          `Strong financials (${financialScore.score.toFixed(1)}) but ${wokeCheck.reason}`
        );
        console.log(`[book:screener] ${candidate.ticker} blocked by woke floor despite financial score ${financialScore.score.toFixed(1)}.`);
        continue;
      }

      // Both checks pass — compute composite using this book's weights
      const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);
      scored.push({
        ...candidate,
        wokeScore: wokeScore.score,
        financialScore: financialScore.score,
        composite,
        wokeExplanation: wokeScore.explanation,
      });
    }

    // Sort by composite (financial-weighted, so financial leaders float to top)
    scored.sort((a, b) => b.composite - a.composite);
    console.log(`[book:screener] ${scored.length} candidates cleared all filters.`);

    // Position sizing: use TARGET_POSITIONS as a denominator, not a hard cap
    const slotsForSizing = Math.max(TARGET_POSITIONS - currentHoldings.size, 1);

    // 8. Buy all qualifying candidates while cash holds
    for (const candidate of scored) {
      // Re-check cash each iteration via Alpaca (may shrink as orders fill)
      const { cash: availableCash } = await getBookValue(BOOK_ID, await alpaca.getPositions());
      if (availableCash < 10) {
        console.log(`[book:screener] Cash exhausted ($${availableCash.toFixed(2)}). Stopping buys.`);
        break;
      }

      // Size the position
      const maxPosPct = Number(getSetting('max_position_pct')) || 0.10;
      const maxTradeSize = Number(getSetting('max_trade_size')) || 5000;
      const positionValue = Math.min(
        availableCash / Math.max(slotsForSizing, 1),
        totalValue * maxPosPct,
        maxTradeSize
      );

      if (positionValue < 10) {
        logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, 'Insufficient cash for position.');
        continue;
      }

      const reason = `Financial: ${candidate.financialScore.toFixed(1)} | Woke: ${candidate.wokeScore.toFixed(1)} | Composite: ${candidate.composite.toFixed(1)} | ${candidate.wokeExplanation}`;
      console.log(`[book:screener] BUY ${candidate.ticker} $${positionValue.toFixed(0)}: ${reason}`);

      try {
        await alpaca.placeMarketOrder({ ticker: candidate.ticker, side: 'buy', notional: positionValue });
        const estShares = positionValue / candidate.metrics.price;
        recordTrade(db, BOOK_ID, candidate.ticker, 'buy', estShares, candidate.metrics.price, reason, candidate);
        logDecision(BOOK_ID, cycleCount, 'buy', candidate.ticker, reason);
      } catch (e) {
        console.error(`[book:screener] Buy order failed for ${candidate.ticker}:`, e.message);
      }
    }
  }

  // 9. Adjust woke/financial weights based on recent P&L trend
  // Book B moves away from ethics when winning, toward it when losing.
  adjustWeights(BOOK_ID);

  console.log(`[book:screener] Cycle ${cycleCount} complete.`);
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
