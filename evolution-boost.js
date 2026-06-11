// ═══════════════════════════════════════════════
// EVOLUTION BOOST — 自己改善のバックテスト駆動化
//
// 旧来の問題: botはブラウザを開いている間しかpaper tradeできず、
// 23:59のGA進化は評価材料(トレード)が無いまま空転していた。
//
// 修理内容:
//  1. 各botのTFについて過去1000本のklineをキャッシュ
//  2. calcFitness / calcFitnessPlus をブレンド版に差し替え
//     (ライブトレードが少ないうちはバックテスト適応度が支配、
//      30トレード蓄積後はライブ実績が支配)
//  3. ページロード時にライブ実績が薄ければ runDailyPDCA を
//     即時実行(最大3世代) — GAがその場で本当に進化する
//
// 既存ファイルは無改変。windowラップのみ(arena-plus.jsと同パターン)。
// ═══════════════════════════════════════════════
(function () {
  'use strict';
  const TAG = '[EvolutionBoost]';
  const KLINE_LIMIT = 1000;
  const INSTANT_EVO_GENERATIONS = 3;
  const INSTANT_EVO_MIN_GAP_MS = 6 * 3600000; // 同一コインで6時間に1回まで
  const BT_CACHE_MAX = 600;

  let klineCache = {};   // tf -> raw Binance klines (current coin)
  let cacheCoin = null;
  let btCache = new Map(); // botId|paramsHash -> fitness result
  let liveFitPlus = null;  // オーバーライド前の calcFitnessPlus 原本
  let ready = false;

  function log(...a) { try { console.log(TAG, ...a); } catch (e) {} }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) {}
  }

  // ── kline取得(S.k*には触らない。独立キャッシュ) ──
  async function fetchTf(tf) {
    const coin = window.currentCoin || 'BTC';
    const pair = (window.COINS && window.COINS[coin] && window.COINS[coin].pair) || 'BTCUSDT';
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=${KLINE_LIMIT}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loadKlines() {
    const bots = window.ALL_BOTS || [];
    const tfs = [...new Set(bots.map(d => d.tf))];
    const coin = window.currentCoin || 'BTC';
    const next = {};
    for (const tf of tfs) {
      try {
        next[tf] = await fetchTf(tf);
      } catch (e) {
        log('kline取得失敗', tf, e.message);
      }
    }
    klineCache = next;
    cacheCoin = coin;
    btCache.clear();
    const loaded = Object.keys(next).length;
    log(`過去${KLINE_LIMIT}本キャッシュ完了: ${loaded}/${tfs.length} TF (${coin})`);
    emit('evoboost-klines', { coin, tfs: Object.keys(next) });
    return loaded > 0;
  }

  // ── バックテスト適応度(botId+paramsでキャッシュ) ──
  function btResultFor(bs) {
    try {
      if (!bs || !bs.params || !window.BotBacktest) return null;
      const def = (window.ALL_BOTS || []).find(d => d.id === bs.id);
      if (!def) return null;
      const klines = klineCache[def.tf];
      if (!klines || klines.length < 100) return null;
      const key = bs.id + '|' + JSON.stringify(bs.params);
      if (btCache.has(key)) return btCache.get(key);
      const r = window.BotBacktest.fitnessFor(def, bs.params, klines, liveFitPlus);
      if (btCache.size > BT_CACHE_MAX) btCache.clear();
      btCache.set(key, r);
      return r;
    } catch (e) {
      return null;
    }
  }

  // ── フィットネスのブレンド差し替え ──
  function installFitnessOverride() {
    liveFitPlus = window.calcFitnessPlus || window.calcFitness;
    if (typeof liveFitPlus !== 'function') { log('calcFitnessPlus不在 — 差し替え中止'); return false; }
    const blended = function (bs) {
      const live = liveFitPlus(bs);
      const bt = btResultFor(bs);
      if (!bt || !isFinite(bt.fitness)) return live;
      const n = (bs.totalWins || 0) + (bs.totalLosses || 0);
      const w = Math.min(1, n / 30);
      return w * live + (1 - w) * bt.fitness;
    };
    // GA(素のcalcFitness呼び出し)もmetabot/HoF(calcFitnessPlus)も両方介入
    window.calcFitness = blended;
    window.calcFitnessPlus = blended;
    log('フィットネス差し替え完了: バックテスト+ライブのブレンド評価');
    return true;
  }

  // ── 即時進化: ライブ実績が薄ければその場でGAを回す ──
  async function instantEvolution() {
    const bots = window.ALL_BOTS || [];
    const states = window.botStates || {};
    const counts = bots.map(d => ((states[d.id] || {}).trades || []).length).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const coin = window.currentCoin || 'BTC';
    const lastKey = `evoBoostLast_${coin}`;
    const last = parseInt(localStorage.getItem(lastKey) || '0');
    if (Date.now() - last < INSTANT_EVO_MIN_GAP_MS) {
      log(`即時進化スキップ(前回から${((Date.now() - last) / 3600000).toFixed(1)}h)`);
      emit('evoboost-done', { ran: false });
      return;
    }
    if (typeof window.runDailyPDCA !== 'function') { emit('evoboost-done', { ran: false }); return; }

    log(`即時進化開始: ライブトレード中央値=${median} → ${INSTANT_EVO_GENERATIONS}世代を即時実行`);
    emit('evoboost-start', { generations: INSTANT_EVO_GENERATIONS, median });
    for (let g = 1; g <= INSTANT_EVO_GENERATIONS; g++) {
      emit('evoboost-progress', { gen: g, total: INSTANT_EVO_GENERATIONS, fitness: snapshotFitness() });
      try { window.runDailyPDCA(); } catch (e) { log('GA実行エラー', e); break; }
      await sleep(400); // オーバーレイ演出が見えるように世代間で一拍
    }
    localStorage.setItem(lastKey, String(Date.now()));
    try { if (typeof window.saveBotArena === 'function') window.saveBotArena(); } catch (e) {}
    emit('evoboost-done', { ran: true, fitness: snapshotFitness() });
    log('即時進化完了 — botパラメータはバックテスト適応度で進化済み');
  }

  function snapshotFitness() {
    const out = {};
    try {
      const states = window.botStates || {};
      (window.ALL_BOTS || []).forEach(d => {
        const bs = states[d.id];
        if (!bs) return;
        const bt = btResultFor(bs);
        out[d.id] = {
          fitness: +(window.calcFitnessPlus ? window.calcFitnessPlus(bs) : 0).toFixed(2),
          btWinRate: bt ? +bt.winRate.toFixed(1) : null,
          btPnl: bt ? +bt.pnlPct.toFixed(2) : null,
          btTrades: bt ? bt.tradeCount : null,
        };
      });
    } catch (e) {}
    return out;
  }

  // ── 公開API(cockpit-plus用) ──
  window.EvolutionBoost = {
    isReady: () => ready,
    btResultFor: (botId) => {
      const bs = (window.botStates || {})[botId];
      return bs ? btResultFor(bs) : null;
    },
    snapshotFitness,
    klines: (tf) => klineCache[tf] || null,
    reload: loadKlines,
  };

  // ── 起動シーケンス ──
  async function init() {
    // BotBacktest(ESモジュール)を待つ — イベント+ポーリング両対応
    for (let i = 0; i < 100 && !window.BotBacktest; i++) await sleep(100);
    if (!window.BotBacktest) { log('BotBacktest不在 — 起動中止'); return; }
    // 旧アプリ本体のbridge(window.ALL_BOTS等)を待つ
    for (let i = 0; i < 100 && !(window.ALL_BOTS && window.ALL_BOTS.length); i++) await sleep(150);
    if (!window.ALL_BOTS) { log('ALL_BOTS不在 — 起動中止'); return; }

    const ok = await loadKlines();
    installFitnessOverride();
    ready = true;
    if (ok) await instantEvolution();

    // コイン切替検知 + 毎時のkline更新
    setInterval(() => {
      if ((window.currentCoin || 'BTC') !== cacheCoin) loadKlines();
    }, 5000);
    setInterval(loadKlines, 3600000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
})();
