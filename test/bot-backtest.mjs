// Sanity checks for js/bot-backtest.js on synthetic Binance raw klines.
import { toCandles, scoreSeries, botSignals, signalsFor, runBot, fitnessFor } from '../js/bot-backtest.js';

let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const raw = [];
let price = 60000, drift = 0;
const t0 = Date.UTC(2026, 0, 1);
for (let i = 0; i < 1000; i++) {
  if (i % 120 === 0) drift = (rand() - 0.5) * 0.002;
  const open = price;
  const close = open * (1 + drift + (rand() - 0.5) * 0.006);
  const high = Math.max(open, close) * (1 + rand() * 0.002);
  const low = Math.min(open, close) * (1 - rand() * 0.002);
  const vol = 10 + rand() * 100;
  const takerBuy = vol * (0.35 + rand() * 0.3);
  raw.push([t0 + i * 300000, open, high, low, close, vol, 0, 0, 0, takerBuy]);
  price = close;
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const candles = toCandles(raw);
assert(candles.length === 1000 && candles[0].takerBuy > 0, 'toCandles parses takerBuy');

const scores = scoreSeries(candles, '5m');
assert(scores.every(s => s >= 0 && s <= 100), 'scores in [0,100]');
assert(new Set(scores.slice(100)).size > 5, 'scores vary (not stuck at 50)');

const styles = [
  ['trend', { scoreEntry: 48, tpPct: 0.25, slPct: 0.15, timeoutMin: 10 }],
  ['counter', { rsiOB: 62, rsiOS: 38, bbEntry: true, tpPct: 0.20, slPct: 0.12, timeoutMin: 8 }],
  ['range', { rangeLookback: 15, rangeMaxPct: 1.0, entryZone: 30, tpPct: 0.10, slPct: 0.07, timeoutMin: 3 }],
];
for (const [style, params] of styles) {
  const sigs = botSignals(candles, '5m', style, params);
  assert(sigs.length > 0, `${style}: signals generated (${sigs.length})`);
  const res = runBot({ tf: '5m', style }, params, raw);
  const m = res.metrics;
  assert(m.tradeCount > 0, `${style}: trades executed (${m.tradeCount})`);
  assert(Math.abs(m.netPnlPct) < 200, `${style}: PnL plausible (${m.netPnlPct.toFixed(1)}%)`);
  // determinism
  const res2 = runBot({ tf: '5m', style }, params, raw);
  assert(res2.metrics.netPnlPct === m.netPnlPct, `${style}: deterministic`);
}

// timeout exits occur with a 10min timeout on 5m bars (=2 bars)
const resT = runBot({ tf: '5m', style: 'trend' }, { scoreEntry: 48, tpPct: 5, slPct: 5, timeoutMin: 10 }, raw);
assert(resT.trades.some(t => t.reason === 'timeout'), 'timeout exits occur');

// fitnessFor with a mock original calcFitnessPlus
const f = fitnessFor({ tf: '5m', style: 'trend' }, { scoreEntry: 48, tpPct: 0.25, slPct: 0.15, timeoutMin: 10 }, raw,
  bs => bs.totalPnlPct + bs.totalWins - bs.totalLosses);
assert(f && Number.isFinite(f.fitness), `fitnessFor finite (${f.fitness.toFixed(2)})`);
assert(f.tradeCount > 0 && f.equityCurve.length === 1000, 'fitnessFor carries stats');

// fallback fitness without fn
const f2 = fitnessFor({ tf: '5m', style: 'trend' }, { scoreEntry: 48, tpPct: 0.25, slPct: 0.15, timeoutMin: 10 }, raw);
assert(Number.isFinite(f2.fitness), 'fallback fitness finite');

// ═══════════════════════════════════════════════════════════════════════
// PER-BOT signal replicas (signalsFor) + synthetic external-series ctx.
// ═══════════════════════════════════════════════════════════════════════

const firstTime = candles[0].time;
const lastTime = candles[candles.length - 1].time;

// Funding rate: a point every 8h, cycling -0.0003..0.0003 with some |fr|>0.00015 episodes.
const frPts = [];
for (let t = firstTime, k = 0; t <= lastTime; t += 8 * 3600, k++) {
  // sine sweep gives both small and large magnitudes incl. |fr|>0.00015
  frPts.push({ time: t, value: 0.0003 * Math.sin(k * 0.9) });
}
// L/S: hourly, oscillating 35..65.
const lsPts = [];
for (let t = firstTime, k = 0; t <= lastTime; t += 3600, k++) {
  lsPts.push({ time: t, value: 50 + 15 * Math.sin(k * 0.5) });
}
// F&G: daily, sweeping 20..80.
const fgPts = [];
for (let t = firstTime, k = 0; t <= lastTime; t += 86400, k++) {
  fgPts.push({ time: t, value: 50 + 30 * Math.sin(k * 1.3) });
}

// Coarse '4h'-style klines by aggregating the 5m candles (48 x 5m = 4h).
const raw4h = [];
for (let i = 0; i < raw.length; i += 48) {
  const chunk = raw.slice(i, i + 48);
  if (!chunk.length) break;
  const o = chunk[0][1];
  const c = chunk[chunk.length - 1][4];
  let hi = -Infinity, lo = Infinity, vol = 0, tb = 0;
  for (const k of chunk) {
    if (k[2] > hi) hi = k[2];
    if (k[3] < lo) lo = k[3];
    vol += k[5]; tb += k[9];
  }
  raw4h.push([chunk[0][0], o, hi, lo, c, vol, 0, 0, 0, tb]);
}

const ctx = { series: { fr: frPts, ls: lsPts, fg: fgPts }, klinesByTf: { '4h': raw4h } };

// Bot roster: mother ids (with tf/style) + variant suffixes on a 5m base bot.
const MOTHERS = [
  { id: 'john',  tf: '5m',  style: 'trend' },
  { id: 'sarah', tf: '15m', style: 'trend' },
  { id: 'mike',  tf: '5m',  style: 'counter' },
  { id: 'emma',  tf: '15m', style: 'counter' },
  { id: 'alex',  tf: '1h',  style: 'trend' },
  { id: 'yuki',  tf: '1h',  style: 'counter' },
  { id: 'delta', tf: '15m', style: 'trend' },
  { id: 'atr',   tf: '1h',  style: 'counter' },
  { id: 'riku',  tf: '5m',  style: 'range' },
  { id: 'band',  tf: '1m',  style: 'range' },
  { id: 'wall',  tf: '3m',  style: 'range' },
  { id: 'blitz', tf: '1m',  style: 'trend' },
  { id: 'flash', tf: '1m',  style: 'trend' },
  { id: 'turbo', tf: '1m',  style: 'counter' },
];
const VARIANTS = [
  { id: 'john_agg',  tf: '5m', style: 'trend' },   // breakout
  { id: 'mike_con',  tf: '5m', style: 'counter' }, // meanrev
  { id: 'delta_fast',tf: '5m', style: 'trend' },   // deltascalp
  { id: 'alex_slow', tf: '5m', style: 'trend' },   // multitf
  { id: 'yuki_risk', tf: '1h', style: 'counter' }, // sentiment
];
const ALL = [...MOTHERS, ...VARIANTS];

// Reasonable per-bot params (cover the named knobs; defaults fill the rest).
const PARAMS = {
  scoreEntry: 48, rsiOS: 38, rsiOB: 62, frThresh: 0.015,
  fgExtreme: 35, fgGreed: 65, lsThresh: 55,
  rangeLookback: 15, rangeMaxPct: 1.0, entryZone: 30, rsiLow: 45, rsiHigh: 55,
  bbPeriod: 20, bbMult: 1.8, bbWidthMin: 0.05, maTouchPct: 0.5,
  momBars: 3, momThresh: 0.01, rsiMin: 35, rsiMax: 65,
  volLookback: 10, volSurgeMult: 1.3, deltaConfirm: false,
  rsiPeriod: 7, rsiExtremeLow: 30, rsiExtremeHigh: 70, bbConfirm: false,
  alignMin: 2,
  tpPct: 0.3, slPct: 0.2, timeoutMin: 30,
};

const wellFormed = sigs => Array.isArray(sigs) && sigs.every(s =>
  Number.isInteger(s.index) && s.index >= 0 && s.index < candles.length &&
  (s.side === 'long' || s.side === 'short'));

const counts = {};
let producers = 0;
for (const def of ALL) {
  const sigs = signalsFor(def, PARAMS, candles, ctx);
  assert(wellFormed(sigs), `${def.id}: well-formed signals`);
  counts[def.id] = sigs.length;
  if (sigs.length > 0) producers++;
  // determinism
  const sigs2 = signalsFor(def, PARAMS, candles, ctx);
  assert(JSON.stringify(sigs) === JSON.stringify(sigs2), `${def.id}: deterministic`);
}

assert(producers >= 12, `at least 12/19 bots produce signals (${producers}/${ALL.length})`);

// Series-dependent bots: >0 WITH series, ===0 WITHOUT.
for (const def of [{ id: 'yuki', tf: '1h', style: 'counter' }, { id: 'yuki_risk', tf: '1h', style: 'counter' }]) {
  const withS = signalsFor(def, PARAMS, candles, ctx);
  const noS = signalsFor(def, PARAMS, candles, {});
  assert(withS.length > 0, `${def.id}: signals WITH series (${withS.length})`);
  assert(noS.length === 0, `${def.id}: no signals WITHOUT series (${noS.length})`);
}

// emma falls back to pure-RSI when funding series absent (still works).
{
  const withFr = signalsFor({ id: 'emma', tf: '15m', style: 'counter' }, PARAMS, candles, ctx);
  const noFr = signalsFor({ id: 'emma', tf: '15m', style: 'counter' }, PARAMS, candles, {});
  assert(withFr.length > 0 && noFr.length > 0, `emma works with & without funding (${withFr.length}/${noFr.length})`);
}

// runBot dispatches via signalsFor and is deterministic.
{
  const r1 = runBot({ id: 'john', tf: '5m', style: 'trend' }, PARAMS, raw, ctx);
  const r2 = runBot({ id: 'john', tf: '5m', style: 'trend' }, PARAMS, raw, ctx);
  assert(r1.metrics.netPnlPct === r2.metrics.netPnlPct, 'runBot via signalsFor deterministic');
}

// Trailing stop: build a strongly TRENDING segment; a trailing-locked exit
// should appear as an 'sl' with positive retPct (trailing tightened above entry).
{
  const trendRaw = [];
  let tp = 50000;
  const tt0 = Date.UTC(2026, 2, 1);
  for (let i = 0; i < 500; i++) {
    const open = tp;
    // Phase 1 (0..120): flat consolidation → neutral score (so a genuine
    // edge into the LONG zone occurs later, not at bar 0).
    // Phase 2 (120..330): strong uptrend → long entry rides up, trailing stop
    // ratchets above entry. Phase 3 (330+): pullback → trailing SL fires while
    // still profitable (exit reason 'sl', retPct > 0).
    let drift;
    if (i < 120) drift = 0;
    else if (i < 330) drift = 0.005;
    else drift = -0.0035;
    const noise = (Math.sin(i * 0.7) * 0.0008);
    const close = open * (1 + drift + noise);
    const high = Math.max(open, close) * (1 + 0.0006);
    const low = Math.min(open, close) * (1 - 0.0006);
    const vol = 50 + (i % 7) * 5;
    trendRaw.push([tt0 + i * 300000, open, high, low, close, vol, 0, 0, 0, vol * 0.7]);
    tp = close;
  }
  // Wide pct SL + unreachable pct TP so the only meaningful exit is the ATR
  // trailing stop (recorded as 'sl' once it ratchets above entry).
  const trailParams = { scoreEntry: 45, slPct: 50, tpPct: 500, trailAtrMult: 1.0, timeoutMin: 0 };
  const rt = runBot({ id: 'john', tf: '5m', style: 'trend' }, trailParams, trendRaw);
  const lockedWin = rt.trades.some(t => t.reason === 'sl' && t.retPct > 0);
  assert(rt.trades.length > 0, `trailing: trades executed (${rt.trades.length})`);
  assert(lockedWin, `trailing locks profit: an 'sl' exit with positive retPct exists`);
}

// fitnessFor threads ctx.
{
  const f = fitnessFor({ id: 'yuki', tf: '1h', style: 'counter' }, PARAMS, raw,
    bs => bs.totalPnlPct + bs.totalWins - bs.totalLosses, ctx);
  assert(f && Number.isFinite(f.fitness), `fitnessFor with ctx finite (${f.fitness.toFixed(2)})`);
}

// Per-bot signal-count summary table.
console.log('\n── Per-bot signal counts (synthetic data, WITH ctx) ──');
for (const def of ALL) {
  console.log(`  ${def.id.padEnd(12)} ${String(counts[def.id]).padStart(5)}`);
}
console.log(`  ${'PRODUCERS'.padEnd(12)} ${String(producers).padStart(5)} / ${ALL.length}`);

console.log(process.exitCode ? '--- FAILURES ---' : '--- ALL PASS ---');
