/**
 * Guardrails service.
 * Enforces position limits, loss limits, woke floors, and trade cooldowns.
 */

const { getDb } = require('../db/index');

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? Number(row.value) : null;
}

function getBook(bookId) {
  const db = getDb();
  return db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
}

/**
 * Check if a book is paused. If daily loss limit is tripped, pause it.
 */
function checkDailyLossLimit(bookId, currentValue) {
  const db = getDb();
  const book = getBook(bookId);
  if (!book || book.paused) return { paused: true, reason: book?.pause_reason || 'unknown' };

  const limitPct = getSetting('daily_loss_limit_pct') || 0.05;

  // Get today's first snapshot
  const todayStart = db.prepare(`
    SELECT total_value FROM portfolio_snapshots
    WHERE book_id = ? AND snapped_at >= date('now')
    ORDER BY snapped_at ASC LIMIT 1
  `).get(bookId);

  if (!todayStart) return { paused: false };

  const drawdown = (todayStart.total_value - currentValue) / todayStart.total_value;
  if (drawdown >= limitPct) {
    const reason = `Daily loss limit hit: down ${(drawdown * 100).toFixed(2)}% today.`;
    db.prepare(`UPDATE books SET paused = 1, pause_reason = ? WHERE id = ?`).run(reason, bookId);
    return { paused: true, reason };
  }

  return { paused: false };
}

/**
 * Check if a ticker is in cooldown for a book.
 */
function isInCooldown(bookId, ticker) {
  const db = getDb();
  const cooldownMinutes = getSetting('trade_cooldown_minutes') || 60;

  const row = db.prepare(`
    SELECT last_trade FROM trade_cooldowns
    WHERE book_id = ? AND ticker = ?
    AND last_trade > datetime('now', ?)
  `).get(bookId, ticker, `-${cooldownMinutes} minutes`);

  return !!row;
}

/**
 * Record a trade for cooldown purposes.
 */
function recordCooldown(bookId, ticker) {
  const db = getDb();
  db.prepare(`
    INSERT INTO trade_cooldowns (book_id, ticker, last_trade)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(book_id, ticker) DO UPDATE SET last_trade = datetime('now')
  `).run(bookId, ticker);
}

/**
 * Check if a proposed buy violates position size limits.
 * @param {string} bookId
 * @param {number} tradeValue - dollar value of proposed trade
 * @param {number} bookValue  - total current book value
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkPositionSize(bookId, ticker, tradeValue, bookValue) {
  const maxPct = getSetting('max_position_pct') || 0.10;
  const maxTradeSize = getSetting('max_trade_size') || 5000;

  if (tradeValue > maxTradeSize) {
    return {
      allowed: false,
      reason: `Trade value $${tradeValue.toFixed(0)} exceeds max trade size $${maxTradeSize}`,
    };
  }

  if (bookValue > 0 && (tradeValue / bookValue) > maxPct) {
    return {
      allowed: false,
      reason: `Trade would exceed max position size of ${(maxPct * 100).toFixed(0)}% of book`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a ticker's woke score clears the floor.
 */
function checkWokeFloor(wokeScore) {
  const floor = getSetting('woke_floor') || 30;
  if (wokeScore < floor) {
    return {
      allowed: false,
      reason: `Woke score ${wokeScore.toFixed(1)} is below floor of ${floor}. Hard pass.`,
    };
  }
  return { allowed: true };
}

/**
 * Reset a book's daily pause at market open.
 */
function resetDailyPause(bookId) {
  const db = getDb();
  db.prepare(`UPDATE books SET paused = 0, pause_reason = NULL WHERE id = ?`).run(bookId);
}

module.exports = {
  checkDailyLossLimit,
  isInCooldown,
  recordCooldown,
  checkPositionSize,
  checkWokeFloor,
  resetDailyPause,
};
