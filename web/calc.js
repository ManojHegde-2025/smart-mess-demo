/*
 * Smart Mess - manager dashboard calculations (Member 4).
 *
 * Pure functions only: no DOM, no network, no randomness. Works in the browser
 * (window.SmartMessCalc) and in Node (require) so the same code is unit tested.
 *
 * Core rule: a missing or invalid value stays null. It is never turned into 0.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmartMessCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEAL_ORDER = ['Breakfast', 'Lunch', 'Snacks', 'Dinner'];

  // MAE/RMSE are shown only when at least this many valid forecast/actual pairs exist.
  // This is a display threshold, not a statistical guarantee; it is tunable by the team.
  var MIN_EVAL_RECORDS = 5;

  /** Valid count -> number. Missing, non-numeric, boolean, negative or non-finite -> null. */
  function toCount(v) {
    if (v === null || v === undefined || typeof v === 'boolean') return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * Live meal statistics for one meal period.
   * remaining = max(expected - served, 0), only when both values exist.
   * expected and served are returned exactly as received (never clamped).
   */
  function mealStats(expectedRaw, servedRaw) {
    var expected = toCount(expectedRaw), served = toCount(servedRaw);
    var out = { expected: expected, served: served, remaining: null, progressPct: null, overServed: false, overBy: null, state: 'ok' };
    if (expected === null && served === null) out.state = 'unavailable';
    else if (expected === null || served === null) out.state = 'partial';
    if (expected !== null && served !== null) {
      out.remaining = Math.max(expected - served, 0);
      out.overServed = served > expected;
      out.overBy = out.overServed ? served - expected : null;
      if (expected > 0) out.progressPct = served / expected * 100;
    }
    return out;
  }

  /**
   * Estimated surplus = max(prepared - served, 0).
   * surplusPct = surplus / prepared * 100, null when prepared is 0 or missing.
   * This is a portions estimate, NOT a measurement of physical food waste.
   */
  function surplus(preparedRaw, servedRaw) {
    var prepared = toCount(preparedRaw), served = toCount(servedRaw);
    var out = { prepared: prepared, served: served, surplus: null, surplusPct: null, shortfall: false, shortBy: null };
    if (prepared !== null && served !== null) {
      out.surplus = Math.max(prepared - served, 0);
      out.shortfall = served > prepared;
      out.shortBy = out.shortfall ? served - prepared : null;
      if (prepared > 0) out.surplusPct = out.surplus / prepared * 100;
    }
    return out;
  }

  /** absoluteError = |predicted - actual|; null if either side is missing/invalid. */
  function absError(predictedRaw, actualRaw) {
    var p = toCount(predictedRaw), a = toCount(actualRaw);
    return p === null || a === null ? null : Math.abs(p - a);
  }

  /**
   * MAE and RMSE over forecast/actual records [{predictedCount, actualCount}].
   * Records with a missing/invalid side are excluded and counted.
   * Below MIN_EVAL_RECORDS valid pairs no metric is returned (sufficient=false).
   */
  function evalMetrics(records, minRecords) {
    var min = typeof minRecords === 'number' ? minRecords : MIN_EVAL_RECORDS;
    var sumAbs = 0, sumSq = 0, n = 0, excluded = 0;
    (records || []).forEach(function (r) {
      var e = absError(r && r.predictedCount, r && r.actualCount);
      if (e === null) { excluded++; return; }
      sumAbs += e; sumSq += e * e; n++;
    });
    var sufficient = n >= min && n > 0;
    return {
      n: n, excluded: excluded, minRequired: min, sufficient: sufficient,
      mae: sufficient ? sumAbs / n : null,
      rmse: sufficient ? Math.sqrt(sumSq / n) : null
    };
  }

  /** Sum of valid values. sum is null when no value is valid (never 0 for "no data"). */
  function sumAvail(values) {
    var sum = null, n = 0, missing = 0;
    (values || []).forEach(function (v) {
      var c = toCount(v);
      if (c === null) { missing++; return; }
      sum = (sum === null ? 0 : sum) + c; n++;
    });
    return { sum: sum, n: n, missing: missing };
  }

  /* ---------- dates (YYYY-MM-DD strings, no timezone surprises) ---------- */

  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }
  function addDays(s, n) {
    var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  /** 'YYYY-MM' -> {from, to} (first and last day of that month). */
  function monthRange(ym) {
    if (typeof ym !== 'string' || !/^\d{4}-\d{2}$/.test(ym)) return null;
    var p = ym.split('-').map(Number);
    if (p[1] < 1 || p[1] > 12) return null;
    var last = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    return { from: ym + '-01', to: ym + '-' + String(last).padStart(2, '0') };
  }

  function sortMeals(a, b) {
    var ia = MEAL_ORDER.indexOf(a), ib = MEAL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
  }

  /** Keep rows whose date is inside [from, to] and (optionally) whose meal matches. */
  function filterRows(rows, f) {
    f = f || {};
    return (rows || []).filter(function (r) {
      var d = r.date || r.targetDate;
      if (f.from && !(d >= f.from)) return false;
      if (f.to && !(d <= f.to)) return false;
      if (f.meal && f.meal !== 'all' && r.mealType !== f.meal) return false;
      return true;
    });
  }

  /**
   * Predicted-vs-actual series, one point per date.
   * Only records with BOTH a valid prediction and a valid actual are used, so the two
   * lines always describe the same meals. Skipped records are counted, not hidden.
   * meal = 'all' sums the paired meals of each date.
   */
  function predictedVsActual(records, meal) {
    var byDate = {}, skipped = 0;
    (records || []).forEach(function (r) {
      if (meal && meal !== 'all' && r.mealType !== meal) return;
      var p = toCount(r.predictedCount), a = toCount(r.actualCount);
      if (p === null || a === null) { skipped++; return; }
      var d = byDate[r.targetDate] || (byDate[r.targetDate] = { date: r.targetDate, predicted: 0, actual: 0, meals: 0 });
      d.predicted += p; d.actual += a; d.meals++;
    });
    var points = Object.keys(byDate).sort().map(function (k) {
      var d = byDate[k];
      d.absError = Math.abs(d.predicted - d.actual);
      return d;
    });
    return { points: points, skipped: skipped };
  }

  /** Prepared-vs-served series per date from report rows (rows with both values only). */
  function preparedVsServed(rows, meal) {
    var byDate = {}, skipped = 0;
    (rows || []).forEach(function (r) {
      if (meal && meal !== 'all' && r.mealType !== meal) return;
      var p = toCount(r.prepared), s = toCount(r.served);
      if (p === null || s === null) { skipped++; return; }
      var d = byDate[r.date] || (byDate[r.date] = { date: r.date, prepared: 0, served: 0 });
      d.prepared += p; d.served += s;
    });
    var points = Object.keys(byDate).sort().map(function (k) {
      var d = byDate[k], x = surplus(d.prepared, d.served);
      d.surplus = x.surplus; d.surplusPct = x.surplusPct; d.shortfall = x.shortfall;
      return d;
    });
    return { points: points, skipped: skipped };
  }

  /**
   * Report builder shared by the screen and the CSV export, so they cannot disagree.
   * rows: [{date, mealType, expected, served, prepared, predictedCount}]
   */
  function buildReport(rows, opts) {
    // Days on/after opts.inProgressFrom (normally today) are still being served, so a forecast
    // error against their partial served count would be misleading: absError stays null for them.
    var cutoff = opts && opts.inProgressFrom;
    var lines = (rows || []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : sortMeals(a.mealType, b.mealType);
    }).map(function (r) {
      var m = mealStats(r.expected, r.served), s = surplus(r.prepared, r.served);
      return {
        date: r.date, mealType: r.mealType,
        expected: m.expected, served: m.served, remaining: m.remaining, overServed: m.overServed,
        prepared: s.prepared, surplus: s.surplus, surplusPct: s.surplusPct,
        predicted: toCount(r.predictedCount), inProgress: !!(cutoff && r.date >= cutoff), absError: cutoff && r.date >= cutoff ? null : absError(r.predictedCount, r.served)
      };
    });
    var paired = lines.filter(function (l) { return l.surplus !== null; });
    var pairedPrepared = sumAvail(paired.map(function (l) { return l.prepared; })).sum;
    var surplusSum = sumAvail(paired.map(function (l) { return l.surplus; }));
    var totals = {
      expected: sumAvail(lines.map(function (l) { return l.expected; })),
      served: sumAvail(lines.map(function (l) { return l.served; })),
      prepared: sumAvail(lines.map(function (l) { return l.prepared; })),
      surplus: surplusSum,
      surplusPct: surplusSum.sum !== null && pairedPrepared > 0 ? surplusSum.sum / pairedPrepared * 100 : null,
      surplusRows: paired.length
    };
    return { lines: lines, totals: totals };
  }

  /* ---------- CSV ---------- */

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = typeof v === 'number' ? String(v) : String(v);
    // Spreadsheet formula injection guard applies to text only, never to numbers.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function round1(v) { return v === null ? null : Math.round(v * 10) / 10; }

  /** CSV text for a report (header + one line per row + TOTAL line). Missing values are empty cells. */
  function reportToCsv(report) {
    var head = ['Date', 'Meal', 'Expected', 'Served', 'Remaining', 'Prepared', 'Estimated surplus', 'Estimated surplus %', 'Predicted', 'Absolute error'];
    var out = [head.map(csvCell).join(',')];
    report.lines.forEach(function (l) {
      out.push([l.date, l.mealType, l.expected, l.served, l.remaining, l.prepared, l.surplus, round1(l.surplusPct), l.predicted, l.absError].map(csvCell).join(','));
    });
    var t = report.totals;
    out.push(['TOTAL', '', t.expected.sum, t.served.sum, '', t.prepared.sum, t.surplus.sum, round1(t.surplusPct), '', ''].map(csvCell).join(','));
    return out.join('\r\n') + '\r\n';
  }

  return {
    MEAL_ORDER: MEAL_ORDER, MIN_EVAL_RECORDS: MIN_EVAL_RECORDS,
    toCount: toCount, mealStats: mealStats, surplus: surplus, absError: absError, evalMetrics: evalMetrics,
    sumAvail: sumAvail, isDate: isDate, addDays: addDays, monthRange: monthRange, sortMeals: sortMeals,
    filterRows: filterRows, predictedVsActual: predictedVsActual, preparedVsServed: preparedVsServed,
    buildReport: buildReport, reportToCsv: reportToCsv, csvCell: csvCell
  };
});
