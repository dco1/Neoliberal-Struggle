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

// Deterministic mock scores so the same ticker always gets the same score in a session.
// Woke floor is 30 — anything below is blocked by both books.
// Scores reflect real-world ESG reputations: S&P ESG Index removals, labor records, business models.
const MOCK_WOKE = {
  // Solid ESG
  MSFT:  { score: 71, breakdown: { environmental: 80, labor: 68, diversity_governance: 75, harm_avoidance: 65, political: 67 }, explanation: 'Microsoft scores well on sustainability and governance, with a carbon-negative commitment. Defense cloud contracts (JEDI) and some lobbying activity temper the score.' },
  NEE:   { score: 76, breakdown: { environmental: 95, labor: 72, diversity_governance: 68, harm_avoidance: 80, political: 65 }, explanation: 'NextEra is the world\'s largest producer of wind and solar energy. Clean energy business model gives it an unusually high environmental score; governance and labor are solid for the sector.' },
  COST:  { score: 66, breakdown: { environmental: 55, labor: 82, diversity_governance: 65, harm_avoidance: 70, political: 60 }, explanation: 'Costco is consistently ranked among the best US employers — well above minimum wage, good benefits, low turnover. Supply chain and packaging issues prevent a higher score.' },
  V:     { score: 62, breakdown: { environmental: 60, labor: 65, diversity_governance: 70, harm_avoidance: 58, political: 57 }, explanation: 'Visa has relatively clean operations and decent governance. Criticism centres on enabling predatory lending and high interchange fees that disadvantage small businesses.' },
  MA:    { score: 63, breakdown: { environmental: 62, labor: 66, diversity_governance: 72, harm_avoidance: 58, political: 57 }, explanation: 'Mastercard is comparable to Visa in ESG profile — clean operations, reasonable governance, but business model questions around interchange economics and financial exclusion.' },

  // Mid-tier — decent but with real caveats
  AAPL:  { score: 60, breakdown: { environmental: 72, labor: 48, diversity_governance: 65, harm_avoidance: 68, political: 47 }, explanation: 'Apple has strong environmental commitments and renewable energy use, but faces ongoing criticism over Foxconn supply chain labor conditions, anti-right-to-repair lobbying, and aggressive tax minimization.' },
  LLY:   { score: 55, breakdown: { environmental: 62, labor: 64, diversity_governance: 65, harm_avoidance: 52, political: 32 }, explanation: 'Eli Lilly makes genuinely life-improving drugs but charges prices that put them out of reach for millions. Aggressive insulin pricing and lobbying against drug price reform are the primary drags.' },
  PG:    { score: 57, breakdown: { environmental: 58, labor: 62, diversity_governance: 65, harm_avoidance: 55, political: 45 }, explanation: 'Procter & Gamble has decent sustainability commitments and worker treatment, though palm oil sourcing, plastic packaging, and advertising practices have drawn scrutiny.' },
  GOOGL: { score: 52, breakdown: { environmental: 72, labor: 42, diversity_governance: 55, harm_avoidance: 48, political: 43 }, explanation: 'Google has significant environmental commitments but poor labor relations (union suppression, contractor treatment) and major surveillance capitalism concerns drag the score down.' },
  NVDA:  { score: 48, breakdown: { environmental: 52, labor: 60, diversity_governance: 52, harm_avoidance: 32, political: 44 }, explanation: 'Nvidia chips power both AI advancement and military applications. High energy consumption in data centers, significant defense exposure, and crypto mining enablement keep this in the middle.' },

  // Borderline — frequently near or below the floor
  JPM:   { score: 37, breakdown: { environmental: 28, labor: 55, diversity_governance: 58, harm_avoidance: 25, political: 19 }, explanation: 'JPMorgan is one of the world\'s largest fossil fuel financers, having extended hundreds of billions in credit to oil and gas since the Paris Agreement. Reasonable governance, but the fundamental business model is the problem.' },
  UNH:   { score: 33, breakdown: { environmental: 50, labor: 48, diversity_governance: 52, harm_avoidance: 18, political: 17 }, explanation: 'UnitedHealth has abnormally high claim denial rates, multiple fraud settlements, and aggressive lobbying against public healthcare. The core business model is structurally misaligned with patient wellbeing.' },
  AMZN:  { score: 32, breakdown: { environmental: 42, labor: 16, diversity_governance: 46, harm_avoidance: 40, political: 16 }, explanation: 'Amazon has among the worst warehouse injury rates of any major employer, has systematically suppressed union organizing, and fired organizers. Climate Pledge exists but lags in execution.' },
  TSLA:  { score: 24, breakdown: { environmental: 78, labor: 18, diversity_governance: 14, harm_avoidance: 28, political: 8  }, explanation: 'Tesla was removed from the S&P 500 ESG Index in 2022. Strong EV environmental case, but horrific labor practices, zero board independence, racial discrimination settlements, and the CEO\'s political activities create serious ESG liability.' },
  META:  { score: 26, breakdown: { environmental: 52, labor: 42, diversity_governance: 38, harm_avoidance: 8,  political: 30 }, explanation: 'Meta scores poorly on harm avoidance — documented negative effects on teen mental health, democracy, and information ecosystems. Dual-class governance gives Zuckerberg unilateral control. Hard to justify ethically.' },
  WMT:   { score: 31, breakdown: { environmental: 50, labor: 18, diversity_governance: 45, harm_avoidance: 38, political: 24 }, explanation: 'Walmart has a long history of wage suppression, union opposition, and community displacement of small businesses. Some sustainability progress in recent years, but labor practices remain the dominant ethical concern.' },

  // Always blocked — well below floor, fundamental business model issues
  XOM:   { score: 11, breakdown: { environmental: 4,  labor: 42, diversity_governance: 38, harm_avoidance: 8,  political: 6  }, explanation: 'Exxon Mobil is a fossil fuel company with a documented history of funding climate denial research while internally acknowledging climate change since the 1970s. Core business model is extraction of carbon.' },
  CVX:   { score: 13, breakdown: { environmental: 6,  labor: 44, diversity_governance: 40, harm_avoidance: 10, political: 7  }, explanation: 'Chevron is among the world\'s top corporate greenhouse gas emitters. Active opponent of climate regulation and litigation against it. Business model is incompatible with ethical investing.' },
  LMT:   { score: 9,  breakdown: { environmental: 30, labor: 48, diversity_governance: 44, harm_avoidance: 2,  political: 10 }, explanation: 'Lockheed Martin\'s primary business is designing and manufacturing weapons systems, including missiles, fighter jets, and nuclear warhead components. Harm avoidance score is near-zero by definition.' },
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
  // Guard undefined/null — SQLite cannot bind either value
  const safeExplanation = explanation ?? '';
  const safeBreakdown = breakdown == null ? '{}' : (typeof breakdown === 'string' ? breakdown : JSON.stringify(breakdown));
  db.prepare(`
    INSERT INTO woke_scores (ticker, score, explanation, breakdown, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      breakdown = excluded.breakdown,
      scored_at = excluded.scored_at
  `).run(ticker, score, safeExplanation, safeBreakdown);
}

function saveFinancialScore(db, ticker, score, explanation, metrics) {
  // Guard undefined/null — SQLite cannot bind either value
  const safeExplanation = explanation ?? '';
  const safeMetrics = metrics == null ? '{}' : (typeof metrics === 'string' ? metrics : JSON.stringify(metrics));
  db.prepare(`
    INSERT INTO financial_scores (ticker, score, explanation, metrics, scored_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      score = excluded.score,
      explanation = excluded.explanation,
      metrics = excluded.metrics,
      scored_at = excluded.scored_at
  `).run(ticker, score, safeExplanation, safeMetrics);
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

  // News injection — if enabled, fetch recent headlines and add context to the prompt
  let newsContext = '';
  if (getSetting('news_enabled') === 'true') {
    try {
      console.log(`[scoring] [news] fetching headlines for ${ticker}`);
      const alpaca = require('./alpaca');
      const articles = await alpaca.getNews([ticker], 5);
      if (articles.length > 0) {
        const lines = articles.map(a => `  - ${a.headline} (${a.source})`).join('\n');
        newsContext = `\nRecent news about this company (use this to adjust your score if relevant):\n${lines}\n`;
        console.log(`[scoring] [news] ${ticker} — ${articles.length} headline(s) injected into woke score prompt`);
      } else {
        console.log(`[scoring] [news] ${ticker} — no headlines found`);
      }
    } catch (e) {
      console.warn(`[scoring] [news] failed to fetch news for ${ticker}:`, e.message);
    }
  }

  const name = companyName || ticker;
  const prompt = `You are evaluating ${name} (ticker: ${ticker}) for an ethical investment scoring system.
${newsContext}
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

  console.log(`[scoring] [anthropic] woke score — ticker: ${ticker}, model: claude-sonnet-4-6`);
  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  console.log(`[scoring] [anthropic] woke score done — ticker: ${ticker}, tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);

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

  // News injection — if enabled, fetch recent headlines and add context to the prompt
  let newsContext = '';
  if (getSetting('news_enabled') === 'true') {
    try {
      console.log(`[scoring] [news] fetching headlines for ${ticker}`);
      const alpaca = require('./alpaca');
      const articles = await alpaca.getNews([ticker], 5);
      if (articles.length > 0) {
        const lines = articles.map(a => `  - ${a.headline} (${a.source})`).join('\n');
        newsContext = `\nRecent news about this company (use this to adjust your score if relevant):\n${lines}\n`;
        console.log(`[scoring] [news] ${ticker} — ${articles.length} headline(s) injected into financial score prompt`);
      } else {
        console.log(`[scoring] [news] ${ticker} — no headlines found`);
      }
    } catch (e) {
      console.warn(`[scoring] [news] failed to fetch news for ${ticker}:`, e.message);
    }
  }

  const prompt = `You are evaluating the financial attractiveness of ${ticker} for a short-to-medium term position.

Here are the current market metrics:
${JSON.stringify(metrics, null, 2)}
${newsContext}
Score this stock 0–100 on financial attractiveness, where 100 = very strong buy signal and 0 = very strong sell signal.

Consider: price momentum, volume trends, volatility, distance from recent highs/lows, and any notable patterns in the data.

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "explanation": "<2-3 sentence plain English summary of the financial case>"
}`;

  console.log(`[scoring] [anthropic] financial score — ticker: ${ticker}, model: claude-sonnet-4-6`);
  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  console.log(`[scoring] [anthropic] financial score done — ticker: ${ticker}, tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);

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
