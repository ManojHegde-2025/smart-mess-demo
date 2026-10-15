'use strict';
// Unit tests for dashboard state logic, chart builders and escaping (no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../web/dashboard.js');
const charts = require('../web/charts.js');

const never = () => false;
const ok = (data, extra) => Object.assign({ ok: true, data, fetchedAt: 1000, synthetic: false }, extra);
const bad = (message) => ({ ok: false, error: { kind: 'http', message } });

test('applyResult: success -> ok; empty collection -> empty', () => {
  const s = d.newSection();
  d.applyResult(s, ok({ meals: [1] }), x => x.meals.length === 0);
  assert.equal(s.status, 'ok');
  d.applyResult(s, ok({ meals: [] }), x => x.meals.length === 0);
  assert.equal(s.status, 'empty');
});

test('applyResult: first failure -> error with no data (no fake fallback)', () => {
  const s = d.newSection();
  d.applyResult(s, bad('boom'), never);
  assert.equal(s.status, 'error');
  assert.equal(s.data, null);
  assert.equal(s.stale, false);
});

test('applyResult: failure after success keeps old data but marks it STALE', () => {
  const s = d.newSection();
  d.applyResult(s, ok({ meals: [1] }), never);
  d.applyResult(s, bad('down'), never);
  assert.equal(s.stale, true);
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.data, { meals: [1] });
  assert.equal(s.fetchedAt, 1000);        // time of the last SUCCESS, not of the failure
  d.applyResult(s, ok({ meals: [2] }, { fetchedAt: 2000 }), never);
  assert.equal(s.stale, false);           // recovers
  assert.equal(s.fetchedAt, 2000);
});

test('applyResult: synthetic flag follows the latest response', () => {
  const s = d.newSection();
  d.applyResult(s, ok({}, { synthetic: true }), never);
  assert.equal(s.synthetic, true);
});

test('aggregate: normal day', () => {
  const a = d.aggregate([{ mealType: 'Lunch', expected: 720, served: 500, prepared: 734 }, { mealType: 'Dinner', expected: 650, served: 0, prepared: 640 }]);
  assert.equal(a.expected.sum, 1370);
  assert.equal(a.served.sum, 500);
  assert.equal(a.remaining.sum, 220 + 650);
  assert.equal(a.surplus.sum, 234 + 640);
  assert.equal(a.overServed.length, 0);
});

test('aggregate: served > expected keeps served as received and flags the meal', () => {
  const a = d.aggregate([{ mealType: 'Lunch', expected: 100, served: 117, prepared: 120 }]);
  assert.equal(a.served.sum, 117);
  assert.equal(a.remaining.sum, 0);
  assert.equal(a.overServed.length, 1);
});

test('aggregate: missing values -> partial totals / null, never 0', () => {
  const a = d.aggregate([{ mealType: 'Lunch', expected: 100, served: null, prepared: null }, { mealType: 'Dinner', expected: null, served: null, prepared: null }]);
  assert.equal(a.expected.sum, 100);
  assert.equal(a.expected.missing, 1);     // UI shows "Partial: 1 of 2 meals"
  assert.equal(a.served.sum, null);
  assert.equal(a.remaining.sum, null);
  assert.equal(a.surplus.sum, null);
  assert.equal(d.aggregate([]).expected.sum, null);
});

test('forecastTotal: invalid predictions are not summed', () => {
  assert.deepEqual(d.forecastTotal([{ predictedCount: 500 }, { predictedCount: null }]), { sum: 500, n: 1, missing: 1 });
  assert.equal(d.forecastTotal([]).sum, null);
});

test('dateRangeError', () => {
  assert.equal(d.dateRangeError('2026-10-01', '2026-10-14'), null);
  assert.match(d.dateRangeError('2026-10-14', '2026-10-01'), /not be after/);
  assert.match(d.dateRangeError('', '2026-10-01'), /valid/);
  assert.match(d.dateRangeError('2026-01-01', '2026-10-01'), /at most/);
});

test('escaping: untrusted API text cannot inject HTML', () => {
  assert.equal(d.esc('<img src=x onerror=alert(1)>"\''), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
  assert.equal(d.esc(null), '');
  assert.equal(d.typeLabel('duplicate_scan'), 'Duplicate scan');
});

test('charts: empty input draws nothing; line and bar charts are accessible SVG', () => {
  assert.equal(charts.lineChart({ points: [], series: [] }), '');
  const svg = charts.lineChart({ aria: 'A "chart"', series: [{ key: 'a', label: 'Predicted', cls: 's1' }, { key: 'b', label: 'Actual', cls: 's2 dsh' }], points: [{ label: '10-01', values: { a: 100, b: 90 } }, { label: '10-02', values: { a: 120, b: 125 } }] });
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="A &quot;chart&quot;"/);
  assert.equal((svg.match(/<circle/g) || []).length, 4);
  assert.match(svg, /class="ln s2 dsh"/);
  const one = charts.lineChart({ series: [{ key: 'a', label: 'A', cls: 's1' }], points: [{ label: 'x', values: { a: 5 } }] });
  assert.match(one, /<circle/);              // single point still renders
  assert.ok(!/NaN/.test(one + svg));
  const bars = charts.barChart({ series: [{ key: 'p', label: 'P', cls: 's1' }, { key: 's', label: 'S', cls: 's2' }], points: [{ label: 'a', values: { p: 10, s: 0 } }] });
  assert.equal((bars.match(/<rect/g) || []).length, 2);
  assert.ok(!/NaN/.test(bars));
});

test('charts: nice axis maximum covers the data', () => {
  for (const max of [1, 7, 99, 720, 1910, 12345]) assert.ok(charts.axis(max).top >= max, String(max));
});
