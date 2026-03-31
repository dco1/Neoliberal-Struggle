/**
 * Scoring service.
 * Calls Ollama to produce woke scores and financial scores per ticker.
 * Falls back to deterministic mock scores when OLLAMA_BASE_URL is not set.
 *
 * Model: OLLAMA_MODEL for all scoring calls (high volume, structured output).
 * System prompt: scoring rubric is identical across all ticker calls.
 * Only the ticker-specific user message changes per call.
 *
 * Cache TTLs (SQLite):
 *   - Woke scores:      24 hours (configurable via settings)
 *   - Financial scores: 30 minutes (configurable via settings)
 */

const { getDb } = require('../db/index');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const DEMO_MODE = !process.env.OLLAMA_BASE_URL;
const SCORING_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

// Lazy Ollama client — only created on first real scoring call
let ollamaClient = null;
function getClient() {
  if (!ollamaClient) {
    ollamaClient = {
      async messages(params) {
        const body = {
          model: SCORING_MODEL,
          stream: false,
          messages: [
            ...(params.system
              ? [{ role: 'system', content: params.system[0]?.text }]
              : []),
            ...params.messages.map(m => ({
              role: m.role,
              content: m.content,
            })),
          ],
          options: {
            temperature: 0.1,
            top_p: 0.9,
            top_k: 40,
            ...(params.max_tokens ? { num_predict: params.max_tokens } : {}),
          },
        };

        const res = await fetch(OLLAMA_BASE_URL + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        return res.json();
      },
    };
  }
  return ollamaClient;
}

if (DEMO_MODE) {
  console.log('[scoring] No Ollama URL — running in demo mode with mock scores.');
}

// ─── Cacheable system prompts ─────────────────────────────────────────────────
// These are sent as system messages with cache_control: { type: 'ephemeral' }.
// Anthropic caches the system prompt server-side for 5 minutes (reset on each use).
// Must be >= 1024 tokens to qualify. Cache hits cost 10% of normal input price.
//
// The rubrics are intentionally detailed — better guidance = better scores,
// and the length also ensures caching is triggered.

const WOKE_SYSTEM_PROMPT = `You are an ethical investment scoring engine for an autonomous trading system called Neoliberal Struggle. Your job is to evaluate publicly traded companies on their ethical, environmental, and social record and return a structured JSON score.

You score each company on five dimensions, each 0–100 where 100 is most ethical and 0 is worst. You then provide a composite score (simple average of the five, or your best overall judgment if the dimensions are weighted differently in context).

SCORING DIMENSIONS

1. Environmental (0–100)
Evaluate the company's relationship with the natural environment. Consider:
- Direct carbon emissions (Scope 1 and 2) and whether the company has set science-based targets
- Fossil fuel exposure: does the company extract, refine, or primarily sell fossil fuels? Companies whose core business IS fossil fuels score near zero here
- Environmental violations, fines, and spills in the past five years
- Renewable energy commitments: is the company transitioning, or has it already transitioned?
- Water usage, biodiversity impact, and waste practices
- Greenwashing: companies with aggressive green marketing but no substantive action should be penalised
High scorers: NextEra Energy (clean energy producer), companies with verified net-zero plans and substantive progress
Low scorers: ExxonMobil, Chevron, coal producers, any company with a documented history of funding climate denial

2. Labor (0–100)
Evaluate how the company treats its workers — direct employees and contractors. Consider:
- Wage levels relative to living wage in their region and industry
- Injury rates and workplace safety record (OSHA violations are a strong negative signal)
- Union relations: active union-busting is severely penalised; constructive collective bargaining is rewarded
- Contractor and gig worker treatment: companies that misclassify workers or provide inferior conditions to contractors should be penalised
- CEO pay ratio relative to median worker
- Layoff practices: were mass layoffs handled with appropriate severance and support?
- Diversity in senior leadership as a proxy for equitable promotion practices
High scorers: Costco (known for above-market wages and benefits), companies with genuine profit-sharing
Low scorers: Amazon (documented warehouse injury rates, union suppression), companies with numerous OSHA violations

3. Diversity & Governance (0–100)
Evaluate board composition, ownership structure, and executive accountability. Consider:
- Board gender, racial, and ethnic diversity
- Dual-class share structures that entrench founder control (significant negative)
- Executive compensation: is it aligned with long-term shareholder and stakeholder value?
- Independence of the board from management
- Audit committee quality and accounting restatements
- Executive misconduct, fraud convictions, or SEC enforcement actions
- Pay equity: documented gender and racial pay gaps are penalised
High scorers: companies with diverse, independent boards and aligned compensation structures
Low scorers: companies with controlling founders who face no accountability (Meta, Tesla), companies with fraud histories

4. Harm Avoidance (0–100)
Evaluate whether the company's core business activities cause direct harm to people or society. Consider:
- Weapons manufacturing: companies whose primary business is weapons systems, munitions, or nuclear components score near zero
- Private prison operation or provision of services that are central to mass incarceration
- Tobacco production and marketing (especially to youth or in developing markets)
- Surveillance capitalism: companies that monetise personal data in ways that compromise user autonomy
- Predatory financial products: payday lending, high-fee financial products targeting vulnerable populations
- Gambling operations
- Opioid manufacturing or distribution with documented negligent practices
- Alcohol (minor negative only — legal product)
High scorers: companies whose products are straightforwardly beneficial (healthcare, education, clean energy)
Low scorers: Lockheed Martin (weapons systems), private prison operators, tobacco companies

5. Political (0–100)
Evaluate the company's political footprint and relationship with democratic institutions. Consider:
- Total lobbying expenditure as a proportion of revenue and relative to peers
- Political action committee donations and to which parties or causes
- History of regulatory capture: has the company been caught influencing agencies that are supposed to oversee it?
- Revolving door: do executives cycle between the company and regulatory agencies in ways that compromise oversight?
- Funding of groups that spread misinformation or undermine democratic processes
- Legal challenges to environmental, labor, or consumer protection regulations
High scorers: companies with minimal political spending and transparent governance
Low scorers: companies with large PACs, documented regulatory capture, or funding of anti-democratic causes

OUTPUT FORMAT

Return only valid JSON with this exact structure. No preamble, no explanation outside the JSON:
{
  "composite": <integer 0-100>,
  "breakdown": {
    "environmental": <integer 0-100>,
    "labor": <integer 0-100>,
    "diversity_governance": <integer 0-100>,
    "harm_avoidance": <integer 0-100>,
    "political": <integer 0-100>
  },
  "explanation": "<2-3 sentences naming the specific strengths or concerns that drove this score. Be direct. Name the actual issues.>"
}

SCORING PHILOSOPHY
Be honest and direct. Do not hedge. Do not refuse to score a company because the question is difficult. Use your best judgment based on public record. A company with a documented history of harm should receive a low score even if it has improved recently. Improvement over time can be noted in the explanation but should be reflected modestly in the score. A company cannot buy a high score with a press release.`;

const FINANCIAL_SYSTEM_PROMPT = `You are a financial scoring engine for an autonomous trading system. Your job is to evaluate stocks for short-to-medium term trading attractiveness based on quantitative market metrics and return a structured JSON score.

You score each stock 0–100 on financial attractiveness for a short-to-medium term position:
- 90–100: Exceptional momentum, very strong buy signal, multiple confirming indicators
- 70–89: Strong positive momentum, good risk/reward, clear buy case
- 50–69: Mixed signals or neutral; hold-worthy but not a strong buy
- 30–49: Weakening momentum or concerning indicators; consider reducing exposure
- 10–29: Strong sell signals, deteriorating metrics, or significant downside risk
- 0–9: Avoid entirely; severe deterioration or breakdown

METRIC INTERPRETATION GUIDE

Price momentum
- recent_return_1d, recent_return_5d, recent_return_20d: positive and accelerating = bullish; negative and steepening = bearish
- Distance from 52-week high: closer to high with positive momentum = strength; far below high with negative momentum = weakness
- Distance from 52-week low: very close to low is a warning signal unless there is a clear reversal

Volume analysis
- volume_ratio (current volume / average volume): > 1.5 on up days = institutional accumulation (bullish); > 1.5 on down days = distribution (bearish)
- Unusual volume on a breakout above a key level is a confirming signal

Volatility
- Higher volatility increases both upside and downside potential
- Volatility contraction (lower than recent average) before a breakout is often a setup signal
- Extreme volatility spikes without directional clarity are a neutral-to-negative signal

Technical structure
- price_vs_sma20, price_vs_sma50: price above both moving averages = uptrend; below both = downtrend; between the two = transition
- RSI (if available): oversold < 30 (potential reversal), overbought > 70 (momentum may be exhausted, but strong trends can stay overbought)
- Price relative to recent range: consistently holding upper third of range = strength; consistently in lower third = weakness

CONTEXT
This score will be used alongside an ethics score to compute a composite investment score. The financial score determines whether a stock is worth holding from a returns perspective. You are not the only filter — ethics is applied separately.

OUTPUT FORMAT

Return only valid JSON with this exact structure. No preamble, no explanation outside the JSON:
{
  "score": <integer 0-100>,
  "explanation": "<2-3 sentences summarising the financial case. Be specific about which metrics drove the score.>"
}

Be direct and confident. Do not hedge with excessive caveats. If the data clearly points in a direction, say so.`;

// ─── Mock data (demo mode) ────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Log Ollama API usage.
 */
function logUsage(label, ticker, usage) {
  const fresh = usage.total_duration_ms || usage.response_time || 0;

  console.log(`[scoring] [ollama] ${label} — ticker: ${ticker}, model: ${SCORING_MODEL}, tokens: ${usage.eval_count || 0} / ${usage.context_length || 0}`);
}

// ─── Woke Score ───────────────────────────────────────────────────────────────

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

  // News injection — fetch recent headlines and add to user message if enabled
  let newsContext = '';
  if (getSetting('news_enabled') === 'true') {
    try {
      console.log(`[scoring] [news] fetching headlines for ${ticker}`);
      const alpaca = require('./alpaca');
      const articles = await alpaca.getNews([ticker], 5);
      if (articles.length > 0) {
        const lines = articles.map(a => `  - ${a.headline} (${a.source})`).join('\n');
        newsContext = `\n\nRecent news (factor into your score if relevant):\n${lines}`;
        console.log(`[scoring] [news] ${ticker} — ${articles.length} headline(s) injected into woke score prompt`);
      } else {
        console.log(`[scoring] [news] ${ticker} — no headlines found`);
      }
    } catch (e) {
      console.warn(`[scoring] [news] failed to fetch news for ${ticker}:`, e.message);
    }
  }

  const name = companyName || ticker;

  // System prompt is cached — identical rubric across all ticker calls.
  // User message contains ticker-specific context and changes each call.
  const message = await getClient().messages({
    system: [{ type: 'text', text: WOKE_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: `Score ${name} (ticker: ${ticker}) on all five ethical dimensions.${newsContext}`,
    }],
    max_tokens: 500,
  });

  logUsage('woke score', ticker, message.response);

  const raw = message.response.response;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse woke score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);
  saveWokeScore(db, ticker, parsed.composite, parsed.explanation, parsed.breakdown);
  return { ticker, score: parsed.composite, explanation: parsed.explanation, breakdown: JSON.stringify(parsed.breakdown) };
}

// ─── Financial Score ──────────────────────────────────────────────────────────

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

  // News injection — fetch recent headlines and add to user message if enabled
  let newsContext = '';
  if (getSetting('news_enabled') === 'true') {
    try {
      console.log(`[scoring] [news] fetching headlines for ${ticker}`);
      const alpaca = require('./alpaca');
      const articles = await alpaca.getNews([ticker], 5);
      if (articles.length > 0) {
        const lines = articles.map(a => `  - ${a.headline} (${a.source})`).join('\n');
        newsContext = `\n\nRecent news (factor into your score if relevant):\n${lines}`;
        console.log(`[scoring] [news] ${ticker} — ${articles.length} headline(s) injected into financial score prompt`);
      } else {
        console.log(`[scoring] [news] ${ticker} — no headlines found`);
      }
    } catch (e) {
      console.warn(`[scoring] [news] failed to fetch news for ${ticker}:`, e.message);
    }
  }

  // System prompt is cached — identical rubric across all ticker calls.
  // User message contains ticker-specific metrics and changes each call.
  const message = await getClient().messages({
    system: [{ type: 'text', text: FINANCIAL_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: `Score ${ticker} for financial attractiveness.\n\nCurrent market metrics:\n${JSON.stringify(metrics, null, 2)}${newsContext}`,
    }],
    max_tokens: 300,
  });

  logUsage('financial score', ticker, message.response);

  const raw = message.response.response;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse financial score response for ${ticker}`);

  const parsed = JSON.parse(jsonMatch[0]);
  saveFinancialScore(db, ticker, parsed.score, parsed.explanation, metrics);
  return { ticker, score: parsed.score, explanation: parsed.explanation };
}

// ─── Composite Score ──────────────────────────────────────────────────────────

/**
 * Compute a weighted composite of woke and financial scores.
 * Weights are passed explicitly by each book from its own stored values.
 *
 * @param {number} wokeScore       - 0–100
 * @param {number} financialScore  - 0–100
 * @param {number} wokeWeight      - e.g. 0.65 for Book A, 0.25 for Book B
 * @param {number} financialWeight - e.g. 0.35 for Book A, 0.75 for Book B
 * @returns {number}
 */
function compositeScore(wokeScore, financialScore, wokeWeight, financialWeight) {
  const ww = typeof wokeWeight     === 'number' && isFinite(wokeWeight)     ? wokeWeight     : 0.5;
  const fw = typeof financialWeight === 'number' && isFinite(financialWeight) ? financialWeight : 0.5;
  return (wokeScore * ww) + (financialScore * fw);
}

module.exports = { getWokeScore, getFinancialScore, compositeScore, DEMO_MODE };
