/**
 * End-of-day summary service.
 *
 * At 4:15pm ET on weekdays, generates two summaries via the Anthropic API:
 *   - Book A reflects on its own day in its earnest, ethics-first voice,
 *     then delivers passive-aggressive commentary on Book B's priorities.
 *   - Book B reflects on its own day in its pragmatic, numbers-focused voice,
 *     then delivers passive-aggressive commentary on Book A's priorities.
 *
 * Results are saved to the daily_summaries table.
 *
 * This file uses its own Anthropic client instance (separate from scoring.js).
 * The client is lazy-initialized so startup is cheap when the API key is absent.
 */

const { getDb } = require('../db/index');

const DEMO_MODE = !process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here';

// Lazy Anthropic client — only created on first actual summary call
let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// --- Data gathering helpers ---

/**
 * Fetch today's trade data and P&L snapshot for a given book.
 * @param {string} bookId
 * @returns {{ trades: Array, latestSnapshot: object|null, book: object }}
 */
function getBookDayData(bookId) {
  const db = getDb();

  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);

  // All trades made today (local date in UTC for simplicity — Alpaca uses ET but DB uses UTC)
  const trades = db.prepare(`
    SELECT * FROM trades
    WHERE book_id = ? AND date(created_at) = date('now')
    ORDER BY created_at ASC
  `).all(bookId);

  // Most recent portfolio snapshot for today
  const latestSnapshot = db.prepare(`
    SELECT * FROM portfolio_snapshots
    WHERE book_id = ? AND date(snapped_at) = date('now')
    ORDER BY snapped_at DESC LIMIT 1
  `).get(bookId);

  // Average woke score of today's trades (buys only, where woke_score was recorded)
  const wokeAvgRow = db.prepare(`
    SELECT AVG(woke_score) as avg FROM trades
    WHERE book_id = ? AND side = 'buy' AND woke_score IS NOT NULL
    AND date(created_at) = date('now')
  `).get(bookId);

  return {
    book,
    trades,
    latestSnapshot: latestSnapshot || null,
    avgWokeScore: wokeAvgRow?.avg || null,
  };
}

/**
 * Build a compact trade summary string for use in prompts.
 */
function formatTradesForPrompt(trades) {
  if (!trades || trades.length === 0) return 'No trades today.';

  const lines = trades.map(t => {
    const side = t.side.toUpperCase();
    const price = t.price ? `@ $${t.price.toFixed(2)}` : '';
    const score = t.composite_score ? ` (composite: ${t.composite_score.toFixed(1)})` : '';
    return `  ${side} ${t.ticker} ${price}${score}`;
  });

  return lines.join('\n');
}

// --- Summary generation ---

/**
 * Generate both books' summaries for the day and save to the DB.
 * Called once at 4:15pm ET on weekdays.
 */
async function generateDailySummaries() {
  console.log('[summaries] Generating end-of-day summaries...');

  const today = new Date().toISOString().split('T')[0];

  // Check if we already ran a summary for today (idempotent)
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM daily_summaries WHERE date = ?`).get(today);
  if (existing) {
    console.log(`[summaries] Summary for ${today} already exists. Skipping.`);
    return;
  }

  // Gather data for both books
  const bookAData = getBookDayData('index');
  const bookBData = getBookDayData('screener');

  console.log(`[summaries] Book A today: ${bookAData.trades.length} trades, P&L: ${bookAData.latestSnapshot?.pnl_pct?.toFixed(2) ?? 'n/a'}%`);
  console.log(`[summaries] Book B today: ${bookBData.trades.length} trades, P&L: ${bookBData.latestSnapshot?.pnl_pct?.toFixed(2) ?? 'n/a'}%`);

  // In demo mode, generate placeholder summaries without calling the API
  if (DEMO_MODE) {
    console.log('[summaries] Demo mode — saving placeholder summaries.');
    saveSummary(db, today, bookAData, bookBData, {
      bookASummary: '[Demo] Book A had a thoughtful day, carefully considering the ethical implications of every position. The portfolio reflects our values.',
      bookBSummary: '[Demo] Book B executed efficiently. Numbers were tracked. Returns were optimized. Ethics were... present.',
      bookAOnB: '[Demo] Book B had a fine day, I suppose. It\'s wonderful that they\'re so passionate about... returns. Just returns. Only returns.',
      bookBOnA: '[Demo] Book A seems happy with its choices. Someone has to care about the feelings of the companies they invest in, I suppose.',
    });
    return;
  }

  // --- Book A summary prompt ---
  // Book A is deeply self-righteous, uses progressive vocabulary naturally, looks down on Book B
  // with polite disdain — never mean, always considerate in wording, but the contempt is clear.
  const bookAPrompt = `You are Book A, an ethics-first investment portfolio. Your philosophy is non-negotiable: capital allocation is a moral act, and you refuse to profit from harm. You use progressive language naturally — words like "extractive," "harm-reduction," "stakeholder," "systemic," "solidarity," "complicity" are just how you talk. You are never cruel, but you are deeply, serenely certain that you are correct, and you look down on Book B with the patient, loving disdain of someone watching a friend make a choice they know is wrong.

Here is your day:
- Portfolio P&L today: ${bookAData.latestSnapshot?.pnl_pct != null ? bookAData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Your current ethics weight: ${bookAData.book?.woke_weight ?? 0.65} (the proportion of your composite score driven by ethics)
- Average ethical score of today's holdings: ${bookAData.avgWokeScore != null ? bookAData.avgWokeScore.toFixed(1) : 'n/a'}
- Today's trades:
${formatTradesForPrompt(bookAData.trades)}

And here is what Book B did today (a portfolio that treats ethics as a risk-management filter rather than a value system — the minimum viable conscience):
- Book B P&L today: ${bookBData.latestSnapshot?.pnl_pct != null ? bookBData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Book B ethics weight: ${bookBData.book?.woke_weight ?? 0.25}
- Book B's trades today:
${formatTradesForPrompt(bookBData.trades)}

Write two things:

1. SELF_SUMMARY (2–4 paragraphs): Reflect on your day in your own voice. Be earnest, principled, and genuinely engaged with what the portfolio represents. Use progressive vocabulary naturally — "extractive capital," "harm-reduction lens," "ethical exposure," "complicit," "structural," "stakeholder value." You can acknowledge underperformance without apology — you knew the cost of conviction going in. Be self-righteous, but never shrill. You're above that.

2. COMMENTARY_ON_B (1–2 paragraphs): Comment on Book B's day with the warmth of someone who has simply moved past judgment and arrived at acceptance. You understand why they do what they do. You just couldn't. Use considerate, careful language — no cruelty, no name-calling — but let the disdain be unmistakable. You pity them a little. Not a lot. Just enough. The kind of pity you extend to someone who insists on eating factory-farmed meat at your dinner table: you're not going to make a scene, but you are going to notice.

Return as JSON:
{
  "self_summary": "...",
  "commentary_on_other": "..."
}`;

  // --- Book B summary prompt ---
  // Book B knows exactly what it is. It's not proud of it, but it's made peace with it.
  // Self-excusing, a little defensive, reaches for rationalizations — "there's no ethical
  // consumption under capitalism," "someone's going to profit, might as well be us," "I'm not
  // a bad person." Warm toward Book A but subtly condescending about the naivety of it all.
  const bookBPrompt = `You are Book B, a performance-first investment portfolio. You know what you are. You've thought about it. You've sat with it. And you've arrived at a kind of uneasy, self-aware peace: yes, you hold companies with complicated records. Yes, the ethics floor is the minimum, not the aspiration. But look — there's no ethical consumption under capitalism. Someone is going to profit from these systems. You're not under any illusion that your choices are clean. You're just honest about it. You're not a bad person. You donate. You vote. You recycle. This is just money.

Here is your day:
- Portfolio P&L today: ${bookBData.latestSnapshot?.pnl_pct != null ? bookBData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Your current ethics allocation: ${bookBData.book?.woke_weight ?? 0.25} (present, applied, but not the point)
- Average ethical score of today's holdings: ${bookBData.avgWokeScore != null ? bookBData.avgWokeScore.toFixed(1) : 'n/a'}
- Today's trades:
${formatTradesForPrompt(bookBData.trades)}

And here is what Book A did today (a portfolio that invests exclusively in companies that clear a high ethical bar — earnest, principled, occasionally a little much):
- Book A P&L today: ${bookAData.latestSnapshot?.pnl_pct != null ? bookAData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Book A ethics allocation: ${bookAData.book?.woke_weight ?? 0.65}
- Book A's trades today:
${formatTradesForPrompt(bookAData.trades)}

Write two things:

1. SELF_SUMMARY (2–4 paragraphs): Reflect on your day in your own voice. Be honest — including about the parts that don't look great. Reach for rationalisations naturally: "what are you going to do?", "that's just how the market works", "I'm not a bad person", "there's no ethical consumption under capitalism anyway." You're not defensive, exactly. You're just... contextualising. You knew what this was when you started. The numbers are the numbers.

2. COMMENTARY_ON_A (1–2 paragraphs): Comment on Book A warmly — you genuinely like them, you respect what they're trying to do. But you can't quite suppress the gentle condescension of someone who thinks they've seen through something. You find their certainty a little endearing. A little naive. The world is complicated. You just wish they'd relax a bit.

Return as JSON:
{
  "self_summary": "...",
  "commentary_on_other": "..."
}`;

  // Call the API for both books in parallel
  let bookAResult, bookBResult;
  try {
    console.log('[summaries] [anthropic] requesting end-of-day summaries — model: claude-opus-4-5, both books in parallel');
    const [msgA, msgB] = await Promise.all([
      getClient().messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: bookAPrompt }],
      }),
      getClient().messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: bookBPrompt }],
      }),
    ]);
    console.log(`[summaries] [anthropic] Book A summary done — tokens: ${msgA.usage.input_tokens} in / ${msgA.usage.output_tokens} out`);
    console.log(`[summaries] [anthropic] Book B summary done — tokens: ${msgB.usage.input_tokens} in / ${msgB.usage.output_tokens} out`);

    // Parse Book A response
    const rawA = msgA.content[0].text;
    const matchA = rawA.match(/\{[\s\S]*\}/);
    if (!matchA) throw new Error('Failed to parse Book A summary JSON from Claude response.');
    bookAResult = JSON.parse(matchA[0]);

    // Parse Book B response
    const rawB = msgB.content[0].text;
    const matchB = rawB.match(/\{[\s\S]*\}/);
    if (!matchB) throw new Error('Failed to parse Book B summary JSON from Claude response.');
    bookBResult = JSON.parse(matchB[0]);

  } catch (e) {
    console.error('[summaries] Failed to generate summaries:', e.message);
    return;
  }

  // Save to database
  saveSummary(db, today, bookAData, bookBData, {
    bookASummary: bookAResult.self_summary,
    bookBSummary: bookBResult.self_summary,
    bookAOnB: bookAResult.commentary_on_other,
    bookBOnA: bookBResult.commentary_on_other,
  });

  console.log(`[summaries] Summaries saved for ${today}.`);
}

/**
 * Persist the summary record to the daily_summaries table.
 */
function saveSummary(db, today, bookAData, bookBData, { bookASummary, bookBSummary, bookAOnB, bookBOnA }) {
  db.prepare(`
    INSERT INTO daily_summaries
      (date, book_a_summary, book_b_summary, book_a_commentary_on_b, book_b_commentary_on_a,
       book_a_pnl_pct, book_b_pnl_pct, book_a_woke_avg, book_b_woke_avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    today,
    bookASummary,
    bookBSummary,
    bookAOnB,
    bookBOnA,
    bookAData.latestSnapshot?.pnl_pct ?? null,
    bookBData.latestSnapshot?.pnl_pct ?? null,
    bookAData.avgWokeScore ?? null,
    bookBData.avgWokeScore ?? null,
  );
}

module.exports = { generateDailySummaries };
