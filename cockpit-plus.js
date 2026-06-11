// ═══════════════════════════════════════════════
// COCKPIT PLUS — サイバーコックピット演出強化
//
// 全て追加的(既存ファイル無改変・windowラップのみ)。失敗時は静かに無効化。
//  1. EVOLUTIONオーバーレイ: 即時進化中のスキャンライン+世代進捗+適応度カチカチ
//  2. botカード装飾: FITバッジ / バックテストエクイティのスパークライン /
//     「エントリー間近」近接グロー(スコアが閾値に近づくほど光る)
//  3. 勝敗演出: 勝ち=緑バースト+「+X%」フロート+連勝コンボ、負け=赤シェイク
//  4. 作戦司令室ストリップ: 稼働ポジ数・艦隊含み損益・コンボが毎秒チクタク
//  5. Web Audioビープ(エントリー/TP/SL、🔊トグルでミュート、設定保存)
// ═══════════════════════════════════════════════
(function () {
  'use strict';
  const TAG = '[CockpitPlus]';
  function log(...a) { try { console.log(TAG, ...a); } catch (e) {} }

  // ────────────────────────────── CSS注入
  const css = `
  /* EVOLUTION overlay */
  #cpEvoOverlay{position:fixed;inset:0;z-index:9999;background:rgba(4,8,14,.92);display:flex;
    flex-direction:column;align-items:center;justify-content:center;gap:14px;
    font-family:'Share Tech Mono',monospace;color:#00d4ff;opacity:0;pointer-events:none;
    transition:opacity .4s;}
  #cpEvoOverlay.on{opacity:1;pointer-events:auto;}
  #cpEvoOverlay::before{content:'';position:absolute;inset:0;pointer-events:none;
    background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(0,212,255,.05) 2px 4px);
    animation:cpScan 6s linear infinite;}
  @keyframes cpScan{from{background-position:0 0}to{background-position:0 120px}}
  .cp-evo-title{font-size:1.5rem;letter-spacing:.4em;text-shadow:0 0 18px #00d4ff;
    animation:cpFlicker 1.2s infinite;}
  @keyframes cpFlicker{0%,100%{opacity:1}45%{opacity:1}50%{opacity:.55}55%{opacity:1}}
  .cp-evo-sub{font-size:.78rem;color:#5a7a8a;letter-spacing:.2em;}
  .cp-evo-bar{width:min(480px,80vw);height:8px;border:1px solid #2a3f55;border-radius:4px;overflow:hidden;}
  .cp-evo-fill{height:100%;width:0%;background:linear-gradient(90deg,#00d4ff,#00ff88);
    box-shadow:0 0 12px #00ff88;transition:width .35s;}
  .cp-evo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;
    width:min(560px,86vw);max-height:40vh;overflow:hidden;}
  .cp-evo-bot{font-size:.66rem;border:1px solid #1c2a3a;border-radius:4px;padding:4px 6px;
    display:flex;justify-content:space-between;gap:6px;background:rgba(13,17,23,.7);}
  .cp-evo-bot b{color:#00ff88;font-variant-numeric:tabular-nums;}
  .cp-evo-bot.up b{text-shadow:0 0 8px #00ff88;}
  /* bot card decorations */
  .cp-fit{font-size:.62rem;font-family:'Share Tech Mono',monospace;color:#00d4ff;
    border:1px solid rgba(0,212,255,.35);border-radius:3px;padding:1px 5px;margin-left:auto;
    white-space:nowrap;}
  .cp-fit b{color:#00ff88;}
  .cp-spark{margin-left:6px;vertical-align:middle;opacity:.9;}
  .ba-bot{--cp-glow:0;}
  .ba-bot.cp-glowing{box-shadow:0 0 calc(var(--cp-glow)*22px)
    rgba(0,212,255,calc(var(--cp-glow)*.55));}
  .cp-imminent{font-size:.6rem;color:#ffd60a;border:1px solid rgba(255,214,10,.5);
    border-radius:3px;padding:1px 5px;letter-spacing:.1em;animation:cpBlink .7s infinite;white-space:nowrap;}
  @keyframes cpBlink{50%{opacity:.25}}
  .ba-bot.cp-entry-flash{animation:cpEntryFlash 1.2s ease-out;}
  @keyframes cpEntryFlash{0%{box-shadow:0 0 0 rgba(0,212,255,0)}25%{box-shadow:0 0 34px rgba(0,212,255,.9)}100%{box-shadow:0 0 0 rgba(0,212,255,0)}}
  .ba-bot.cp-win-flash{animation:cpWinFlash 1.6s ease-out;}
  @keyframes cpWinFlash{0%{box-shadow:0 0 0 rgba(0,255,136,0)}20%{box-shadow:0 0 40px rgba(0,255,136,.95)}100%{box-shadow:0 0 0 rgba(0,255,136,0)}}
  .ba-bot.cp-loss-shake{animation:cpShake .5s;}
  @keyframes cpShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
  /* floating result feed */
  #cpFeed{position:fixed;right:12px;bottom:80px;z-index:9000;display:flex;flex-direction:column-reverse;
    gap:6px;pointer-events:none;}
  .cp-float{font-family:'Share Tech Mono',monospace;font-weight:700;font-size:.95rem;
    padding:6px 12px;border-radius:6px;background:rgba(7,9,13,.9);border:1px solid;
    animation:cpFloatUp 2.6s ease-out forwards;}
  .cp-float.win{color:#00ff88;border-color:#00ff88;text-shadow:0 0 10px #00ff88;}
  .cp-float.loss{color:#ff2d55;border-color:#ff2d55;}
  .cp-float.entry{color:#00d4ff;border-color:#00d4ff;}
  @keyframes cpFloatUp{0%{opacity:0;transform:translateY(14px)}10%{opacity:1;transform:translateY(0)}
    80%{opacity:1}100%{opacity:0;transform:translateY(-22px)}}
  /* war-room strip */
  #cpWarRoom{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;
    background:linear-gradient(90deg,rgba(0,212,255,.06),rgba(0,255,136,.05));
    border:1px solid #2a3f55;border-left:3px solid #00d4ff;border-radius:6px;
    padding:7px 12px;margin:8px 0;font-family:'Share Tech Mono',monospace;font-size:.72rem;}
  #cpWarRoom .wr{color:#5a7a8a;letter-spacing:.08em;white-space:nowrap;}
  #cpWarRoom .wr b{color:#d0e8f8;font-size:.85rem;font-variant-numeric:tabular-nums;}
  #cpWarRoom .wr b.up{color:#00ff88;text-shadow:0 0 8px rgba(0,255,136,.6);}
  #cpWarRoom .wr b.down{color:#ff2d55;}
  #cpWarRoom .wr b.combo{color:#ffd60a;}
  #cpMute{cursor:pointer;margin-left:auto;background:none;border:1px solid #2a3f55;
    border-radius:4px;color:#5a7a8a;font-size:.8rem;padding:2px 8px;}
  #cpMute.on{color:#00d4ff;border-color:#00d4ff;}
  `;
  try {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  } catch (e) {}

  // ────────────────────────────── Web Audio
  let audioCtx = null;
  let muted = localStorage.getItem('cpMute') === '1';
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  document.addEventListener('pointerdown', ensureAudio, { once: true });
  function beep(freqs, dur = 0.09, type = 'square', gain = 0.04) {
    if (muted || !audioCtx || audioCtx.state !== 'running') return;
    try {
      let t = audioCtx.currentTime;
      for (const f of freqs) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + dur);
        t += dur * 0.9;
      }
    } catch (e) {}
  }
  const sfx = {
    entry: () => beep([880], 0.07),
    tp: () => beep([660, 990, 1320], 0.09),
    sl: () => beep([220, 165], 0.12, 'sawtooth'),
  };

  // ────────────────────────────── 勝敗演出 + コンボ
  let combo = 0, bestCombo = parseInt(localStorage.getItem('cpBestCombo') || '0');
  function getFeed() {
    let el = document.getElementById('cpFeed');
    if (!el) { el = document.createElement('div'); el.id = 'cpFeed'; document.body.appendChild(el); }
    return el;
  }
  function float(text, cls) {
    try {
      const d = document.createElement('div');
      d.className = 'cp-float ' + cls;
      d.textContent = text;
      const feed = getFeed();
      feed.appendChild(d);
      while (feed.children.length > 5) feed.removeChild(feed.firstChild);
      setTimeout(() => d.remove(), 2700);
    } catch (e) {}
  }
  function flashCard(botId, cls) {
    const el = document.getElementById('bot-card-' + botId);
    if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; // restart animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1800);
  }
  function onTradeEvent(def, type, dir, price, reason, pnlPct) {
    if (type === 'entry') {
      flashCard(def.id, 'cp-entry-flash');
      float(`⚡ ${def.emoji} ${def.name} ${dir} エントリー`, 'entry');
      sfx.entry();
    } else if (type === 'tp' || (pnlPct != null && pnlPct > 0)) {
      combo++;
      if (combo > bestCombo) { bestCombo = combo; localStorage.setItem('cpBestCombo', bestCombo); }
      flashCard(def.id, 'cp-win-flash');
      float(`💰 ${def.emoji} ${def.name} +${(+pnlPct || 0).toFixed(2)}%${combo >= 2 ? `  🔥${combo}連勝` : ''}`, 'win');
      sfx.tp();
    } else if (type === 'sl' || (pnlPct != null && pnlPct <= 0)) {
      combo = 0;
      flashCard(def.id, 'cp-loss-shake');
      float(`💥 ${def.emoji} ${def.name} ${(+pnlPct || 0).toFixed(2)}%`, 'loss');
      sfx.sl();
    }
  }
  // 素のaddBotTradeLog呼び出しはグローバル束縛経由なので再代入で介入できる
  function wrapTradeLog() {
    const orig = window.addBotTradeLog;
    if (typeof orig !== 'function') return false;
    window.addBotTradeLog = function (def, type, dir, price, reason, pnlPct) {
      try { onTradeEvent(def, type, dir, price, reason, pnlPct); } catch (e) {}
      return orig.apply(this, arguments);
    };
    return true;
  }

  // ────────────────────────────── EVOLUTIONオーバーレイ
  function getOverlay() {
    let ov = document.getElementById('cpEvoOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'cpEvoOverlay';
      ov.innerHTML = `
        <div class="cp-evo-title">⬡ EVOLUTION PROTOCOL</div>
        <div class="cp-evo-sub" id="cpEvoSub">過去1000本のバックテストでbot艦隊を進化中…</div>
        <div class="cp-evo-bar"><div class="cp-evo-fill" id="cpEvoFill"></div></div>
        <div class="cp-evo-grid" id="cpEvoGrid"></div>`;
      document.body.appendChild(ov);
    }
    return ov;
  }
  const lastFit = {};
  function renderEvoGrid(fitness) {
    const grid = document.getElementById('cpEvoGrid');
    if (!grid || !fitness) return;
    const bots = (window.ALL_BOTS || []).slice(0, 18);
    grid.innerHTML = bots.map(d => {
      const f = fitness[d.id];
      if (!f) return '';
      const up = lastFit[d.id] != null && f.fitness > lastFit[d.id];
      lastFit[d.id] = f.fitness;
      return `<div class="cp-evo-bot ${up ? 'up' : ''}"><span>${d.emoji} ${d.name}</span><b>${f.fitness}</b></div>`;
    }).join('');
  }
  window.addEventListener('evoboost-start', (e) => {
    getOverlay().classList.add('on');
    const sub = document.getElementById('cpEvoSub');
    if (sub) sub.textContent = `GA進化を即時実行: ${e.detail.generations}世代 (ライブ実績の不足をバックテストで補完)`;
  });
  window.addEventListener('evoboost-progress', (e) => {
    getOverlay().classList.add('on');
    const { gen, total, fitness } = e.detail;
    const fill = document.getElementById('cpEvoFill');
    if (fill) fill.style.width = `${Math.round(gen / total * 100)}%`;
    const sub = document.getElementById('cpEvoSub');
    if (sub) sub.textContent = `GENERATION ${gen}/${total} — 適応度を再評価中…`;
    renderEvoGrid(fitness);
  });
  window.addEventListener('evoboost-done', (e) => {
    const ov = document.getElementById('cpEvoOverlay');
    if (!ov || !ov.classList.contains('on')) return;
    const fill = document.getElementById('cpEvoFill');
    if (fill) fill.style.width = '100%';
    const sub = document.getElementById('cpEvoSub');
    if (sub) sub.textContent = '✓ 進化完了 — bot艦隊は最新相場に適応済み';
    renderEvoGrid(e.detail && e.detail.fitness);
    setTimeout(() => ov.classList.remove('on'), 1800);
  });

  // ────────────────────────────── botカード装飾(再renderで消えるため毎tick再適用)
  function sparklineSVG(curve, w = 56, h = 16) {
    if (!curve || curve.length < 2) return '';
    const step = Math.max(1, Math.floor(curve.length / 28));
    const pts = [];
    for (let i = 0; i < curve.length; i += step) pts.push(curve[i].value);
    pts.push(curve[curve.length - 1].value);
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    const path = pts.map((v, i) =>
      `${(i / (pts.length - 1) * w).toFixed(1)},${(h - (v - min) / span * (h - 2) - 1).toFixed(1)}`).join(' ');
    const upCls = pts[pts.length - 1] >= pts[0] ? '#00ff88' : '#ff2d55';
    return `<svg class="cp-spark" width="${w}" height="${h}"><polyline points="${path}" fill="none" stroke="${upCls}" stroke-width="1.2"/></svg>`;
  }

  function decorateCards() {
    const bots = window.ALL_BOTS || [];
    const states = window.botStates || {};
    const EB = window.EvolutionBoost;
    for (const def of bots) {
      const card = document.getElementById('bot-card-' + def.id);
      if (!card) continue;
      const bs = states[def.id];
      if (!bs) continue;
      const top = card.querySelector('.ba-bot-top');

      // FITバッジ + スパークライン
      if (top && !top.querySelector('.cp-fit')) {
        try {
          const fit = typeof window.calcFitnessPlus === 'function' ? window.calcFitnessPlus(bs) : 0;
          const bt = EB && EB.isReady() ? EB.btResultFor(def.id) : null;
          const span = document.createElement('span');
          span.className = 'cp-fit';
          span.innerHTML = `FIT <b>${(+fit).toFixed(1)}</b>${bt ? ` · BT勝率${bt.winRate.toFixed(0)}%` : ''}` +
            (bt ? sparklineSVG(bt.equityCurve) : '');
          span.title = bt
            ? `バックテスト(直近1000本): ${bt.tradeCount}回 / PnL ${bt.pnlPct.toFixed(2)}% / DD ${bt.maxDrawdownPct.toFixed(1)}%`
            : 'バックテスト準備中…';
          top.appendChild(span);
        } catch (e) {}
      }

      // エントリー間近メーター(近接グロー)
      try {
        const r = typeof window.botComputeTF === 'function' ? window.botComputeTF(def.tf) : null;
        if (r && bs.params && !bs.position) {
          const entry = Math.max(38, Math.min(75, bs.params.scoreEntry || 50));
          const dist = Math.min(Math.abs(r.score - entry), Math.abs(r.score - (100 - entry)));
          const glow = Math.max(0, 1 - dist / 15);
          card.style.setProperty('--cp-glow', glow.toFixed(2));
          card.classList.toggle('cp-glowing', glow > 0.05);
          let tag = card.querySelector('.cp-imminent');
          if (glow > 0.75 || bs.status === 'ready') {
            if (!tag && top) {
              tag = document.createElement('span');
              tag.className = 'cp-imminent';
              top.appendChild(tag);
            }
            if (tag) tag.textContent = bs.status === 'ready' ? '🚨 突入態勢' : '⚡ エントリー間近';
          } else if (tag) tag.remove();
        } else {
          card.classList.remove('cp-glowing');
          const tag = card.querySelector('.cp-imminent');
          if (tag) tag.remove();
        }
      } catch (e) {}
    }
  }

  // ────────────────────────────── 作戦司令室ストリップ
  function getWarRoom() {
    let el = document.getElementById('cpWarRoom');
    if (el) return el;
    const header = document.querySelector('.ba-header');
    if (!header || !header.parentNode) return null;
    el = document.createElement('div');
    el.id = 'cpWarRoom';
    el.innerHTML = `
      <span class="wr">⬡ 司令室</span>
      <span class="wr">稼働ポジ <b id="cpWrPos">0</b></span>
      <span class="wr">艦隊含み損益 <b id="cpWrPnl">+0.00%</b></span>
      <span class="wr">本日 <b id="cpWrToday">0勝0敗</b></span>
      <span class="wr">連勝 <b class="combo" id="cpWrCombo">0</b> <span style="opacity:.6">(最高${bestCombo})</span></span>
      <span class="wr">世代 <b id="cpWrGen">—</b></span>
      <button id="cpMute" title="効果音 ON/OFF">${muted ? '🔇' : '🔊'}</button>`;
    header.parentNode.insertBefore(el, header.nextSibling);
    el.querySelector('#cpMute').onclick = function () {
      muted = !muted;
      localStorage.setItem('cpMute', muted ? '1' : '0');
      this.textContent = muted ? '🔇' : '🔊';
      this.classList.toggle('on', !muted);
      if (!muted) { ensureAudio(); sfx.entry(); }
    };
    return el;
  }
  function tickWarRoom() {
    const el = getWarRoom();
    if (!el) return;
    try {
      const S = window.S || {};
      const states = window.botStates || {};
      const bots = window.ALL_BOTS || [];
      let posCount = 0, pnlSum = 0, wins = 0, losses = 0;
      const todayStr = new Date().toDateString();
      for (const d of bots) {
        const bs = states[d.id];
        if (!bs) continue;
        const pos = bs.position;
        if (pos && S.price > 0) {
          posCount++;
          const raw = pos.dir === 'LONG'
            ? (S.price - pos.entry) / pos.entry
            : (pos.entry - S.price) / pos.entry;
          pnlSum += raw * 100 * (pos.lev || 1);
        }
        for (const t of (bs.trades || [])) {
          if (t.exitTime && new Date(t.exitTime).toDateString() === todayStr) {
            if (t.win) wins++; else losses++;
          }
        }
      }
      const set = (id, txt) => { const n = document.getElementById(id); if (n) n.textContent = txt; };
      set('cpWrPos', posCount);
      const pnlEl = document.getElementById('cpWrPnl');
      if (pnlEl) {
        pnlEl.textContent = `${pnlSum >= 0 ? '+' : ''}${pnlSum.toFixed(2)}%`;
        pnlEl.className = pnlSum >= 0 ? 'up' : 'down';
      }
      set('cpWrToday', `${wins}勝${losses}敗`);
      set('cpWrCombo', combo);
      const gen = localStorage.getItem(`gaGen_${window.currentCoin || 'BTC'}`);
      set('cpWrGen', gen ? `G${gen}` : '—');
    } catch (e) {}
  }

  // ────────────────────────────── 起動
  function init() {
    let tries = 0;
    const boot = setInterval(() => {
      tries++;
      const ok = wrapTradeLog();
      if (ok || tries > 60) {
        clearInterval(boot);
        if (!ok) { log('addBotTradeLog不在 — 勝敗演出は無効'); }
        // 再render直後に装飾を即時再適用(点滅防止)
        const origRender = window.renderBotCards;
        if (typeof origRender === 'function') {
          window.renderBotCards = function () {
            const r = origRender.apply(this, arguments);
            try { decorateCards(); } catch (e) {}
            return r;
          };
        }
        setInterval(decorateCards, 1500);
        setInterval(tickWarRoom, 1000);
        log('ready — 司令室/近接グロー/勝敗演出/EVOLUTIONオーバーレイ 起動');
      }
    }, 500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
