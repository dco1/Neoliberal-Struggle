/**
 * Alpaca paper trading client.
 * Wraps the REST API for account info, market data, and order management.
 */

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';

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
  return get('/v2/account');
}

// --- Market Clock ---

async function getClock() {
  return get('/v2/clock');
}

async function isMarketOpen() {
  const clock = await getClock();
  return clock.is_open;
}

// --- Positions ---

async function getPositions() {
  return get('/v2/positions');
}

async function getPosition(ticker) {
  try {
    return await get(`/v2/positions/${ticker}`);
  } catch (e) {
    if (e.message.includes('404')) return null;
    throw e;
  }
}

// --- Orders ---

async function placeMarketOrder({ ticker, side, notional = null, qty = null }) {
  const body = {
    symbol: ticker,
    side,
    type: 'market',
    time_in_force: 'day',
  };
  if (notional !== null) {
    body.notional = notional.toFixed(2);  // dollar amount
  } else if (qty !== null) {
    body.qty = qty;
  } else {
    throw new Error('placeMarketOrder requires either notional or qty');
  }
  return post('/v2/orders', body);
}

async function getOpenOrders() {
  return get('/v2/orders?status=open');
}

async function cancelOrder(orderId) {
  return del(`/v2/orders/${orderId}`);
}

async function cancelAllOrders() {
  return del('/v2/orders');
}

// --- Market Data ---

async function getLatestQuotes(tickers) {
  const symbols = tickers.join(',');
  return get(`/v2/stocks/quotes/latest?symbols=${symbols}`, DATA_URL);
}

async function getLatestBars(tickers) {
  const symbols = tickers.join(',');
  return get(`/v2/stocks/bars/latest?symbols=${symbols}`, DATA_URL);
}

async function getBars(ticker, { timeframe = '1Day', limit = 30 } = {}) {
  return get(
    `/v2/stocks/${ticker}/bars?timeframe=${timeframe}&limit=${limit}`,
    DATA_URL
  );
}

async function getSnapshot(ticker) {
  return get(`/v2/stocks/${ticker}/snapshot`, DATA_URL);
}

async function getSnapshots(tickers) {
  const symbols = tickers.join(',');
  return get(`/v2/stocks/snapshots?symbols=${symbols}`, DATA_URL);
}

module.exports = {
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
};
