/**
 * End-of-day export service.
 *
 * Reads all woke + financial scores from the local SQLite DB, builds a
 * scores.json snapshot, and pushes it to the GitHub repo via the GitHub
 * Contents API. No git binary needed — just an HTTPS PUT with a
 * fine-grained personal access token.
 *
 * Called once at end of day (alongside generateDailySummaries) so the
 * public GitHub Pages site always reflects today's evaluations.
 *
 * Required env vars:
 *   GITHUB_TOKEN  — fine-grained PAT with "Contents: Read and write" on this repo
 *   GITHUB_OWNER  — repo owner, e.g. "dco1"
 *   GITHUB_REPO   — repo name, e.g. "Neoliberal-Struggle"
 *
 * Optional:
 *   GITHUB_SCORES_PATH   — path in repo (default: "public/scores.json")
 *   GITHUB_SCORES_BRANCH — target branch  (default: "main")
 */

const { getDb } = require('../db/index');

const GITHUB_API  = 'https://api.github.com';
const OWNER       = process.env.GITHUB_OWNER;
const REPO        = process.env.GITHUB_REPO;
const TOKEN       = process.env.GITHUB_TOKEN;
const FILE_PATH   = process.env.GITHUB_SCORES_PATH  || 'public/scores.json';
const BRANCH      = process.env.GITHUB_SCORES_BRANCH || 'main';

const EXPORT_ENABLED = !!(TOKEN && OWNER && REPO);

// ─── Data gathering ───────────────────────────────────────────────────────────

/**
 * Pull all scored tickers from the DB and return a flat object keyed by ticker.
 * Joins with sp500_tickers for company name and sector.
 */
function buildScoresPayload() {
  const db = getDb();

  // All woke scores
  const wokeRows = db.prepare(`
    SELECT w.ticker, w.score, w.explanation, w.breakdown, w.scored_at,
           s.company, s.sector
    FROM woke_scores w
    LEFT JOIN sp500_tickers s ON s.ticker = w.ticker
    ORDER BY w.ticker ASC
  `).all();

  // All financial scores — keyed by ticker for fast lookup
  const finRows = db.prepare(`
    SELECT ticker, score, explanation, metrics, scored_at
    FROM financial_scores
  `).all();
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
      ticker:  row.ticker,
      company: row.company  || null,
      sector:  row.sector   || null,
      woke: {
        score:       row.score,
        explanation: row.explanation,
        breakdown,
        scored_at:   row.scored_at,
      },
      financial: fin ? {
        score:       fin.score,
        explanation: fin.explanation,
        metrics,
        scored_at:   fin.scored_at,
      } : null,
    };
  }

  return {
    exported_at: new Date().toISOString(),
    ticker_count: Object.keys(scores).length,
    scores,
  };
}

// ─── GitHub Contents API helpers ─────────────────────────────────────────────

/**
 * GET the current SHA of a file in the repo (needed for updates).
 * Returns null if the file doesn't exist yet (first push).
 */
async function getFileSha() {
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${FILE_PATH} failed [${res.status}]: ${await res.text()}`);
  const data = await res.json();
  return data.sha;
}

/**
 * PUT (create or update) the scores.json file in the repo.
 */
async function putFile(content, sha, message) {
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha; // required for updates; omit for create

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
  if (!res.ok) throw new Error(`GitHub PUT ${FILE_PATH} failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

// ─── Main export function ─────────────────────────────────────────────────────

/**
 * Build scores.json from the DB and push it to GitHub.
 * Called once at end of day from agent.js.
 */
async function exportScores() {
  if (!EXPORT_ENABLED) {
    console.log('[export] Skipping — GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO not set.');
    return;
  }

  console.log('[export] Building scores payload...');
  const payload = buildScoresPayload();
  const content = JSON.stringify(payload, null, 2);

  console.log(`[export] ${payload.ticker_count} tickers scored. Pushing to ${OWNER}/${REPO}:${FILE_PATH}...`);

  try {
    const sha = await getFileSha();
    const today = new Date().toISOString().slice(0, 10);
    const message = sha
      ? `chore: update scores.json — ${today} (${payload.ticker_count} tickers)`
      : `chore: create scores.json — ${today} (${payload.ticker_count} tickers)`;

    await putFile(content, sha, message);
    console.log(`[export] scores.json pushed to GitHub (${sha ? 'updated' : 'created'}).`);
  } catch (e) {
    console.error('[export] Failed to push scores.json to GitHub:', e.message);
    // Non-fatal — don't let an export failure take down the end-of-day flow
  }
}

module.exports = { exportScores };
