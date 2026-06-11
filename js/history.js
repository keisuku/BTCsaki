// BotHistory — external indicator HISTORY for backtesting (funding rate,
// long/short account ratio, Fear & Greed). The live app only has current
// values (S.fr/S.ls/S.fg); these series let the backtester replay the
// sentiment gates of emma/yuki/sentiment-variant bots over the past.
//
// Published as window.BotHistory for classic scripts. All fetchers return
// [{time(sec), value}] sorted ascending; failures resolve to [] (gates then
// see null = neutral, same as before this module existed).

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Funding rate, 8h interval, ~333 days. value = raw rate (e.g. 0.0001).
export async function fetchFundingHistory(pair) {
  try {
    const d = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1000`);
    return d.map(x => ({ time: Math.floor(x.fundingTime / 1000), value: parseFloat(x.fundingRate) }))
      .sort((a, b) => a.time - b.time);
  } catch (e) { return []; }
}

// Global long/short ACCOUNT ratio, max 30 days. value = % accounts long (0-100,
// same scale as S.ls).
export async function fetchLSHistory(pair, period = '1h') {
  try {
    const d = await getJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=${period}&limit=500`);
    return d.map(x => ({ time: Math.floor(x.timestamp / 1000), value: parseFloat(x.longAccount) * 100 }))
      .sort((a, b) => a.time - b.time);
  } catch (e) { return []; }
}

// Fear & Greed, daily, full history. value = 0-100 (same scale as S.fg).
export async function fetchFGHistory() {
  try {
    const d = await getJson('https://api.alternative.me/fng/?limit=0');
    return (d.data || []).map(x => ({ time: parseInt(x.timestamp), value: parseInt(x.value) }))
      .sort((a, b) => a.time - b.time);
  } catch (e) { return []; }
}

// Step-function alignment: for each candle, the latest point with
// point.time <= candle.time (null before the first point). O(n+m).
export function alignSeries(candles, points) {
  const out = new Array(candles.length).fill(null);
  if (!points || !points.length) return out;
  let j = 0, cur = null;
  for (let i = 0; i < candles.length; i++) {
    while (j < points.length && points[j].time <= candles[i].time) { cur = points[j].value; j++; }
    out[i] = cur;
  }
  return out;
}

// Fetch all three for a coin pair. Returns { fr, ls, fg } point arrays.
export async function fetchAll(pair) {
  const [fr, ls, fg] = await Promise.all([
    fetchFundingHistory(pair), fetchLSHistory(pair), fetchFGHistory(),
  ]);
  return { fr, ls, fg };
}

if (typeof window !== 'undefined') {
  window.BotHistory = { fetchFundingHistory, fetchLSHistory, fetchFGHistory, fetchAll, alignSeries };
  window.dispatchEvent(new Event('bothistory-ready'));
  console.log('[BotHistory] ready — funding/L&S/F&G履歴をバックテストに供給可能');
}
