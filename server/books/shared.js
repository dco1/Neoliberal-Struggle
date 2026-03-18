/**
 * Shared utilities for book strategies.
 *
 * Includes:
 *   - logDecision: write an agent_log entry
 *   - snapshotPortfolio: record a portfolio_snapshots row
 *   - getBookCash: compute remaining cash from trade history
 *   - adjustWeights: read recent P&L trend and update a book's woke/financial weights
 */

const { getDb } = require('../db/index');
const alpaca = require('../services/alpaca');
const ws     = require('../services/ws');

/**
 * Write a decision to the agent_log table.
 */
function logDecision(bookId, cycle, action, ticker, reasoning) {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_log (book_id, cycle, action, ticker, reasoning)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, cycle, action, ticker || null, reasoning);

  // Push the new log entry to all connected dashboard clients in real-time.
  // Clients append it directly to the log tab instead of waiting for a poll.
  ws.broadcast('log_entry', { bookId, cycle, action, ticker: ticker || null, reasoning });
}

/**
 * Record a portfolio snapshot for the given book.
 * pnl and pnl_pct are calculated relative to starting capital.
 */
async function snapshotPortfolio(bookId, totalValue, cash, invested, startingCapital) {
  const db = getDb();
  const pnl = totalValue - startingCapital;
  const pnlPct = startingCapital > 0 ? (pnl / startingCapital) * 100 : 0;

  db.prepare(`
    INSERT INTO portfolio_snapshots (book_id, total_value, cash, invested, pnl, pnl_pct)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(bookId, totalValue, cash, invested, pnl, pnlPct);
}

/**
 * Compute this book's real cash and total portfolio value using the Alpaca API.
 *
 * Both books share one Alpaca account, so we can't ask Alpaca for per-book cash.
 * Instead of a naive 50/50 split (which drifts as books trade differently), we
 * distribute the real Alpaca cash proportionally based on each book's unspent
 * capital fraction derived from trade history:
 *
 *   book_remaining = book.capital - net_spend_from_trades
 *   book_cash = alpaca_cash × (book_remaining / total_remaining_across_both_books)
 *
 * This means if Book A has deployed $3k and Book B has deployed $0, Book A gets
 * proportionally less of Alpaca's remaining cash — reflecting reality.
 *
 * Invested value is always precise: filtered to Alpaca positions this book traded.
 *
 * @param {string} bookId          - 'index' or 'screener'
 * @param {Array}  alpacaPositions  - already-fetched Alpaca positions array
 */
async function getBookValue(bookId, alpacaPositions) {
  const db = getDb();

  // Real authoritative cash from Alpaca
  const account = await alpaca.getAccount();
  const totalAccountCash = parseFloat(account.cash);

  // Net spend per book = sum(buys) - sum(sells) recorded in our trade log.
  // Uses total_value (shares × price at time of order) as the proxy for cash moved.
  function getNetSpend(id) {
    const row = db.prepare(`
      SELECT SUM(CASE WHEN side='buy' THEN total_value ELSE -total_value END) as net
      FROM trades WHERE book_id = ?
    `).get(id);
    return Math.max(0, row?.net || 0);
  }

  const otherBookId = bookId === 'index' ? 'screener' : 'index';

  // Use the real per-book capital allocation — recorded from Alpaca on first startup
  // as (account.equity / 2) and stored in settings as 'initial_equity_per_book'.
  // book.capital is a legacy field seeded at $50,000 and must NOT be used here:
  // with capital=$50k, a book that has spent $7,685 still shows $42,315 "remaining"
  // and keeps receiving cash allocations well beyond its actual $5k fair share.
  const initialEquityRow = db.prepare("SELECT value FROM settings WHERE key = 'initial_equity_per_book'").get();
  const perBookCapital = initialEquityRow ? parseFloat(initialEquityRow.value) : 5000;

  // Each book's "unspent" capital according to our trade records.
  // When net_spend >= perBookCapital the book is fully deployed and gets 0 cash.
  const myRemaining    = Math.max(0, perBookCapital - getNetSpend(bookId));
  const otherRemaining = Math.max(0, perBookCapital - getNetSpend(otherBookId));
  const totalRemaining = myRemaining + otherRemaining;

  // Distribute real Alpaca cash proportionally; fall back to 50/50 if no trades yet
  const cash = totalRemaining > 0
    ? totalAccountCash * (myRemaining / totalRemaining)
    : totalAccountCash / 2;

  // Build a price map from Alpaca's live positions.
  // Used to mark-to-market this book's shares at today's price.
  const priceMap = new Map(
    alpacaPositions.map(p => [p.symbol, parseFloat(p.current_price)])
  );

  // Compute invested value from TRADE RECORDS × CURRENT PRICE.
  // This avoids double-counting: both books may hold the same ticker, so
  // filtering Alpaca's market_value by ticker would give each book the full
  // position value instead of just their own share count.
  const netPositions = db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares,
           SUM(CASE WHEN side='buy' THEN total_value ELSE 0 END) /
           NULLIF(SUM(CASE WHEN side='buy' THEN shares ELSE 0 END), 0) as avg_cost
    FROM trades WHERE book_id = ?
    GROUP BY ticker HAVING net_shares > 0.001
  `).all(bookId);

  const investedValue = netPositions.reduce((sum, pos) => {
    const price = priceMap.get(pos.ticker) ?? pos.avg_cost;
    return sum + (pos.net_shares * price);
  }, 0);

  // myPositions is still used by book cycle files to know which tickers to re-score.
  // Keep the ticker-filter approach here — it's only used for the tickers list, not value.
  const myTickers  = new Set(netPositions.map(p => p.ticker));
  const myPositions = alpacaPositions.filter(p => myTickers.has(p.symbol));

  const totalValue = cash + investedValue;

  console.log(
    `[book:${bookId}] Cash split — Alpaca total: $${totalAccountCash.toFixed(0)} | ` +
    `this book remaining fraction: ${totalRemaining > 0 ? ((myRemaining / totalRemaining) * 100).toFixed(1) : 50}% | ` +
    `book cash: $${cash.toFixed(0)} | invested: $${investedValue.toFixed(0)} | total: $${totalValue.toFixed(0)}`
  );

  return { cash, investedValue, totalValue, myPositions, account };
}

/**
 * Autonomous weight adjustment — called at the end of each book cycle.
 *
 * Looks at the last 3 portfolio snapshots to determine if P&L is improving
 * (i.e. pnl_pct is trending upward). Then adjusts woke_weight accordingly:
 *
 * Book A (ethics-first, id='index'):
 *   - P&L improving → increase woke_weight by 0.02 (max 0.80): doubling down on ethics
 *   - P&L declining → decrease woke_weight by 0.01 (min 0.55): slight tactical concession
 *   - Book A never abandons ethics; its floor is 0.55
 *
 * Book B (performance-first, id='screener'):
 *   - P&L improving → decrease woke_weight by 0.02 (min 0.15): leaning further into performance
 *   - P&L declining → increase woke_weight by 0.01 (max 0.45): tactically adding ethics as buffer
 *   - Book B uses ethics tactically; its ceiling is 0.45
 *
 * financial_weight is always (1 - woke_weight).
 *
 * @param {string} bookId - 'index' or 'screener'
 */
function adjustWeights(bookId) {
  const db = getDb();

  // Fetch the book's current weights
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) {
    console.error(`[book:${bookId}] adjustWeights: book not found`);
    return;
  }

  let { woke_weight: wokeWeight } = book;

  // Fetch last 3 snapshots (most recent first) to determine trend
  const snapshots = db.prepare(`
    SELECT pnl_pct FROM portfolio_snapshots
    WHERE book_id = ?
    ORDER BY snapped_at DESC LIMIT 3
  `).all(bookId);

  // Need at least 2 snapshots to determine a trend
  if (snapshots.length < 2) {
    console.log(`[book:${bookId}] adjustWeights: not enough snapshots yet (${snapshots.length}), skipping.`);
    return;
  }

  // snapshots[0] is the most recent, snapshots[last] is oldest of the set
  // "Improving" means the most recent pnl_pct is higher than the oldest in the window
  const mostRecent = snapshots[0].pnl_pct;
  const oldest = snapshots[snapshots.length - 1].pnl_pct;
  const improving = mostRecent > oldest;

  const prevWeight = wokeWeight;
  let changeDescription = '';

  if (bookId === 'index') {
    // Book A: ethics-first. Never goes below 0.55.
    if (improving) {
      wokeWeight = Math.min(0.80, wokeWeight + 0.02);
      changeDescription = 'P&L improving, doubling down on ethics.';
    } else {
      wokeWeight = Math.max(0.55, wokeWeight - 0.01);
      changeDescription = 'P&L declining, slight tactical concession on ethics weight.';
    }
  } else if (bookId === 'screener') {
    // Book B: performance-first. Never goes above 0.45.
    if (improving) {
      wokeWeight = Math.max(0.15, wokeWeight - 0.02);
      changeDescription = 'P&L improving, leaning further into performance.';
    } else {
      wokeWeight = Math.min(0.45, wokeWeight + 0.01);
      changeDescription = 'P&L declining, adding ethics as tactical buffer.';
    }
  } else {
    console.warn(`[book:${bookId}] adjustWeights: unknown book id, skipping weight adjustment.`);
    return;
  }

  // Round to 2 decimal places to avoid floating-point drift
  wokeWeight = Math.round(wokeWeight * 100) / 100;
  const financialWeight = Math.round((1 - wokeWeight) * 100) / 100;

  if (wokeWeight !== prevWeight) {
    console.log(`[book:${bookId}] Woke weight adjusted: ${prevWeight} → ${wokeWeight} (${changeDescription})`);
    db.prepare(`
      UPDATE books SET woke_weight = ?, financial_weight = ? WHERE id = ?
    `).run(wokeWeight, financialWeight, bookId);
  } else {
    console.log(`[book:${bookId}] Woke weight unchanged at ${wokeWeight} (already at boundary). ${changeDescription}`);
  }
}

/**
 * Simple concurrency limiter — runs at most `concurrency` async tasks simultaneously.
 * Drop-in replacement for the `p-limit` npm package; no external dependency needed.
 *
 * Usage:
 *   const limit = pLimit(5);
 *   const results = await Promise.all(items.map(item => limit(() => asyncWork(item))));
 *
 * @param {number} concurrency - max simultaneous in-flight promises
 * @returns {function} limit(fn) — wraps an async task factory, queuing if at capacity
 */
function pLimit(concurrency) {
  let running = 0;
  const queue = [];

  function next() {
    if (running >= concurrency || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      running--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = { logDecision, snapshotPortfolio, getBookValue, adjustWeights, pLimit };
