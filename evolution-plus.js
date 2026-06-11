/*
 * evolution-plus.js — 進化エンジン増強モジュール
 *
 * 既存: GA進化 (23:59 JST)、Micro PDCA (4h)、マザー/子ボット階層、手動昇格
 * 追加:
 *   1. Hall of Fame — 歴代最強パラメータの永続保存
 *   2. Catch-up PDCA — ページ起動時に過去の未実行PDCA世代を一気に回す
 *   3. Auto-promotion — 3日連続カテゴリTop1の子botを自動的にマザー昇格
 *   4. 改良フィットネス関数 — ドローダウンペナルティ+一貫性+最近値重み
 *   5. Stagnation detection — 全体が停滞したらワイルドカード注入
 *   6. DNA export/import — 最強botのDNAをJSON化
 *   7. Daily AI Insights — 日次パフォーマンス分析文生成
 */
(function(){
  'use strict';

  const HOF_KEY_PREFIX = 'hof_';
  const PDCA_META_KEY_PREFIX = 'pdcaMeta_';
  const AUTO_PROMO_KEY_PREFIX = 'autoPromo_';

  // ═══════════════════════════════════════════════
  // 1. Hall of Fame — 歴代最強DNA永続保存
  // ═══════════════════════════════════════════════

  const HallOfFame = {
    data: {},  // coin -> [{botName, emoji, params, fitness, pnl, winRate, promotedAt}]

    key(coin){ return HOF_KEY_PREFIX + (coin || window.currentCoin || 'BTC'); },

    load(coin){
      try{
        const raw = localStorage.getItem(this.key(coin));
        if(!raw) return [];
        return JSON.parse(raw) || [];
      }catch(e){ return []; }
    },

    save(coin, list){
      try{
        localStorage.setItem(this.key(coin), JSON.stringify(list.slice(0, 20)));
      }catch(e){}
    },

    /**
     * 新しいエントリを追加 (既存botの更新または新規)
     */
    record(coin, entry){
      const list = this.load(coin);
      // 同じbotの以前のエントリを削除 (更新扱い)
      const filtered = list.filter(e => !(e.botId === entry.botId && Math.abs(e.fitness - entry.fitness) < 0.1));
      filtered.push({
        ...entry,
        recordedAt: Date.now(),
      });
      // フィットネスで降順ソート
      filtered.sort((a,b) => b.fitness - a.fitness);
      this.save(coin, filtered);
    },

    top(coin, n = 10){
      return this.load(coin).slice(0, n);
    },

    /**
     * PDCA後のスナップショット — Top-5を自動記録
     */
    snapshot(coin){
      if(!window.botStates || !window.ALL_BOTS) return;
      const top = [];
      window.ALL_BOTS.forEach(def => {
        const bs = window.botStates[def.id];
        if(!bs) return;
        const total = bs.totalWins + bs.totalLosses;
        if(total < 5) return; // 最低5トレード
        const fitness = calcFitnessPlus(bs);
        if(fitness > 0){
          top.push({
            botId: def.id,
            botName: def.name,
            emoji: def.emoji,
            tf: def.tf,
            style: def.style,
            params: JSON.parse(JSON.stringify(bs.params)),
            fitness,
            pnl: bs.totalPnlPct,
            winRate: bs.totalWins / total,
            totalTrades: total,
          });
        }
      });
      top.sort((a,b) => b.fitness - a.fitness);
      // Top-5 を記録
      top.slice(0, 5).forEach(entry => this.record(coin, entry));
    },
  };

  // ═══════════════════════════════════════════════
  // 2. 改良フィットネス関数
  // ═══════════════════════════════════════════════

  /**
   * 改良版フィットネス
   * - pnl
   * - winRate
   * - sharpe proxy
   * - drawdown penalty
   * - consistency (勝ち負けの分散小)
   * - recency (直近10トレード重視)
   */
  function calcFitnessPlus(bs){
    const total = (bs.totalWins||0) + (bs.totalLosses||0);
    if(total < 2) return 0;
    const winRate = bs.totalWins / total;
    const pnl = bs.totalPnlPct || 0;
    const trades = bs.trades || [];

    // --- Sharpe proxy (全トレード) ---
    const allPnls = trades.map(t => t.pnlPct || 0);
    const mean = allPnls.reduce((s,v)=>s+v,0) / Math.max(1, allPnls.length);
    const variance = allPnls.reduce((s,v)=>s+(v-mean)*(v-mean),0) / Math.max(1, allPnls.length);
    const std = Math.sqrt(variance) || 0.001;
    const sharpe = mean / std;

    // --- Drawdown ---
    let peak = 0, cum = 0, maxDD = 0;
    allPnls.forEach(p => {
      cum += p;
      if(cum > peak) peak = cum;
      const dd = peak - cum;
      if(dd > maxDD) maxDD = dd;
    });
    const ddPenalty = Math.min(20, maxDD); // 最大20点ペナルティ

    // --- 直近10トレードの成績 ---
    const recent = trades.slice(-10);
    const recentWinRate = recent.length > 0 ? recent.filter(t=>t.win).length / recent.length : winRate;
    const recentPnl = recent.reduce((s,t)=>s+(t.pnlPct||0), 0);

    // --- Consistency: 勝ち負けのPnL絶対値の変動係数 ---
    const wins = allPnls.filter(p => p > 0);
    const losses = allPnls.filter(p => p < 0).map(p => Math.abs(p));
    const avgWin = wins.length ? wins.reduce((s,v)=>s+v,0)/wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s,v)=>s+v,0)/losses.length : 0;
    const rr = avgLoss > 0 ? avgWin / avgLoss : 1.5;

    // Composite fitness
    const score =
      pnl * 0.30 +                                      // 累積PnL (percent)
      winRate * 100 * 0.20 +                            // 勝率 (0..100)
      Math.max(-3, Math.min(3, sharpe)) * 10 * 0.15 +   // Sharpe (clip)
      Math.max(-3, Math.min(3, rr - 1)) * 5 * 0.10 +    // リスクリワード比
      recentPnl * 0.15 +                                 // 直近10トレード
      recentWinRate * 100 * 0.10 +                      // 直近勝率
      0;

    return score - ddPenalty * 0.5; // DDペナルティ
  }

  window.calcFitnessPlus = calcFitnessPlus;

  // ═══════════════════════════════════════════════
  // 3. Catch-up PDCA — ページロード時に過去分を補完
  // ═══════════════════════════════════════════════

  function pdcaMetaKey(){ return PDCA_META_KEY_PREFIX + (window.currentCoin || 'BTC'); }

  function loadPdcaMeta(){
    try{
      const raw = localStorage.getItem(pdcaMetaKey());
      return raw ? JSON.parse(raw) : { lastRunDate: null, catchupCount: 0 };
    }catch(e){ return { lastRunDate: null, catchupCount: 0 }; }
  }

  function savePdcaMeta(meta){
    try{ localStorage.setItem(pdcaMetaKey(), JSON.stringify(meta)); }catch(e){}
  }

  function todayJstDate(){
    const d = new Date(Date.now() + 9*3600000);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(d1, d2){
    const a = new Date(d1), b = new Date(d2);
    return Math.floor((b - a) / 86400000);
  }

  /**
   * 過去のPDCAが漏れていたらまとめて実行
   */
  function catchUpPdca(){
    if(typeof window.runDailyPDCA !== 'function') return;
    const meta = loadPdcaMeta();
    const today = todayJstDate();
    if(!meta.lastRunDate){
      meta.lastRunDate = today;
      savePdcaMeta(meta);
      return;
    }
    const missedDays = daysBetween(meta.lastRunDate, today);
    if(missedDays < 1) return;

    console.log(`[EvolutionPlus] Catch-up PDCA: ${missedDays}日分補完`);
    // 最大7日分まで (それ以上は意味が薄いので1回にまとめる)
    const runs = Math.min(missedDays, 7);
    for(let i = 0; i < runs; i++){
      try{
        window.runDailyPDCA();
        meta.catchupCount = (meta.catchupCount||0) + 1;
      } catch(e){ console.warn('[EvolutionPlus] PDCA catch-up error:', e); }
    }
    meta.lastRunDate = today;
    savePdcaMeta(meta);
    // Catch-up後にHall of Fame更新
    HallOfFame.snapshot(window.currentCoin);

    // 通知
    if(window.showToast){
      window.showToast(`🧬 進化補完完了: ${runs}世代分を一気に進化しました`, 'success');
    }
  }

  // ═══════════════════════════════════════════════
  // 4. Auto-promotion — 3日連続Top1の子botを昇格
  // ═══════════════════════════════════════════════

  function autoPromoKey(){ return AUTO_PROMO_KEY_PREFIX + (window.currentCoin || 'BTC'); }

  function loadAutoPromo(){
    try{
      return JSON.parse(localStorage.getItem(autoPromoKey())) || {};
    }catch(e){ return {}; }
  }

  function saveAutoPromo(d){
    try{ localStorage.setItem(autoPromoKey(), JSON.stringify(d)); }catch(e){}
  }

  /**
   * 自動昇格チェック: 3日連続カテゴリTop1の子botを自動でマザー昇格
   */
  function checkAutoPromotion(){
    if(!window.botStates || !window.ALL_BOTS) return;
    const today = todayJstDate();
    const tracker = loadAutoPromo();

    // カテゴリ別にTop1を算出
    const categories = {};
    window.ALL_BOTS.forEach(def => {
      if(window.MOTHER_BOT_IDS && window.MOTHER_BOT_IDS.includes(def.id)) return;
      if(!def.isChild) return;
      const bs = window.botStates[def.id];
      if(!bs) return;
      const total = (bs.totalWins||0) + (bs.totalLosses||0);
      if(total < 10) return; // 最低10トレード
      const fit = calcFitnessPlus(bs);
      const key = `${def.tf}_${def.style}`;
      if(!categories[key]) categories[key] = [];
      categories[key].push({ def, fit });
    });

    let autoPromoted = 0;
    Object.entries(categories).forEach(([catKey, arr]) => {
      arr.sort((a,b) => b.fit - a.fit);
      const top = arr[0];
      if(!top) return;
      const botId = top.def.id;
      const record = tracker[botId] || { days: [], lastDate: null };

      if(record.lastDate !== today){
        record.days.push(today);
        record.lastDate = today;
        record.days = record.days.slice(-5);
      }

      // 3日連続チェック
      if(record.days.length >= 3){
        const last3 = record.days.slice(-3);
        const d0 = new Date(last3[0]);
        const d2 = new Date(last3[2]);
        const span = Math.floor((d2 - d0) / 86400000);
        if(span === 2 && last3.every((d, i, a) => {
          if(i === 0) return true;
          const prev = new Date(a[i-1]);
          const curr = new Date(d);
          return Math.floor((curr - prev) / 86400000) === 1;
        })){
          // Auto promote!
          autoPromoteBotById(botId);
          autoPromoted++;
          delete tracker[botId]; // reset tracker
          return;
        }
      }

      tracker[botId] = record;
    });

    // 他のbotのrecordは残しつつ、このカテゴリtop1以外の連続記録をリセット
    // (厳密にはcat内で変動したら即リセットすべきだが、簡易化)
    saveAutoPromo(tracker);

    if(autoPromoted > 0 && window.showToast){
      window.showToast(`🏆 ${autoPromoted}体のbotが自動昇格しました！`, 'success');
    }
  }

  /**
   * isAdminModeを一時的にONにしてpromoteChildToMotherを呼ぶ
   */
  function autoPromoteBotById(botId){
    try{
      const def = window.ALL_BOTS.find(d => d.id === botId);
      const bs = window.botStates[botId];
      if(!def || !bs || !def.isChild) return;

      // promotedBots配列に直接push (確認ダイアログなしで実行)
      const frozenParams = JSON.parse(JSON.stringify(bs.params));
      if(!window.promotedBots) window.promotedBots = [];
      window.promotedBots.push({
        id: botId,
        promotedFrom: def.motherId,
        promotedAt: new Date().toISOString(),
        frozenParams,
        originalName: def.name,
        autoPromoted: true,
      });

      if(window.MOTHER_BOT_IDS && !window.MOTHER_BOT_IDS.includes(botId)){
        window.MOTHER_BOT_IDS.push(botId);
      }
      def._promoted = true;
      def._promotedAt = new Date().toISOString();
      def._autoPromoted = true;
      if(window.BOT_DEFAULT_PARAMS) window.BOT_DEFAULT_PARAMS[botId] = frozenParams;

      bs.pdcaLog = bs.pdcaLog || [];
      bs.pdcaLog.push({
        time: Date.now(),
        msg: `【自動昇格】3日連続カテゴリTop1を達成！マザーbotに自動昇格。パラメータ固定。`,
      });

      // Hall of Fame記録
      HallOfFame.record(window.currentCoin, {
        botId,
        botName: def.name,
        emoji: def.emoji,
        tf: def.tf,
        style: def.style,
        params: frozenParams,
        fitness: calcFitnessPlus(bs),
        pnl: bs.totalPnlPct,
        winRate: bs.totalWins / (bs.totalWins + bs.totalLosses),
        totalTrades: bs.totalWins + bs.totalLosses,
        autoPromoted: true,
      });

      if(typeof window.savePromotedBots === 'function') window.savePromotedBots();
      if(typeof window.saveBotArena === 'function') window.saveBotArena();
      console.log(`[EvolutionPlus] 自動昇格: ${def.emoji} ${def.name}`);
    }catch(e){
      console.warn('[EvolutionPlus] Auto-promote error:', e);
    }
  }

  // ═══════════════════════════════════════════════
  // 5. Stagnation Detection
  // ═══════════════════════════════════════════════

  function detectStagnation(){
    if(!window.botStates || !window.ALL_BOTS) return false;
    const fits = [];
    window.ALL_BOTS.forEach(def => {
      const bs = window.botStates[def.id];
      if(bs && (bs.totalWins + bs.totalLosses) >= 3){
        fits.push(calcFitnessPlus(bs));
      }
    });
    if(fits.length < 5) return false;

    // 直近のフィットネス分散が小さい → 停滞
    const mean = fits.reduce((s,v)=>s+v,0) / fits.length;
    const variance = fits.reduce((s,v)=>s+(v-mean)*(v-mean),0) / fits.length;
    const std = Math.sqrt(variance);

    // 全体が赤字 && 分散小 → 停滞
    const allNegative = fits.every(f => f < 5);
    return allNegative && std < 3;
  }

  /**
   * 停滞打破: ワイルドカードを注入
   */
  function injectWildcards(){
    if(!window.botStates || !window.ALL_BOTS) return;
    let count = 0;
    window.ALL_BOTS.forEach(def => {
      if(window.MOTHER_BOT_IDS && window.MOTHER_BOT_IDS.includes(def.id)) return;
      if(!def.isChild) return;
      const bs = window.botStates[def.id];
      if(!bs || !bs.params) return;
      const fit = calcFitnessPlus(bs);
      if(fit < 0 && Math.random() < 0.4){
        // 激しくランダム化
        Object.keys(bs.params).forEach(k => {
          if(typeof bs.params[k] === 'number'){
            bs.params[k] *= (0.5 + Math.random() * 1.0); // 0.5x ~ 1.5x
            bs.params[k] = +bs.params[k].toFixed(4);
          }
        });
        bs.pdcaLog = bs.pdcaLog || [];
        bs.pdcaLog.push({
          time: Date.now(),
          msg: `【停滞打破】ワイルドカード変異を注入 — 大規模ランダム化`,
        });
        count++;
      }
    });
    if(count > 0){
      console.log(`[EvolutionPlus] 停滞検知 → ${count}体にワイルドカード注入`);
      if(window.saveBotArena) window.saveBotArena();
    }
  }

  // ═══════════════════════════════════════════════
  // 6. DNA Export/Import
  // ═══════════════════════════════════════════════

  function exportBotDNA(botId){
    const bs = window.botStates ? window.botStates[botId] : null;
    const def = window.ALL_BOTS ? window.ALL_BOTS.find(d => d.id === botId) : null;
    if(!bs || !def) return null;
    return {
      version: 1,
      botId,
      botName: def.name,
      emoji: def.emoji,
      tf: def.tf,
      style: def.style,
      params: bs.params,
      stats: {
        totalWins: bs.totalWins,
        totalLosses: bs.totalLosses,
        totalPnlPct: bs.totalPnlPct,
        fitness: calcFitnessPlus(bs),
      },
      exportedAt: new Date().toISOString(),
    };
  }

  function downloadDNA(botId){
    const dna = exportBotDNA(botId);
    if(!dna) return;
    const blob = new Blob([JSON.stringify(dna, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dna_${dna.botName}_${Date.now()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════
  // 7. Daily AI Insights
  // ═══════════════════════════════════════════════

  function generateAIInsights(){
    if(!window.botStates || !window.ALL_BOTS) return null;
    const insights = [];
    const today = todayJstDate();

    // 今日のトレードを集計
    const allTrades = [];
    Object.entries(window.botStates).forEach(([id, bs]) => {
      (bs.trades||[]).forEach(t => {
        if(t.exitTime && t.exitTime.startsWith(today)){
          allTrades.push({ botId: id, ...t });
        }
      });
    });

    if(allTrades.length === 0){
      return { insights: ['本日はまだトレードがありません。'], summary: null };
    }

    // 勝率
    const wins = allTrades.filter(t => t.win).length;
    const winRate = (wins / allTrades.length * 100).toFixed(1);
    const totalPnl = allTrades.reduce((s,t) => s + (t.pnlPct||0), 0);

    // 最強bot
    const byBot = {};
    allTrades.forEach(t => {
      if(!byBot[t.botId]) byBot[t.botId] = { wins:0, losses:0, pnl:0, count:0 };
      byBot[t.botId].count++;
      byBot[t.botId].pnl += (t.pnlPct||0);
      if(t.win) byBot[t.botId].wins++; else byBot[t.botId].losses++;
    });
    const bestBotId = Object.entries(byBot).sort((a,b) => b[1].pnl - a[1].pnl)[0]?.[0];
    const worstBotId = Object.entries(byBot).sort((a,b) => a[1].pnl - b[1].pnl)[0]?.[0];
    const bestDef = window.ALL_BOTS.find(d => d.id === bestBotId);
    const worstDef = window.ALL_BOTS.find(d => d.id === worstBotId);

    // 方向性
    const longs = allTrades.filter(t => t.dir === 'LONG');
    const shorts = allTrades.filter(t => t.dir === 'SHORT');
    const longWR = longs.length ? (longs.filter(t=>t.win).length / longs.length * 100).toFixed(0) : 'N/A';
    const shortWR = shorts.length ? (shorts.filter(t=>t.win).length / shorts.length * 100).toFixed(0) : 'N/A';

    insights.push(`本日のトレード数: ${allTrades.length}件 (勝率${winRate}% / 総P&L${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}%)`);
    if(bestDef && byBot[bestBotId].pnl > 0){
      insights.push(`🏆 最強: ${bestDef.emoji} ${bestDef.name} (${byBot[bestBotId].wins}勝${byBot[bestBotId].losses}敗 / +${byBot[bestBotId].pnl.toFixed(2)}%)`);
    }
    if(worstDef && byBot[worstBotId].pnl < 0){
      insights.push(`💸 不調: ${worstDef.emoji} ${worstDef.name} (${byBot[worstBotId].wins}勝${byBot[worstBotId].losses}敗 / ${byBot[worstBotId].pnl.toFixed(2)}%)`);
    }
    insights.push(`方向性: LONG勝率${longWR}% (${longs.length}件) / SHORT勝率${shortWR}% (${shorts.length}件)`);

    // 相場解釈
    if(longs.length > shorts.length * 2 && parseFloat(longWR) > 60){
      insights.push(`📈 強いロングバイアス相場。トレンドフォロー順張り優位。`);
    } else if(shorts.length > longs.length * 2 && parseFloat(shortWR) > 60){
      insights.push(`📉 強いショートバイアス相場。下降トレンドフォロー優位。`);
    } else if(parseFloat(winRate) < 45){
      insights.push(`⚠️ チョッピー相場の可能性。エントリー基準を厳しくすべき。`);
    }

    return {
      insights,
      summary: { winRate, totalPnl, tradeCount: allTrades.length, bestBotId, worstBotId },
    };
  }

  // ═══════════════════════════════════════════════
  // 8. Public API
  // ═══════════════════════════════════════════════

  window.EvolutionPlus = {
    HallOfFame,
    calcFitnessPlus,
    catchUpPdca,
    checkAutoPromotion,
    detectStagnation,
    injectWildcards,
    exportBotDNA,
    downloadDNA,
    generateAIInsights,
    todayJstDate,
  };

  // ═══════════════════════════════════════════════
  // 9. 自動起動ロジック
  // ═══════════════════════════════════════════════

  function startLoops(){
    // ページロード後5秒でcatch-up PDCA実行
    setTimeout(() => {
      try{ catchUpPdca(); }catch(e){ console.warn('[EvolutionPlus] catchUpPdca error:', e); }
    }, 5000);

    // 15分ごとに自動昇格チェック
    setInterval(() => {
      try{ checkAutoPromotion(); }catch(e){}
    }, 15 * 60 * 1000);

    // 1時間ごとに停滞検知 → ワイルドカード注入
    setInterval(() => {
      try{
        if(detectStagnation()){
          console.log('[EvolutionPlus] 停滞検知');
          injectWildcards();
        }
      }catch(e){}
    }, 60 * 60 * 1000);

    // 10分ごとにHall of Fame更新
    setInterval(() => {
      try{ HallOfFame.snapshot(window.currentCoin); }catch(e){}
    }, 10 * 60 * 1000);
  }

  function init(){
    const wait = () => {
      if(typeof window.currentCoin === 'undefined' || typeof window.runDailyPDCA !== 'function'){
        setTimeout(wait, 500);
        return;
      }
      startLoops();
      console.log('[EvolutionPlus] loaded — Hall of Fame + Auto-promotion + Catch-up PDCA active');
    };
    wait();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
