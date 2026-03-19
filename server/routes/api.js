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
// reflects reality, not stored estimates.
//
// ── Cash split ───────────────────────────────────────────────────────────────
// Cash is divided proportionally based on each book's undeployed capital
// fraction (same logic as shared.js getBookValue).
//
// ── Invested value ───────────────────────────────────────────────────────────
// Computed from TRADE RECORDS × CURRENT PRICE, not from Alpaca market_value.
// This prevents double-counting: when both books hold the same ticker, each
// only counts the shares it actually bought. Using Alpaca's market_value and
// filtering by ticker would give both books the full position value.
//
// ── P&L baseline ─────────────────────────────────────────────────────────────
// On the very first successful Alpaca call, (account.equity / 2) is stored as
// initial_equity_per_book. All P&L is measured against that fixed value.
router.get('/books', async (req, res) => {
  try {
    const books = db().prepare('SELECT * FROM books').all();

    // Fetch live Alpaca data once and share across both books
    const [account, alpacaPositions] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
    ]);

    const totalAccountCash   = parseFloat(account.cash);
    const totalAccountEquity = parseFloat(account.equity);

    // ── P&L baseline ────────────────────────────────────────────────
    const stored = db().prepare(`SELECT value FROM settings WHERE key = 'initial_equity_per_book'`).get();
    let initialEquityPerBook = stored ? parseFloat(stored.value) : 0;

    if (initialEquityPerBook <= 0 && totalAccountEquity > 0) {
      initialEquityPerBook = totalAccountEquity / 2;
      db().prepare(`
        UPDATE settings SET value = ?, updated_at = datetime('now')
        WHERE key = 'initial_equity_per_book'
      `).run(String(initialEquityPerBook));
      console.log(`[api] Initial equity per book locked in: $${initialEquityPerBook.toFixed(2)}`);
    }

    // ── Cash split (proportional by undeployed capital) ─────────────
    // Mirrors the logic in server/books/shared.js getBookValue().
    function getNetSpend(bookId) {
      const row = db().prepare(`
        SELECT SUM(CASE WHEN side='buy' THEN total_value ELSE -total_value END) as net
        FROM trades WHERE book_id = ?
      `).get(bookId);
      return Math.max(0, row?.net ?? 0);
    }

    const remainders = {};
    let totalRemaining = 0;
    for (const b of books) {
      const r = Math.max(0, b.capital - getNetSpend(b.id));
      remainders[b.id] = r;
      totalRemaining += r;
    }

    // ── Current price map from Alpaca positions ──────────────────────
    // Used to mark-to-market each book's net shares at today's price.
    const priceMap = new Map(
      alpacaPositions.map(p => [p.symbol, parseFloat(p.current_price)])
    );

    const enriched = books.map(book => {
      // Each book's proportional share of the real Alpaca cash balance
      const cashPerBook = totalRemaining > 0
        ? totalAccountCash * (remainders[book.id] / totalRemaining)
        : totalAccountCash / 2;

      // Net shares per ticker this book holds, from trade history
      const netPositions = db().prepare(`
        SELECT ticker,
               SUM(CASE WHEN side='buy' THEN shares ELSE -shares END) as net_shares,
               SUM(CASE WHEN side='buy' THEN total_value ELSE 0 END) /
               NULLIF(SUM(CASE WHEN side='buy' THEN shares ELSE 0 END), 0) as avg_cost
        FROM trades WHERE book_id = ?
        GROUP BY ticker HAVING net_shares > 0.001
      `).all(book.id);

      // Invested value = this book's net shares × current market price.
      // Falls back to avg_cost if Alpaca doesn't have a price (e.g. position
      // was fully sold on Alpaca's side but our trades table still shows it).
      const investedValue = netPositions.reduce((sum, pos) => {
        const price = priceMap.get(pos.ticker) ?? pos.avg_cost;
        return sum + (pos.net_shares * price);
      }, 0);

      // Live total value and P&L
      const totalValue    = cashPerBook + investedValue;
      const startingValue = initialEquityPerBook > 0 ? initialEquityPerBook : (totalAccountEquity / 2);
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

// POST /api/admin/export-scores — trigger a scores.json export immediately.
// Waits for the result and returns a summary (useful for testing).
router.post('/admin/export-scores', async (req, res) => {
  try {
    const { exportScores } = require('../services/export');
    await exportScores();
    res.json({ ok: true, message: 'Export complete — check server logs for details.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/regenerate-summaries — delete today's summary and re-run generation.
// Intended for manual use when the market is closed and a re-run is needed.
router.post('/admin/regenerate-summaries', async (req, res) => {
  try {
    const { generateDailySummaries } = require('../services/summaries');
    const today = new Date().toISOString().split('T')[0];
    // Remove today's record so generateDailySummaries() doesn't skip it as a duplicate
    db().prepare('DELETE FROM daily_summaries WHERE date = ?').run(today);
    await generateDailySummaries();
    // Also push the fresh reflection to GitHub Pages
    const { exportReflections } = require('../services/export');
    await exportReflections();
    res.json({ ok: true, message: 'Summaries regenerated and pushed to GitHub Pages.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/fix-summary-pnl — patch a past day's P&L in daily_summaries.
// If book_a_pnl_pct / book_b_pnl_pct are provided in the body, use those directly.
// Otherwise fall back to the best portfolio_snapshot for that date.
// Body: { date: "2026-03-19", book_a_pnl_pct: 13.76, book_b_pnl_pct: 18.83 }
router.post('/admin/fix-summary-pnl', async (req, res) => {
  try {
    const date = (req.body?.date || new Date().toISOString().split('T')[0]).trim();
    const d = db();

    let pnlA = req.body?.book_a_pnl_pct != null ? parseFloat(req.body.book_a_pnl_pct) : null;
    let pnlB = req.body?.book_b_pnl_pct != null ? parseFloat(req.body.book_b_pnl_pct) : null;

    // Fall back to portfolio snapshots if not manually provided
    if (pnlA == null || pnlB == null) {
      const getSnap = (bookId) => d.prepare(`
        SELECT pnl_pct FROM portfolio_snapshots
        WHERE book_id = ? AND date(snapped_at) = ?
        ORDER BY snapped_at DESC LIMIT 1
      `).get(bookId, date);
      if (pnlA == null) pnlA = getSnap('index')?.pnl_pct ?? null;
      if (pnlB == null) pnlB = getSnap('screener')?.pnl_pct ?? null;
    }

    if (pnlA == null && pnlB == null) {
      return res.status(404).json({ ok: false, error: `No P&L data found for ${date} — provide values manually.` });
    }

    d.prepare(`
      UPDATE daily_summaries
      SET book_a_pnl_pct = COALESCE(?, book_a_pnl_pct),
          book_b_pnl_pct = COALESCE(?, book_b_pnl_pct)
      WHERE date = ?
    `).run(pnlA, pnlB, date);

    const { exportReflections } = require('../services/export');
    await exportReflections();

    res.json({
      ok: true,
      date,
      book_a_pnl_pct: snapA?.pnl_pct ?? null,
      book_b_pnl_pct: snapB?.pnl_pct ?? null,
      message: `P&L patched and reflections re-exported.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
