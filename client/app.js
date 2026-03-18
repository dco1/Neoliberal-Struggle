// Neoliberal Struggle — Dashboard
// Each book controls its own woke/greed balance autonomously.
// The struggle dial is read-only — the books decide for themselves.
// Real-time updates are pushed over WebSocket; a slow fallback poll
// runs every 5 minutes in case the socket drops or is unavailable.

const FALLBACK_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes (safety net only)
const WS_RECONNECT_BASE_MS   = 2000;           // initial reconnect delay
const WS_RECONNECT_MAX_MS    = 30000;          // cap reconnect delay at 30s

const charts = {};
const activeTab = { index: 'holdings', screener: 'holdings' };

// Per-book sort state for the holdings table — persists across tab switches
const holdingsSort  = { index: { col: null, dir: 1 }, screener: { col: null, dir: 1 } };
// Last-fetched holdings per book — allows re-sorting without a network round-trip
const holdingsCache = { index: [], screener: [] };

// --- Fetch helpers ---

async function apiFetch(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost(path) {
  const res = await fetch(`/api${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- Formatters ---

const fmt = {
  dollar: v => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct:    v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%',
  score:  v => v == null ? '—' : Number(v).toFixed(1),
  date:   s => s ? new Date(s + 'Z').toLocaleString() : '—',
  dateShort: s => s ? new Date(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '—',
};

function pnlClass(v) {
  if (v == null) return 'neutral';
  return v >= 0 ? 'positive' : 'negative';
}

function scoreBar(score, cls) {
  const w = Math.max(0, Math.min(100, score || 0));
  return `<span class="score-bar ${cls}" style="width:${w * 0.5}px"></span>${fmt.score(score)}`;
}

// --- Status ---

async function refreshStatus() {
  try {
    const status = await apiFetch('/status');

    const el = document.getElementById('market-status');
    el.textContent = status.market_open ? 'Market Open' : 'Market Closed';
    el.className = `badge ${status.market_open ? 'badge-open' : 'badge-closed'}`;

    const banner = document.getElementById('market-closed-banner');
    banner.style.display = status.market_open ? 'none' : 'flex';

    document.getElementById('cycle-count').textContent = `Cycle: ${status.cycle_count}`;
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();

    // Expose market state so refreshSummaries can decide whether to show the regenerate button
    window._marketOpen = status.market_open;
  } catch (e) {
    console.warn('Status fetch failed:', e.message);
  }
}

// --- Books ---

async function refreshBooks() {
  try {
    const books = await apiFetch('/books');
    for (const book of books) {
      renderBookSummary(book);
    }
  } catch (e) {
    console.warn('Books fetch failed:', e.message);
  }
}

function renderBookSummary(book) {
  const id = book.id;
  const snap = book.snapshot;

  // Portfolio value
  const valEl = document.getElementById(`${id}-value`);
  if (valEl) valEl.textContent = snap ? fmt.dollar(snap.total_value) : fmt.dollar(book.capital);

  // P&L
  const pnlEl = document.getElementById(`${id}-pnl`);
  if (pnlEl && snap) {
    pnlEl.textContent = `${fmt.dollar(snap.pnl)} (${fmt.pct(snap.pnl_pct)})`;
    pnlEl.className = pnlClass(snap.pnl);
  }

  // Position count
  const posEl = document.getElementById(`${id}-positions`);
  if (posEl) posEl.textContent = book.holding_count ?? '—';

  // Average woke score (7-day)
  const wokeEl = document.getElementById(`${id}-woke`);
  if (wokeEl) wokeEl.textContent = book.avg_woke_score_7d != null ? book.avg_woke_score_7d + '/100' : '—';

  // Update subtitle weight breakdown — reflects each book's current autonomous balance.
  const wokeW   = book.woke_weight != null ? book.woke_weight : (id === 'index' ? 0.65 : 0.25);
  const wokePct = Math.round(wokeW * 100);
  const finPct  = 100 - wokePct;

  const wokeWeightEl = document.getElementById(`${id}-woke-weight`);
  const finWeightEl  = document.getElementById(`${id}-fin-weight`);
  if (wokeWeightEl) wokeWeightEl.textContent = wokePct + '%';
  if (finWeightEl)  finWeightEl.textContent  = finPct + '%';
}

// --- Charts ---

async function refreshChart(bookId) {
  try {
    const { snapshots } = await apiFetch(`/books/${bookId}`);
    if (!snapshots.length) return;

    const labels  = snapshots.map(s => new Date(s.snapped_at + 'Z').toLocaleTimeString());
    const data    = snapshots.map(s => s.total_value);
    const startVal = data[0];
    const color   = data[data.length - 1] >= startVal ? '#3ddc84' : '#ff5f5f';

    const ctx = document.getElementById(`${bookId}-chart`);
    if (!ctx) return;

    if (charts[bookId]) {
      // Update existing chart in-place to avoid flicker
      charts[bookId].data.labels = labels;
      charts[bookId].data.datasets[0].data = data;
      charts[bookId].data.datasets[0].borderColor = color;
      charts[bookId].update('none');
    } else {
      charts[bookId] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data,
            borderColor: color,
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            backgroundColor: color + '15',
            tension: 0.3,
          }],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { display: false },
            y: {
              display: true,
              grid: { color: '#2a2a32' },
              ticks: { color: '#8888a0', font: { size: 10 }, callback: v => '$' + v.toLocaleString() },
            },
          },
        },
      });
    }
  } catch (e) {
    console.warn(`Chart refresh failed for ${bookId}:`, e.message);
  }
}

// --- Tabs ---

async function loadTab(bookId, tab) {
  const content = document.getElementById(`${bookId}-tab-content`);
  content.innerHTML = '<div style="padding:16px;color:var(--text-dim)">Loading...</div>';

  try {
    if (tab === 'holdings') {
      const { holdings } = await apiFetch(`/books/${bookId}`);
      holdingsCache[bookId] = holdings || [];
      content.innerHTML = renderHoldings(holdingsCache[bookId], bookId);
    } else if (tab === 'trades') {
      const trades = await apiFetch(`/books/${bookId}/trades?limit=50`);
      content.innerHTML = renderTrades(trades);
    } else if (tab === 'log') {
      const log = await apiFetch(`/books/${bookId}/log?limit=50`);
      content.innerHTML = renderLog(log);
    }
  } catch (e) {
    content.innerHTML = `<div style="padding:16px;color:var(--red)">${e.message}</div>`;
  }
}

// Column definitions for the holdings table — key matches holding object fields
const HOLDINGS_COLS = [
  { key: 'ticker',          label: 'Ticker',    numeric: false },
  { key: 'net_shares',      label: 'Shares',    numeric: true  },
  { key: 'avg_cost',        label: 'Avg Cost',  numeric: true  },
  { key: 'woke_score',      label: 'Woke',      numeric: true  },
  { key: 'financial_score', label: 'Financial', numeric: true  },
];

function sortHoldings(holdings, col, dir) {
  if (!col) return [...holdings]; // unsorted — preserve original order
  return [...holdings].sort((a, b) => {
    const av = a[col] ?? (typeof a[col] === 'number' ? -Infinity : '');
    const bv = b[col] ?? (typeof b[col] === 'number' ? -Infinity : '');
    if (av < bv) return -dir;
    if (av > bv) return  dir;
    return 0;
  });
}

function renderHoldings(holdings, bookId) {
  if (!holdings.length) return '<div style="padding:16px;color:var(--text-dim)">No holdings yet.</div>';

  const { col, dir } = holdingsSort[bookId] || { col: null, dir: 1 };
  const sorted = sortHoldings(holdings, col, dir);

  const headerCells = HOLDINGS_COLS.map(c => {
    const active  = c.key === col;
    const arrow   = active ? (dir === 1 ? ' ↑' : ' ↓') : ' ⇅';
    const cls     = `sortable-th${active ? ' sort-active' : ''}`;
    return `<th class="${cls}" data-col="${c.key}">${c.label}<span class="sort-arrow">${arrow}</span></th>`;
  }).join('');

  const rows = sorted.map(h => `
    <tr>
      <td><strong>${h.ticker}</strong></td>
      <td>${Number(h.net_shares).toFixed(4)}</td>
      <td>${fmt.dollar(h.avg_cost)}</td>
      <td>${scoreBar(h.woke_score, 'score-woke')}</td>
      <td>${scoreBar(h.financial_score, 'score-fin')}</td>
    </tr>
  `).join('');

  return `
    <table class="holdings-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderTrades(trades) {
  if (!trades.length) return '<div style="padding:16px;color:var(--text-dim)">No trades yet.</div>';
  return `
    <table class="trades-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Side</th>
          <th>Ticker</th>
          <th>Shares</th>
          <th>Price</th>
          <th>Composite</th>
        </tr>
      </thead>
      <tbody>
        ${trades.map(t => `
          <tr>
            <td style="color:var(--text-dim);font-size:11px">${fmt.date(t.created_at)}</td>
            <td class="${t.side === 'buy' ? 'positive' : 'negative'}">${t.side.toUpperCase()}</td>
            <td><strong>${t.ticker}</strong></td>
            <td>${Number(t.shares).toFixed(4)}</td>
            <td>${fmt.dollar(t.price)}</td>
            <td>${fmt.score(t.composite_score)}</td>
          </tr>
          ${t.reasoning ? `<tr><td colspan="6" style="color:var(--text-dim);font-size:11px;padding:2px 8px 8px">${t.reasoning}</td></tr>` : ''}
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderLog(log) {
  if (!log.length) return '<div style="padding:16px;color:var(--text-dim)">No log entries yet.</div>';
  return log.map(entry => `
    <div class="log-entry">
      <span class="log-action log-${entry.action}">${entry.action.toUpperCase()}</span>
      ${entry.ticker ? `<span class="log-ticker">${entry.ticker}</span>` : ''}
      <span class="log-time">${fmt.date(entry.created_at)}</span>
      <span class="log-reason">${entry.reasoning}</span>
    </div>
  `).join('');
}

// --- Daily Summaries ---
// Fetches end-of-day summaries and renders them as a blog-style two-column feed.
// Book A reflects earnestly on its own ethics; Book B gives the numbers-first take.
// Each writes a passive-aggressive-but-kind commentary on the other.

// Convert newlines to <p> tags for readable multi-paragraph rendering
const paras = text => text
  ? text.split(/\n\n+/).map(p => `<p>${p.trim()}</p>`).join('')
  : '';

function renderSummaryDay(s) {
  return `
    <div class="summary-day">
      <div class="summary-date">${fmt.dateShort(s.date)}</div>
      <div class="summary-perf">
        <span class="summary-perf-item">Book A P&amp;L: <strong class="${s.book_a_pnl_pct >= 0 ? 'positive' : 'negative'}">${fmt.pct(s.book_a_pnl_pct)}</strong></span>
        <span class="summary-perf-sep">·</span>
        <span class="summary-perf-item">Book B P&amp;L: <strong class="${s.book_b_pnl_pct >= 0 ? 'positive' : 'negative'}">${fmt.pct(s.book_b_pnl_pct)}</strong></span>
        ${s.book_a_woke_avg != null ? `<span class="summary-perf-sep">·</span><span class="summary-perf-item">Avg Woke A: <strong>${Math.round(s.book_a_woke_avg)}</strong></span>` : ''}
        ${s.book_b_woke_avg != null ? `<span class="summary-perf-sep">·</span><span class="summary-perf-item">Avg Woke B: <strong>${Math.round(s.book_b_woke_avg)}</strong></span>` : ''}
      </div>
      <div class="summary-columns">
        <div class="summary-col summary-col-a">
          <div class="summary-col-header">
            <span class="summary-book-tag">Book A</span>
            <span class="summary-book-label">Index Universe — Ethics First</span>
          </div>
          <div class="summary-body">
            <div class="summary-self">${paras(s.book_a_summary)}</div>
            <div class="summary-commentary-header">On Book B…</div>
            <div class="summary-commentary">${paras(s.book_a_commentary_on_b)}</div>
          </div>
        </div>
        <div class="summary-col summary-col-b">
          <div class="summary-col-header">
            <span class="summary-book-tag">Book B</span>
            <span class="summary-book-label">Screener Universe — Financials First</span>
          </div>
          <div class="summary-body">
            <div class="summary-self">${paras(s.book_b_summary)}</div>
            <div class="summary-commentary-header">On Book A…</div>
            <div class="summary-commentary">${paras(s.book_b_commentary_on_a)}</div>
          </div>
        </div>
      </div>
    </div>`;
}

async function triggerRegenerate(btn) {
  btn.disabled = true;
  btn.textContent = '↺ Generating…';
  try {
    await apiPost('/admin/regenerate-summaries');
    btn.textContent = '✓ Done';
    setTimeout(() => refreshSummaries(), 1000);
  } catch (e) {
    btn.textContent = '✗ Failed';
    console.error('Regenerate failed:', e.message);
    setTimeout(() => { btn.disabled = false; btn.textContent = '↺ Generate Summaries'; }, 3000);
  }
}

async function refreshSummaries() {
  try {
    const summaries = await apiFetch('/summaries');
    const container = document.getElementById('summaries-list');

    const today = new Date().toISOString().slice(0, 10);
    const hasTodaySummary = summaries.some(s => s.date === today);
    const marketClosed = !window._marketOpen;

    if (!summaries.length || (!hasTodaySummary && marketClosed)) {
      const showBtn = marketClosed && !hasTodaySummary;
      container.innerHTML = `
        <div class="summaries-empty">
          No summaries yet for today.
          ${showBtn ? '<button id="generate-summaries-btn" class="regenerate-btn">↺ Generate Summaries</button>' : 'Check back after market close.'}
        </div>`;
      if (showBtn) {
        const genBtn = document.getElementById('generate-summaries-btn');
        genBtn.addEventListener('click', () => triggerRegenerate(genBtn));
      }
      if (summaries.length) {
        // Still render older summaries below
        container.insertAdjacentHTML('beforeend', summaries.map(renderSummaryDay).join(''));
      }
      return;
    }

    container.innerHTML = summaries.map(renderSummaryDay).join('');
  } catch (e) {
    console.warn('Summaries fetch failed:', e.message);
  }
}

// --- Tabs ---

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const bookId  = tab.dataset.book;
      const tabName = tab.dataset.tab;

      // Deactivate sibling tabs, activate this one
      document.querySelectorAll(`.tab[data-book="${bookId}"]`).forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      activeTab[bookId] = tabName;
      loadTab(bookId, tabName);
    });
  });

  // Sort click delegation — one listener per tab-content container
  ['index', 'screener'].forEach(bookId => {
    const container = document.getElementById(`${bookId}-tab-content`);
    if (!container) return;
    container.addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      const state = holdingsSort[bookId];
      if (state.col === col) {
        state.dir = -state.dir;        // toggle direction
      } else {
        state.col = col;
        state.dir = 1;                 // new column: default ascending
      }
      // Re-render in place — no network fetch needed
      container.innerHTML = renderHoldings(holdingsCache[bookId], bookId);
    });
  });
}

// --- Settings ---

// Maps setting key → { el id, serialise fn, deserialise fn }
const SETTING_FIELDS = [
  {
    key: 'news_enabled',
    id: 'setting-news-enabled',
    type: 'toggle',
    read:  el => el.checked ? 'true' : 'false',
    write: (el, v) => { el.checked = v === 'true'; },
  },
  {
    key: 'woke_floor',
    id: 'setting-woke-floor',
    type: 'number',
    read:  el => String(el.value),
    write: (el, v) => { el.value = v; },
  },
  {
    key: 'max_position_pct',
    id: 'setting-max-position-pct',
    type: 'number',
    read:  el => String(parseFloat(el.value) / 100),   // UI shows %, API stores 0.xx
    write: (el, v) => { el.value = Math.round(parseFloat(v) * 100); },
  },
  {
    key: 'max_trade_size',
    id: 'setting-max-trade-size',
    type: 'number',
    read:  el => String(el.value),
    write: (el, v) => { el.value = v; },
  },
  {
    key: 'trade_cooldown_minutes',
    id: 'setting-trade-cooldown',
    type: 'number',
    read:  el => String(el.value),
    write: (el, v) => { el.value = v; },
  },
  {
    key: 'woke_score_ttl_hours',
    id: 'setting-woke-ttl',
    type: 'number',
    read:  el => String(el.value),
    write: (el, v) => { el.value = v; },
  },
  {
    key: 'financial_score_ttl_minutes',
    id: 'setting-fin-ttl',
    type: 'number',
    read:  el => String(el.value),
    write: (el, v) => { el.value = v; },
  },
];

async function initSettings() {
  try {
    const settings = await apiFetch('/settings');
    console.log('[settings] Loaded:', settings);

    // Populate all fields from current DB values
    for (const field of SETTING_FIELDS) {
      const el = document.getElementById(field.id);
      if (!el) continue;
      if (settings[field.key] !== undefined) field.write(el, settings[field.key]);
    }

    // Save button — gather all fields and PATCH in one request
    const saveBtn    = document.getElementById('settings-save-btn');
    const saveStatus = document.getElementById('settings-save-status');

    saveBtn.addEventListener('click', async () => {
      const payload = {};
      for (const field of SETTING_FIELDS) {
        const el = document.getElementById(field.id);
        if (!el) continue;
        payload[field.key] = field.read(el);
      }

      saveBtn.disabled = true;
      saveStatus.textContent = 'Saving…';
      saveStatus.className   = 'settings-save-status';

      try {
        await fetch('/api/settings', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });
        console.log('[settings] Saved:', payload);
        saveStatus.textContent = '✓ Saved';
        saveStatus.className   = 'settings-save-status saved';
      } catch (e) {
        console.warn('[settings] Save failed:', e.message);
        saveStatus.textContent = '✗ Error saving';
        saveStatus.className   = 'settings-save-status error';
      } finally {
        saveBtn.disabled = false;
        setTimeout(() => { saveStatus.textContent = ''; }, 3000);
      }
    });

  } catch (e) {
    console.warn('[settings] Failed to load settings:', e.message);
  }
}

// --- Agent trigger ---

function initTrigger() {
  document.getElementById('trigger-cycle').addEventListener('click', async () => {
    const status = document.getElementById('trigger-status');
    status.textContent = 'Triggering...';
    try {
      await apiPost('/agent/trigger');
      status.textContent = 'Cycle triggered. Check logs.';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
    setTimeout(() => { status.textContent = ''; }, 5000);
  });
}

// --- Full refresh (initial load + fallback) ---

async function refresh() {
  await Promise.all([
    refreshStatus(),
    refreshBooks(),
    refreshChart('index'),
    refreshChart('screener'),
    refreshSummaries(),
    loadTab('index', activeTab.index),
    loadTab('screener', activeTab.screener),
  ]);
}

// --- Partial refresh triggered by cycle_complete event ---
// Skips summaries (only needed after market close) and re-uses the
// already-fetched book data to redraw charts and the active tab.

async function refreshOnCycle() {
  await Promise.all([
    refreshStatus(),
    refreshBooks(),
    refreshChart('index'),
    refreshChart('screener'),
    loadTab('index', activeTab.index),
    loadTab('screener', activeTab.screener),
  ]);
  document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
}

// --- Real-time log entry injection ---
// When a log_entry WS event arrives and the log tab is visible for that book,
// prepend the new row directly to the DOM without a full tab reload.

function injectLogEntry(entry) {
  const bookId = entry.bookId;
  if (activeTab[bookId] !== 'log') return; // tab not visible, skip

  const content = document.getElementById(`${bookId}-tab-content`);
  if (!content) return;

  // If the tab is still showing the "no entries" placeholder, replace it first
  if (content.querySelector('.log-empty') || content.textContent.trim() === 'No log entries yet.') {
    content.innerHTML = '';
  }

  const el = document.createElement('div');
  el.className = 'log-entry log-entry-new'; // CSS can fade this in
  el.innerHTML = `
    <span class="log-action log-${entry.action}">${entry.action.toUpperCase()}</span>
    ${entry.ticker ? `<span class="log-ticker">${entry.ticker}</span>` : ''}
    <span class="log-time">${new Date().toLocaleTimeString()}</span>
    <span class="log-reason">${entry.reasoning}</span>
  `;
  content.prepend(el);

  // Remove the highlight class after the CSS transition ends so it
  // doesn't keep triggering on re-renders.
  el.addEventListener('animationend', () => el.classList.remove('log-entry-new'), { once: true });
}

// --- WebSocket client ---
// Connects to the same origin as the page. Falls back gracefully if the
// socket is unavailable. Reconnects with exponential back-off on drop.

function initWebSocket() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let reconnectDelay = WS_RECONNECT_BASE_MS;
  let ws = null;
  let reconnectTimer = null;

  const wsIndicator = document.getElementById('ws-indicator');

  function setWsStatus(connected) {
    if (!wsIndicator) return;
    wsIndicator.title   = connected ? 'Live (WebSocket)' : 'Polling fallback';
    wsIndicator.dataset.connected = connected ? 'true' : 'false';
  }

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      console.log('[ws] Connected to server');
      reconnectDelay = WS_RECONNECT_BASE_MS; // reset back-off on successful connect
      setWsStatus(true);
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      const { event, data } = msg;
      console.log(`[ws] ← ${event}`, data);

      switch (event) {
        case 'connected':
          // Server hello — no action needed
          break;

        case 'cycle_complete':
          // A full agent cycle just finished — refresh all live data
          refreshOnCycle().catch(console.warn);
          break;

        case 'log_entry':
          // A new log decision was written — inject it into the visible log tab
          injectLogEntry(data);
          break;

        case 'summary':
          // New end-of-day summary written — refresh the journal section
          refreshSummaries().catch(console.warn);
          break;

        default:
          console.log(`[ws] Unhandled event: ${event}`);
      }
    });

    ws.addEventListener('close', () => {
      console.warn(`[ws] Disconnected. Reconnecting in ${reconnectDelay / 1000}s…`);
      setWsStatus(false);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
        connect();
      }, reconnectDelay);
    });

    ws.addEventListener('error', () => {
      // error event always precedes close; close handler does the reconnect
      console.warn('[ws] Connection error');
    });
  }

  connect();

  // Return a cleanup fn (useful for testing)
  return () => {
    clearTimeout(reconnectTimer);
    ws?.close();
  };
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initTrigger();
  initSettings();

  // Initial full load
  refresh();

  // WebSocket for real-time push updates
  initWebSocket();

  // Slow fallback poll — keeps data fresh if WS is unavailable or
  // if the server restarts mid-session without the client noticing.
  setInterval(refresh, FALLBACK_POLL_INTERVAL);
});
