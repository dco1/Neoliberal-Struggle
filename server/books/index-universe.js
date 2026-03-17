/**
 * Book A — Index Universe
 *
 * Strategy: Score all S&P 500 constituents. Hold the top composite scorers.
 * Ethics-first: woke score is the primary lens, financial score breaks ties.
 *
 * Loop logic:
 *   1. Get current holdings and cash
 *   2. Re-score holdings (financial scores update each cycle)
 *   3. Scan full S&P 500 universe for candidates
 *   4. Sell anything below composite threshold or woke floor
 *   5. Buy top-scoring candidates up to position limits
 */

const alpaca = require('../services/alpaca');
const scoring = require('../services/scoring');
const market = require('../services/market');
const guardrails = require('../services/guardrails');
const { getDb } = require('../db/index');
const { logDecision, snapshotPortfolio, getBookCash } = require('./shared');

const BOOK_ID = 'index';
const TARGET_POSITIONS = 15;          // how many stocks to hold at once
const SELL_COMPOSITE_THRESHOLD = 45;  // sell if composite drops below this
const BUY_COMPOSITE_THRESHOLD = 60;   // only buy if composite is above this
const CANDIDATES_TO_SCORE = 50;       // score top N by momentum before picking

async function runCycle(cycleCount) {
  const db = getDb();
  console.log(`[book:index] Starting cycle ${cycleCount}`);

  // 1. Check if book is paused
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(BOOK_ID);
  if (book.paused) {
    logDecision(BOOK_ID, cycleCount, 'paused', null, `Book paused: ${book.pause_reason}`);
    return;
  }

  // 2. Get current positions from Alpaca
  const alpacaPositions = await alpaca.getPositions();
  const myTickers = alpacaPositions.map(p => p.symbol);

  // 3. Get market data for held positions
  let heldMetrics = [];
  if (myTickers.length > 0) {
    heldMetrics = await market.getTickerMetrics(myTickers);
  }

  // 4. Compute current book value for guardrails
  const cash = await getBookCash(BOOK_ID, book.capital);
  const investedValue = alpacaPositions.reduce((sum, p) => sum + parseFloat(p.market_value), 0);
  const totalValue = cash + investedValue;

  // 5. Check daily loss limit
  const lossCheck = guardrails.checkDailyLossLimit(BOOK_ID, totalValue);
  if (lossCheck.paused) {
    logDecision(BOOK_ID, cycleCount, 'paused', null, lossCheck.reason);
    return;
  }

  // 6. Snapshot portfolio
  const startingCapital = book.capital;
  await snapshotPortfolio(BOOK_ID, totalValue, cash, investedValue, startingCapital);

  // 7. Score and evaluate each current holding
  const holdEvaluations = [];
  for (const pos of alpacaPositions) {
    const ticker = pos.symbol;
    const metricData = heldMetrics.find(m => m.ticker === ticker);
    if (!metricData) continue;

    const wokeScore = await scoring.getWokeScore(ticker);
    const financialScore = await scoring.getFinancialScore(ticker, metricData.metrics);
    const composite = scoring.compositeScore(wokeScore.score, financialScore.score);

    holdEvaluations.push({
      ticker,
      position: pos,
      wokeScore: wokeScore.score,
      financialScore: financialScore.score,
      composite,
      wokeExplanation: wokeScore.explanation,
      financialExplanation: financialScore.explanation,
    });
  }

  // 8. Sell anything below thresholds
  for (const ev of holdEvaluations) {
    const wokeCheck = guardrails.checkWokeFloor(ev.wokeScore);
    const shouldSell = !wokeCheck.allowed || ev.composite < SELL_COMPOSITE_THRESHOLD;

    if (shouldSell) {
      const reason = !wokeCheck.allowed
        ? wokeCheck.reason
        : `Composite score ${ev.composite.toFixed(1)} fell below threshold ${SELL_COMPOSITE_THRESHOLD}.`;

      if (!guardrails.isInCooldown(BOOK_ID, ev.ticker)) {
        try {
          const qty = parseFloat(ev.position.qty);
          const order = await alpaca.placeMarketOrder({ ticker: ev.ticker, side: 'sell', qty });
          guardrails.recordCooldown(BOOK_ID, ev.ticker);
          recordTrade(db, BOOK_ID, ev.ticker, 'sell', qty, parseFloat(ev.position.current_price), reason, ev);
          logDecision(BOOK_ID, cycleCount, 'sell', ev.ticker, reason);
          console.log(`[book:index] SELL ${ev.ticker}: ${reason}`);
        } catch (e) {
          console.error(`[book:index] Order failed for ${ev.ticker}:`, e.message);
        }
      }
    } else {
      logDecision(BOOK_ID, cycleCount, 'hold', ev.ticker,
        `Composite: ${ev.composite.toFixed(1)} | Woke: ${ev.wokeScore.toFixed(1)} | Financial: ${ev.financialScore.toFixed(1)}`
      );
    }
  }

  // 9. Find new candidates from S&P 500 universe
  const currentHoldings = new Set(myTickers);
  const universe = market.getSP500Tickers();
  const universeTickers = universe.map(u => u.ticker).filter(t => !currentHoldings.has(t));

  if (currentHoldings.size >= TARGET_POSITIONS) {
    logDecision(BOOK_ID, cycleCount, 'skip', null, `At target position count (${TARGET_POSITIONS}). No new buys.`);
    return;
  }

  // 10. Get market data for candidates, screen, rank by momentum
  const candidateMetrics = await market.getTickerMetrics(universeTickers);
  const screened = market.screenTickers(candidateMetrics);
  const ranked = market.rankByMomentum(screened).slice(0, CANDIDATES_TO_SCORE);

  // 11. Score top candidates
  const scoredCandidates = [];
  for (const candidate of ranked) {
    const sp500Entry = universe.find(u => u.ticker === candidate.ticker);
    const wokeScore = await scoring.getWokeScore(candidate.ticker, sp500Entry?.company);
    const financialScore = await scoring.getFinancialScore(candidate.ticker, candidate.metrics);
    const composite = scoring.compositeScore(wokeScore.score, financialScore.score);

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

  // Sort by composite, buy the best ones
  scoredCandidates.sort((a, b) => b.composite - a.composite);

  const openSlots = TARGET_POSITIONS - currentHoldings.size;
  const toBuy = scoredCandidates.slice(0, openSlots);

  for (const candidate of toBuy) {
    if (guardrails.isInCooldown(BOOK_ID, candidate.ticker)) continue;

    const positionValue = Math.min(
      cash / toBuy.length,
      (totalValue * (Number(getSetting('max_position_pct')) || 0.10)),
      Number(getSetting('max_trade_size')) || 5000
    );

    if (positionValue < 10) {
      logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, 'Insufficient cash for position.');
      continue;
    }

    const sizeCheck = guardrails.checkPositionSize(BOOK_ID, candidate.ticker, positionValue, totalValue);
    if (!sizeCheck.allowed) {
      logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, sizeCheck.reason);
      continue;
    }

    try {
      const order = await alpaca.placeMarketOrder({ ticker: candidate.ticker, side: 'buy', notional: positionValue });
      guardrails.recordCooldown(BOOK_ID, candidate.ticker);
      const estShares = positionValue / candidate.metrics.price;
      const reason = `Composite: ${candidate.composite.toFixed(1)} | Woke: ${candidate.wokeScore.toFixed(1)} | ${candidate.wokeExplanation}`;
      recordTrade(db, BOOK_ID, candidate.ticker, 'buy', estShares, candidate.metrics.price, reason, candidate);
      logDecision(BOOK_ID, cycleCount, 'buy', candidate.ticker, reason);
      console.log(`[book:index] BUY ${candidate.ticker}: ${reason}`);
    } catch (e) {
      console.error(`[book:index] Order failed for ${candidate.ticker}:`, e.message);
    }
  }

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
  `).run(bookId, ticker, side, shares, price, shares * price, reasoning,
    scores.composite || null, scores.wokeScore || null, scores.financialScore || null);
}

module.exports = { runCycle };
