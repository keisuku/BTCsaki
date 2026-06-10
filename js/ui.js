// DOM rendering: top bar, live signal panel, leaderboard, progress.

import { COINS, TIMEFRAMES } from './config.js';
import { paramLabel } from './strategies.js';

const $ = id => document.getElementById(id);

export function fmtPrice(v, coin) {
  if (v == null) return '—';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: COINS[coin].precision,
    maximumFractionDigits: COINS[coin].precision,
  });
}

const fmtPct = (v, digits = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;

export function buildSelectors(state, onCoin, onTf) {
  const coinBox = $('coinTabs'), tfBox = $('tfTabs');
  coinBox.innerHTML = Object.keys(COINS)
    .map(c => `<button data-coin="${c}">${c}</button>`).join('');
  tfBox.innerHTML = TIMEFRAMES
    .map(t => `<button data-tf="${t}">${t}</button>`).join('');
  coinBox.addEventListener('click', e => {
    const c = e.target.dataset?.coin;
    if (c) onCoin(c);
  });
  tfBox.addEventListener('click', e => {
    const t = e.target.dataset?.tf;
    if (t) onTf(t);
  });
  updateSelectors(state);
}

export function updateSelectors(state) {
  for (const b of $('coinTabs').children) b.classList.toggle('active', b.dataset.coin === state.coin);
  for (const b of $('tfTabs').children) b.classList.toggle('active', b.dataset.tf === state.tf);
}

export function renderTicker(coin, ticker) {
  $('livePrice').textContent = ticker ? fmtPrice(ticker.price, coin) : '—';
  const ch = $('liveChange');
  ch.textContent = ticker ? fmtPct(ticker.changePct, 2) : '';
  ch.className = 'change ' + (ticker && ticker.changePct >= 0 ? 'up' : 'down');
}

export function renderFearGreed(fg) {
  $('fgBadge').textContent = fg ? `F&G ${fg.value} ${fg.label}` : '';
}

// verdict: { side:'LONG'|'SHORT'|'WAIT', entry, tp, sl, reason } or null while loading.
// champion: leaderboard row or null. stale: champion is from a previous session.
export function renderSignalPanel({ coin, verdict, champion, stale }) {
  const box = $('signalPanel');
  if (!champion) {
    box.className = 'signal-panel wait';
    $('signalVerdict').textContent = verdict === undefined ? '分析中…' : 'WAIT';
    $('signalDetail').innerHTML = '<span class="muted">優位性のある戦略が見つかるまで待機 — 無理なエントリーはしません</span>';
    $('signalMeta').textContent = '';
    return;
  }
  const side = verdict?.side || 'WAIT';
  box.className = 'signal-panel ' + side.toLowerCase();
  $('signalVerdict').textContent = side === 'WAIT' ? 'WAIT' : (side === 'LONG' ? '▲ LONG' : '▼ SHORT');

  if (side !== 'WAIT') {
    $('signalDetail').innerHTML = `
      <div class="kv"><span>エントリー</span><b>${fmtPrice(verdict.entry, coin)}</b></div>
      <div class="kv tp"><span>利確 TP</span><b>${fmtPrice(verdict.tp, coin)}</b></div>
      <div class="kv sl"><span>損切り SL</span><b>${fmtPrice(verdict.sl, coin)}</b></div>`;
  } else {
    $('signalDetail').innerHTML = '<span class="muted">シグナル待ち — チャンピオンbotはノーポジ</span>';
  }
  const t = champion.test;
  $('signalMeta').innerHTML =
    `👑 ${champion.emoji || ''} <b>${champion.name}</b> <span class="muted">${paramLabel(champion.params)} / SL×${champion.exitParams.slAtr} TP×${champion.exitParams.tpAtr}</span><br>` +
    `検証成績: 勝率 <b>${t.winRate.toFixed(0)}%</b> · PF <b>${t.profitFactor === Infinity ? '∞' : t.profitFactor.toFixed(2)}</b> · ` +
    `PnL <b class="${t.netPnlPct >= 0 ? 'up' : 'down'}">${fmtPct(t.netPnlPct)}</b> · ${t.tradeCount}回` +
    (stale ? ' <span class="stale">前回結果(再分析中)</span>' : '');
}

// rows: leaderboard entries. selectedIdx highlighted; onSelect(i) on click.
export function renderLeaderboard(rows, selectedIdx, onSelect) {
  const tbody = $('lbBody');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">分析待ち…</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const t = r.test;
    return `<tr class="${i === selectedIdx ? 'selected' : ''} ${r.isChampion ? 'champion' : ''}" data-i="${i}">
      <td>${r.isChampion ? '👑' : ''} ${r.emoji || ''} ${r.name}</td>
      <td class="muted small">${paramLabel(r.params)} | SL×${r.exitParams.slAtr} TP×${r.exitParams.tpAtr}</td>
      <td>${t.tradeCount}</td>
      <td>${t.winRate.toFixed(0)}%</td>
      <td class="${t.netPnlPct >= 0 ? 'up' : 'down'}">${fmtPct(t.netPnlPct)}</td>
      <td>${t.profitFactor === Infinity ? '∞' : t.profitFactor.toFixed(2)}</td>
      <td>${t.sharpe.toFixed(2)}</td>
      <td>${t.maxDrawdownPct.toFixed(1)}%</td>
    </tr>`;
  }).join('');
  tbody.onclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) onSelect(+tr.dataset.i);
  };
}

export function renderProgress(done, total, label) {
  const bar = $('progressBar'), txt = $('progressText');
  if (done >= total) {
    bar.style.width = '100%';
    txt.textContent = label || '最適化完了';
    setTimeout(() => { $('progressWrap').classList.add('done'); }, 800);
    return;
  }
  $('progressWrap').classList.remove('done');
  bar.style.width = `${(done / total * 100).toFixed(0)}%`;
  txt.textContent = `バックテスト中: ${label} (${done}/${total})`;
}

export function renderOptimizedAt(ts) {
  $('optimizedAt').textContent = ts
    ? `最終分析: ${new Date(ts).toLocaleString('ja-JP')}` : '';
}
