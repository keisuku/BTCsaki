// ═══════════════════════════════════════════════
// COCKPIT FX — 追加演出パック (cockpit-plus.jsの後にロード)
//
//  1. 大勝ちカットイン: 画面横断の斜めグリッチバナー + パーティクルバースト
//  2. 大負けスクリーンシェイク + 赤ビネット
//  3. ソナースイープ: エントリー間近botが輝点で浮かぶ回転レーダー
//  4. エクイティレース: bot上位8体の累計PnLバーが滑らかに入れ替わる順位表
//
// すべて追加的・try/catch安全失敗・prefers-reduced-motion尊重・非表示タブで停止。
// ═══════════════════════════════════════════════
(function () {
  'use strict';
  const TAG = '[CockpitFX]';
  const log = (...a) => { try { console.log(TAG, ...a); } catch (e) {} };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ────────────────────────────── CSS
  const css = `
  /* cut-in */
  #fxCutin{position:fixed;left:-110%;top:38%;z-index:9500;width:120%;pointer-events:none;
    transform:rotate(-4deg);background:linear-gradient(90deg,transparent,rgba(0,255,136,.18) 12%,rgba(7,9,13,.96) 25%,rgba(7,9,13,.96) 75%,rgba(0,255,136,.18) 88%,transparent);
    border-top:2px solid #00ff88;border-bottom:2px solid #00ff88;
    padding:14px 0;text-align:center;font-family:'Share Tech Mono',monospace;}
  #fxCutin.loss{border-color:#ff2d55;
    background:linear-gradient(90deg,transparent,rgba(255,45,85,.18) 12%,rgba(7,9,13,.96) 25%,rgba(7,9,13,.96) 75%,rgba(255,45,85,.18) 88%,transparent);}
  #fxCutin.run{animation:fxCutinSlide 2.1s cubic-bezier(.2,.9,.25,1) forwards;}
  @keyframes fxCutinSlide{0%{left:-110%}18%{left:-5%}26%{left:-6.5%}74%{left:-6.5%}82%{left:-5%}100%{left:110%}}
  .fx-cutin-main{font-size:1.7rem;font-weight:900;color:#00ff88;letter-spacing:.18em;
    text-shadow:0 0 16px #00ff88,2px 0 0 rgba(0,212,255,.8),-2px 0 0 rgba(255,45,85,.55);
    animation:fxGlitch .18s steps(2) infinite;}
  #fxCutin.loss .fx-cutin-main{color:#ff2d55;text-shadow:0 0 16px #ff2d55,2px 0 0 rgba(255,214,10,.6);}
  .fx-cutin-sub{font-size:.8rem;color:#d0e8f8;letter-spacing:.3em;margin-top:2px;}
  @keyframes fxGlitch{0%{transform:translate(0)}25%{transform:translate(1.5px,-1px)}50%{transform:translate(-1.5px,1px)}75%{transform:translate(1px,1.5px)}100%{transform:translate(0)}}
  /* shake + vignette */
  body.fx-shake{animation:fxShake .45s;}
  @keyframes fxShake{0%,100%{transform:translate(0)}15%{transform:translate(-7px,3px)}30%{transform:translate(6px,-4px)}45%{transform:translate(-5px,-2px)}60%{transform:translate(4px,3px)}75%{transform:translate(-3px,1px)}90%{transform:translate(2px,-1px)}}
  #fxVignette{position:fixed;inset:0;z-index:9400;pointer-events:none;opacity:0;
    box-shadow:inset 0 0 120px 40px rgba(255,45,85,.55);transition:opacity .15s;}
  #fxVignette.on{opacity:1;animation:fxVigPulse .8s ease-out forwards;}
  @keyframes fxVigPulse{0%{opacity:1}100%{opacity:0}}
  /* particles canvas */
  #fxParticles{position:fixed;inset:0;z-index:9450;pointer-events:none;}
  /* sonar */
  #fxSonarWrap{display:flex;align-items:center;gap:4px;margin-left:8px;}
  #fxSonar{border-radius:50%;border:1px solid #2a3f55;background:radial-gradient(circle,#0d1117 60%,#07090d);}
  .fx-sonar-label{font-size:.58rem;color:#5a7a8a;font-family:'Share Tech Mono',monospace;writing-mode:vertical-rl;letter-spacing:.1em;}
  /* equity race */
  #fxRace{background:linear-gradient(180deg,rgba(0,212,255,.04),transparent);border:1px solid #2a3f55;
    border-radius:6px;padding:8px 12px;margin:8px 0;font-family:'Share Tech Mono',monospace;}
  #fxRace h4{font-size:.7rem;color:#5a7a8a;letter-spacing:.15em;margin:0 0 6px;display:flex;justify-content:space-between;cursor:pointer;}
  #fxRaceBody{display:flex;flex-direction:column;gap:3px;}
  .fx-race-row{display:flex;align-items:center;gap:8px;font-size:.66rem;height:16px;
    transition:transform .8s cubic-bezier(.3,.8,.3,1);}
  .fx-race-name{width:110px;white-space:nowrap;overflow:hidden;color:#d0e8f8;}
  .fx-race-track{flex:1;height:8px;background:rgba(42,63,85,.35);border-radius:4px;overflow:hidden;}
  .fx-race-bar{height:100%;border-radius:4px;transition:width .8s ease;box-shadow:0 0 8px currentColor;}
  .fx-race-val{width:64px;text-align:right;font-variant-numeric:tabular-nums;}
  .fx-race-val.up{color:#00ff88;}.fx-race-val.down{color:#ff2d55;}
  `;
  try { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); } catch (e) {}

  // ────────────────────────────── パーティクル(単一canvas, rAF)
  let pCanvas = null, pCtx = null, particles = [], pRunning = false;
  function burst(x, y, color, n = 26) {
    if (reduced) return;
    try {
      if (!pCanvas) {
        pCanvas = document.createElement('canvas');
        pCanvas.id = 'fxParticles';
        document.body.appendChild(pCanvas);
        pCtx = pCanvas.getContext('2d');
      }
      pCanvas.width = innerWidth; pCanvas.height = innerHeight;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 5;
        particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1, color });
      }
      if (!pRunning) { pRunning = true; requestAnimationFrame(pTick); }
    } catch (e) {}
  }
  function pTick() {
    if (!particles.length || document.hidden) { particles = []; pRunning = false; pCtx && pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height); return; }
    pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.02;
      pCtx.globalAlpha = Math.max(0, p.life);
      pCtx.fillStyle = p.color;
      pCtx.fillRect(p.x, p.y, 3, 3);
    }
    pCtx.globalAlpha = 1;
    particles = particles.filter(p => p.life > 0);
    requestAnimationFrame(pTick);
  }

  // ────────────────────────────── カットイン / シェイク
  let cutinBusy = false;
  function cutin(main, sub, isLoss) {
    try {
      if (cutinBusy) return;
      cutinBusy = true;
      let el = document.getElementById('fxCutin');
      if (!el) { el = document.createElement('div'); el.id = 'fxCutin'; document.body.appendChild(el); }
      el.className = isLoss ? 'loss' : '';
      el.innerHTML = `<div class="fx-cutin-main">${main}</div><div class="fx-cutin-sub">${sub}</div>`;
      if (reduced) {
        el.style.left = '-6%';
        setTimeout(() => { el.style.left = '-110%'; cutinBusy = false; }, 1600);
      } else {
        void el.offsetWidth;
        el.classList.add('run');
        if (!isLoss) burst(innerWidth / 2, innerHeight * 0.42, '#00ff88', 36);
        setTimeout(() => { el.classList.remove('run'); cutinBusy = false; }, 2200);
      }
    } catch (e) { cutinBusy = false; }
  }
  function shake() {
    if (reduced) return;
    try {
      let v = document.getElementById('fxVignette');
      if (!v) { v = document.createElement('div'); v.id = 'fxVignette'; document.body.appendChild(v); }
      v.classList.remove('on'); void v.offsetWidth; v.classList.add('on');
      document.body.classList.remove('fx-shake'); void document.body.offsetWidth;
      document.body.classList.add('fx-shake');
      setTimeout(() => document.body.classList.remove('fx-shake'), 500);
    } catch (e) {}
  }

  // ────────────────────────────── トレードイベント(cockpit-plusのラップにさらに重ねる)
  let streak = 0;
  function hookTradeLog() {
    const orig = window.addBotTradeLog;
    if (typeof orig !== 'function') return false;
    window.addBotTradeLog = function (def, type, dir, price, reason, pnlPct) {
      try {
        if (type === 'tp' || (pnlPct != null && pnlPct > 0 && type !== 'entry')) {
          streak++;
          if ((pnlPct >= 1.0 || streak >= 3)) {
            cutin(`⚡ BIG WIN!! ${def.emoji} ${def.name} +${(+pnlPct || 0).toFixed(2)}%`,
              streak >= 3 ? `${streak} WIN STREAK — 艦隊絶好調` : 'TAKE PROFIT CONFIRMED', false);
          }
        } else if (type === 'sl' || (pnlPct != null && pnlPct <= 0 && type !== 'entry')) {
          if (pnlPct <= -1.0) {
            shake();
            cutin(`💥 HEAVY LOSS ${def.emoji} ${def.name} ${(+pnlPct || 0).toFixed(2)}%`, 'DAMAGE REPORT — リスク管理を確認', true);
          }
          streak = 0;
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    return true;
  }

  // ────────────────────────────── ソナースイープ
  let sonarCanvas = null, sonarAngle = 0, blips = [];
  function setupSonar() {
    if (sonarCanvas || !document.querySelector('.ba-header')) return;
    const wr = document.getElementById('cpWarRoom');
    if (!wr) return;
    const wrap = document.createElement('span');
    wrap.id = 'fxSonarWrap';
    wrap.innerHTML = '<canvas id="fxSonar" width="64" height="64"></canvas>';
    wr.insertBefore(wrap, wr.firstChild);
    sonarCanvas = wrap.querySelector('#fxSonar');
    requestAnimationFrame(sonarTick);
  }
  function scanBlips() {
    try {
      const bots = window.ALL_BOTS || [];
      const states = window.botStates || {};
      const out = [];
      for (const def of bots) {
        const bs = states[def.id];
        if (!bs || !bs.params) continue;
        let level = 0;
        if (bs.position) level = 1.0;
        else if (bs.status === 'ready') level = 0.85;
        else {
          const r = typeof window.botComputeTF === 'function' ? window.botComputeTF(def.tf) : null;
          if (r) {
            const entry = Math.max(38, Math.min(75, bs.params.scoreEntry || 50));
            const dist = Math.min(Math.abs(r.score - entry), Math.abs(r.score - (100 - entry)));
            level = Math.max(0, 1 - dist / 15) * 0.7;
          }
        }
        if (level > 0.35) {
          // 決定的な角度(bot idハッシュ)+ levelで中心からの距離
          let h = 0;
          for (const ch of def.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          out.push({ angle: (h % 360) * Math.PI / 180, r: 1 - level * 0.75, level, holding: !!bs.position });
        }
      }
      blips = out;
    } catch (e) {}
  }
  function sonarTick() {
    if (!sonarCanvas) return;
    if (document.hidden) { setTimeout(() => requestAnimationFrame(sonarTick), 800); return; }
    try {
      const ctx = sonarCanvas.getContext('2d');
      const W = 64, C = 32, R = 30;
      ctx.clearRect(0, 0, W, W);
      ctx.strokeStyle = 'rgba(0,212,255,.25)';
      for (const rr of [10, 20, 30]) { ctx.beginPath(); ctx.arc(C, C, rr, 0, 7); ctx.stroke(); }
      // sweep
      sonarAngle += reduced ? 0 : 0.035;
      const grad = ctx.createConicGradient ? ctx.createConicGradient(sonarAngle, C, C) : null;
      if (grad) {
        grad.addColorStop(0, 'rgba(0,212,255,.5)');
        grad.addColorStop(0.12, 'rgba(0,212,255,0)');
        grad.addColorStop(1, 'rgba(0,212,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(C, C); ctx.arc(C, C, R, 0, 7); ctx.fill();
      }
      // blips
      const t = Date.now() / 300;
      for (const b of blips) {
        const x = C + Math.cos(b.angle) * b.r * R, y = C + Math.sin(b.angle) * b.r * R;
        const pulse = b.holding ? 1 : (0.6 + 0.4 * Math.sin(t + b.angle * 7));
        ctx.globalAlpha = Math.max(0.2, pulse);
        ctx.fillStyle = b.holding ? '#00ff88' : (b.level > 0.7 ? '#ffd60a' : '#00d4ff');
        ctx.beginPath(); ctx.arc(x, y, b.holding ? 2.5 : 2, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } catch (e) {}
    requestAnimationFrame(sonarTick);
  }

  // ────────────────────────────── エクイティレース
  let raceCollapsed = localStorage.getItem('fxRaceCollapsed') === '1';
  function setupRace() {
    if (document.getElementById('fxRace')) return;
    const wr = document.getElementById('cpWarRoom');
    if (!wr || !wr.parentNode) return;
    const el = document.createElement('div');
    el.id = 'fxRace';
    el.innerHTML = `<h4 id="fxRaceHead"><span>🏁 EQUITY RACE — 累計PnL順位</span><span>${raceCollapsed ? '▸' : '▾'}</span></h4><div id="fxRaceBody" style="${raceCollapsed ? 'display:none' : ''}"></div>`;
    wr.parentNode.insertBefore(el, wr.nextSibling);
    el.querySelector('#fxRaceHead').onclick = () => {
      raceCollapsed = !raceCollapsed;
      localStorage.setItem('fxRaceCollapsed', raceCollapsed ? '1' : '0');
      el.querySelector('#fxRaceBody').style.display = raceCollapsed ? 'none' : '';
      el.querySelector('#fxRaceHead span:last-child').textContent = raceCollapsed ? '▸' : '▾';
    };
  }
  function tickRace() {
    setupRace();
    if (raceCollapsed) return;
    const body = document.getElementById('fxRaceBody');
    if (!body) return;
    try {
      const bots = window.ALL_BOTS || [];
      const states = window.botStates || {};
      const rows = bots
        .map(d => ({ d, pnl: (states[d.id] || {}).totalPnlPct || 0 }))
        .sort((a, b) => b.pnl - a.pnl).slice(0, 8);
      if (!rows.length) return;
      const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.pnl)));
      // 行はbotId固定で再利用し、order+widthのtransitionで滑らかに入替
      for (let rank = 0; rank < rows.length; rank++) {
        const { d, pnl } = rows[rank];
        let row = body.querySelector(`[data-bot="${d.id}"]`);
        if (!row) {
          row = document.createElement('div');
          row.className = 'fx-race-row';
          row.dataset.bot = d.id;
          row.innerHTML = `<span class="fx-race-name"></span><div class="fx-race-track"><div class="fx-race-bar"></div></div><span class="fx-race-val"></span>`;
          body.appendChild(row);
        }
        row.style.order = rank;
        row.querySelector('.fx-race-name').textContent = `${rank + 1}. ${d.emoji} ${d.name}`;
        const bar = row.querySelector('.fx-race-bar');
        bar.style.width = `${(Math.abs(pnl) / maxAbs * 100).toFixed(0)}%`;
        bar.style.background = pnl >= 0 ? '#00ff88' : '#ff2d55';
        bar.style.color = pnl >= 0 ? '#00ff88' : '#ff2d55';
        const val = row.querySelector('.fx-race-val');
        val.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
        val.className = 'fx-race-val ' + (pnl >= 0 ? 'up' : 'down');
      }
      body.style.display = raceCollapsed ? 'none' : 'flex';
      // 圏外行を除去
      for (const row of [...body.children]) {
        if (!rows.some(r => r.d.id === row.dataset.bot)) row.remove();
      }
    } catch (e) {}
  }

  // ────────────────────────────── 起動
  function init() {
    let tries = 0;
    const boot = setInterval(() => {
      tries++;
      if (hookTradeLog() || tries > 60) {
        clearInterval(boot);
        setInterval(() => { setupSonar(); scanBlips(); }, 2000);
        setInterval(tickRace, 5000);
        setTimeout(tickRace, 3000);
        log('ready — カットイン/シェイク/ソナー/エクイティレース 起動');
      }
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
