const { getDb } = require('./index');

function initSchema() {
  const db = getDb();

  // Core tables — all use IF NOT EXISTS so re-running is safe
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      capital     REAL NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      woke_weight      REAL NOT NULL DEFAULT 0.65,
      financial_weight REAL NOT NULL DEFAULT 0.35,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     TEXT NOT NULL REFERENCES books(id),
      ticker      TEXT NOT NULL,
      shares      REAL NOT NULL,
      avg_cost    REAL NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(book_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id       TEXT NOT NULL REFERENCES books(id),
      ticker        TEXT NOT NULL,
      side          TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      shares        REAL NOT NULL,
      price         REAL NOT NULL,
      total_value   REAL NOT NULL,
      reasoning     TEXT,
      composite_score REAL,
      woke_score    REAL,
      financial_score REAL,
      alpaca_order_id TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS woke_scores (
      ticker      TEXT PRIMARY KEY,
      score       REAL NOT NULL,
      explanation TEXT NOT NULL,
      breakdown   TEXT NOT NULL,
      scored_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_scores (
      ticker      TEXT PRIMARY KEY,
      score       REAL NOT NULL,
      explanation TEXT NOT NULL,
      metrics     TEXT NOT NULL,
      scored_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    CREATE TABLE IF NOT EXISTS agent_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     TEXT NOT NULL REFERENCES books(id),
      cycle       INTEGER NOT NULL,
      action      TEXT NOT NULL,
      ticker      TEXT,
      reasoning   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sp500_tickers (
      ticker      TEXT PRIMARY KEY,
      company     TEXT,
      sector      TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trade_cooldowns (
      book_id     TEXT NOT NULL REFERENCES books(id),
      ticker      TEXT NOT NULL,
      last_trade  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (book_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      date                    TEXT NOT NULL,
      book_a_summary          TEXT NOT NULL,
      book_b_summary          TEXT NOT NULL,
      book_a_commentary_on_b  TEXT NOT NULL,
      book_b_commentary_on_a  TEXT NOT NULL,
      book_a_pnl_pct          REAL,
      book_b_pnl_pct          REAL,
      book_a_woke_avg         REAL,
      book_b_woke_avg         REAL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Migrations: add columns to existing tables without breaking existing data ---

  // Add woke_weight and financial_weight to books if they don't exist yet
  // (safe to run on a fresh or existing database)
  try {
    db.exec(`ALTER TABLE books ADD COLUMN woke_weight REAL NOT NULL DEFAULT 0.65`);
    console.log('[db] Migration: added woke_weight to books.');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  try {
    db.exec(`ALTER TABLE books ADD COLUMN financial_weight REAL NOT NULL DEFAULT 0.35`);
    console.log('[db] Migration: added financial_weight to books.');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // Correction: if Book B got the wrong default weights from the migration
  // (ALTER TABLE applies the same DEFAULT to all existing rows), fix them now.
  const screener = db.prepare('SELECT woke_weight FROM books WHERE id = ?').get('screener');
  if (screener && screener.woke_weight === 0.65) {
    db.prepare('UPDATE books SET woke_weight = 0.25, financial_weight = 0.75 WHERE id = ?').run('screener');
    console.log('[db] Migration: corrected Book B weights to 0.25/0.75.');
  }

  // Seed books if not already present
  // Book A is ethics-first: woke_weight=0.65, financial_weight=0.35
  // Book B is performance-first: woke_weight=0.25, financial_weight=0.75
  const existingBooks = db.prepare('SELECT COUNT(*) as count FROM books').get();
  if (existingBooks.count === 0) {
    db.exec('BEGIN');
    db.prepare(`
      INSERT INTO books (id, name, description, capital, woke_weight, financial_weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'index',
      'Book A — Index Universe',
      'Scores every S&P 500 constituent. Holds best composite scorers. Ethics-first.',
      Number(process.env.BOOK_A_CAPITAL) || 50000,
      0.65,
      0.35
    );
    db.prepare(`
      INSERT INTO books (id, name, description, capital, woke_weight, financial_weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'screener',
      'Book B — Screener Universe',
      'Filters by financial criteria first, then applies woke scoring. Performance-forward.',
      Number(process.env.BOOK_B_CAPITAL) || 50000,
      0.25,
      0.75
    );
    db.exec('COMMIT');
    console.log('[db] Seeded books with starting weights.');
  }

  // Seed default settings
  // Note: woke_weight and financial_weight are now per-book columns, not global settings.
  // daily_loss_limit_pct is removed — no pausing logic.
  const defaults = {
    max_position_pct:          process.env.MAX_POSITION_PCT || '0.10',
    max_trade_size:            process.env.MAX_TRADE_SIZE || '5000',
    trade_cooldown_minutes:    process.env.TRADE_COOLDOWN_MINUTES || '60',
    woke_floor:                process.env.WOKE_FLOOR || '30',
    woke_score_ttl_hours:      '24',
    financial_score_ttl_minutes: '30',
    agent_cycle_count:         '0',
    news_enabled:              'false',
  };

  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`);
  db.exec('BEGIN');
  for (const [key, value] of Object.entries(defaults)) {
    upsert.run(key, String(value));
  }
  db.exec('COMMIT');

  console.log('[db] Schema initialized.');
}

module.exports = { initSchema };
