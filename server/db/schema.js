const { getDb } = require('./index');

function initSchema() {
  const db = getDb();

  db.exec(`
    -- The two strategy books
    CREATE TABLE IF NOT EXISTS books (
      id          TEXT PRIMARY KEY,   -- 'index' or 'screener'
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      capital     REAL NOT NULL,      -- allocated starting capital
      active      INTEGER NOT NULL DEFAULT 1,
      paused      INTEGER NOT NULL DEFAULT 0,  -- 1 = guardrail tripped
      pause_reason TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Current holdings per book
    CREATE TABLE IF NOT EXISTS holdings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     TEXT NOT NULL REFERENCES books(id),
      ticker      TEXT NOT NULL,
      shares      REAL NOT NULL,
      avg_cost    REAL NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(book_id, ticker)
    );

    -- Full trade history
    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id       TEXT NOT NULL REFERENCES books(id),
      ticker        TEXT NOT NULL,
      side          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      shares        REAL NOT NULL,
      price         REAL NOT NULL,
      total_value   REAL NOT NULL,
      reasoning     TEXT,            -- plain-English explanation from agent
      composite_score REAL,
      woke_score    REAL,
      financial_score REAL,
      alpaca_order_id TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Woke scores (cached, updates slowly)
    CREATE TABLE IF NOT EXISTS woke_scores (
      ticker      TEXT PRIMARY KEY,
      score       REAL NOT NULL,        -- 0-100
      explanation TEXT NOT NULL,
      breakdown   TEXT NOT NULL,        -- JSON: per-dimension scores
      scored_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Financial scores (cached, updates each cycle)
    CREATE TABLE IF NOT EXISTS financial_scores (
      ticker      TEXT PRIMARY KEY,
      score       REAL NOT NULL,        -- 0-100
      explanation TEXT NOT NULL,
      metrics     TEXT NOT NULL,        -- JSON: raw metrics used
      scored_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Portfolio value snapshots (for charting)
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     TEXT NOT NULL REFERENCES books(id),
      total_value REAL NOT NULL,
      cash        REAL NOT NULL,
      invested    REAL NOT NULL,
      pnl         REAL NOT NULL,
      pnl_pct     REAL NOT NULL,
      snapped_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Agent decision log (every loop cycle per book)
    CREATE TABLE IF NOT EXISTS agent_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     TEXT NOT NULL REFERENCES books(id),
      cycle       INTEGER NOT NULL,       -- loop iteration count
      action      TEXT NOT NULL,          -- 'hold', 'buy', 'sell', 'skip', 'paused'
      ticker      TEXT,
      reasoning   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Global settings (key-value)
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Index of S&P 500 tickers (populated on startup)
    CREATE TABLE IF NOT EXISTS sp500_tickers (
      ticker      TEXT PRIMARY KEY,
      company     TEXT,
      sector      TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Trade cooldown tracking
    CREATE TABLE IF NOT EXISTS trade_cooldowns (
      book_id     TEXT NOT NULL REFERENCES books(id),
      ticker      TEXT NOT NULL,
      last_trade  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (book_id, ticker)
    );
  `);

  // Seed books if not already present
  const existingBooks = db.prepare('SELECT COUNT(*) as count FROM books').get();
  if (existingBooks.count === 0) {
    const insert = db.prepare(`
      INSERT INTO books (id, name, description, capital)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(
      'index',
      'Book A — Index Universe',
      'Scores every S&P 500 constituent. Holds best composite scorers. Ethics-first.',
      Number(process.env.BOOK_A_CAPITAL) || 50000
    );
    insert.run(
      'screener',
      'Book B — Screener Universe',
      'Filters by financial criteria first, then applies woke scoring. Performance-forward.',
      Number(process.env.BOOK_B_CAPITAL) || 50000
    );
  }

  // Seed default settings
  const defaults = {
    woke_weight: process.env.WOKE_WEIGHT || '0.4',
    financial_weight: process.env.FINANCIAL_WEIGHT || '0.6',
    max_position_pct: process.env.MAX_POSITION_PCT || '0.10',
    max_trade_size: process.env.MAX_TRADE_SIZE || '5000',
    daily_loss_limit_pct: process.env.DAILY_LOSS_LIMIT_PCT || '0.05',
    trade_cooldown_minutes: process.env.TRADE_COOLDOWN_MINUTES || '60',
    woke_floor: process.env.WOKE_FLOOR || '30',
    woke_score_ttl_hours: '24',
    financial_score_ttl_minutes: '30',
    agent_cycle_count: '0',
  };

  const upsert = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  for (const [key, value] of Object.entries(defaults)) {
    upsert.run(key, String(value));
  }

  console.log('[db] Schema initialized.');
}

module.exports = { initSchema };
