/*
 * Smart Mess - Mess Manager dashboard UI (Member 4).
 *
 * install(ctx) replaces the Mess Chief "Dashboard", "Meal Demand Prediction" and "Reports"
 * pages of index.html. All data comes from web/api.js (real backend / ML service). A failed
 * request becomes an error or "stale" state - it is never replaced with sample numbers.
 *
 * Pure helpers (applyResult, aggregate, ...) are exported for unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'), require('./api.js'), require('./charts.js'));
  else root.SmartMessDashboard = factory(root.SmartMessCalc, root.SmartMessApi, root.SmartMessCharts);
})(typeof self !== 'undefined' ? self : this, function (calc, Api, charts) {
  'use strict';

  // Meal periods offered in filters. The dashboard itself shows whatever periods the backend returns.
  var FILTER_MEALS = ['Breakfast', 'Lunch', 'Dinner'];
  var MAX_RANGE_DAYS = 92;

  /* ---------------- formatting ---------------- */

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
  function unav(text) { return '<span class="unav">' + esc(text || 'Unavailable') + '</span>'; }
  function val(n) { return n === null || n === undefined ? unav() : esc(num(n)); }
  function pct(n) { return n === null || n === undefined ? unav() : esc(n.toFixed(1)) + '%'; }
  function tag(c, t) { return '<span class="tag t-' + c + '">' + esc(t) + '</span>'; }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function fmtDT(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d) ? esc(s) : esc(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  }
  var BADGE = {
    actual: ['ok', 'Actual'], backend: ['n', 'Backend figure'], calc: ['n', 'Calculated'],
    estimate: ['wn', 'Estimate'], model: ['n', 'Model prediction']
  };
  function badge(kind) { return tag(BADGE[kind][0], BADGE[kind][1]); }
  function table(head, rows, numCols) {
    numCols = numCols || [];
    if (!rows.length) return '';
    return '<div class="tw"><table class="rs"><thead><tr>' + head.map(function (h, i) { return '<th' + (numCols.indexOf(i) >= 0 ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td data-l="' + esc(head[i]) + '"' + (numCols.indexOf(i) >= 0 ? ' class="num mono-num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div>';
  }

  /* ---------------- section state (pure, tested) ---------------- */

  function newSection() { return { status: 'loading', data: null, error: null, fetchedAt: null, synthetic: false, stale: false, busy: false }; }
  function resetSection(sec) { sec.status = 'loading'; sec.data = null; sec.error = null; sec.fetchedAt = null; sec.synthetic = false; sec.stale = false; }

  /**
   * Fold an API result into a section.
   *  success            -> status ok|empty, fresh data
   *  failure, had data  -> keep the old data but flag it stale (never shown as live)
   *  failure, no data   -> status error
   */
  function applyResult(sec, r, isEmpty) {
    if (r.ok) {
      sec.data = r.data; sec.error = null; sec.stale = false; sec.fetchedAt = r.fetchedAt; sec.synthetic = !!r.synthetic;
      sec.status = isEmpty(r.data) ? 'empty' : 'ok';
    } else {
      sec.error = r.error;
      if (sec.data !== null) { sec.stale = true; sec.status = isEmpty(sec.data) ? 'empty' : 'ok'; }
      else sec.status = 'error';
    }
    return sec;
  }

  /** Per-meal stats plus totals for the overview cards. Totals are null (not 0) when nothing is available. */
  function aggregate(meals) {
    var stats = (meals || []).map(function (m) { return { meal: m, st: calc.mealStats(m.expected, m.served), sp: calc.surplus(m.prepared, m.served) }; });
    return {
      stats: stats,
      expected: calc.sumAvail(stats.map(function (s) { return s.meal.expected; })),
      served: calc.sumAvail(stats.map(function (s) { return s.meal.served; })),
      remaining: calc.sumAvail(stats.map(function (s) { return s.st.remaining; })),
      surplus: calc.sumAvail(stats.map(function (s) { return s.sp.surplus; })),
      overServed: stats.filter(function (s) { return s.st.overServed; })
    };
  }

  /** Sum of forecast predictions that are valid; invalid ones are counted, not summed. */
  function forecastTotal(list) {
    var a = calc.sumAvail((list || []).map(function (f) { return f.predictedCount; }));
    return { sum: a.sum, n: a.n, missing: a.missing };
  }

  function typeLabel(t) { return String(t || 'unknown').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }

  /* ---------------- shared render pieces ---------------- */

  function banner(kind, html, retryKey) {
    return '<div class="banner ' + kind + '" role="' + (kind === 'er' ? 'alert' : 'status') + '"><span>' + html + '</span>' +
      (retryKey ? '<button class="btn o" data-act="retry" data-key="' + retryKey + '">Retry</button>' : '') + '</div>';
  }

  /** Wrap a section body with its loading / error / empty / stale handling. */
  function box(title, sec, key, o, bodyFn) {
    var h = '<div class="card mt"><div class="sm-h"><h2>' + esc(title) + '</h2><span>' + (o.badges || '') + '</span></div>';
    if (o.intro) h += '<p class="mut" style="margin-bottom:8px">' + o.intro + '</p>';
    if (sec.status === 'loading') h += '<p class="mut" role="status">Loading…</p>';
    else if (sec.status === 'error') h += banner('er', esc(sec.error.message), key);
    else {
      if (sec.stale) h += banner('wn', '<b>Stale data</b> - last updated ' + esc(fmtTime(sec.fetchedAt)) + '. The latest refresh failed: ' + esc(sec.error.message), key);
      h += sec.status === 'empty' ? '<p class="mut">' + esc(o.empty || 'Nothing to show.') + '</p>' : bodyFn();
    }
    return h + '</div>';
  }

  function synthBanner(secs) {
    var any = Object.keys(secs).some(function (k) { return secs[k].synthetic; });
    return any ? '<div class="syn" role="status">SYNTHETIC DATA - these figures come from a synthetic data source (demo or test), not from real mess records.</div>' : '';
  }

  /* ---------------- DASHBOARD ---------------- */

  function kpi(label, kind, total, unit, extra) {
    var body, note = '';
    if (total === 'loading') body = '<span class="unav" role="status">Loading…</span>';
    else if (total === null || total.sum === null) body = unav();
    else {
      body = '<div class="big mono-num">' + esc(num(total.sum)) + (unit ? ' <span class="mut">' + esc(unit) + '</span>' : '') + '</div>';
      if (total.missing > 0) note = '<div class="note">Partial: ' + total.n + ' of ' + (total.n + total.missing) + ' meals reporting</div>';
    }
    return '<div class="card kpi"><div class="lbl"><span>' + esc(label) + '</span>' + badge(kind) + '</div>' + body + note + (extra || '') + '</div>';
  }

  function mealCard(s) {
    var m = s.meal, st = s.st, over = st.overServed;
    var tagHtml = st.state === 'unavailable' ? tag('n', 'Unavailable') : over ? tag('wn', 'Over expected') : st.state === 'partial' ? tag('wn', 'Partial data') : tag('ok', 'Actual');
    var pctShown = st.progressPct === null ? null : Math.min(100, st.progressPct);
    var h = '<div class="card meal"><div class="sm-h"><b>' + esc(m.mealType) + '</b>' + tagHtml + '</div><dl>' +
      '<dt>Expected</dt><dd>' + val(st.expected) + '</dd><dt>Served</dt><dd>' + val(st.served) + '</dd><dt>Remaining</dt><dd>' + val(st.remaining) + '</dd></dl>';
    if (pctShown !== null) {
      h += '<div class="bar' + (over ? ' over' : '') + '" role="progressbar" aria-label="' + esc(m.mealType) + ' service progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pctShown) + '"><i style="width:' + pctShown.toFixed(1) + '%"></i></div>' +
        '<div class="mut">Service progress: ' + esc(st.progressPct.toFixed(0)) + '%</div>';
    } else h += '<div class="mut" style="margin-top:8px">Service progress unavailable</div>';
    if (over) h += '<div class="note" style="color:var(--wtx);font-size:13px;margin-top:4px">Warning: served is ' + esc(num(st.overBy)) + ' above expected. Values are shown as received.</div>';
    return h + '</div>';
  }

  function preparedRows(stats) {
    return stats.map(function (s) {
      var sp = s.sp;
      var note = sp.shortfall ? '<div class="mut">Served exceeds prepared by ' + esc(num(sp.shortBy)) + '</div>' : '';
      return [esc(s.meal.mealType), val(sp.prepared), val(sp.served), val(sp.surplus) + note, sp.prepared === 0 ? unav('n/a (0 prepared)') : pct(sp.surplusPct)];
    });
  }

  function forecastCard(f) {
    var main = f.invalidPredicted ? '<div class="unav">Invalid value from ML service</div>' : f.predictedCount === null ? '<div class="unav">No prediction</div>' : '<div class="big mono-num">' + esc(num(f.predictedCount)) + '</div>';
    var rows = [
      ['Prediction range', f.range ? esc(num(f.range.low)) + ' - ' + esc(num(f.range.high)) : unav('Not provided')],
      ['Model version', f.modelVersion ? esc(f.modelVersion) : unav('Not provided')],
      ['Generated', f.generatedAt ? fmtDT(f.generatedAt) : unav('Not provided')],
      ['Recommended preparation', f.recommendedPrep !== null ? esc(num(f.recommendedPrep)) : unav('Not provided by ML service')]
    ];
    if (f.method) rows.splice(2, 0, ['Method', esc(f.method)]);
    return '<div class="card meal"><div class="sm-h"><b>' + esc(f.mealType) + '</b>' + badge('model') + '</div>' + main +
      '<dl class="stack" style="margin-top:8px">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
      (f.warnings.length ? '<ul class="fc-warn">' + f.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }

  function forecastGrid(data) {
    var list = data.forecasts, have = {}, why = {};
    list.forEach(function (f) { have[f.mealType] = true; });
    (data.unavailable || []).forEach(function (u) { why[u.mealType] = u.reason; });
    var cards = list.map(forecastCard);
    FILTER_MEALS.forEach(function (m) { if (!have[m]) cards.push('<div class="card meal"><div class="sm-h"><b>' + esc(m) + '</b>' + tag('n', 'No forecast') + '</div>' + unav(why[m] || 'No forecast returned') + '</div>'); });
    return '<div class="grid">' + cards.join('') + '</div>';
  }

  function exceptionsTable(list) {
    var counts = {};
    list.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
    var chips = Object.keys(counts).sort().map(function (t) { return tag('n', typeLabel(t) + ': ' + counts[t]); }).join(' ');
    var rows = list.slice(0, 50).map(function (e) {
      return [e.timestamp ? fmtDT(e.timestamp) : unav('-'), esc(typeLabel(e.type)), e.description ? esc(e.description) : unav('-'), e.subjectRef ? esc(e.subjectRef) : unav('-'), e.status ? tag(e.status === 'resolved' ? 'ok' : 'wn', e.status) : unav('-')];
    });
    return '<p style="margin-bottom:8px">' + chips + '</p>' + table(['Time', 'Type', 'Description', 'Reference', 'Status'], rows) +
      (list.length > 50 ? '<p class="mut">Showing the first 50 of ' + list.length + '.</p>' : '');
  }

  function freshness(c) {
    var sm = c.secs.summary, age = sm.fetchedAt ? Date.now() - sm.fetchedAt : null;
    if (sm.status === 'loading') return banner('n', 'Loading live counts…');
    if (sm.status === 'error') return banner('er', '<b>Live counts unavailable.</b> ' + esc(sm.error.message), 'summary');
    if (sm.stale) return banner('wn', '<b>STALE - not live.</b> Last successful update ' + esc(fmtTime(sm.fetchedAt)) + '. Latest refresh failed: ' + esc(sm.error.message), 'summary');
    var live = age !== null && age < c.refreshMs * 2.5;
    return banner(live ? 'ok' : 'wn', (live ? '<b>LIVE</b>' : '<b>NOT LIVE</b>') + ' - last updated ' + esc(fmtTime(sm.fetchedAt)) + (sm.busy ? ' (refreshing…)' : '') + ' · auto-refresh every ' + Math.round(c.refreshMs / 1000) + 's' +
      (sm.data && sm.data.generatedAt ? ' · server time ' + fmtDT(sm.data.generatedAt) : ''), null).replace('</div>', '<button class="btn o" data-act="refresh">Refresh now</button></div>');
  }

  function renderDash(c) {
    var s = c.secs, sm = s.summary, fc = s.forecast, ex = s.exceptions, tomorrow = c.tomorrow;
    var agg = sm.data ? aggregate(sm.data.meals) : null, h = synthBanner(s) + freshness(c);
    var haveMeals = agg && agg.stats.length > 0;
    var ftot = fc.data ? forecastTotal(fc.data.forecasts) : fc.status === 'loading' ? 'loading' : null;
    var L = sm.status === 'loading' ? 'loading' : null;
    h += '<div class="grid">' +
      kpi('Expected meals', 'backend', haveMeals ? agg.expected : L) +
      kpi('Meals served', 'actual', haveMeals ? agg.served : L) +
      kpi('Meals remaining', 'calc', haveMeals ? agg.remaining : L) +
      kpi('Estimated surplus', 'estimate', haveMeals ? agg.surplus : L, '', '<div class="mut" style="font-size:12px">Prepared − served. Not measured food waste.</div>') +
      kpi('Tomorrow predicted (' + tomorrow + ')', 'model', ftot) +
      '<div class="card kpi"><div class="lbl"><span>Exceptions today</span>' + badge('actual') + '</div>' +
      (sm.data && sm.data.exceptionCount !== null ? '<div class="big mono-num">' + esc(num(sm.data.exceptionCount)) + '</div>' : L ? '<span class="unav" role="status">Loading…</span>' : unav()) + '</div></div>';

    h += box('Live meal counts - today', sm, 'summary', { badges: badge('actual'), empty: 'The backend returned no meal periods for today.', intro: 'Expected and served come from the backend. Remaining = max(expected − served, 0).' }, function () {
      return '<div class="grid">' + agg.stats.map(mealCard).join('') + '</div>' +
        (agg.overServed.length ? banner('wn', '<b>' + agg.overServed.length + ' meal period(s) served more than expected.</b> Check the expected-meal rule with the backend team.') : '');
    });

    h += box('Prepared vs served - today', sm, 'summary', { badges: badge('estimate'), empty: 'No meal periods to compare.', intro: 'Estimated surplus = max(prepared − served, 0) in meals. It is an estimate from counts, <b>not a measurement of physical food waste</b>. While a meal is still being served the surplus is overstated.' }, function () {
      return table(['Meal', 'Prepared', 'Served', 'Estimated surplus', 'Surplus %'], preparedRows(agg.stats), [1, 2, 3, 4]);
    });

    h += box('Tomorrow\'s forecast - ' + tomorrow, fc, 'forecast', { badges: badge('model'), empty: 'The ML service returned no forecast for ' + tomorrow + '.', intro: 'Aggregate meals per meal period from the ML service. No safety buffer is applied unless the service returns a recommended preparation.' }, function () {
      return forecastGrid(fc.data);
    });

    h += box('Exceptions - last 7 days', ex, 'exceptions', { badges: badge('actual'), empty: 'No exceptions were recorded in the last 7 days.', intro: 'Operational events recorded by the backend. Student identities are shown only as anonymised references.' }, function () {
      return exceptionsTable(ex.data.exceptions);
    });

    if (c.localExtras) h += c.localExtras();
    c.el.innerHTML = h;
  }

  /* ---------------- controller helpers ---------------- */

  function loadSection(c, key, call, isEmpty) {
    var sec = c.secs[key];
    if (sec.busy) return Promise.resolve();
    sec.busy = true;
    return call().then(function (r) {
      if (r && r.superseded) return; // a newer request owns this section now
      sec.busy = false;
      applyResult(sec, r, isEmpty);
      if (c.el.isConnected) c.render(c);
    }, function () {
      sec.busy = false;
      applyResult(sec, { ok: false, error: { kind: 'network', message: 'Unexpected error while loading.' } }, isEmpty);
      if (c.el.isConnected) c.render(c);
    });
  }

  var EMPTY = {
    summary: function (d) { return d.meals.length === 0; },
    forecasts: function (d) { return d.forecasts.length === 0 && d.unavailable.length === 0; },
    exceptions: function (d) { return d.exceptions.length === 0; },
    evaluations: function (d) { return d.records.length === 0; },
    report: function (d) { return d.rows.length === 0; }
  };

  function dateRangeError(from, to) {
    if (!calc.isDate(from) || !calc.isDate(to)) return 'Choose a valid start and end date.';
    if (from > to) return 'The start date must not be after the end date.';
    if (calc.addDays(from, MAX_RANGE_DAYS) < to) return 'Please choose a range of at most ' + MAX_RANGE_DAYS + ' days.';
    return null;
  }

  /* ---------------- install ---------------- */

  function install(ctx) {
    var cfg = ctx.config || {};
    var client = ctx.client || Api.createClient({ apiBase: cfg.apiBase, forecastBase: cfg.forecastBase, messIds: cfg.messIds, timeoutMs: cfg.timeoutMs });
    var refreshMs = Math.max(5000, cfg.refreshMs || 30000);
    var doc = ctx.document || document;

    function head(title, mess) {
      return '<h1>' + esc(title) + '</h1><p class="mut">' + esc(mess) + ' · Today ' + esc(ctx.today()) + ' · Signed in as ' + esc(ctx.uid() || 'demo') + ' · Data source: ' + esc(cfg.apiBase || 'same origin') + '</p>';
    }

    function bind(c) {
      c.el.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-act]') : null;
        if (b && c.onAct) c.onAct(b.getAttribute('data-act'), b.getAttribute('data-key'), b);
      });
      c.el.addEventListener('change', function (e) { if (c.onChange) c.onChange(e.target); });
    }

    /* ----- Dashboard ----- */
    ctx.P.chief.dash = function () {
      return head('Mess Dashboard', ctx.mess()) + '<div id="sm-dash"></div>';
    };
    ctx.A.dash = function () {
      var el = doc.getElementById('sm-dash');
      if (!el) return;
      var mess = ctx.mess(), today = ctx.today(), tomorrow = calc.addDays(today, 1);
      var c = { el: el, render: renderDash, refreshMs: refreshMs, tomorrow: tomorrow, localExtras: ctx.localExtras,
        secs: { summary: newSection(), forecast: newSection(), exceptions: newSection() } };
      var loaders = {
        summary: function () { return loadSection(c, 'summary', function () { return client.getSummary({ mess: mess, date: today }); }, EMPTY.summary); },
        forecast: function () { return loadSection(c, 'forecast', function () { return client.getForecasts({ mess: mess, date: tomorrow }); }, EMPTY.forecasts); },
        exceptions: function () { return loadSection(c, 'exceptions', function () { return client.getExceptions({ mess: mess, from: calc.addDays(today, -6), to: today }); }, EMPTY.exceptions); }
      };
      c.onAct = function (act, key) {
        if (act === 'retry' && loaders[key]) loaders[key]();
        if (act === 'refresh') { loaders.summary(); loaders.exceptions(); loaders.forecast(); c.render(c); }
      };
      bind(c);
      c.render(c);
      loaders.summary(); loaders.forecast(); loaders.exceptions();
      // Auto-refresh live counts and exceptions only; the forecast changes rarely (manual refresh).
      var timer = setInterval(function () {
        if (!el.isConnected) { clearInterval(timer); return; }
        if (doc.hidden) return;
        loaders.summary(); loaders.exceptions();
      }, refreshMs);
      doc.addEventListener('visibilitychange', function onVis() {
        if (!el.isConnected) { doc.removeEventListener('visibilitychange', onVis); return; }
        if (!doc.hidden) { loaders.summary(); loaders.exceptions(); } c.render(c);
      });
      c.timer = timer;
    };

    /* ----- Meal Demand Prediction ----- */
    function renderPred(c) {
      var s = c.secs, h = synthBanner(s), f = c.f, err = dateRangeError(f.from, f.to);
      h += box('Tomorrow\'s forecast - ' + c.tomorrow, s.forecast, 'forecast', { badges: badge('model'), empty: 'The ML service returned no forecast for ' + c.tomorrow + '.', intro: 'Prediction ranges, model versions and preparation advice are shown only when the ML service provides them.' }, function () { return forecastGrid(s.forecast.data); });
      h += '<div class="card mt"><div class="sm-h"><h2>Predicted vs actual</h2><span>' + badge('model') + ' ' + badge('actual') + '</span></div>' +
        '<div class="filters"><div><label for="pf">From</label><input type="date" id="pf" data-f="from" value="' + esc(f.from) + '"></div><div><label for="pt">To</label><input type="date" id="pt" data-f="to" value="' + esc(f.to) + '"></div>' +
        '<div><label for="pm">Meal period</label><select id="pm" data-f="meal"><option value="all">All meals</option>' + FILTER_MEALS.map(function (m) { return '<option' + (f.meal === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div></div>' +
        '<p class="err" role="alert">' + esc(err || '') + '</p><div id="sm-pred-out">';
      if (!err) {
        var sec = s.evaluations;
        h += (function () {
          if (sec.status === 'loading') return '<p class="mut" role="status">Loading…</p>';
          if (sec.status === 'error') return banner('er', esc(sec.error.message), 'evaluations');
          var out = sec.stale ? banner('wn', '<b>Stale data</b> - last updated ' + esc(fmtTime(sec.fetchedAt)) + '. The latest refresh failed: ' + esc(sec.error.message), 'evaluations') : '';
          if (sec.status === 'empty') return out + '<p class="mut">No evaluated forecasts exist for this mess, period and meal.</p>';
          var recs = calc.filterRows(sec.data.records, { from: f.from, to: f.to, meal: f.meal });
          var pv = calc.predictedVsActual(recs, 'all'), m = calc.evalMetrics(recs);
          if (!pv.points.length) return out + '<p class="mut">No records with both a prediction and an actual count in this selection.</p>';
          out += '<div class="grid"><div class="card"><div class="mut">MAE (per meal)</div>' + (m.sufficient ? '<div class="big mono-num">' + esc(m.mae.toFixed(1)) + '</div><div class="mut">over ' + m.n + ' evaluated forecasts</div>' : unav('Not enough data') + '<div class="mut">' + m.n + ' of ' + m.minRequired + ' evaluated forecasts needed</div>') + '</div>' +
            '<div class="card"><div class="mut">RMSE (per meal)</div>' + (m.sufficient ? '<div class="big mono-num">' + esc(m.rmse.toFixed(1)) + '</div>' : unav('Not enough data')) + '</div></div>';
          out += '<div style="margin-top:12px">' + charts.lineChart({
            aria: 'Predicted versus actual meals per day', series: [{ key: 'predicted', label: 'Predicted', cls: 's1' }, { key: 'actual', label: 'Actual served', cls: 's2 dsh' }],
            points: pv.points.map(function (p) { return { label: p.date.slice(5), values: { predicted: p.predicted, actual: p.actual } }; })
          }) + '</div>';
          out += '<p class="mut">' + (f.meal === 'all' ? 'Each point sums the meal periods that have both values. ' : '') + (pv.skipped ? esc(pv.skipped) + ' record(s) skipped (missing prediction or actual). ' : '') + 'Model version(s): ' + esc(versions(sec.data.records) || 'not provided') + '.</p>';
          out += table(['Date', 'Predicted', 'Actual', 'Absolute error'], pv.points.map(function (p) { return [esc(p.date), val(p.predicted), val(p.actual), val(p.absError)]; }), [1, 2, 3]);
          return out;
        })();
      }
      c.el.innerHTML = h + '</div></div>';
    }
    function versions(recs) {
      var seen = {};
      recs.forEach(function (r) { if (r.modelVersion) seen[r.modelVersion] = true; });
      return Object.keys(seen).join(', ');
    }

    ctx.P.chief.pred = function () { return head('Meal Demand Prediction', ctx.mess()) + '<div id="sm-pred"></div>'; };
    ctx.A.pred = function () {
      var el = doc.getElementById('sm-pred');
      if (!el) return;
      var mess = ctx.mess(), today = ctx.today(), tomorrow = calc.addDays(today, 1);
      var c = { el: el, render: renderPred, tomorrow: tomorrow, f: { from: calc.addDays(today, -14), to: calc.addDays(today, -1), meal: 'all' }, seq: 0,
        secs: { forecast: newSection(), evaluations: newSection() } };
      function loadEval() {
        var f = c.f;
        if (dateRangeError(f.from, f.to)) return;
        var my = ++c.seq, sec = c.secs.evaluations;
        sec.busy = false;
        loadSection(c, 'evaluations', function () {
          return client.getEvaluations({ mess: mess, from: f.from, to: f.to, meal: f.meal }).then(function (r) { return my === c.seq ? r : { ok: false, error: { kind: 'stale', message: 'Superseded by a newer request.' }, superseded: true }; });
        }, EMPTY.evaluations);
      }
      c.onAct = function (act, key) {
        if (act === 'retry' && key === 'forecast') loadSection(c, 'forecast', function () { return client.getForecasts({ mess: mess, date: tomorrow }); }, EMPTY.forecasts);
        if (act === 'retry' && key === 'evaluations') loadEval();
      };
      c.onChange = function (t) {
        var k = t.getAttribute && t.getAttribute('data-f');
        if (!k) return;
        c.f[k] = t.value;
        resetSection(c.secs.evaluations);
        c.render(c);
        loadEval();
      };
      bind(c);
      c.render(c);
      loadSection(c, 'forecast', function () { return client.getForecasts({ mess: mess, date: tomorrow }); }, EMPTY.forecasts);
      loadEval();
    };

    /* ----- Reports ----- */
    function reportRange(f) {
      if (f.mode === 'monthly') return calc.monthRange(f.month);
      return calc.isDate(f.date) ? { from: f.date, to: f.date } : null;
    }
    function reportFilename(mess, r) { return 'smart-mess-report_' + String(mess).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + r.from + '_' + r.to + '.csv'; }

    function renderRep(c) {
      var s = c.secs, f = c.f, range = reportRange(f), h = synthBanner(s);
      h += '<div class="card"><div class="filters"><div><label for="rm">Report type</label><select id="rm" data-f="mode"><option value="daily"' + (f.mode === 'daily' ? ' selected' : '') + '>Daily</option><option value="monthly"' + (f.mode === 'monthly' ? ' selected' : '') + '>Monthly</option></select></div>' +
        (f.mode === 'daily' ? '<div><label for="rd">Date</label><input type="date" id="rd" data-f="date" value="' + esc(f.date) + '"></div>' : '<div><label for="rmo">Month</label><input type="month" id="rmo" data-f="month" value="' + esc(f.month) + '"></div>') + '</div>' +
        '<p class="err" role="alert">' + (range ? '' : 'Choose a valid ' + (f.mode === 'daily' ? 'date' : 'month') + '.') + '</p></div>';
      if (range) {
        var rp = s.report;
        h += box((f.mode === 'daily' ? 'Daily' : 'Monthly') + ' report - ' + range.from + (range.from === range.to ? '' : ' to ' + range.to), rp, 'report', { badges: badge('actual'), empty: 'The backend has no report rows for this period.', intro: 'Remaining = max(expected − served, 0). Surplus = max(prepared − served, 0) is an <b>estimate</b>, not measured food waste. Empty cells mean the backend did not provide a value. Forecast error is not computed for today, because today\'s meals are still being served.' }, function () {
          var rows = calc.filterRows(rp.data.rows, { from: range.from, to: range.to });
          var rep = calc.buildReport(rows, { inProgressFrom: c.today }), t = rep.totals;
          var m = calc.evalMetrics(rows.filter(function (r) { return r.date < c.today; }).map(function (r) { return { predictedCount: r.predictedCount, actualCount: r.served }; }));
          var out = '<div class="row" style="margin-bottom:8px"><button class="btn" data-act="csv"' + (rep.lines.length ? '' : ' disabled') + '>Download CSV</button></div>';
          out += table(['Date', 'Meal', 'Expected', 'Served', 'Remaining', 'Prepared', 'Est. surplus', 'Surplus %', 'Predicted', 'Abs. error'],
            rep.lines.map(function (l) { return [esc(l.date), esc(l.mealType), val(l.expected), val(l.served) + (l.overServed ? ' ' + tag('wn', 'over') : ''), val(l.remaining), val(l.prepared), val(l.surplus), pct(l.surplusPct), val(l.predicted), val(l.absError)]; }).concat([
              ['<b>Total</b>', '', val(t.expected.sum), val(t.served.sum), '', val(t.prepared.sum), val(t.surplus.sum), pct(t.surplusPct), '', '']
            ]), [2, 3, 4, 5, 6, 7, 8, 9]);
          out += '<p class="mut">Totals add only the values that exist; surplus totals use meal periods with both prepared and served (' + t.surplusRows + ' of ' + rep.lines.length + ').</p>';
          out += '<div class="grid" style="margin-top:8px"><div class="card"><div class="mut">Forecast MAE (per meal)</div>' + (m.sufficient ? '<div class="big mono-num">' + esc(m.mae.toFixed(1)) + '</div><div class="mut">over ' + m.n + ' forecasts · RMSE ' + esc(m.rmse.toFixed(1)) + '</div>' : unav('Not enough data') + '<div class="mut">' + m.n + ' of ' + m.minRequired + ' forecast/actual pairs needed</div>') + '</div></div>';
          var pv = calc.preparedVsServed(rows, 'all');
          if (pv.points.length > 1) out += '<h2 class="mt">Prepared vs served</h2>' + charts.barChart({ aria: 'Prepared versus served meals per day', series: [{ key: 'prepared', label: 'Prepared', cls: 's1' }, { key: 'served', label: 'Served', cls: 's2' }], points: pv.points.map(function (p) { return { label: p.date.slice(5), values: { prepared: p.prepared, served: p.served } }; }) }) + (pv.skipped ? '<p class="mut">' + pv.skipped + ' row(s) skipped (missing prepared or served).</p>' : '');
          return out;
        });
        h += box('Exceptions in this period', s.exceptions, 'exceptions', { badges: badge('actual'), empty: 'No exceptions were recorded in this period.' }, function () { return exceptionsTable(s.exceptions.data.exceptions); });
      }
      if (c.localExtras) h += c.localExtras();
      c.el.innerHTML = h;
    }

    ctx.P.chief.rep = function () { return head('Reports', ctx.mess()) + '<div id="sm-rep"></div>'; };
    ctx.A.rep = function () {
      var el = doc.getElementById('sm-rep');
      if (!el) return;
      var mess = ctx.mess(), today = ctx.today();
      var c = { el: el, today: today, render: renderRep, localExtras: ctx.localReportExtras, f: { mode: 'daily', date: today, month: today.slice(0, 7) }, seq: 0,
        secs: { report: newSection(), exceptions: newSection() } };
      function loadAll() {
        var range = reportRange(c.f);
        if (!range) return;
        var my = ++c.seq;
        var guard = function (p) { return p.then(function (r) { return my === c.seq ? r : { ok: false, superseded: true, error: { kind: 'stale', message: 'Superseded by a newer request.' } }; }); };
        c.secs.report.busy = false; c.secs.exceptions.busy = false;
        loadSection(c, 'report', function () { return guard(client.getReport({ mess: mess, from: range.from, to: range.to })); }, EMPTY.report);
        loadSection(c, 'exceptions', function () { return guard(client.getExceptions({ mess: mess, from: range.from, to: range.to })); }, EMPTY.exceptions);
      }
      c.onAct = function (act, key) {
        if (act === 'retry') loadAll();
        if (act === 'csv') {
          var range = reportRange(c.f), sec = c.secs.report;
          if (!range || !sec.data) return;
          var csv = calc.reportToCsv(calc.buildReport(calc.filterRows(sec.data.rows, range), { inProgressFrom: c.today }));
          var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), a = doc.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = reportFilename(mess, range); doc.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        }
      };
      c.onChange = function (t) {
        var k = t.getAttribute && t.getAttribute('data-f');
        if (!k) return;
        c.f[k] = t.value;
        resetSection(c.secs.report); resetSection(c.secs.exceptions);
        c.render(c);
        loadAll();
      };
      bind(c);
      c.render(c);
      loadAll();
    };
  }

  return {
    install: install, applyResult: applyResult, newSection: newSection, aggregate: aggregate, forecastTotal: forecastTotal,
    dateRangeError: dateRangeError, typeLabel: typeLabel, esc: esc
  };
});
