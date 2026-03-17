/**
 * Shared utilities for book strategies.
 */

const { getDb } = require('../db/index');

function logDecision(bookId, cycle, action, ticker, reasoning) {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_log (book_id, cycle, action, ticker, reasoning)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, cycle, action, ticker || null, reasoning);
}

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

module.exports = { logDecision, snapshotPortfolio, getBookCash };
