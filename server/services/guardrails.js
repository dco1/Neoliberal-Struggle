/**
 * Guardrails service.
 * Enforces position size limits, woke floor, and trade cooldowns.
 *
 * Pause logic has been entirely removed — books always run.
 * checkDailyLossLimit and resetDailyPause are gone.
 * isInCooldown / recordCooldown are kept for reference but books
 * no longer call them — the books themselves decide whether to use cooldowns.
 */

const { getDb } = require('../db/index');

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? Number(row.value) : null;
}

/**
 * Check if a ticker is in cooldown for a book.
 * Books no longer call this in their main loop, but the function
 * is kept here for optional use or future reinstatement.
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
 * Record a trade for cooldown tracking purposes.
 * Kept for optional use — books no longer call this in their loops.
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
 * @param {string} ticker
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
 * Check if a ticker's woke score clears the hard floor.
 * This is a non-negotiable ethical minimum for both books.
 * @param {number} wokeScore
 * @returns {{ allowed: boolean, reason?: string }}
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

module.exports = {
  isInCooldown,
  recordCooldown,
  checkPositionSize,
  checkWokeFloor,
};
