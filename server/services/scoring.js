/**
 * Scoring service.
 * Calls Claude API to produce woke scores and financial scores per ticker.
 * Results are cached in SQLite on different TTLs:
 *   - Woke scores: 24 hours (company ethics don't change overnight)
 *   - Financial scores: 30 minutes (momentum/price does)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/index');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// --- Woke Score ---

async function getWokeScore(ticker, companyName = null, forceRefresh = false) {
  const db = getDb();
  const ttlHours = Number(getSetting('woke_score_ttl_hours') || 24);

  if (!forceRefresh) {
    const cached = db.prepare(`
      SELECT * FROM woke_scores
      WHERE ticker = ?
      AND scored_at > datetime('now', ?)
    `).get(ticker, `-${ttlHours} hours`);

    if (cached) return cached;
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

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse woke score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);

  const upsert = db.prepare(`
    INSERT INTO woke_scores (ticker, score, explanation, breakdown, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      breakdown = excluded.breakdown,
      scored_at = excluded.scored_at
  `);
  upsert.run(ticker, parsed.composite, parsed.explanation, JSON.stringify(parsed.breakdown));

  return { ticker, score: parsed.composite, explanation: parsed.explanation, breakdown: JSON.stringify(parsed.breakdown) };
}

// --- Financial Score ---

async function getFinancialScore(ticker, metrics, forceRefresh = false) {
  const db = getDb();
  const ttlMinutes = Number(getSetting('financial_score_ttl_minutes') || 30);

  if (!forceRefresh) {
    const cached = db.prepare(`
      SELECT * FROM financial_scores
      WHERE ticker = ?
      AND scored_at > datetime('now', ?)
    `).get(ticker, `-${ttlMinutes} minutes`);

    if (cached) return cached;
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

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse financial score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);

  const upsert = db.prepare(`
    INSERT INTO financial_scores (ticker, score, explanation, metrics, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      metrics = excluded.metrics,
      scored_at = excluded.scored_at
  `);
  upsert.run(ticker, parsed.score, parsed.explanation, JSON.stringify(metrics));

  return { ticker, score: parsed.score, explanation: parsed.explanation };
}

// --- Composite Score ---

function compositeScore(wokeScore, financialScore) {
  const wokeWeight = Number(getSetting('woke_weight') || 0.4);
  const financialWeight = Number(getSetting('financial_weight') || 0.6);
  return (wokeScore * wokeWeight) + (financialScore * financialWeight);
}

module.exports = { getWokeScore, getFinancialScore, compositeScore };
