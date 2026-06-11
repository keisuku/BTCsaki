// Sanity checks for js/bot-backtest.js on synthetic Binance raw klines.
import { toCandles, scoreSeries, botSignals, runBot, fitnessFor } from '../js/bot-backtest.js';

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

console.log(process.exitCode ? '--- FAILURES ---' : '--- ALL PASS ---');
