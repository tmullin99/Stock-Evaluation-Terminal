// Serverless function: GET /api/company?ticker=AAPL
//
// Runs server-side (Vercel Node.js function), so the FMP_API_KEY never
// reaches the browser and this call is not subject to browser CORS rules.
//
// Data provider: Financial Modeling Prep (financialmodelingprep.com).
// Free-tier signup, no credit card. Field names below follow FMP's
// documented "stable" endpoint schema as of this writing. FMP has
// changed field names across API versions before -- if a field comes
// back undefined, `pick()` tries a short list of known alternates, and
// the response always includes `raw` (the untouched upstream payloads)
// so you can inspect real field names in your browser's dev tools if
// something doesn't map and adjust the `pick(...)` calls below.

const BASE = "https://financialmodelingprep.com/stable";

async function fetchJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error("Upstream returned non-JSON (status " + r.status + "): " + text.slice(0, 200));
  }
  if (!r.ok) {
    const msg = (json && (json.error || json.message)) || ("HTTP " + r.status);
    throw new Error("FMP error: " + msg);
  }
  return json;
}

// Return the first defined value among several possible field names,
// checked against a possibly-array-wrapped payload.
function pick(obj, names) {
  if (!obj) return null;
  var o = Array.isArray(obj) ? obj[0] : obj;
  if (!o) return null;
  for (var i = 0; i < names.length; i++) {
    if (o[names[i]] !== undefined && o[names[i]] !== null) return o[names[i]];
  }
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  var ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "Pass ?ticker=SYMBOL" });
    return;
  }
  var key = process.env.FMP_API_KEY;
  if (!key) {
    res.status(500).json({ error: "Server is missing FMP_API_KEY. Add it as an environment variable in your hosting dashboard (see README) and redeploy." });
    return;
  }

  var q = "symbol=" + encodeURIComponent(ticker) + "&apikey=" + encodeURIComponent(key);

  try {
    var results = await Promise.allSettled([
      fetchJson(BASE + "/profile?" + q),
      fetchJson(BASE + "/quote?" + q),
      fetchJson(BASE + "/income-statement?" + q + "&limit=2"),
      fetchJson(BASE + "/balance-sheet-statement?" + q + "&limit=1"),
      fetchJson(BASE + "/stock-peers?" + q),
    ]);

    var profileRes = results[0], quoteRes = results[1], incomeRes = results[2], balanceRes = results[3], peersRes = results[4];

    if (profileRes.status === "rejected" && quoteRes.status === "rejected") {
      res.status(502).json({ error: "Couldn't reach the data provider for " + ticker + ": " + (profileRes.reason && profileRes.reason.message) });
      return;
    }

    var profile = profileRes.status === "fulfilled" ? profileRes.value : null;
    var quote = quoteRes.status === "fulfilled" ? quoteRes.value : null;
    var income = incomeRes.status === "fulfilled" ? incomeRes.value : null;
    var balance = balanceRes.status === "fulfilled" ? balanceRes.value : null;
    var peersData = peersRes.status === "fulfilled" ? peersRes.value : null;

    var incomeArr = Array.isArray(income) ? income : (income ? [income] : []);
    var incomeCur = incomeArr[0] || null;
    var incomePrior = incomeArr[1] || null;

    var name = pick(profile, ["companyName", "name"]) || pick(quote, ["name"]) || ticker;
    var industry = pick(profile, ["industry"]) || "Unsorted";
    var sector = pick(profile, ["sector"]);
    var price = num(pick(quote, ["price"])) || num(pick(profile, ["price"]));
    var sharesOut = num(pick(quote, ["sharesOutstanding"])) || num(pick(profile, ["sharesOutstanding", "shares"]));
    var marketCapRaw = num(pick(quote, ["marketCap"])) || num(pick(profile, ["mktCap", "marketCap"]));
    // shares outstanding, in millions, derived from market cap / price when not given directly
    var sharesMM = sharesOut ? sharesOut / 1e6 : (marketCapRaw && price ? marketCapRaw / price / 1e6 : null);

    var totalDebt = num(pick(balance, ["totalDebt"]));
    var cash = num(pick(balance, ["cashAndCashEquivalents", "cashAndShortTermInvestments"]));

    var revenueCur = num(pick(incomeCur, ["revenue"]));
    var revenuePrior = num(pick(incomePrior, ["revenue"]));
    var grossProfitCur = num(pick(incomeCur, ["grossProfit"]));
    var opIncomeCur = num(pick(incomeCur, ["operatingIncome"]));
    var ebitdaCur = num(pick(incomeCur, ["ebitda"]));
    var netIncomeCur = num(pick(incomeCur, ["netIncome"]));
    var netIncomePrior = num(pick(incomePrior, ["netIncome"]));
    var epsCur = num(pick(incomeCur, ["epsDiluted", "eps"]));
    var epsPrior = num(pick(incomePrior, ["epsDiluted", "eps"]));

    var peers = [];
    if (Array.isArray(peersData) && peersData[0] && Array.isArray(peersData[0].peersList)) {
      peers = peersData[0].peersList;
    } else if (peersData && Array.isArray(peersData.peersList)) {
      peers = peersData.peersList;
    } else if (Array.isArray(peersData)) {
      peers = peersData.map(function (p) { return (typeof p === "string") ? p : (p && p.symbol); }).filter(Boolean);
    }

    res.status(200).json({
      ticker: ticker,
      name: name,
      industry: industry,
      sector: sector,
      price: price,
      shares: sharesMM, // millions
      debt: totalDebt != null ? totalDebt / 1e6 : null, // millions
      cash: cash != null ? cash / 1e6 : null, // millions
      revenueCur: revenueCur != null ? revenueCur / 1e6 : null,
      revenuePrior: revenuePrior != null ? revenuePrior / 1e6 : null,
      grossProfitCur: grossProfitCur != null ? grossProfitCur / 1e6 : null,
      opIncomeCur: opIncomeCur != null ? opIncomeCur / 1e6 : null,
      ebitdaCur: ebitdaCur != null ? ebitdaCur / 1e6 : null,
      netIncomeCur: netIncomeCur != null ? netIncomeCur / 1e6 : null,
      netIncomePrior: netIncomePrior != null ? netIncomePrior / 1e6 : null,
      epsCur: epsCur,
      epsPrior: epsPrior,
      peers: peers.slice(0, 6),
      fetchedAt: Date.now(),
      raw: { profile: profile, quote: quote, income: incomeArr, balance: balance, peers: peersData },
    });
  } catch (e) {
    res.status(502).json({ error: "Unexpected error fetching " + ticker + ": " + e.message });
  }
};
