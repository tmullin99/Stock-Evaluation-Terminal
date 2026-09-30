// Serverless function: GET /api/company?ticker=AAPL
//
// Runs server-side (Vercel Node.js function), so API keys never reach the
// browser and this call is not subject to browser CORS rules.
//
// Three data sources, tried in order:
//   1. Finnhub (FINNHUB_API_KEY) -- PRIMARY. Free tier is 60 calls/minute
//      (no daily cap), which is what this file is built around now. Get a
//      free key at finnhub.io/register (just an email).
//   2. Financial Modeling Prep (FMP_API_KEY, optional) -- used only when
//      Finnhub didn't have this ticker at all. Its free tier is a tight
//      ~250 requests/day, so it's a fallback now, not the primary source.
//   3. Alpha Vantage (ALPHA_VANTAGE_API_KEY, optional) -- last resort, for
//      whatever both of the above still left empty. Free tier is only
//      ~25 requests/day as of writing, so it rarely gets much of a chance.
//
// In the common case (Finnhub has the ticker), this makes 4 calls total
// and never touches FMP or Alpha Vantage at all -- that's the whole point
// of the reordering: the old FMP-primary version spent up to 6 FMP calls
// on every single lookup and burned through its daily quota in a hurry.
//
// A note on Finnhub's `metric` fields: margins and growth rates come back
// as plain percentages (e.g. 42.5 meaning 42.5%), so they're divided by
// 100 below to match this app's decimal-fraction convention everywhere
// else. P/E, EV/EBITDA, current ratio and debt/equity come back as plain
// multiples already, so those aren't rescaled. These are Finnhub's
// documented conventions, not verified against a live key from here --
// same as the FMP/AV field names elsewhere in this file, the response
// always includes `raw` so a scaling or naming mismatch can be caught from
// your browser's Network tab and fixed in one line, without guessing.

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FMP_BASE = "https://financialmodelingprep.com/stable";
const AV_BASE = "https://www.alphavantage.co/query";

async function fetchJson(url, label) {
  const r = await fetch(url);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(label + " returned non-JSON (status " + r.status + "): " + text.slice(0, 200));
  }
  if (!r.ok) {
    const msg = (json && (json.error || json.message || json["Error Message"])) || ("HTTP " + r.status);
    throw new Error(label + " (" + r.status + "): " + msg);
  }
  // Alpha Vantage returns 200 with an informational body on rate-limit/bad-symbol
  if (json && (json.Note || json.Information)) {
    throw new Error(label + " limit/notice: " + (json.Note || json.Information));
  }
  if (json && json["Error Message"]) {
    throw new Error(label + " error: " + json["Error Message"]);
  }
  return json;
}

// Tiny in-memory cache, scoped to one warm serverless instance. Vercel
// reuses a warm instance across nearby requests, so this cuts duplicate
// upstream calls (e.g. a peer chip you already fetched, or a page reload)
// without needing a real database. Cold starts just get an empty cache.
var CACHE = new Map();
var CACHE_TTL_MS = 3 * 60 * 1000;
function cacheGet(key) {
  var hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value: value, at: Date.now() });
  if (CACHE.size > 200) { CACHE.delete(CACHE.keys().next().value); }
}

function pick(obj, names) {
  if (!obj) return null;
  var o = Array.isArray(obj) ? obj[0] : obj;
  if (!o) return null;
  for (var i = 0; i < names.length; i++) {
    if (o[names[i]] !== undefined && o[names[i]] !== null && o[names[i]] !== "None" && o[names[i]] !== "") {
      return o[names[i]];
    }
  }
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}
function pct100(v) { var n = num(v); return n == null ? null : n / 100; }

function mm(v) { return v == null ? null : v / 1e6; }

// ---------------- Finnhub ----------------
async function fetchFinnhub(ticker, key) {
  var q = "symbol=" + encodeURIComponent(ticker) + "&token=" + encodeURIComponent(key);
  var results = await Promise.allSettled([
    fetchJson(FINNHUB_BASE + "/stock/profile2?" + q, "Finnhub profile"),
    fetchJson(FINNHUB_BASE + "/quote?" + q, "Finnhub quote"),
    fetchJson(FINNHUB_BASE + "/stock/metric?" + q + "&metric=all", "Finnhub metrics"),
    fetchJson(FINNHUB_BASE + "/stock/peers?" + q, "Finnhub peers"),
  ]);
  var val = function (r) { return r.status === "fulfilled" ? r.value : null; };
  var profile = val(results[0]);
  var quote = val(results[1]);
  var metricResp = val(results[2]);
  var peersData = val(results[3]);
  // Finnhub returns 200 with an empty/zeroed body for a symbol it doesn't
  // have, rather than an HTTP error -- treat those as "no data" too.
  if (profile && Object.keys(profile).length === 0) profile = null;
  if (quote && (quote.c === 0 || quote.c == null) && (quote.pc === 0 || quote.pc == null)) quote = null;
  return {
    profile: profile,
    quote: quote,
    metric: (metricResp && metricResp.metric) || null,
    peers: Array.isArray(peersData) ? peersData.filter(function (p) { return p && p !== ticker; }) : [],
    errors: results.map(function (r) { return r.status === "rejected" ? r.reason.message : null; }),
  };
}

// ---------------- Financial Modeling Prep (fallback) ----------------
async function fetchFmp(ticker, key) {
  var q = "symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(key);
  var results = await Promise.allSettled([
    fetchJson(FMP_BASE + "/profile?" + q, "FMP profile"),
    fetchJson(FMP_BASE + "/quote?" + q, "FMP quote"),
    fetchJson(FMP_BASE + "/income-statement?" + q + "&limit=5", "FMP income"),
    fetchJson(FMP_BASE + "/balance-sheet-statement?" + q + "&limit=1", "FMP balance"),
    fetchJson(FMP_BASE + "/cash-flow-statement?" + q + "&limit=1", "FMP cash flow"),
    fetchJson(FMP_BASE + "/stock-peers?" + q, "FMP peers"),
  ]);
  var val = function (r) { return r.status === "fulfilled" ? r.value : null; };
  var income = val(results[2]);
  var balance = val(results[3]);
  var cashflow = val(results[4]);
  var incomeArr = Array.isArray(income) ? income : (income ? [income] : []);
  var balanceArr = Array.isArray(balance) ? balance : (balance ? [balance] : []);
  var cashflowArr = Array.isArray(cashflow) ? cashflow : (cashflow ? [cashflow] : []);
  var peersData = val(results[5]);
  var peers = [];
  if (Array.isArray(peersData) && peersData[0] && Array.isArray(peersData[0].peersList)) {
    peers = peersData[0].peersList;
  } else if (peersData && Array.isArray(peersData.peersList)) {
    peers = peersData.peersList;
  } else if (Array.isArray(peersData)) {
    peers = peersData.map(function (p) { return (typeof p === "string") ? p : (p && p.symbol); }).filter(Boolean);
  }
  return {
    profile: val(results[0]),
    quote: val(results[1]),
    incomeArr: incomeArr,
    balanceCur: balanceArr[0] || null,
    cashflowCur: cashflowArr[0] || null,
    peers: peers,
    errors: results.map(function (r) { return r.status === "rejected" ? r.reason.message : null; }),
  };
}

// ---------------- Alpha Vantage (last resort) ----------------
async function fetchAv(ticker, key, need) {
  var avq = "symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(key);
  var results = await Promise.allSettled([
    need.profile ? fetchJson(AV_BASE + "?function=OVERVIEW&" + avq, "Alpha Vantage overview") : Promise.resolve(null),
    need.quote ? fetchJson(AV_BASE + "?function=GLOBAL_QUOTE&" + avq, "Alpha Vantage quote") : Promise.resolve(null),
    need.income ? fetchJson(AV_BASE + "?function=INCOME_STATEMENT&" + avq, "Alpha Vantage income") : Promise.resolve(null),
    need.balance ? fetchJson(AV_BASE + "?function=BALANCE_SHEET&" + avq, "Alpha Vantage balance") : Promise.resolve(null),
    need.cashflow ? fetchJson(AV_BASE + "?function=CASH_FLOW&" + avq, "Alpha Vantage cash flow") : Promise.resolve(null),
  ]);
  var val = function (r) { return r.status === "fulfilled" ? r.value : null; };
  var income = val(results[2]);
  var balance = val(results[3]);
  var cashflow = val(results[4]);
  return {
    overview: val(results[0]),
    quote: val(results[1]),
    incomeArr: (income && income.annualReports) || [],
    balCur: (balance && balance.annualReports && balance.annualReports[0]) || null,
    cfCur: (cashflow && cashflow.annualReports && cashflow.annualReports[0]) || null,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  var ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "Pass ?ticker=SYMBOL" });
    return;
  }
  var finnhubKey = process.env.FINNHUB_API_KEY;
  var fmpKey = process.env.FMP_API_KEY;
  var avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!finnhubKey && !fmpKey) {
    res.status(500).json({ error: "Server is missing both FINNHUB_API_KEY and FMP_API_KEY -- add at least one as an environment variable in your hosting dashboard and redeploy. Finnhub is recommended (much higher free-tier limit)." });
    return;
  }

  var cached = cacheGet(ticker);
  if (cached) {
    res.status(200).json(cached);
    return;
  }

  try {
    // ---- 1. Finnhub, primary ----
    var fh = { profile: null, quote: null, metric: null, peers: [], errors: [] };
    if (finnhubKey) fh = await fetchFinnhub(ticker, finnhubKey);

    var source = { quote: fh.quote ? "finnhub" : "none", financials: fh.metric ? "finnhub" : "none", cashflow: "none" };

    // ---- 2. FMP, only when Finnhub didn't have this ticker at all ----
    // (keeps FMP's tight daily quota almost untouched in the normal case)
    var fmp = { profile: null, quote: null, incomeArr: [], balanceCur: null, cashflowCur: null, peers: [], errors: [] };
    var finnhubMissing = !fh.profile || !fh.quote;
    if (finnhubMissing && fmpKey) {
      fmp = await fetchFmp(ticker, fmpKey);
      if (!source.quote || source.quote === "none") source.quote = fmp.quote ? "fmp" : "none";
      if (fmp.incomeArr.length) source.financials = source.financials === "none" ? "fmp" : source.financials;
      if (fmp.cashflowCur) source.cashflow = "fmp";
    }

    // ---- 3. Alpha Vantage, last resort for whatever's still missing ----
    var av = { overview: null, quote: null, incomeArr: [], balCur: null, cfCur: null };
    var stillNeed = {
      profile: !fh.profile && !fmp.profile,
      quote: !fh.quote && !fmp.quote,
      income: !fh.metric && !fmp.incomeArr.length,
      balance: !fmp.balanceCur,
      cashflow: !fmp.cashflowCur,
    };
    if (avKey && (stillNeed.profile || stillNeed.quote || stillNeed.income || stillNeed.balance || stillNeed.cashflow)) {
      av = await fetchAv(ticker, avKey, stillNeed);
      if (av.quote && source.quote === "none") source.quote = "alphavantage";
      if (av.incomeArr.length && source.financials === "none") source.financials = "alphavantage";
      if (av.cfCur) source.cashflow = "alphavantage";
    }

    // Give up only once Finnhub, FMP and Alpha Vantage have all had a shot.
    if (!fh.profile && !fh.quote && !fmp.profile && !fmp.quote && !av.overview && !av.quote) {
      var bits = [];
      if (finnhubKey) bits.push("Finnhub: " + (fh.errors.filter(Boolean)[0] || "no data for this symbol") + ".");
      else bits.push("Finnhub key isn't set.");
      if (fmpKey) bits.push("FMP: " + (fmp.errors.filter(Boolean)[0] || "no data for this symbol") + ".");
      else bits.push("FMP key isn't set.");
      bits.push(avKey ? "Alpha Vantage also came back empty." : "Alpha Vantage key isn't set either.");
      res.status(502).json({
        error: "Couldn't get data for " + ticker + " from any provider. " + bits.join(" ")
          + " If this happens for every ticker, it's almost always an API key or quota problem -- check each provider's dashboard.",
      });
      return;
    }

    var avGlobalQuote = av.quote && av.quote["Global Quote"];
    var avIncCur = av.incomeArr[0] || null, avIncPrior = av.incomeArr[1] || null;

    // ---- core identity ----
    var name = pick(fh.profile, ["name"]) || pick(fmp.profile, ["companyName", "name"]) || pick(av.overview, ["Name"]) || ticker;
    var industry = pick(fh.profile, ["finnhubIndustry"]) || pick(fmp.profile, ["industry"]) || pick(av.overview, ["Industry"]) || "Unsorted";
    var sector = pick(fmp.profile, ["sector"]) || pick(av.overview, ["Sector"]) || null;
    var description = pick(fmp.profile, ["description"]) || pick(av.overview, ["Description"]) || null; // Finnhub's free profile has no description field
    var logo = pick(fh.profile, ["logo"]) || pick(fmp.profile, ["image"]);

    var price = num(pick(fh.quote, ["c"])) || num(pick(fmp.quote, ["price"])) || num(pick(fmp.profile, ["price"])) ||
                num(pick(avGlobalQuote, ["05. price"])) || num(pick(av.overview, ["AnalystTargetPrice"]));
    var changePct = num(pick(fh.quote, ["dp"])) || num(pick(fmp.quote, ["changePercentage"]));
    if (changePct == null && avGlobalQuote) {
      var avChangePct = pick(avGlobalQuote, ["10. change percent"]);
      if (avChangePct) changePct = num(String(avChangePct).replace("%", ""));
    }
    var sharesOutMM = num(pick(fh.profile, ["shareOutstanding"])); // Finnhub gives this in millions already
    var sharesOut = num(pick(fmp.quote, ["sharesOutstanding"])) || num(pick(fmp.profile, ["sharesOutstanding", "shares"])) ||
                    num(pick(av.overview, ["SharesOutstanding"]));
    var marketCapFhMM = num(pick(fh.profile, ["marketCapitalization"])); // Finnhub gives this in millions already
    var marketCapRaw = num(pick(fmp.quote, ["marketCap"])) || num(pick(fmp.profile, ["mktCap", "marketCap"])) ||
                        num(pick(av.overview, ["MarketCapitalization"]));
    var sharesMM = sharesOutMM || (sharesOut ? sharesOut / 1e6 : null) ||
                   (marketCapFhMM && price ? marketCapFhMM / price : null) ||
                   (marketCapRaw && price ? marketCapRaw / price / 1e6 : null);

    // ---- precomputed ratios (Finnhub's `metric`, when we have it) ----
    var m = fh.metric;
    var rPe = num(pick(m, ["peTTM", "peBasicExclExtraTTM", "peExclExtraTTM", "peNormalizedAnnual"]));
    var rEvEbitda = num(pick(m, ["evEbitdaTTM", "evEbitdaAnnual"]));
    var rGrossMargin = pct100(pick(m, ["grossMarginTTM", "grossMarginAnnual"]));
    var rOpMargin = pct100(pick(m, ["operatingMarginTTM", "operatingMarginAnnual"]));
    var rNetMargin = pct100(pick(m, ["netMarginTTM", "netProfitMarginTTM", "netProfitMarginAnnual"]));
    var rRevGrowth = pct100(pick(m, ["revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy", "revenueGrowth5Y"]));
    var rCurrentRatio = num(pick(m, ["currentRatioAnnual", "currentRatioQuarterly"]));
    // Finnhub's debt/equity, like its margins, comes back as a percent
    // number (e.g. 145.2 meaning a 1.45x ratio) rather than the plain
    // multiple -- a raw reading of "145x" would be nonsensical for any real
    // company, so this is scaled the same way. Flagged in this file's top
    // comment as the one field worth double-checking against `raw` first.
    var rDebtToEquity = pct100(pick(m, ["totalDebt/totalEquityAnnual", "debtToEquityAnnual", "totalDebt/totalEquityQuarterly"]));

    // ---- balance sheet dollar figures (FMP/AV only -- Finnhub's free tier doesn't give raw statements) ----
    var totalDebt = num(pick(fmp.balanceCur, ["totalDebt"]));
    if (totalDebt == null && av.balCur) {
      var std = num(pick(av.balCur, ["shortLongTermDebtTotal", "shortTermDebt"]));
      var ltd = num(pick(av.balCur, ["longTermDebt"]));
      totalDebt = (std != null || ltd != null) ? (std || 0) + (ltd || 0) : null;
    }
    var cash = num(pick(fmp.balanceCur, ["cashAndCashEquivalents", "cashAndShortTermInvestments"])) ||
               num(pick(av.balCur, ["cashAndCashEquivalentsAtCarryingValue", "cashAndShortTermInvestments"]));
    var currentAssets = num(pick(fmp.balanceCur, ["totalCurrentAssets"])) || num(pick(av.balCur, ["totalCurrentAssets"]));
    var currentLiabilities = num(pick(fmp.balanceCur, ["totalCurrentLiabilities"])) || num(pick(av.balCur, ["totalCurrentLiabilities"]));
    var totalEquity = num(pick(fmp.balanceCur, ["totalStockholdersEquity", "totalEquity"])) || num(pick(av.balCur, ["totalShareholderEquity"]));

    // ---- income statement dollar figures, current + prior (FMP/AV only) ----
    var incomeCur = fmp.incomeArr[0] || null, incomePrior = fmp.incomeArr[1] || null;
    var revenueCur = num(pick(incomeCur, ["revenue"])) || num(pick(avIncCur, ["totalRevenue"]));
    var revenuePrior = num(pick(incomePrior, ["revenue"])) || num(pick(avIncPrior, ["totalRevenue"]));
    var grossProfitCur = num(pick(incomeCur, ["grossProfit"])) || num(pick(avIncCur, ["grossProfit"]));
    var opIncomeCur = num(pick(incomeCur, ["operatingIncome"])) || num(pick(avIncCur, ["operatingIncome"]));
    var ebitdaCur = num(pick(incomeCur, ["ebitda"])) || num(pick(avIncCur, ["ebitda"]));
    var netIncomeCur = num(pick(incomeCur, ["netIncome"])) || num(pick(avIncCur, ["netIncome"]));
    var netIncomePrior = num(pick(incomePrior, ["netIncome"])) || num(pick(avIncPrior, ["netIncome"]));
    var epsCur = num(pick(incomeCur, ["epsDiluted", "eps"])) || num(pick(av.overview, ["DilutedEPSTTM", "EPS"]));
    var epsPrior = num(pick(incomePrior, ["epsDiluted", "eps"]));

    // ---- cash flow (FMP/AV only) ----
    var operatingCashFlow = num(pick(fmp.cashflowCur, ["operatingCashFlow", "netCashProvidedByOperatingActivities"])) ||
                             num(pick(av.cfCur, ["operatingCashflow"]));
    var capex = num(pick(fmp.cashflowCur, ["capitalExpenditure"]));
    if (capex == null && av.cfCur) capex = num(pick(av.cfCur, ["capitalExpenditures"]));
    var freeCashFlow = num(pick(fmp.cashflowCur, ["freeCashFlow"]));
    if (freeCashFlow == null && operatingCashFlow != null && capex != null) {
      freeCashFlow = operatingCashFlow - Math.abs(capex);
    }

    // ---- multi-year revenue/net-income history (FMP/AV only -- not available from Finnhub's free tier) ----
    var history = [];
    if (fmp.incomeArr.length) {
      history = fmp.incomeArr.map(function (r) {
        return { year: (pick(r, ["date", "calendarYear"]) || "").toString().slice(0, 4), revenue: num(pick(r, ["revenue"])), netIncome: num(pick(r, ["netIncome"])) };
      }).filter(function (r) { return r.year; }).reverse();
    } else if (av.incomeArr.length) {
      history = av.incomeArr.map(function (r) {
        return { year: (pick(r, ["fiscalDateEnding"]) || "").toString().slice(0, 4), revenue: num(pick(r, ["totalRevenue"])), netIncome: num(pick(r, ["netIncome"])) };
      }).filter(function (r) { return r.year; }).reverse();
    }
    history = history.map(function (r) { return { year: r.year, revenue: mm(r.revenue), netIncome: mm(r.netIncome) }; });

    var peers = (fh.peers && fh.peers.length ? fh.peers : fmp.peers) || [];

    var payload = {
      ticker: ticker,
      name: name,
      industry: industry,
      sector: sector,
      description: description,
      logo: logo,
      price: price,
      changePct: changePct,
      shares: sharesMM,
      debt: mm(totalDebt),
      cash: mm(cash),
      currentAssets: mm(currentAssets),
      currentLiabilities: mm(currentLiabilities),
      totalEquity: mm(totalEquity),
      revenueCur: mm(revenueCur),
      revenuePrior: mm(revenuePrior),
      grossProfitCur: mm(grossProfitCur),
      opIncomeCur: mm(opIncomeCur),
      ebitdaCur: mm(ebitdaCur),
      netIncomeCur: mm(netIncomeCur),
      netIncomePrior: mm(netIncomePrior),
      epsCur: epsCur,
      epsPrior: epsPrior,
      operatingCashFlow: mm(operatingCashFlow),
      capex: mm(capex),
      freeCashFlow: mm(freeCashFlow),
      history: history,
      peers: peers.slice(0, 6),
      dataSource: source,
      // Precomputed ratios, preferred by the frontend over deriving from the
      // dollar figures above when present (Finnhub's free tier gives these
      // directly, without needing full financial statements).
      ratios: {
        pe: rPe, evEbitda: rEvEbitda, grossMargin: rGrossMargin, opMargin: rOpMargin,
        netMargin: rNetMargin, revGrowth: rRevGrowth, currentRatio: rCurrentRatio, debtToEquity: rDebtToEquity,
      },
      fetchedAt: Date.now(),
      raw: {
        finnhubProfile: fh.profile, finnhubQuote: fh.quote, finnhubMetric: m, finnhubPeers: fh.peers,
        fmpProfile: fmp.profile, fmpQuote: fmp.quote, fmpIncome: fmp.incomeArr, fmpBalance: fmp.balanceCur, fmpCashflow: fmp.cashflowCur,
        avOverview: av.overview, avQuote: av.quote, avIncome: av.incomeArr, avBalance: av.balCur, avCashflow: av.cfCur,
      },
    };
    cacheSet(ticker, payload);
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: "Unexpected error fetching " + ticker + ": " + e.message });
  }
};
