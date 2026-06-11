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

import { sma, ema, rsi as rsiSeries, macd as macdSeries, bollinger } from './indicators.js';
import { backtest } from './backtest.js';

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

// Run one bot's params over raw klines. Returns backtest result + stats.
export function runBot(def, params, rawKlines) {
  const candles = toCandles(rawKlines);
  if (candles.length < 60) return null;
  const tf = def.tf;
  const signals = botSignals(candles, tf, def.style || 'trend', params);
  const tfMin = TF_MINUTES[tf] || 5;
  const timeoutBars = params.timeoutMin ? Math.max(1, Math.round(params.timeoutMin / tfMin)) : null;
  const exitParams = (params.slPct != null && params.tpPct != null)
    ? { slPct: params.slPct, tpPct: params.tpPct }
    : { slAtr: params.slAtrMult || 1.0, tpAtr: params.tpAtrMult || 1.5 };
  const res = backtest(candles, signals, exitParams, { timeoutBars });
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
export function fitnessFor(def, params, rawKlines, fitnessFn) {
  const res = runBot(def, params, rawKlines);
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
  window.BotBacktest = { toCandles, scoreSeries, botSignals, runBot, pseudoState, fitnessFor };
  window.dispatchEvent(new Event('botbacktest-ready'));
  console.log('[BotBacktest] ready — instant historical bot evaluation available');
}
