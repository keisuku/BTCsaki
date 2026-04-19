/*
 * metabot.js — 最強統合Bot (Meta-Ensemble Trader)
 *
 * 全botの中でフィットネストップ5をリアルタイムに選出し、
 * その方向一致度を信号として独自にペーパートレードする。
 * これが「最終的な最強のbot」 — 進化の集大成として機能。
 *
 * 特徴:
 *  - 毎秒Top5を再評価 (動的メンバー選抜)
 *  - 3体以上が同方向 → エントリー
 *  - 4体以上 → 確信度UP (レバレッジ1.5x相当)
 *  - 5体全員 → 最高確信度 (2x相当)
 *  - ATR連動のTP/SL
 *  - 勝率とP&Lを独自管理 → 既存Arenaの上に表示
 */
(function(){
  'use strict';

  const META_KEY = 'metabot_v1_';
  const META_MIN_TRADES = 5;        // 候補bot最低トレード数
  const META_REFRESH_MS = 3000;     // top5再評価頻度

  const MetaBot = {
    state: null,          // 永続state
    top5: [],             // 現在選抜中のbot
    lastEvalTs: 0,

    stateKey(){ return META_KEY + (window.currentCoin || 'BTC'); },

    init(){
      this.state = this._load();
      this._ensureShape();
    },

    _load(){
      try{
        const raw = localStorage.getItem(this.stateKey());
        if(raw) return JSON.parse(raw);
      }catch(e){}
      return this._newState();
    },

    _newState(){
      return {
        position: null,
        totalWins: 0,
        totalLosses: 0,
        totalPnlPct: 0,
        trades: [],           // 最大500件
        equity: [],           // [{t, pnl}]
        dailyStats: [],       // [{date, wins, losses, pnlPct}]
        lastUpdate: Date.now(),
        lastDailyClose: null,
      };
    },

    _ensureShape(){
      if(!this.state) this.state = this._newState();
      const s = this.state;
      if(!s.trades) s.trades = [];
      if(!s.equity) s.equity = [];
      if(!s.dailyStats) s.dailyStats = [];
    },

    _save(){
      try{ localStorage.setItem(this.stateKey(), JSON.stringify(this.state)); }catch(e){}
    },

    _todayJst(){
      const d = new Date(Date.now() + 9*3600000);
      return d.toISOString().slice(0, 10);
    },

    /**
     * Top5 botを選抜 (フィットネス高い順)
     */
    selectTop5(){
      if(!window.botStates || !window.ALL_BOTS || typeof window.calcFitnessPlus !== 'function') return [];
      const candidates = [];
      window.ALL_BOTS.forEach(def => {
        const bs = window.botStates[def.id];
        if(!bs) return;
        const total = (bs.totalWins||0) + (bs.totalLosses||0);
        if(total < META_MIN_TRADES) return;
        const fit = window.calcFitnessPlus(bs);
        if(fit > 0){ // プラス成績のみ
          candidates.push({ def, bs, fit });
        }
      });
      candidates.sort((a,b) => b.fit - a.fit);
      return candidates.slice(0, 5);
    },

    /**
     * エントリー条件チェック — Top5のうち3体以上が同方向 holding
     */
    checkEntry(){
      const top5 = this.top5;
      if(top5.length < 3) return null;

      const holdingBots = top5.filter(c => c.bs.position);
      if(holdingBots.length < 3) return null;

      const longCount  = holdingBots.filter(c => c.bs.position.dir === 'LONG').length;
      const shortCount = holdingBots.filter(c => c.bs.position.dir === 'SHORT').length;

      if(longCount >= 3 && longCount > shortCount){
        return { dir: 'LONG', count: longCount, total: top5.length, confidence: longCount/top5.length };
      }
      if(shortCount >= 3 && shortCount > longCount){
        return { dir: 'SHORT', count: shortCount, total: top5.length, confidence: shortCount/top5.length };
      }
      return null;
    },

    /**
     * メインループ — 毎秒評価
     */
    tick(){
      if(!window.S || !window.S.price) return;
      const now = Date.now();
      const price = window.S.price;

      // Top5 refresh
      if(now - this.lastEvalTs > META_REFRESH_MS){
        this.top5 = this.selectTop5();
        this.lastEvalTs = now;
      }

      const s = this.state;

      // 既存ポジションの決済判定
      if(s.position){
        const p = s.position;
        const pnlPct = p.dir === 'LONG' ? (price - p.entry) / p.entry * 100
                                        : (p.entry - price) / p.entry * 100;
        const pnlLev = pnlPct * (p.lev || 1);

        let exit = null, reason = '';
        if(p.dir === 'LONG'){
          if(price >= p.tp){ exit = p.tp; reason = 'TP到達'; }
          else if(price <= p.sl){ exit = p.sl; reason = 'SL到達'; }
        } else {
          if(price <= p.tp){ exit = p.tp; reason = 'TP到達'; }
          else if(price >= p.sl){ exit = p.sl; reason = 'SL到達'; }
        }
        // 時間切れ (60分)
        if(!exit && now - p.time > 60 * 60 * 1000){
          exit = price; reason = '時間切れ';
        }
        // 合意逆転 — Top5が逆方向多数 → 早期決済
        if(!exit){
          const signal = this.checkEntry();
          if(signal && signal.dir !== p.dir){
            exit = price; reason = '合意逆転';
          }
        }

        if(exit !== null){
          const finalPnl = p.dir === 'LONG' ? (exit - p.entry) / p.entry * 100
                                            : (p.entry - exit) / p.entry * 100;
          const finalPnlLev = finalPnl * (p.lev || 1);
          const win = finalPnlLev > 0;
          s.trades.push({
            dir: p.dir,
            entry: p.entry,
            exit,
            entryTime: new Date(p.time).toISOString(),
            exitTime: new Date(now).toISOString(),
            pnlPct: finalPnlLev,
            win,
            lev: p.lev,
            reason,
          });
          if(s.trades.length > 500) s.trades = s.trades.slice(-500);
          if(win) s.totalWins++; else s.totalLosses++;
          s.totalPnlPct += finalPnlLev;
          s.equity.push({ t: now, pnl: s.totalPnlPct });
          if(s.equity.length > 300) s.equity = s.equity.slice(-300);
          s.position = null;
          this._save();
          console.log(`[MetaBot] ${p.dir} closed: ${reason} ${finalPnlLev>=0?'+':''}${finalPnlLev.toFixed(2)}%`);
        }
      }

      // 新規エントリー (5分cooldown)
      const lastExitTime = s.trades.length > 0 ? new Date(s.trades[s.trades.length-1].exitTime).getTime() : 0;
      const inCooldown = lastExitTime && (now - lastExitTime) < 5 * 60 * 1000;
      if(!s.position && !inCooldown){
        const signal = this.checkEntry();
        if(signal){
          // 確信度からレバレッジ
          const lev = signal.count >= 5 ? 2 : signal.count >= 4 ? 1.5 : 1;
          // ATR-based TP/SL
          const k5 = window.S.k5 || [];
          const atr = this._calcATR(k5, 14);
          const tpAtr = 1.5, slAtr = 1.0;
          let tp, sl;
          if(signal.dir === 'LONG'){
            tp = price + atr * tpAtr;
            sl = price - atr * slAtr;
          } else {
            tp = price - atr * tpAtr;
            sl = price + atr * slAtr;
          }
          s.position = {
            dir: signal.dir,
            entry: price,
            time: now,
            tp, sl, lev,
            signal: { count: signal.count, total: signal.total },
          };
          this._save();
          console.log(`[MetaBot] ${signal.dir} @ $${price.toFixed(0)} (${signal.count}/${signal.total} bots agree, ${lev}x)`);
        }
      }

      // Daily roll-up
      const today = this._todayJst();
      if(s.lastDailyClose !== today){
        const todayTrades = s.trades.filter(t => t.exitTime && t.exitTime.startsWith(today));
        const wins = todayTrades.filter(t => t.win).length;
        const losses = todayTrades.length - wins;
        const pnl = todayTrades.reduce((sum,t) => sum + t.pnlPct, 0);
        // Update or insert today's record
        const existing = s.dailyStats.find(ds => ds.date === today);
        if(existing){
          existing.wins = wins; existing.losses = losses; existing.pnlPct = +pnl.toFixed(3);
        } else {
          s.dailyStats.push({ date: today, wins, losses, pnlPct: +pnl.toFixed(3), tradeCount: wins+losses });
        }
        if(s.dailyStats.length > 60) s.dailyStats = s.dailyStats.slice(-60);
        s.lastDailyClose = today;
        this._save();
      }
    },

    _calcATR(kl, period){
      if(!kl || kl.length < period + 1) return window.S?.price ? window.S.price * 0.003 : 100;
      const trs = [];
      for(let i = 1; i < kl.length; i++){
        const h = parseFloat(kl[i][2]);
        const l = parseFloat(kl[i][3]);
        const pc = parseFloat(kl[i-1][4]);
        const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        trs.push(tr);
      }
      const recent = trs.slice(-period);
      return recent.reduce((s,v)=>s+v,0) / Math.max(1, recent.length);
    },
  };

  // ═══════════════════════════════════════════════
  // UI Panel
  // ═══════════════════════════════════════════════

  const META_HTML = `
    <div class="mb-panel" id="mbPanel">
      <div class="mb-header">
        <div class="mb-title-wrap">
          <span class="mb-emoji">👑</span>
          <span class="mb-title">META BOT — 最強統合AI</span>
          <span class="mb-live"></span>
        </div>
        <div class="mb-sub">Top5bot合意エンジン — 進化の集大成</div>
      </div>
      <div class="mb-main-row">
        <div class="mb-stat-block">
          <div class="mb-stat-lbl">生涯P&L</div>
          <div class="mb-stat-val" id="mbPnl">--</div>
          <div class="mb-stat-sub" id="mbWinRate">勝率 --</div>
        </div>
        <div class="mb-stat-block">
          <div class="mb-stat-lbl">現在のポジション</div>
          <div class="mb-stat-val" id="mbPos">--</div>
          <div class="mb-stat-sub" id="mbPosDetail">--</div>
        </div>
        <div class="mb-stat-block">
          <div class="mb-stat-lbl">Top5合意</div>
          <div class="mb-stat-val" id="mbConsensus">--</div>
          <div class="mb-stat-sub" id="mbConsensusDetail">--</div>
        </div>
      </div>
      <div class="mb-top5-row" id="mbTop5">--</div>
      <canvas class="mb-equity" id="mbEquity"></canvas>
    </div>
  `;

  const META_CSS = `
    .mb-panel{background:linear-gradient(135deg,rgba(167,139,250,.08),rgba(0,212,255,.04));border:1.5px solid rgba(167,139,250,.4);border-radius:10px;padding:14px 16px;margin:10px 14px;position:relative;overflow:hidden;}
    .mb-panel::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#a78bfa,#00d4ff,#00ff88);animation:mbGradientSlide 3s linear infinite;}
    @keyframes mbGradientSlide{0%{background-position:0% 50%}100%{background-position:200% 50%}}
    .mb-header{display:flex;flex-direction:column;gap:2px;margin-bottom:12px;}
    .mb-title-wrap{display:flex;align-items:center;gap:8px;}
    .mb-emoji{font-size:1.4rem;filter:drop-shadow(0 0 8px rgba(255,214,10,.5));}
    .mb-title{font-family:'Share Tech Mono',monospace;font-size:.88rem;font-weight:bold;color:#c4b5fd;letter-spacing:.1em;}
    .mb-live{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:mbLivePulse 1s infinite;}
    @keyframes mbLivePulse{0%,100%{opacity:1}50%{opacity:.3}}
    .mb-sub{font-size:.66rem;color:var(--dim);font-family:'Share Tech Mono',monospace;letter-spacing:.1em;}
    .mb-main-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;}
    @media(max-width:520px){.mb-main-row{grid-template-columns:1fr;}}
    .mb-stat-block{background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:6px;padding:8px 10px;}
    .mb-stat-lbl{font-family:'Share Tech Mono',monospace;font-size:.5rem;color:var(--dim);letter-spacing:.15em;text-transform:uppercase;margin-bottom:3px;}
    .mb-stat-val{font-family:'Share Tech Mono',monospace;font-size:1.1rem;font-weight:bold;line-height:1.1;}
    .mb-stat-val.pos{color:var(--green);}
    .mb-stat-val.neg{color:var(--red);}
    .mb-stat-val.neutral{color:var(--yellow);}
    .mb-stat-sub{font-family:'Share Tech Mono',monospace;font-size:.6rem;color:var(--dim);margin-top:2px;}
    .mb-top5-row{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;background:rgba(0,0,0,.2);border-radius:6px;border:1px dashed var(--border);font-size:.72rem;color:var(--dim);margin-bottom:8px;}
    .mb-top5-row .mb-top5-pill{padding:3px 8px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);font-family:'Share Tech Mono',monospace;font-size:.62rem;color:var(--text);}
    .mb-top5-row .mb-top5-pill.holding-long{border-color:rgba(0,255,136,.45);color:var(--green);background:rgba(0,255,136,.05);}
    .mb-top5-row .mb-top5-pill.holding-short{border-color:rgba(255,45,85,.45);color:var(--red);background:rgba(255,45,85,.05);}
    .mb-equity{display:block;width:100%;height:60px;background:rgba(0,0,0,.15);border-radius:4px;border:1px solid rgba(255,255,255,.04);}
  `;

  function injectCss(){
    if(document.getElementById('metabotCss')) return;
    const s = document.createElement('style');
    s.id = 'metabotCss';
    s.textContent = META_CSS;
    document.head.appendChild(s);
  }

  function injectPanel(){
    if(document.getElementById('mbPanel')) return true;
    // Inject at very top of ba-wrap (right after header)
    const header = document.querySelector('.ba-wrap .ba-header');
    if(header){
      header.insertAdjacentHTML('afterend', META_HTML);
      return true;
    }
    const host = document.querySelector('.ba-wrap');
    if(host){
      host.insertAdjacentHTML('afterbegin', META_HTML);
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════
  // Renderers
  // ═══════════════════════════════════════════════

  function renderStats(){
    const s = MetaBot.state;
    if(!s) return;

    // PnL
    const pnlEl = document.getElementById('mbPnl');
    const wrEl = document.getElementById('mbWinRate');
    if(pnlEl){
      pnlEl.textContent = `${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}%`;
      pnlEl.className = 'mb-stat-val ' + (s.totalPnlPct > 0 ? 'pos' : s.totalPnlPct < 0 ? 'neg' : 'neutral');
    }
    if(wrEl){
      const total = s.totalWins + s.totalLosses;
      const wr = total > 0 ? (s.totalWins / total * 100).toFixed(1) : '--';
      wrEl.textContent = total > 0 ? `勝率 ${wr}% (${s.totalWins}勝${s.totalLosses}敗)` : `トレード未実行`;
    }

    // Position
    const posEl = document.getElementById('mbPos');
    const posDetailEl = document.getElementById('mbPosDetail');
    if(posEl && posDetailEl){
      if(s.position){
        const p = s.position;
        const price = window.S?.price || p.entry;
        const pnlPct = p.dir === 'LONG' ? (price - p.entry) / p.entry * 100
                                        : (p.entry - price) / p.entry * 100;
        const pnlLev = pnlPct * (p.lev || 1);
        posEl.textContent = p.dir + (p.lev > 1 ? ` ${p.lev}x` : '');
        posEl.className = 'mb-stat-val ' + (p.dir === 'LONG' ? 'pos' : 'neg');
        posDetailEl.innerHTML = `@$${p.entry.toFixed(0)} 含み <span style="color:${pnlLev>=0?'var(--green)':'var(--red)'};font-weight:700;">${pnlLev>=0?'+':''}${pnlLev.toFixed(2)}%</span>`;
      } else {
        posEl.textContent = '待機中';
        posEl.className = 'mb-stat-val neutral';
        posDetailEl.textContent = 'Top5合意待ち';
      }
    }

    // Consensus
    const consEl = document.getElementById('mbConsensus');
    const consDetEl = document.getElementById('mbConsensusDetail');
    const signal = MetaBot.checkEntry();
    if(consEl && consDetEl){
      if(signal){
        consEl.textContent = signal.dir;
        consEl.className = 'mb-stat-val ' + (signal.dir === 'LONG' ? 'pos' : 'neg');
        consDetEl.textContent = `${signal.count}/${signal.total}体が同方向 (信頼度${(signal.confidence*100).toFixed(0)}%)`;
      } else {
        const loadedCount = MetaBot.top5.length;
        if(loadedCount < 3){
          consEl.textContent = '準備中';
          consEl.className = 'mb-stat-val neutral';
          consDetEl.textContent = `Top5選抜中 (${loadedCount}/5)`;
        } else {
          consEl.textContent = '待機';
          consEl.className = 'mb-stat-val neutral';
          consDetEl.textContent = `Top5の合意なし`;
        }
      }
    }

    // Top5 pills
    const top5El = document.getElementById('mbTop5');
    if(top5El){
      if(MetaBot.top5.length === 0){
        top5El.innerHTML = '<span style="color:var(--dim);">候補bot選抜中... 最低5回トレード実績のあるbotが必要</span>';
      } else {
        top5El.innerHTML = MetaBot.top5.map(c => {
          const pos = c.bs.position;
          const cls = pos ? (pos.dir === 'LONG' ? 'holding-long' : 'holding-short') : '';
          const posTag = pos ? ` ${pos.dir === 'LONG' ? '↑' : '↓'}` : '';
          return `<span class="mb-top5-pill ${cls}">${c.def.emoji||'🤖'} ${c.def.name}${posTag} fit:${c.fit.toFixed(1)}</span>`;
        }).join('');
      }
    }

    // Equity curve
    drawEquity();
  }

  function drawEquity(){
    const canvas = document.getElementById('mbEquity');
    if(!canvas) return;
    const s = MetaBot.state;
    if(!s || !s.equity || s.equity.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);

    const data = s.equity.slice(-200);
    const vals = data.map(e => e.pnl);
    const minV = Math.min(0, ...vals);
    const maxV = Math.max(0, ...vals);
    const rangeV = (maxV - minV) || 1;
    const pad = 4;
    const paneH = H - pad * 2;

    // Zero line
    const zeroY = pad + paneH * (1 - (0 - minV)/rangeV);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
    ctx.setLineDash([]);

    // Fill under curve
    ctx.beginPath();
    data.forEach((e, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = pad + paneH * (1 - (e.pnl - minV)/rangeV);
      if(i === 0){ ctx.moveTo(x, zeroY); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(W, zeroY); ctx.closePath();
    const lastVal = vals[vals.length-1];
    const isPos = lastVal >= 0;
    const grd = ctx.createLinearGradient(0, pad, 0, H);
    if(isPos){
      grd.addColorStop(0, 'rgba(0,255,136,0.3)');
      grd.addColorStop(1, 'rgba(0,255,136,0.0)');
    } else {
      grd.addColorStop(0, 'rgba(255,45,85,0.3)');
      grd.addColorStop(1, 'rgba(255,45,85,0.0)');
    }
    ctx.fillStyle = grd;
    ctx.fill();

    // Line
    ctx.strokeStyle = isPos ? '#00ff88' : '#ff2d55';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((e, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = pad + paneH * (1 - (e.pnl - minV)/rangeV);
      if(i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ═══════════════════════════════════════════════
  // Main loop
  // ═══════════════════════════════════════════════

  function init(){
    injectCss();

    const wait = () => {
      if(typeof window.currentCoin === 'undefined' || typeof window.botStates === 'undefined' || typeof window.ALL_BOTS === 'undefined'){
        setTimeout(wait, 500);
        return;
      }
      MetaBot.init();
      injectPanel();

      // Track coin for reload on switch
      MetaBot._lastCoin = window.currentCoin;

      // Tick every 1 second
      setInterval(() => {
        // Coin switch detection → reload state
        if(MetaBot._lastCoin !== window.currentCoin){
          MetaBot._lastCoin = window.currentCoin;
          MetaBot.state = MetaBot._load();
          MetaBot._ensureShape();
          console.log('[MetaBot] coin switched → state reloaded');
        }
        try{ MetaBot.tick(); }catch(e){ console.warn('[MetaBot] tick err:', e); }
      }, 1000);

      // Render every 1.5s
      setInterval(() => {
        try{ renderStats(); }catch(e){}
      }, 1500);

      console.log('[MetaBot] 最強統合AI loaded — watching top 5 bots');
    };
    wait();
  }

  window.MetaBot = MetaBot;

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
