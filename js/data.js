// Binance public REST + alternative.me Fear & Greed. No API keys required.

const BINANCE = 'https://api.binance.com';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Returns [{time(sec), open, high, low, close, volume}], oldest first.
export async function fetchKlines(symbol, interval, limit = 1500) {
  const raw = await getJson(
    `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

// Returns { price, changePct }.
export async function fetchTicker(symbol) {
  const t = await getJson(`${BINANCE}/api/v3/ticker/24hr?symbol=${symbol}`);
  return { price: +t.lastPrice, changePct: +t.priceChangePercent };
}

// Fear & Greed index (display only). Returns { value, label } or null.
export async function fetchFearGreed() {
  try {
    const d = await getJson('https://api.alternative.me/fng/?limit=1');
    const e = d.data && d.data[0];
    return e ? { value: +e.value, label: e.value_classification } : null;
  } catch {
    return null;
  }
}
