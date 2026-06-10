// Grid search + walk-forward validation + champion selection. Pure logic —
// runs identically inside the Web Worker or on the main thread.

import { STRATEGIES, getStrategy } from './strategies.js';
import { backtest } from './backtest.js';
import { atr as calcAtr } from './indicators.js';
import { EXIT_GRID, TRAIN_RATIO, MIN_TEST_TRADES, ATR_EXIT_PERIOD } from './config.js';

// Train-set ranking score: reward PnL (discounted under 10 trades), penalize drawdown.
function score(m) {
  return m.netPnlPct * Math.min(1, m.tradeCount / 10) - 0.5 * m.maxDrawdownPct;
}

function passesGuards(test) {
  return test.tradeCount >= MIN_TEST_TRADES
    && test.netPnlPct > 0
    && test.profitFactor > 1;
}

// Returns { champion, leaderboard, splitIndex }.
// onProgress(done, total, strategyName) is optional.
export function optimize(candles, onProgress) {
  const splitIndex = Math.floor(candles.length * TRAIN_RATIO);
  const trainCandles = candles.slice(0, splitIndex);
  const atrFull = calcAtr(candles, ATR_EXIT_PERIOD);

  const totalCombos = STRATEGIES.reduce((a, s) => a + s.grid.length, 0) * EXIT_GRID.length;
  let done = 0;
  const trainResults = [];

  for (const strat of STRATEGIES) {
    for (const params of strat.grid) {
      const signals = strat.run(candles, params);
      const trainSignals = signals.filter(s => s.index < splitIndex);
      for (const exitParams of EXIT_GRID) {
        const res = backtest(trainCandles, trainSignals, exitParams, { atrValues: atrFull });
        trainResults.push({
          strategyId: strat.id, name: strat.name, emoji: strat.emoji,
          params, exitParams, signals,
          train: res.metrics, trainScore: score(res.metrics),
        });
        done++;
      }
    }
    if (onProgress) onProgress(done, totalCombos, strat.name);
  }

  // Candidates for out-of-sample validation: overall top-5 + best per strategy.
  const sorted = [...trainResults].sort((a, b) => b.trainScore - a.trainScore);
  const candidates = new Set(sorted.slice(0, 5));
  for (const strat of STRATEGIES) {
    const best = sorted.find(r => r.strategyId === strat.id);
    if (best) candidates.add(best);
  }

  for (const cand of candidates) {
    const res = backtest(candles, cand.signals, cand.exitParams, {
      atrValues: atrFull, startIndex: splitIndex,
    });
    cand.test = res.metrics;
    cand.testScore = score(res.metrics);
  }

  // Leaderboard: best validated combo per strategy, ranked by test score.
  const leaderboard = [];
  for (const strat of STRATEGIES) {
    const rows = [...candidates].filter(r => r.strategyId === strat.id);
    if (!rows.length) continue;
    rows.sort((a, b) => b.testScore - a.testScore);
    const { signals, ...row } = rows[0]; // drop signals — not serializable-cheap
    leaderboard.push(row);
  }
  leaderboard.sort((a, b) => b.testScore - a.testScore);

  const champion = leaderboard.find(r => passesGuards(r.test)) || null;
  if (champion) champion.isChampion = true;

  return { champion, leaderboard, splitIndex };
}

// Full-period evaluation of one config — for chart markers / equity curve.
export function evaluateConfig(candles, config) {
  const strat = getStrategy(config.strategyId);
  if (!strat) return null;
  const signals = strat.run(candles, config.params);
  const res = backtest(candles, signals, config.exitParams);
  return { ...res, signals };
}
