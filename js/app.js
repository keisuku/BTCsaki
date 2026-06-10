// Orchestrator: data flow, worker, persistence, live polling.

import { COINS, DEFAULT_COIN, DEFAULT_TF, KLINE_LIMIT, POLL_MS, REOPTIMIZE_MS, STORAGE_PREFIX, ATR_EXIT_PERIOD } from './config.js';
import { fetchKlines, fetchTicker, fetchFearGreed } from './data.js';
import { optimize, evaluateConfig } from './optimizer.js';
import { getStrategy } from './strategies.js';
import { atr as calcAtr } from './indicators.js';
import { MainChart, EquityChart } from './chart.js';
import * as ui from './ui.js';

const state = {
  coin: DEFAULT_COIN,
  tf: DEFAULT_TF,
  candles: [],          // includes the in-progress last candle
  result: null,         // { champion, leaderboard, splitIndex }
  selectedIdx: 0,
  stale: false,
  epoch: 0,             // bumped on coin/tf switch to cancel async work
};

let mainChart, equityChart, worker, pollTimer, reoptTimer;

// ---------------------------------------------------------------- persistence

const storeKey = () => `${STORAGE_PREFIX}:result:${state.coin}:${state.tf}`;

function loadCached() {
  try {
    const raw = localStorage.getItem(storeKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCached(result) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ ...result, optimizedAt: Date.now() }));
  } catch { /* storage full — non-fatal */ }
}

// ---------------------------------------------------------------- optimization

function runOptimization(candles, onProgress) {
  return new Promise((resolve, reject) => {
    if (worker) {
      const id = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.data.id !== id) return;
        if (e.data.type === 'progress') onProgress(e.data.done, e.data.total, e.data.name);
        else {
          worker.removeEventListener('message', onMsg);
          if (e.data.type === 'result') resolve(e.data.result);
          else reject(new Error(e.data.message));
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id, candles });
    } else {
      // main-thread fallback (~1-3s, blocks UI briefly)
      setTimeout(() => {
        try { resolve(optimize(candles, onProgress)); } catch (err) { reject(err); }
      }, 50);
    }
  });
}

// ---------------------------------------------------------------- live verdict

// Closed candles only: Binance returns the in-progress candle last.
const closedCandles = () => state.candles.slice(0, -1);

function computeVerdict() {
  const champion = state.result?.champion;
  if (!champion) return null;
  const candles = closedCandles();
  const ev = evaluateConfig(candles, champion);
  if (!ev) return null;
  const last = ev.trades[ev.trades.length - 1];
  // Position still open at data end = the champion bot is in a trade right now.
  if (last && last.reason === 'eod' && last.exitIndex === candles.length - 1) {
    const atrValues = calcAtr(candles, ATR_EXIT_PERIOD);
    const a = atrValues[last.entryIndex - 1] ?? atrValues[atrValues.length - 1];
    const e = last.entryPrice;
    const sign = last.side === 'long' ? 1 : -1;
    return {
      side: last.side === 'long' ? 'LONG' : 'SHORT',
      entry: e,
      tp: e + sign * champion.exitParams.tpAtr * a,
      sl: e - sign * champion.exitParams.slAtr * a,
    };
  }
  return { side: 'WAIT' };
}

function refreshSignalPanel() {
  const verdict = state.result ? computeVerdict() : undefined;
  ui.renderSignalPanel({
    coin: state.coin,
    verdict,
    champion: state.result?.champion || null,
    stale: state.stale,
  });
  mainChart.setLiveLines(verdict && verdict.side !== 'WAIT'
    ? { entry: verdict.entry, tp: verdict.tp, sl: verdict.sl } : null);
}

// ---------------------------------------------------------------- rendering

function selectRow(i) {
  state.selectedIdx = i;
  const rows = state.result?.leaderboard || [];
  ui.renderLeaderboard(rows, i, selectRow);
  const row = rows[i];
  if (!row) return;
  const candles = closedCandles();
  const ev = evaluateConfig(candles, row);
  if (!ev) return;
  mainChart.setTradeMarkers(ev.trades, candles);
  const strat = getStrategy(row.strategyId);
  mainChart.setOverlays(strat?.overlays ? strat.overlays(candles, row.params) : []);
  const splitTime = candles[state.result.splitIndex]?.time ?? null;
  equityChart.setData(ev.equityCurve, splitTime);
}

function applyResult(result, { stale, optimizedAt }) {
  state.result = result;
  state.stale = stale;
  const champIdx = result.leaderboard.findIndex(r => r.isChampion);
  ui.renderOptimizedAt(optimizedAt);
  selectRow(champIdx >= 0 ? champIdx : 0);
  refreshSignalPanel();
}

// ---------------------------------------------------------------- main flow

async function loadView() {
  const epoch = ++state.epoch;
  clearInterval(pollTimer);
  clearTimeout(reoptTimer);
  ui.updateSelectors(state);
  ui.renderSignalPanel({ coin: state.coin, verdict: undefined, champion: null, stale: false });
  ui.renderLeaderboard(null);

  const { symbol } = COINS[state.coin];

  // Fetch fresh klines + ticker.
  let candles, ticker;
  try {
    [candles, ticker] = await Promise.all([
      fetchKlines(symbol, state.tf, KLINE_LIMIT),
      fetchTicker(symbol),
    ]);
  } catch (err) {
    if (epoch !== state.epoch) return;
    document.getElementById('progressText').textContent = `データ取得失敗: ${err.message}`;
    return;
  }
  if (epoch !== state.epoch) return;

  state.candles = candles;
  mainChart.setCandles(candles);
  mainChart.fit();
  ui.renderTicker(state.coin, ticker);

  // Instant render from cache while re-optimizing.
  const cached = loadCached();
  if (cached?.leaderboard) {
    applyResult(cached, { stale: true, optimizedAt: cached.optimizedAt });
  }

  // Re-optimize on fresh closed candles.
  try {
    const result = await runOptimization(closedCandles(), (done, total, name) => {
      if (epoch === state.epoch) ui.renderProgress(done, total, name);
    });
    if (epoch !== state.epoch) return;
    ui.renderProgress(1, 1);
    saveCached(result);
    applyResult(result, { stale: false, optimizedAt: Date.now() });
  } catch (err) {
    if (epoch !== state.epoch) return;
    console.error('optimization failed', err);
    document.getElementById('progressText').textContent = `分析エラー: ${err.message}`;
  }

  startPolling(epoch, symbol);
  reoptTimer = setTimeout(() => { if (epoch === state.epoch) loadView(); }, REOPTIMIZE_MS);
}

function startPolling(epoch, symbol) {
  pollTimer = setInterval(async () => {
    if (epoch !== state.epoch || document.hidden) return;
    try {
      const [recent, ticker] = await Promise.all([
        fetchKlines(symbol, state.tf, 3),
        fetchTicker(symbol),
      ]);
      if (epoch !== state.epoch) return;
      ui.renderTicker(state.coin, ticker);

      const lastKnown = state.candles[state.candles.length - 1];
      let newClosed = false;
      for (const c of recent) {
        if (c.time > lastKnown.time) {
          state.candles.push(c);
          newClosed = true;
          mainChart.updateLastCandle(c);
        } else {
          // Update known candles in place (covers the in-progress one).
          for (let i = state.candles.length - 1; i >= Math.max(0, state.candles.length - 4); i--) {
            if (state.candles[i].time === c.time) {
              state.candles[i] = c;
              mainChart.updateLastCandle(c);
              break;
            }
          }
        }
      }
      // A previously in-progress candle has closed → re-evaluate the champion.
      if (newClosed) refreshSignalPanel();
    } catch { /* transient network error — next tick retries */ }
  }, POLL_MS[state.tf]);
}

// ---------------------------------------------------------------- boot

function boot() {
  mainChart = new MainChart(document.getElementById('mainChart'));
  equityChart = new EquityChart(document.getElementById('equityChart'));

  try {
    worker = new Worker('./js/worker.js', { type: 'module' });
    worker.onerror = (e) => {
      console.warn('worker failed, falling back to main thread', e.message);
      worker = null;
    };
  } catch {
    worker = null;
  }

  ui.buildSelectors(state,
    coin => { if (coin !== state.coin) { state.coin = coin; loadView(); } },
    tf => { if (tf !== state.tf) { state.tf = tf; loadView(); } });

  fetchFearGreed().then(ui.renderFearGreed);
  loadView();
}

boot();
