'use strict';
// Adapter + client tests against a FAKE of Member 3's ML contract (test/fake-ml.js). Not the real service.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeMl } = require('./fake-ml.js');
const { createProxy } = require('../adapters/ml-proxy.js');
const { createClient, normalizeForecasts } = require('../web/api.js');

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
const close = (srv) => new Promise(r => srv.close(r));

async function withStack(fn, proxyOpts) {
  const ml = createFakeMl(), mlUrl = await listen(ml.server);
  const proxy = createProxy(Object.assign({ mlUrl, apiKey: 'test-key' }, proxyOpts)), base = await listen(proxy.server);
  try { await fn({ ml, base, client: createClient({ apiBase: base, timeoutMs: 3000 }) }); } finally { await close(proxy.server); await close(ml.server); }
}

test('adapter: maps the ML contract to the dashboard shape (3 meals, one with no history)', async () => {
  await withStack(async ({ client }) => {
    const r = await client.getForecasts({ mess: 'South Mess', date: '2026-10-15' });
    assert.equal(r.ok, true);
    const by = Object.fromEntries(r.data.forecasts.map(f => [f.mealType, f]));
    assert.deepEqual(Object.keys(by).sort(), ['Dinner', 'Lunch']);
    assert.equal(by.Lunch.predictedCount, 704);
    assert.deepEqual(by.Lunch.range, { low: 680, high: 731 });
    assert.equal(by.Lunch.modelVersion, 'xgb_v1');
    assert.equal(by.Lunch.method, 'xgboost');
    assert.equal(by.Lunch.recommendedPrep, 718);
    assert.equal(by.Lunch.generatedAt, null);        // the ML service sends none; nothing is invented
    assert.equal(by.Dinner.range, null);             // baseline method: no range
    assert.equal(by.Dinner.method, 'moving_average_7');
    assert.equal(r.data.unavailable.length, 1);
    assert.equal(r.data.unavailable[0].mealType, 'Breakfast');
    assert.match(r.data.unavailable[0].reason, /No history for mess='south'/);
    assert.equal(r.synthetic, true);                 // 'trained on SYNTHETIC data' warning flips the banner
    assert.match(by.Lunch.warnings[0], /SYNTHETIC/);
  });
});

test('adapter: the ML API key is sent to ML only and never returned to the caller', async () => {
  await withStack(async ({ ml, base }) => {
    const res = await fetch(base + '/api/v1/forecasts?mess=South%20Mess&date=2026-10-15'), text = await res.text();
    assert.ok(ml.state.calls.length === 3);
    assert.ok(ml.state.calls.every(c => c.headers['x-api-key'] === 'test-key'));
    assert.equal(text.includes('test-key'), false);
    assert.equal(text.includes('internal_note'), false);   // only whitelisted ML fields are forwarded
    assert.equal(res.headers.get('x-api-key'), null);
  });
});

test('adapter: wrong key -> 502 with a generic message, no number invented', async () => {
  const ml = createFakeMl(), mlUrl = await listen(ml.server);
  const proxy = createProxy({ mlUrl, apiKey: 'wrong' }), base = await listen(proxy.server);
  try {
    const r = await createClient({ apiBase: base }).getForecasts({ mess: 'South Mess', date: '2026-10-15' });
    assert.equal(r.ok, false);
    assert.equal(r.error.status, 502);
    assert.match(r.error.message, /rejected/);
  } finally { await close(proxy.server); await close(ml.server); }
});

test('adapter: ML service down / erroring -> 502 error result', async () => {
  await withStack(async ({ ml, client }) => {
    ml.state.mode = 'down';
    let r = await client.getForecasts({ mess: 'South Mess', date: '2026-10-15' });
    assert.equal(r.ok, false); assert.equal(r.error.status, 502);
    ml.state.mode = 'error';
    r = await client.getForecasts({ mess: 'South Mess', date: '2026-10-15' });
    assert.equal(r.ok, false); assert.match(r.error.message, /error \(500\)/);
  });
});

test('adapter: unknown mess -> every meal unavailable with the ML reason (not an error, not zeros)', async () => {
  await withStack(async ({ client }) => {
    const r = await client.getForecasts({ mess: 'West Mess', date: '2026-10-15' });
    assert.equal(r.ok, true);
    assert.equal(r.data.forecasts.length, 0);
    assert.equal(r.data.unavailable.length, 3);
  });
});

test('adapter: single meal filter, bad input, ranges and unsupported endpoints', async () => {
  await withStack(async ({ client, base }) => {
    const one = await client.getForecasts({ mess: 'South Mess', date: '2026-10-15', meal: 'Lunch' });
    assert.deepEqual(one.data.forecasts.map(f => f.mealType), ['Lunch']);
    assert.equal((await fetch(base + '/api/v1/forecasts?mess=South%20Mess&date=nope')).status, 400);
    assert.equal((await fetch(base + '/api/v1/forecasts?mess=South%20Mess&from=2026-10-01&to=2026-10-05')).status, 400);
    assert.equal((await fetch(base + '/api/v1/forecasts?mess=South%20Mess&date=2026-10-15&meal=brunch')).status, 400);
    assert.equal((await fetch(base + '/api/v1/forecasts/evaluations?mess=x')).status, 501); // history is the backend's job
    assert.equal((await fetch(base + '/api/v1/forecasts', { method: 'POST' })).status, 405);
    const ev = await client.getEvaluations({ mess: 'South Mess', from: '2026-10-01', to: '2026-10-05' });
    assert.equal(ev.ok, false);                                                          // surfaces as an honest error
  });
});

test('adapter: CORS only for the allowed origin', async () => {
  await withStack(async ({ base }) => {
    const ok = await fetch(base + '/api/v1/forecasts?mess=South%20Mess&date=2026-10-15', { headers: { Origin: 'http://localhost:3000' } });
    const bad = await fetch(base + '/api/v1/forecasts?mess=South%20Mess&date=2026-10-15', { headers: { Origin: 'http://evil.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('client accepts ML-native fields passed straight through by a backend route', () => {
  const out = normalizeForecasts({ forecasts: [{ mess_id: 'south', date: '2026-10-15', meal_type: 'lunch', predicted_meals: 700,
    recommended_preparation: 714, prediction_range: { low: 680, high: 725, coverage: '~80%' }, model_version: 'xgb_v2', method: 'xgboost', warnings: ['a', '', 5] }] });
  const f = out.forecasts[0];
  assert.deepEqual([f.mealType, f.targetDate, f.predictedCount, f.recommendedPrep, f.modelVersion, f.messId], ['Lunch', '2026-10-15', 700, 714, 'xgb_v2', 'south']);
  assert.deepEqual(f.range, { low: 680, high: 725 });
  assert.deepEqual(f.warnings, ['a']);
  assert.equal(f.synthetic, false);
});

test('client: negative ML prediction is invalid, not a number', () => {
  const f = normalizeForecasts({ forecasts: [{ meal_type: 'lunch', predicted_meals: -3 }] }).forecasts[0];
  assert.equal(f.predictedCount, null);
  assert.equal(f.invalidPredicted, true);
});
