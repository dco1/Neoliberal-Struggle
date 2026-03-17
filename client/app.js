// Neoliberal Struggle — Dashboard
// Each book controls its own woke/greed balance autonomously.
// The struggle dial is read-only — the books decide for themselves.

const REFRESH_INTERVAL = 30000; // 30 seconds
const charts = {};
const activeTab = { index: 'holdings', screener: 'holdings' };

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
      content.innerHTML = renderHoldings(holdings);
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

function renderHoldings(holdings) {
  if (!holdings.length) return '<div style="padding:16px;color:var(--text-dim)">No holdings yet.</div>';
  return `
    <table class="holdings-table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Shares</th>
          <th>Avg Cost</th>
          <th>Woke</th>
          <th>Financial</th>
        </tr>
      </thead>
      <tbody>
        ${holdings.map(h => `
          <tr>
            <td><strong>${h.ticker}</strong></td>
            <td>${Number(h.net_shares).toFixed(4)}</td>
            <td>${fmt.dollar(h.avg_cost)}</td>
            <td>${scoreBar(h.woke_score, 'score-woke')}</td>
            <td>${scoreBar(h.financial_score, 'score-fin')}</td>
          </tr>
        `).join('')}
      </tbody>
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

async function refreshSummaries() {
  try {
    const summaries = await apiFetch('/summaries');
    const container = document.getElementById('summaries-list');

    if (!summaries.length) {
      container.innerHTML = '<div class="summaries-empty">No summaries yet. Check back after market close.</div>';
      return;
    }

    container.innerHTML = summaries.map(s => `
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

          <!-- Book A column -->
          <div class="summary-col summary-col-a">
            <div class="summary-col-header">
              <span class="summary-book-tag">Book A</span>
              <span class="summary-book-label">Index Universe — Ethics First</span>
            </div>
            <div class="summary-body">
              <div class="summary-self">${s.book_a_summary}</div>
              <div class="summary-commentary-header">On Book B…</div>
              <div class="summary-commentary">${s.book_a_commentary_on_b}</div>
            </div>
          </div>

          <!-- Book B column -->
          <div class="summary-col summary-col-b">
            <div class="summary-col-header">
              <span class="summary-book-tag">Book B</span>
              <span class="summary-book-label">Screener Universe — Financials First</span>
            </div>
            <div class="summary-body">
              <div class="summary-self">${s.book_b_summary}</div>
              <div class="summary-commentary-header">On Book A…</div>
              <div class="summary-commentary">${s.book_b_commentary_on_a}</div>
            </div>
          </div>

        </div>
      </div>
    `).join('');
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

// --- Main refresh loop ---

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

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initTrigger();

  refresh();
  setInterval(refresh, REFRESH_INTERVAL);
});
