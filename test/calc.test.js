'use strict';
// Unit tests: pure calculations (no network). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../web/calc.js');

test('toCount: missing/invalid stay null, never 0', () => {
  for (const v of [null, undefined, '', '  ', 'abc', -1, NaN, Infinity, true, false]) assert.equal(c.toCount(v), null, String(v));
  assert.equal(c.toCount(0), 0);
  assert.equal(c.toCount('12'), 12);
});

test('mealStats: normal, partial, unavailable', () => {
  const m = c.mealStats(720, 500);
  assert.deepEqual([m.expected, m.served, m.remaining, m.overServed], [720, 500, 220, false]);
  assert.ok(Math.abs(m.progressPct - 69.444) < 0.01);
  assert.equal(c.mealStats(null, 500).state, 'partial');
  assert.equal(c.mealStats(null, 500).remaining, null);
  assert.equal(c.mealStats(720, null).remaining, null);
  assert.equal(c.mealStats(null, null).state, 'unavailable');
});

test('mealStats: served > expected keeps originals, remaining is 0, flagged', () => {
  const m = c.mealStats(100, 117);
  assert.deepEqual([m.expected, m.served, m.remaining, m.overServed, m.overBy], [100, 117, 0, true, 17]);
});

test('mealStats: expected 0 gives no progress percentage (no divide by zero)', () => {
  const m = c.mealStats(0, 0);
  assert.equal(m.progressPct, null);
  assert.equal(m.remaining, 0);
});

test('surplus: prepared > served, served > prepared, equal, zero, missing', () => {
  assert.deepEqual(pick(c.surplus(734, 708)), { surplus: 26, shortfall: false });
  assert.ok(Math.abs(c.surplus(734, 708).surplusPct - 3.542) < 0.01);
  const s = c.surplus(100, 120);
  assert.deepEqual([s.surplus, s.shortfall, s.shortBy, s.surplusPct], [0, true, 20, 0]);
  assert.deepEqual(pick(c.surplus(50, 50)), { surplus: 0, shortfall: false });
  const z = c.surplus(0, 10);
  assert.equal(z.surplusPct, null); // zero prepared: percentage unavailable
  assert.equal(c.surplus(null, 10).surplus, null);
  assert.equal(c.surplus(100, null).surplus, null);
  assert.equal(c.surplus(null, null).surplusPct, null);
});
function pick(o) { return { surplus: o.surplus, shortfall: o.shortfall }; }

test('absError and PRD example (720 predicted, 708 actual -> 12)', () => {
  assert.equal(c.absError(720, 708), 12);
  assert.equal(c.absError(null, 708), null);
  assert.equal(c.absError(720, -5), null);
});

test('evalMetrics: MAE/RMSE only with enough valid pairs', () => {
  const recs = [[10, 12], [20, 18], [30, 30], [40, 44], [50, 49]].map(([p, a]) => ({ predictedCount: p, actualCount: a }));
  const m = c.evalMetrics(recs);
  assert.equal(m.n, 5);
  assert.equal(m.sufficient, true);
  assert.ok(Math.abs(m.mae - 1.8) < 1e-9);                 // (2+2+0+4+1)/5
  assert.ok(Math.abs(m.rmse - Math.sqrt((4 + 4 + 0 + 16 + 1) / 5)) < 1e-9);
});
test('evalMetrics: single forecast is not reported as model accuracy', () => {
  const m = c.evalMetrics([{ predictedCount: 720, actualCount: 708 }]);
  assert.equal(m.sufficient, false);
  assert.equal(m.mae, null);
  assert.equal(m.rmse, null);
  assert.equal(c.evalMetrics([]).mae, null);
});
test('evalMetrics: invalid records are excluded and counted', () => {
  const recs = Array.from({ length: 5 }, () => ({ predictedCount: 10, actualCount: 12 })).concat([{ predictedCount: null, actualCount: 3 }, { predictedCount: -4, actualCount: 3 }]);
  const m = c.evalMetrics(recs);
  assert.equal(m.n, 5);
  assert.equal(m.excluded, 2);
  assert.equal(m.mae, 2);
});

test('sumAvail: null when nothing valid, never 0', () => {
  assert.deepEqual(c.sumAvail([null, undefined]), { sum: null, n: 0, missing: 2 });
  assert.deepEqual(c.sumAvail([1, null, 2]), { sum: 3, n: 2, missing: 1 });
  assert.equal(c.sumAvail([0]).sum, 0); // a real zero stays zero
});

test('dates: validation, addDays across month/year, monthRange incl. leap year', () => {
  assert.equal(c.isDate('2026-02-30'), false);
  assert.equal(c.isDate('2026-10-14'), true);
  assert.equal(c.isDate('14-10-2026'), false);
  assert.equal(c.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(c.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(c.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(c.monthRange('2026-10'), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(c.monthRange('2026-13'), null);
  assert.equal(c.monthRange(''), null);
});

test('filterRows: date range and meal filter are inclusive', () => {
  const rows = [{ date: '2026-10-01', mealType: 'Lunch' }, { date: '2026-10-02', mealType: 'Dinner' }, { date: '2026-10-03', mealType: 'Lunch' }];
  assert.equal(c.filterRows(rows, { from: '2026-10-02', to: '2026-10-03' }).length, 2);
  assert.equal(c.filterRows(rows, { meal: 'Lunch' }).length, 2);
  assert.equal(c.filterRows(rows, { from: '2026-10-02', to: '2026-10-02', meal: 'Dinner' }).length, 1);
  assert.equal(c.filterRows(rows, { meal: 'all' }).length, 3);
});

test('predictedVsActual: pairs only, skipped are counted, meals summed per date', () => {
  const recs = [
    { targetDate: '2026-10-01', mealType: 'Lunch', predictedCount: 100, actualCount: 90 },
    { targetDate: '2026-10-01', mealType: 'Dinner', predictedCount: 50, actualCount: 60 },
    { targetDate: '2026-10-02', mealType: 'Lunch', predictedCount: 80, actualCount: null },
    { targetDate: '2026-10-02', mealType: 'Dinner', predictedCount: -1, actualCount: 5 }
  ];
  const r = c.predictedVsActual(recs, 'all');
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.points.map(p => [p.date, p.predicted, p.actual, p.absError]), [['2026-10-01', 150, 150, 0]]);
  assert.equal(c.predictedVsActual(recs, 'Lunch').points[0].predicted, 100);
});

test('preparedVsServed: surplus per date, shortfall flagged, missing skipped', () => {
  const rows = [
    { date: '2026-10-01', mealType: 'Lunch', prepared: 100, served: 90 },
    { date: '2026-10-01', mealType: 'Dinner', prepared: 100, served: 95 },
    { date: '2026-10-02', mealType: 'Lunch', prepared: 100, served: 130 },
    { date: '2026-10-02', mealType: 'Dinner', prepared: null, served: 5 }
  ];
  const r = c.preparedVsServed(rows, 'all');
  assert.equal(r.skipped, 1);
  assert.equal(r.points[0].surplus, 15);
  assert.ok(Math.abs(r.points[0].surplusPct - 7.5) < 1e-9);
  assert.equal(r.points[1].surplus, 0);
  assert.equal(r.points[1].shortfall, true);
});

test('buildReport: totals add only available values; surplus % uses paired rows', () => {
  const rows = [
    { date: '2026-10-01', mealType: 'Dinner', expected: 650, served: 600, prepared: 640, predictedCount: 648 },
    { date: '2026-10-01', mealType: 'Lunch', expected: 720, served: 700, prepared: 730, predictedCount: 715 },
    { date: '2026-10-01', mealType: 'Breakfast', expected: 540, served: null, prepared: 550, predictedCount: 530 }
  ];
  const r = c.buildReport(rows);
  assert.deepEqual(r.lines.map(l => l.mealType), ['Breakfast', 'Lunch', 'Dinner']); // meal order, not input order
  assert.equal(r.totals.expected.sum, 1910);
  assert.equal(r.totals.served.sum, 1300);
  assert.equal(r.totals.served.missing, 1);
  assert.equal(r.totals.prepared.sum, 1920);
  assert.equal(r.totals.surplus.sum, 40 + 30);
  assert.ok(Math.abs(r.totals.surplusPct - (70 / 1370) * 100) < 1e-9); // only the two paired rows: prepared 730+640
  assert.equal(r.totals.surplusRows, 2);
});

test('buildReport: empty report has null totals (not zeros)', () => {
  const r = c.buildReport([]);
  assert.equal(r.lines.length, 0);
  assert.equal(r.totals.served.sum, null);
  assert.equal(r.totals.surplusPct, null);
});

test('CSV: header, rows, TOTAL equals on-screen totals, missing cells empty', () => {
  const rows = [
    { date: '2026-10-01', mealType: 'Lunch', expected: 720, served: 700, prepared: 730, predictedCount: 715 },
    { date: '2026-10-01', mealType: 'Dinner', expected: 650, served: null, prepared: null, predictedCount: null }
  ];
  const rep = c.buildReport(rows);
  const lines = c.reportToCsv(rep).trim().split('\r\n');
  assert.equal(lines[0], 'Date,Meal,Expected,Served,Remaining,Prepared,Estimated surplus,Estimated surplus %,Predicted,Absolute error');
  assert.equal(lines[1], '2026-10-01,Lunch,720,700,20,730,30,4.1,715,15');
  assert.equal(lines[2], '2026-10-01,Dinner,650,,,,,,,');
  assert.equal(lines[3], 'TOTAL,,1370,700,,730,30,4.1,,');
  assert.equal(lines.length, 4);
});

test('CSV: quoting and spreadsheet-formula guard on text only', () => {
  assert.equal(c.csvCell('a,b'), '"a,b"');
  assert.equal(c.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(c.csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(c.csvCell(-5), '-5'); // numbers are never altered
  assert.equal(c.csvCell(null), '');
});

test('forecast values: negative prediction is invalid', () => {
  assert.equal(c.toCount(-720), null);
});

test('buildReport: today (still in service) gets no forecast error; past days do', () => {
  const rows = [
    { date: '2026-10-13', mealType: 'Lunch', expected: 700, served: 690, prepared: 710, predictedCount: 700 },
    { date: '2026-10-14', mealType: 'Lunch', expected: 700, served: 120, prepared: 710, predictedCount: 700 }
  ];
  const r = c.buildReport(rows, { inProgressFrom: '2026-10-14' });
  assert.equal(r.lines[0].absError, 10);
  assert.equal(r.lines[1].absError, null);
  assert.equal(r.lines[1].inProgress, true);
  assert.equal(c.buildReport(rows).lines[1].absError, 580); // without the cutoff behaviour is unchanged
});
