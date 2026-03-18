# Neoliberal Struggle

> *The tension between doing good and making money, automated and running 24/7.*

An autonomous dual-portfolio trading agent that wrestles with the central contradiction of ethical investing: you can't fully optimise for both returns and ethics at the same time. Each book knows this. Each book handles it differently.

---

## What it does

Two AI-driven investment books run in parallel against a shared [Alpaca](https://alpaca.markets) paper trading account, using real market data and fake money.

**Book A — Index Universe (Ethics First)**
Scores every S&P 500 constituent on a woke/ethics rubric and holds the best composite performers. Starts with a 65% ethics / 35% financial weighting and drifts further toward ethics when it's winning. It believes the market will eventually reward virtue. It is sometimes wrong.

**Book B — Screener Universe (Financials First)**
Filters by financial momentum first, then applies an ethics check as a risk filter. Starts at 25% ethics / 75% financial. Gets greedier when it's winning. Uses ethics tactically, not principally.

Both books **autonomously adjust their own woke/greed balance** each cycle based on recent P&L trend — doubling down on their philosophy when it's working, moderating slightly when it isn't. Neither book can fully abandon its nature.

At **4:15pm ET on weekdays**, each book writes a journal entry about its day — and a kind, passive-aggressive commentary about the other one.

---

## Architecture

```
Neoliberal Struggle
├── server/
│   ├── index.js              Express server entry point
│   ├── agent.js              Orchestrator: cron, market check, end-of-day summaries
│   ├── books/
│   │   ├── index-universe.js Book A strategy loop
│   │   ├── screener-universe.js Book B strategy loop
│   │   └── shared.js         Portfolio valuation, snapshots, weight adjustment
│   ├── services/
│   │   ├── alpaca.js         Alpaca REST API client (paper trading)
│   │   ├── scoring.js        Claude API — woke + financial scoring with SQLite cache
│   │   ├── summaries.js      Claude API — end-of-day journal entries
│   │   ├── market.js         S&P 500 universe, market data, screening
│   │   └── guardrails.js     Position size limits, woke floor
│   ├── db/
│   │   ├── index.js          SQLite connection (node:sqlite built-in)
│   │   └── schema.js         Schema init, migrations, seeds
│   └── routes/
│       └── api.js            REST API for the dashboard
├── client/
│   ├── index.html            Dashboard
│   ├── app.js                Dashboard JS
│   └── style.css             Styles
└── db/
    └── neoliberal.db         SQLite database (gitignored)
```

**Stack:** Node.js · Express · node:sqlite · node-cron · Alpaca API · Anthropic Claude API · Chart.js · pm2

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

> Without keys the server still runs in demo mode with mock data and placeholder scores.

### 3. Run

```bash
# Development
npm run dev

# Production (pm2)
npm run pm2:start
```

Dashboard at **http://localhost:3000**

---

## How the agent works

The agent runs every 15 minutes. At the start of each cycle it checks whether the market is open via the Alpaca API — if closed, the cycle is skipped. No hardcoded market hours.

**Each cycle:**
1. Fetch real account cash + live position market values from Alpaca
2. Each book evaluates its current holdings — sell anything below composite or ethics threshold
3. Scan the S&P 500 universe for candidates
4. Score candidates via Claude API (woke score cached 24h, financial score cached 30min)
5. Buy the best composite scorers while cash is available
6. Adjust woke/financial weights based on recent P&L trend

**End of day (4:15pm ET):**
Claude generates a reflective journal entry for each book — its own day in its own voice, and a commentary on the other book's choices.

---

## Database

SQLite via Node's built-in `node:sqlite`. Database lives at `db/neoliberal.db`.

Key tables: `books` · `trades` · `woke_scores` · `financial_scores` · `portfolio_snapshots` · `agent_log` · `daily_summaries` · `sp500_tickers`

---

## How P&L is calculated

Both books share a single Alpaca paper-trading account. Alpaca has no concept of two separate sub-accounts, so all book-level bookkeeping is internal.

**Cash split**
At each cycle, the real Alpaca cash balance is divided proportionally between the two books based on each book's remaining undeployed capital, derived from trade history:

```
book_remaining   = book.capital − net_spend_from_trades
book_cash        = alpaca_cash × (book_remaining / total_remaining_across_both_books)
```

If no trades have been made yet, the split is 50/50.

**Invested value**
Each book's invested value is the sum of live Alpaca `market_value` for tickers where that book holds a net-positive position (tracked via the internal `trades` table).

**Total value**
```
total_value = book_cash + invested_value
```

**P&L baseline**
On the very first successful Alpaca API call, the server records `account.equity / 2` as `initial_equity_per_book` in the `settings` table. This value is **fixed for the lifetime of the account** and used as each book's starting value:

```
pnl     = total_value − initial_equity_per_book
pnl_pct = pnl / initial_equity_per_book × 100
```

This means gains compound correctly from deposit day. The baseline does not drift as the account grows. If you reset the account or deposit more funds, update `initial_equity_per_book` in the `settings` table manually.

**Why your dashboard P&L might not match Alpaca's**
Alpaca shows portfolio-level P&L for the whole account. The dashboard shows per-book P&L based on the internal cash split and position attribution. If the cash split has drifted from 50/50 (because one book has deployed more capital), the two numbers will legitimately differ. They should converge at end-of-day when positions are valued at close.

The demo page (`/demo`) uses simulated trade data and fake price movement — its P&L numbers are not derived from Alpaca and are purely illustrative.

---

## The woke score

Each stock is scored 0–100 on five dimensions via Claude:

| Dimension | What it measures |
|---|---|
| Environmental | Carbon footprint, fossil fuel exposure |
| Labor | Worker treatment, wages, union relations |
| Diversity & Governance | Board diversity, pay equity, exec compensation |
| Harm avoidance | Weapons, prison industry, surveillance, tobacco |
| Political | Lobbying spend, political donations |

Scores are cached in SQLite and refreshed every 24 hours. The hard ethical floor (default: 30/100) is the one thing neither book will cross regardless of financial performance.

---

## License

MIT
