/*
 * realtime-plus.js — 真のリアルタイムCVD/オーダーフロー/ボリュームプロファイル
 *
 * 既存: @aggTradeで価格のみ使用。@kline_5mでOHLCV更新
 * 追加:
 *   1. 真のCVD — @aggTradeのm (buyer is maker) フラグから正確な買い/売り圧を累積
 *   2. Kline[9] (takerBuyBaseAssetVolume) を利用した真のDelta
 *   3. @depth20@100ms によるDOM (板) リアルタイム → 板の厚み非対称度
 *   4. ボリュームプロファイル — 価格帯別出来高 → POC/VAH/VAL
 *   5. 清算クラスタ推定 — OI急変+FR極端+L/S偏りから確率的に算出
 *   6. CVDダイバージェンス検出 — 価格↑だがCVD↓ → 弱気警告
 */
(function(){
  'use strict';

  // ═══════════════════════════════════════════════
  // 1. True CVD Engine (Cumulative Volume Delta)
  // ═══════════════════════════════════════════════

  const CVD = {
    series: [],           // [{t, cvd, price, buyVol, sellVol}]
    currentBucket: null,  // 5秒バケット集計中
    bucketMs: 5000,       // 5秒ごとに記録
    maxLen: 720,          // 1時間分 (720 * 5s)
    total: 0,             // 累積CVD
    sessionStart: 0,      // UTC 00:00でリセット
    sessionStartCvd: 0,

    init(){
      this._resetIfNewSession();
      // 過去履歴をlocalStorageから復元
      try{
        const saved = localStorage.getItem(`cvd_${window.currentCoin || 'BTC'}`);
        if(saved){
          const obj = JSON.parse(saved);
          if(obj && obj.sessionStart === this._todayUtcMs()){
            this.series = obj.series || [];
            this.total = obj.total || 0;
          }
        }
      }catch(e){}
    },

    _todayUtcMs(){
      const d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    },

    _resetIfNewSession(){
      const today = this._todayUtcMs();
      if(this.sessionStart !== today){
        this.sessionStart = today;
        this.total = 0;
        this.series = [];
        this.sessionStartCvd = 0;
      }
    },

    /**
     * aggTradeメッセージを処理。m=true → buyer is maker → 成行売り
     */
    ingestAggTrade(d){
      this._resetIfNewSession();
      const price = parseFloat(d.p);
      const qty   = parseFloat(d.q);
      const isSell = d.m === true; // maker=buyer → trade executed by seller taker
      const delta = isSell ? -qty : qty;
      this.total += delta;

      const now = d.T || Date.now();
      const bucketKey = Math.floor(now / this.bucketMs) * this.bucketMs;
      if(!this.currentBucket || this.currentBucket.t !== bucketKey){
        if(this.currentBucket){
          this.series.push(this.currentBucket);
          if(this.series.length > this.maxLen) this.series.shift();
        }
        this.currentBucket = { t: bucketKey, cvd: this.total, price, buyVol: 0, sellVol: 0 };
      }
      this.currentBucket.price = price;
      this.currentBucket.cvd   = this.total;
      if(isSell) this.currentBucket.sellVol += qty; else this.currentBucket.buyVol += qty;

      // Periodic save
      if(Math.random() < 0.01) this._save();
    },

    _save(){
      try{
        localStorage.setItem(`cvd_${window.currentCoin || 'BTC'}`, JSON.stringify({
          sessionStart: this.sessionStart,
          total: this.total,
          series: this.series.slice(-this.maxLen),
        }));
      }catch(e){}
    },

    /**
     * CVDダイバージェンス検出
     * 過去N足: 価格が高値更新だがCVDは低下 → 弱気ダイバージェンス
     */
    detectDivergence(lookback = 60){
      if(this.series.length < lookback) return null;
      const recent = this.series.slice(-lookback);
      const prices = recent.map(b => b.price);
      const cvds   = recent.map(b => b.cvd);

      // 前半/後半を比較
      const mid = Math.floor(lookback/2);
      const p1 = Math.max(...prices.slice(0, mid));
      const p2 = Math.max(...prices.slice(mid));
      const c1 = Math.max(...cvds.slice(0, mid));
      const c2 = Math.max(...cvds.slice(mid));

      // 価格が高値更新 && CVDが低下 → 弱気ダイバージェンス
      if(p2 > p1 * 1.001 && c2 < c1 * 0.98) return { type:'bearish', strength: (p2/p1 - c2/c1) };
      // 価格が安値更新 && CVDが上昇 → 強気ダイバージェンス
      const pl1 = Math.min(...prices.slice(0, mid));
      const pl2 = Math.min(...prices.slice(mid));
      const cl1 = Math.min(...cvds.slice(0, mid));
      const cl2 = Math.min(...cvds.slice(mid));
      if(pl2 < pl1 * 0.999 && cl2 > cl1 * 1.02) return { type:'bullish', strength: (pl1/pl2 - cl1/cl2) };

      return null;
    },

    /**
     * 直近のCVDモメンタム (-100..+100)
     */
    momentum(lookback = 30){
      if(this.series.length < lookback) return 0;
      const recent = this.series.slice(-lookback);
      const first = recent[0].cvd;
      const last  = recent[recent.length-1].cvd;
      const delta = last - first;
      // ノーマライズ: バケット内の最大絶対値で割る
      const maxAbs = Math.max(...recent.map(b => Math.abs(b.cvd - first))) || 1;
      return Math.max(-100, Math.min(100, (delta / maxAbs) * 100));
    },
  };

  // ═══════════════════════════════════════════════
  // 2. True Delta from kline[9] (takerBuyBaseAssetVolume)
  // ═══════════════════════════════════════════════
  window.calcTrueDelta = function(kl, lookback = 10){
    if(!kl || kl.length < 2) return 0;
    const recent = kl.slice(-Math.min(lookback, kl.length));
    let totalVol = 0, takerBuyVol = 0;
    recent.forEach(k => {
      const v  = parseFloat(k[5]);   // totalVolume
      const tb = parseFloat(k[9]||0); // takerBuyBaseAssetVolume
      if(isFinite(v) && isFinite(tb)){
        totalVol += v;
        takerBuyVol += tb;
      }
    });
    if(totalVol === 0) return 0;
    // Delta in [-1, 1]: takerBuy - takerSell normalized
    const takerSellVol = totalVol - takerBuyVol;
    return (takerBuyVol - takerSellVol) / totalVol;
  };

  // ═══════════════════════════════════════════════
  // 3. DOM Imbalance (Depth of Market)
  // ═══════════════════════════════════════════════

  const DOM = {
    bids: [],  // [[price, qty], ...] 高価格順
    asks: [],  // [[price, qty], ...] 低価格順
    lastUpdate: 0,
    imbalance: 0, // -1 (売り壁優勢) .. 1 (買い壁優勢)
    bigWalls: [], // [{side, price, qty}]

    ingest(d){
      if(!d || !d.bids || !d.asks) return;
      this.bids = d.bids.map(([p,q]) => [parseFloat(p), parseFloat(q)]).slice(0, 20);
      this.asks = d.asks.map(([p,q]) => [parseFloat(p), parseFloat(q)]).slice(0, 20);
      this.lastUpdate = Date.now();
      this._computeImbalance();
      this._detectWalls();
    },

    _computeImbalance(){
      const bidSum = this.bids.reduce((s,[p,q]) => s + q, 0);
      const askSum = this.asks.reduce((s,[p,q]) => s + q, 0);
      const total = bidSum + askSum;
      this.imbalance = total > 0 ? (bidSum - askSum) / total : 0;
    },

    _detectWalls(){
      const all = [...this.bids.map(([p,q])=>({side:'bid',p,q})),
                   ...this.asks.map(([p,q])=>({side:'ask',p,q}))];
      const avgQ = all.reduce((s,x)=>s+x.q,0) / Math.max(1,all.length);
      // 平均の4倍以上の壁を検出
      this.bigWalls = all.filter(x => x.q > avgQ * 4).sort((a,b) => b.q - a.q).slice(0, 5);
    },

    bidAskSpread(){
      if(!this.bids.length || !this.asks.length) return 0;
      return this.asks[0][0] - this.bids[0][0];
    },
  };

  // ═══════════════════════════════════════════════
  // 4. Volume Profile (価格帯別出来高)
  // ═══════════════════════════════════════════════

  const VP = {
    /**
     * klineから価格帯別出来高を算出
     * @returns {poc, vah, val, distribution}
     */
    compute(kl, bins = 40){
      if(!kl || kl.length < 10) return null;
      let minP = Infinity, maxP = -Infinity;
      kl.forEach(k => {
        const lo = parseFloat(k[3]), hi = parseFloat(k[2]);
        if(lo < minP) minP = lo;
        if(hi > maxP) maxP = hi;
      });
      if(!isFinite(minP) || !isFinite(maxP) || maxP <= minP) return null;

      const binSize = (maxP - minP) / bins;
      const profile = new Array(bins).fill(0);
      const totals  = [];

      kl.forEach(k => {
        const lo = parseFloat(k[3]), hi = parseFloat(k[2]), vol = parseFloat(k[5]);
        const lowBin  = Math.max(0, Math.min(bins-1, Math.floor((lo - minP) / binSize)));
        const highBin = Math.max(0, Math.min(bins-1, Math.floor((hi - minP) / binSize)));
        const spread  = highBin - lowBin + 1;
        const volPer  = vol / spread;
        for(let b = lowBin; b <= highBin; b++){
          profile[b] += volPer;
        }
      });

      // POC: 最多出来高
      let pocBin = 0, pocVol = 0;
      profile.forEach((v,i) => { if(v > pocVol){ pocVol = v; pocBin = i; } });
      const poc = minP + binSize * (pocBin + 0.5);

      // Value Area (70%) around POC
      const totalVol = profile.reduce((s,v) => s+v, 0);
      const targetVol = totalVol * 0.7;
      let accVol = profile[pocBin];
      let lowIdx = pocBin, highIdx = pocBin;
      while(accVol < targetVol && (lowIdx > 0 || highIdx < bins-1)){
        const lowVol  = lowIdx > 0 ? profile[lowIdx-1] : 0;
        const highVol = highIdx < bins-1 ? profile[highIdx+1] : 0;
        if(lowVol > highVol && lowIdx > 0){ lowIdx--; accVol += lowVol; }
        else if(highIdx < bins-1){ highIdx++; accVol += highVol; }
        else if(lowIdx > 0){ lowIdx--; accVol += lowVol; }
        else break;
      }
      const val = minP + binSize * lowIdx;
      const vah = minP + binSize * (highIdx + 1);

      return {
        poc, val, vah,
        binSize,
        minP, maxP,
        distribution: profile,
      };
    },
  };

  // ═══════════════════════════════════════════════
  // 5. 清算クラスタ推定 (OI + FR + L/S proxy)
  // ═══════════════════════════════════════════════

  const LiqEstimator = {
    /**
     * 清算クラスタ推定 — 現在価格からの上下N%範囲に清算確率密度を推定
     * 実際の清算データはないので、OI増加+FR偏り+L/S偏りを組み合わせた確率モデル
     */
    estimate(price, oi, fr, ls){
      if(!price) return null;
      // レバレッジ平均を想定 (10x..25x)
      const LEV_RANGE = [10, 15, 20, 25, 50];
      const clusters = { above: [], below: [] };

      // L/S比率からロング/ショート総量を推定 (相対値)
      const longRatio  = (ls || 50) / 100;
      const shortRatio = 1 - longRatio;

      // 各レバレッジについて清算価格を計算
      LEV_RANGE.forEach(lev => {
        // ロング清算: price * (1 - (1/lev) * 0.95)  (0.95は維持証拠金率)
        const longLiq = price * (1 - 0.95/lev);
        // ショート清算: price * (1 + (1/lev) * 0.95)
        const shortLiq = price * (1 + 0.95/lev);

        // 重み: レバレッジが低いほど多数のトレーダーが使用
        const levWeight = 1 / Math.log(lev + 1);

        // FRがプラス(ロング偏り) → ロング清算クラスタが密集
        const frBias = Math.max(-0.05, Math.min(0.05, fr || 0));
        const longDensity  = longRatio  * levWeight * (1 + Math.max(0, frBias*20));
        const shortDensity = shortRatio * levWeight * (1 + Math.max(0, -frBias*20));

        clusters.below.push({ price: longLiq, density: longDensity, lev, side:'long' });
        clusters.above.push({ price: shortLiq, density: shortDensity, lev, side:'short' });
      });

      // 密度でソート
      clusters.above.sort((a,b) => b.density - a.density);
      clusters.below.sort((a,b) => b.density - a.density);

      return {
        topAbove: clusters.above[0],
        topBelow: clusters.below[0],
        all: clusters,
      };
    },
  };

  // ═══════════════════════════════════════════════
  // 6. WebSocket アップグレード
  //    既存の @aggTrade をフックしてCVDに注入
  //    新規 @depth20@100ms ストリーム
  // ═══════════════════════════════════════════════

  let _wsDepth = null;
  let _wsAggHook = null;

  function hookAggTrade(){
    // 既存のWebSocketをpatchする代わりに、独自の@aggTrade接続を作る
    // 注意: ブラウザのconnection制限があるので、既存の_wsPriceにpiggybackするのが理想
    // しかし既存のonmessageを監視する方法がないので、新規接続を作る
    try{
      const coin = (window.currentCoin || 'BTC');
      const pair = (window.COINS && window.COINS[coin] ? window.COINS[coin].pair : 'BTCUSDT').toLowerCase();

      if(_wsAggHook){ try{ _wsAggHook.close(); }catch(e){} }
      _wsAggHook = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@aggTrade`);
      _wsAggHook.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          CVD.ingestAggTrade(d);
        } catch(err) {}
      };
      _wsAggHook.onclose = () => setTimeout(hookAggTrade, 5000);
      _wsAggHook.onerror = () => { try{_wsAggHook.close();}catch(e){} };
    } catch(e) {}
  }

  function hookDepth(){
    try{
      const coin = (window.currentCoin || 'BTC');
      const pair = (window.COINS && window.COINS[coin] ? window.COINS[coin].pair : 'BTCUSDT').toLowerCase();

      if(_wsDepth){ try{ _wsDepth.close(); }catch(e){} }
      _wsDepth = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@depth20@100ms`);
      _wsDepth.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          DOM.ingest(d);
        } catch(err) {}
      };
      _wsDepth.onclose = () => setTimeout(hookDepth, 5000);
      _wsDepth.onerror = () => { try{_wsDepth.close();}catch(e){} };
    } catch(e) {}
  }

  function closeAll(){
    if(_wsAggHook){ try{_wsAggHook.close();}catch(e){} _wsAggHook = null; }
    if(_wsDepth){ try{_wsDepth.close();}catch(e){} _wsDepth = null; }
  }

  // コイン切替時に再接続
  function reconnectOnCoinChange(){
    closeAll();
    CVD.init();
    hookAggTrade();
    hookDepth();
  }

  // ═══════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════

  window.RealtimePlus = {
    CVD,
    DOM,
    VP,
    LiqEstimator,
    reconnectOnCoinChange,
    closeAll,
    hookAggTrade,
    hookDepth,
  };

  // 初期化
  function init(){
    CVD.init();
    // 既存コードがCOINS/currentCoinを定義するまで待機
    const wait = () => {
      if(typeof window.currentCoin === 'undefined' || typeof window.COINS === 'undefined'){
        setTimeout(wait, 300);
        return;
      }
      hookAggTrade();
      hookDepth();
      console.log('[RealtimePlus] CVD + DOM streams connected');
    };
    wait();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
