/**
 * Alpaca paper trading client.
 * Falls back to mock data when ALPACA_API_KEY is not set.
 */

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';

const DEMO_MODE = !process.env.ALPACA_API_KEY || process.env.ALPACA_API_KEY === 'your_paper_api_key_here';

if (DEMO_MODE) {
  console.log('[alpaca] No API key — running in demo mode with mock data.');
}

// --- Mock data ---

const MOCK_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'JPM', 'WMT', 'PG'];

function mockPrice(ticker) {
  // Deterministic-ish price based on ticker name, with small drift over time
  const base = { AAPL: 182, MSFT: 415, GOOGL: 175, AMZN: 195, TSLA: 172,
                  META: 525, NVDA: 875, JPM: 202, WMT: 87, PG: 165 };
  const p = base[ticker] || 100;
  // Add a small random walk so charts have movement
  return p + (Math.random() - 0.48) * p * 0.005;
}

function mockSnapshot(ticker) {
  const price = mockPrice(ticker);
  const prevClose = price * (1 + (Math.random() - 0.5) * 0.02);
  return {
    latestTrade: { p: price },
    dailyBar: {
      o: prevClose * 1.001,
      h: price * 1.01,
      l: price * 0.99,
      c: price,
      v: Math.floor(Math.random() * 5000000 + 500000),
      vw: price * (1 + (Math.random() - 0.5) * 0.003),
    },
    prevDailyBar: { c: prevClose },
  };
}

// --- HTTP helpers ---

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

async function get(path, base = BASE_URL) {
  const res = await fetch(`${base}${path}`, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca GET ${path} failed [${res.status}]: ${text}`);
  }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca POST ${path} failed [${res.status}]: ${text}`);
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Alpaca DELETE ${path} failed [${res.status}]: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// --- Account ---

async function getAccount() {
  if (DEMO_MODE) {
    return { equity: '100000.00', cash: '100000.00', buying_power: '100000.00', portfolio_value: '100000.00' };
  }
  return get('/v2/account');
}

// --- Market Clock ---

async function getClock() {
  if (DEMO_MODE) {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const isDuringHours = hour >= 9 && hour < 17;
    return { is_open: isWeekday && isDuringHours, next_open: null, next_close: null };
  }
  return get('/v2/clock');
}

async function isMarketOpen() {
  const clock = await getClock();
  return clock.is_open;
}

// --- Positions ---

async function getPositions() {
  if (DEMO_MODE) return [];
  return get('/v2/positions');
}

async function getPosition(ticker) {
  if (DEMO_MODE) return null;
  try {
    return await get(`/v2/positions/${ticker}`);
  } catch (e) {
    if (e.message.includes('404')) return null;
    throw e;
  }
}

// --- Orders ---

async function placeMarketOrder({ ticker, side, notional = null, qty = null }) {
  if (DEMO_MODE) {
    console.log(`[alpaca:demo] ${side.toUpperCase()} ${ticker} notional=${notional} qty=${qty}`);
    return { id: `demo-${Date.now()}`, symbol: ticker, side, status: 'filled' };
  }
  const body = {
    symbol: ticker,
    side,
    type: 'market',
    time_in_force: 'day',
  };
  if (notional !== null) {
    body.notional = notional.toFixed(2);
  } else if (qty !== null) {
    body.qty = qty;
  } else {
    throw new Error('placeMarketOrder requires either notional or qty');
  }
  return post('/v2/orders', body);
}

async function getOpenOrders() {
  if (DEMO_MODE) return [];
  return get('/v2/orders?status=open');
}

async function cancelOrder(orderId) {
  if (DEMO_MODE) return null;
  return del(`/v2/orders/${orderId}`);
}

async function cancelAllOrders() {
  if (DEMO_MODE) return null;
  return del('/v2/orders');
}

// --- Market Data ---

async function getLatestQuotes(tickers) {
  if (DEMO_MODE) {
    return Object.fromEntries(tickers.map(t => [t, { ap: mockPrice(t) }]));
  }
  const symbols = tickers.join(',');
  return get(`/v2/stocks/quotes/latest?symbols=${symbols}`, DATA_URL);
}

async function getLatestBars(tickers) {
  if (DEMO_MODE) {
    return { bars: Object.fromEntries(tickers.map(t => [t, mockSnapshot(t).dailyBar])) };
  }
  const symbols = tickers.join(',');
  return get(`/v2/stocks/bars/latest?symbols=${symbols}`, DATA_URL);
}

async function getBars(ticker, { timeframe = '1Day', limit = 30 } = {}) {
  if (DEMO_MODE) return { bars: [] };
  return get(`/v2/stocks/${ticker}/bars?timeframe=${timeframe}&limit=${limit}`, DATA_URL);
}

async function getSnapshot(ticker) {
  if (DEMO_MODE) return mockSnapshot(ticker);
  return get(`/v2/stocks/${ticker}/snapshot`, DATA_URL);
}

async function getSnapshots(tickers) {
  if (DEMO_MODE) {
    return Object.fromEntries(tickers.map(t => [t, mockSnapshot(t)]));
  }
  const symbols = tickers.join(',');
  return get(`/v2/stocks/snapshots?symbols=${symbols}`, DATA_URL);
}

// --- News ---

async function getNews(tickers, limit = 5) {
  if (DEMO_MODE) {
    return tickers.flatMap(t => [
      { headline: `${t} Q4 earnings beat estimates on strong demand`, source: 'Reuters', created_at: new Date().toISOString() },
      { headline: `Analysts raise ${t} price target amid sector momentum`, source: 'Bloomberg', created_at: new Date().toISOString() },
    ]);
  }
  const symbols = tickers.join(',');
  const response = await get(`/v1beta1/news?symbols=${symbols}&limit=${limit}&sort=desc`, DATA_URL);
  return (response.news || []).map(a => ({
    headline: a.headline,
    summary: a.summary,
    url: a.url,
    source: a.source,
    created_at: a.created_at,
  }));
}

module.exports = {
  DEMO_MODE,
  getAccount,
  getClock,
  isMarketOpen,
  getPositions,
  getPosition,
  placeMarketOrder,
  getOpenOrders,
  cancelOrder,
  cancelAllOrders,
  getLatestQuotes,
  getLatestBars,
  getBars,
  getSnapshot,
  getSnapshots,
  getNews,
};
