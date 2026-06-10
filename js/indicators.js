// Pure indicator functions. Input: candle arrays [{time,open,high,low,close,volume}]
// or numeric arrays. Output: arrays aligned by index, null during warmup.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { seed += values[i]; continue; }
    if (i === period - 1) { prev = (seed + values[i]) / period; }
    else { prev = values[i] * k + prev * (1 - k); }
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  const m = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { out[i] = c.high - c.low; continue; }
    const pc = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return out;
}

// Wilder's ATR.
export function atr(candles, period) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      prev += tr[i] / period;
      if (i === period - 1) out[i] = prev;
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalLen = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  // signal EMA computed over the non-null segment
  const start = line.findIndex(v => v != null);
  const seg = line.slice(start);
  const sigSeg = ema(seg, signalLen);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigSeg.length; i++) signal[start + i] = sigSeg[i];
  const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  return { line, signal, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  const upper = mid.map((m, i) => m != null ? m + mult * sd[i] : null);
  const lower = mid.map((m, i) => m != null ? m - mult * sd[i] : null);
  return { mid, upper, lower, sd };
}

export function keltner(candles, period = 20, mult = 1.5) {
  const closes = candles.map(c => c.close);
  const mid = ema(closes, period);
  const a = atr(candles, period);
  const upper = mid.map((m, i) => (m != null && a[i] != null) ? m + mult * a[i] : null);
  const lower = mid.map((m, i) => (m != null && a[i] != null) ? m - mult * a[i] : null);
  return { mid, upper, lower };
}

export function donchian(candles, period) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  const mid = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi; lower[i] = lo; mid[i] = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

// Rolling VWAP over a fixed window of bars, with stdev bands.
export function rollingVwap(candles, window) {
  const vwap = new Array(candles.length).fill(null);
  const dev = new Array(candles.length).fill(null);
  for (let i = window - 1; i < candles.length; i++) {
    let pv = 0, vol = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      pv += tp * candles[j].volume;
      vol += candles[j].volume;
    }
    if (vol === 0) continue;
    const vw = pv / vol;
    let s = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      s += (tp - vw) ** 2;
    }
    vwap[i] = vw;
    dev[i] = Math.sqrt(s / window);
  }
  return { vwap, dev };
}

// Heikin-Ashi transform — returns HA candle array (same length).
export function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: c.time,
      open: haOpen,
      close: haClose,
      high: Math.max(c.high, haOpen, haClose),
      low: Math.min(c.low, haOpen, haClose),
    });
  }
  return out;
}

// Supertrend: returns { line, dir } where dir[i] = 1 (bullish) | -1 (bearish).
export function supertrend(candles, period, mult) {
  const a = atr(candles, period);
  const n = candles.length;
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(null);
  let upperBand = null, lowerBand = null, trend = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    let ub = hl2 + mult * a[i];
    let lb = hl2 - mult * a[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    if (upperBand != null) {
      ub = (ub < upperBand || prevClose > upperBand) ? ub : upperBand;
      lb = (lb > lowerBand || prevClose < lowerBand) ? lb : lowerBand;
    }
    if (upperBand != null) {
      if (trend === 1 && c.close < lb) trend = -1;
      else if (trend === -1 && c.close > ub) trend = 1;
    }
    upperBand = ub; lowerBand = lb;
    dir[i] = trend;
    line[i] = trend === 1 ? lb : ub;
  }
  return { line, dir };
}

// Chandelier exit stops: longStop = highest(high,len) - mult*ATR, shortStop = lowest(low,len) + mult*ATR.
export function chandelier(candles, period, mult) {
  const a = atr(candles, period);
  const n = candles.length;
  const longStop = new Array(n).fill(null);
  const shortStop = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (a[i] == null) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    longStop[i] = hi - mult * a[i];
    shortStop[i] = lo + mult * a[i];
  }
  return { longStop, shortStop };
}

// Linear regression value at each bar over `period` (endpoint of fitted line),
// used by LazyBear Squeeze Momentum.
export function linreg(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (v == null) { ok = false; break; }
      sx += j; sy += v; sxy += j * v; sxx += j * j;
    }
    if (!ok) continue;
    const slope = (period * sxy - sx * sy) / (period * sxx - sx * sx);
    const intercept = (sy - slope * sx) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}
