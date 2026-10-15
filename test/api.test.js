'use strict';
// API client tests. "Mock-server" tests run against the in-process SYNTHETIC mock (mock/mock-api.js);
// "fake-fetch" tests feed hand-written responses. These are NOT integration tests against the real
// backend or ML service (see docs/API_CONTRACT.md for what is still blocked).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMock } = require('../mock/mock-api.js');
const { createClient, normalizeForecasts, normalizeSummary, normalizeExceptions } = require('../web/api.js');

const NOW = () => new Date(2026, 9, 14, 13, 0, 0); // fixed clock: 14 Oct 2026, 13:00 local

async function withMock(scenario, fn) {
  const m = createMock({ now: NOW, scenario });
  await new Promise(r => m.server.listen(0, r));
  const base = 'http://127.0.0.1:' + m.server.address().port;
  try { await fn(createClient({ apiBase: base, timeoutMs: 3000 }), m, base); } finally { await new Promise(r => m.server.close(r)); }
}
const fake = (status, body, raw) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => (raw !== undefined ? raw : JSON.stringify(body)) });
const clientWith = (impl) => createClient({ apiBase: 'http://x', fetchImpl: impl, timeoutMs: 1000 });

test('mock-server: summary success is flagged synthetic with 3 meals', async () => {
  await withMock('normal', async (cl) => {
    const r = await cl.getSummary({ mess: 'South Mess', date: '2026-10-14' });
    assert.equal(r.ok, true);
    assert.equal(r.synthetic, true);
    assert.deepEqual(r.data.meals.map(m => m.mealType), ['Breakfast', 'Lunch', 'Dinner']);
    assert.equal(typeof r.data.meals[1].expected, 'number');
  });
});

test('mock-server: served counts change as the clock moves (refresh after data changes)', async () => {
  const clock = { t: new Date(2026, 9, 14, 12, 30) };
  const m = createMock({ now: () => clock.t });
  await new Promise(r => m.server.listen(0, r));
  const cl = createClient({ apiBase: 'http://127.0.0.1:' + m.server.address().port });
  const lunch = async () => (await cl.getSummary({ mess: 'South Mess', date: '2026-10-14' })).data.meals.find(x => x.mealType === 'Lunch').served;
  const a = await lunch(); clock.t = new Date(2026, 9, 14, 13, 30); const b = await lunch();
  await new Promise(r => m.server.close(r));
  assert.ok(b > a, `served should grow: ${a} -> ${b}`);
});

test('mock-server: empty scenario returns empty collections (not zeros, not errors)', async () => {
  await withMock('empty', async (cl) => {
    assert.deepEqual((await cl.getSummary({ mess: 'South Mess' })).data.meals, []);
    assert.deepEqual((await cl.getForecasts({ mess: 'South Mess' })).data.forecasts, []);
    assert.deepEqual((await cl.getExceptions({ mess: 'South Mess' })).data.exceptions, []);
    assert.deepEqual((await cl.getReport({ mess: 'South Mess', from: '2026-10-14', to: '2026-10-14' })).data.rows, []);
  });
});

test('mock-server: missing values arrive as null, not 0', async () => {
  await withMock('missing', async (cl) => {
    const m = (await cl.getSummary({ mess: 'South Mess' })).data.meals;
    assert.equal(m.find(x => x.mealType === 'Lunch').served, null);
    assert.equal(m.find(x => x.mealType === 'Dinner').expected, null);
    assert.equal(m.find(x => x.mealType === 'Breakfast').prepared, null);
  });
});

test('mock-server: served above expected is passed through unchanged', async () => {
  await withMock('over', async (cl) => {
    const l = (await cl.getSummary({ mess: 'South Mess' })).data.meals.find(x => x.mealType === 'Lunch');
    assert.equal(l.served, l.expected + 17);
  });
});

test('mock-server: summary 500 -> error result, no data', async () => {
  await withMock('fail-summary', async (cl) => {
    const r = await cl.getSummary({ mess: 'South Mess' });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'http');
    assert.equal(r.error.status, 500);
    assert.equal(r.data, undefined);
  });
});

test('mock-server: ML failure does not break the backend endpoints', async () => {
  await withMock('fail-forecast', async (cl) => {
    const f = await cl.getForecasts({ mess: 'South Mess' });
    assert.equal(f.ok, false);
    assert.equal(f.error.status, 503);
    assert.equal((await cl.getSummary({ mess: 'South Mess' })).ok, true);
  });
});

test('mock-server: 401 becomes an auth error', async () => {
  await withMock('auth', async (cl) => {
    const r = await cl.getSummary({ mess: 'South Mess' });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'auth');
  });
});

test('mock-server: forecasts for different dates and meals; evaluations; exceptions; reports', async () => {
  await withMock('normal', async (cl) => {
    const a = (await cl.getForecasts({ mess: 'South Mess', date: '2026-10-15' })).data.forecasts;
    const b = (await cl.getForecasts({ mess: 'South Mess', date: '2026-10-16' })).data.forecasts;
    assert.equal(a.length, 3);
    assert.ok(a.every(f => f.targetDate === '2026-10-15') && b.every(f => f.targetDate === '2026-10-16'));
    assert.ok(a[0].range && a[0].range.low <= a[0].predictedCount && a[0].predictedCount <= a[0].range.high);
    const lunch = (await cl.getForecasts({ mess: 'South Mess', date: '2026-10-15', meal: 'Lunch' })).data.forecasts;
    assert.deepEqual(lunch.map(f => f.mealType), ['Lunch']);
    const ev = (await cl.getEvaluations({ mess: 'South Mess', from: '2026-10-01', to: '2026-10-10' })).data.records;
    assert.equal(ev.length, 30);
    const ex = (await cl.getExceptions({ mess: 'South Mess', from: '2026-10-01', to: '2026-10-07' })).data.exceptions;
    assert.ok(ex.every(e => e.timestamp.slice(0, 10) >= '2026-10-01' && e.timestamp.slice(0, 10) <= '2026-10-07'));
    const rp = (await cl.getReport({ mess: 'South Mess', from: '2026-10-01', to: '2026-10-03' })).data.rows;
    assert.equal(rp.length, 9);
  });
});

test('mock-server: only the allowed origin gets CORS headers (no wildcard)', async () => {
  await withMock('normal', async (cl, m, base) => {
    const ok = await fetch(base + '/api/v1/exceptions', { headers: { Origin: 'http://localhost:3000' } });
    const bad = await fetch(base + '/api/v1/exceptions', { headers: { Origin: 'http://evil.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('refresh does not stack requests: identical in-flight calls share one fetch', async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const cl = clientWith(async () => { calls++; await gate; return { status: 200, ok: true, text: async () => JSON.stringify({ meals: [] }) }; });
  const p = [cl.getSummary({ mess: 'South Mess', date: '2026-10-14' }), cl.getSummary({ mess: 'South Mess', date: '2026-10-14' }), cl.getSummary({ mess: 'South Mess', date: '2026-10-14' })];
  release();
  const rs = await Promise.all(p);
  assert.equal(calls, 1);
  assert.ok(rs.every(r => r.ok));
  await cl.getSummary({ mess: 'South Mess', date: '2026-10-14' }); // finished -> next refresh makes a new request
  assert.equal(calls, 2);
});

test('network failure -> kind network (never sample data)', async () => {
  const cl = createClient({ apiBase: 'http://127.0.0.1:1', timeoutMs: 1000 });
  const r = await cl.getSummary({ mess: 'South Mess' });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'network');
});

test('timeout -> kind timeout', async () => {
  const cl = createClient({ apiBase: 'http://x', timeoutMs: 30, fetchImpl: (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  const r = await cl.getForecasts({ mess: 'South Mess' });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'timeout');
});

test('non-JSON body -> parse error; wrong shape -> shape error', async () => {
  assert.equal((await clientWith(fake(200, null, '<html>oops</html>')).getSummary({})).error.kind, 'parse');
  assert.equal((await clientWith(fake(200, { nothing: true })).getSummary({})).error.kind, 'shape');
  assert.equal((await clientWith(fake(200, { meals: 'x' })).getSummary({})).error.kind, 'shape');
});

test('error body message is surfaced, truncated; 403 is an auth error', async () => {
  const r = await clientWith(fake(500, { error: 'x'.repeat(500) })).getSummary({});
  assert.equal(r.error.kind, 'http');
  assert.ok(r.error.message.length < 260);
  assert.equal((await clientWith(fake(403, {})).getSummary({})).error.kind, 'auth');
});

test('requests send no secrets in the URL and no cookies cross-site', async () => {
  let seen;
  const cl = clientWith(async (url, opts) => { seen = { url, opts }; return { status: 200, ok: true, text: async () => JSON.stringify({ meals: [] }) }; });
  await cl.getSummary({ mess: 'South Mess', date: '2026-10-14' });
  assert.equal(seen.opts.credentials, 'same-origin');
  assert.equal(seen.opts.method, 'GET');
  assert.equal(seen.url, 'http://x/api/v1/dashboard/summary?mess=South%20Mess&date=2026-10-14');
  assert.ok(!/token|password|key=/i.test(seen.url));
});

test('managerLogin: a manager gets a token stored, a student is refused and nothing is stored', async () => {
  const { auth } = require('../web/api.js');
  const store = {};
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  try {
    const mgr = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ access_token: 'tok-m', role: 'manager' }) });
    const res = await auth.login('http://x', 'MGR001', 'password123', mgr);
    assert.equal(res.role, 'manager');
    assert.equal(store.sm_manager_token, 'tok-m');
    assert.equal(auth.hasToken(), true);

    auth.signOut();
    assert.equal(auth.hasToken(), false);

    const stu = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ access_token: 'tok-s', role: 'student' }) });
    await assert.rejects(auth.login('http://x', 'STU001', 'password123', stu), /not a mess manager/);
    assert.equal(auth.hasToken(), false);

    const bad = async () => ({ status: 401, ok: false, text: async () => '{"detail":"Invalid"}' });
    await assert.rejects(auth.login('http://x', 'MGR001', 'nope', bad), /Wrong ID or password/);
  } finally {
    delete global.localStorage;
  }
});

test('requests carry the Bearer token when signed in', async () => {
  const { auth } = require('../web/api.js');
  global.localStorage = { getItem: () => 'tok-abc', setItem() {}, removeItem() {} };
  try {
    let seen;
    const cl = clientWith(async (url, opts) => { seen = opts; return { status: 200, ok: true, text: async () => JSON.stringify({ meals: [] }) }; });
    await cl.getSummary({ mess: 'South Mess', date: '2026-10-14' });
    assert.equal(seen.headers.Authorization, 'Bearer tok-abc');
    assert.ok(auth.hasToken());
  } finally {
    delete global.localStorage;
  }
});

test('mess id mapping is applied to query parameters', async () => {
  let url;
  const cl = createClient({ apiBase: 'http://x', messIds: { 'South Mess': 'south' }, fetchImpl: async (u) => { url = u; return { status: 200, ok: true, text: async () => JSON.stringify({ forecasts: [] }) }; } });
  await cl.getForecasts({ mess: 'South Mess', date: '2026-10-15' });
  assert.match(url, /mess=south&date=2026-10-15/);
});

test('forecast normalizer: missing range / model version stay null; negative or text predictions are invalid', () => {
  const out = normalizeForecasts({ forecasts: [
    { messId: 'south', targetDate: '2026-10-15', mealType: 'Lunch', predictedCount: 700 },
    { messId: 'south', targetDate: '2026-10-15', mealType: 'Dinner', predictedCount: -5, range: { low: 1, high: 2 }, modelVersion: 'v1' },
    { messId: 'south', targetDate: '2026-10-15', mealType: 'Breakfast', predictedCount: 'lots', range: { low: 9, high: 3 } },
    { messId: 'south', targetDate: '2026-10-15', mealType: 'Snacks' }
  ] }).forecasts;
  const by = Object.fromEntries(out.map(f => [f.mealType, f]));
  assert.equal(by.Lunch.range, null);
  assert.equal(by.Lunch.modelVersion, null);
  assert.equal(by.Lunch.generatedAt, null);
  assert.equal(by.Lunch.recommendedPrep, null);
  assert.equal(by.Dinner.predictedCount, null);
  assert.equal(by.Dinner.invalidPredicted, true);
  assert.equal(by.Breakfast.invalidPredicted, true);
  assert.equal(by.Breakfast.range, null); // low > high is rejected, not invented
  assert.equal(by.Snacks.invalidPredicted, false); // absent, not invalid
  assert.deepEqual(out.map(f => f.mealType), ['Breakfast', 'Lunch', 'Snacks', 'Dinner']);
});

test('summary normalizer: missing values stay null', () => {
  const s = normalizeSummary({ meals: [{ mealType: 'Lunch', expected: 100 }, { mealType: 'Dinner', expected: 'x', served: -1, prepared: 0 }] });
  assert.equal(s.meals[0].served, null);
  assert.equal(s.meals[1].expected, null);
  assert.equal(s.meals[1].served, null);
  assert.equal(s.meals[1].prepared, 0); // a real zero is preserved
  assert.equal(s.exceptionCount, null);
});

test('exception normalizer: optional fields missing -> null; rows without id get a stable key', () => {
  const e = normalizeExceptions({ exceptions: [{ type: 'duplicate_scan' }, { id: 7, timestamp: '2026-10-14T10:00:00', description: 'x', subjectRef: 'S-1', status: 'open' }] }).exceptions;
  assert.deepEqual([e[0].id, e[0].timestamp, e[0].description, e[0].subjectRef, e[0].status], ['row-0', null, null, null, null]);
  assert.equal(e[1].id, '7');
  assert.equal(normalizeExceptions({ exceptions: [{}] }).exceptions[0].type, 'unknown');
});

test('exception normalizer never copies unknown (possibly personal) fields', () => {
  const e = normalizeExceptions({ exceptions: [{ id: 'a', type: 't', studentName: 'Jane Doe', email: 'j@x.y' }] }).exceptions[0];
  assert.equal(JSON.stringify(e).includes('Jane'), false);
  assert.equal(JSON.stringify(e).includes('@'), false);
});
