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
  let extSeries = null;  // { fr, ls, fg } 履歴ポイント列 (window.BotHistory経由)
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
    // 外部指標履歴(funding/L&S/F&G) — 失敗してもnullで続行(ゲート中立)
    try {
      if (window.BotHistory) {
        const pair = (window.COINS && window.COINS[coin] && window.COINS[coin].pair) || 'BTCUSDT';
        extSeries = await window.BotHistory.fetchAll(pair);
        log(`外部指標履歴: FR ${extSeries.fr.length}点 / L&S ${extSeries.ls.length}点 / F&G ${extSeries.fg.length}点`);
      }
    } catch (e) { extSeries = null; }
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
      const r = window.BotBacktest.fitnessFor(def, bs.params, klines, liveFitPlus, buildCtx());
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

  // ── グリッド探索注入: GAのランダム変異を待たず、チャンピオン近傍の
  //    パラメータをウォークフォワード探索して勝てる設定を直接注入する ──
  const GRID_KEYS = ['scoreEntry', 'rsiOS', 'rsiOB', 'tpPct', 'slPct', 'timeoutMin',
    'volSurgeMult', 'momThresh', 'entryZone', 'bbMult'];
  const GRID_MULTS = [0.85, 1.0, 1.15];
  const PARAM_BOUNDS = {
    scoreEntry: [38, 75], rsiOS: [10, 45], rsiOB: [55, 90],
    tpPct: [0.05, 2.5], slPct: [0.03, 1.2], timeoutMin: [1, 180],
    volSurgeMult: [1.05, 4], momThresh: [0.01, 0.5], entryZone: [10, 45], bbMult: [1.2, 3.5],
  };

  function clampParam(key, v) {
    const b = PARAM_BOUNDS[key];
    if (!b) return v;
    v = Math.max(b[0], Math.min(b[1], v));
    return key === 'timeoutMin' ? Math.round(v) : +v.toFixed(4);
  }

  // テスト側(後半30%)のトレードだけでフィットネスを算出
  function testFitness(def, params, klines, splitIdx) {
    try {
      const res = window.BotBacktest.runBot(def, params, klines, buildCtx());
      if (!res) return null;
      const testTrades = res.trades.filter(t => t.entryIndex >= splitIdx);
      if (testTrades.length < 3) return null;
      return liveFitPlus(window.BotBacktest.pseudoState(testTrades));
    } catch (e) { return null; }
  }

  async function gridSearchInjection() {
    const bots = window.ALL_BOTS || [];
    const states = window.botStates || {};
    const motherIds = window.MOTHER_BOT_IDS || [];
    if (!bots.length || typeof liveFitPlus !== 'function') return;

    // カテゴリ分け(GAと同じ tf×style)
    const cats = {};
    bots.forEach(d => {
      const key = `${d.tf}_${d.style}`;
      (cats[key] = cats[key] || []).push(d);
    });

    let injected = 0;
    for (const [cat, members] of Object.entries(cats)) {
      const ranked = members
        .map(d => ({ d, bs: states[d.id] }))
        .filter(x => x.bs && x.bs.params)
        .sort((a, b) => (window.calcFitnessPlus(b.bs) || 0) - (window.calcFitnessPlus(a.bs) || 0));
      if (ranked.length < 2) continue;
      const champ = ranked[0];
      const klines = klineCache[champ.d.tf];
      if (!klines || klines.length < 300) continue;
      const splitIdx = Math.floor(klines.length * 0.7);
      const trainKl = klines.slice(0, splitIdx);

      const keys = GRID_KEYS.filter(k => typeof champ.bs.params[k] === 'number').slice(0, 4);
      if (!keys.length) continue;

      // train側でグリッド全探索
      const combos = [];
      const rec = (i, cur) => {
        if (i === keys.length) { combos.push(cur); return; }
        for (const m of GRID_MULTS) {
          rec(i + 1, { ...cur, [keys[i]]: clampParam(keys[i], champ.bs.params[keys[i]] * m) });
        }
      };
      rec(0, {});
      const scored = [];
      for (const ov of combos) {
        const params = { ...champ.bs.params, ...ov };
        try {
          const res = window.BotBacktest.runBot(champ.d, params, trainKl, buildCtx());
          if (!res || res.trades.length < 3) continue;
          scored.push({ ov, fit: liveFitPlus(window.BotBacktest.pseudoState(res.trades)) });
        } catch (e) {}
      }
      if (!scored.length) { await sleep(0); continue; }
      scored.sort((a, b) => b.fit - a.fit);

      // 上位3をtest側(未知データ)で検証、ベースラインと比較
      const baseline = testFitness(champ.d, champ.bs.params, klines, splitIdx);
      let best = null;
      for (const cand of scored.slice(0, 3)) {
        const f = testFitness(champ.d, { ...champ.bs.params, ...cand.ov }, klines, splitIdx);
        if (f != null && (!best || f > best.f)) best = { f, ov: cand.ov };
      }
      const margin = baseline == null ? 0 : Math.max(2, Math.abs(baseline) * 0.1);
      if (best && (baseline == null || best.f > baseline + margin)) {
        // カテゴリ最下位2体(非マザー)に注入
        const targets = ranked.slice(-2).filter(x => !motherIds.includes(x.d.id));
        for (const t of targets) {
          Object.assign(t.bs.params, best.ov);
          if (Array.isArray(t.bs.pdcaLog)) {
            t.bs.pdcaLog.push({ time: Date.now(), msg: `⚡グリッド探索で最適化: ${Object.keys(best.ov).join(',')} (検証fit ${best.f.toFixed(1)})` });
            if (t.bs.pdcaLog.length > 10) t.bs.pdcaLog.shift();
          }
          injected++;
        }
        btCache.clear();
      }
      await sleep(0); // UIを固めない
    }
    if (injected) {
      log(`グリッド探索注入: ${injected}体のパラメータを検証済み最適値へ更新`);
      try { if (typeof window.saveBotArena === 'function') window.saveBotArena(); } catch (e) {}
      emit('evoboost-grid', { injected });
    }
  }

  function buildCtx() {
    return { series: extSeries, klinesByTf: klineCache };
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
    if (ok) {
      await instantEvolution();
      await gridSearchInjection();
    }

    // コイン切替検知 + 毎時のkline更新+グリッド再探索
    setInterval(() => {
      if ((window.currentCoin || 'BTC') !== cacheCoin) loadKlines();
    }, 5000);
    setInterval(async () => { if (await loadKlines()) gridSearchInjection(); }, 3600000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
})();
