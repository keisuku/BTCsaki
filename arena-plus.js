/*
 * arena-plus.js — Bot Arena UI拡張
 *
 * 追加機能:
 *   1. Canvas Chartへの bot取引マーカーオーバーレイ (entry/exit矢印)
 *   2. Volume Profile オーバーレイ (POC/VAH/VAL)
 *   3. CVDパネル + ダイバージェンス警告
 *   4. DOM(板) 可視化 + 大口壁検出
 *   5. 清算クラスタ可視化
 *   6. Hall of Fame パネル
 *   7. Daily AI Insights パネル
 *   8. 各bot のミニ equity curve sparkline
 */
(function(){
  'use strict';

  // ═══════════════════════════════════════════════
  // 1. Chart Overlay: 既存のdrawBaChart呼び出し後にフック
  // ═══════════════════════════════════════════════

  function installChartOverlay(){
    // 既存のdrawBaChartをwrapする
    if(typeof window.drawBaChart !== 'function') return false;
    if(window._chartOverlayInstalled) return true;

    const original = window.drawBaChart;
    window.drawBaChart = function(){
      original.apply(this, arguments);
      try{ drawChartOverlay(); }catch(e){ /* console.warn('overlay err', e); */ }
    };
    window._chartOverlayInstalled = true;
    console.log('[ArenaPlus] Chart overlay installed');
    return true;
  }

  function drawChartOverlay(){
    const canvas = document.getElementById('baChartCanvas');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;

    const tf = window.baChartTf || '5m';
    const kl = window.KL && window.KL[tf] ? window.KL[tf]() : null;
    if(!kl || kl.length < 10) return;

    const candles = kl.slice(-60);
    const pad = { l: 48, r: 6, t: 4, b: 16 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    const n = candles.length;
    const gap = cw / n;

    // Re-derive priceY (we need minP, maxP same way as original)
    let minP = Infinity, maxP = -Infinity;
    for(const k of candles){
      const lo = parseFloat(k[3]), hi = parseFloat(k[2]);
      if(lo < minP) minP = lo;
      if(hi > maxP) maxP = hi;
    }
    const range = maxP - minP || 1;
    minP -= range * 0.02;
    maxP += range * 0.02;
    const fullRange = maxP - minP;
    const priceY = p => pad.t + ch * (1 - (p - minP) / fullRange);
    const firstTs = parseInt(candles[0][0]);
    const lastTs = parseInt(candles[n-1][0]);
    const tfMs = (lastTs - firstTs) / Math.max(1, n-1);

    // --- (A) Volume Profile Overlay (right-side horizontal bars) ---
    drawVolumeProfile(ctx, candles, pad, W, H, cw, ch, priceY, minP, maxP);

    // --- (B) Liquidation clusters (horizontal ghost lines) ---
    drawLiquidationClusters(ctx, pad, W, H, priceY, minP, maxP);

    // --- (C) Bot trade markers ---
    drawBotTradeMarkers(ctx, pad, cw, ch, gap, firstTs, lastTs, tfMs, priceY, minP, maxP);

    // --- (D) CVD mini-pane at bottom ---
    drawCvdPane(ctx, pad, cw, H, candles);
  }

  function drawVolumeProfile(ctx, candles, pad, W, H, cw, ch, priceY, minP, maxP){
    if(!window.RealtimePlus || !window.RealtimePlus.VP) return;
    const vp = window.RealtimePlus.VP.compute(candles, 30);
    if(!vp) return;

    // Draw horizontal bars on right side
    const barW = Math.min(60, cw * 0.25);
    const maxVol = Math.max(...vp.distribution);
    const binSize = vp.binSize;

    ctx.save();
    vp.distribution.forEach((vol, i) => {
      if(vol <= 0) return;
      const binBottom = vp.minP + binSize * i;
      const binTop = binBottom + binSize;
      const yTop = priceY(binTop);
      const yBot = priceY(binBottom);
      const barH = Math.max(1, yBot - yTop);
      const w = (vol / maxVol) * barW;
      const x = W - pad.r - w;
      ctx.fillStyle = 'rgba(167,139,250,0.18)';
      ctx.fillRect(x, yTop, w, barH - 0.5);
    });

    // POC line (red)
    const pocY = priceY(vp.poc);
    if(pocY >= pad.t && pocY <= pad.t + ch){
      ctx.strokeStyle = 'rgba(255,214,10,0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.l, pocY);
      ctx.lineTo(W - pad.r, pocY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd60a';
      ctx.font = '8px "Share Tech Mono"';
      ctx.textAlign = 'right';
      ctx.fillText('POC', W - pad.r - 2, pocY - 2);
    }

    // VAH/VAL (dim)
    [['VAH', vp.vah], ['VAL', vp.val]].forEach(([lbl, p]) => {
      const y = priceY(p);
      if(y >= pad.t && y <= pad.t + ch){
        ctx.strokeStyle = 'rgba(167,139,250,0.25)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(W - pad.r, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#a78bfa';
        ctx.font = '8px "Share Tech Mono"';
        ctx.textAlign = 'right';
        ctx.fillText(lbl, W - pad.r - 2, y - 2);
      }
    });
    ctx.restore();
  }

  function drawLiquidationClusters(ctx, pad, W, H, priceY, minP, maxP){
    if(!window.RealtimePlus || !window.RealtimePlus.LiqEstimator) return;
    const S = window.S;
    if(!S || !S.price) return;
    const est = window.RealtimePlus.LiqEstimator.estimate(S.price, S.oiVal, S.fr, S.ls);
    if(!est || !est.all) return;

    ctx.save();
    // Top densities above and below
    const aboveTop3 = est.all.above.slice(0, 3);
    const belowTop3 = est.all.below.slice(0, 3);

    aboveTop3.forEach((c, i) => {
      if(c.price < minP || c.price > maxP) return;
      const y = priceY(c.price);
      const alpha = 0.35 - i*0.08;
      ctx.fillStyle = `rgba(255,45,85,${alpha})`;
      ctx.fillRect(pad.l, y - 1, 8, 2);
      ctx.fillStyle = `rgba(255,45,85,${alpha*0.5})`;
      ctx.font = '7px "Share Tech Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`💀${c.lev}x`, pad.l + 10, y + 2);
    });
    belowTop3.forEach((c, i) => {
      if(c.price < minP || c.price > maxP) return;
      const y = priceY(c.price);
      const alpha = 0.35 - i*0.08;
      ctx.fillStyle = `rgba(0,255,136,${alpha})`;
      ctx.fillRect(pad.l, y - 1, 8, 2);
      ctx.fillStyle = `rgba(0,255,136,${alpha*0.5})`;
      ctx.font = '7px "Share Tech Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`🧲${c.lev}x`, pad.l + 10, y + 2);
    });
    ctx.restore();
  }

  function drawBotTradeMarkers(ctx, pad, cw, ch, gap, firstTs, lastTs, tfMs, priceY, minP, maxP){
    if(!window.botStates || !window.ALL_BOTS) return;
    const now = Date.now();

    ctx.save();
    // Collect all recent trades and open positions
    const markers = [];
    window.ALL_BOTS.forEach(def => {
      const bs = window.botStates[def.id];
      if(!bs) return;
      // Open position
      if(bs.position){
        const p = bs.position;
        if(p.time >= firstTs){
          markers.push({
            type: 'entry',
            dir: p.dir,
            time: p.time,
            price: p.entry,
            botId: def.id,
            botName: def.name,
            emoji: def.emoji,
            open: true,
          });
        }
      }
      // Recent closed trades (within chart window)
      (bs.trades || []).slice(-30).forEach(t => {
        const entryMs = t.entryTime ? new Date(t.entryTime).getTime() : null;
        const exitMs  = t.exitTime  ? new Date(t.exitTime).getTime()  : null;
        if(entryMs && entryMs >= firstTs - tfMs){
          markers.push({ type:'entry', dir:t.dir, time:entryMs, price:t.entry, botId:def.id, botName:def.name, emoji:def.emoji, win:t.win, pnlPct:t.pnlPct, open:false });
        }
        if(exitMs && exitMs >= firstTs - tfMs){
          markers.push({ type:'exit', dir:t.dir, time:exitMs, price:t.exit, botId:def.id, botName:def.name, emoji:def.emoji, win:t.win, pnlPct:t.pnlPct });
        }
      });
    });

    markers.forEach(m => {
      if(m.price < minP || m.price > maxP) return;
      const xFrac = (m.time - firstTs) / (lastTs - firstTs + tfMs);
      if(xFrac < 0 || xFrac > 1) return;
      const x = pad.l + xFrac * cw;
      const y = priceY(m.price);

      const isLong = m.dir === 'LONG';
      const isEntry = m.type === 'entry';

      ctx.fillStyle = m.win === true ? '#00ff88' :
                      m.win === false ? '#ff2d55' :
                      isLong ? '#00d4ff' : '#ff6b35';
      ctx.globalAlpha = m.open ? 1 : 0.75;

      // Draw triangle arrow
      const size = m.open ? 5 : 3.5;
      ctx.beginPath();
      if(isEntry){
        if(isLong){
          // Up-pointing triangle below price
          ctx.moveTo(x, y + 2);
          ctx.lineTo(x - size, y + 2 + size*1.6);
          ctx.lineTo(x + size, y + 2 + size*1.6);
        } else {
          // Down-pointing triangle above price
          ctx.moveTo(x, y - 2);
          ctx.lineTo(x - size, y - 2 - size*1.6);
          ctx.lineTo(x + size, y - 2 - size*1.6);
        }
      } else {
        // Exit: small square
        const s = size * 0.8;
        ctx.rect(x - s/2, y - s/2, s, s);
      }
      ctx.closePath();
      ctx.fill();

      // Pulse animation for open positions
      if(m.open){
        const pulse = (Math.sin(now / 300) + 1) / 2; // 0..1
        ctx.globalAlpha = 0.3 + pulse * 0.3;
        ctx.beginPath();
        ctx.arc(x, y, size + 4 + pulse * 3, 0, Math.PI * 2);
        ctx.strokeStyle = isLong ? '#00ff88' : '#ff2d55';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function drawCvdPane(ctx, pad, cw, H, candles){
    if(!window.RealtimePlus || !window.RealtimePlus.CVD) return;
    const cvd = window.RealtimePlus.CVD;
    if(!cvd.series || cvd.series.length < 5) return;

    // Map CVD series times to chart x coordinates
    const firstTs = parseInt(candles[0][0]);
    const lastTs  = parseInt(candles[candles.length-1][0]);
    const span    = Math.max(1, lastTs - firstTs);

    const filtered = cvd.series.filter(b => b.t >= firstTs && b.t <= lastTs + span/candles.length);
    if(filtered.length < 3) return;

    const cvdVals = filtered.map(b => b.cvd);
    const minC = Math.min(...cvdVals);
    const maxC = Math.max(...cvdVals);
    const cRange = (maxC - minC) || 1;

    const paneH = 20;
    const paneY = H - pad.b - paneH - 2;

    // Background
    ctx.save();
    ctx.fillStyle = 'rgba(167,139,250,0.04)';
    ctx.fillRect(pad.l, paneY, cw, paneH);

    // Zero baseline (if range crosses zero)
    if(minC < 0 && maxC > 0){
      const zeroY = paneY + paneH * (1 - (0 - minC)/cRange);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(pad.l+cw, zeroY); ctx.stroke();
    }

    // CVD line
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    filtered.forEach((b, i) => {
      const xFrac = (b.t - firstTs) / span;
      const x = pad.l + xFrac * cw;
      const y = paneY + paneH * (1 - (b.cvd - minC)/cRange);
      if(i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Label
    ctx.fillStyle = '#c4b5fd';
    ctx.font = '8px "Share Tech Mono"';
    ctx.textAlign = 'left';
    ctx.fillText('CVD', pad.l + 2, paneY + 8);

    // Divergence warning
    const div = cvd.detectDivergence(60);
    if(div){
      const color = div.type === 'bearish' ? '#ff6b35' : '#00ff88';
      ctx.fillStyle = color;
      ctx.font = 'bold 8px "Share Tech Mono"';
      ctx.textAlign = 'right';
      ctx.fillText(`${div.type==='bearish'?'⚠ 弱気ダイバージェンス':'⚡ 強気ダイバージェンス'}`, pad.l + cw - 2, paneY + 8);
    }
    ctx.restore();
  }

  // ═══════════════════════════════════════════════
  // 2. CVD / DOM Panel (新セクション)
  // ═══════════════════════════════════════════════

  const CVD_PANEL_HTML = `
    <div class="ap-panel" id="apRealtime">
      <div class="ap-panel-title">⚡ リアルタイム オーダーフロー <span class="ap-live-pulse"></span></div>
      <div class="ap-realtime-grid">
        <div class="ap-rt-cell">
          <div class="ap-rt-lbl">CVD (本日)</div>
          <div class="ap-rt-val" id="apCvdTotal">--</div>
          <div class="ap-rt-sub" id="apCvdMom">momentum: --</div>
        </div>
        <div class="ap-rt-cell">
          <div class="ap-rt-lbl">DOM 非対称度</div>
          <div class="ap-rt-val" id="apDomImb">--</div>
          <div class="ap-rt-sub" id="apDomSpread">spread: --</div>
        </div>
        <div class="ap-rt-cell">
          <div class="ap-rt-lbl">大口壁</div>
          <div class="ap-rt-val" id="apWalls">--</div>
          <div class="ap-rt-sub" id="apWallDetail">--</div>
        </div>
        <div class="ap-rt-cell">
          <div class="ap-rt-lbl">真のDelta (1m)</div>
          <div class="ap-rt-val" id="apTrueDelta">--</div>
          <div class="ap-rt-sub">taker buy - sell</div>
        </div>
      </div>
      <div class="ap-rt-divergence" id="apDivergence"></div>
    </div>
  `;

  const HOF_PANEL_HTML = `
    <div class="ap-panel" id="apHallOfFame">
      <div class="ap-panel-title">🏆 殿堂入りDNA — Hall of Fame</div>
      <div class="ap-hof-list" id="apHofList"><div class="ap-hof-empty">データ蓄積中... 最低5トレード後に記録されます。</div></div>
    </div>
  `;

  const INSIGHTS_PANEL_HTML = `
    <div class="ap-panel" id="apInsights">
      <div class="ap-panel-title">🧠 本日のAI分析</div>
      <div class="ap-insights-body" id="apInsightsBody">分析生成中...</div>
    </div>
  `;

  const CSS = `
    .ap-panel{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:10px 14px;position:relative;overflow:hidden;}
    .ap-panel::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#a78bfa,#00d4ff);}
    .ap-panel-title{font-family:'Share Tech Mono',monospace;font-size:.72rem;color:#c4b5fd;letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .ap-live-pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:apPulse 1.2s infinite;}
    @keyframes apPulse{0%,100%{opacity:1}50%{opacity:.3}}
    .ap-realtime-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
    @media(max-width:520px){.ap-realtime-grid{grid-template-columns:repeat(2,1fr);}}
    .ap-rt-cell{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;}
    .ap-rt-lbl{font-family:'Share Tech Mono',monospace;font-size:.5rem;color:var(--dim);letter-spacing:.15em;text-transform:uppercase;margin-bottom:4px;}
    .ap-rt-val{font-family:'Share Tech Mono',monospace;font-size:.95rem;font-weight:bold;color:var(--text);line-height:1.1;}
    .ap-rt-val.bull{color:var(--green);}
    .ap-rt-val.bear{color:var(--red);}
    .ap-rt-val.neut{color:var(--yellow);}
    .ap-rt-sub{font-family:'Share Tech Mono',monospace;font-size:.54rem;color:var(--dim);margin-top:3px;}
    .ap-rt-divergence{margin-top:10px;padding:8px 10px;border-radius:6px;display:none;font-size:.75rem;font-weight:700;}
    .ap-rt-divergence.bull{display:block;background:rgba(0,255,136,.08);border:1px solid rgba(0,255,136,.3);color:var(--green);}
    .ap-rt-divergence.bear{display:block;background:rgba(255,45,85,.08);border:1px solid rgba(255,45,85,.3);color:var(--red);}

    .ap-hof-list{display:flex;flex-direction:column;gap:6px;}
    .ap-hof-empty{color:var(--dim);font-size:.78rem;padding:8px 0;}
    .ap-hof-row{display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;}
    .ap-hof-rank{font-family:'Share Tech Mono',monospace;font-size:.7rem;color:var(--dim);width:22px;flex-shrink:0;text-align:center;}
    .ap-hof-rank.gold{color:#ffd60a;text-shadow:0 0 8px rgba(255,214,10,.5);}
    .ap-hof-rank.silver{color:#c4b5fd;}
    .ap-hof-rank.bronze{color:#ff6b35;}
    .ap-hof-emoji{font-size:1.1rem;}
    .ap-hof-name{flex:1;font-weight:700;font-size:.82rem;}
    .ap-hof-name .ap-hof-tag{font-size:.54rem;color:var(--dim);font-weight:400;margin-left:6px;letter-spacing:.08em;}
    .ap-hof-stats{font-family:'Share Tech Mono',monospace;font-size:.68rem;color:var(--dim);text-align:right;line-height:1.25;}
    .ap-hof-stats .ap-hof-pnl{font-size:.78rem;font-weight:700;}
    .ap-hof-stats .ap-hof-pnl.pos{color:var(--green);}
    .ap-hof-stats .ap-hof-pnl.neg{color:var(--red);}

    .ap-insights-body{font-size:.85rem;color:var(--text);line-height:1.7;}
    .ap-insights-body .ap-ins-line{padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.05);}
    .ap-insights-body .ap-ins-line:last-child{border-bottom:none;}
  `;

  // ═══════════════════════════════════════════════
  // 3. Panel injection
  // ═══════════════════════════════════════════════

  function injectCss(){
    if(document.getElementById('arenaPlusCss')) return;
    const style = document.createElement('style');
    style.id = 'arenaPlusCss';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function injectPanels(){
    // baBots (live trade section) の直後に注入
    const host = document.querySelector('.ba-wrap');
    if(!host) return false;

    if(!document.getElementById('apRealtime')){
      // リアルタイムパネル: baChartWrapの直後
      const chartWrap = document.getElementById('baChartWrap');
      if(chartWrap){
        chartWrap.insertAdjacentHTML('afterend', CVD_PANEL_HTML);
      } else {
        host.insertAdjacentHTML('beforeend', CVD_PANEL_HTML);
      }
    }
    if(!document.getElementById('apInsights')){
      // AI Insightsパネル: baPdcaの前
      const pdca = document.getElementById('baPdca');
      if(pdca){
        pdca.insertAdjacentHTML('beforebegin', INSIGHTS_PANEL_HTML);
      } else {
        host.insertAdjacentHTML('beforeend', INSIGHTS_PANEL_HTML);
      }
    }
    if(!document.getElementById('apHallOfFame')){
      // Hall of Fame: baDailySummaryの後
      const ds = document.getElementById('baDailySummary');
      if(ds){
        ds.insertAdjacentHTML('afterend', HOF_PANEL_HTML);
      } else {
        host.insertAdjacentHTML('beforeend', HOF_PANEL_HTML);
      }
    }
    return true;
  }

  // ═══════════════════════════════════════════════
  // 4. Panel renderers
  // ═══════════════════════════════════════════════

  function renderRealtimePanel(){
    if(!window.RealtimePlus) return;
    const CVD = window.RealtimePlus.CVD;
    const DOM_ = window.RealtimePlus.DOM;

    // CVD total
    const cvdEl = document.getElementById('apCvdTotal');
    const momEl = document.getElementById('apCvdMom');
    if(cvdEl){
      const total = CVD.total;
      const mom = CVD.momentum(30);
      const sign = total >= 0 ? '+' : '';
      cvdEl.textContent = `${sign}${total.toFixed(2)}`;
      cvdEl.className = 'ap-rt-val ' + (total > 0 ? 'bull' : total < 0 ? 'bear' : 'neut');
      if(momEl){
        momEl.textContent = `momentum: ${mom >= 0 ? '+' : ''}${mom.toFixed(1)}`;
        momEl.style.color = mom > 20 ? 'var(--green)' : mom < -20 ? 'var(--red)' : 'var(--dim)';
      }
    }

    // DOM imbalance
    const domEl = document.getElementById('apDomImb');
    const spreadEl = document.getElementById('apDomSpread');
    if(domEl){
      const imb = DOM_.imbalance;
      const pct = (imb * 100).toFixed(1);
      domEl.textContent = `${imb >= 0 ? '+' : ''}${pct}%`;
      domEl.className = 'ap-rt-val ' + (imb > 0.15 ? 'bull' : imb < -0.15 ? 'bear' : 'neut');
    }
    if(spreadEl){
      const spread = DOM_.bidAskSpread();
      spreadEl.textContent = `spread: $${spread.toFixed(2)}`;
    }

    // Walls
    const wallsEl = document.getElementById('apWalls');
    const wallDetailEl = document.getElementById('apWallDetail');
    if(wallsEl){
      const walls = DOM_.bigWalls || [];
      wallsEl.textContent = walls.length > 0 ? `${walls.length}件` : 'なし';
      wallsEl.className = 'ap-rt-val ' + (walls.length >= 3 ? 'neut' : walls.length > 0 ? 'bull' : '');
      if(wallDetailEl){
        if(walls.length === 0){
          wallDetailEl.textContent = '板厚み通常';
        } else {
          const top = walls[0];
          wallDetailEl.textContent = `最大${top.side==='bid'?'買':'売'}壁 $${Math.round(top.p).toLocaleString()} (${top.q.toFixed(1)})`;
        }
      }
    }

    // True delta
    const deltaEl = document.getElementById('apTrueDelta');
    if(deltaEl && window.calcTrueDelta && window.S){
      const k1m = window.S.k1m || [];
      const delta = window.calcTrueDelta(k1m, 10);
      const pct = (delta * 100).toFixed(1);
      deltaEl.textContent = `${delta >= 0 ? '+' : ''}${pct}%`;
      deltaEl.className = 'ap-rt-val ' + (delta > 0.1 ? 'bull' : delta < -0.1 ? 'bear' : 'neut');
    }

    // Divergence alert
    const divEl = document.getElementById('apDivergence');
    if(divEl){
      const div = CVD.detectDivergence(60);
      if(div){
        const cls = div.type === 'bullish' ? 'bull' : 'bear';
        const msg = div.type === 'bullish'
          ? `⚡ 強気CVDダイバージェンス検出 — 価格↓ CVD↑。反発の兆候 (強度:${div.strength.toFixed(2)})`
          : `⚠ 弱気CVDダイバージェンス検出 — 価格↑ CVD↓。反落の兆候 (強度:${div.strength.toFixed(2)})`;
        divEl.className = 'ap-rt-divergence ' + cls;
        divEl.textContent = msg;
      } else {
        divEl.className = 'ap-rt-divergence';
      }
    }
  }

  function renderHallOfFame(){
    const el = document.getElementById('apHofList');
    if(!el || !window.EvolutionPlus) return;
    const list = window.EvolutionPlus.HallOfFame.top(window.currentCoin, 10);
    if(list.length === 0){
      el.innerHTML = '<div class="ap-hof-empty">データ蓄積中... 最低5トレード後に記録されます。</div>';
      return;
    }
    el.innerHTML = list.map((e, i) => {
      const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const pnlCls = e.pnl >= 0 ? 'pos' : 'neg';
      const tag = e.autoPromoted ? '<span class="ap-hof-tag">自動昇格</span>' :
                  e.tf ? `<span class="ap-hof-tag">${e.tf} / ${e.style||''}</span>` : '';
      return `
        <div class="ap-hof-row">
          <div class="ap-hof-rank ${rankCls}">#${i+1}</div>
          <div class="ap-hof-emoji">${e.emoji||'🤖'}</div>
          <div class="ap-hof-name">${e.botName}${tag}</div>
          <div class="ap-hof-stats">
            <div class="ap-hof-pnl ${pnlCls}">${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(2)}%</div>
            <div>勝率${(e.winRate*100).toFixed(0)}% / ${e.totalTrades}回 / fit:${e.fitness.toFixed(1)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderInsights(){
    const el = document.getElementById('apInsightsBody');
    if(!el || !window.EvolutionPlus) return;
    const result = window.EvolutionPlus.generateAIInsights();
    if(!result){
      el.textContent = '分析生成中...';
      return;
    }
    el.innerHTML = result.insights.map(l => `<div class="ap-ins-line">${l}</div>`).join('');
  }

  // ═══════════════════════════════════════════════
  // 5. showToast helper (used by evolution-plus)
  // ═══════════════════════════════════════════════

  if(!window.showToast){
    window.showToast = function(msg, type){
      try{
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = `
          position:fixed;left:50%;bottom:30px;transform:translateX(-50%);
          background:${type==='success'?'rgba(0,255,136,.18)':'rgba(167,139,250,.2)'};
          color:${type==='success'?'#00ff88':'#c4b5fd'};
          border:1px solid ${type==='success'?'rgba(0,255,136,.5)':'rgba(167,139,250,.5)'};
          padding:10px 18px;border-radius:8px;font-family:'Share Tech Mono',monospace;font-size:.75rem;
          z-index:10000;box-shadow:0 4px 20px rgba(0,0,0,.4);
          animation:apToastIn .3s ease;
        `;
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .5s'; }, 4000);
        setTimeout(() => t.remove(), 4600);
      }catch(e){}
    };
    // animation CSS
    if(!document.getElementById('apToastKey')){
      const s = document.createElement('style');
      s.id = 'apToastKey';
      s.textContent = '@keyframes apToastIn{from{opacity:0;transform:translate(-50%,20px)}to{opacity:1;transform:translate(-50%,0)}}';
      document.head.appendChild(s);
    }
  }

  // ═══════════════════════════════════════════════
  // 6. Main loop
  // ═══════════════════════════════════════════════

  let _renderTimer = null;

  function renderAll(){
    try{ renderRealtimePanel(); }catch(e){}
    try{ renderHallOfFame(); }catch(e){}
    try{ renderInsights(); }catch(e){}
  }

  function startRenderLoop(){
    if(_renderTimer) return;
    renderAll();
    _renderTimer = setInterval(renderAll, 2000);
  }

  function init(){
    injectCss();

    // Wait for DOM and core script to be ready
    const wait = () => {
      const host = document.querySelector('.ba-wrap');
      if(!host || typeof window.currentCoin === 'undefined'){
        setTimeout(wait, 500);
        return;
      }
      injectPanels();
      installChartOverlay();
      startRenderLoop();
      console.log('[ArenaPlus] UI panels + chart overlay active');

      // retry chart overlay install for a few seconds (in case drawBaChart is loaded later)
      let retry = 0;
      const tryInstall = setInterval(() => {
        retry++;
        if(installChartOverlay() || retry > 20) clearInterval(tryInstall);
      }, 500);
    };
    wait();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
