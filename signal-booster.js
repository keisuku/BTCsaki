/*
 * signal-booster.js — 既存bot群のシグナル品質をCVD/DOM/TrueDeltaで増強
 *
 * アプローチ: window.botComputeTF をラップし、既存スコアに以下のbonus/penaltyを追加
 *   1. CVD方向一致度: CVDがbot方向と一致 → +点、逆行 → -点
 *   2. DOM imbalance: 板厚が方向と一致 → +点
 *   3. True delta (1m): kline[9]ベースのtaker delta
 *   4. CVD divergence 警告: 全bot に逆張り注意
 *
 * 既存の15種類のbotすべてが、これらの高品質リアルタイムデータの恩恵を受ける。
 */
(function(){
  'use strict';

  function init(){
    const wait = () => {
      if(typeof window.botComputeTF !== 'function' || !window.RealtimePlus){
        setTimeout(wait, 500);
        return;
      }
      installBooster();
    };
    wait();
  }

  function installBooster(){
    if(window._signalBoosterInstalled) return;
    const original = window.botComputeTF;
    window.botComputeTF = function(tf){
      const r = original(tf);
      if(!r || typeof r !== 'object') return r;
      try{
        boostSignal(r, tf);
      }catch(e){}
      return r;
    };
    window._signalBoosterInstalled = true;
    console.log('[SignalBooster] botComputeTF patched — CVD/DOM/Delta injected into bot decisions');
  }

  function boostSignal(r, tf){
    if(!r.inds) return;
    if(r._boosted) return; // 二重適用を防ぐ
    r._boosted = true;

    const CVD = window.RealtimePlus?.CVD;
    const DOM = window.RealtimePlus?.DOM;

    let scoreAdjust = 0;
    const notes = [];

    // ═══ 1. CVD momentum ═══
    if(CVD && CVD.series.length >= 30){
      const mom = CVD.momentum(30); // -100..+100
      if(Math.abs(mom) > 20){
        const factor = Math.min(1, Math.abs(mom) / 60); // 0..1
        // CVD上昇 → bullish
        if(mom > 20){
          scoreAdjust += 4 * factor;
          notes.push(`CVD+${mom.toFixed(0)}`);
        } else if(mom < -20){
          scoreAdjust -= 4 * factor;
          notes.push(`CVD${mom.toFixed(0)}`);
        }
      }

      // Divergence — 強い警告
      const div = CVD.detectDivergence(60);
      if(div){
        if(div.type === 'bearish'){
          scoreAdjust -= 6;
          notes.push('⚠CVD弱気ダイバ');
        } else {
          scoreAdjust += 6;
          notes.push('⚡CVD強気ダイバ');
        }
      }
    }

    // ═══ 2. DOM imbalance ═══
    if(DOM && DOM.lastUpdate > 0 && (Date.now() - DOM.lastUpdate) < 10000){
      const imb = DOM.imbalance; // -1..1
      if(Math.abs(imb) > 0.2){
        scoreAdjust += imb * 5; // -5..+5
        notes.push(`DOM${imb>0?'+':''}${(imb*100).toFixed(0)}%`);
      }
    }

    // ═══ 3. True Delta (1m) ═══
    if(window.calcTrueDelta && window.S?.k1m?.length >= 3){
      const delta = window.calcTrueDelta(window.S.k1m, 10);
      if(Math.abs(delta) > 0.15){
        scoreAdjust += delta * 3; // -3..+3
        notes.push(`δ${delta>0?'+':''}${(delta*100).toFixed(0)}%`);
      }
    }

    // Apply adjustment with taper (より高いTFほど影響小、短期scalper optimum)
    const tfWeight = {
      '1m': 1.0, '3m': 0.9, '5m': 0.8, '15m': 0.6,
      '1h': 0.3, '4h': 0.15, '1d': 0.05,
    };
    const w = tfWeight[tf] ?? 0.5;
    const adjusted = scoreAdjust * w;

    if(Math.abs(adjusted) > 0.5){
      const oldScore = r.score;
      r.score = Math.max(0, Math.min(100, r.score + adjusted));
      // Update signal category based on new score
      if(r.score >= 65) r.signal = 'LONG';
      else if(r.score <= 35) r.signal = 'SHORT';
      else r.signal = 'WAIT';
      // Attach boost info for debugging
      r._boostDelta = +adjusted.toFixed(2);
      r._boostNotes = notes;
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
