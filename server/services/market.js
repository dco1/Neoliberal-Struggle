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

    db.exec('BEGIN');
    for (const row of lines) {
      const [ticker, company, sector] = row.split(',').map(s => s.replace(/"/g, '').trim());
      if (ticker) upsert.run(ticker, company || '', sector || '');
    }
    db.exec('COMMIT');
    console.log(`[market] Refreshed S&P 500 tickers (${lines.length} companies).`);
  } catch (e) {
    console.error('[market] Failed to refresh S&P 500 tickers:', e.message);
    // If the remote fetch failed, seed from the static fallback so the
    // agent always has a universe to work with.
    seedFallbackTickers();
  }
}

/**
 * Ensure the S&P 500 ticker table has data.
 * Called on startup — if the table is empty (e.g. first run, or server restarted
 * mid-session after market already opened), fetch immediately rather than waiting
 * for the 9:30am cron.
 */
async function ensureSP500Tickers() {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) as count FROM sp500_tickers').get();
  if (count === 0) {
    console.log('[market] sp500_tickers is empty — fetching immediately on startup...');
    await refreshSP500Tickers();
  } else {
    console.log(`[market] sp500_tickers already loaded (${count} tickers).`);
  }
}

/**
 * Static fallback — a broad, representative slice of the S&P 500.
 * Used when the remote CSV is unavailable so the agent always has a universe.
 * Covers all 11 GICS sectors. Refreshed from the real source at market open.
 */
function seedFallbackTickers() {
  const db = getDb();
  const fallback = [
    // Technology
    ['AAPL','Apple Inc','Information Technology'],
    ['MSFT','Microsoft Corporation','Information Technology'],
    ['NVDA','NVIDIA Corporation','Information Technology'],
    ['AVGO','Broadcom Inc','Information Technology'],
    ['ORCL','Oracle Corporation','Information Technology'],
    ['CRM','Salesforce Inc','Information Technology'],
    ['AMD','Advanced Micro Devices','Information Technology'],
    ['ACN','Accenture plc','Information Technology'],
    ['INTC','Intel Corporation','Information Technology'],
    ['CSCO','Cisco Systems','Information Technology'],
    ['IBM','IBM','Information Technology'],
    ['TXN','Texas Instruments','Information Technology'],
    // Communication Services
    ['GOOGL','Alphabet Inc Class A','Communication Services'],
    ['META','Meta Platforms','Communication Services'],
    ['NFLX','Netflix Inc','Communication Services'],
    ['DIS','Walt Disney Co','Communication Services'],
    ['CMCSA','Comcast Corporation','Communication Services'],
    ['VZ','Verizon Communications','Communication Services'],
    ['T','AT&T Inc','Communication Services'],
    // Consumer Discretionary
    ['AMZN','Amazon.com Inc','Consumer Discretionary'],
    ['TSLA','Tesla Inc','Consumer Discretionary'],
    ['HD','Home Depot','Consumer Discretionary'],
    ['MCD','McDonald\'s Corporation','Consumer Discretionary'],
    ['NKE','Nike Inc','Consumer Discretionary'],
    ['SBUX','Starbucks Corporation','Consumer Discretionary'],
    ['TGT','Target Corporation','Consumer Discretionary'],
    ['LOW','Lowe\'s Companies','Consumer Discretionary'],
    // Consumer Staples
    ['WMT','Walmart Inc','Consumer Staples'],
    ['PG','Procter & Gamble','Consumer Staples'],
    ['KO','Coca-Cola Company','Consumer Staples'],
    ['PEP','PepsiCo Inc','Consumer Staples'],
    ['COST','Costco Wholesale','Consumer Staples'],
    ['PM','Philip Morris International','Consumer Staples'],
    ['MDLZ','Mondelez International','Consumer Staples'],
    // Financials
    ['JPM','JPMorgan Chase','Financials'],
    ['BAC','Bank of America','Financials'],
    ['WFC','Wells Fargo','Financials'],
    ['GS','Goldman Sachs','Financials'],
    ['MS','Morgan Stanley','Financials'],
    ['BLK','BlackRock Inc','Financials'],
    ['AXP','American Express','Financials'],
    ['V','Visa Inc','Financials'],
    ['MA','Mastercard Inc','Financials'],
    // Healthcare
    ['UNH','UnitedHealth Group','Health Care'],
    ['JNJ','Johnson & Johnson','Health Care'],
    ['LLY','Eli Lilly and Company','Health Care'],
    ['ABBV','AbbVie Inc','Health Care'],
    ['MRK','Merck & Co','Health Care'],
    ['TMO','Thermo Fisher Scientific','Health Care'],
    ['ABT','Abbott Laboratories','Health Care'],
    ['PFE','Pfizer Inc','Health Care'],
    ['AMGN','Amgen Inc','Health Care'],
    // Industrials
    ['CAT','Caterpillar Inc','Industrials'],
    ['BA','Boeing Company','Industrials'],
    ['HON','Honeywell International','Industrials'],
    ['UPS','United Parcel Service','Industrials'],
    ['RTX','RTX Corporation','Industrials'],
    ['LMT','Lockheed Martin','Industrials'],
    ['GE','GE Aerospace','Industrials'],
    ['DE','Deere & Company','Industrials'],
    // Energy
    ['XOM','Exxon Mobil Corporation','Energy'],
    ['CVX','Chevron Corporation','Energy'],
    ['COP','ConocoPhillips','Energy'],
    ['SLB','SLB','Energy'],
    ['EOG','EOG Resources','Energy'],
    // Materials
    ['LIN','Linde plc','Materials'],
    ['APD','Air Products and Chemicals','Materials'],
    ['ECL','Ecolab Inc','Materials'],
    ['NEM','Newmont Corporation','Materials'],
    // Real Estate
    ['PLD','Prologis Inc','Real Estate'],
    ['AMT','American Tower','Real Estate'],
    ['EQIX','Equinix Inc','Real Estate'],
    ['SPG','Simon Property Group','Real Estate'],
    // Utilities
    ['NEE','NextEra Energy','Utilities'],
    ['DUK','Duke Energy','Utilities'],
    ['SO','Southern Company','Utilities'],
    ['AEP','American Electric Power','Utilities'],
  ];

  const upsert = db.prepare(`
    INSERT INTO sp500_tickers (ticker, company, sector, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO NOTHING
  `);
  db.exec('BEGIN');
  for (const [ticker, company, sector] of fallback) {
    upsert.run(ticker, company, sector);
  }
  db.exec('COMMIT');
  console.log(`[market] Seeded ${fallback.length} fallback tickers. Will refresh from source at next market open.`);
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
  ensureSP500Tickers,
  getSP500Tickers,
  getTickerMetrics,
  screenTickers,
  rankByMomentum,
};
