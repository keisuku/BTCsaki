// Sanity checks for indicators / strategies / backtest / optimizer on synthetic data.
import { ema, rsi, atr, supertrend, bollinger } from '../js/indicators.js';
import { STRATEGIES } from '../js/strategies.js';
import { backtest } from '../js/backtest.js';
import { optimize, evaluateConfig } from '../js/optimizer.js';

// Synthetic 1500-candle series: random walk with regime-switching drift (seeded).
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const candles = [];
let price = 60000, drift = 0;
for (let i = 0; i < 1500; i++) {
  if (i % 150 === 0) drift = (rand() - 0.5) * 0.002; // regime switch
  const open = price;
  const ret = drift + (rand() - 0.5) * 0.008;
  const close = open * (1 + ret);
  const high = Math.max(open, close) * (1 + rand() * 0.003);
  const low = Math.min(open, close) * (1 - rand() * 0.003);
  candles.push({ time: 1700000000 + i * 900, open, high, low, close, volume: 10 + rand() * 100 });
  price = close;
}

const closes = candles.map(c => c.close);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

// Indicators
const e = ema(closes, 20);
assert(e[1499] != null && Math.abs(e[1499] - closes[1499]) / closes[1499] < 0.1, 'EMA20 tracks price');
const r = rsi(closes, 14);
assert(r.slice(20).every(v => v >= 0 && v <= 100), 'RSI in [0,100]');
const a = atr(candles, 14);
assert(a.slice(20).every(v => v > 0), 'ATR > 0');
const st = supertrend(candles, 10, 3);
let flips = 0;
for (let i = 1; i < 1500; i++) if (st.dir[i] && st.dir[i - 1] && st.dir[i] !== st.dir[i - 1]) flips++;
assert(flips > 3 && flips < 300, `Supertrend flips sane (${flips})`);
const bb = bollinger(closes, 20, 2);
assert(bb.upper[100] > bb.mid[100] && bb.mid[100] > bb.lower[100], 'BB band order');

// Strategies emit sane signal counts
for (const s of STRATEGIES) {
  const sigs = s.run(candles, s.grid[0]);
  assert(Array.isArray(sigs), `${s.id} returns array`);
  assert(sigs.every(x => x.index > 0 && x.index < 1500 && ['long', 'short', 'exit'].includes(x.side)),
    `${s.id} signals well-formed (${sigs.length} signals)`);
  // overlays don't throw
  const ov = s.overlays(candles, s.grid[0]);
  assert(Array.isArray(ov), `${s.id} overlays ok`);
}

// Backtest: supertrend vertical slice
const stStrat = STRATEGIES.find(s => s.id === 'supertrend');
const sigs = stStrat.run(candles, { period: 10, mult: 3 });
const res = backtest(candles, sigs, { slAtr: 1.5, tpAtr: 2.0 });
const m = res.metrics;
console.log('supertrend backtest:', JSON.stringify(m));
assert(m.tradeCount >= 5 && m.tradeCount <= 300, `trade count sane (${m.tradeCount})`);
assert(Math.abs(m.netPnlPct) < 500, `PnL plausible (${m.netPnlPct.toFixed(1)}%)`);
assert(m.winRate < 100, 'losing trades exist');
assert(res.trades.every(t => t.entryIndex > 0 && t.exitIndex >= t.entryIndex), 'trade index order');
// next-open entry: each trade's entry index must be exactly signal index + 1 for some signal
const sigSet = new Set(sigs.map(s => s.index + 1));
assert(res.trades.every(t => sigSet.has(t.entryIndex)), 'entries at next open after signal');
assert(res.equityCurve.length === candles.length, 'equity curve covers all candles');

// Optimizer end-to-end + timing
const t0 = Date.now();
const out = optimize(candles, () => {});
const dt = Date.now() - t0;
console.log(`optimize: ${dt}ms, leaderboard=${out.leaderboard.length}, champion=${out.champion ? out.champion.strategyId : 'none'}`);
assert(dt < 5000, `optimize under 5s (${dt}ms)`);
assert(out.leaderboard.length === 10, 'leaderboard has all 10 strategies');
assert(out.leaderboard.every(r => r.test && r.train), 'rows carry train+test metrics');
assert(out.splitIndex === 1050, 'split at 70%');
if (out.champion) {
  const t = out.champion.test;
  assert(t.tradeCount >= 8 && t.netPnlPct > 0 && t.profitFactor > 1, 'champion passes guards');
  const ev = evaluateConfig(candles, out.champion);
  assert(ev.trades.length > 0 && ev.equityCurve.length === candles.length, 'evaluateConfig works');
}
// JSON-serializable (localStorage / worker postMessage)
JSON.stringify(out);
console.log('ok: result JSON-serializable');
console.log(process.exitCode ? '--- FAILURES ---' : '--- ALL PASS ---');
