/**
 * End-of-day export service.
 *
 * Two exports run at 4:15pm ET:
 *
 *   exportScores()      — pushes docs/scores.json for the public stock-scores site
 *   exportReflections() — pushes static HTML pages under docs/reflections/
 *                         following the structure /reflections/YYYY/MM/DD/index.html
 *                         and regenerates /reflections/index.html as an index
 *
 * All pushes go through the GitHub Contents API — no git binary required.
 *
 * Required env vars:
 *   GITHUB_TOKEN  — fine-grained PAT with "Contents: Read and write" on this repo
 *   GITHUB_OWNER  — repo owner, e.g. "dco1"
 *   GITHUB_REPO   — repo name, e.g. "Neoliberal-Struggle"
 */

const { getDb } = require('../db/index');

const GITHUB_API  = 'https://api.github.com';
const OWNER       = process.env.GITHUB_OWNER;
const REPO        = process.env.GITHUB_REPO;
const TOKEN       = process.env.GITHUB_TOKEN;
const BRANCH      = process.env.GITHUB_SCORES_BRANCH || 'main';

const EXPORT_ENABLED = !!(TOKEN && OWNER && REPO);

// ─── GitHub Contents API helpers ─────────────────────────────────────────────

/**
 * GET the current SHA of any file in the repo (needed for updates).
 * Returns null if the file doesn't exist yet (first push = create).
 */
async function getFileSha(path) {
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed [${res.status}]: ${await res.text()}`);
  return (await res.json()).sha;
}

/**
 * PUT (create or update) any file in the repo.
 */
async function putFile(path, content, message) {
  const sha = await getFileSha(path);
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed [${res.status}]: ${await res.text()}`);
  return sha ? 'updated' : 'created';
}

// ─── Scores export ────────────────────────────────────────────────────────────

function buildScoresPayload() {
  const db = getDb();

  const wokeRows = db.prepare(`
    SELECT w.ticker, w.score, w.explanation, w.breakdown, w.scored_at,
           s.company, s.sector
    FROM woke_scores w
    LEFT JOIN sp500_tickers s ON s.ticker = w.ticker
    ORDER BY w.ticker ASC
  `).all();

  const finRows = db.prepare(`SELECT ticker, score, explanation, metrics, scored_at FROM financial_scores`).all();
  const finMap = new Map(finRows.map(r => [r.ticker, r]));

  const scores = {};
  for (const row of wokeRows) {
    const fin = finMap.get(row.ticker);
    let breakdown = null;
    try { breakdown = JSON.parse(row.breakdown); } catch (_) { breakdown = row.breakdown; }
    let metrics = null;
    if (fin) {
      try { metrics = JSON.parse(fin.metrics); } catch (_) { metrics = fin.metrics; }
    }
    scores[row.ticker] = {
      ticker: row.ticker, company: row.company || null, sector: row.sector || null,
      woke: { score: row.score, explanation: row.explanation, breakdown, scored_at: row.scored_at },
      financial: fin ? { score: fin.score, explanation: fin.explanation, metrics, scored_at: fin.scored_at } : null,
    };
  }

  return { exported_at: new Date().toISOString(), ticker_count: Object.keys(scores).length, scores };
}

async function exportScores() {
  if (!EXPORT_ENABLED) {
    console.log('[export] Skipping — GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO not set.');
    return;
  }

  console.log('[export] Building scores payload...');
  const payload = buildScoresPayload();
  const content = JSON.stringify(payload, null, 2);
  const path = process.env.GITHUB_SCORES_PATH || 'docs/scores.json';
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[export] ${payload.ticker_count} tickers scored. Pushing to ${OWNER}/${REPO}:${path}...`);
  try {
    const status = await putFile(path, content, `chore: update scores.json — ${today} (${payload.ticker_count} tickers)`);
    console.log(`[export] scores.json pushed to GitHub (${status}).`);
  } catch (e) {
    console.error('[export] Failed to push scores.json to GitHub:', e.message);
  }
}

// ─── Reflections export ───────────────────────────────────────────────────────

// Shared inline CSS for all reflections pages — dark aesthetic matching the dashboard.
const REFLECTIONS_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0e0e10; --surface: #1a1a1e; --surface2: #222228;
    --border: #2a2a30; --text: #e8e8ed; --text-dim: #8e8e9a;
    --accent-a: #a78bfa; --accent-b: #38bdf8;
    --positive: #34d399; --negative: #f87171;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; }
  a { color: var(--accent-a); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .site-header { padding: 20px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
  .site-header .wordmark { font-size: 17px; font-weight: 700; color: var(--text); }
  .site-header .section { font-size: 13px; color: var(--text-dim); flex: 1; }
  .site-header .rss-link { color: var(--text-dim); opacity: 0.5; transition: opacity 0.15s; display: flex; }
  .site-header .rss-link:hover { opacity: 1; color: #f26522; }

  .page { max-width: 960px; margin: 0 auto; padding: 40px 24px 80px; }

  .back-link { font-size: 12px; color: var(--text-dim); margin-bottom: 32px; display: inline-block; }
  .back-link:hover { color: var(--text); }

  /* Index */
  .index-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .index-title { font-size: 22px; font-weight: 700; margin: 0; }
  .index-rss { color: var(--text-dim); opacity: 0.45; transition: opacity 0.15s, color 0.15s; display: flex; }
  .index-rss:hover { opacity: 1; color: #f26522; }
  .index-subtitle { font-size: 13px; color: var(--text-dim); margin-bottom: 40px; }
  .index-list { list-style: none; display: flex; flex-direction: column; gap: 0; }
  .index-item { border-top: 1px solid var(--border); }
  .index-item:last-child { border-bottom: 1px solid var(--border); }
  .index-item a { display: flex; align-items: center; gap: 24px; padding: 14px 0; color: var(--text); }
  .index-item a:hover { text-decoration: none; }
  .index-item a:hover .index-date { color: var(--accent-a); }
  .index-date { font-size: 13px; font-weight: 600; min-width: 100px; color: var(--text); }
  .index-pnl { font-size: 12px; display: flex; gap: 16px; }
  .index-pnl span { color: var(--text-dim); }
  .index-pnl strong.pos { color: var(--positive); }
  .index-pnl strong.neg { color: var(--negative); }

  /* Day page */
  .day-date { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 8px; }
  .day-perf { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: var(--text-dim); margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
  .day-perf strong.pos { color: var(--positive); }
  .day-perf strong.neg { color: var(--negative); }

  .summary-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 640px) { .summary-columns { grid-template-columns: 1fr; } }

  .summary-col { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .summary-col-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .summary-book-tag { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: var(--surface2); color: var(--text); }
  .summary-col-a .summary-book-tag { color: var(--accent-a); }
  .summary-col-b .summary-book-tag { color: var(--accent-b); }
  .summary-book-label { font-size: 11px; color: var(--text-dim); }

  .summary-self { font-size: 13px; line-height: 1.75; color: var(--text); margin-bottom: 20px; }
  .summary-self p { margin: 0 0 10px; }
  .summary-self p:last-child { margin-bottom: 0; }

  .summary-commentary-header { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 10px; padding-top: 16px; border-top: 1px solid var(--border); }
  .summary-commentary { font-size: 13px; line-height: 1.75; color: var(--text-dim); font-style: italic; }
  .summary-commentary p { margin: 0 0 10px; }
  .summary-commentary p:last-child { margin-bottom: 0; }
`.trim();

/** Convert \n\n-separated text to <p> tags */
function paras(text) {
  if (!text) return '';
  return text.split(/\n\n+/).map(p => `<p>${p.trim()}</p>`).join('');
}

/** Format a date string like "2026-03-18" → "March 18, 2026" */
function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Format P&L percentage */
function fmtPct(val) {
  if (val == null) return 'n/a';
  return (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
}

/** Build the full HTML for a single day reflection page */
function buildDayPageHtml(s, depth) {
  // depth = how many levels deep (e.g. reflections/2026/03/18/ = 4 levels from docs root)
  const root = '../'.repeat(depth); // path back to docs/ root
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${fmtDate(s.date)} — Neoliberal Struggle Reflections</title>
  <style>${REFLECTIONS_CSS}</style>
</head>
<body>
  <header class="site-header">
    <a class="wordmark" href="${root}index.html">Neoliberal Struggle</a>
    <span class="section">Daily Reflections</span>
  </header>
  <main class="page">
    <a class="back-link" href="${root}reflections/index.html">← All reflections</a>
    <div class="day-date">${fmtDate(s.date)}</div>
    <div class="day-perf">
      <span>Book A P&amp;L: <strong class="${s.book_a_pnl_pct >= 0 ? 'pos' : 'neg'}">${fmtPct(s.book_a_pnl_pct)}</strong></span>
      <span>Book B P&amp;L: <strong class="${s.book_b_pnl_pct >= 0 ? 'pos' : 'neg'}">${fmtPct(s.book_b_pnl_pct)}</strong></span>
      ${s.book_a_woke_avg != null ? `<span>Avg ethics A: <strong>${Math.round(s.book_a_woke_avg)}</strong></span>` : ''}
      ${s.book_b_woke_avg != null ? `<span>Avg ethics B: <strong>${Math.round(s.book_b_woke_avg)}</strong></span>` : ''}
    </div>
    <div class="summary-columns">
      <div class="summary-col summary-col-a">
        <div class="summary-col-header">
          <span class="summary-book-tag">Book A</span>
          <span class="summary-book-label">Index Universe — Ethics First</span>
        </div>
        <div class="summary-self">${paras(s.book_a_summary)}</div>
        <div class="summary-commentary-header">On Book B…</div>
        <div class="summary-commentary">${paras(s.book_a_commentary_on_b)}</div>
      </div>
      <div class="summary-col summary-col-b">
        <div class="summary-col-header">
          <span class="summary-book-tag">Book B</span>
          <span class="summary-book-label">Screener Universe — Financials First</span>
        </div>
        <div class="summary-self">${paras(s.book_b_summary)}</div>
        <div class="summary-commentary-header">On Book A…</div>
        <div class="summary-commentary">${paras(s.book_b_commentary_on_a)}</div>
      </div>
    </div>
  </main>
</body>
</html>`;
}

/** Build an RSS 2.0 feed for all reflection days */
function buildRssFeed(summaries) {
  const BASE = 'https://dco1.github.io/Neoliberal-Struggle';
  const escXml = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const items = summaries.slice(0, 50).map(s => {
    const [y, m, d] = s.date.split('-');
    const url = `${BASE}/reflections/${y}/${m}/${d}/`;
    // RFC 822 date — treat each reflection as published at 4:15pm ET
    const pubDate = new Date(`${s.date}T21:15:00Z`).toUTCString();
    const title = fmtDate(s.date);

    const descHtml = [
      s.book_a_summary ? `<h3>Book A</h3><p>${escXml(s.book_a_summary)}</p>` : '',
      s.book_a_commentary_on_b ? `<h4>On Book B…</h4><p><em>${escXml(s.book_a_commentary_on_b)}</em></p>` : '',
      s.book_b_summary ? `<h3>Book B</h3><p>${escXml(s.book_b_summary)}</p>` : '',
      s.book_b_commentary_on_a ? `<h4>On Book A…</h4><p><em>${escXml(s.book_b_commentary_on_a)}</em></p>` : '',
    ].filter(Boolean).join('\n');

    return `
  <item>
    <title>${escXml(title)}</title>
    <link>${url}</link>
    <guid isPermaLink="true">${url}</guid>
    <pubDate>${pubDate}</pubDate>
    <description><![CDATA[${descHtml}]]></description>
  </item>`;
  }).join('');

  const lastBuild = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Neoliberal Struggle — Daily Reflections</title>
    <link>${BASE}/reflections/</link>
    <description>Daily end-of-day reflections from two autonomous AI investment portfolios — one ethics-first, one performance-first — each commenting on the other's choices.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${BASE}/reflections/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/** Build the index page listing all reflection days */
function buildIndexPageHtml(summaries) {
  const items = summaries.map(s => {
    const [y, m, d] = s.date.split('-');
    return `
    <li class="index-item">
      <a href="${y}/${m}/${d}/index.html">
        <span class="index-date">${fmtDate(s.date)}</span>
        <span class="index-pnl">
          <span>Book A: <strong class="${s.book_a_pnl_pct >= 0 ? 'pos' : 'neg'}">${fmtPct(s.book_a_pnl_pct)}</strong></span>
          <span>Book B: <strong class="${s.book_b_pnl_pct >= 0 ? 'pos' : 'neg'}">${fmtPct(s.book_b_pnl_pct)}</strong></span>
        </span>
      </a>
    </li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reflections — Neoliberal Struggle</title>
  <link rel="alternate" type="application/rss+xml" title="Neoliberal Struggle — Daily Reflections" href="feed.xml">
  <style>${REFLECTIONS_CSS}</style>
</head>
<body>
  <header class="site-header">
    <a class="wordmark" href="../index.html">Neoliberal Struggle</a>
    <span class="section">Daily Reflections</span>
    <a class="rss-link" href="feed.xml" title="RSS feed">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="6.18" cy="17.82" r="2.18"/><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/></svg>
    </a>
  </header>
  <main class="page">
    <div class="index-title-row">
      <h1 class="index-title">Daily Reflections</h1>
      <a class="index-rss" href="feed.xml" title="RSS feed">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="6.18" cy="17.82" r="2.18"/><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/></svg>
      </a>
    </div>
    <p class="index-subtitle">Each trading day, Book A and Book B write about their day — and about each other.</p>
    <ul class="index-list">${items}</ul>
  </main>
</body>
</html>`;
}

/**
 * Export all daily summaries as static HTML pages to docs/reflections/.
 * Pushes today's new day page + regenerates the index.
 */
async function exportReflections() {
  if (!EXPORT_ENABLED) return;

  const db = getDb();
  const summaries = db.prepare(`
    SELECT * FROM daily_summaries ORDER BY date DESC
  `).all();

  if (!summaries.length) {
    console.log('[export] No summaries to export.');
    return;
  }

  console.log(`[export] Exporting ${summaries.length} reflection(s) to GitHub Pages...`);

  const today = new Date().toISOString().slice(0, 10);
  let pushed = 0;

  // Push today's day page (always regenerate in case of reruns)
  const todaySummary = summaries.find(s => s.date === today);
  if (todaySummary) {
    const [y, m, d] = today.split('-');
    const path = `docs/reflections/${y}/${m}/${d}/index.html`;
    const html = buildDayPageHtml(todaySummary, 4); // 4 levels deep from docs/
    try {
      const status = await putFile(path, html, `chore: reflection ${today}`);
      console.log(`[export] reflections/${y}/${m}/${d}/ ${status}.`);
      pushed++;
    } catch (e) {
      console.error(`[export] Failed to push reflection ${today}:`, e.message);
    }
  }

  // Always regenerate the index page
  const indexHtml = buildIndexPageHtml(summaries);
  try {
    const status = await putFile('docs/reflections/index.html', indexHtml, `chore: reflections index — ${today}`);
    console.log(`[export] reflections/index.html ${status}.`);
    pushed++;
  } catch (e) {
    console.error('[export] Failed to push reflections index:', e.message);
  }

  // Regenerate the RSS feed
  const feedXml = buildRssFeed(summaries);
  try {
    const status = await putFile('docs/reflections/feed.xml', feedXml, `chore: reflections feed — ${today}`);
    console.log(`[export] reflections/feed.xml ${status}.`);
    pushed++;
  } catch (e) {
    console.error('[export] Failed to push reflections feed.xml:', e.message);
  }

  // Push a lightweight data.json so the main scores page can list recent reflections
  const dataJson = JSON.stringify(summaries.map(s => ({
    date: s.date,
    book_a_pnl_pct: s.book_a_pnl_pct,
    book_b_pnl_pct: s.book_b_pnl_pct,
  })), null, 2);
  try {
    const status = await putFile('docs/reflections/data.json', dataJson, `chore: reflections data — ${today}`);
    console.log(`[export] reflections/data.json ${status}.`);
    pushed++;
  } catch (e) {
    console.error('[export] Failed to push reflections data.json:', e.message);
  }

  console.log(`[export] Reflections export done (${pushed} file(s) pushed).`);
}

module.exports = { exportScores, exportReflections };
