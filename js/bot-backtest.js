// BotBacktest — instant historical evaluation of the cockpit bots' parameters.
//
// Replicates the PRICE-COMPUTABLE subset of index.html's computeTF() score
// (RSI w/ adaptive thresholds, SMA trend, simplified perfect order, MACD, BB,
// session VWAP, taker delta) as a causal series over historical klines, then
// simulates each bot's style + params with js/backtest.js. Funding rate,
// L/S ratio and Fear&Greed are omitted (no cheap history) — fitness only
// needs to RANK parameter sets, not replay live trades exactly.
//
// Published as window.BotBacktest for the classic scripts (evolution-boost.js,
// cockpit-plus.js). Fires 'botbacktest-ready' on window when loaded.

import { sma, ema, rsi as rsiSeries, macd as macdSeries, bollinger, atr as atrSeries } from './indicators.js';
import { backtest } from './backtest.js';
import { alignSeries } from './history.js';

const TF_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
const FAST_TF = { '1m': 1, '3m': 1, '5m': 1, '15m': 1 };
const TRW = { '1m': 0.2, '3m': 0.3, '5m': 0.4, '15m': 0.55, '1h': 0.7, '4h': 1.0, '1d': 1.0 };

// Binance raw kline array -> candle objects (takerBuy = k[9]).
export function toCandles(rawKlines) {
  return rawKlines.map(k => ({
    time: Math.floor(parseInt(k[0]) / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    takerBuy: +k[9] || 0,
  }));
}

// Causal per-bar session VWAP (UTC daily anchor, like calcVWAP).
function sessionVwap(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null, cumTP = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.time / 86400);
    if (d !== day) { day = d; cumTP = 0; cumVol = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    cumTP += tp * c.volume; cumVol += c.volume;
    out[i] = cumVol > 0 ? cumTP / cumVol : null;
  }
  return out;
}

// Taker delta over last 10 bars: (2*takerBuy - vol) / vol  (mirrors calcDelta).
function takerDelta(candles, window = 10) {
  const out = new Array(candles.length).fill(0);
  for (let i = window - 1; i < candles.length; i++) {
    let buy = 0, vol = 0;
    for (let j = i - window + 1; j <= i; j++) { buy += candles[j].takerBuy; vol += candles[j].volume; }
    out[i] = vol > 0 ? (2 * buy - vol) / vol : 0;
  }
  return out;
}

// Causal composite score series — same bull/bear weights and the exact
// damped-score conversion as computeTF (index.html ~2289-2445), restricted
// to price-based indicators.
export function scoreSeries(candles, tf) {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const fast = !!FAST_TF[tf];
  const trW = TRW[tf] ?? 0.5;
  const rsiP = fast ? 9 : 14;

  const rsiArr = rsiSeries(closes, rsiP);
  const sma5 = sma(closes, 5), sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const { line: macdLine, hist: macdHist } = macdSeries(closes);
  const bb = bollinger(closes, 20, 2);
  const vwap = sessionVwap(candles);
  const delta = fast ? takerDelta(candles) : null;

  const scores = new Array(n).fill(50);
  const rsiWindow = []; // rolling valid RSI values for adaptive thresholds

  for (let i = 0; i < n; i++) {
    let bull = 0, bear = 0, active = 0, count = 0;
    const last = closes[i];

    // RSI with adaptive percentile thresholds (rolling 100 values)
    const rv = rsiArr[i];
    if (rv != null && rv > 0 && rv < 100) {
      rsiWindow.push(rv);
      if (rsiWindow.length > 100) rsiWindow.shift();
    }
    if (rv != null) {
      count++;
      let rsiOB = 75, rsiBull = 60, rsiBear = 40, rsiOS = 25;
      if (rsiWindow.length >= 20) {
        const sorted = rsiWindow.slice().sort((a, b) => a - b);
        const pct = p => sorted[Math.floor(sorted.length * p)];
        rsiOB = Math.max(65, pct(0.85));
        rsiBull = Math.max(52, pct(0.65));
        rsiBear = Math.min(48, pct(0.35));
        rsiOS = Math.min(35, pct(0.15));
      }
      if (rv > rsiOB) { bear += 2; active++; }
      else if (rv > rsiBull) { bull += 1; active++; }
      else if (rv < rsiOS) { bull += 2; active++; }
      else if (rv < rsiBear) { bear += 1; active++; }
    }

    // SMA trend
    if (sma20[i] != null && sma50[i] != null) {
      count++;
      if (last > sma20[i] && sma20[i] > sma50[i]) { bull += 2 * trW; active++; }
      else if (last > sma20[i]) { bull += trW; active++; }
      else if (last < sma20[i] && sma20[i] < sma50[i]) { bear += 2 * trW; active++; }
      else if (last < sma20[i]) { bear += trW; active++; }
    }

    // Simplified perfect order (SMA5>20>50 aligned with price)
    if (sma5[i] != null && sma50[i] != null) {
      count++;
      if (last > sma5[i] && sma5[i] > sma20[i] && sma20[i] > sma50[i]) { bull += 2.5; active++; }
      else if (last < sma5[i] && sma5[i] < sma20[i] && sma20[i] < sma50[i]) { bear += 2.5; active++; }
    }

    // MACD (exact weight map from computeTF)
    if (macdLine[i] != null && macdHist[i] != null) {
      count++;
      const h = macdHist[i], m = macdLine[i];
      if (h > 0 && m > 0) { bull += 2; active++; }
      else if (h > 0) { bull += 1; active++; }
      else if (h < 0 && m < 0) { bear += 2; active++; }
      else if (h < 0) { bear += 1; active++; }
    }

    // Bollinger (mean-reversion bias, ±1.5)
    if (bb.mid[i] != null) {
      count++;
      if (last > bb.upper[i]) { bear += 1.5; active++; }
      else if (last < bb.lower[i]) { bull += 1.5; active++; }
    }

    // Session VWAP (±1.5 beyond 0.2%)
    if (vwap[i] != null) {
      count++;
      if (last > vwap[i] * 1.002) { bull += 1.5; active++; }
      else if (last < vwap[i] * 0.998) { bear += 1.5; active++; }
    }

    // Taker delta (fast TFs, ±1.2 beyond ±0.1)
    if (delta) {
      count++;
      if (delta[i] > 0.1) { bull += 1.2; active++; }
      else if (delta[i] < -0.1) { bear += 1.2; active++; }
    }

    // Exact damped-score conversion from computeTF
    const maxWeight = (count || 1) * 2;
    const rawBullPct = (bull / maxWeight) * 100;
    const rawBearPct = (bear / maxWeight) * 100;
    const confidenceFactor = Math.min(1, active / 4);
    const rawScore = 50 + (rawBullPct - rawBearPct);
    scores[i] = Math.max(0, Math.min(100, Math.round(50 + (rawScore - 50) * confidenceFactor)));
  }
  return scores;
}

// Style rules → edge-triggered entry signals (mirrors checkBotEntry gates).
export function botSignals(candles, tf, style, p) {
  const n = candles.length;
  const sigs = [];
  let prevZone = 0; // -1 short zone, 0 neutral, 1 long zone

  if (style === 'trend') {
    const scores = scoreSeries(candles, tf);
    const entry = Math.max(38, Math.min(75, p.scoreEntry || 50));
    for (let i = 1; i < n; i++) {
      const zone = scores[i] >= entry ? 1 : scores[i] <= 100 - entry ? -1 : 0;
      if (zone !== 0 && zone !== prevZone) sigs.push({ index: i, side: zone === 1 ? 'long' : 'short' });
      prevZone = zone;
    }
  } else if (style === 'counter') {
    const closes = candles.map(c => c.close);
    const fast = !!FAST_TF[tf];
    const r = rsiSeries(closes, p.rsiPeriod || (fast ? 9 : 14));
    const ob = p.rsiOB || p.rsiExtremeHigh || 62;
    const os = p.rsiOS || p.rsiExtremeLow || 38;
    const bb = (p.bbEntry || p.bbConfirm)
      ? bollinger(closes, p.bbPeriod || 20, p.bbMult || 2) : null;
    for (let i = 1; i < n; i++) {
      if (r[i] == null) continue;
      let zone = 0;
      if (r[i] < os && (!bb || (bb.lower[i] != null && closes[i] < bb.lower[i]))) zone = 1;
      else if (r[i] > ob && (!bb || (bb.upper[i] != null && closes[i] > bb.upper[i]))) zone = -1;
      if (zone !== 0 && zone !== prevZone) sigs.push({ index: i, side: zone === 1 ? 'long' : 'short' });
      prevZone = zone;
    }
  } else { // 'range'
    const lookback = p.rangeLookback || 15;
    const maxPct = p.rangeMaxPct || 1.0;
    const zonePct = (p.entryZone || 30) / 100;
    for (let i = lookback; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - lookback; j < i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low < lo) lo = candles[j].low;
      }
      const width = (hi - lo) / lo * 100;
      const c = candles[i].close;
      let zone = 0;
      if (width <= maxPct && c >= lo && c <= hi) {
        if (c <= lo + (hi - lo) * zonePct) zone = 1;
        else if (c >= hi - (hi - lo) * zonePct) zone = -1;
      }
      if (zone !== 0 && zone !== prevZone) sigs.push({ index: i, side: zone === 1 ? 'long' : 'short' });
      prevZone = zone;
    }
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════
// PER-BOT signal replicas — faithful, causal, edge-triggered versions of the
// live checkBotEntry() gates (index.html). Each returns [{index, side}].
// Edge-trigger = emit only on the bar where a NEW directional zone is entered
// (the prevZone pattern from botSignals), so backtest enters once per setup.
// ═══════════════════════════════════════════════════════════════════════

// Shared helpers ---------------------------------------------------------
function closesOf(candles) { return candles.map(c => c.close); }

// Edge-trigger a zone array (-1/0/1) into [{index,side}] signals.
function edgeSignals(zones, fromIndex = 1) {
  const sigs = [];
  let prev = 0;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i] || 0;
    if (i >= fromIndex && z !== 0 && z !== prev) {
      sigs.push({ index: i, side: z === 1 ? 'long' : 'short' });
    }
    prev = z;
  }
  return sigs;
}

// ATR-spike ratio per bar: mean(high-low over last 14) / mean(high-low over
// bars i-29..i-15). Mirrors botComputeTF's atr indicator (simple range mean,
// not Wilder). spike when ratio >= 1.15.
function atrRatioSeries(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const rng = candles.map(c => c.high - c.low);
  for (let i = 14; i < n; i++) {
    let r14 = 0;
    for (let j = i - 13; j <= i; j++) r14 += rng[j];
    r14 /= 14;
    let base, cnt = 0, sum = 0;
    if (i >= 29) {
      for (let j = i - 29; j <= i - 14; j++) { sum += rng[j]; cnt++; }
      base = sum / cnt;
    } else {
      base = r14;
    }
    out[i] = base > 0 ? r14 / base : 1;
  }
  return out;
}

// Trend class at bar i (matches inds.trend cls): 'bull'|'bear'|'neut'.
function trendCls(close, sma20, sma50) {
  if (sma20 == null || sma50 == null) return null;
  if (close > sma20 && sma20 > sma50) return 'bull';
  if (close > sma20) return 'bull';
  if (close < sma20 && sma20 < sma50) return 'bear';
  if (close < sma20) return 'bear';
  return 'neut';
}

// Align a score series computed on another-TF's klines onto own candles.
function alignedHigherScore(candles, rawKlinesHigher, tfHigher) {
  if (!rawKlinesHigher || !rawKlinesHigher.length) return null;
  const hc = toCandles(rawKlinesHigher);
  if (hc.length < 20) return null;
  const hs = scoreSeries(hc, tfHigher);
  const points = hc.map((c, i) => ({ time: c.time, value: hs[i] }));
  return alignSeries(candles, points); // own-length array of higher-TF scores (or null)
}

// ── 1. john / sarah — score trend with SMA trend gate ──────────────────
function sig_scoreTrend(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const scores = scoreSeries(candles, tf);
  const s20 = sma(cl, 20), s50 = sma(cl, 50);
  const entry = Math.max(38, Math.min(75, p.scoreEntry || 50));
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const tc = trendCls(cl[i], s20[i], s50[i]);
    if (scores[i] >= entry && tc !== 'bear') zones[i] = 1;
    else if (scores[i] <= 100 - entry && tc !== 'bull') zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 2. mike — RSI7 + BB(20,2) counter ──────────────────────────────────
function sig_mike(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 7);
  const bb = bollinger(cl, 20, 2);
  const os = p.rsiOS || 38, ob = p.rsiOB || 62;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (r[i] == null) continue;
    const below = bb.lower[i] != null && cl[i] < bb.lower[i];
    const above = bb.upper[i] != null && cl[i] > bb.upper[i];
    if (r[i] <= os || (below && r[i] <= 45)) zones[i] = 1;
    else if (r[i] >= ob || (above && r[i] >= 55)) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 3. emma — RSI14 + funding-rate divergence ──────────────────────────
function sig_emma(candles, tf, p, ctx) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 14);
  const os = p.rsiOS || 38, ob = p.rsiOB || 62;
  const frTh = p.frThresh || 0.015;
  const fr = (ctx && ctx.series && ctx.series.fr) ? alignSeries(candles, ctx.series.fr) : null;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (r[i] == null) continue;
    if (r[i] <= os) { zones[i] = 1; continue; }
    if (r[i] >= ob) { zones[i] = -1; continue; }
    if (fr && fr[i] != null && r[i] > 30 && r[i] < 70) {
      const frPct = fr[i] * 100;
      if (Math.abs(frPct) >= frTh) zones[i] = frPct > 0 ? -1 : 1;
    }
  }
  return edgeSignals(zones);
}

// ── 4. alex — own-TF score + optional 4h confirmation ──────────────────
function sig_alex(candles, tf, p, ctx) {
  const n = candles.length;
  const scores = scoreSeries(candles, tf);
  const entry = Math.max(38, Math.min(75, p.scoreEntry || 50));
  const h4 = (ctx && ctx.klinesByTf && ctx.klinesByTf['4h'])
    ? alignedHigherScore(candles, ctx.klinesByTf['4h'], '4h') : null;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (scores[i] >= entry) {
      if (!h4 || h4[i] == null || h4[i] >= 55) zones[i] = 1;
    } else if (scores[i] <= 100 - entry) {
      if (!h4 || h4[i] == null || h4[i] <= 45) zones[i] = -1;
    }
  }
  return edgeSignals(zones);
}

// ── 5. yuki — F&G + L/S sentiment (no series → no signals) ─────────────
function sig_yuki(candles, tf, p, ctx) {
  const n = candles.length;
  const fgPts = ctx && ctx.series && ctx.series.fg;
  const lsPts = ctx && ctx.series && ctx.series.ls;
  if (!fgPts || !fgPts.length || !lsPts || !lsPts.length) return [];
  const fg = alignSeries(candles, fgPts);
  const ls = alignSeries(candles, lsPts);
  const fgEx = p.fgExtreme || 35, fgGr = p.fgGreed || 65, lsTh = p.lsThresh || 55;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (fg[i] == null || ls[i] == null) continue;
    if (fg[i] <= fgEx && ls[i] < (100 - lsTh)) zones[i] = 1;
    else if (fg[i] >= fgGr && ls[i] > lsTh) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 6. delta — score trend gated by taker delta ────────────────────────
function sig_delta(candles, tf, p) {
  const n = candles.length;
  const scores = scoreSeries(candles, tf);
  const d = takerDelta(candles, 10);
  const entry = Math.max(38, Math.min(75, p.scoreEntry || 50));
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (scores[i] >= entry && d[i] > -0.1) zones[i] = 1;
    else if (scores[i] <= 100 - entry && d[i] < 0.1) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 7. atr — RSI extreme + ATR spike counter ───────────────────────────
function sig_atr(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 14);
  const ratio = atrRatioSeries(candles);
  const os = p.rsiOS || 38, ob = p.rsiOB || 62;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (r[i] == null || ratio[i] == null) continue;
    const spike = ratio[i] >= 1.15;
    if (!spike) continue;
    if (r[i] <= os) zones[i] = 1;
    else if (r[i] >= ob) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 8. riku — range bounce scalp (RSI7) ────────────────────────────────
function sig_riku(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 7);
  const lookback = p.rangeLookback || 15;
  const maxPct = p.rangeMaxPct || 1.0;
  const entryZone = p.entryZone || 30;
  const rsiLow = p.rsiLow || 45, rsiHigh = p.rsiHigh || 55;
  const zones = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const size = hi - lo;
    if (size <= 0) continue;
    const width = size / lo * 100;
    if (width > maxPct) continue;
    const c = candles[i];
    const pos = (c.close - lo) / size * 100;
    const bull = c.close > c.open, bear = c.close < c.open;
    if (pos <= entryZone && ((r[i] != null && r[i] <= rsiLow) || bull)) zones[i] = 1;
    else if (pos >= 100 - entryZone && ((r[i] != null && r[i] >= rsiHigh) || bear)) zones[i] = -1;
  }
  return edgeSignals(zones, lookback);
}

// ── 9. band — Bollinger ±σ scalp (RSI7) ────────────────────────────────
function sig_band(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 7);
  const period = p.bbPeriod || 20, mult = p.bbMult || 1.8;
  const bb = bollinger(cl, period, mult);
  const widthMin = p.bbWidthMin || 0.15;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (bb.mid[i] == null || bb.mid[i] <= 0) continue;
    const range = bb.upper[i] - bb.lower[i];
    const widthPct = range / bb.mid[i] * 100;
    if (widthPct < widthMin || range <= 0) continue;
    const pos = (cl[i] - bb.lower[i]) / range * 100;
    if (cl[i] <= bb.lower[i] || (pos <= 12 && r[i] != null && r[i] <= 35)) zones[i] = 1;
    else if (cl[i] >= bb.upper[i] || (pos >= 88 && r[i] != null && r[i] >= 65)) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 10. wall — MA bounce (RSI9) ────────────────────────────────────────
function sig_wall(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 9);
  const s200 = sma(cl, 200), s100 = sma(cl, 100), s50 = sma(cl, 50);
  const e20 = ema(cl, 20), e9 = ema(cl, 9);
  const touchPct = p.maTouchPct || 0.15;
  const rsiOB = p.rsiOB || 60, rsiOS = p.rsiOS || 40;
  const mas = [s200, s100, s50, e20, e9];
  const zones = new Array(n).fill(0);
  for (let i = 2; i < n; i++) {
    const c = cl[i];
    // 3 consecutive rising / falling closes
    const rising = cl[i] > cl[i - 1] && cl[i - 1] > cl[i - 2];
    const falling = cl[i] < cl[i - 1] && cl[i - 1] < cl[i - 2];
    if (!rising && !falling) continue;
    let touched = false;
    for (const ma of mas) {
      const v = ma[i];
      if (v == null || v <= 0) continue;
      if (Math.abs(c - v) / v * 100 <= touchPct) { touched = true; break; }
    }
    if (!touched) continue;
    if (rising && r[i] != null && r[i] < rsiOB) zones[i] = 1;
    else if (falling && r[i] != null && r[i] > rsiOS) zones[i] = -1;
  }
  return edgeSignals(zones, 2);
}

// ── 11. blitz — momentum burst (RSI7) ──────────────────────────────────
function sig_blitz(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 7);
  const N = p.momBars || 3;
  const th = p.momThresh || 0.03;
  const rMin = p.rsiMin || 35, rMax = p.rsiMax || 65;
  const zones = new Array(n).fill(0);
  for (let i = N - 1; i < n; i++) {
    let bull = 0, bear = 0, move = 0;
    for (let j = i - N + 1; j <= i; j++) {
      const c = candles[j];
      move += (c.close - c.open) / c.open * 100;
      if (c.close > c.open) bull++; else bear++;
    }
    if (r[i] == null) continue;
    // avg volume of last 5 bars
    let vsum = 0, vc = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) { vsum += candles[j].volume; vc++; }
    const avg5 = vc ? vsum / vc : 0;
    const volOk = candles[i].volume >= 0.7 * avg5;
    if (!volOk) continue;
    if (bull === N && move >= th && r[i] >= rMin && r[i] <= rMax) zones[i] = 1;
    else if (bear === N && move <= -th && r[i] >= rMin && r[i] <= rMax) zones[i] = -1;
  }
  return edgeSignals(zones, N - 1);
}

// ── 12. flash — volume surge ───────────────────────────────────────────
function sig_flash(candles, tf, p) {
  const n = candles.length;
  const lookback = p.volLookback || 10;
  const surge = p.volSurgeMult || 1.8;
  const d = p.deltaConfirm ? takerDelta(candles, 10) : null;
  const zones = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += candles[j].volume;
    const avg = sum / lookback;
    if (avg <= 0) continue;
    if (candles[i].volume < surge * avg) continue;
    const c = candles[i];
    let dir = c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
    if (dir === 0) continue;
    if (d) {
      if (dir === 1 && !(d[i] > 0.1)) continue;
      if (dir === -1 && !(d[i] < -0.1)) continue;
    }
    zones[i] = dir;
  }
  return edgeSignals(zones, lookback);
}

// ── 13. turbo — RSI extreme reversal ───────────────────────────────────
function sig_turbo(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, p.rsiPeriod || 7);
  const lo = p.rsiExtremeLow || 22, hi = p.rsiExtremeHigh || 78;
  const bb = p.bbConfirm ? bollinger(cl, 20, 1.8) : null;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (r[i] == null) continue;
    const c = candles[i];
    if (r[i] <= lo && c.close > c.open) {
      if (!bb || bb.mid[i] == null || c.close < bb.mid[i]) zones[i] = 1;
    } else if (r[i] >= hi && c.close < c.open) {
      if (!bb || bb.mid[i] == null || c.close > bb.mid[i]) zones[i] = -1;
    }
  }
  return edgeSignals(zones);
}

// ── 14. variant breakout (_agg) — BB break + ATR expansion ─────────────
function sig_breakout(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const bb = bollinger(cl, 20, 2);
  const ratio = atrRatioSeries(candles);
  const scores = scoreSeries(candles, tf);
  const zones = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (ratio[i] == null || ratio[i] < 1.15) continue; // ATR expanding precondition
    const up = bb.upper[i] != null && cl[i] > bb.upper[i] && cl[i] > cl[i - 1];
    const dn = bb.lower[i] != null && cl[i] < bb.lower[i] && cl[i] < cl[i - 1];
    if (up || scores[i] >= 58) zones[i] = 1;
    else if (dn || scores[i] <= 42) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 15. variant meanrev (_con) — RSI counter, trend-blocked ────────────
function sig_meanrev(candles, tf, p) {
  const n = candles.length;
  const cl = closesOf(candles);
  const r = rsiSeries(cl, 14);
  const s20 = sma(cl, 20), s50 = sma(cl, 50);
  const scores = scoreSeries(candles, tf);
  const os = p.rsiOS || 38, ob = p.rsiOB || 62;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (r[i] == null) continue;
    const c = cl[i];
    const strongBull = s20[i] != null && s50[i] != null && c > s20[i] && s20[i] > s50[i] && scores[i] > 72;
    const strongBear = s20[i] != null && s50[i] != null && c < s20[i] && s20[i] < s50[i] && scores[i] < 28;
    if (r[i] <= os) { if (!strongBear) zones[i] = 1; }
    else if (r[i] >= ob) { if (!strongBull) zones[i] = -1; }
  }
  return edgeSignals(zones);
}

// ── 16. variant deltascalp (_fast) — delta + volume surge ──────────────
function sig_deltascalp(candles, tf, p) {
  const n = candles.length;
  const d = takerDelta(candles, 10);
  const surge = p.volSurgeMult || 1.2;
  const zones = new Array(n).fill(0);
  for (let i = 5; i < n; i++) {
    let sum = 0;
    for (let j = i - 5; j < i; j++) sum += candles[j].volume;
    const avg = sum / 5;
    if (avg <= 0) continue;
    const surged = candles[i].volume >= surge * avg;
    if (!surged) continue;
    if (d[i] > 0.1) zones[i] = 1;
    else if (d[i] < -0.1) zones[i] = -1;
  }
  return edgeSignals(zones, 5);
}

// ── 17. variant multitf (_slow) — multi-TF score consensus ─────────────
const TF_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
function sig_multitf(candles, tf, p, ctx) {
  const n = candles.length;
  const entry = p.scoreEntry || 48;
  const alignMin = p.alignMin || 2;
  // own TF score + up to 2 higher TFs available in ctx
  const ownScores = scoreSeries(candles, tf);
  const series = [{ tf, scores: ownScores }];
  const idx = TF_ORDER.indexOf(tf);
  if (ctx && ctx.klinesByTf && idx >= 0) {
    let added = 0;
    for (let k = idx + 1; k < TF_ORDER.length && added < 2; k++) {
      const htf = TF_ORDER[k];
      const raw = ctx.klinesByTf[htf];
      if (!raw || !raw.length) continue;
      const aligned = alignedHigherScore(candles, raw, htf);
      if (aligned) { series.push({ tf: htf, scores: aligned }); added++; }
    }
  }
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let longV = 0, shortV = 0, sum = 0, cnt = 0;
    for (const s of series) {
      const sc = s.scores[i];
      if (sc == null) continue;
      cnt++; sum += sc;
      if (sc >= entry) longV++;
      else if (sc <= 100 - entry) shortV++;
    }
    if (cnt < 2) continue;
    const avg = sum / cnt;
    if (longV >= alignMin && avg >= entry) zones[i] = 1;
    else if (shortV >= alignMin && avg <= 100 - entry) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// ── 18. variant sentiment (_risk) — F&G + L/S + FR point system ────────
function sig_sentiment(candles, tf, p, ctx) {
  const n = candles.length;
  const s = ctx && ctx.series;
  const fgPts = s && s.fg, lsPts = s && s.ls, frPts = s && s.fr;
  const hasAny = (fgPts && fgPts.length) || (lsPts && lsPts.length) || (frPts && frPts.length);
  if (!hasAny) return [];
  const fg = fgPts && fgPts.length ? alignSeries(candles, fgPts) : null;
  const ls = lsPts && lsPts.length ? alignSeries(candles, lsPts) : null;
  const fr = frPts && frPts.length ? alignSeries(candles, frPts) : null;
  const fgEx = p.fgExtreme || 35, fgGr = p.fgGreed || 65, lsTh = p.lsThresh || 55, frTh = p.frThresh || 0.015;
  const zones = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let longPts = 0, shortPts = 0;
    if (fg && fg[i] != null) {
      if (fg[i] <= fgEx) longPts += 2;
      else if (fg[i] >= fgGr) shortPts += 2;
      else if (fg[i] <= 45) longPts += 1;
      else if (fg[i] >= 75) shortPts += 1;
    }
    if (ls && ls[i] != null) {
      if (ls[i] < 45) longPts += 1;
      else if (ls[i] > 55) shortPts += 1;
    }
    if (fr && fr[i] != null) {
      const frPct = fr[i] * 100;
      if (frPct <= -frTh) longPts += 1;
      else if (frPct >= frTh) shortPts += 1;
    }
    if (longPts >= 2 && longPts >= shortPts) zones[i] = 1;
    else if (shortPts >= 2 && shortPts > longPts) zones[i] = -1;
  }
  return edgeSignals(zones);
}

// Mother-bot dispatch table.
const MOTHER_FNS = {
  john: sig_scoreTrend, sarah: sig_scoreTrend,
  mike: sig_mike, emma: sig_emma, alex: sig_alex, yuki: sig_yuki,
  delta: sig_delta, atr: sig_atr, riku: sig_riku, band: sig_band,
  wall: sig_wall, blitz: sig_blitz, flash: sig_flash, turbo: sig_turbo,
};
// Variant-suffix dispatch table.
const VARIANT_FNS = {
  _agg: sig_breakout, _con: sig_meanrev, _fast: sig_deltascalp,
  _slow: sig_multitf, _risk: sig_sentiment,
};

// Dispatch: exact mother id → mother fn; id suffix → variant fn; else style fallback.
export function signalsFor(def, params, candles, ctx) {
  const tf = def.tf;
  const p = params || {};
  const id = def.id || '';
  if (MOTHER_FNS[id]) return MOTHER_FNS[id](candles, tf, p, ctx);
  for (const suf of Object.keys(VARIANT_FNS)) {
    if (id.endsWith(suf)) return VARIANT_FNS[suf](candles, tf, p, ctx);
  }
  return botSignals(candles, tf, def.style || 'trend', p);
}

// Run one bot's params over raw klines. Returns backtest result + stats.
export function runBot(def, params, rawKlines, ctx) {
  const candles = toCandles(rawKlines);
  if (candles.length < 60) return null;
  const tf = def.tf;
  const signals = signalsFor(def, params, candles, ctx);
  const tfMin = TF_MINUTES[tf] || 5;
  const timeoutBars = params.timeoutMin ? Math.max(1, Math.round(params.timeoutMin / tfMin)) : null;
  const exitParams = (params.slPct != null && params.tpPct != null)
    ? { slPct: params.slPct, tpPct: params.tpPct }
    : { slAtr: params.slAtrMult || 1.0, tpAtr: params.tpAtrMult || 1.5 };
  const opts = { timeoutBars };
  if (params.trailAtrMult > 0) {
    opts.trail = { atrMult: params.trailAtrMult, atrValues: atrSeries(candles, 14) };
  }
  const res = backtest(candles, signals, exitParams, opts);
  return { ...res, signals, candleCount: candles.length };
}

// Build a pseudo bot-state so the ORIGINAL calcFitnessPlus can score the
// backtest on the same scale as live paper trades.
export function pseudoState(trades) {
  let wins = 0, losses = 0, pnl = 0;
  const t = trades.map(tr => {
    const win = tr.retPct > 0;
    if (win) wins++; else losses++;
    pnl += tr.retPct;
    return { pnlPct: tr.retPct, win, dir: tr.side === 'long' ? 'LONG' : 'SHORT' };
  });
  return { trades: t, totalWins: wins, totalLosses: losses, totalPnlPct: pnl };
}

// fitnessFn: the pre-override calcFitnessPlus captured by evolution-boost.js.
export function fitnessFor(def, params, rawKlines, fitnessFn, ctx) {
  const res = runBot(def, params, rawKlines, ctx);
  if (!res) return null;
  const ps = pseudoState(res.trades);
  const m = res.metrics;
  let fitness;
  if (typeof fitnessFn === 'function') {
    fitness = fitnessFn(ps);
  } else {
    // standalone fallback on the same idea: pnl + winrate - drawdown
    fitness = m.netPnlPct * 0.5 + m.winRate * 0.2 - m.maxDrawdownPct * 0.5;
  }
  return {
    fitness,
    tradeCount: m.tradeCount,
    winRate: m.winRate,
    pnlPct: m.netPnlPct,
    maxDrawdownPct: m.maxDrawdownPct,
    profitFactor: m.profitFactor,
    equityCurve: res.equityCurve,
    trades: res.trades,
  };
}

if (typeof window !== 'undefined') {
  window.BotBacktest = { toCandles, scoreSeries, botSignals, signalsFor, runBot, pseudoState, fitnessFor };
  window.dispatchEvent(new Event('botbacktest-ready'));
  console.log('[BotBacktest] ready — instant historical bot evaluation available');
}
