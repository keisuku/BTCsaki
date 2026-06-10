// 10 popular signal strategies (GitHub/TradingView favorites) with a uniform contract.
//
// strategy.run(candles, params) -> [{index, side: 'long'|'short'|'exit'}]
//   - 'long'/'short' are entry intents on the SIGNAL candle close; the backtester
//     enters at the NEXT candle open (no lookahead). Opposite signal reverses.
//   - 'exit' closes any open position (used by mean-reversion strategies).
// strategy.grid -> array of param objects to grid-search.
// strategy.overlays(candles, params) -> [{id, color, lineWidth?, dashed?, data:[{time,value}]}]

import {
  sma, ema, rsi, atr, macd, bollinger, keltner, donchian,
  rollingVwap, heikinAshi, supertrend, chandelier, linreg,
} from './indicators.js';

function toLine(candles, values) {
  const data = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null) data.push({ time: candles[i].time, value: values[i] });
  }
  return data;
}

function crossUp(a, b, i) {
  return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null
    && a[i - 1] <= b[i - 1] && a[i] > b[i];
}
function crossDown(a, b, i) {
  return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null
    && a[i - 1] >= b[i - 1] && a[i] < b[i];
}

// ---------------------------------------------------------------- 1. Supertrend
const stSupertrend = {
  id: 'supertrend',
  name: 'Supertrend',
  emoji: '🌀',
  grid: [7, 10, 14].flatMap(period => [2, 3, 4].map(mult => ({ period, mult }))),
  run(candles, p) {
    const { dir } = supertrend(candles, p.period, p.mult);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (dir[i] == null || dir[i - 1] == null) continue;
      if (dir[i] === 1 && dir[i - 1] === -1) sigs.push({ index: i, side: 'long' });
      else if (dir[i] === -1 && dir[i - 1] === 1) sigs.push({ index: i, side: 'short' });
    }
    return sigs;
  },
  overlays(candles, p) {
    const { line } = supertrend(candles, p.period, p.mult);
    return [{ id: 'st', color: '#f0a020', data: toLine(candles, line) }];
  },
};

// ---------------------------------------------------------------- 2. UT Bot Alerts
function utBotStops(candles, keyValue, atrPeriod) {
  const a = atr(candles, atrPeriod);
  const n = candles.length;
  const stop = new Array(n).fill(null);
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const src = candles[i].close;
    const loss = keyValue * a[i];
    let s;
    if (prev == null) s = src - loss;
    else {
      const prevSrc = candles[i - 1].close;
      if (src > prev && prevSrc > prev) s = Math.max(prev, src - loss);
      else if (src < prev && prevSrc < prev) s = Math.min(prev, src + loss);
      else s = src > prev ? src - loss : src + loss;
    }
    stop[i] = s;
    prev = s;
  }
  return stop;
}
const stUtBot = {
  id: 'utbot',
  name: 'UT Bot Alerts',
  emoji: '🤖',
  grid: [1, 2, 3].flatMap(keyValue => [7, 10, 14].map(atrPeriod => ({ keyValue, atrPeriod }))),
  run(candles, p) {
    const stop = utBotStops(candles, p.keyValue, p.atrPeriod);
    const closes = candles.map(c => c.close);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (crossUp(closes, stop, i)) sigs.push({ index: i, side: 'long' });
      else if (crossDown(closes, stop, i)) sigs.push({ index: i, side: 'short' });
    }
    return sigs;
  },
  overlays(candles, p) {
    const stop = utBotStops(candles, p.keyValue, p.atrPeriod);
    return [{ id: 'ut', color: '#e055e0', data: toLine(candles, stop) }];
  },
};

// ------------------------------------------------- 3. Squeeze Momentum (LazyBear)
function squeezeCalc(candles, kcMult, momLen) {
  const closes = candles.map(c => c.close);
  const bb = bollinger(closes, 20, 2);
  const kc = keltner(candles, 20, kcMult);
  const n = candles.length;
  const sqzOn = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (bb.lower[i] == null || kc.lower[i] == null) continue;
    sqzOn[i] = bb.lower[i] > kc.lower[i] && bb.upper[i] < kc.upper[i];
  }
  // momentum: linreg of close - avg(midline of Donchian(momLen), SMA(close,momLen))
  const dc = donchian(candles, momLen);
  const smaC = sma(closes, momLen);
  const diff = closes.map((c, i) =>
    (dc.mid[i] != null && smaC[i] != null) ? c - (dc.mid[i] + smaC[i]) / 2 : null);
  const mom = linreg(diff, momLen);
  return { sqzOn, mom };
}
const stSqueeze = {
  id: 'squeeze',
  name: 'Squeeze Momentum',
  emoji: '🍋',
  grid: [1.5, 2.0].flatMap(kcMult => [12, 20].map(momLen => ({ kcMult, momLen }))),
  run(candles, p) {
    const { sqzOn, mom } = squeezeCalc(candles, p.kcMult, p.momLen);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (sqzOn[i] === false && sqzOn[i - 1] === true && mom[i] != null) {
        sigs.push({ index: i, side: mom[i] > 0 ? 'long' : 'short' });
      }
    }
    return sigs;
  },
  overlays(candles, p) {
    const kc = keltner(candles, 20, p.kcMult);
    return [
      { id: 'kcU', color: '#5577aa', data: toLine(candles, kc.upper) },
      { id: 'kcL', color: '#5577aa', data: toLine(candles, kc.lower) },
    ];
  },
};

// ---------------------------------------------------------------- 4. EMA cross
const stEmaCross = {
  id: 'emacross',
  name: 'EMA Cross',
  emoji: '✂️',
  grid: [[8, 21], [9, 26], [12, 50], [20, 50], [50, 100]].map(([fast, slow]) => ({ fast, slow })),
  run(candles, p) {
    const closes = candles.map(c => c.close);
    const f = ema(closes, p.fast), s = ema(closes, p.slow);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (crossUp(f, s, i)) sigs.push({ index: i, side: 'long' });
      else if (crossDown(f, s, i)) sigs.push({ index: i, side: 'short' });
    }
    return sigs;
  },
  overlays(candles, p) {
    const closes = candles.map(c => c.close);
    return [
      { id: 'emaF', color: '#40c4ff', data: toLine(candles, ema(closes, p.fast)) },
      { id: 'emaS', color: '#ff8a65', data: toLine(candles, ema(closes, p.slow)) },
    ];
  },
};

// ---------------------------------------------------------------- 5. MACD + RSI
const stMacdRsi = {
  id: 'macdrsi',
  name: 'MACD+RSI',
  emoji: '⚡',
  grid: [{ rsiLong: 50, rsiShort: 50 }, { rsiLong: 55, rsiShort: 45 }, { rsiLong: 60, rsiShort: 40 }],
  run(candles, p) {
    const closes = candles.map(c => c.close);
    const m = macd(closes);
    const r = rsi(closes, 14);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (r[i] == null) continue;
      if (crossUp(m.line, m.signal, i) && r[i] > p.rsiLong) sigs.push({ index: i, side: 'long' });
      else if (crossDown(m.line, m.signal, i) && r[i] < p.rsiShort) sigs.push({ index: i, side: 'short' });
    }
    return sigs;
  },
  overlays(candles) {
    const closes = candles.map(c => c.close);
    return [
      { id: 'ema12', color: '#40c4ff', data: toLine(candles, ema(closes, 12)) },
      { id: 'ema26', color: '#ff8a65', data: toLine(candles, ema(closes, 26)) },
    ];
  },
};

// -------------------------------------------------- 6. Bollinger mean-reversion
const stBollinger = {
  id: 'bbrevert',
  name: 'BB逆張り',
  emoji: '🎯',
  grid: [2.0, 2.5, 3.0].map(mult => ({ mult })),
  run(candles, p) {
    const closes = candles.map(c => c.close);
    const bb = bollinger(closes, 20, p.mult);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (bb.lower[i] == null) continue;
      if (crossDown(closes, bb.lower, i)) sigs.push({ index: i, side: 'long' });
      else if (crossUp(closes, bb.upper, i)) sigs.push({ index: i, side: 'short' });
      else if (crossUp(closes, bb.mid, i) || crossDown(closes, bb.mid, i)) {
        sigs.push({ index: i, side: 'exit' });
      }
    }
    return sigs;
  },
  overlays(candles, p) {
    const closes = candles.map(c => c.close);
    const bb = bollinger(closes, 20, p.mult);
    return [
      { id: 'bbU', color: '#7986cb', data: toLine(candles, bb.upper) },
      { id: 'bbM', color: '#7986cb', dashed: true, data: toLine(candles, bb.mid) },
      { id: 'bbL', color: '#7986cb', data: toLine(candles, bb.lower) },
    ];
  },
};

// ---------------------------------------------------------------- 7. VWAP reversion
const VWAP_WINDOW = 96; // rolling bars (~1 day on 15m)
const stVwap = {
  id: 'vwaprevert',
  name: 'VWAP回帰',
  emoji: '🧲',
  grid: [1.5, 2.0, 2.5].map(devMult => ({ devMult })),
  run(candles, p) {
    const { vwap, dev } = rollingVwap(candles, VWAP_WINDOW);
    const closes = candles.map(c => c.close);
    const lower = vwap.map((v, i) => v != null ? v - p.devMult * dev[i] : null);
    const upper = vwap.map((v, i) => v != null ? v + p.devMult * dev[i] : null);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      if (vwap[i] == null) continue;
      if (crossDown(closes, lower, i)) sigs.push({ index: i, side: 'long' });
      else if (crossUp(closes, upper, i)) sigs.push({ index: i, side: 'short' });
      else if (crossUp(closes, vwap, i) || crossDown(closes, vwap, i)) {
        sigs.push({ index: i, side: 'exit' });
      }
    }
    return sigs;
  },
  overlays(candles, p) {
    const { vwap, dev } = rollingVwap(candles, VWAP_WINDOW);
    const lower = vwap.map((v, i) => v != null ? v - p.devMult * dev[i] : null);
    const upper = vwap.map((v, i) => v != null ? v + p.devMult * dev[i] : null);
    return [
      { id: 'vwap', color: '#ffd54f', data: toLine(candles, vwap) },
      { id: 'vwU', color: '#8d6e63', data: toLine(candles, upper) },
      { id: 'vwL', color: '#8d6e63', data: toLine(candles, lower) },
    ];
  },
};

// ---------------------------------------------------------------- 8. Donchian breakout
const stDonchian = {
  id: 'donchian',
  name: 'Donchianブレイク',
  emoji: '🚀',
  grid: [20, 40, 55].map(len => ({ len })),
  run(candles, p) {
    const dc = donchian(candles, p.len);
    const sigs = [];
    for (let i = 1; i < candles.length; i++) {
      // break above/below the channel of the PREVIOUS bar (classic turtle rule)
      if (dc.upper[i - 1] == null) continue;
      const c = candles[i].close;
      if (c > dc.upper[i - 1]) sigs.push({ index: i, side: 'long' });
      else if (c < dc.lower[i - 1]) sigs.push({ index: i, side: 'short' });
    }
    // dedupe consecutive same-side breakouts
    const out = [];
    let last = null;
    for (const s of sigs) {
      if (s.side !== last) out.push(s);
      last = s.side;
    }
    return out;
  },
  overlays(candles, p) {
    const dc = donchian(candles, p.len);
    return [
      { id: 'dcU', color: '#4db6ac', data: toLine(candles, dc.upper) },
      { id: 'dcL', color: '#4db6ac', data: toLine(candles, dc.lower) },
    ];
  },
};

// ---------------------------------------------------------------- 9. Heikin-Ashi trend
const stHeikin = {
  id: 'heikin',
  name: 'Heikin-Ashiトレンド',
  emoji: '🕯️',
  grid: [2, 3].flatMap(consec => [true, false].map(emaFilter => ({ consec, emaFilter }))),
  run(candles, p) {
    const ha = heikinAshi(candles);
    const closes = candles.map(c => c.close);
    const e200 = p.emaFilter ? ema(closes, 200) : null;
    const sigs = [];
    let lastSide = null;
    for (let i = p.consec; i < candles.length; i++) {
      let bulls = 0, bears = 0;
      for (let j = i - p.consec + 1; j <= i; j++) {
        if (ha[j].close > ha[j].open) bulls++;
        else if (ha[j].close < ha[j].open) bears++;
      }
      let side = null;
      if (bulls === p.consec) side = 'long';
      else if (bears === p.consec) side = 'short';
      if (!side || side === lastSide) continue;
      if (e200 && e200[i] != null) {
        if (side === 'long' && closes[i] < e200[i]) continue;
        if (side === 'short' && closes[i] > e200[i]) continue;
      }
      sigs.push({ index: i, side });
      lastSide = side;
    }
    return sigs;
  },
  overlays(candles, p) {
    if (!p.emaFilter) return [];
    const closes = candles.map(c => c.close);
    return [{ id: 'ema200', color: '#90a4ae', data: toLine(candles, ema(closes, 200)) }];
  },
};

// ---------------------------------------------------------------- 10. Chandelier flip
const stChandelier = {
  id: 'chandelier',
  name: 'Chandelier Exit',
  emoji: '💡',
  grid: [2.0, 3.0, 3.5].map(mult => ({ len: 22, mult })),
  run(candles, p) {
    const { longStop, shortStop } = chandelier(candles, p.len, p.mult);
    const sigs = [];
    let trend = null;
    for (let i = 1; i < candles.length; i++) {
      if (longStop[i] == null || shortStop[i] == null) continue;
      const c = candles[i].close;
      if (trend == null) { trend = c > shortStop[i] ? 1 : -1; continue; }
      if (trend === -1 && c > shortStop[i]) {
        trend = 1; sigs.push({ index: i, side: 'long' });
      } else if (trend === 1 && c < longStop[i]) {
        trend = -1; sigs.push({ index: i, side: 'short' });
      }
    }
    return sigs;
  },
  overlays(candles, p) {
    const { longStop, shortStop } = chandelier(candles, p.len, p.mult);
    return [
      { id: 'chL', color: '#66bb6a', dashed: true, data: toLine(candles, longStop) },
      { id: 'chS', color: '#ef5350', dashed: true, data: toLine(candles, shortStop) },
    ];
  },
};

export const STRATEGIES = [
  stSupertrend, stUtBot, stSqueeze, stEmaCross, stMacdRsi,
  stBollinger, stVwap, stDonchian, stHeikin, stChandelier,
];

export function getStrategy(id) {
  return STRATEGIES.find(s => s.id === id) || null;
}

export function paramLabel(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`)
    .join(' ');
}
