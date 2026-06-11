/**
 * e2e.mjs — Playwright E2E harness for BTCsaki dashboard.
 *
 * Usage:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/e2e.mjs
 */

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

// Import our mock dispatcher
import { route as mockRoute } from './mock-api.mjs';

// ── Ensure screenshots dir ───────────────────────────────────────────────────
const SHOTS_DIR = '/tmp/shots';
mkdirSync(SHOTS_DIR, { recursive: true });

// ── Find a free port ────────────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── Start python HTTP server ─────────────────────────────────────────────────
function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'http.server', String(port)], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const onData = () => {
      if (!started) { started = true; resolve(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', reject);

    // Fallback: give it 1.5s then assume it's up
    setTimeout(() => { if (!started) { started = true; resolve(proc); } }, 1500);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
const unmockedURLs = [];
const consoleErrors = [];
const pageErrors = [];
const asserts = [];

function assert(name, value, detail = '') {
  const passed = Boolean(value);
  asserts.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function run() {
  const port = await getFreePort();
  console.log(`\n[e2e] Starting server on port ${port}…`);
  const server = await startServer(port);
  const BASE = `http://127.0.0.1:${port}`;

  // Ensure server is killed on exit
  const cleanup = () => { try { server.kill('SIGTERM'); } catch (_) {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let browser, context;
  try {
    console.log('[e2e] Launching Chromium…');
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    // ── Init script: stub WebSocket, clear storage, record evo event ────────
    await context.addInitScript(() => {
      // Clear any cached state
      try { localStorage.clear(); } catch (_) {}

      // Record evoboost-start event
      window.__evoStarted = false;
      window.addEventListener('evoboost-start', () => { window.__evoStarted = true; });

      // Stub WebSocket to avoid uncaught errors from blocked ws connections
      const OrigWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        // Only stub external (non-localhost) WebSocket connections
        if (typeof url === 'string' && !url.includes('127.0.0.1') && !url.includes('localhost')) {
          const fake = {
            url, readyState: 3 /* CLOSED */,
            close() {}, send() {},
            onopen: null, onclose: null, onmessage: null, onerror: null,
            addEventListener() {}, removeEventListener() {},
            dispatchEvent() { return true; },
            CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
          };
          // Fire onclose asynchronously so app fallback logic can run
          setTimeout(() => {
            if (typeof fake.onclose === 'function') {
              fake.onclose({ code: 1006, reason: 'stubbed', wasClean: false });
            }
          }, 50);
          return fake;
        }
        return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      };
      // Copy static properties
      Object.assign(window.WebSocket, {
        CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
        prototype: OrigWS.prototype,
      });

      // Stub TradingView in case the script loads slowly or fails
      window.TradingView = window.TradingView || { widget: function () {} };
    });

    // ── Route handler ────────────────────────────────────────────────────────
    await context.route('**/*', async (r) => {
      const url = r.request().url();

      // Same-origin: pass through
      if (url.startsWith(BASE) || url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return r.continue();
      }

      // Try our mock dispatcher
      const mocked = mockRoute(url);
      if (mocked) {
        return r.fulfill({
          status: mocked.status,
          contentType: mocked.contentType,
          body: mocked.body,
        });
      }

      // Catch-all for any unmocked external request
      if (!unmockedURLs.includes(url)) unmockedURLs.push(url);
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    });

    // ── Collect console messages ─────────────────────────────────────────────
    const page = await context.newPage();

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        consoleErrors.push(text);
      }
    });

    page.on('pageerror', err => {
      pageErrors.push(err.message);
    });

    // ── Phase 1: Load the page and wait for #mainDashboard ──────────────────
    console.log('[e2e] Navigating to', BASE + '/');
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // The app starts in "overview" mode (overviewVisible=true), so mainDashboard
    // has class "hidden". We must click a coin button to show it.
    // Wait a bit for JS to fully initialize before clicking.
    console.log('[e2e] Waiting for app JS init…');
    await page.waitForTimeout(3000);

    // Click BTC coin button to switch from overview → main dashboard
    console.log('[e2e] Clicking BTC coin button to reveal mainDashboard…');
    await page.click('button[data-coin="BTC"]').catch(e => {
      console.warn('[e2e] Could not click BTC button:', e.message);
    });

    // Now wait for #mainDashboard to be visible (no longer has class "hidden")
    console.log('[e2e] Waiting for #mainDashboard to be visible…');
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById('mainDashboard');
          return el && !el.classList.contains('hidden');
        },
        { timeout: 30000 }
      );
    } catch (e) {
      console.warn('[e2e] Timed out waiting for #mainDashboard to be visible:', e.message);
    }

    // Wait extra time for enhancement scripts (bots, evo-boost, cockpit-plus)
    console.log('[e2e] Waiting 8s for enhancement scripts to run…');
    await page.waitForTimeout(8000);

    // Screenshot 03: try to catch evo overlay early (may already be gone)
    const evoOverlayVisible = await page.evaluate(() => {
      const el = document.getElementById('cpEvoOverlay');
      if (!el) return false;
      return el.classList.contains('on') || getComputedStyle(el).opacity > '0.1';
    }).catch(() => false);
    if (evoOverlayVisible) {
      await page.screenshot({ path: path.join(SHOTS_DIR, '03-evolution.png'), fullPage: false });
      console.log('[e2e] Saved 03-evolution.png (overlay was visible)');
    } else {
      console.log('[e2e] cpEvoOverlay not visible at capture time — skipping 03-evolution.png');
    }

    // ── Phase 2: Navigate to Bot Arena ──────────────────────────────────────
    console.log('[e2e] Clicking Bot Arena tab…');
    await page.click('#botArenaTab').catch(e => {
      console.warn('[e2e] Could not click botArenaTab:', e.message);
    });
    await page.waitForTimeout(2000);

    // ── Phase 3: Assertions ──────────────────────────────────────────────────
    console.log('\n[e2e] Running assertions…');

    // First switch back to main dashboard for the #mainDashboard check
    await page.click('button[data-coin="BTC"]').catch(() => {});
    await page.waitForTimeout(500);

    // Assert: #mainDashboard visible
    const mainDashVisible = await page.evaluate(() => {
      const el = document.getElementById('mainDashboard');
      return el !== null && !el.classList.contains('hidden');
    }).catch(() => false);
    assert('#mainDashboard visible', mainDashVisible);

    // Assert: .ba-bot cards — switch to Bot Arena
    await page.click('#botArenaTab').catch(() => {});
    await page.waitForTimeout(1500);

    const botCount = await page.evaluate(() => {
      return document.querySelectorAll('.ba-bot').length;
    }).catch(() => 0);
    assert('.ba-bot cards > 0', botCount > 0, `found ${botCount}`);

    // Assert: #cpWarRoom exists in DOM (created by cockpit-plus.js)
    const warRoomExists = await page.evaluate(() => {
      return document.getElementById('cpWarRoom') !== null;
    }).catch(() => false);
    assert('#cpWarRoom exists', warRoomExists);

    // Assert: evoboost-start event fired at some point
    const evoStarted = await page.evaluate(() => window.__evoStarted === true).catch(() => false);
    assert('evoboost-start event fired', evoStarted, evoStarted ? '' : 'evolution-boost skipped (6h cooldown or runDailyPDCA not ready)');

    // Assert: zero page errors
    assert('zero pageerrors', pageErrors.length === 0, pageErrors.length > 0 ? pageErrors.slice(0, 3).join('; ') : '');

    // Assert: no significant console errors
    const filteredErrors = consoleErrors.filter(e => {
      if (e.includes('tradingview') || e.includes('TradingView')) return false;
      if (e.includes('favicon') || e.includes('404')) return false;
      if (e.includes('Failed to load resource')) return false;
      if (e.includes('net::ERR_')) return false;
      return true;
    });
    assert('no significant console errors', filteredErrors.length === 0,
      filteredErrors.length > 0 ? filteredErrors.slice(0, 3).join(' | ') : '');

    // ── Phase 4: Screenshots ─────────────────────────────────────────────────
    console.log('\n[e2e] Taking screenshots…');

    // Switch back to main dashboard for full-page screenshot
    await page.click('button[data-coin="BTC"]').catch(() => {});
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SHOTS_DIR, '01-full.png'), fullPage: true });
    console.log('[e2e] Saved 01-full.png');

    // Bot Arena screenshot
    await page.click('#botArenaTab').catch(() => {});
    await page.waitForTimeout(1000);

    const arenaSection = await page.$('#botArenaSection').catch(() => null);
    if (arenaSection) {
      await arenaSection.screenshot({ path: path.join(SHOTS_DIR, '02-arena.png') });
      console.log('[e2e] Saved 02-arena.png');
    } else {
      await page.screenshot({ path: path.join(SHOTS_DIR, '02-arena.png'), fullPage: true });
      console.log('[e2e] Saved 02-arena.png (fullpage fallback)');
    }

    // FX: trigger a big-win cut-in via the (wrapped) addBotTradeLog and capture mid-animation
    console.log('[e2e] Capturing cockpit-fx effects…');
    const fxOk = await page.evaluate(() => {
      if (typeof window.addBotTradeLog !== 'function') return false;
      window.addBotTradeLog({ id: 'john', name: 'JOHN', emoji: '🔵' }, 'tp', 'LONG', 60000, 'e2e', 1.62);
      return true;
    }).catch(() => false);
    if (fxOk) {
      await page.waitForTimeout(700); // mid cut-in slide
      await page.screenshot({ path: path.join(SHOTS_DIR, '05-fx-cutin.png'), fullPage: false });
      console.log('[e2e] Saved 05-fx-cutin.png');
    }
    assert('cut-in fires via addBotTradeLog', fxOk);
    const cutinVisible = await page.evaluate(() =>
      !!document.getElementById('fxCutin')).catch(() => false);
    assert('#fxCutin element created', cutinVisible);

    // FX: sonar + equity race (need a few ticks)
    await page.waitForTimeout(5500);
    const sonarExists = await page.evaluate(() => !!document.getElementById('fxSonar')).catch(() => false);
    const raceRows = await page.evaluate(() =>
      document.querySelectorAll('#fxRaceBody .fx-race-row').length).catch(() => 0);
    assert('#fxSonar radar exists', sonarExists);
    assert('equity race rows > 0', raceRows > 0, `rows=${raceRows}`);
    const warEl = await page.$('#cpWarRoom').catch(() => null);
    if (warEl) {
      const race = await page.$('#fxRace').catch(() => null);
      const clip = await warEl.boundingBox();
      const raceBox = race ? await race.boundingBox() : null;
      if (clip) {
        const h = raceBox ? (raceBox.y + raceBox.height - clip.y) : clip.height;
        await page.screenshot({
          path: path.join(SHOTS_DIR, '06-warroom-race.png'),
          clip: { x: clip.x, y: clip.y, width: clip.width, height: h },
        });
        console.log('[e2e] Saved 06-warroom-race.png');
      }
    }

    // Mobile screenshot
    console.log('[e2e] Taking mobile screenshot…');
    const mobilePage = await context.newPage();
    await mobilePage.setViewportSize({ width: 390, height: 844 });

    await mobilePage.addInitScript(() => {
      try { localStorage.clear(); } catch (_) {}
      window.__evoStarted = false;
      window.TradingView = window.TradingView || { widget: function () {} };
      const OrigWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (typeof url === 'string' && !url.includes('127.0.0.1') && !url.includes('localhost')) {
          const fake = {
            url, readyState: 3,
            close() {}, send() {},
            onopen: null, onclose: null, onmessage: null, onerror: null,
            addEventListener() {}, removeEventListener() {},
            dispatchEvent() { return true; },
          };
          setTimeout(() => { if (typeof fake.onclose === 'function') fake.onclose({ code: 1006 }); }, 50);
          return fake;
        }
        return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      };
    });

    await mobilePage.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mobilePage.waitForTimeout(4000);
    await mobilePage.click('button[data-coin="BTC"]').catch(() => {});
    await mobilePage.waitForTimeout(2000);
    await mobilePage.screenshot({ path: path.join(SHOTS_DIR, '04-mobile.png'), fullPage: true });
    console.log('[e2e] Saved 04-mobile.png');
    await mobilePage.close();

    // ── Phase 5: Summary ─────────────────────────────────────────────────────
    const passed = asserts.filter(a => a.passed).length;
    const failed = asserts.filter(a => !a.passed).length;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  RESULT: ${failed === 0 ? 'ALL PASS ✓' : `${failed} FAIL(S) ✗`}  (${passed}/${asserts.length} assertions)`);
    console.log('╚══════════════════════════════════════════════════════╝');

    if (unmockedURLs.length > 0) {
      console.log('\n[Unmocked URLs encountered]:');
      unmockedURLs.forEach(u => console.log('  •', u));
    } else {
      console.log('\n[Unmocked URLs]: none');
    }

    if (consoleErrors.length > 0) {
      console.log('\n[Console errors (all)]:');
      consoleErrors.slice(0, 20).forEach(e => console.log('  •', e.slice(0, 200)));
    }

    if (pageErrors.length > 0) {
      console.log('\n[Page errors]:');
      pageErrors.forEach(e => console.log('  •', e.slice(0, 200)));
    }

    console.log('\n[Screenshots]:');
    ['01-full.png', '02-arena.png', '03-evolution.png', '04-mobile.png'].forEach(f =>
      console.log(' ', path.join(SHOTS_DIR, f))
    );

    process.exitCode = failed > 0 ? 1 : 0;

  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    cleanup();
  }
}

run().catch(err => {
  console.error('[e2e] Fatal error:', err);
  process.exit(1);
});
