// Serverless function: GET /api/news?ticker=AAPL
//
// On-demand only (the frontend calls this when you click "Load news" on a
// card, not automatically) because Alpha Vantage's free tier has a low
// daily request cap -- fetching news for every tracked company on every
// page load would burn through it fast.

const AV_BASE = "https://www.alphavantage.co/query";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  var ticker = String(req.query.ticker || "").trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "Pass ?ticker=SYMBOL" });
    return;
  }
  var avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) {
    res.status(500).json({ error: "Server is missing ALPHA_VANTAGE_API_KEY. Add it as an environment variable to enable news." });
    return;
  }
  try {
    var url = AV_BASE + "?function=NEWS_SENTIMENT&tickers=" + encodeURIComponent(ticker) + "&limit=8&apikey=" + encodeURIComponent(avKey);
    var r = await fetch(url);
    var json = await r.json();
    if (json.Note || json.Information) {
      res.status(429).json({ error: "Alpha Vantage rate limit reached: " + (json.Note || json.Information) });
      return;
    }
    var feed = Array.isArray(json.feed) ? json.feed : [];
    var items = feed.slice(0, 6).map(function (item) {
      var tickerSentiment = (item.ticker_sentiment || []).find(function (t) { return t.ticker === ticker; });
      return {
        title: item.title,
        url: item.url,
        source: item.source,
        timePublished: item.time_published,
        summary: item.summary,
        sentimentLabel: (tickerSentiment && tickerSentiment.ticker_sentiment_label) || item.overall_sentiment_label,
        sentimentScore: num((tickerSentiment && tickerSentiment.ticker_sentiment_score) || item.overall_sentiment_score),
      };
    });
    res.status(200).json({ ticker: ticker, items: items });
  } catch (e) {
    res.status(502).json({ error: "Couldn't fetch news for " + ticker + ": " + e.message });
  }
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}
