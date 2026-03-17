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
 * Compute this book's real cash and total portfolio value using the Alpaca API.
 *
 * Since both books share a single Alpaca paper account, we can't ask Alpaca
 * "how much cash does Book A have?" — it only knows the total account balance.
 * We split cash 50/50 (both books started with equal capital), which is the
 * fairest approximation. Invested value is precise: we filter Alpaca positions
 * to only those this book has traded, via our internal trade records.
 *
 * Returns { cash, investedValue, totalValue, account }
 *   - cash:          this book's share of real Alpaca cash (account.cash / 2)
 *   - investedValue: real market value of positions attributed to this book
 *   - totalValue:    cash + investedValue
 *   - account:       raw Alpaca account object (equity, buying_power, etc.)
 *
 * @param {string} bookId         - 'index' or 'screener'
 * @param {Array}  alpacaPositions - already-fetched Alpaca positions array
 */
async function getBookValue(bookId, alpacaPositions) {
  const db = getDb();

  // Fetch real account data from Alpaca — this is the authoritative cash number
  const account = await alpaca.getAccount();
  const totalAccountCash = parseFloat(account.cash);

  // Split cash equally — both books started with the same capital
  // and Alpaca doesn't track the per-book split
  const cash = totalAccountCash / 2;

  // Determine which tickers belong to this book from our internal trade records
  const myTrades = db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares
    FROM trades WHERE book_id = ?
    GROUP BY ticker HAVING net_shares > 0.001
  `).all(bookId);
  const myTickers = new Set(myTrades.map(t => t.ticker));

  // Filter Alpaca positions to only this book's holdings, sum real market values
  const myPositions = alpacaPositions.filter(p => myTickers.has(p.symbol));
  const investedValue = myPositions.reduce((sum, p) => sum + parseFloat(p.market_value || 0), 0);

  const totalValue = cash + investedValue;

  console.log(`[book:${bookId}] Alpaca account cash: $${totalAccountCash.toFixed(0)} → book share: $${cash.toFixed(0)} | invested: $${investedValue.toFixed(0)} | total: $${totalValue.toFixed(0)}`);

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

module.exports = { logDecision, snapshotPortfolio, getBookValue, adjustWeights };
