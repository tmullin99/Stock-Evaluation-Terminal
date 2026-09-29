// Serverless function: GET /api/movers
//
// Returns today's top gaining tickers so the dashboard isn't empty on a
// fresh visit. Called once per browser (gated client-side by a localStorage
// flag), not on every page load.

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  var avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) {
    res.status(500).json({ error: "Server is missing ALPHA_VANTAGE_API_KEY, which powers the market-movers list." });
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
    var gainers = Array.isArray(json.top_gainers) ? json.top_gainers : [];
    var tickers = gainers.slice(0, 5).map(function (g) { return g.ticker; }).filter(Boolean);
    res.status(200).json({ tickers: tickers });
  } catch (e) {
    res.status(502).json({ error: "Couldn't fetch market movers: " + e.message });
  }
};
