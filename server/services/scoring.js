/**
 * Scoring service.
 * Calls Claude API to produce woke scores and financial scores per ticker.
 * Falls back to deterministic mock scores when ANTHROPIC_API_KEY is not set.
 *
 * Cache TTLs:
 *   - Woke scores: 24 hours
 *   - Financial scores: 30 minutes
 *
 * compositeScore() now accepts per-book weights as arguments rather than
 * reading global settings — each book passes its own woke_weight/financial_weight.
 */

const { getDb } = require('../db/index');

const DEMO_MODE = !process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here';

// Lazy-init Anthropic client — only instantiated when a real API call is needed
let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

if (DEMO_MODE) {
  console.log('[scoring] No Anthropic key — running in demo mode with mock scores.');
}

// Deterministic mock scores so the same ticker always gets the same score in a session
const MOCK_WOKE = {
  AAPL:  { score: 62, breakdown: { environmental: 70, labor: 55, diversity_governance: 65, harm_avoidance: 72, political: 48 }, explanation: 'Apple has strong environmental commitments and renewable energy use, but faces ongoing criticism over supply chain labor conditions in Asia and aggressive tax minimization. Overall a mid-tier performer on ethics.' },
  MSFT:  { score: 71, breakdown: { environmental: 80, labor: 68, diversity_governance: 75, harm_avoidance: 65, political: 67 }, explanation: 'Microsoft scores well on sustainability and governance, with a carbon-negative commitment. Defense cloud contracts (JEDI) and some lobbying activity temper the score.' },
  GOOGL: { score: 54, breakdown: { environmental: 72, labor: 45, diversity_governance: 55, harm_avoidance: 50, political: 48 }, explanation: 'Google has significant environmental commitments but poor labor relations (union suppression, contractor treatment) and major surveillance capitalism concerns drag the score down.' },
  AMZN:  { score: 38, breakdown: { environmental: 45, labor: 20, diversity_governance: 48, harm_avoidance: 42, political: 35 }, explanation: 'Amazon has notorious warehouse labor conditions, aggressive union suppression, and is a major defense/surveillance contractor. Environmental pledges exist but execution lags.' },
  TSLA:  { score: 44, breakdown: { environmental: 85, labor: 25, diversity_governance: 30, harm_avoidance: 60, political: 20 }, explanation: 'Tesla produces EVs (strong environmental case) but has serious labor and governance concerns, a hostile union record, and an erratic executive whose political activities create real risk.' },
  META:  { score: 29, breakdown: { environmental: 50, labor: 40, diversity_governance: 45, harm_avoidance: 10, political: 30 }, explanation: 'Meta scores poorly on harm avoidance — the platform has documented negative effects on mental health, democracy, and information ecosystems. Hard to justify ethically despite improving environmental metrics.' },
  NVDA:  { score: 48, breakdown: { environmental: 55, labor: 60, diversity_governance: 52, harm_avoidance: 35, political: 38 }, explanation: 'Nvidia chips power both AI advancement and military applications. High energy consumption in data centers, significant defense exposure, but decent labor practices keep this in the middle.' },
  JPM:   { score: 41, breakdown: { environmental: 38, labor: 52, diversity_governance: 58, harm_avoidance: 28, political: 29 }, explanation: 'JPMorgan is a major fossil fuel financer and has significant regulatory/scandal history. Reasonable governance structure but fundamental business model conflicts with ethical investing.' },
  WMT:   { score: 35, breakdown: { environmental: 50, labor: 18, diversity_governance: 45, harm_avoidance: 38, political: 24 }, explanation: 'Walmart has a long history of wage suppression, union opposition, and community harm. Some sustainability progress, but labor practices remain the dominant ethical concern.' },
  PG:    { score: 58, breakdown: { environmental: 62, labor: 60, diversity_governance: 65, harm_avoidance: 55, political: 48 }, explanation: 'Procter & Gamble is a relatively ethical consumer staples company with decent sustainability commitments and worker treatment, though palm oil sourcing and advertising practices have drawn scrutiny.' },
};

function mockWokeScore(ticker) {
  const known = MOCK_WOKE[ticker];
  if (known) return known;
  // Generate a plausible score for unknown tickers based on hash of ticker name
  const seed = ticker.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const score = 30 + (seed % 50);
  return {
    score,
    breakdown: { environmental: score + 5, labor: score - 3, diversity_governance: score, harm_avoidance: score + 8, political: score - 10 },
    explanation: `Mock ethical assessment for ${ticker}. Score of ${score}/100 is a placeholder until real Claude API scoring is enabled.`,
  };
}

function mockFinancialScore(ticker, metrics) {
  const dailyChange = metrics?.daily_change_pct || 0;
  const base = 50 + (dailyChange * 5);
  const score = Math.max(10, Math.min(90, base + (Math.random() - 0.5) * 20));
  return {
    score: Math.round(score),
    explanation: `Mock financial assessment for ${ticker}. Daily change: ${dailyChange.toFixed(2)}%. Real scoring requires Anthropic API key.`,
  };
}

// --- Helpers ---

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function saveWokeScore(db, ticker, score, explanation, breakdown) {
  db.prepare(`
    INSERT INTO woke_scores (ticker, score, explanation, breakdown, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      breakdown = excluded.breakdown,
      scored_at = excluded.scored_at
  `).run(ticker, score, explanation, typeof breakdown === 'string' ? breakdown : JSON.stringify(breakdown));
}

function saveFinancialScore(db, ticker, score, explanation, metrics) {
  db.prepare(`
    INSERT INTO financial_scores (ticker, score, explanation, metrics, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      metrics = excluded.metrics,
      scored_at = excluded.scored_at
  `).run(ticker, score, explanation, typeof metrics === 'string' ? metrics : JSON.stringify(metrics));
}

// --- Woke Score ---

async function getWokeScore(ticker, companyName = null, forceRefresh = false) {
  const db = getDb();
  const ttlHours = Number(getSetting('woke_score_ttl_hours') || 24);

  if (!forceRefresh) {
    const cached = db.prepare(`
      SELECT * FROM woke_scores WHERE ticker = ? AND scored_at > datetime('now', ?)
    `).get(ticker, `-${ttlHours} hours`);
    if (cached) return cached;
  }

  if (DEMO_MODE) {
    const mock = mockWokeScore(ticker);
    saveWokeScore(db, ticker, mock.score, mock.explanation, mock.breakdown);
    return { ticker, score: mock.score, explanation: mock.explanation, breakdown: JSON.stringify(mock.breakdown) };
  }

  const name = companyName || ticker;
  const prompt = `You are evaluating ${name} (ticker: ${ticker}) for an ethical investment scoring system.

Score this company 0–100 on each of the following dimensions, where 100 is best/most ethical and 0 is worst:

1. Environmental: Carbon footprint, fossil fuel exposure, environmental record
2. Labor: Worker treatment, wages, union relations, contractor practices
3. Diversity & Governance: Board diversity, pay equity, executive compensation ratios
4. Harm avoidance: Weapons/defense exposure, prison industry, surveillance, tobacco, gambling
5. Political: Political donations, lobbying spend, regulatory capture

Return a JSON object with this exact structure:
{
  "composite": <number 0-100>,
  "breakdown": {
    "environmental": <number>,
    "labor": <number>,
    "diversity_governance": <number>,
    "harm_avoidance": <number>,
    "political": <number>
  },
  "explanation": "<2-3 sentence plain English summary of why this score was given, naming specific concerns or strengths>"
}

Be direct and specific. Do not hedge or refuse to score — give your best assessment based on what is publicly known about this company.`;

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse woke score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);
  saveWokeScore(db, ticker, parsed.composite, parsed.explanation, parsed.breakdown);
  return { ticker, score: parsed.composite, explanation: parsed.explanation, breakdown: JSON.stringify(parsed.breakdown) };
}

// --- Financial Score ---

async function getFinancialScore(ticker, metrics, forceRefresh = false) {
  const db = getDb();
  const ttlMinutes = Number(getSetting('financial_score_ttl_minutes') || 30);

  if (!forceRefresh) {
    const cached = db.prepare(`
      SELECT * FROM financial_scores WHERE ticker = ? AND scored_at > datetime('now', ?)
    `).get(ticker, `-${ttlMinutes} minutes`);
    if (cached) return cached;
  }

  if (DEMO_MODE) {
    const mock = mockFinancialScore(ticker, metrics);
    saveFinancialScore(db, ticker, mock.score, mock.explanation, metrics);
    return { ticker, score: mock.score, explanation: mock.explanation };
  }

  const prompt = `You are evaluating the financial attractiveness of ${ticker} for a short-to-medium term position.

Here are the current market metrics:
${JSON.stringify(metrics, null, 2)}

Score this stock 0–100 on financial attractiveness, where 100 = very strong buy signal and 0 = very strong sell signal.

Consider: price momentum, volume trends, volatility, distance from recent highs/lows, and any notable patterns in the data.

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "explanation": "<2-3 sentence plain English summary of the financial case>"
}`;

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse financial score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);
  saveFinancialScore(db, ticker, parsed.score, parsed.explanation, metrics);
  return { ticker, score: parsed.score, explanation: parsed.explanation };
}

// --- Composite Score ---

/**
 * Compute a weighted composite of woke and financial scores.
 * Weights are now passed explicitly by each book from its own stored values,
 * rather than being read from a global setting.
 *
 * @param {number} wokeScore      - 0–100
 * @param {number} financialScore - 0–100
 * @param {number} wokeWeight     - e.g. 0.65 for Book A, 0.25 for Book B
 * @param {number} financialWeight - e.g. 0.35 for Book A, 0.75 for Book B
 * @returns {number}
 */
function compositeScore(wokeScore, financialScore, wokeWeight, financialWeight) {
  // Validate that weights are sensible; fall back to equal weighting if missing
  const ww = typeof wokeWeight === 'number' && isFinite(wokeWeight) ? wokeWeight : 0.5;
  const fw = typeof financialWeight === 'number' && isFinite(financialWeight) ? financialWeight : 0.5;
  return (wokeScore * ww) + (financialScore * fw);
}

module.exports = { getWokeScore, getFinancialScore, compositeScore, DEMO_MODE };
