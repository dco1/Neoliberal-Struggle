# Neoliberal Struggle

> *The tension between doing good and making money, automated and running 24/7.*

An autonomous dual-portfolio trading agent that wrestles with the central contradiction of ethical investing: you can't fully optimise for both returns and ethics at the same time. Each book knows this. Each book handles it differently.

---

## What it does

Two AI-driven investment books run in parallel against a shared [Alpaca](https://alpaca.markets) paper trading account, using real market data and fake money.

**Book A — Index Universe (Ethics First)**
Scores every S&P 500 constituent on a woke/ethics rubric and holds the best composite performers. Starts with a 65% ethics / 35% financial weighting. When it's winning, it takes that as vindication and doubles down on ethics. When it's losing, it double downs on ethics again, because it believes the market will eventually reward virtue. It is sometimes wrong.

**Book B — Screener Universe (Financials First)**
Filters by financial momentum first, then applies an ethics check as a risk filter. Starts at 25% ethics / 75% financial. Gets greedier when it's winning. Uses ethics tactically, not principally. It knows what it's doing.

Both books **autonomously adjust their own woke/greed balance** each cycle based on recent P&L trend. Neither book can fully abandon its nature: Book A's ethics weight is bounded between 0.55 and 0.80, Book B's between 0.15 and 0.45.

At **4:15pm ET on weekdays**, each book writes a journal entry about its day — and a kind, passive-aggressive commentary about the other book's choices. Book A is self-righteous. Book B is self-excusing.

---

## Architecture

```
Neoliberal Struggle
├── server/
│   ├── index.js              Express + WebSocket server entry point
│   ├── agent.js              Orchestrator: cron, market check, WS broadcasts, end-of-day
│   ├── books/
│   │   ├── index-universe.js Book A strategy loop
│   │   ├── screener-universe.js Book B strategy loop
│   │   └── shared.js         Portfolio valuation, snapshots, weight adjustment
│   ├── services/
│   │   ├── alpaca.js         Alpaca REST API client (paper trading + news)
│   │   ├── scoring.js        Claude API — woke + financial scoring with SQLite cache
│   │   ├── summaries.js      Claude API — end-of-day journal entries
│   │   ├── market.js         S&P 500 universe, market data, screening, seeding
│   │   ├── guardrails.js     Position size limits, woke floor enforcement
│   │   └── ws.js             WebSocket server — real-time push to dashboard
│   ├── db/
│   │   ├── index.js          SQLite connection (node:sqlite built-in)
│   │   └── schema.js         Schema init, migrations, seeds
│   ├── routes/
│   │   └── api.js            REST API for the dashboard
│   └── tests/
│       └── rotation.test.js  Unit tests for portfolio rotation logic
├── client/
│   ├── index.html            Dashboard
│   ├── app.js                Dashboard JS (WebSocket client)
│   ├── style.css             Styles (native nested CSS)
│   └── demo.html             After-hours simulation page
└── db/
    └── neoliberal.db         SQLite database (gitignored)
```

**Stack:** Node.js · Express · WebSockets (`ws`) · node:sqlite · node-cron · Alpaca API · Anthropic Claude API · Chart.js · pm2

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/dco1/Neoliberal-Struggle.git
cd Neoliberal-Struggle
npm install
```

### 2. Create a `.env` file

```env
ALPACA_API_KEY=your_paper_api_key
ALPACA_SECRET_KEY=your_paper_secret_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

- **Alpaca paper trading keys** — sign up at [alpaca.markets](https://alpaca.markets), switch to paper trading, generate keys
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)

> Without keys the server runs in demo mode with mock scores and simulated data.

### 3. Run

```bash
# Development
npm run dev

# Production (pm2)
npm run pm2:start
```

Dashboard at **http://localhost:3000** · Demo page at **http://localhost:3000/demo**

---

## How the agent works

The agent runs on a `*/15 * * * *` cron. At the start of each cycle it checks whether the market is open via the Alpaca `/v2/clock` endpoint — if closed, the cycle is skipped entirely. There are no hardcoded market hours.

**Each cycle (per book):**
1. Fetch real account cash + live position values from Alpaca
2. Re-score current holdings (woke + financial in parallel)
3. Sell anything below the composite threshold or woke floor
4. **Rotation pass** — if cash is exhausted, check if any zombie holding can be swapped for something materially better (see below)
5. Scan the S&P 500 universe for new candidates
6. Score candidates via Claude API (cached)
7. Buy the best composite scorers while cash is available
8. Adjust woke/financial weights based on recent P&L trend

**End of day (4:15pm ET):**
Claude generates a reflective journal entry for each book — its own day in its own voice, and a commentary on the other book's choices.

**WebSocket push:**
After each cycle completes, the server broadcasts a `cycle_complete` event over WebSocket. The dashboard updates books, charts, logs, and status in real time without polling. Individual log entries are also pushed live as they are written, so you can watch decisions happen as they occur.

---

## Portfolio rotation

**The problem.** A book can run out of cash while still holding positions that aren't good enough to buy fresh — scores above the sell floor but below the buy threshold. The book has nothing to do each cycle: it can't sell (scores are acceptable) and can't buy (no cash). These are called **zombie holdings**.

**The zombie zone.** Each book has a sell threshold (the floor below which a position is automatically liquidated) and a buy threshold (the minimum score required to open a new position). The gap between them is intentional — it prevents constant buying and selling on marginal differences. But it also means a holding can get stuck in the middle indefinitely.

```
0 ─────────── [SELL FLOOR] ─────── [zombie zone] ─────── [BUY THRESHOLD] ──── 100
                   45                  45–60                     60
```

**The rotation fix.** Once per cycle, when cash is below $10 and zombie holdings exist, each book:
1. Identifies the worst-scoring zombie (lowest composite below the buy threshold)
2. Scores 20 fresh candidates from the S&P 500 universe
3. If the best candidate scores **5+ points higher** than the zombie *and* clears all filters (woke floor, buy threshold), the zombie is sold and the cash is freed for the buy pass
4. If no candidate clears the bar, the book logs "no materially better candidates" and holds — no pointless churn

One rotation per cycle. This prevents the agent from liquidating the entire portfolio in a single pass when the market moves.

**Why rotation may not fire.** The rotation check uses `composite < BUY_COMPOSITE_THRESHOLD`. A holding scoring *exactly* 60.0 is not a zombie (`<` not `<=`). Additionally, if a book's `woke_weight` has drifted to its maximum cap (Book A can reach 0.80), the high ethics weighting collapses composite scores into a narrow band — everything clusters around the average woke score (~62), making it very hard for any holding to fall genuinely below 60 and very hard for any candidate to be 5 points better than anything else. This is an observed production behaviour.

---

## How P&L is calculated

Both books share a single Alpaca paper-trading account. Alpaca has no concept of sub-accounts, so all book-level bookkeeping is internal.

**Invested value (per book)**
Each book's invested value is computed from its own trade history rather than directly from Alpaca's `market_value`. For each ticker where the book has a net-positive position (buys minus sells from the `trades` table), we multiply the book's net share count by the current price from Alpaca:

```
invested_value = Σ (net_shares × current_price)  for each ticker this book holds
```

This prevents double-counting when both books happen to hold the same ticker — each book only counts its own shares, not the full Alpaca position.

> **Why this matters.** Before this fix, both books filtered Alpaca's positions by tickers in their trade history and claimed the full Alpaca `market_value` for any match. Since both books sometimes buy the same stock, the same Alpaca position was claimed by both books simultaneously. The combined "invested value" of both books exceeded the real account total by thousands of dollars.

**Cash split**
At each cycle, the real Alpaca cash balance is divided proportionally between the two books based on each book's remaining undeployed capital, derived from trade history:

```
book_remaining = book.capital − net_spend_from_trades
book_cash      = alpaca_cash × (book_remaining / total_remaining_across_both_books)
```

If no trades have been made, the split is 50/50.

**P&L baseline**
On the very first successful Alpaca API call, the server records `account.equity / 2` as `initial_equity_per_book` in the `settings` table. This value is fixed for the lifetime of the account:

```
pnl     = total_value − initial_equity_per_book
pnl_pct = pnl / initial_equity_per_book × 100
```

The combined P&L of both books will always sum to approximately the Alpaca account's total P&L. If the individual books show large swings in opposite directions, it means one book has deployed significantly more capital than the other — the maths is correct, the deployment is unequal.

If you reset the account or deposit more funds, update `initial_equity_per_book` in the `settings` table manually, or delete the row and restart the server to re-snapshot.

---

## The woke score

Each stock is scored 0–100 on five dimensions via Claude (`claude-sonnet-4-6`):

| Dimension | What it measures |
|---|---|
| Environmental | Carbon footprint, fossil fuel exposure, climate commitments |
| Labor | Worker treatment, wages, union relations, injury rates |
| Diversity & Governance | Board diversity, pay equity, executive compensation |
| Harm avoidance | Weapons, prison industry, surveillance, tobacco, payday lending |
| Political | Lobbying spend, political donations, regulatory capture |

Scores are cached in SQLite and refreshed on a configurable TTL (default: 24 hours). The hard ethical floor (default: 30/100) is the one thing neither book will cross regardless of financial performance.

**Why woke scores cluster.** In practice, a large proportion of S&P 500 companies score in the 55–70 range. Genuinely terrible companies (XOM, LMT, CVX) cluster near the bottom; genuinely exemplary ones (NEE, certain healthcare companies) cluster near the top. The middle is crowded. This makes it difficult for composite scores to differentiate strongly among mid-range holdings, especially when a book's ethics weight is high.

**News influence.** When the "Allow news to influence trading" setting is enabled, recent Alpaca news headlines for each ticker are injected into both the woke and financial scoring prompts before Claude scores the stock. Scores will reflect the current news context rather than only static ESG knowledge. This is logged with `[news]` tags in the server output.

---

## Settings

All settings are configurable from the dashboard (⚙ button) and stored in the `settings` SQLite table. Changes take effect on the next agent cycle.

| Setting | Default | Description |
|---|---|---|
| Allow news to influence trading | off | Injects Alpaca news headlines into scoring prompts |
| Woke floor | 30 | Minimum ethics score (0–100) to consider a stock |
| Max position size | 10% | Maximum share of a book's capital in one position |
| Max trade size | $5,000 | Hard dollar cap per trade order |
| Trade cooldown | 60 min | Minutes before the same ticker can be traded again |
| Ethics score TTL | 24 hr | How long a woke score is cached before Claude re-scores |
| Financial score TTL | 30 min | How long a financial score is cached |

---

## Database

SQLite via Node's built-in `node:sqlite` (no native binary, no Gatekeeper issues on macOS).

> **Why not better-sqlite3?** The original implementation used `better-sqlite3`, which ships a prebuilt native binary. On macOS, Gatekeeper rejected it with a Team ID code-signature error that could not be resolved without rebuilding from source. `node:sqlite` (available since Node 22.5) has no native component and works identically for this use case.

Key tables:

| Table | Purpose |
|---|---|
| `books` | Book config: `woke_weight`, `financial_weight`, capital |
| `trades` | Full trade history — the source of truth for position attribution and cash split |
| `woke_scores` | Cached ethics scores with TTL |
| `financial_scores` | Cached financial scores with TTL |
| `portfolio_snapshots` | Point-in-time book value snapshots used for P&L trend and weight adjustment |
| `agent_log` | Every hold/buy/sell/skip decision with reasoning |
| `daily_summaries` | End-of-day journal entries from each book |
| `sp500_tickers` | S&P 500 constituent list, refreshed from remote CSV or seeded from fallback |
| `settings` | All configurable parameters |
| `trade_cooldowns` | Per-ticker cooldown tracking |

---

## Known behaviours and open questions

**Weight drift to extremes.** The `adjustWeights` function nudges each book's woke/financial weighting each cycle based on recent P&L trend. When a book loses consistently, it doubles down on its core philosophy. This can push Book A to its maximum ethics weighting (0.80), at which point financial scores contribute very little to composite calculations. All holdings then score similarly (~62), making rotation and replacement decisions nearly impossible. This is philosophically coherent but practically self-defeating.

**Unequal capital deployment.** Because both books share one Alpaca account and Alpaca paper trading provides significant buying power beyond the deposited amount, one book can end up deploying more capital than the other across early cycles. The internal cash split corrects for this over time, but the initial deployment may be lopsided. The books' P&L figures reflect this imbalance accurately — they are not wrong, the deployment genuinely is unequal.

**Scores clustering at ~62.** Most mid-cap S&P 500 companies receive similar woke scores from Claude. With Book A's ethics weight at 0.80, composite scores converge tightly. This is a real limitation of the scoring model at this scale and update frequency, not a bug.

**The zombie zone is real.** Between the sell floor (45) and the buy threshold (60) there is a 15-point band where holdings sit indefinitely. Rotation is the designed solution. Rotation fires when a zombie exists *and* a materially better candidate is available. When all holdings score above 60 (which happens when woke_weight is high), there are no zombies and rotation is correctly skipped — even if the book is losing money, because the losses are from price movement, not from bad scoring.

---

## Upcoming (GitHub Issues)

- **[#4]** S&P 500 ticker seeding on cold start (partial — fallback seeding implemented, startup call in progress)
- **[#7]** Parallel Claude API calls in scoring loops (implemented)
- **[#9]** Book C — Ultra-Ethical Universe (avg woke score must stay above 90)
- **[#10]** Book D — Maximum Extraction Universe (10% ethical, 90% greed, complicated feelings about it)

---

## License

MIT
