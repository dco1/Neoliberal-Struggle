/**
 * Agent orchestrator.
 * Runs both book loops on a schedule during market hours.
 * Resets daily guardrails at market open.
 */

const cron = require('node-cron');
const alpaca = require('./services/alpaca');
const market = require('./services/market');
const guardrails = require('./services/guardrails');
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

async function runAgentCycle() {
  if (isRunning) {
    console.log('[agent] Cycle already running, skipping.');
    return;
  }

  try {
    const open = await alpaca.isMarketOpen();
    if (!open) {
      console.log('[agent] Market is closed. Skipping cycle.');
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

async function runMarketOpenSetup() {
  console.log('[agent] Market open — running daily setup.');

  // Reset daily loss limit pauses
  guardrails.resetDailyPause('index');
  guardrails.resetDailyPause('screener');

  // Refresh S&P 500 ticker list
  await market.refreshSP500Tickers();

  console.log('[agent] Daily setup complete.');
}

function startAgent() {
  const intervalMinutes = Number(process.env.AGENT_INTERVAL_MINUTES) || 15;
  console.log(`[agent] Starting. Cycle every ${intervalMinutes} minutes during market hours.`);

  // Load cycle count from DB
  const saved = getSetting('agent_cycle_count');
  if (saved) cycleCount = Number(saved);

  // Market open: 9:30 ET — reset daily state and refresh tickers
  cron.schedule('30 9 * * 1-5', runMarketOpenSetup, { timezone: 'America/New_York' });

  // Agent loop: every N minutes on weekdays
  const cronExpr = `*/${intervalMinutes} 9-16 * * 1-5`;
  cron.schedule(cronExpr, runAgentCycle, { timezone: 'America/New_York' });

  console.log(`[agent] Scheduled: ${cronExpr} (ET, weekdays only)`);

  // Run immediately on startup if market is open
  runAgentCycle().catch(console.error);
}

module.exports = { startAgent, runAgentCycle };
