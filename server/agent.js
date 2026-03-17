/**
 * Agent orchestrator.
 *
 * Runs both book loops every 15 minutes, all day, every day.
 * Market status is checked via the Alpaca API at the start of each cycle —
 * if the market is closed, the cycle is skipped but the cron keeps running.
 *
 * At 4:15pm ET on weekdays, generates end-of-day summaries for both books.
 *
 * No pause resets. No daily loss limits. No hardcoded market-hours cron window.
 */

const cron = require('node-cron');
const alpaca = require('./services/alpaca');
const market = require('./services/market');
const { generateDailySummaries } = require('./services/summaries');
const { getDb } = require('./db/index');

const indexBook = require('./books/index-universe');
const screenerBook = require('./books/screener-universe');

let cycleCount = 0;
let isRunning = false;

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?
  `).run(String(value), key);
}

/**
 * Main agent cycle — runs every 15 minutes.
 * Checks Alpaca market clock first; exits early if market is closed.
 * Runs both books sequentially to avoid Alpaca API rate limits.
 */
async function runAgentCycle() {
  if (isRunning) {
    console.log('[agent] Cycle already running, skipping.');
    return;
  }

  // Check market status via Alpaca API — this is the authoritative source.
  // We do NOT rely on hardcoded time windows in the cron expression.
  try {
    const open = await alpaca.isMarketOpen();
    if (!open) {
      console.log('[agent] Market is closed (Alpaca API). Skipping cycle.');
      return;
    }
  } catch (e) {
    console.error('[agent] Could not check market status:', e.message);
    return;
  }

  isRunning = true;
  cycleCount++;
  setSetting('agent_cycle_count', cycleCount);

  console.log(`\n[agent] ===== Cycle ${cycleCount} =====`);

  try {
    // Run both books sequentially to avoid API rate limit issues
    await indexBook.runCycle(cycleCount);
    await screenerBook.runCycle(cycleCount);
  } catch (e) {
    console.error('[agent] Unhandled error in cycle:', e);
  } finally {
    isRunning = false;
    console.log(`[agent] ===== Cycle ${cycleCount} done =====\n`);
  }
}

/**
 * Market open daily setup.
 * Runs at 9:30am ET on weekdays to refresh the S&P 500 ticker list.
 * No pause resets — books always run.
 */
async function runMarketOpenSetup() {
  console.log('[agent] Market open — running daily setup.');

  // Refresh S&P 500 ticker list so we have current constituents
  await market.refreshSP500Tickers();

  console.log('[agent] Daily setup complete.');
}

/**
 * End-of-day summary generation.
 * Runs at 4:15pm ET on weekdays — 15 minutes after market close.
 * Each book reflects on its own day and comments on the other.
 */
async function runEndOfDaySummary() {
  console.log('[agent] Running end-of-day summary generation...');
  try {
    await generateDailySummaries();
    console.log('[agent] End-of-day summaries complete.');
  } catch (e) {
    console.error('[agent] Failed to generate end-of-day summaries:', e.message);
  }
}

function startAgent() {
  console.log('[agent] Starting. Cycle every 15 minutes (market status checked via Alpaca API).');

  // Restore cycle count from DB so the counter survives restarts
  const saved = getSetting('agent_cycle_count');
  if (saved) cycleCount = Number(saved);

  // --- Scheduled jobs ---

  // Market open: 9:30am ET weekdays — refresh ticker universe
  cron.schedule('30 9 * * 1-5', runMarketOpenSetup, { timezone: 'America/New_York' });
  console.log('[agent] Scheduled: market open setup at 09:30 ET weekdays.');

  // Agent cycle: every 15 minutes, all day, every day.
  // Market-closed cycles are handled inside runAgentCycle via the Alpaca API check.
  cron.schedule('*/15 * * * *', runAgentCycle);
  console.log('[agent] Scheduled: agent cycle */15 * * * * (all day, market check inside cycle).');

  // End-of-day summaries: 4:15pm ET on weekdays (15 min after close)
  cron.schedule('15 16 * * 1-5', runEndOfDaySummary, { timezone: 'America/New_York' });
  console.log('[agent] Scheduled: end-of-day summary at 16:15 ET weekdays.');

  // Run a cycle immediately on startup (will no-op if market is closed)
  console.log('[agent] Running immediate startup cycle...');
  runAgentCycle().catch(console.error);
}

module.exports = { startAgent, runAgentCycle };
