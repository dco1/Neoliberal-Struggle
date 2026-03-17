/**
 * REST API routes for the dashboard.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/index');
const alpaca = require('../services/alpaca');
const { runAgentCycle } = require('../agent');

function db() { return getDb(); }

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

// GET /api/books — both books overview
router.get('/books', (req, res) => {
  const books = db().prepare('SELECT * FROM books').all();

  const enriched = books.map(book => {
    const latestSnapshot = db().prepare(`
      SELECT * FROM portfolio_snapshots
      WHERE book_id = ? ORDER BY snapped_at DESC LIMIT 1
    `).get(book.id);

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
      snapshot: latestSnapshot,
      holding_count: holdingCount?.count || 0,
      last_trade: recentTrade,
      avg_woke_score_7d: avgWoke?.avg ? Math.round(avgWoke.avg) : null,
    };
  });

  res.json(enriched);
});

// GET /api/books/:id — single book detail
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

  res.json({ book, holdings, snapshots: snapshots.reverse() });
});

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

// GET /api/scores/:ticker — scores for a ticker
router.get('/scores/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const woke = db().prepare('SELECT * FROM woke_scores WHERE ticker = ?').get(ticker);
  const financial = db().prepare('SELECT * FROM financial_scores WHERE ticker = ?').get(ticker);
  res.json({ ticker, woke, financial });
});

// GET /api/settings — all settings
router.get('/settings', (req, res) => {
  const settings = db().prepare('SELECT * FROM settings ORDER BY key').all();
  res.json(Object.fromEntries(settings.map(s => [s.key, s.value])));
});

// PATCH /api/settings — update settings
router.patch('/settings', (req, res) => {
  const allowed = ['woke_weight', 'financial_weight', 'woke_floor', 'max_position_pct', 'max_trade_size', 'trade_cooldown_minutes'];
  const updates = req.body;

  const update = db().prepare(`UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?`);
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    update.run(String(value), key);
  }

  // Validate weights sum to 1
  const woke = db().prepare('SELECT value FROM settings WHERE key = ?').get('woke_weight');
  const fin = db().prepare('SELECT value FROM settings WHERE key = ?').get('financial_weight');
  if (woke && fin) {
    const sum = Number(woke.value) + Number(fin.value);
    if (Math.abs(sum - 1.0) > 0.01) {
      return res.status(400).json({ error: `Weights must sum to 1.0, got ${sum.toFixed(2)}` });
    }
  }

  res.json({ ok: true });
});

// POST /api/agent/trigger — manually trigger a cycle (useful for testing)
router.post('/agent/trigger', async (req, res) => {
  try {
    res.json({ ok: true, message: 'Cycle triggered.' });
    // Run async after response
    runAgentCycle().catch(console.error);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/books/:id/pause — manually pause/unpause a book
router.patch('/books/:id/pause', (req, res) => {
  const { paused, reason } = req.body;
  db().prepare(`UPDATE books SET paused = ?, pause_reason = ? WHERE id = ?`)
    .run(paused ? 1 : 0, paused ? (reason || 'Manually paused') : null, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
