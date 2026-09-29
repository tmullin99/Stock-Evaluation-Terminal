# Comps Terminal

A live stock peer-comps dashboard styled after a Bloomberg terminal — black
background, amber monospace type, sharp corners, and a scrolling ticker tape
of whatever you're tracking. Type a ticker, it fetches real fundamentals
server-side, suggests real industry peers, ranks the group on growth,
profitability and valuation with adjustable weights, and also shows a
fundamentals scorecard, financial-health checks, a multi-year revenue trend,
and recent news per company.

This is a normal two-part web app, not a Claude artifact, so it can be deployed
anywhere that runs Node.js serverless functions and shared with a plain URL —
no Claude account needed on the other end.

- `public/index.html` — the whole frontend (one file, no build step)
- `api/company.js` — fetches fundamentals server-side (so your API keys never
  reach the browser), trying Financial Modeling Prep first and Alpha Vantage
  as a fallback for whatever FMP's free tier doesn't cover (mostly small caps)
- `api/news.js` — fetches recent news + sentiment for one ticker, called only
  when you click "Load recent news" on a card (keeps API usage low)
- `api/movers.js` — fetches today's top gaining tickers, used once to
  populate the dashboard on a visitor's very first visit (empty browser, no
  shared link)

## 1. Get your API keys

**Financial Modeling Prep** (required): sign up at
https://site.financialmodelingprep.com/register (no credit card). Free tier
is roughly 250 requests/day.

**Alpha Vantage** (optional, but strongly recommended): get a free key at
https://www.alphavantage.co/support/#api-key (just an email, no signup form).
This is what makes small-cap tickers work, and it also powers the news feed.
Without it, small caps will still show a price and peer suggestions, but
financials will often be blank.

## 2. Deploy to Vercel (free) — pick one path

### Path A: no terminal, all in the browser
1. Create a new GitHub repo and upload this folder's contents to it (GitHub's
   web UI has an "upload files" button — drag the whole folder in, so
   `public/` and `api/` end up at the repo root, not nested one level deep).
2. Go to https://vercel.com, sign up with your GitHub account, click
   "Add New… → Project", and import that repo.
3. Before the first deploy, open "Environment Variables" and add both:
   - Key: `FMP_API_KEY` — Value: your Financial Modeling Prep key
   - Key: `ALPHA_VANTAGE_API_KEY` — Value: your Alpha Vantage key
4. Click Deploy. Vercel gives you a URL like `comps-terminal.vercel.app` —
   that's the link to share.

### Path B: command line (a few minutes if you have Node.js installed)
```bash
npm install -g vercel
cd comps-terminal-app
vercel                                # first deploy, follow the prompts
vercel env add FMP_API_KEY            # paste your FMP key when asked
vercel env add ALPHA_VANTAGE_API_KEY  # paste your Alpha Vantage key when asked
vercel --prod                         # redeploy with both env vars attached
```

### Already deployed and just adding the Alpha Vantage key now?
Go to your Vercel project → Settings → Environment Variables → add
`ALPHA_VANTAGE_API_KEY` → then Deployments → "..." on the latest deployment →
Redeploy, so the new key actually takes effect.

## 3. Using it

Type a ticker (e.g. `AMD`) and hit Fetch. Each card shows:
- Price, market cap, logo and a one-line description
- A **fundamentals scorecard** badge (Strong / Mixed / Weak / Not enough
  data) — a plain factual checklist (revenue growth, margins, free cash
  flow, liquidity, leverage, a sane P/E), **not investment advice or a
  buy/sell call**. Hover it to see which checks passed.
- A financial-health strip: current ratio, debt/equity, free cash flow, and
  a cash-runway warning if the company is burning cash
- A small revenue trend line across however many years of history the data
  source returned
- Up to 6 suggested industry peers (click a chip to add it to the same group)
- A "Load recent news" button (fetches on click only, to conserve Alpha
  Vantage's daily request limit)

Everything you track is saved in *your* browser's local storage — this app
has no shared server-side database. Use "Copy shareable link" to bake your
current tickers into a URL; anyone who opens it gets those same tickers
fetched fresh into their own browser.

**Display settings** (the ⚙ button, top right) let you show or hide each
section — description, fundamentals badge, stats, revenue trend, health
strip, news button, the ranking table, and the group charts — per your own
browser. Nothing here changes the data, only what's shown.

**First visit:** if your browser has nothing tracked yet and you didn't open
a shared link, the dashboard auto-populates with today's top 5 market movers
(via Alpha Vantage) so it's never empty. This only happens once per browser
— remove any of them, and they won't come back on your next visit.

**Ticker tape:** the amber strip across the very top scrolls every company
you're tracking with its live price and daily % change (green up, red down).
It fills in automatically as you add tickers — nothing to configure.

## Notes on the data

- FMP is tried first; Alpha Vantage fills in whatever FMP's free tier left
  empty (mainly small/micro caps). Each card's health strip says which
  source its financials came from.
- Both providers' field names are well-documented and have been stable for
  years, but if a number ever looks wrong, open your browser's Network tab,
  find the `/api/company?ticker=...` request, and check the `raw` field in
  its response — that's the untouched upstream payload from whichever
  source(s) responded, useful for adjusting a `pick(...)` call in
  `api/company.js`.
- Both free tiers rate-limit. Alpha Vantage's is the tighter one (historically
  as low as 25-500 requests/day depending on signup date) — that's why news
  is fetch-on-click rather than automatic, and why the fallback only fires
  when FMP actually comes back empty rather than on every request.
- The valuation score deliberately treats a negative P/E or EV/EBITDA (a
  loss-making company) as the *most* expensive score (0), not the cheapest —
  a plain min/max normalization would otherwise call a money-losing company
  "cheap," which is backwards.
- The fundamentals scorecard uses fixed, generic thresholds (P/E under 40,
  current ratio above 1, etc.) that don't account for industry norms — a
  bank or an insurer will look "wrong" on some of these by construction.
  Treat it as a quick sanity check, not a verdict.
