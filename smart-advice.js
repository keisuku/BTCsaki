/*
 * smart-advice.js — リアルタイム状況判断パネル
 *
 * 全てのシグナル(複合スコア, MetaBot, CVD, DOM, トップbot)を統合して
 * 「今どうすべきか」を1文で提示するAI助言モジュール。
 *
 * 出力例:
 *  「🚀 全方位LONG圧力。MetaBot LONG中、CVD+48、Top3bot全員LONG — 高確信LONG機会」
 *  「⚠ チョッピー、方向性不明。MetaBot待機、CVD分散。見送り推奨」
 *  「🧲 清算クラスタ接近中: +1.2% で大量SHORT清算 → 自然吸引LONG期待」
 */
(function(){
  'use strict';

  const PANEL_HTML = `
    <div class="sa-panel" id="saPanel">
      <div class="sa-title">
        <span class="sa-dot"></span>
        <span>NOW ADVICE</span>
        <span class="sa-age" id="saAge">--</span>
      </div>
      <div class="sa-advice" id="saAdvice">状況分析中...</div>
      <div class="sa-signals" id="saSignals"></div>
    </div>
  `;

  const CSS = `
    .sa-panel{background:linear-gradient(135deg,rgba(0,212,255,.06),rgba(0,255,136,.02));border:1px solid rgba(0,212,255,.3);border-radius:10px;padding:10px 14px;margin:8px 14px;position:relative;overflow:hidden;}
    .sa-panel::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 30% 50%,rgba(0,212,255,.08),transparent 70%);pointer-events:none;}
    .sa-panel.mode-long{border-color:rgba(0,255,136,.5);background:linear-gradient(135deg,rgba(0,255,136,.1),rgba(0,212,255,.03));}
    .sa-panel.mode-short{border-color:rgba(255,45,85,.5);background:linear-gradient(135deg,rgba(255,45,85,.1),rgba(255,107,53,.03));}
    .sa-panel.mode-wait{border-color:rgba(255,214,10,.4);background:linear-gradient(135deg,rgba(255,214,10,.06),rgba(0,0,0,.1));}
    .sa-title{font-family:'Share Tech Mono',monospace;font-size:.56rem;color:var(--dim);letter-spacing:.2em;margin-bottom:6px;display:flex;align-items:center;gap:8px;}
    .sa-dot{width:5px;height:5px;border-radius:50%;background:#00d4ff;box-shadow:0 0 5px #00d4ff;animation:saDot 1.5s infinite;}
    @keyframes saDot{0%,100%{opacity:1}50%{opacity:.3}}
    .sa-age{margin-left:auto;color:var(--dim);font-size:.5rem;}
    .sa-advice{font-size:.92rem;line-height:1.45;font-weight:700;color:var(--text);margin-bottom:6px;}
    .sa-advice .sa-icon{font-size:1.15rem;margin-right:4px;}
    .sa-signals{display:flex;flex-wrap:wrap;gap:4px;font-family:'Share Tech Mono',monospace;font-size:.58rem;}
    .sa-sig{padding:2px 6px;border-radius:3px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:var(--dim);}
    .sa-sig.bull{color:var(--green);border-color:rgba(0,255,136,.3);background:rgba(0,255,136,.05);}
    .sa-sig.bear{color:var(--red);border-color:rgba(255,45,85,.3);background:rgba(255,45,85,.05);}
    .sa-sig.neutral{color:var(--yellow);border-color:rgba(255,214,10,.3);background:rgba(255,214,10,.05);}
  `;

  function inject(){
    if(document.getElementById('saPanel')) return true;
    const header = document.querySelector('.ba-wrap .ba-header');
    if(header){
      header.insertAdjacentHTML('afterend', PANEL_HTML);
      return true;
    }
    return false;
  }

  function injectCss(){
    if(document.getElementById('saCss')) return;
    const s = document.createElement('style');
    s.id = 'saCss';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function gatherSignals(){
    const signals = [];
    const S = window.S || {};

    // 1. Composite dashboard score
    let composite = null;
    try{
      if(typeof window.computeTF === 'function'){
        const tfs = ['5m', '15m', '1h', '4h', '1d'];
        const weights = { '5m':1, '15m':1.5, '1h':2, '4h':2.5, '1d':2 };
        let sum = 0, wsum = 0;
        tfs.forEach(tf => {
          const r = window.computeTF(tf);
          if(r && typeof r.score === 'number'){
            sum += r.score * weights[tf];
            wsum += weights[tf];
          }
        });
        composite = wsum > 0 ? sum / wsum : 50;
      }
    }catch(e){}
    if(composite !== null){
      signals.push({
        key: 'composite',
        label: `複合${composite.toFixed(0)}`,
        vote: composite >= 60 ? 'LONG' : composite <= 40 ? 'SHORT' : 'WAIT',
        weight: 3,
      });
    }

    // 2. MetaBot state
    if(window.MetaBot && window.MetaBot.state){
      const mb = window.MetaBot.state;
      if(mb.position){
        signals.push({
          key: 'meta',
          label: `MetaBot ${mb.position.dir}`,
          vote: mb.position.dir,
          weight: 4,
        });
      } else {
        const sig = window.MetaBot.checkEntry();
        if(sig){
          signals.push({
            key: 'meta',
            label: `MetaBot合意${sig.dir}(${sig.count}/${sig.total})`,
            vote: sig.dir,
            weight: 3,
          });
        } else {
          signals.push({ key:'meta', label:'MetaBot待機', vote:'WAIT', weight:1 });
        }
      }
    }

    // 3. CVD momentum
    if(window.RealtimePlus && window.RealtimePlus.CVD){
      const mom = window.RealtimePlus.CVD.momentum(30);
      if(Math.abs(mom) > 15){
        signals.push({
          key: 'cvd',
          label: `CVD${mom >= 0 ? '+' : ''}${mom.toFixed(0)}`,
          vote: mom > 0 ? 'LONG' : 'SHORT',
          weight: 2,
        });
      }
      // Divergence
      const div = window.RealtimePlus.CVD.detectDivergence(60);
      if(div){
        signals.push({
          key: 'cvdDiv',
          label: div.type === 'bullish' ? 'CVD強気ダイバ' : 'CVD弱気ダイバ',
          vote: div.type === 'bullish' ? 'LONG' : 'SHORT',
          weight: 3,
        });
      }
    }

    // 4. DOM imbalance
    if(window.RealtimePlus && window.RealtimePlus.DOM){
      const imb = window.RealtimePlus.DOM.imbalance;
      if(Math.abs(imb) > 0.2){
        signals.push({
          key: 'dom',
          label: `板${imb >= 0 ? '+' : ''}${(imb*100).toFixed(0)}%`,
          vote: imb > 0 ? 'LONG' : 'SHORT',
          weight: 2,
        });
      }
    }

    // 5. True delta
    if(window.calcTrueDelta && S.k1m && S.k1m.length >= 3){
      const delta = window.calcTrueDelta(S.k1m, 10);
      if(Math.abs(delta) > 0.1){
        signals.push({
          key: 'delta',
          label: `δ${delta >= 0 ? '+' : ''}${(delta*100).toFixed(0)}%`,
          vote: delta > 0 ? 'LONG' : 'SHORT',
          weight: 1,
        });
      }
    }

    // 6. Top bot consensus (top 3 by fitness)
    if(window.calcFitnessPlus && window.ALL_BOTS && window.botStates){
      const candidates = [];
      window.ALL_BOTS.forEach(def => {
        const bs = window.botStates[def.id];
        if(!bs) return;
        const total = (bs.totalWins||0) + (bs.totalLosses||0);
        if(total < 5) return;
        const fit = window.calcFitnessPlus(bs);
        if(fit > 0 && bs.position){
          candidates.push({ def, bs, fit });
        }
      });
      candidates.sort((a,b) => b.fit - a.fit);
      const top3 = candidates.slice(0, 3);
      if(top3.length >= 2){
        const longs = top3.filter(c => c.bs.position.dir === 'LONG').length;
        const shorts = top3.filter(c => c.bs.position.dir === 'SHORT').length;
        if(longs >= 2){
          signals.push({ key:'top3', label:`Top3中${longs}体LONG`, vote:'LONG', weight:2 });
        } else if(shorts >= 2){
          signals.push({ key:'top3', label:`Top3中${shorts}体SHORT`, vote:'SHORT', weight:2 });
        }
      }
    }

    return signals;
  }

  function synthesizeAdvice(signals){
    // Weighted vote
    let longScore = 0, shortScore = 0, waitScore = 0;
    signals.forEach(s => {
      if(s.vote === 'LONG') longScore += s.weight;
      else if(s.vote === 'SHORT') shortScore += s.weight;
      else waitScore += s.weight;
    });
    const total = longScore + shortScore + waitScore;
    if(total === 0) return { mode: 'wait', icon: '👀', text: '状況分析中...', signals };

    const longPct = longScore / total;
    const shortPct = shortScore / total;

    let mode, icon, text;
    if(longPct >= 0.6){
      mode = 'long';
      const confidence = longPct >= 0.8 ? '高確信' : longPct >= 0.65 ? '中確信' : '弱確信';
      const sigCount = signals.filter(s => s.vote === 'LONG').length;
      const total = signals.length;
      if(longPct >= 0.8){
        icon = '🚀'; text = `全方位LONG圧力。${sigCount}/${total}シグナルがLONG — ${confidence}LONG機会`;
      } else {
        icon = '📈'; text = `LONG優位 (${(longPct*100).toFixed(0)}%)。${sigCount}/${total}シグナルがLONG`;
      }
    } else if(shortPct >= 0.6){
      mode = 'short';
      const confidence = shortPct >= 0.8 ? '高確信' : shortPct >= 0.65 ? '中確信' : '弱確信';
      const sigCount = signals.filter(s => s.vote === 'SHORT').length;
      const total = signals.length;
      if(shortPct >= 0.8){
        icon = '🚨'; text = `全方位SHORT圧力。${sigCount}/${total}シグナルがSHORT — ${confidence}SHORT機会`;
      } else {
        icon = '📉'; text = `SHORT優位 (${(shortPct*100).toFixed(0)}%)。${sigCount}/${total}シグナルがSHORT`;
      }
    } else {
      mode = 'wait';
      if(longScore > 0 && shortScore > 0 && Math.abs(longScore - shortScore) < 2){
        icon = '⚔'; text = `シグナル拮抗 (L${longScore}vs S${shortScore})。見送り推奨`;
      } else if(total < 3){
        icon = '👀'; text = `シグナル不足。データ蓄積中...`;
      } else {
        icon = '⚠'; text = `方向性不明 — レンジまたはチョッピー。見送り推奨`;
      }
    }

    // Check for special conditions
    const divSignal = signals.find(s => s.key === 'cvdDiv');
    if(divSignal){
      text += ` | ${divSignal.label}検出`;
    }

    return { mode, icon, text, signals };
  }

  function render(){
    const panel = document.getElementById('saPanel');
    if(!panel) return;

    const signals = gatherSignals();
    const result = synthesizeAdvice(signals);

    panel.className = 'sa-panel mode-' + result.mode;

    const adviceEl = document.getElementById('saAdvice');
    if(adviceEl){
      adviceEl.innerHTML = `<span class="sa-icon">${result.icon}</span>${result.text}`;
    }

    const sigEl = document.getElementById('saSignals');
    if(sigEl){
      sigEl.innerHTML = signals.map(s => {
        const cls = s.vote === 'LONG' ? 'bull' : s.vote === 'SHORT' ? 'bear' : 'neutral';
        return `<span class="sa-sig ${cls}">${s.label}</span>`;
      }).join('');
    }

    const ageEl = document.getElementById('saAge');
    if(ageEl){
      const now = new Date();
      ageEl.textContent = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    }
  }

  function init(){
    injectCss();
    const wait = () => {
      if(typeof window.currentCoin === 'undefined'){
        setTimeout(wait, 500);
        return;
      }
      // Wait for ba-wrap and ba-header
      const checkHost = () => {
        const host = document.querySelector('.ba-wrap .ba-header');
        if(!host){ setTimeout(checkHost, 500); return; }
        // Inject after MetaBot panel if it exists, otherwise after ba-header
        const mb = document.getElementById('mbPanel');
        if(mb){
          if(!document.getElementById('saPanel')){
            mb.insertAdjacentHTML('beforebegin', PANEL_HTML);
          }
        } else {
          inject();
        }
        setInterval(render, 2000);
        render();
        console.log('[SmartAdvice] Live NOW-advice engine started');
      };
      checkHost();
    };
    wait();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
