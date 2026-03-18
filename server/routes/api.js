 /**
 * REST API routes for the dashboard.
 *
 * Changes from original:
 *   - Added GET /api/summaries and GET /api/summaries/latest
 *   - Removed PATCH /api/books/:id/pause (no pause logic)
 *   - Removed woke_weight and financial_weight from PATCH /api/settings (now per-book)
 *   - GET /api/books/:id now includes woke_weight and financial_weight from the book row
 *   - Added PATCH /api/books/:id/weights to update per-book weights
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/index');
const alpaca = require('../services/alpaca');
const { runAgentCycle } = require('../agent');

function db() { return getDb(); }

// ─── Status ─────────────────────────────────────────────────────────────────

// GET /api/status — overall system status
router.get('/status', async (req, res) => {
  try {
    const clock = await alpaca.getClock();
    const account = await alpaca.getAccount();
    const cycleCount = db().prepare('SELECT value FROM settings WHERE key = ?').get('agent_cycle_count');

    res.json({
      market_open: clock.is_open,
      next_open: clock.next_open,
      next_close: clock.next_close,
      account: {
        equity: account.equity,
        cash: account.cash,
        buying_power: account.buying_power,
        portfolio_value: account.portfolio_value,
      },
      cycle_count: Number(cycleCount?.value || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Books ───────────────────────────────────────────────────────────────────

// GET /api/books — both books overview
// Fetches live values from Alpaca on every request so the dashboard always
// reflects reality, not stored estimates. Cash is split 50/50 between books
// (both started with equal capital; Alpaca has no concept of our book split).
// P&L is computed relative to the live account equity split, not the seeded
// book.capital value, so it stays grounded in what Alpaca actually reports.
router.get('/books', async (req, res) => {
  try {
    const books = db().prepare('SELECT * FROM books').all();

    // Fetch live Alpaca data once and share across both books
    const [account, alpacaPositions] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
    ]);

    const totalAccountCash  = parseFloat(account.cash);
    const totalAccountEquity = parseFloat(account.equity);

    // Each book's live cash = half the real Alpaca cash balance
    const cashPerBook = totalAccountCash / 2;

    const enriched = books.map(book => {
      // Determine which Alpaca positions belong to this book via trade history
      const myTrades = db().prepare(`
        SELECT ticker,
               SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares
        FROM trades WHERE book_id = ?
        GROUP BY ticker HAVING net_shares > 0.001
      `).all(book.id);
      const myTickers = new Set(myTrades.map(t => t.ticker));

      // Live invested value: sum real Alpaca market_value for this book's positions
      const myPositions = alpacaPositions.filter(p => myTickers.has(p.symbol));
      const investedValue = myPositions.reduce((sum, p) => sum + parseFloat(p.market_value || 0), 0);

      // Live total value and P&L — grounded entirely in Alpaca numbers
      const totalValue  = cashPerBook + investedValue;
      const startingValue = totalAccountEquity / 2; // baseline = half of current equity (best available proxy)
      const pnl    = totalValue - startingValue;
      const pnlPct = startingValue > 0 ? (pnl / startingValue) * 100 : 0;

      // Build a live snapshot object in the same shape as portfolio_snapshots rows
      // so the frontend doesn't need to change
      const liveSnapshot = {
        book_id:     book.id,
        total_value: totalValue,
        cash:        cashPerBook,
        invested:    investedValue,
        pnl,
        pnl_pct:     pnlPct,
        snapped_at:  new Date().toISOString(),
        live:        true, // flag so the frontend can tell this is real-time
      };

      const holdingCount = db().prepare(`
        SELECT COUNT(DISTINCT ticker) as count FROM trades
        WHERE book_id = ?
        AND ticker NOT IN (
          SELECT ticker FROM trades t2
          WHERE t2.book_id = ? AND t2.side = 'sell'
          AND t2.created_at > (
            SELECT MAX(created_at) FROM trades t3
            WHERE t3.book_id = ? AND t3.ticker = t2.ticker AND t3.side = 'buy'
          )
        )
      `).get(book.id, book.id, book.id);

      const recentTrade = db().prepare(`
        SELECT * FROM trades WHERE book_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(book.id);

      const avgWoke = db().prepare(`
        SELECT AVG(woke_score) as avg FROM trades
        WHERE book_id = ? AND woke_score IS NOT NULL
        AND created_at >= date('now', '-7 days')
      `).get(book.id);

      return {
        ...book,
        snapshot:          liveSnapshot,    // always live from Alpaca, never stale
        holding_count:     holdingCount?.count || 0,
        last_trade:        recentTrade,
        avg_woke_score_7d: avgWoke?.avg ? Math.round(avgWoke.avg) : null,
      };
    });

    res.json(enriched);
  } catch (e) {
    console.error('[api] /books failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/books/:id — single book detail including current weights
router.get('/books/:id', (req, res) => {
  const book = db().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const holdings = db().prepare(`
    SELECT
      t.ticker,
      SUM(CASE WHEN t.side='buy' THEN t.shares ELSE -t.shares END) as net_shares,
      AVG(CASE WHEN t.side='buy' THEN t.price END) as avg_cost,
      MAX(t.created_at) as last_updated,
      ws.score as woke_score,
      ws.explanation as woke_explanation,
      fs.score as financial_score,
      fs.explanation as financial_explanation
    FROM trades t
    LEFT JOIN woke_scores ws ON ws.ticker = t.ticker
    LEFT JOIN financial_scores fs ON fs.ticker = t.ticker
    WHERE t.book_id = ?
    GROUP BY t.ticker
    HAVING net_shares > 0.001
    ORDER BY t.ticker
  `).all(req.params.id);

  const snapshots = db().prepare(`
    SELECT * FROM portfolio_snapshots
    WHERE book_id = ? ORDER BY snapped_at DESC LIMIT 200
  `).all(req.params.id);

  // book row includes woke_weight and financial_weight from the books table
  res.json({ book, holdings, snapshots: snapshots.reverse() });
});

// PATCH /api/books/:id/weights — manually override a book's woke/financial weights
// Weights must sum to 1.0 and stay within that book's allowed range.
router.patch('/books/:id/weights', (req, res) => {
  const book = db().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const { woke_weight } = req.body;
  if (typeof woke_weight !== 'number' || isNaN(woke_weight)) {
    return res.status(400).json({ error: 'woke_weight must be a number' });
  }

  // Enforce per-book boundaries
  let min, max;
  if (req.params.id === 'index') {
    min = 0.55; max = 0.80; // Book A never abandons ethics
  } else if (req.params.id === 'screener') {
    min = 0.15; max = 0.45; // Book B uses ethics tactically
  } else {
    min = 0.0; max = 1.0;
  }

  if (woke_weight < min || woke_weight > max) {
    return res.status(400).json({
      error: `woke_weight for book '${req.params.id}' must be between ${min} and ${max}`,
    });
  }

  const financialWeight = Math.round((1 - woke_weight) * 100) / 100;

  db().prepare(`
    UPDATE books SET woke_weight = ?, financial_weight = ? WHERE id = ?
  `).run(woke_weight, financialWeight, req.params.id);

  console.log(`[api] Book ${req.params.id} weights manually set: woke=${woke_weight}, financial=${financialWeight}`);
  res.json({ ok: true, woke_weight: woke_weight, financial_weight: financialWeight });
});

// ─── Logs & Trades ───────────────────────────────────────────────────────────

// GET /api/books/:id/log — agent decision log
router.get('/books/:id/log', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const log = db().prepare(`
    SELECT * FROM agent_log
    WHERE book_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(req.params.id, limit);
  res.json(log);
});

// GET /api/books/:id/trades — trade history
router.get('/books/:id/trades', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const trades = db().prepare(`
    SELECT * FROM trades WHERE book_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(req.params.id, limit);
  res.json(trades);
});

// ─── Scores ──────────────────────────────────────────────────────────────────

// GET /api/scores/:ticker — scores for a ticker
router.get('/scores/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const woke = db().prepare('SELECT * FROM woke_scores WHERE ticker = ?').get(ticker);
  const financial = db().prepare('SELECT * FROM financial_scores WHERE ticker = ?').get(ticker);
  res.json({ ticker, woke, financial });
});

// ─── Settings ────────────────────────────────────────────────────────────────

// GET /api/settings — all settings
router.get('/settings', (req, res) => {
  const settings = db().prepare('SELECT * FROM settings ORDER BY key').all();
  res.json(Object.fromEntries(settings.map(s => [s.key, s.value])));
});

// PATCH /api/settings — update settings
// Note: woke_weight and financial_weight are no longer global settings —
// they live as columns on the books table and are updated via PATCH /api/books/:id/weights.
router.patch('/settings', (req, res) => {
  const allowed = [
    'woke_floor',
    'max_position_pct',
    'max_trade_size',
    'trade_cooldown_minutes',
    'news_enabled',
    'woke_score_ttl_hours',
    'financial_score_ttl_minutes',
  ];
  const updates = req.body;

  const update = db().prepare(`UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?`);
  const applied = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    update.run(String(value), key);
    applied.push(key);
  }

  console.log(`[api] Settings updated: ${applied.join(', ') || 'none'}`);
  res.json({ ok: true, applied });
});

// ─── Summaries ───────────────────────────────────────────────────────────────

// GET /api/summaries — all daily summaries ordered by date desc
router.get('/summaries', (req, res) => {
  const limit = Number(req.query.limit) || 30;
  const summaries = db().prepare(`
    SELECT * FROM daily_summaries
    ORDER BY date DESC LIMIT ?
  `).all(limit);
  res.json(summaries);
});

// GET /api/summaries/latest — most recent summary only
router.get('/summaries/latest', (req, res) => {
  const summary = db().prepare(`
    SELECT * FROM daily_summaries
    ORDER BY date DESC LIMIT 1
  `).get();

  if (!summary) {
    return res.status(404).json({ error: 'No summaries yet.' });
  }
  res.json(summary);
});

// ─── Agent ───────────────────────────────────────────────────────────────────

// POST /api/agent/trigger — manually trigger a cycle (useful for testing)
router.post('/agent/trigger', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Cycle triggered.' });
    // Run async after response so the HTTP response returns immediately
    runAgentCycle().catch(console.error);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
