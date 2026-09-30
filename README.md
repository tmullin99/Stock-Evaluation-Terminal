# Comps Notebook

A stock peer-comps dashboard built for a beginner investor, not a trading
desk — warm paper-and-ink colors, serif/sans type built for reading, and a
plain-English explanation under every number instead of just the number
itself. Type a ticker, it fetches real fundamentals server-side, suggests
real industry peers, ranks the group on growth, profitability and valuation
with adjustable weights, and also shows a plain-language takeaway sentence,
a fundamentals scorecard with a readable checklist, financial-health checks,
a multi-year revenue trend, and recent news per company. A built-in "Learn
the terms" glossary and "?" buttons next to every jargon label explain what
each metric actually means, so using the dashboard is itself a way to learn
how to read one.

This is a normal two-part web app, not a Claude artifact, so it can be deployed
anywhere that runs Node.js serverless functions and shared with a plain URL —
no Claude account needed on the other end.

- `public/index.html` — the whole frontend (one file, no build step)
- `api/company.js` — fetches fundamentals server-side (so your API keys never
  reach the browser), trying Finnhub first, Financial Modeling Prep as a
  fallback for whatever Finnhub doesn't have, and Alpha Vantage as a last
  resort for whatever's still missing after both
- `api/news.js` — fetches recent news + sentiment for one ticker, called only
  when you click "Load recent news" on a card (keeps API usage low)
- `api/movers.js` — fetches today's top gainers/losers for the always-on
  market snapshot, cached for 3 minutes so repeat page loads don't re-spend
  a call

## 1. Get your API keys

**Finnhub** (recommended, this is the primary source now): sign up at
https://finnhub.io/register (just an email, no credit card). Free tier is
**60 requests/minute with no daily cap** — this is what most ticker lookups
use, and it's a lot more headroom than the other two.

**Financial Modeling Prep** (optional fallback): sign up at
https://site.financialmodelingprep.com/register (no credit card). Free tier
is roughly 250 requests/day, only spent when Finnhub doesn't have a ticker.
It's also currently the only source in this app for the multi-year revenue
trend chart, since Finnhub's free tier doesn't include full financial
statements.

**Alpha Vantage** (optional, last-resort fallback): get a free key at
https://www.alphavantage.co/support/#api-key (just an email, no signup
form). Free tier is roughly 25 requests/day as of writing — thin, but it
also powers the market snapshot and the news feed, so it's worth having.

You can run this with just the Finnhub key and skip the other two — you'll
lose the revenue trend chart and the market snapshot/news feed, but ticker
lookups themselves will work fine.

## 2. Deploy to Vercel (free) — pick one path

### Path A: no terminal, all in the browser
1. Create a new GitHub repo and upload this folder's contents to it (GitHub's
   web UI has an "upload files" button — drag the whole folder in, so
   `public/` and `api/` end up at the repo root, not nested one level deep).
2. Go to https://vercel.com, sign up with your GitHub account, click
   "Add New… → Project", and import that repo.
3. Before the first deploy, open "Environment Variables" and add:
   - Key: `FINNHUB_API_KEY` — Value: your Finnhub key
   - Key: `FMP_API_KEY` — Value: your Financial Modeling Prep key (optional)
   - Key: `ALPHA_VANTAGE_API_KEY` — Value: your Alpha Vantage key (optional)
4. Click Deploy. Vercel gives you a URL like `comps-terminal.vercel.app` —
   that's the link to share.

### Path B: command line (a few minutes if you have Node.js installed)
```bash
npm install -g vercel
cd comps-terminal-app
vercel                                # first deploy, follow the prompts
vercel env add FINNHUB_API_KEY        # paste your Finnhub key when asked
vercel env add FMP_API_KEY            # optional -- paste your FMP key
vercel env add ALPHA_VANTAGE_API_KEY  # optional -- paste your AV key
vercel --prod                         # redeploy with the env vars attached
```

### Already deployed and just adding/changing a key now?
Go to your Vercel project → Settings → Environment Variables → add or edit
the key → then Deployments → "..." on the latest deployment → Redeploy, so
the change actually takes effect.

## 3. Using it

Type a ticker (e.g. `AMD`) and hit Fetch. Each card shows:
- Price, market cap, logo and a one-line description
- A plain-English **takeaway sentence** at the top of the card (e.g. "Apple
  Inc. is growing sales while turning a healthy profit, and is currently
  priced more cheaply than the peers you're tracking.") — a quick read of
  what the numbers below actually mean, generated from the same figures
  the card shows
- A **fundamentals scorecard** pill (Strong / Mixed / Weak / Not enough
  data) — click it to expand a plain-language pass/fail checklist (revenue
  growth, margins, free cash flow, liquidity, leverage, a sane P/E), **not
  investment advice or a buy/sell call**
- A financial-health strip: current ratio, debt/equity, free cash flow, and
  a cash-runway warning if the company is burning cash
- A small revenue trend line across however many years of history the data
  source returned
- Up to 6 suggested industry peers (click a chip to add it to the same group)
- A "Load recent news" button (fetches on click only, to conserve Alpha
  Vantage's daily request limit)

Every jargon label (Rev growth, Net margin, P/E, EV/EBITDA, Market cap,
Current ratio, Debt/equity, Free cash flow, the composite Score, and more)
has a small "?" button next to it. Click one and it opens the **"Learn the
terms" glossary** (also reachable from the header) scrolled straight to
that definition, in plain English, no finance-jargon-explained-with-more-
jargon.

Everything you track is saved in *your* browser's local storage — this app
has no shared server-side database. Use "Copy shareable link" to bake your
current tickers into a URL; anyone who opens it gets those same tickers
fetched fresh into their own browser.

**Display settings** (top right) let you show or hide each section —
description, fundamentals badge, stats, revenue trend, health strip, news
button, the ranking table, and the group charts — per your own browser.
The ranking table is hidden by default; the cards themselves, with their
takeaway sentences, are the primary view for a beginner. Nothing in this
panel changes the data, only what's shown.

**Color scheme** (same panel, below the section toggles) defaults to **Paper
& Ink** — a warm, light, high-contrast theme chosen for readability, not a
dark terminal look. Three more presets are available (Clear Sky, Rosewood,
and Night Reading for a dark option), plus six swatches (background, text,
accent, gains, losses, warning) you can adjust individually. Panels,
borders, and table shading all derive from your background/text choice
automatically, so any combination still looks like one coherent theme.
Saved per browser, same as the display toggles.

**Market snapshot:** every visit, whether or not you've tracked anything
yet, the top of the page shows today's biggest gainers and losers (via
Alpha Vantage) so there's always something to look at before you type a
ticker. Click the `+` on any of them to add it to your own tracked list —
this doesn't spend an FMP lookup until you actually do that.

**Ticker tape:** the strip across the very top scrolls every company you're
tracking with its live price and daily % change (green up, red down). It
fills in automatically as you add tickers — nothing to configure.

## Notes on the data

- Finnhub is tried first (4 calls: profile, quote, ratios, peers). FMP only
  gets called when Finnhub didn't have the ticker at all, and Alpha Vantage
  only for whatever's still missing after both. In the common case this
  means zero FMP or Alpha Vantage calls per lookup — that headroom is the
  whole reason for the ordering. Each card's health strip says which
  source(s) it actually came from.
- Finnhub's free tier gives ratios directly (P/E, margins, growth, current
  ratio, debt/equity) rather than raw financial statements, so those are
  used as-is when present instead of being recalculated from dollar
  figures. The one thing its free tier doesn't include is multi-year
  history, so the revenue trend chart only appears when FMP (or Alpha
  Vantage) also had data for that ticker.
- All three providers' field names are documented and have been stable for
  years, but if a number ever looks wrong, open your browser's Network tab,
  find the `/api/company?ticker=...` request, and check the `raw` field in
  its response — that's the untouched upstream payload from whichever
  source(s) responded, useful for adjusting a `pick(...)` call in
  `api/company.js`. Debt/equity specifically was mapped from Finnhub's
  documented convention without a live key to verify against — if it ever
  reads as an obviously-wrong huge or tiny number, that's the field to
  check first.
- All three free tiers rate-limit. Finnhub's (60/min, no daily cap) is by
  far the most generous; FMP (~250/day) and Alpha Vantage (~25/day) are
  both tight, which is why they're fallbacks now rather than the primary
  source, and why news is fetch-on-click rather than automatic.
- The valuation score deliberately treats a negative P/E or EV/EBITDA (a
  loss-making company) as the *most* expensive score (0), not the cheapest —
  a plain min/max normalization would otherwise call a money-losing company
  "cheap," which is backwards.
- The fundamentals scorecard uses fixed, generic thresholds (P/E under 40,
  current ratio above 1, etc.) that don't account for industry norms — a
  bank or an insurer will look "wrong" on some of these by construction.
  Treat it as a quick sanity check, not a verdict.
- If a ticker comes back with "Couldn't get data ... from any provider," the
  error message names what each provider actually said. Almost always this
  means an API key or a daily-quota problem on the provider's side — check
  each provider's dashboard. It is not something a redeploy fixes.
