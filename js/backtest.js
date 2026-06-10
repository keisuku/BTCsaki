// Backtest engine. One position at a time, long+short, compounding equity.
// Entry at the NEXT candle open after a signal (no lookahead). Exits:
//   - ATR-based SL/TP checked intra-candle vs high/low (SL first if both touch — conservative)
//   - opposite signal closes/reverses at next open; 'exit' signal closes at next open
// Fees deducted per side.

import { atr as calcAtr } from './indicators.js';
import { FEE_PER_SIDE, ATR_EXIT_PERIOD } from './config.js';

export function backtest(candles, signals, exitParams, opts = {}) {
  const { slAtr, tpAtr } = exitParams;
  const fee = opts.feePerSide ?? FEE_PER_SIDE;
  const atrValues = opts.atrValues ?? calcAtr(candles, ATR_EXIT_PERIOD);
  const startIndex = opts.startIndex ?? 0;

  const sigAt = new Map();
  for (const s of signals) {
    if (s.index >= startIndex) sigAt.set(s.index, s.side);
  }

  const trades = [];
  const equityCurve = [];
  let equity = 1;
  let pos = null; // {side, entryIndex, entryPrice, sl, tp}
  let pending = null; // action decided on previous candle close

  const closePos = (i, price, reason) => {
    const raw = pos.side === 'long'
      ? price / pos.entryPrice - 1
      : 1 - price / pos.entryPrice;
    const ret = raw - fee * 2;
    equity *= 1 + ret;
    trades.push({
      side: pos.side,
      entryIndex: pos.entryIndex, entryPrice: pos.entryPrice,
      exitIndex: i, exitPrice: price,
      retPct: ret * 100, reason,
    });
    pos = null;
  };

  for (let i = startIndex; i < candles.length; i++) {
    const c = candles[i];

    // 1. Execute action decided at previous candle close, at this open.
    if (pending) {
      if (pos) closePos(i, c.open, 'flip');
      if (pending.side === 'long' || pending.side === 'short') {
        const a = pending.atr;
        if (a != null && a > 0) {
          pos = {
            side: pending.side,
            entryIndex: i,
            entryPrice: c.open,
            sl: pending.side === 'long' ? c.open - slAtr * a : c.open + slAtr * a,
            tp: pending.side === 'long' ? c.open + tpAtr * a : c.open - tpAtr * a,
          };
        }
      }
      pending = null;
    }

    // 2. Intra-candle SL/TP check (SL first — conservative).
    if (pos) {
      if (pos.side === 'long') {
        if (c.low <= pos.sl) closePos(i, pos.sl, 'sl');
        else if (c.high >= pos.tp) closePos(i, pos.tp, 'tp');
      } else {
        if (c.high >= pos.sl) closePos(i, pos.sl, 'sl');
        else if (c.low <= pos.tp) closePos(i, pos.tp, 'tp');
      }
    }

    // 3. Read signal at this candle close → act at next open.
    const side = sigAt.get(i);
    if (side) {
      if (side === 'exit') {
        if (pos) pending = { side: 'exit' };
      } else if (!pos || pos.side !== side) {
        pending = { side, atr: atrValues[i] };
      }
    }

    // 4. Mark-to-market equity curve.
    let mtm = equity;
    if (pos) {
      const raw = pos.side === 'long'
        ? c.close / pos.entryPrice - 1
        : 1 - c.close / pos.entryPrice;
      mtm = equity * (1 + raw);
    }
    equityCurve.push({ time: c.time, value: mtm });
  }

  // Close any open position at the last close.
  if (pos) {
    const last = candles.length - 1;
    closePos(last, candles[last].close, 'eod');
    equityCurve[equityCurve.length - 1] = { time: candles[last].time, value: equity };
  }

  return { trades, equityCurve, metrics: computeMetrics(trades, equityCurve, equity) };
}

function computeMetrics(trades, equityCurve, finalEquity) {
  const n = trades.length;
  const rets = trades.map(t => t.retPct);
  const wins = rets.filter(r => r > 0);
  const losses = rets.filter(r => r <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) {
    if (p.value > peak) peak = p.value;
    const dd = (peak - p.value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;

  return {
    netPnlPct: (finalEquity - 1) * 100,
    winRate: n ? (wins.length / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0,
    maxDrawdownPct: maxDD * 100,
    tradeCount: n,
    avgTradePct: mean,
  };
}
