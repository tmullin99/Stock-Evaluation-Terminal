// Serverless function: GET /api/company?ticker=AAPL
//
// Runs server-side (Vercel Node.js function), so API keys never reach the
// browser and this call is not subject to browser CORS rules.
//
// Two data sources, tried in order:
//   1. Financial Modeling Prep (FMP_API_KEY) -- strong coverage for
//      large/mid caps, thin coverage for small caps on the free tier.
//   2. Alpha Vantage (ALPHA_VANTAGE_API_KEY, optional) -- used only to
//      fill in whatever FMP left empty. Get a free key at
//      alphavantage.co/support/#api-key (no signup form, just an email).
//      Free tier is rate-limited (historically ~25-500 requests/day
//      depending on when you signed up), so this is a fallback, not the
//      primary source.
//
// Field names for both providers are well-documented and have been
// stable for years, EXCEPT FMP's stable-tier renaming, which this file
// has already been adjusted for once. `pick()` tries a short list of
// known alternates per field, and the response always includes `raw`
// (the untouched upstream payloads) so a field-name drift can be
// diagnosed from your browser's Network tab without guessing.

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
    // Surface FMP's actual error body (it usually explains *why*: bad key,
    // plan doesn't cover this endpoint, rate limit, etc.) instead of just
    // the HTTP status, since that's what actually tells you what to fix.
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

function mm(v) { return v == null ? null : v / 1e6; }

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  var ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "Pass ?ticker=SYMBOL" });
    return;
  }
  var fmpKey = process.env.FMP_API_KEY;
  var avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!fmpKey) {
    res.status(500).json({ error: "Server is missing FMP_API_KEY. Add it as an environment variable in your hosting dashboard and redeploy." });
    return;
  }

  var cached = cacheGet(ticker);
  if (cached) {
    res.status(200).json(cached);
    return;
  }

  var q = "symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(fmpKey);

  try {
    var fmpResults = await Promise.allSettled([
      fetchJson(FMP_BASE + "/profile?" + q, "FMP profile"),
      fetchJson(FMP_BASE + "/quote?" + q, "FMP quote"),
      fetchJson(FMP_BASE + "/income-statement?" + q + "&limit=5", "FMP income"),
      fetchJson(FMP_BASE + "/balance-sheet-statement?" + q + "&limit=1", "FMP balance"),
      fetchJson(FMP_BASE + "/cash-flow-statement?" + q + "&limit=1", "FMP cash flow"),
      fetchJson(FMP_BASE + "/stock-peers?" + q, "FMP peers"),
    ]);
    var val = function (r) { return r.status === "fulfilled" ? r.value : null; };
    var profile = val(fmpResults[0]);
    var quote = val(fmpResults[1]);
    var income = val(fmpResults[2]);
    var balance = val(fmpResults[3]);
    var cashflow = val(fmpResults[4]);
    var peersData = val(fmpResults[5]);

    var incomeArr = Array.isArray(income) ? income : (income ? [income] : []);
    var balanceArr = Array.isArray(balance) ? balance : (balance ? [balance] : []);
    var cashflowArr = Array.isArray(cashflow) ? cashflow : (cashflow ? [cashflow] : []);
    var incomeCur = incomeArr[0] || null;
    var incomePrior = incomeArr[1] || null;
    var balanceCur = balanceArr[0] || null;
    var cashflowCur = cashflowArr[0] || null;

    var source = { quote: quote ? "fmp" : "none", financials: incomeArr.length ? "fmp" : "none", cashflow: cashflowCur ? "fmp" : "none" };

    // ---- Alpha Vantage fallback for whatever FMP left empty ----
    // Important: this has to run even when FMP came back with NOTHING at all
    // (e.g. its daily quota is exhausted, or the key is bad) -- that's
    // exactly the moment a fallback is for. An earlier version of this file
    // gave up before ever trying Alpha Vantage in that case.
    var avOverview = null, avQuote = null, avIncome = null, avBalance = null, avCashflow = null;
    var needsFallback = !profile || !quote || !incomeArr.length || !balanceCur || !cashflowCur;
    if (needsFallback && avKey) {
      var avq = "symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(avKey);
      var avResults = await Promise.allSettled([
        (!profile) ? fetchJson(AV_BASE + "?function=OVERVIEW&" + avq, "Alpha Vantage overview") : Promise.resolve(null),
        (!quote) ? fetchJson(AV_BASE + "?function=GLOBAL_QUOTE&" + avq, "Alpha Vantage quote") : Promise.resolve(null),
        (!incomeArr.length) ? fetchJson(AV_BASE + "?function=INCOME_STATEMENT&" + avq, "Alpha Vantage income") : Promise.resolve(null),
        (!balanceCur) ? fetchJson(AV_BASE + "?function=BALANCE_SHEET&" + avq, "Alpha Vantage balance") : Promise.resolve(null),
        (!cashflowCur) ? fetchJson(AV_BASE + "?function=CASH_FLOW&" + avq, "Alpha Vantage cash flow") : Promise.resolve(null),
      ]);
      avOverview = avResults[0].status === "fulfilled" ? avResults[0].value : null;
      avQuote = avResults[1].status === "fulfilled" ? avResults[1].value : null;
      avIncome = avResults[2].status === "fulfilled" ? avResults[2].value : null;
      avBalance = avResults[3].status === "fulfilled" ? avResults[3].value : null;
      avCashflow = avResults[4].status === "fulfilled" ? avResults[4].value : null;
      if (avQuote) source.quote = "alphavantage";
      if (avIncome && avIncome.annualReports && avIncome.annualReports.length) source.financials = "alphavantage";
      if (avCashflow && avCashflow.annualReports && avCashflow.annualReports.length) source.cashflow = "alphavantage";
    }

    // Only now, after BOTH providers have had a real shot, give up -- and
    // say exactly what each one said, so the actual cause (bad key, plan
    // doesn't cover this endpoint, quota hit) is visible instead of guessed at.
    if (!profile && !quote && !avOverview && !avQuote) {
      var fmpProfileErr = fmpResults[0].status === "rejected" ? fmpResults[0].reason.message : "no data";
      var fmpQuoteErr = fmpResults[1].status === "rejected" ? fmpResults[1].reason.message : "no data";
      var avNote = avKey ? "" : " Alpha Vantage key isn't set, so there was no fallback to try.";
      res.status(502).json({
        error: "Couldn't get data for " + ticker + " from either provider. FMP profile: " + fmpProfileErr + ". FMP quote: " + fmpQuoteErr + "." + avNote
          + " This is almost always an API key or quota problem on the provider's side, not a bug in this app -- check your FMP dashboard's usage/plan page.",
      });
      return;
    }

    var avIncomeArr = (avIncome && avIncome.annualReports) || [];
    var avBalanceArr = (avBalance && avBalance.annualReports) || [];
    var avCashflowArr = (avCashflow && avCashflow.annualReports) || [];
    var avGlobalQuote = avQuote && avQuote["Global Quote"];

    // ---- core identity fields ----
    var name = pick(profile, ["companyName", "name"]) || pick(avOverview, ["Name"]) || ticker;
    var industry = pick(profile, ["industry"]) || pick(avOverview, ["Industry"]) || "Unsorted";
    var sector = pick(profile, ["sector"]) || pick(avOverview, ["Sector"]);
    var description = pick(profile, ["description"]) || pick(avOverview, ["Description"]);
    var logo = pick(profile, ["image"]);

    var price = num(pick(quote, ["price"])) || num(pick(profile, ["price"])) ||
                num(pick(avGlobalQuote, ["05. price"])) || num(pick(avOverview, ["AnalystTargetPrice"]));
    var changePct = num(pick(quote, ["changePercentage"]));
    if (changePct == null && avGlobalQuote) {
      var avChangePct = pick(avGlobalQuote, ["10. change percent"]);
      if (avChangePct) changePct = num(String(avChangePct).replace("%", ""));
    }
    var sharesOut = num(pick(quote, ["sharesOutstanding"])) || num(pick(profile, ["sharesOutstanding", "shares"])) ||
                    num(pick(avOverview, ["SharesOutstanding"]));
    var marketCapRaw = num(pick(quote, ["marketCap"])) || num(pick(profile, ["mktCap", "marketCap"])) ||
                        num(pick(avOverview, ["MarketCapitalization"]));
    var sharesMM = sharesOut ? sharesOut / 1e6 : (marketCapRaw && price ? marketCapRaw / price / 1e6 : null);

    // ---- balance sheet (fill any missing piece from AV's most recent annual report) ----
    var avBalCur = avBalanceArr[0] || null;
    var totalDebt = num(pick(balanceCur, ["totalDebt"]));
    if (totalDebt == null && avBalCur) {
      var std = num(pick(avBalCur, ["shortLongTermDebtTotal", "shortTermDebt"]));
      var ltd = num(pick(avBalCur, ["longTermDebt"]));
      totalDebt = (std != null || ltd != null) ? (std || 0) + (ltd || 0) : null;
    }
    var cash = num(pick(balanceCur, ["cashAndCashEquivalents", "cashAndShortTermInvestments"])) ||
               num(pick(avBalCur, ["cashAndCashEquivalentsAtCarryingValue", "cashAndShortTermInvestments"]));
    var currentAssets = num(pick(balanceCur, ["totalCurrentAssets"])) || num(pick(avBalCur, ["totalCurrentAssets"]));
    var currentLiabilities = num(pick(balanceCur, ["totalCurrentLiabilities"])) || num(pick(avBalCur, ["totalCurrentLiabilities"]));
    var totalEquity = num(pick(balanceCur, ["totalStockholdersEquity", "totalEquity"])) || num(pick(avBalCur, ["totalShareholderEquity"]));

    // ---- income statement, current + prior ----
    var avIncCur = avIncomeArr[0] || null, avIncPrior = avIncomeArr[1] || null;
    var revenueCur = num(pick(incomeCur, ["revenue"])) || num(pick(avIncCur, ["totalRevenue"]));
    var revenuePrior = num(pick(incomePrior, ["revenue"])) || num(pick(avIncPrior, ["totalRevenue"]));
    var grossProfitCur = num(pick(incomeCur, ["grossProfit"])) || num(pick(avIncCur, ["grossProfit"]));
    var opIncomeCur = num(pick(incomeCur, ["operatingIncome"])) || num(pick(avIncCur, ["operatingIncome"]));
    var ebitdaCur = num(pick(incomeCur, ["ebitda"])) || num(pick(avIncCur, ["ebitda"]));
    var netIncomeCur = num(pick(incomeCur, ["netIncome"])) || num(pick(avIncCur, ["netIncome"]));
    var netIncomePrior = num(pick(incomePrior, ["netIncome"])) || num(pick(avIncPrior, ["netIncome"]));
    var epsCur = num(pick(incomeCur, ["epsDiluted", "eps"])) || num(pick(avOverview, ["DilutedEPSTTM", "EPS"]));
    var epsPrior = num(pick(incomePrior, ["epsDiluted", "eps"]));

    // ---- cash flow (for free cash flow / quality-of-earnings) ----
    var avCfCur = avCashflowArr[0] || null;
    var operatingCashFlow = num(pick(cashflowCur, ["operatingCashFlow", "netCashProvidedByOperatingActivities"])) ||
                             num(pick(avCfCur, ["operatingCashflow"]));
    var capex = num(pick(cashflowCur, ["capitalExpenditure"]));
    if (capex == null && avCfCur) capex = num(pick(avCfCur, ["capitalExpenditures"]));
    var freeCashFlow = num(pick(cashflowCur, ["freeCashFlow"]));
    if (freeCashFlow == null && operatingCashFlow != null && capex != null) {
      freeCashFlow = operatingCashFlow - Math.abs(capex);
    }

    // ---- multi-year revenue/net-income history, oldest to newest ----
    var history = [];
    if (incomeArr.length) {
      history = incomeArr.map(function (r) {
        return { year: (pick(r, ["date", "calendarYear"]) || "").toString().slice(0, 4), revenue: num(pick(r, ["revenue"])), netIncome: num(pick(r, ["netIncome"])) };
      }).filter(function (r) { return r.year; }).reverse();
    } else if (avIncomeArr.length) {
      history = avIncomeArr.map(function (r) {
        return { year: (pick(r, ["fiscalDateEnding"]) || "").toString().slice(0, 4), revenue: num(pick(r, ["totalRevenue"])), netIncome: num(pick(r, ["netIncome"])) };
      }).filter(function (r) { return r.year; }).reverse();
    }
    history = history.map(function (r) { return { year: r.year, revenue: mm(r.revenue), netIncome: mm(r.netIncome) }; });

    var peers = [];
    if (Array.isArray(peersData) && peersData[0] && Array.isArray(peersData[0].peersList)) {
      peers = peersData[0].peersList;
    } else if (peersData && Array.isArray(peersData.peersList)) {
      peers = peersData.peersList;
    } else if (Array.isArray(peersData)) {
      peers = peersData.map(function (p) { return (typeof p === "string") ? p : (p && p.symbol); }).filter(Boolean);
    }

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
      fetchedAt: Date.now(),
      raw: { profile: profile, quote: quote, income: incomeArr, balance: balanceCur, cashflow: cashflowCur, peers: peersData, avOverview: avOverview, avQuote: avQuote, avIncome: avIncomeArr, avBalance: avBalCur, avCashflow: avCfCur },
    };
    cacheSet(ticker, payload);
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: "Unexpected error fetching " + ticker + ": " + e.message });
  }
};
