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

/**
 * Write a decision to the agent_log table.
 */
function logDecision(bookId, cycle, action, ticker, reasoning) {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_log (book_id, cycle, action, ticker, reasoning)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, cycle, action, ticker || null, reasoning);
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
 * Compute this book's remaining cash.
 * Since Alpaca is a single account, we track cash per book by summing our trade history.
 * Net = starting capital + all sell proceeds - all buy costs.
 */
async function getBookCash(bookId, startingCapital) {
  const db = getDb();
  const result = db.prepare(`
    SELECT
      SUM(CASE WHEN side = 'buy'  THEN -total_value ELSE 0 END) +
      SUM(CASE WHEN side = 'sell' THEN  total_value ELSE 0 END) as net
    FROM trades WHERE book_id = ?
  `).get(bookId);

  const net = result?.net || 0;
  return startingCapital + net;
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

module.exports = { logDecision, snapshotPortfolio, getBookCash, adjustWeights };
