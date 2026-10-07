const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function installRoutes(page, profileStatus) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
  return page.setRequestInterception(true).then(() => {
    page.on('request', (req) => {
      const url = req.url();
      if ((url.includes('/api/profile') || url.includes('/api/bookings')) && req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: cors, body: '' }).catch(() => {});
        return;
      }
      if (url.includes('/api/profile')) {
        const body = profileStatus === 401
          ? JSON.stringify({ ok: false, error: 'session_required' })
          : JSON.stringify({ ok: true, tenants: [{ id: 'aura-exec', ownerName: 'Test Owner', ownerEmail: 'owner@example.com' }] });
        req.respond({
          status: profileStatus === 401 ? 401 : 200,
          contentType: 'application/json',
          headers: cors,
          body
        }).catch(() => {});
        return;
      }
      if (url.includes('/api/bookings')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify({ ok: true, tenants: [{ id: 'aura-exec', appointments: [] }] })
        }).catch(() => {});
        return;
      }
      if (req.isNavigationRequest()) {
        req.continue().catch(() => {});
        return;
      }
      req.abort().catch(() => {});
    });
  });
}

async function portalState(page) {
  return page.evaluate(() => {
    const login = document.getElementById('tenantLoginBox');
    const dash = document.getElementById('tenantDashboard');
    const services = document.getElementById('tenantSectionServices');
    const btn = document.getElementById('tenantAddHomeScreenBtn');
    let session = '';
    let meta = '';
    let legacy = '';
    try { session = localStorage.getItem('schedi.authSession') || ''; } catch (e) {}
    try { meta = localStorage.getItem('schedi.authMeta') || ''; } catch (e) {}
    try { legacy = sessionStorage.getItem('schedi.authSession') || ''; } catch (e) {}
    return {
      loginHidden: !!(login && login.classList.contains('hidden')),
      dashHidden: !!(dash && dash.classList.contains('hidden')),
      servicesHidden: services ? services.classList.contains('hidden') : null,
      homeHidden: !!(btn && btn.classList.contains('hidden')),
      url: (location.pathname || '/') + (location.search || ''),
      session,
      meta,
      legacy,
      mobile: typeof schediIsMobileHomeScreenTarget === 'function' ? schediIsMobileHomeScreenTarget() : null
    };
  });
}

async function waitFor(page, pred, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 6000) {
    last = await portalState(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(label + ' last=' + JSON.stringify(last));
}

const signedIn = (s) => s.loginHidden && !s.dashHidden && s.session === 'test-session' && s.meta.includes('aura-exec');
const signedOut = (s) => !s.loginHidden && s.dashHidden && !s.session && !s.legacy;

async function openPage(browser, origin, { profileStatus, userAgent, seed }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (userAgent) await page.setUserAgent(userAgent.ua, userAgent.metadata);
  const errors = [];
  page.on('pageerror', (err) => {
    const message = String(err && err.message);
    if (!/firebase|Failed to fetch|import|tailwind is not defined/i.test(message)) errors.push(message);
  });
  await installRoutes(page, profileStatus);
  await page.evaluateOnNewDocument((seedJson) => {
    if (window.top !== window.self) return;
    if (localStorage.getItem('schedi.testSeeded') === '1') return;
    const seed = JSON.parse(seedJson);
    localStorage.removeItem('schedi.authSession');
    localStorage.removeItem('schedi.authMeta');
    sessionStorage.removeItem('schedi.authSession');
    if (seed.mode === 'local') {
      localStorage.setItem('schedi.authSession', 'test-session');
      localStorage.setItem('schedi.authMeta', JSON.stringify({ role: 'owner', tenantId: 'aura-exec', email: 'owner@example.com' }));
    } else if (seed.mode === 'legacy') {
      sessionStorage.setItem('schedi.authSession', 'test-session');
    }
    localStorage.setItem('schedi.testSeeded', '1');
  }, JSON.stringify(seed));
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  page.__errors = errors;
  return page;
}

(async () => {
  if (!CHROME) throw new Error('Chrome not found');
  const server = await startServer();
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const desktop = await openPage(browser, origin, { profileStatus: 200, seed: { mode: 'local' } });
    const restored = await waitFor(desktop, signedIn, 'stored owner session should open the portal without signing in again');
    if (!restored.homeHidden) throw new Error('Add to home screen should be hidden on desktop');
    if (desktop.__errors.length) throw new Error('page errors: ' + desktop.__errors.join(' | '));

    await desktop.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await waitFor(desktop, signedIn, 'full reload should keep the owner signed in');
    if (!reloaded.homeHidden) throw new Error('Add to home screen became visible after reload');
    if (reloaded.legacy) throw new Error('session leaked back into sessionStorage');

    const afterClick = await desktop.evaluate(() => {
      const before = location.pathname + location.search;
      document.getElementById('tenantAddHomeScreenBtn').classList.remove('hidden');
      window.addTenantPortalToHomeScreen();
      window.switchTenantTab('services');
      const servicesHidden = document.getElementById('tenantSectionServices').classList.contains('hidden');
      const rosterHiddenWhileServices = document.getElementById('tenantSectionRoster').classList.contains('hidden');
      window.switchTenantTab('roster');
      window.setRosterCalendarView('week');
      const weekPressed = document.getElementById('rosterViewWeek').getAttribute('aria-pressed');
      window.setRosterCalendarView('month');
      const monthPressed = document.getElementById('rosterViewMonth').getAttribute('aria-pressed');
      window.setRosterCalendarView('list');
      const listPressed = document.getElementById('rosterViewList').getAttribute('aria-pressed');
      const fn = String(window.addTenantPortalToHomeScreen);
      return {
        before,
        after: location.pathname + location.search,
        rewroteHistory: /history\.replaceState|history\.pushState/.test(fn),
        servicesHidden,
        rosterHiddenWhileServices,
        weekPressed,
        monthPressed,
        listPressed
      };
    });
    if (afterClick.before !== afterClick.after) throw new Error('desktop add-to-home changed the URL: ' + afterClick.after);
    if (afterClick.rewroteHistory) throw new Error('add-to-home still rewrites history');
    if (afterClick.servicesHidden || !afterClick.rosterHiddenWhileServices) throw new Error('Manage Services did not switch after add-to-home: ' + JSON.stringify(afterClick));
    if (afterClick.weekPressed !== 'true' || afterClick.monthPressed !== 'true' || afterClick.listPressed !== 'true') {
      throw new Error('List/Week/Month stopped switching after add-to-home: ' + JSON.stringify(afterClick));
    }

    await desktop.evaluate(() => { window.handleTenantLogout(); });
    const loggedOut = await portalState(desktop);
    if (loggedOut.session || loggedOut.legacy || loggedOut.loginHidden || !loggedOut.dashHidden) {
      throw new Error('sign out should clear the session and show the login form: ' + JSON.stringify(loggedOut));
    }
    await desktop.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(desktop, signedOut, 'after sign out, reload should stay on the login form');
    await desktop.close();

    const legacy = await openPage(browser, origin, { profileStatus: 200, seed: { mode: 'legacy' } });
    const migrated = await waitFor(legacy, (s) => signedIn(s) && !s.legacy, 'a pre-existing sessionStorage token should move to localStorage and reopen the portal');
    if (!migrated.meta.includes('"role":"owner"')) throw new Error('legacy session did not record owner role: ' + migrated.meta);
    await legacy.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(legacy, signedIn, 'migrated session should survive another reload');
    await legacy.close();

    const expired = await openPage(browser, origin, { profileStatus: 401, seed: { mode: 'local' } });
    await waitFor(expired, signedOut, 'an expired session should return the owner to the login form');
    await expired.close();

    const anon = await openPage(browser, origin, { profileStatus: 200, seed: { mode: 'none' } });
    await waitFor(anon, signedOut, 'a visitor with no session should see the login form');
    const anonClick = await anon.evaluate(() => {
      const before = location.pathname + location.search;
      window.addTenantPortalToHomeScreen();
      window.switchTenantTab('services');
      return {
        before,
        after: location.pathname + location.search,
        servicesHidden: document.getElementById('tenantSectionServices').classList.contains('hidden'),
        homeHidden: document.getElementById('tenantAddHomeScreenBtn').classList.contains('hidden')
      };
    });
    if (anonClick.before !== anonClick.after) throw new Error('logged-out desktop add-to-home changed URL');
    if (!anonClick.homeHidden) throw new Error('logged-out desktop still shows Add to home screen');
    if (anonClick.servicesHidden) throw new Error('tab switch failed while logged out');
    await anon.close();

    const mobile = await openPage(browser, origin, {
      profileStatus: 200,
      seed: { mode: 'local' },
      userAgent: {
        ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        metadata: { mobile: true, platform: 'Android', architecture: '', model: 'Pixel 8', platformVersion: '14' }
      }
    });
    await waitFor(mobile, (s) => signedIn(s) && s.mobile === true && s.homeHidden === false, 'phones should still see Add to home screen');
    await mobile.close();

    console.log('portal launch checks passed');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
