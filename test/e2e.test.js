'use strict';
/*
 * Browser end-to-end tests (Playwright + Chromium) against the SYNTHETIC mock API.
 * They prove the UI behaves correctly for every data/error state. They do NOT prove that
 * the real backend or ML service work - those integration tests are blocked (docs/API_CONTRACT.md).
 *
 * Needs the `playwright` package and a Chromium build (set PW_CHROMIUM to its path if needed).
 * Skipped with a clear message if Playwright is not installed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createMock } = require('../mock/mock-api.js');
const { createFakeMl } = require('./fake-ml.js');
const { createProxy } = require('../adapters/ml-proxy.js');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* skip below */ }
const skip = chromium ? false : 'playwright is not installed (npm i -D playwright)';

const APP = 'http://localhost:3000/?demo=1', API = 'http://localhost:4000';
const CORS = { 'Access-Control-Allow-Origin': 'http://localhost:3000', 'Access-Control-Allow-Credentials': 'true' };
let browser, staticProc, mock;

async function waitFor(url, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { await fetch(url); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start: ' + url);
}

test.before(async () => {
  if (skip) return;
  mock = createMock({ allowedOrigin: 'http://localhost:3000' });
  await new Promise(r => mock.server.listen(4000, r));
  staticProc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT: '3000' }), stdio: 'ignore' });
  await waitFor('http://localhost:3000/');
  const exe = process.env.PW_CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => fs.existsSync(p));
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
});
test.after(async () => {
  if (browser) await browser.close();
  if (staticProc) staticProc.kill();
  if (mock) await new Promise(r => mock.server.close(r));
});
test.beforeEach(() => { if (mock) mock.setScenario('normal'); });

async function open(opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.reqs = [];
  page.on('request', r => { if (r.url().startsWith(API)) page.reqs.push(r.url()); });
  await page.goto(opts.url || APP);
  return page;
}
async function loginChief(page, mess) {
  await page.click('#r-chief'); await page.fill('#uid', 'mgr1'); await page.fill('#pw', 'demo1234');
  await page.click('button:has-text("Sign In")');
  if (mess) await page.selectOption('#msel', mess);
  await page.waitForSelector('#sm-dash');
}
const nav = (page, label) => page.click(`#nav button:has-text("${label}")`);
const count = (page, frag) => page.reqs.filter(u => u.includes(frag)).length;
const live = page => page.waitForSelector('b:text-is("LIVE")');

test('dashboard loads with live counts, labels and a SYNTHETIC DATA banner', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  assert.ok(await page.locator('text=SYNTHETIC DATA').first().isVisible());
  assert.equal(await page.locator('.meal:has-text("Expected")').count(), 3);
  for (const l of ['Expected meals', 'Meals served', 'Meals remaining', 'Estimated surplus', 'Tomorrow predicted', 'Exceptions today']) assert.ok(await page.locator('.kpi', { hasText: l }).first().isVisible(), l);
  assert.ok(await page.locator('.kpi:has-text("Estimated surplus") >> text=Not measured food waste').isVisible());
  assert.ok(await page.locator('[role=progressbar]').count() >= 3);
  assert.deepEqual(page.errors, []);
});

test('sidebar navigation reaches every manager page; other Mess Chief pages still work', { skip }, async () => {
  const page = await open(); await loginChief(page);
  for (const [label, h1] of [['Meal Demand Prediction', 'Meal Demand Prediction'], ['Reports', 'Reports'], ['Menu Management', 'Menu Management'], ['Inventory Management', 'Inventory'], ['Meal Attendance', 'Meal Attendance'], ['Student Records', 'Student Records'], ['Dashboard', 'Mess Dashboard']]) {
    await nav(page, label);
    assert.equal(await page.locator('#pg h1').first().innerText(), h1, label);
  }
  assert.deepEqual(page.errors, []);
});

test('mess selection reloads data for that mess', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  const before = count(page, 'mess=North%20Mess');
  await page.selectOption('#msel', 'North Mess');
  await page.waitForSelector('#pg:has-text("North Mess · Today")');
  await live(page);
  assert.ok(count(page, 'mess=North%20Mess') > before);
});

test('theme switching works and persists across pages', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#th');
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.notEqual(t0, t1);
  await nav(page, 'Reports'); await nav(page, 'Dashboard');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), t1);
  await page.locator('.meal').first().waitFor({ state: 'visible', timeout: 8000 }); // wait for the reloaded data, not a snapshot
});

test('loading state appears while the backend is slow', { skip }, async () => {
  const page = await open();
  await page.route('**/api/v1/dashboard/summary*', async r => { await new Promise(x => setTimeout(x, 1200)); r.continue(); });
  await loginChief(page, 'South Mess');
  assert.ok(await page.locator('#sm-dash >> text=Loading').first().isVisible());
  await live(page);
});

test('backend error: error banner + retry; other sections stay usable', { skip }, async () => {
  const page = await open(); mock.setScenario('fail-summary');
  await loginChief(page, 'South Mess');
  await page.waitForSelector('[role=alert]:has-text("500")');
  assert.equal(await page.locator('b:text-is("LIVE")').count(), 0);
  await page.waitForSelector('.card:has-text("Tomorrow\'s forecast") .meal'); // ML section still renders
  assert.equal(await page.locator('.kpi:has-text("Meals served") .big').count(), 0); // no number invented
  mock.setScenario('normal');
  await page.locator('.banner button:has-text("Retry")').first().click();
  await live(page);
  assert.ok(await page.locator('.meal:has-text("Expected")').first().isVisible());
});

test('ML failure: forecast shows an error, live counts remain live', { skip }, async () => {
  const page = await open(); mock.setScenario('fail-forecast');
  await loginChief(page, 'South Mess'); await live(page);
  await page.waitForSelector('.card:has-text("Tomorrow\'s forecast") [role=alert]:has-text("503")');
  assert.ok(await page.locator('.kpi:has-text("Tomorrow predicted") >> text=Unavailable').isVisible());
});

test('stale data: failed refresh keeps old numbers but is labelled STALE, never LIVE', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  await page.route('**/api/v1/dashboard/summary*', r => r.abort());
  await page.click('button:has-text("Refresh now")');
  await page.waitForSelector('b:text-is("STALE - not live.")');
  assert.equal(await page.locator('b:text-is("LIVE")').count(), 0);
  assert.ok(await page.locator('.meal:has-text("Expected")').first().isVisible()); // last good data still shown
  await page.unroute('**/api/v1/dashboard/summary*');
  await page.locator('.banner button:has-text("Retry")').first().click();
  await live(page);
});

test('refresh button does not create duplicate requests', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  await page.route('**/api/v1/dashboard/summary*', async r => { await new Promise(x => setTimeout(x, 700)); r.continue(); });
  const before = count(page, '/api/v1/dashboard/summary');
  await page.evaluate(() => { const b = document.querySelector('[data-act=refresh]'); for (let i = 0; i < 4; i++) b.click(); });
  await page.waitForTimeout(1600);
  assert.equal(count(page, '/api/v1/dashboard/summary') - before, 1);
});

test('served above expected: values kept, warning shown', { skip }, async () => {
  const page = await open(); mock.setScenario('over');
  await loginChief(page, 'South Mess'); await live(page);
  assert.ok(await page.locator('text=above expected').first().isVisible());
  assert.ok(await page.locator('.meal:has-text("Lunch") >> text=Over expected').isVisible());
});

test('missing values show Unavailable / Partial, never 0', { skip }, async () => {
  const page = await open(); mock.setScenario('missing');
  await loginChief(page, 'South Mess'); await live(page);
  const lunch = page.locator('.meal:has-text("Lunch")').first();
  assert.equal(await lunch.locator('dt:has-text("Served") + dd').innerText(), 'Unavailable');
  assert.equal(await lunch.locator('dt:has-text("Remaining") + dd').innerText(), 'Unavailable');
  assert.ok(await page.locator('.kpi:has-text("Expected meals") >> text=Partial').isVisible());
});

test('empty responses show empty states, not zeros', { skip }, async () => {
  const page = await open(); mock.setScenario('empty');
  await loginChief(page, 'South Mess');
  await page.waitForSelector('text=No exceptions were recorded');
  assert.ok(await page.locator('text=returned no meal periods').first().isVisible());
  assert.ok(await page.locator('text=returned no forecast').first().isVisible());
  for (const l of ['Expected meals', 'Meals served', 'Meals remaining', 'Estimated surplus', 'Tomorrow predicted']) assert.equal(await page.locator('.kpi', { hasText: l }).locator('.big').count(), 0, l);
  assert.equal(await page.locator('.kpi:has-text("Exceptions today") .big').innerText(), '0'); // the backend sent a real 0 here
});

test('data source down: errors everywhere, no numbers invented', { skip }, async () => {
  const page = await open();
  await page.route(API + '/**', r => r.abort());
  await loginChief(page, 'South Mess');
  await page.waitForSelector('[role=alert]');
  await page.waitForFunction(() => document.querySelectorAll('#sm-dash [role=alert]').length >= 3);
  assert.equal(await page.locator('#sm-dash .big').count(), 0);
  assert.equal(await page.locator('#sm-dash .meal').count(), 0);
});

test('untrusted API text is escaped (no script/HTML injection)', { skip }, async () => {
  const page = await open();
  await page.route('**/api/v1/exceptions*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ exceptions: [{ id: '1', timestamp: '2026-10-14T10:00:00', type: 'x<b>', description: '<img src=x onerror="window.__xss=1">', subjectRef: 'S-1', status: 'open' }] }) }));
  await loginChief(page, 'South Mess');
  await page.waitForSelector('td:has-text("onerror")');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#sm-dash img').count(), 0);
});

test('prediction page: chart, MAE/RMSE, meal and date filters, invalid range', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await nav(page, 'Meal Demand Prediction');
  await page.waitForSelector('svg.chart');
  assert.ok(await page.locator('text=MAE (per meal)').isVisible());
  assert.ok(await page.locator('.card:has-text("MAE") .big').first().isVisible());
  assert.ok(await page.locator('.legend:has-text("Predicted")').isVisible());
  await page.selectOption('#pm', 'Lunch');
  await page.waitForFunction(() => document.querySelectorAll('#sm-pred-out tbody tr').length > 0);
  assert.ok(page.reqs.some(u => u.includes('/api/v1/forecasts/evaluations') && u.includes('meal=Lunch')));
  await page.fill('#pf', '2026-10-10');                    // valid range -> one request
  await page.waitForFunction(() => document.querySelectorAll('#sm-pred-out tbody tr').length > 0);
  await page.waitForTimeout(300);
  const n0 = count(page, '/api/v1/forecasts/evaluations');
  await page.fill('#pt', '2026-10-08');                    // end before start -> invalid
  await page.waitForSelector('text=must not be after');
  await page.waitForTimeout(300);
  assert.equal(count(page, '/api/v1/forecasts/evaluations'), n0); // invalid range sends no request
});

test('prediction page: few evaluated forecasts -> no accuracy claim', { skip }, async () => {
  const page = await open();
  const y = new Date(Date.now() - 864e5), ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  await page.route('**/api/v1/forecasts/evaluations*', r => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ records: [{ targetDate: ymd, mealType: 'Lunch', predictedCount: 720, actualCount: 708 }] }) }));
  await loginChief(page, 'South Mess'); await nav(page, 'Meal Demand Prediction');
  await page.waitForSelector('text=1 of 5 evaluated forecasts needed');
  assert.equal(await page.locator('.card:has-text("MAE") .big').count(), 0);
});

test('reports: daily, monthly, date filter; CSV matches the table', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await nav(page, 'Reports');
  await page.waitForSelector('#sm-rep table');
  const day = new Date(Date.now() - 3 * 864e5), ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await page.fill('#rd', ymd);
  await page.waitForSelector(`#sm-rep td:has-text("${ymd}")`);
  const rows = () => page.locator('#sm-rep table').first().locator('tbody tr').count();
  assert.equal(await rows(), 4); // 3 meals + total
  assert.ok(page.reqs.some(u => u.includes('/api/v1/reports/daily') && u.includes(`from=${ymd}&to=${ymd}`)));
  await page.selectOption('#rm', 'monthly'); await page.fill('#rmo', '2026-09');
  await page.waitForSelector('#sm-rep td:has-text("2026-09-30")');
  assert.ok(page.reqs.some(u => u.includes('from=2026-09-01&to=2026-09-30')));
  assert.equal(await rows(), 30 * 3 + 1);
  const cells = await page.locator('#sm-rep table').first().locator('tbody tr:last-child td').allInnerTexts();
  const tableExpected = Number(cells[2].replace(/,/g, '')), tableServed = Number(cells[3].replace(/,/g, ''));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=csv]')]);
  assert.match(dl.suggestedFilename(), /^smart-mess-report_south-mess_2026-09-01_2026-09-30\.csv$/);
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(csv.length, 1 + 90 + 1);
  const tot = csv[csv.length - 1].split(',');
  assert.equal(tot[0], 'TOTAL');
  assert.equal(Number(tot[2]), tableExpected);
  assert.equal(Number(tot[3]), tableServed);
  assert.ok(await page.locator('svg.chart').first().isVisible()); // prepared vs served chart
});

test('reports: empty period shows an empty state and no CSV button', { skip }, async () => {
  const page = await open(); mock.setScenario('empty');
  await loginChief(page, 'South Mess'); await nav(page, 'Reports');
  await page.waitForSelector('text=no report rows for this period');
  assert.equal(await page.locator('[data-act=csv]').count(), 0);
});

test('student portal still works: login, simulated scan, history, feedback page', { skip }, async () => {
  const page = await open();
  await page.fill('#uid', 'nn25cse290'); await page.fill('#pw', 'demo1234'); await page.click('button:has-text("Sign In")');
  await page.waitForSelector('text=Good');
  await nav(page, 'Scan QR');
  await page.click('button:has-text("Simulate valid scan")');
  assert.ok(await page.locator('.res.ok, .res.bad').first().isVisible());
  await nav(page, 'Meal History');
  assert.ok(await page.locator('#pg table tbody tr').count() >= 1);
  await nav(page, 'Menu Feedback');
  assert.ok(await page.locator('#pg h1:has-text("Menu Feedback")').isVisible());
  assert.equal(count(page, '/api/'), 0); // student portal does not call the manager API
  assert.deepEqual(page.errors, []);
});

test('mobile layout: no horizontal scroll, menu opens, cards stack', { skip }, async () => {
  const page = await open({ viewport: { width: 375, height: 800 } }); await loginChief(page, 'South Mess'); await live(page);
  for (const label of ['Dashboard', 'Meal Demand Prediction', 'Reports']) {
    await page.click('#ham'); await page.click(`#nav button:has-text("${label}")`);
    await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 1, `${label} overflows by ${over}px`);
  }
  await page.click('#ham'); await page.click('#nav button:has-text("Dashboard")'); await live(page);
  const xs = await page.locator('.meal').evaluateAll(els => els.slice(0, 3).map(e => Math.round(e.getBoundingClientRect().x)));
  assert.equal(new Set(xs).size, 1); // stacked in one column
});

test('browser calls the API cross-origin with credentials (CORS configured, no wildcard)', { skip }, async () => {
  const page = await open(); await loginChief(page, 'South Mess'); await live(page);
  assert.ok(count(page, '/api/v1/dashboard/summary') >= 1);
  assert.ok(count(page, '/api/v1/forecasts') >= 1);
});

test('forecasts via the ML adapter (FAKE ML): fields, warnings and per-meal reasons render; key stays server-side', { skip }, async () => {
  const ml = createFakeMl(), mlUrl = await new Promise(r => ml.server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + ml.server.address().port)));
  const proxy = createProxy({ mlUrl, apiKey: 'test-key', allowedOrigin: 'http://localhost:3000' });
  await new Promise(r => proxy.server.listen(4100, '127.0.0.1', r));
  try {
    const page = await open({ url: APP + '&mlproxy=1' }); await loginChief(page, 'South Mess'); await live(page);
    const lunch = page.locator('.card:has-text("Tomorrow\'s forecast") .meal:has-text("Lunch")');
    await lunch.waitFor();
    for (const t of ['704', '680 - 731', 'xgb_v1', 'xgboost', 'Not provided', 'SYNTHETIC data']) assert.ok(await lunch.locator(`text=${t}`).first().isVisible(), t);
    assert.ok(await lunch.locator('dt:has-text("Recommended preparation") + dd:has-text("718")').isVisible());
    assert.ok(await page.locator('.card:has-text("Tomorrow\'s forecast") .meal:has-text("Breakfast") >> text=No history for mess').isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('test-key')), false);
  } finally { await new Promise(r => proxy.server.close(r)); await new Promise(r => ml.server.close(r)); }
});
