// Neoliberal Struggle — Dashboard

const REFRESH_INTERVAL = 30000; // 30s
const charts = {};
const activeTab = { index: 'holdings', screener: 'holdings' };

// --- Fetch helpers ---

async function apiFetch(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  // Value
  const valEl = document.getElementById(`${id}-value`);
  if (valEl) valEl.textContent = snap ? fmt.dollar(snap.total_value) : fmt.dollar(book.capital);

  // P&L
  const pnlEl = document.getElementById(`${id}-pnl`);
  if (pnlEl && snap) {
    pnlEl.textContent = `${fmt.dollar(snap.pnl)} (${fmt.pct(snap.pnl_pct)})`;
    pnlEl.className = pnlClass(snap.pnl);
  }

  // Positions
  const posEl = document.getElementById(`${id}-positions`);
  if (posEl) posEl.textContent = book.holding_count ?? '—';

  // Woke
  const wokeEl = document.getElementById(`${id}-woke`);
  if (wokeEl) wokeEl.textContent = book.avg_woke_score_7d != null ? book.avg_woke_score_7d + '/100' : '—';

  // Pause button
  const pauseBtn = document.querySelector(`.btn-pause[data-book="${id}"]`);
  const statusBadge = document.querySelector(`#${id}-status .badge`);
  if (book.paused) {
    pauseBtn.textContent = 'Unpause';
    statusBadge.textContent = 'Paused';
    statusBadge.className = 'badge badge-paused';
  } else {
    pauseBtn.textContent = 'Pause';
    statusBadge.textContent = 'Active';
    statusBadge.className = 'badge badge-active';
  }
}

// --- Charts ---

async function refreshChart(bookId) {
  try {
    const { snapshots } = await apiFetch(`/books/${bookId}`);
    if (!snapshots.length) return;

    const labels = snapshots.map(s => new Date(s.snapped_at + 'Z').toLocaleTimeString());
    const data = snapshots.map(s => s.total_value);
    const startVal = data[0];
    const color = data[data.length - 1] >= startVal ? '#3ddc84' : '#ff5f5f';

    const ctx = document.getElementById(`${bookId}-chart`);
    if (!ctx) return;

    if (charts[bookId]) {
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

// --- Struggle Dial ---

function initDial() {
  const dial = document.getElementById('struggle-dial');
  const wokeDisplay = document.getElementById('woke-weight-display');
  const finDisplay = document.getElementById('fin-weight-display');

  apiFetch('/settings').then(settings => {
    const wokeW = Math.round(Number(settings.woke_weight || 0.4) * 100);
    dial.value = wokeW;
    wokeDisplay.textContent = wokeW + '%';
    finDisplay.textContent = (100 - wokeW) + '%';
  });

  dial.addEventListener('input', () => {
    const wokeW = Number(dial.value);
    wokeDisplay.textContent = wokeW + '%';
    finDisplay.textContent = (100 - wokeW) + '%';
  });

  document.getElementById('save-weights').addEventListener('click', async () => {
    const wokeW = Number(dial.value) / 100;
    const finW = 1 - wokeW;
    try {
      await apiPatch('/settings', { woke_weight: wokeW.toFixed(2), financial_weight: finW.toFixed(2) });
      const btn = document.getElementById('save-weights');
      btn.textContent = 'Saved!';
      setTimeout(() => { btn.textContent = 'Save'; }, 2000);
    } catch (e) {
      alert('Failed to save: ' + e.message);
    }
  });
}

// --- Pause buttons ---

function initPauseButtons() {
  document.querySelectorAll('.btn-pause').forEach(btn => {
    btn.addEventListener('click', async () => {
      const bookId = btn.dataset.book;
      const isPaused = btn.textContent === 'Pause';
      try {
        await apiPatch(`/books/${bookId}/pause`, { paused: isPaused, reason: 'Manually paused via dashboard' });
        await refreshBooks();
      } catch (e) {
        alert('Failed: ' + e.message);
      }
    });
  });
}

// --- Tabs ---

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const bookId = tab.dataset.book;
      const tabName = tab.dataset.tab;

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
    loadTab('index', activeTab.index),
    loadTab('screener', activeTab.screener),
  ]);
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  initDial();
  initPauseButtons();
  initTabs();
  initTrigger();

  refresh();
  setInterval(refresh, REFRESH_INTERVAL);
});
