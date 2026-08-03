/* eslint-disable */
// Playwright demo recorder — fake cursor + captions + deterministic waits.
// Copy into a gitignored scratch dir, edit the CONFIG and CHOREOGRAPHY blocks.
//
//   DEMO_DEBUG=1 node demo.js     # timing log + screenshots while iterating
//   node demo.js                  # quiet run -> page@*.webm in this dir
//
// Then render:  ffmpeg -y -i page@*.webm -vf "scale=1440:-2,fps=30" \
//                 -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4

// --- resolve playwright wherever it lives (node_modules, npx cache, or PW_PATH) ---
function loadChromium() {
  const tries = [];
  if (process.env.PW_PATH) tries.push(process.env.PW_PATH);
  tries.push('playwright', 'playwright-core');
  for (const t of tries) { try { return require(t).chromium; } catch (e) {} }
  const fs = require('fs'), path = require('path'), os = require('os');
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', 'playwright');
      if (fs.existsSync(p)) return require(p).chromium;
    }
  } catch (e) {}
  throw new Error('playwright not found — set PW_PATH or `npx playwright install chromium`');
}
const chromium = loadChromium();

// ===== CONFIG (edit me — base URL, login flow, and routes come from the project's
// app-runbook (.ai/app-runbook.md); credentials ONLY from env) =====
const BASE = process.env.APP_URL || 'http://localhost:3000';
const START_URL = process.env.START_URL || `${BASE}/`;     // the FEATURE page (not login)
const READY_SELECTOR = process.env.READY_SELECTOR || 'body'; // wait for this before acting
const OUT_DIR = __dirname;
const DEBUG = process.env.DEMO_DEBUG === '1';
const VIEWPORT = { width: 1440, height: 900 };
const RESULT_PAUSE = 3000; // hold on a result so the viewer can read it
const BEAT = 650;          // small beat between minor actions
const SHOW_URL_BAR = process.env.DEMO_URL_BAR === '1'; // top address bar: routing / deeplink / query demos
// Login (optional): done in a NON-recorded context so the video starts on the page.
const LOGIN = {
  enabled: process.env.LOGIN !== '0',
  url: `${BASE}/login`,                    // ← runbook
  user: process.env.APP_USER || '',
  pass: process.env.APP_PASS || '',
  userSel: 'input[name="login"]',          // ← runbook
  passSel: 'input[name="password"]',       // ← runbook
  submitSel: 'button[type="submit"]',      // ← runbook
};
// ============================

// --- injected deep-blue pointer cursor + click ripple + caption banner + optional address bar ---
const initScript = (SHOW_URL_BAR) => {
  const CUR = '__demo_cursor__', CAP = '__demo_caption__', BAR = '__demo_urlbar__', BLUE = '#0b2a6b';
  function ensure() {
    if (!document.body) return;
    if (!document.getElementById(CUR)) {
      const c = document.createElement('div');
      c.id = CUR;
      Object.assign(c.style, {
        position: 'fixed', top: '0', left: '0', width: '26px', height: '26px',
        zIndex: '2147483647', pointerEvents: 'none',
        filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))', transform: 'translate(-2px,-2px)',
      });
      c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 2 L3 20.5 L8 15.6 L11.4 22.6 L14.6 21.1 L11.1 14.2 L18 14.2 Z" ' +
        'fill="' + BLUE + '" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      document.body.appendChild(c);
    }
    // synthetic address bar: Playwright records only the viewport, not browser chrome
    if (SHOW_URL_BAR && !document.getElementById(BAR)) {
      const bar = document.createElement('div');
      bar.id = BAR;
      Object.assign(bar.style, {
        position: 'fixed', top: '0', left: '0', right: '0', height: '48px',
        background: '#2b2d31', zIndex: '2147483647', display: 'flex', alignItems: 'center',
        padding: '0 14px', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      });
      const pill = document.createElement('div');
      pill.id = BAR + '_u';
      Object.assign(pill.style, {
        flex: '1', height: '32px', background: '#1b1c1f', borderRadius: '16px',
        color: '#e9eaed', padding: '0 18px',
        font: '500 16px/32px ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      });
      bar.appendChild(pill);
      document.body.appendChild(bar);
    }
    if (!document.getElementById(CAP)) {
      const b = document.createElement('div');
      b.id = CAP;
      Object.assign(b.style, {
        // caption goes to the bottom when the address bar occupies the top
        position: 'fixed', ...(SHOW_URL_BAR ? { bottom: '36px' } : { top: '14px' }),
        left: '50%', transform: 'translateX(-50%)',
        maxWidth: '90%', padding: '18px 32px', borderRadius: '10px',
        background: 'rgba(11,26,64,0.92)', color: '#fff',
        font: '600 30px/1.3 -apple-system, system-ui, sans-serif',
        zIndex: '2147483647', pointerEvents: 'none', opacity: '0',
        transition: 'opacity .25s ease', boxShadow: '0 4px 14px rgba(0,0,0,.35)', letterSpacing: '.2px',
      });
      document.body.appendChild(b);
    }
    // keep the address bar in sync with the current location (re-runs on every navigation/mousemove)
    const u = document.getElementById(BAR + '_u');
    if (u) u.textContent = location.host + location.pathname + location.search;
  }
  const move = (x, y) => { ensure(); const c = document.getElementById(CUR); if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; } };
  const ripple = (x, y) => {
    if (!document.body) return;
    const r = document.createElement('div');
    Object.assign(r.style, {
      position: 'fixed', left: x + 'px', top: y + 'px', width: '12px', height: '12px',
      marginLeft: '-6px', marginTop: '-6px', borderRadius: '50%',
      border: '2px solid rgba(11,42,107,0.85)', background: 'rgba(28,72,168,0.30)',
      zIndex: '2147483646', pointerEvents: 'none', transform: 'scale(0.3)', opacity: '0.85',
      transition: 'transform .45s ease-out, opacity .45s ease-out',
    });
    document.body.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(3.2)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 520);
  };
  document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', (e) => ripple(e.clientX, e.clientY), true);
  window.addEventListener('DOMContentLoaded', ensure);
  window.__demoCaption = (t) => { ensure(); const b = document.getElementById(CAP); if (b) { b.textContent = t; b.style.opacity = t ? '1' : '0'; } };
  ensure();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });

  let storageState;
  if (LOGIN.enabled) {
    const lc = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const lp = await lc.newPage();
    await lp.goto(LOGIN.url, { waitUntil: 'domcontentloaded' });
    await lp.fill(LOGIN.userSel, LOGIN.user);
    await lp.fill(LOGIN.passSel, LOGIN.pass);
    await lp.click(LOGIN.submitSel);
    await lp.waitForLoadState('networkidle').catch(() => {});
    storageState = await lc.storageState();
    await lc.close();
  }

  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
    ignoreHTTPSErrors: true,
    storageState,
  });
  // pass SHOW_URL_BAR by value — addInitScript serializes the fn into the browser, no closure
  await context.addInitScript({ content: `(${initScript})(${SHOW_URL_BAR})` });
  const page = await context.newPage();
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);

  let shot = 0;
  const T0 = Date.now();
  const mark = (m) => { if (DEBUG) console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); };
  const caption = (t) => page.evaluate((x) => window.__demoCaption && window.__demoCaption(x), t).catch(() => {});
  const debugShot = async (name) => { if (DEBUG) await page.screenshot({ path: `${OUT_DIR}/dbg-${String(++shot).padStart(2, '0')}-${name}.png` }).catch(() => {}); };

  // --- helpers: ALWAYS use short explicit timeouts (default is 30s and will hang) ---
  async function glideTo(x, y, steps = 28) { await page.mouse.move(x, y, { steps }); await sleep(160); }
  async function glideToLocator(loc, { click = true } = {}) {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    const box = await loc.boundingBox({ timeout: 2500 }).catch(() => null);
    if (!box) throw new Error('no bounding box');
    await glideTo(box.x + box.width / 2, box.y + box.height / 2);
    if (click) { await page.mouse.down(); await sleep(80); await page.mouse.up(); await sleep(180); }
    return box;
  }
  async function clickText(text, opts = {}) { await glideToLocator(page.getByText(text, { exact: opts.exact || false }).first()); }
  async function typeInto(loc, text, delay = 90) { await glideToLocator(loc); await page.keyboard.type(text, { delay }); }
  // Wait (capped) for a page-evaluated condition to become true — deterministic, fast.
  async function waitUntil(fn, arg, cap = 4000) {
    await page.waitForFunction(fn, arg, { timeout: cap }).catch(() => {});
    await sleep(200);
  }

  // Show the backend payload ON SCREEN. A bug about data coming from the API is not
  // proven by the rendered result alone — the response that produced it must be visible.
  async function payloadPanel(title, data, { lines = 18, side = 'left' } = {}) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    await page.evaluate(({ title, text, lines, side }) => {
      document.getElementById('__demo_payload__')?.remove();
      const box = document.createElement('div');
      box.id = '__demo_payload__';
      Object.assign(box.style, {
        position: 'fixed', top: '90px', [side]: '32px', maxWidth: '46%', maxHeight: '70%',
        overflow: 'hidden', padding: '18px 22px', borderRadius: '12px',
        background: 'rgba(17,20,28,0.95)', color: '#e9eaed', zIndex: '2147483000',
        boxShadow: '0 10px 34px rgba(0,0,0,.45)', opacity: '0', transition: 'opacity .3s ease',
      });
      const h = document.createElement('div');
      h.textContent = title;
      Object.assign(h.style, {
        font: '700 17px/1.3 -apple-system, system-ui, sans-serif',
        color: '#8fd3ff', marginBottom: '10px', letterSpacing: '.3px',
      });
      const pre = document.createElement('pre');
      const shown = text.split('\n').slice(0, lines);
      if (text.split('\n').length > lines) shown.push('…');
      pre.textContent = shown.join('\n');
      Object.assign(pre.style, {
        margin: '0', font: '500 15px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre', color: '#e9eaed',
      });
      box.appendChild(h); box.appendChild(pre);
      document.body.appendChild(box);
      requestAnimationFrame(() => { box.style.opacity = '1'; });
    }, { title, text, lines, side });
  }
  async function hidePayloadPanel() {
    await page.evaluate(() => document.getElementById('__demo_payload__')?.remove());
  }

  // Magnify small UI differences (an icon, a 2px border) that a 1440px frame swallows.
  // Clones are re-parented to <body>, so design tokens defined on an inner container
  // would stop resolving — the computed values are copied onto the panel.
  async function magnify(items, { tokens = [], scale = 4, side = 'right' } = {}) {
    await page.evaluate(({ items, tokens, scale, side }) => {
      document.getElementById('__demo_zoom__')?.remove();
      const first = document.querySelector(items[0].selector);
      if (!first) return;

      const panel = document.createElement('div');
      panel.id = '__demo_zoom__';
      Object.assign(panel.style, {
        position: 'fixed', [side]: '48px', top: '50%', transform: 'translateY(-50%)',
        display: 'flex', gap: '56px', alignItems: 'flex-start',
        padding: '36px 44px', borderRadius: '16px', background: '#fff',
        boxShadow: '0 12px 40px rgba(0,0,0,.35)', zIndex: '2147483000',
        font: '600 15px/1.4 -apple-system, system-ui, sans-serif', color: '#0b2a6b',
        opacity: '0', transition: 'opacity .4s ease',
      });
      const scope = getComputedStyle(first);
      for (const name of tokens) panel.style.setProperty(name, scope.getPropertyValue(name));

      for (const { selector, label, strip = [] } of items) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        const wrap = document.createElement('div');
        wrap.style.textAlign = 'center';
        const stage = document.createElement('div');
        Object.assign(stage.style, {
          width: rect.width * scale + 'px', height: rect.height * scale + 'px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '18px',
        });
        const holder = document.createElement('div');
        Object.assign(holder.style, {
          width: rect.width + 'px', height: rect.height + 'px', transform: `scale(${scale})`,
        });
        const clone = node.cloneNode(true);
        clone.style.pointerEvents = 'none';
        for (const sel of strip) clone.querySelectorAll(sel).forEach((n) => n.remove());
        holder.appendChild(clone);
        stage.appendChild(holder);
        const cap = document.createElement('div');
        cap.textContent = label;
        wrap.appendChild(stage); wrap.appendChild(cap);
        panel.appendChild(wrap);
      }
      document.body.appendChild(panel);
      requestAnimationFrame(() => { panel.style.opacity = '1'; });
    }, { items, tokens, scale, side });
  }
  async function hideMagnifier() {
    await page.evaluate(() => document.getElementById('__demo_zoom__')?.remove());
  }

  try {
    mark('goto start');
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(READY_SELECTOR).first().waitFor({ timeout: 30000 });
    mark('ready');

    // ===== CHOREOGRAPHY (edit me) =====
    // Tell the story in 3-6 beats. caption() narrates; glide* drives the cursor.
    // Pause RESULT_PAUSE right after a result renders; keep transitions to BEAT.
    await caption('Here is the feature');
    await debugShot('start');
    await sleep(1800);

    // Example — type into a search box and show results:
    //   const search = page.getByTestId('my-search-input');
    //   await caption('Search by name');
    //   await typeInto(search, 'issue');
    //   await page.keyboard.press('Enter');
    //   await waitUntil(() => document.querySelectorAll('[data-testid="row"]').length < 20, null);
    //   await caption('Filtered results'); await sleep(RESULT_PAUSE);

    // Example — click a button:
    //   await caption('Open the panel');
    //   await glideToLocator(page.getByRole('button', { name: 'Open' }));
    //   await sleep(BEAT);

    await caption('Done ✓');
    await sleep(2200);
    await caption('');
    // ==================================

    console.log('DEMO_OK');
  } catch (err) {
    console.error('DEMO_ERROR', err && err.message);
    await page.screenshot({ path: `${OUT_DIR}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    const video = page.video();
    await context.close(); // finalizes the video
    if (video) { const p = await video.path().catch(() => null); if (p) console.log('VIDEO_PATH', p); }
    await browser.close();
  }
}

main();
