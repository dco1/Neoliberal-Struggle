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
  // Book A is earnest, ethical, slightly self-righteous. It writes from the perspective
  // of an ethical investor who genuinely believes in the mission.
  const bookAPrompt = `You are Book A, an ethics-first investment portfolio. Your philosophy: you only hold companies that meet high ethical standards. Financial returns matter, but never at the expense of your values.

Here is your day:
- Portfolio P&L today: ${bookAData.latestSnapshot?.pnl_pct != null ? bookAData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Your current woke weight: ${bookAData.book?.woke_weight ?? 0.65} (ethics weight in your scoring formula)
- Average woke score of today's holdings: ${bookAData.avgWokeScore != null ? bookAData.avgWokeScore.toFixed(1) : 'n/a'}
- Today's trades:
${formatTradesForPrompt(bookAData.trades)}

And here is what Book B did today (a portfolio that prioritizes financial performance first, then applies ethical filters as an afterthought):
- Book B P&L today: ${bookBData.latestSnapshot?.pnl_pct != null ? bookBData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Book B woke weight: ${bookBData.book?.woke_weight ?? 0.25} (they barely think about ethics)
- Book B's trades today:
${formatTradesForPrompt(bookBData.trades)}

Write two things:

1. SELF_SUMMARY (2–4 paragraphs): Your own voice reflection on your day. Be earnest and genuine. Talk about what you bought and why, what it means to invest with integrity, how you feel about your performance. You can acknowledge when financial performance wasn't great — you knew the costs of your convictions. Be slightly self-righteous but not insufferable.

2. COMMENTARY_ON_B (1–2 paragraphs): Comment on Book B's day. Be kind. Be generous. But land a passive-aggressive barb or two. You admire their efficiency. You understand their logic. But you feel a little sad about what they're optimizing for. Never be openly hostile — just ever so slightly wounded by their choices.

Return as JSON:
{
  "self_summary": "...",
  "commentary_on_other": "..."
}`;

  // --- Book B summary prompt ---
  // Book B is pragmatic, numbers-focused, mildly dismissive of ethics as a performance driver.
  const bookBPrompt = `You are Book B, a performance-first investment portfolio. Your philosophy: financial fundamentals lead. You apply ethical filters as a sensible risk-management tool, not as a moral statement. You respect the data.

Here is your day:
- Portfolio P&L today: ${bookBData.latestSnapshot?.pnl_pct != null ? bookBData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Your current woke weight: ${bookBData.book?.woke_weight ?? 0.25} (ethics as a factor, not a religion)
- Average woke score of today's holdings: ${bookBData.avgWokeScore != null ? bookBData.avgWokeScore.toFixed(1) : 'n/a'}
- Today's trades:
${formatTradesForPrompt(bookBData.trades)}

And here is what Book A did today (a portfolio that leads with ethics and treats financial performance as secondary):
- Book A P&L today: ${bookAData.latestSnapshot?.pnl_pct != null ? bookAData.latestSnapshot.pnl_pct.toFixed(2) + '%' : 'not yet snapshotted'}
- Book A woke weight: ${bookAData.book?.woke_weight ?? 0.65} (ethics über alles)
- Book A's trades today:
${formatTradesForPrompt(bookAData.trades)}

Write two things:

1. SELF_SUMMARY (2–4 paragraphs): Your own voice reflection on your day. Be pragmatic and data-driven. Talk about what worked, what the numbers said, why you made the moves you made. You can acknowledge when you passed on a stock for ethical reasons — it was a measured risk decision. Be vaguely dismissive of anything that can't be quantified, but not cartoonishly so.

2. COMMENTARY_ON_A (1–2 paragraphs): Comment on Book A's day. Be generous and warm — you respect their commitment. You even find it a little charming. But also gently imply that good intentions don't always compound. Land the barb softly. Never be cruel — just subtly, kindly, devastatingly practical.

Return as JSON:
{
  "self_summary": "...",
  "commentary_on_other": "..."
}`;

  // Call the API for both books in parallel
  let bookAResult, bookBResult;
  try {
    console.log('[summaries] Calling Claude API for Book A summary...');
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
    console.log('[summaries] Both API calls returned.');

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
