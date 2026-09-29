// Serverless function: GET /api/movers
//
// Powers the always-on "Market Snapshot" strip so the dashboard is
// informative before anyone types a ticker -- called on every page load,
// not just a visitor's first visit. Returns price/change/volume directly
// from Alpha Vantage's own top-gainers payload, so the frontend never has
// to spend extra /api/company (FMP+AV) calls just to show this.
//
// Cached for 3 minutes across a warm serverless instance: this endpoint is
// now called far more often than before, and top-movers data doesn't need
// to be second-by-second fresh, so caching keeps it off the same daily
// quota that /api/company depends on.

var CACHE = null;
var CACHE_AT = 0;
var CACHE_TTL_MS = 3 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (CACHE && Date.now() - CACHE_AT < CACHE_TTL_MS) {
    res.status(200).json(CACHE);
    return;
  }
  var avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) {
    res.status(500).json({ error: "Server is missing ALPHA_VANTAGE_API_KEY, which powers the market snapshot." });
    return;
  }
  try {
    var url = "https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=" + encodeURIComponent(avKey);
    var r = await fetch(url);
    var json = await r.json();
    if (json.Note || json.Information) {
      res.status(429).json({ error: "Alpha Vantage rate limit reached: " + (json.Note || json.Information) });
      return;
    }
    var shape = function (list) {
      return (Array.isArray(list) ? list : []).slice(0, 5).map(function (g) {
        return {
          ticker: g.ticker,
          price: num(g.price),
          changePct: num(String(g.change_percentage || "").replace("%", "")),
          volume: num(g.volume),
        };
      }).filter(function (g) { return g.ticker; });
    };
    var payload = {
      gainers: shape(json.top_gainers),
      losers: shape(json.top_losers),
      updatedAt: json.last_updated || null,
      fetchedAt: Date.now(),
    };
    CACHE = payload; CACHE_AT = Date.now();
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: "Couldn't fetch market movers: " + e.message });
  }
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}
