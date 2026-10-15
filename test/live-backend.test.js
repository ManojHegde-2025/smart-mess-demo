'use strict';
/*
 * LIVE browser test: the manager dashboard against the REAL backend (no mock).
 * Runs only when LIVE_BACKEND=1 and the backend is reachable at BACKEND_URL (default http://localhost:8000).
 *
 *   LIVE_BACKEND=1 PW_CHROMIUM=/path/to/chromium node --test test/live-backend.test.js
 *
 * It starts server.js (which forwards /api/v1 to the backend), signs in as a real manager, and checks
 * the figures on screen against the backend's own summary response.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:8000';
const APP_PORT = process.env.LIVE_APP_PORT || '3100';
const MANAGER = process.env.LIVE_MANAGER || 'MGR001';
const STUDENT = process.env.LIVE_STUDENT || 'STU001';
const PASSWORD = process.env.LIVE_PASSWORD || 'password123';

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* skipped below */ }

async function reachable(url) { try { await fetch(url, { signal: AbortSignal.timeout(3000) }); return true; } catch (e) { return false; } }

let skipReason = null;
if (process.env.LIVE_BACKEND !== '1') skipReason = 'set LIVE_BACKEND=1 to run against the real backend';
else if (!chromium) skipReason = 'playwright is not installed';

let browser, proc, backendUp = false;

test.before(async () => {
  if (skipReason) return;
  backendUp = await reachable(BACKEND + '/health');
  if (!backendUp) return;
  const exe = process.env.PW_CHROMIUM;
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: APP_PORT, BACKEND_URL: BACKEND }),
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { if (await reachable(`http://localhost:${APP_PORT}/`)) break; await new Promise(r => setTimeout(r, 100)); }
});

test.after(async () => {
  if (browser) await browser.close();
  if (proc) proc.kill();
});

const skipIf = () => skipReason || false; // decided at declaration; backend reachability is checked inside each test

test('a student account is refused by the manager dashboard sign-in', { skip: skipIf() }, async (t) => {
  if (!backendUp) return t.skip('backend not running at ' + BACKEND);
  const page = await browser.newPage();
  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.click('#r-chief');
  await page.fill('#uid', STUDENT);
  await page.fill('#pw', PASSWORD);
  await page.click('text=Sign In');
  await page.waitForFunction(() => document.getElementById('lerr').textContent.length > 0, null, { timeout: 8000 });
  assert.match(await page.textContent('#lerr'), /not a mess manager/);
  assert.equal(await page.evaluate(() => localStorage.getItem('sm_manager_token')), null);
  await page.close();
});

test('manager signs in and the dashboard shows the backend figures, flagged synthetic', { skip: skipIf() }, async (t) => {
  if (!backendUp) return t.skip('backend not running at ' + BACKEND);
  const page = await browser.newPage();
  const apiCalls = [];
  page.on('response', r => { if (r.url().includes('/api/v1/')) apiCalls.push({ url: r.url(), status: r.status(), auth: r.request().headers()['authorization'] || null }); });

  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.click('#r-chief');
  await page.fill('#uid', MANAGER);
  await page.fill('#pw', PASSWORD);
  await page.click('text=Sign In');
  await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

  // The backend's own answer for "today" in India, to compare with the screen.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const loginRes = await fetch(BACKEND + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roll_no: MANAGER, password: PASSWORD }) });
  const token = (await loginRes.json()).access_token;
  const summary = await (await fetch(`${BACKEND}/api/v1/dashboard/summary?mess=south&date=${today}`, { headers: { Authorization: 'Bearer ' + token } })).json();

  await page.waitForFunction(() => /SYNTHETIC DATA/.test(document.body.innerText), null, { timeout: 10000 });
  const summaryCalls = apiCalls.filter(c => c.url.includes('/api/v1/dashboard/summary'));
  assert.ok(summaryCalls.length >= 1, 'dashboard called the backend summary');
  assert.ok(summaryCalls.every(c => c.status === 200 && c.auth && c.auth.startsWith('Bearer ')), 'every summary call is authorised with a Bearer token');

  const text = await page.innerText('body');
  assert.ok(text.includes('LIVE') || text.includes('NOT LIVE'), 'freshness banner is shown');
  for (const m of summary.meals) {
    assert.ok(text.includes(m.mealType), `meal ${m.mealType} is shown`);
    if (m.served > 0) assert.ok(text.includes(String(m.served)), `served ${m.served} for ${m.mealType} is on screen`);
  }
  await page.close();
});
