// Neoliberal Struggle — Public stock evaluations page
// Loads scores.json, renders a filterable/sortable table of all scored tickers.

const SCORES_URL = './scores.json';

const DIMENSIONS = [
  { key: 'environmental',      label: 'Environmental',         cls: 'dim-environmental' },
  { key: 'labor',              label: 'Labor',                 cls: 'dim-labor'         },
  { key: 'diversity_governance', label: 'Diversity & Governance', cls: 'dim-diversity'  },
  { key: 'harm_avoidance',     label: 'Harm Avoidance',        cls: 'dim-harm'          },
  { key: 'political',          label: 'Political',             cls: 'dim-political'     },
];

// ── State ─────────────────────────────────────────────────────────────────────

let allStocks  = [];   // flat array of stock objects from scores.json
let sortCol    = 'woke';
let sortDir    = -1;   // -1 = desc (high first), 1 = asc
let expandedTicker = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = {
  score: v => v == null ? '—' : Number(v).toFixed(0),
  price: v => v == null ? '—' : '$' + Number(v).toFixed(2),
  pct:   v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%',
  date:  s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
};

function scoreBar(score, cls, maxWidth = 60) {
  const w = Math.max(2, Math.min(maxWidth, (score || 0) / 100 * maxWidth));
  return `<div class="score-bar-wrap">
    <span class="score-bar ${cls}" style="width:${w}px"></span>
    <span class="score-val">${fmt.score(score)}</span>
  </div>`;
}

function scoreColor(score) {
  if (score == null) return '';
  if (score >= 70) return 'color:var(--green)';
  if (score >= 50) return 'color:var(--text)';
  return 'color:var(--red)';
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadScores() {
  const res  = await fetch(SCORES_URL);
  const data = await res.json();

  allStocks = Object.values(data.scores).map(s => ({
    ticker:       s.ticker,
    company:      s.company   || s.ticker,
    sector:       s.sector    || 'Unknown',
    woke:         s.woke?.score    ?? null,
    financial:    s.financial?.score ?? null,
    wokeData:     s.woke     || null,
    finData:      s.financial || null,
  }));

  // Populate sector filter
  const sectors = [...new Set(allStocks.map(s => s.sector).filter(Boolean))].sort();
  const sel = document.getElementById('sector-filter');
  sectors.forEach(sec => {
    const opt = document.createElement('option');
    opt.value = sec;
    opt.textContent = sec;
    sel.appendChild(opt);
  });

  // Header meta
  document.getElementById('header-meta').innerHTML =
    `${allStocks.length} stocks · exported ${fmt.date(data.exported_at)}`;

  render();
}

// ── Filtering & sorting ───────────────────────────────────────────────────────

function getFiltered() {
  const query   = document.getElementById('search').value.toLowerCase().trim();
  const sector  = document.getElementById('sector-filter').value;
  const minWoke = parseFloat(document.getElementById('min-woke').value) || 0;
  const minFin  = parseFloat(document.getElementById('min-fin').value)  || 0;

  return allStocks
    .filter(s => {
      if (query && !s.ticker.toLowerCase().includes(query) && !s.company.toLowerCase().includes(query)) return false;
      if (sector && s.sector !== sector) return false;
      if (minWoke && (s.woke ?? 0) < minWoke) return false;
      if (minFin  && (s.financial ?? 0) < minFin)  return false;
      return true;
    })
    .sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      av = av ?? -Infinity;
      bv = bv ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const stocks = getFiltered();
  document.getElementById('result-count').textContent =
    `${stocks.length} of ${allStocks.length} stocks`;

  const tbody = document.getElementById('scores-body');
  if (!stocks.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No stocks match your filters.</td></tr>';
    return;
  }

  const rows = [];
  for (const s of stocks) {
    rows.push(`
      <tr class="stock-row${expandedTicker === s.ticker ? ' expanded' : ''}" data-ticker="${s.ticker}">
        <td class="ticker-cell">${s.ticker}</td>
        <td class="company-cell" title="${s.company}">${s.company}</td>
        <td><span class="sector-badge">${s.sector}</span></td>
        <td class="score-cell">${scoreBar(s.woke, 'woke')}</td>
        <td class="score-cell">${scoreBar(s.financial, 'fin')}</td>
        <td><button class="expand-btn" data-ticker="${s.ticker}" title="Show details">${expandedTicker === s.ticker ? '▲' : '▼'}</button></td>
      </tr>
    `);
    if (expandedTicker === s.ticker) {
      rows.push(renderDetailRow(s));
    }
  }

  tbody.innerHTML = rows.join('');
  updateSortHeaders();
}

function renderDetailRow(s) {
  const w = s.wokeData;
  const f = s.finData;

  // Dimensions breakdown
  const dimRows = w?.breakdown ? DIMENSIONS.map(d => {
    const val = w.breakdown[d.key] ?? null;
    return `<li>
      <span class="dim-label">${d.label}</span>
      <span class="score-bar ${d.cls}" style="width:${Math.max(2, (val || 0) / 100 * 80)}px"></span>
      <span class="dim-score" style="${scoreColor(val)}">${fmt.score(val)}</span>
    </li>`;
  }).join('') : '<li style="color:var(--text-dim)">Breakdown not available.</li>';

  // Financial metrics
  const m = f?.metrics || {};
  const metricItems = [
    ['Price',       fmt.price(m.price)],
    ['Daily Chg',   fmt.pct(m.daily_change_pct)],
    ['Volume',      m.volume ? Number(m.volume).toLocaleString() : '—'],
    ['vs VWAP',     fmt.pct(m.price_vs_vwap_pct)],
    ['High',        fmt.price(m.high)],
    ['Low',         fmt.price(m.low)],
    ['Range',       fmt.pct(m.high_low_range_pct)],
    ['VWAP',        fmt.price(m.vwap)],
  ].map(([label, val]) => `
    <div class="metric-item">
      <div class="metric-label">${label}</div>
      <div class="metric-val">${val}</div>
    </div>
  `).join('');

  return `<tr class="detail-row" data-detail-for="${s.ticker}">
    <td colspan="6">
      <div class="detail-panel">
        <div class="detail-section">
          <h4>Ethics score — ${fmt.score(w?.score)} / 100</h4>
          <ul class="dim-list">${dimRows}</ul>
          <div class="detail-explanation">${w?.explanation || 'No explanation available.'}</div>
          <div class="detail-scored-at">Scored ${fmt.date(w?.scored_at)}</div>
        </div>
        <div class="detail-section">
          <h4>Financial score — ${fmt.score(f?.score)} / 100</h4>
          <div class="metrics-grid">${metricItems}</div>
          <div class="detail-explanation">${f?.explanation || 'No financial evaluation available.'}</div>
          <div class="detail-scored-at">Scored ${fmt.date(f?.scored_at)}</div>
        </div>
      </div>
    </td>
  </tr>`;
}

function updateSortHeaders() {
  document.querySelectorAll('#scores-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol) {
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function initEvents() {
  // Sort headers
  document.querySelectorAll('#scores-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (sortCol === th.dataset.col) {
        sortDir = -sortDir;
      } else {
        sortCol = th.dataset.col;
        sortDir = th.dataset.col === 'ticker' || th.dataset.col === 'company' || th.dataset.col === 'sector' ? 1 : -1;
      }
      render();
    });
  });

  // Search + filters
  ['search', 'sector-filter', 'min-woke', 'min-fin'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
  });

  // Row / expand button clicks
  document.getElementById('scores-body').addEventListener('click', e => {
    const btn = e.target.closest('.expand-btn');
    const row = e.target.closest('.stock-row');
    const ticker = (btn || row)?.dataset.ticker;
    if (!ticker) return;
    expandedTicker = expandedTicker === ticker ? null : ticker;
    render();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initEvents();
  try {
    await loadScores();
  } catch (e) {
    document.getElementById('scores-body').innerHTML =
      `<tr><td colspan="6" class="empty">Failed to load scores: ${e.message}</td></tr>`;
    document.getElementById('header-meta').textContent = 'Error loading data';
  }
});
