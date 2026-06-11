/**
 * mock-api.mjs — Deterministic mock responses for BTCsaki external APIs.
 *
 * Exports:
 *   genKlines(symbol, interval, limit, endTime?)  → array of kline arrays
 *   route(url)  → { status, contentType, body } | null
 */

// ── Deterministic seeded PRNG (mulberry32) ──────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ── Price scales per base asset ─────────────────────────────────────────────
const PRICE_SCALES = {
  BTC: 60000,
  ETH: 3000,
  XRP: 2,
  SOL: 150,
};

function basePrice(symbol) {
  for (const [k, v] of Object.entries(PRICE_SCALES)) {
    if (symbol.startsWith(k)) return v;
  }
  return 100;
}

// ── Interval → ms ───────────────────────────────────────────────────────────
const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
  '6h': 21600000, '8h': 28800000, '12h': 43200000,
  '1d': 86400000, '3d': 259200000, '1w': 604800000,
};

// ── Kline cache so overlapping calls return consistent data ─────────────────
const KLINE_CACHE = new Map();

/**
 * Generate a realistic kline array for (symbol, interval).
 * Returns the last `limit` candles, anchored to a fixed endTime.
 */
export function genKlines(symbol, interval, limit, endTime = 1748736000000 /* 2025-06-01 00:00 UTC */) {
  const key = `${symbol}:${interval}`;
  // We always generate enough bars to cover any limit up to 1500
  const TOTAL = 1500;

  if (!KLINE_CACHE.has(key)) {
    const seed = hashStr(key);
    const rng = mulberry32(seed);
    const base = basePrice(symbol);
    const iMs = INTERVAL_MS[interval] || 300000;

    // Regime cycle: alternate trend/range blocks
    const regimePeriod = Math.floor(120 + rng() * 200); // bars per regime
    let regime = rng() > 0.5 ? 'trend' : 'range';
    let regimeBar = 0;
    let trendDir = rng() > 0.5 ? 1 : -1;

    let price = base;
    const bars = [];

    for (let i = 0; i < TOTAL; i++) {
      // Regime switch
      if (regimeBar >= regimePeriod) {
        regimeBar = 0;
        regime = regime === 'trend' ? 'range' : 'trend';
        if (regime === 'trend') trendDir = rng() > 0.5 ? 1 : -1;
      }
      regimeBar++;

      // Price move
      let drift = 0;
      let vol = 0;
      if (regime === 'trend') {
        drift = trendDir * (rng() * 0.0012 + 0.0001);
        vol = rng() * 0.006 + 0.002;
      } else {
        drift = (rng() - 0.5) * 0.0004;
        vol = rng() * 0.003 + 0.001;
      }

      const open = price;
      const close = open * (1 + drift + (rng() - 0.5) * vol);
      const high = Math.max(open, close) * (1 + rng() * vol * 0.6);
      const low = Math.min(open, close) * (1 - rng() * vol * 0.6);

      // Volume with occasional surges
      const baseVol = base * 0.8 + rng() * base * 0.5;
      const surge = rng() > 0.93 ? 3 + rng() * 5 : 1;
      const volume = baseVol * surge;
      const quoteVol = volume * (open + close) / 2;
      const takerBuyPct = 0.35 + rng() * 0.30; // 35–65%
      const takerBuyBase = volume * takerBuyPct;
      const takerBuyQuote = quoteVol * takerBuyPct;
      const trades = Math.floor(1000 + rng() * 4000) * (surge > 1 ? 2 : 1);

      const openTime = endTime - (TOTAL - i) * iMs;
      const closeTime = openTime + iMs - 1;

      bars.push([
        openTime,                             // 0: openTime
        open.toFixed(2),                      // 1: open
        high.toFixed(2),                      // 2: high
        low.toFixed(2),                       // 3: low
        close.toFixed(2),                     // 4: close
        volume.toFixed(3),                    // 5: volume
        closeTime,                            // 6: closeTime
        quoteVol.toFixed(2),                  // 7: quoteAssetVolume
        trades,                               // 8: numberOfTrades
        takerBuyBase.toFixed(3),              // 9: takerBuyBaseAssetVolume
        takerBuyQuote.toFixed(2),             // 10: takerBuyQuoteAssetVolume
        '0',                                  // 11: ignore
      ]);

      price = close;
    }

    KLINE_CACHE.set(key, bars);
  }

  const all = KLINE_CACHE.get(key);
  return all.slice(Math.max(0, all.length - limit));
}

// ── Helper: last kline close price for a symbol ─────────────────────────────
function lastClose(symbol) {
  const bars = genKlines(symbol, '5m', 2);
  return parseFloat(bars[bars.length - 1][4]);
}

// ── Route dispatcher ─────────────────────────────────────────────────────────
/**
 * Given a URL string, return { status, contentType, body } or null.
 * null means "I don't handle this URL".
 */
export function route(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }

  const host = parsed.hostname;
  const path = parsed.pathname;
  const sp = parsed.searchParams;

  // ── api.binance.com ───────────────────────────────────────────────────────
  if (host === 'api.binance.com') {
    // GET /api/v3/klines
    if (path === '/api/v3/klines') {
      const symbol = sp.get('symbol') || 'BTCUSDT';
      const interval = sp.get('interval') || '5m';
      const limit = Math.min(parseInt(sp.get('limit') || '100'), 1500);
      const data = genKlines(symbol, interval, limit);
      return json(data);
    }

    // GET /api/v3/ticker/24hr
    if (path === '/api/v3/ticker/24hr') {
      const symbol = sp.get('symbol') || 'BTCUSDT';
      const price = lastClose(symbol);
      const open = price * (0.97 + Math.random() * 0.06);
      const pctChg = ((price - open) / open * 100).toFixed(2);
      const data = {
        symbol,
        priceChange: (price - open).toFixed(2),
        priceChangePercent: pctChg,
        weightedAvgPrice: ((price + open) / 2).toFixed(2),
        prevClosePrice: open.toFixed(2),
        lastPrice: price.toFixed(2),
        lastQty: '0.100',
        bidPrice: (price * 0.9999).toFixed(2),
        bidQty: '1.000',
        askPrice: (price * 1.0001).toFixed(2),
        askQty: '1.000',
        openPrice: open.toFixed(2),
        highPrice: (price * 1.02).toFixed(2),
        lowPrice: (price * 0.98).toFixed(2),
        volume: (1000 + Math.random() * 5000).toFixed(3),
        quoteVolume: (price * 3000).toFixed(2),
        openTime: Date.now() - 86400000,
        closeTime: Date.now(),
        firstId: 100000,
        lastId: 200000,
        count: 100000,
      };
      return json(data);
    }

    // Fallthrough — handled by catch-all below
    return json({});
  }

  // ── fapi.binance.com ──────────────────────────────────────────────────────
  if (host === 'fapi.binance.com') {
    const symbol = sp.get('symbol') || 'BTCUSDT';

    // /fapi/v1/fundingRate
    if (path === '/fapi/v1/fundingRate') {
      const limit = parseInt(sp.get('limit') || '1');
      const now = Date.now();
      const items = [];
      for (let i = 0; i < Math.min(limit, 1000); i++) {
        items.push({
          symbol,
          fundingTime: now - i * 8 * 3600000,
          fundingRate: (0.0001 + (Math.random() - 0.5) * 0.0003).toFixed(8),
        });
      }
      return json(items);
    }

    // /futures/data/globalLongShortAccountRatio
    if (path === '/futures/data/globalLongShortAccountRatio') {
      const limit = parseInt(sp.get('limit') || '1');
      const now = Date.now();
      const items = [];
      for (let i = 0; i < Math.min(limit, 500); i++) {
        const r = 0.8 + Math.random() * 0.4; // ratio in 0.8–1.2
        const longPct = r / (1 + r);
        items.push({
          symbol,
          longAccount: longPct.toFixed(4),
          shortAccount: (1 - longPct).toFixed(4),
          longShortRatio: r.toFixed(4),
          timestamp: now - i * 5 * 60000,
        });
      }
      return json(items);
    }

    // /fapi/v1/openInterest
    if (path === '/fapi/v1/openInterest') {
      const price = lastClose(symbol);
      return json({
        symbol,
        openInterest: (price * (10000 + Math.random() * 5000)).toFixed(0),
        time: Date.now(),
      });
    }

    // /fapi/v1/ticker/price
    if (path === '/fapi/v1/ticker/price') {
      const price = lastClose(symbol);
      return json({ symbol, price: price.toFixed(2), time: Date.now() });
    }

    // Other futures/* endpoints
    return json([]);
  }

  // ── api.alternative.me ────────────────────────────────────────────────────
  if (host === 'api.alternative.me') {
    if (path === '/fng/') {
      const limit = parseInt(sp.get('limit') || '1');
      const count = limit === 0 ? 30 : Math.min(limit, 30);
      const classifications = ['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'];
      const data = [];
      for (let i = 0; i < count; i++) {
        const val = 20 + Math.floor(Math.random() * 60);
        const cls = val < 25 ? 'Extreme Fear' : val < 46 ? 'Fear' : val < 55 ? 'Neutral' : val < 75 ? 'Greed' : 'Extreme Greed';
        data.push({
          value: String(val),
          value_classification: cls,
          timestamp: String(Math.floor((Date.now() - i * 86400000) / 1000)),
          time_until_update: i === 0 ? '86400' : undefined,
        });
      }
      return json({ name: 'Fear and Greed Index', data, metadata: { error: null } });
    }
    return json({});
  }

  // ── open.er-api.com ───────────────────────────────────────────────────────
  if (host === 'open.er-api.com') {
    return json({
      result: 'success',
      provider: 'https://www.exchangerate-api.com',
      documentation: 'https://www.exchangerate-api.com/docs/free',
      terms_of_use: 'https://www.exchangerate-api.com/terms',
      time_last_update_unix: Math.floor(Date.now() / 1000),
      time_last_update_utc: new Date().toUTCString(),
      time_next_update_unix: Math.floor(Date.now() / 1000) + 86400,
      time_next_update_utc: new Date(Date.now() + 86400000).toUTCString(),
      time_eol_unix: 0,
      base_code: 'USD',
      rates: {
        USD: 1, EUR: 0.92, GBP: 0.79, JPY: 155.2, AUD: 1.53, CAD: 1.37,
        CHF: 0.90, CNY: 7.25, HKD: 7.82, KRW: 1340.0, SGD: 1.35,
        THB: 36.5, MXN: 17.2, NOK: 10.6, SEK: 10.4, DKK: 6.9,
        NZD: 1.63, INR: 83.2, BRL: 5.1, ZAR: 18.7, TRY: 32.1,
        AED: 3.67, SAR: 3.75, MYR: 4.72, IDR: 15800,
      },
    });
  }

  // ── corsproxy.io (proxy for fapi calls) ───────────────────────────────────
  if (host === 'corsproxy.io') {
    // Extract original URL from query param
    const inner = decodeURIComponent(sp.get('url') || '') || decodeURIComponent(parsed.search.slice(1));
    if (inner) {
      const r = route(inner);
      if (r) return r;
    }
    return json([]);
  }

  // ── s3.tradingview.com / cdn / fonts ─────────────────────────────────────
  if (host.includes('tradingview.com')) {
    // Return minimal empty JS so the script tag loads without error
    return { status: 200, contentType: 'application/javascript', body: '/* tradingview stub */\nwindow.TradingView = window.TradingView || { widget: function(){} };' };
  }

  if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
    return { status: 200, contentType: 'text/css', body: '/* font stub */' };
  }

  // ── api.rss2json.com ──────────────────────────────────────────────────────
  if (host === 'api.rss2json.com') {
    return json({ status: 'ok', feed: {}, items: [] });
  }

  // ── stream.binance.com (WebSocket upgrade attempt via HTTP) ───────────────
  if (host === 'stream.binance.com') {
    return json({});
  }

  // Not matched — return null to trigger catch-all in e2e.mjs
  return null;
}

// ── Helper ───────────────────────────────────────────────────────────────────
function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}
