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
 *   5. Re-score current holdings in parallel; sell anything below thresholds or woke floor
 *   6. Scan S&P 500 universe for candidates
 *   6b. Rotation: if cash-poor, sell worst zombie holding if a better candidate exists
 *   7. If cash >= $10, score candidates in parallel and buy the best ones
 *   8. Adjust woke/financial weights based on recent P&L trend
 *
 * No pause checks. No cooldown calls. No hard-stop at TARGET_POSITIONS.
 * TARGET_POSITIONS is used only for position sizing math.
 * Scoring is parallelised (max SCORE_CONCURRENCY simultaneous Claude API calls).
 */

const alpaca = require('../services/alpaca');
const scoring = require('../services/scoring');
const market = require('../services/market');
const guardrails = require('../services/guardrails');
const { getDb } = require('../db/index');
const { logDecision, snapshotPortfolio, getBookValue, adjustWeights, pLimit } = require('./shared');

const BOOK_ID = 'index';
const TARGET_POSITIONS = 15;          // soft guide for position sizing (not a hard cap)
const SELL_COMPOSITE_THRESHOLD = 45;  // sell if composite drops below this
const BUY_COMPOSITE_THRESHOLD = 60;   // only buy if composite is above this
const CANDIDATES_TO_SCORE = 50;       // score top N by momentum before picking
const SCORE_CONCURRENCY = 5;          // max parallel Claude API calls during scoring
const ROTATION_MIN_IMPROVEMENT = 5;   // candidate must score this many points above the zombie to trigger a swap
const ROTATION_CANDIDATES = 20;       // how many candidates to score during a rotation check

async function runCycle(cycleCount) {
  const db = getDb();
  console.log(`[book:index] Starting cycle ${cycleCount}`);

  // 1. Load book config — includes current woke_weight and financial_weight
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(BOOK_ID);
  const wokeWeight = book.woke_weight || 0.65;
  const financialWeight = book.financial_weight || 0.35;
  console.log(`[book:index] Current weights — woke: ${wokeWeight}, financial: ${financialWeight}`);

  // 2. Get all Alpaca positions, then compute real cash + invested value from the API.
  // getBookValue calls alpaca.getAccount() for authoritative cash, splits proportionally
  // between books, and filters positions to only those this book has traded.
  const alpacaPositions = await alpaca.getPositions();
  const { cash, investedValue, totalValue, myPositions } = await getBookValue(BOOK_ID, alpacaPositions);
  const myTickers = myPositions.map(p => p.symbol);

  // 4. Snapshot portfolio state for trend tracking and end-of-day reporting
  await snapshotPortfolio(BOOK_ID, totalValue, cash, investedValue, book.capital);

  // 5. Get market data for current holdings, then score all in parallel.
  //    Sell decisions are collected first, executed sequentially after.
  let heldMetrics = [];
  if (myTickers.length > 0) {
    heldMetrics = await market.getTickerMetrics(myTickers);
  }

  // holdingEvals declared in outer scope so the rotation block (step 6b) can read it
  let holdingEvals = [];

  if (myPositions.length > 0) {
    console.log(`[book:index] Scoring ${myPositions.length} holdings in parallel (max ${SCORE_CONCURRENCY} concurrent).`);
    const limit = pLimit(SCORE_CONCURRENCY);

    // Score all held positions concurrently — woke + financial per ticker in parallel
    holdingEvals = await Promise.all(myPositions.map(pos => limit(async () => {
      const ticker = pos.symbol;
      const metricData = heldMetrics.find(m => m.ticker === ticker);
      if (!metricData) {
        console.log(`[book:index] No market data for held position ${ticker}, skipping evaluation.`);
        return null;
      }
      const [wokeScore, financialScore] = await Promise.all([
        scoring.getWokeScore(ticker),
        scoring.getFinancialScore(ticker, metricData.metrics),
      ]);
      const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);
      console.log(`[book:index] Evaluating ${ticker} — woke: ${wokeScore.score.toFixed(1)}, financial: ${financialScore.score.toFixed(1)}, composite: ${composite.toFixed(1)}`);
      return { pos, ticker, metricData, wokeScore, financialScore, composite };
    })));

    // Process sell / hold decisions sequentially after all scores are in
    for (const result of holdingEvals) {
      if (!result) continue;
      const { pos, ticker, wokeScore, financialScore, composite } = result;

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
  }

  // 6. Find new candidates from the full S&P 500 universe
  const currentHoldings = new Set(myTickers);
  const universe = market.getSP500Tickers();
  const universeTickers = universe.map(u => u.ticker).filter(t => !currentHoldings.has(t));

  // 6b. Portfolio rotation — when fully deployed, swap the worst "zombie" holding
  //     for a materially better candidate rather than sitting idle every cycle.
  //
  //     A "zombie" is a holding that scores below BUY_COMPOSITE_THRESHOLD — not bad
  //     enough to auto-sell (above SELL_COMPOSITE_THRESHOLD) but not good enough to
  //     buy fresh. When cash is exhausted these positions just sit there, dragging.
  //
  //     Rotation only fires when:
  //       (a) cash is below the buy minimum ($10), AND
  //       (b) at least one zombie holding exists, AND
  //       (c) a candidate scores ROTATION_MIN_IMPROVEMENT+ points above the worst zombie.
  //     Only one position is rotated per cycle to avoid excessive churn.
  {
    const { cash: cashBeforeRotation } = await getBookValue(BOOK_ID, await alpaca.getPositions());
    const validEvals = holdingEvals.filter(e => e !== null);

    if (cashBeforeRotation < 10 && validEvals.length > 0) {
      // Zombies: above sell floor but below buy threshold — mediocre, not catastrophic
      const zombies = validEvals
        .filter(e => e.composite < BUY_COMPOSITE_THRESHOLD)
        .sort((a, b) => a.composite - b.composite); // worst first

      if (zombies.length > 0) {
        const worstZombie = zombies[0];
        const minRequired = worstZombie.composite + ROTATION_MIN_IMPROVEMENT;
        console.log(`[book:index] Rotation check: worst zombie is ${worstZombie.ticker} (composite ${worstZombie.composite.toFixed(1)}). Need candidate >= ${minRequired.toFixed(1)}.`);

        // Score a small batch of fresh candidates to look for something materially better
        const rotMetrics = await market.getTickerMetrics(universeTickers.slice(0, 100));
        const rotScreened = market.screenTickers(rotMetrics);
        const rotRanked = market.rankByMomentum(rotScreened).slice(0, ROTATION_CANDIDATES);

        const rotLimit = pLimit(SCORE_CONCURRENCY);
        const rotScored = await Promise.all(rotRanked.map(c => rotLimit(async () => {
          const sp500Entry = universe.find(u => u.ticker === c.ticker);
          const [ws, fs] = await Promise.all([
            scoring.getWokeScore(c.ticker, sp500Entry?.company),
            scoring.getFinancialScore(c.ticker, c.metrics),
          ]);
          const composite = scoring.compositeScore(ws.score, fs.score, wokeWeight, financialWeight);
          return { ticker: c.ticker, composite, wokeScore: ws.score, financialScore: fs.score, ws, metrics: c.metrics };
        })));

        // Find the best candidate that clearly beats the zombie and clears ethics
        const bestCandidate = rotScored
          .filter(c => {
            const wokeCheck = guardrails.checkWokeFloor(c.wokeScore);
            return wokeCheck.allowed && c.composite >= BUY_COMPOSITE_THRESHOLD && c.composite >= minRequired;
          })
          .sort((a, b) => b.composite - a.composite)[0];

        if (bestCandidate) {
          const reason = `Rotation: ${worstZombie.ticker} (composite ${worstZombie.composite.toFixed(1)}) is below buy threshold — ` +
            `replacing with ${bestCandidate.ticker} (composite ${bestCandidate.composite.toFixed(1)}).`;
          console.log(`[book:index] ROTATION: ${worstZombie.ticker} → ${bestCandidate.ticker} ` +
            `(${worstZombie.composite.toFixed(1)} → ${bestCandidate.composite.toFixed(1)})`);
          try {
            const qty = parseFloat(worstZombie.pos.qty);
            await alpaca.placeMarketOrder({ ticker: worstZombie.ticker, side: 'sell', qty });
            recordTrade(db, BOOK_ID, worstZombie.ticker, 'sell', qty, parseFloat(worstZombie.pos.current_price), reason, {
              composite: worstZombie.composite,
              wokeScore: worstZombie.wokeScore.score,
              financialScore: worstZombie.financialScore.score,
            });
            logDecision(BOOK_ID, cycleCount, 'sell', worstZombie.ticker, reason);
            // Remove from currentHoldings so the buy pass can pick up the freed cash
            currentHoldings.delete(worstZombie.ticker);
          } catch (e) {
            console.error(`[book:index] Rotation sell failed for ${worstZombie.ticker}:`, e.message);
          }
        } else {
          console.log(`[book:index] Rotation check: no candidate beats ${worstZombie.ticker} by ${ROTATION_MIN_IMPROVEMENT}+ points. Holding.`);
          logDecision(BOOK_ID, cycleCount, 'hold', null,
            `Rotation check: no materially better candidates found. Worst holding ${worstZombie.ticker} stays (composite ${worstZombie.composite.toFixed(1)}).`
          );
        }
      }
    }
  }

  // 7. Check cash before proceeding to buys.
  // Re-fetch from Alpaca since sells above may have freed up real capital.
  const { cash: freshCash } = await getBookValue(BOOK_ID, await alpaca.getPositions());
  if (freshCash < 10) {
    console.log(`[book:index] Cash $${freshCash.toFixed(2)} < $10. Skipping buys.`);
    logDecision(BOOK_ID, cycleCount, 'skip', null, `Cash $${freshCash.toFixed(2)} below minimum. No buys.`);
  } else {
    console.log(`[book:index] $${freshCash.toFixed(0)} available. Scanning ${universeTickers.length} candidates.`);

    // Get market data for all universe tickers, screen and rank by momentum
    const candidateMetrics = await market.getTickerMetrics(universeTickers);
    const screened = market.screenTickers(candidateMetrics);
    const ranked = market.rankByMomentum(screened).slice(0, CANDIDATES_TO_SCORE);

    console.log(`[book:index] Scoring top ${ranked.length} candidates in parallel (max ${SCORE_CONCURRENCY} concurrent).`);

    // Score all candidates concurrently — woke + financial in parallel per ticker
    const limit = pLimit(SCORE_CONCURRENCY);
    const scoringResults = await Promise.all(ranked.map(candidate => limit(async () => {
      const sp500Entry = universe.find(u => u.ticker === candidate.ticker);
      const [wokeScore, financialScore] = await Promise.all([
        scoring.getWokeScore(candidate.ticker, sp500Entry?.company),
        scoring.getFinancialScore(candidate.ticker, candidate.metrics),
      ]);
      const composite = scoring.compositeScore(wokeScore.score, financialScore.score, wokeWeight, financialWeight);
      return { candidate, wokeScore, financialScore, composite };
    })));

    // Apply ethics filter and composite threshold
    const scoredCandidates = [];
    for (const { candidate, wokeScore, financialScore, composite } of scoringResults) {
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
      // Re-check available cash each iteration via Alpaca (may shrink as orders fill)
      const { cash: availableCash } = await getBookValue(BOOK_ID, await alpaca.getPositions());
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
