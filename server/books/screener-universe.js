/**
 * Book B — Screener Universe
 *
 * Strategy: Filter S&P 500 by financial criteria first, then apply woke scoring.
 * Performance-forward: financial momentum leads, ethics is the filter.
 *
 * Loop logic:
 *   1. Get current holdings and cash
 *   2. Score holdings; sell underperformers or woke-floor violations
 *   3. Screen full universe by financial criteria
 *   4. Rank top performers, apply woke filter
 *   5. Buy top composite scorers from financially qualified set
 */

const alpaca = require('../services/alpaca');
const scoring = require('../services/scoring');
const market = require('../services/market');
const guardrails = require('../services/guardrails');
const { getDb } = require('../db/index');
const { logDecision, snapshotPortfolio, getBookCash } = require('./shared');

const BOOK_ID = 'screener';
const TARGET_POSITIONS = 15;
const SELL_FINANCIAL_THRESHOLD = 35;   // sell if financial score drops below this
const SELL_COMPOSITE_THRESHOLD = 40;
const TOP_FINANCIAL_CANDIDATES = 30;   // score top N financial performers on woke
const MIN_FINANCIAL_SCORE_TO_BUY = 60; // must pass financial bar before woke scoring

async function runCycle(cycleCount) {
  const db = getDb();
  console.log(`[book:screener] Starting cycle ${cycleCount}`);

  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(BOOK_ID);
  if (book.paused) {
    logDecision(BOOK_ID, cycleCount, 'paused', null, `Book paused: ${book.pause_reason}`);
    return;
  }

  const alpacaPositions = await alpaca.getPositions();

  // Note: Alpaca is a single account. We track our book's positions by what we've
  // recorded as this book's trades. For paper trading simplicity, we use all positions
  // here — in production you'd namespace by book.
  const myTrades = db.prepare(`
    SELECT ticker, SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares
    FROM trades WHERE book_id = ? GROUP BY ticker HAVING net_shares > 0.001
  `).all(BOOK_ID);
  const myTickers = myTrades.map(t => t.ticker);

  const myPositions = alpacaPositions.filter(p => myTickers.includes(p.symbol));

  const cash = await getBookCash(BOOK_ID, book.capital);
  const investedValue = myPositions.reduce((sum, p) => sum + parseFloat(p.market_value), 0);
  const totalValue = cash + investedValue;

  const lossCheck = guardrails.checkDailyLossLimit(BOOK_ID, totalValue);
  if (lossCheck.paused) {
    logDecision(BOOK_ID, cycleCount, 'paused', null, lossCheck.reason);
    return;
  }

  await snapshotPortfolio(BOOK_ID, totalValue, cash, investedValue, book.capital);

  // Score current holdings
  let heldMetrics = [];
  if (myTickers.length > 0) {
    heldMetrics = await market.getTickerMetrics(myTickers);
  }

  for (const pos of myPositions) {
    const ticker = pos.symbol;
    const metricData = heldMetrics.find(m => m.ticker === ticker);
    if (!metricData) continue;

    const wokeScore = await scoring.getWokeScore(ticker);
    const financialScore = await scoring.getFinancialScore(ticker, metricData.metrics);
    const composite = scoring.compositeScore(wokeScore.score, financialScore.score);

    const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);
    const financialWeak = financialScore.score < SELL_FINANCIAL_THRESHOLD;
    const compositeWeak = composite < SELL_COMPOSITE_THRESHOLD;

    if (!wokeCheck.allowed || financialWeak || compositeWeak) {
      const reason = !wokeCheck.allowed ? wokeCheck.reason
        : financialWeak ? `Financial score ${financialScore.score.toFixed(1)} dropped below ${SELL_FINANCIAL_THRESHOLD}. Momentum gone.`
        : `Composite ${composite.toFixed(1)} below threshold.`;

      if (!guardrails.isInCooldown(BOOK_ID, ticker)) {
        try {
          const qty = parseFloat(pos.qty);
          await alpaca.placeMarketOrder({ ticker, side: 'sell', qty });
          guardrails.recordCooldown(BOOK_ID, ticker);
          recordTrade(db, BOOK_ID, ticker, 'sell', qty, parseFloat(pos.current_price), reason, { composite, wokeScore: wokeScore.score, financialScore: financialScore.score });
          logDecision(BOOK_ID, cycleCount, 'sell', ticker, reason);
          console.log(`[book:screener] SELL ${ticker}: ${reason}`);
        } catch (e) {
          console.error(`[book:screener] Order failed for ${ticker}:`, e.message);
        }
      }
    } else {
      logDecision(BOOK_ID, cycleCount, 'hold', ticker,
        `Financial: ${financialScore.score.toFixed(1)} | Woke: ${wokeScore.score.toFixed(1)} | Composite: ${composite.toFixed(1)}`
      );
    }
  }

  // Find new candidates
  const currentHoldings = new Set(myTickers);
  if (currentHoldings.size >= TARGET_POSITIONS) {
    logDecision(BOOK_ID, cycleCount, 'skip', null, `At target position count (${TARGET_POSITIONS}). No new buys.`);
    return;
  }

  const universe = market.getSP500Tickers();
  const universeTickers = universe.map(u => u.ticker).filter(t => !currentHoldings.has(t));

  // Get metrics, screen, rank by financial momentum
  const candidateMetrics = await market.getTickerMetrics(universeTickers);
  const screened = market.screenTickers(candidateMetrics);
  const ranked = market.rankByMomentum(screened);

  // Score top financial candidates on woke AFTER financial ranking
  const scored = [];
  let financiallyScoredCount = 0;

  for (const candidate of ranked) {
    if (financiallyScoredCount >= TOP_FINANCIAL_CANDIDATES) break;

    const financialScore = await scoring.getFinancialScore(candidate.ticker, candidate.metrics);
    financiallyScoredCount++;

    if (financialScore.score < MIN_FINANCIAL_SCORE_TO_BUY) continue;

    const sp500Entry = universe.find(u => u.ticker === candidate.ticker);
    const wokeScore = await scoring.getWokeScore(candidate.ticker, sp500Entry?.company);
    const wokeCheck = guardrails.checkWokeFloor(wokeScore.score);

    if (!wokeCheck.allowed) {
      logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker,
        `Strong financials (${financialScore.score.toFixed(1)}) but ${wokeCheck.reason}`);
      continue;
    }

    const composite = scoring.compositeScore(wokeScore.score, financialScore.score);
    scored.push({
      ...candidate,
      wokeScore: wokeScore.score,
      financialScore: financialScore.score,
      composite,
      wokeExplanation: wokeScore.explanation,
    });
  }

  scored.sort((a, b) => b.composite - a.composite);

  const openSlots = TARGET_POSITIONS - currentHoldings.size;
  const toBuy = scored.slice(0, openSlots);

  for (const candidate of toBuy) {
    if (guardrails.isInCooldown(BOOK_ID, candidate.ticker)) continue;

    const positionValue = Math.min(
      cash / Math.max(toBuy.length, 1),
      totalValue * 0.10,
      5000
    );

    if (positionValue < 10) {
      logDecision(BOOK_ID, cycleCount, 'skip', candidate.ticker, 'Insufficient cash.');
      continue;
    }

    try {
      await alpaca.placeMarketOrder({ ticker: candidate.ticker, side: 'buy', notional: positionValue });
      guardrails.recordCooldown(BOOK_ID, candidate.ticker);
      const estShares = positionValue / candidate.metrics.price;
      const reason = `Financial: ${candidate.financialScore.toFixed(1)} | Woke: ${candidate.wokeScore.toFixed(1)} | ${candidate.wokeExplanation}`;
      recordTrade(db, BOOK_ID, candidate.ticker, 'buy', estShares, candidate.metrics.price, reason, candidate);
      logDecision(BOOK_ID, cycleCount, 'buy', candidate.ticker, reason);
      console.log(`[book:screener] BUY ${candidate.ticker}: ${reason}`);
    } catch (e) {
      console.error(`[book:screener] Order failed for ${candidate.ticker}:`, e.message);
    }
  }

  console.log(`[book:screener] Cycle ${cycleCount} complete.`);
}

function recordTrade(db, bookId, ticker, side, shares, price, reasoning, scores) {
  db.prepare(`
    INSERT INTO trades (book_id, ticker, side, shares, price, total_value, reasoning, composite_score, woke_score, financial_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, ticker, side, shares, price, shares * price, reasoning,
    scores.composite || null, scores.wokeScore || null, scores.financialScore || null);
}

module.exports = { runCycle };
