/**
 * Market data helpers.
 * Fetches S&P 500 constituents and computes financial metrics for scoring.
 */

const alpaca = require('./alpaca');
const { getDb } = require('../db/index');

// S&P 500 tickers — static list, refreshed periodically
// Using a well-known subset to start; can expand to full index
const SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

async function refreshSP500Tickers() {
  const db = getDb();
  try {
    const res = await fetch(SP500_URL);
    const csv = await res.text();
    const lines = csv.trim().split('\n').slice(1); // skip header

    const upsert = db.prepare(`
      INSERT INTO sp500_tickers (ticker, company, sector, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(ticker) DO UPDATE SET
        company = excluded.company,
        sector = excluded.sector,
        updated_at = excluded.updated_at
    `);

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const [ticker, company, sector] = row.split(',').map(s => s.replace(/"/g, '').trim());
        if (ticker) upsert.run(ticker, company || '', sector || '');
      }
    });

    insertMany(lines);
    console.log(`[market] Refreshed S&P 500 tickers (${lines.length} companies).`);
  } catch (e) {
    console.error('[market] Failed to refresh S&P 500 tickers:', e.message);
  }
}

function getSP500Tickers() {
  const db = getDb();
  return db.prepare('SELECT ticker, company, sector FROM sp500_tickers ORDER BY ticker').all();
}

/**
 * Fetch snapshot data for a list of tickers and compute financial metrics.
 * Returns an array of { ticker, company, sector, price, metrics }
 */
async function getTickerMetrics(tickers) {
  // Alpaca snapshots endpoint accepts up to 1000 symbols
  const chunks = chunkArray(tickers, 100);
  const results = [];

  for (const chunk of chunks) {
    try {
      const snapshots = await alpaca.getSnapshots(chunk);
      for (const [ticker, snap] of Object.entries(snapshots)) {
        if (!snap || !snap.latestTrade) continue;

        const bar = snap.dailyBar || {};
        const prevBar = snap.prevDailyBar || {};
        const price = snap.latestTrade.p || bar.c || 0;
        const prevClose = prevBar.c || price;
        const dailyChangePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
        const volume = bar.v || 0;
        const vwap = bar.vw || price;
        const high = bar.h || price;
        const low = bar.l || price;
        const open = bar.o || price;

        results.push({
          ticker,
          price,
          metrics: {
            price,
            open,
            high,
            low,
            close: bar.c || price,
            vwap,
            volume,
            daily_change_pct: dailyChangePct,
            price_vs_vwap_pct: vwap ? ((price - vwap) / vwap) * 100 : 0,
            high_low_range_pct: low ? ((high - low) / low) * 100 : 0,
          },
        });
      }
    } catch (e) {
      console.error(`[market] Snapshot fetch failed for chunk:`, e.message);
    }
  }

  return results;
}

/**
 * Basic financial screener criteria for Book B.
 * Returns tickers that pass minimum bars before scoring.
 */
function screenTickers(tickerMetrics) {
  return tickerMetrics.filter(({ metrics }) => {
    if (!metrics.price || metrics.price < 5) return false;           // no penny stocks
    if (!metrics.volume || metrics.volume < 100000) return false;    // minimum liquidity
    if (Math.abs(metrics.daily_change_pct) > 15) return false;       // skip news-driven spikes
    return true;
  });
}

/**
 * Rank screened tickers by financial momentum score.
 * Simple composite: positive daily change + volume + price near vwap.
 */
function rankByMomentum(tickerMetrics) {
  return tickerMetrics
    .map(t => ({
      ...t,
      momentumScore:
        (t.metrics.daily_change_pct * 2) +
        (t.metrics.volume > 1000000 ? 10 : 0) +
        (Math.abs(t.metrics.price_vs_vwap_pct) < 1 ? 5 : 0),
    }))
    .sort((a, b) => b.momentumScore - a.momentumScore);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  refreshSP500Tickers,
  getSP500Tickers,
  getTickerMetrics,
  screenTickers,
  rankByMomentum,
};
