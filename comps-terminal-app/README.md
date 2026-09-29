# Comps Terminal

A live stock peer-comps dashboard. Type a ticker, it fetches real fundamentals
from Financial Modeling Prep server-side, suggests real industry peers, and
ranks the group on growth, profitability and valuation with adjustable weights.

This is a normal two-part web app, not a Claude artifact, so it can be deployed
anywhere that runs Node.js serverless functions and shared with a plain URL —
no Claude account needed on the other end.

- `public/index.html` — the whole frontend (one file, no build step)
- `api/company.js` — a serverless function that calls Financial Modeling Prep
  server-side (so your API key never reaches the browser) and returns clean,
  normalized numbers to the page

## 1. Get a free API key

Sign up at https://site.financialmodelingprep.com/register (no credit card).
Free tier is roughly 250 requests/day — plenty for personal use. Copy the key
they give you.

## 2. Deploy to Vercel (free) — pick one path

### Path A: no terminal, all in the browser
1. Create a new GitHub repo and upload this folder's contents to it (GitHub's
   web UI has an "upload files" button — drag the whole folder in).
2. Go to https://vercel.com, sign up with your GitHub account, click
   "Add New… → Project", and import that repo.
3. Before the first deploy, open "Environment Variables" and add:
   - Key: `FMP_API_KEY`
   - Value: the key from step 1
4. Click Deploy. Vercel gives you a URL like `comps-terminal.vercel.app` —
   that's the link to share with your brother.

### Path B: command line (a few minutes if you have Node.js installed)
```bash
npm install -g vercel
cd comps-terminal-app
vercel                      # first deploy, follow the prompts
vercel env add FMP_API_KEY  # paste your key when asked
vercel --prod               # redeploy with the env var attached
```

## 3. Using it

Type a ticker (e.g. `AMD`) and hit Fetch. It pulls live price, market cap,
revenue/margins/EBITDA, and up to 6 suggested industry peers — click a peer
chip to add it to the same group. Everything you track is saved in *your*
browser's local storage, so your brother opening the same link builds his own
independent list — this app has no shared server-side database, only a
shared data source.

## Notes on the data

- Numbers come from Financial Modeling Prep's `/stable` endpoints
  (profile, quote, income-statement, balance-sheet-statement, stock-peers).
  `api/company.js` maps their documented field names into the shape the page
  expects, with a couple of fallback field names in case FMP's schema drifts.
  If a number ever looks wrong, open your browser's Network tab, find the
  `/api/company?ticker=...` request, and check the `raw` field in its
  response — that's the untouched upstream payload, useful for fixing a
  field-name mismatch in `pick(...)` calls in `api/company.js`.
- The free tier does rate-limit; if you see fetch errors after a lot of
  requests in one day, that's the daily cap, not a bug.
- The valuation score deliberately treats a negative P/E or EV/EBITDA (a
  loss-making company) as the *most* expensive score (0), not the cheapest —
  a plain min/max normalization would otherwise call a money-losing company
  "cheap," which is backwards.
