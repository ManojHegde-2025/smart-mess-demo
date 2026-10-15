/*
 * Smart Mess - API client for the manager dashboard (Member 4).
 *
 * Every network call from the manager UI goes through here. Rules:
 *  - A failed request returns {ok:false, error}. It is NEVER replaced by sample data.
 *  - Missing values stay null (see calc.toCount). Nothing is defaulted to 0.
 *  - Identical in-flight requests are shared, so refreshes cannot pile up.
 *  - Authentication: the manager signs in with the backend (POST /api/v1/auth/login). The Bearer
 *    token is kept in localStorage under sm_manager_token and sent on every request. 401/403 become kind:'auth'.
 *    The ML key is never stored here; forecasts go through the backend.
 *
 * Endpoints are the PROPOSED contract in docs/API_CONTRACT.md (Member 2 / Member 3 have
 * not delivered code yet). If the real paths differ, change ENDPOINTS below only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'));
  else root.SmartMessApi = factory(root.SmartMessCalc);
})(typeof self !== 'undefined' ? self : this, function (calc) {
  'use strict';

  var ENDPOINTS = {
    login: '/api/v1/auth/login',
    summary: '/api/v1/dashboard/summary',
    forecasts: '/api/v1/forecasts',
    evaluations: '/api/v1/forecasts/evaluations',
    exceptions: '/api/v1/exceptions',
    report: '/api/v1/reports/daily'
  };

  var TOKEN_KEY = 'sm_manager_token';
  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function getStoredToken() { var s = storage(); return s ? s.getItem(TOKEN_KEY) : null; }
  function setStoredToken(t) { var s = storage(); if (s) s.setItem(TOKEN_KEY, t); }
  function clearStoredToken() { var s = storage(); if (s) s.removeItem(TOKEN_KEY); }

  /* Real manager sign-in. Stores the token only for a manager account; rejects everyone else. */
  function managerLogin(baseUrl, rollNo, password, fetchImpl) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) return Promise.reject(new Error('fetch is not available in this browser.'));
    var url = String(baseUrl || '').replace(/\/+$/, '') + ENDPOINTS.login;
    return f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ roll_no: rollNo, password: password })
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (res.status === 401) throw new Error('Wrong ID or password.');
        if (!res.ok) throw new Error('Sign-in failed (server returned ' + res.status + ').');
        if (!body || typeof body.access_token !== 'string') throw new Error('Unexpected response from the server.');
        if (body.role !== 'manager') throw new Error('This account is not a mess manager. Use the student portal instead.');
        setStoredToken(body.access_token);
        return { role: body.role };
      });
    }, function () { throw new Error('Cannot reach the server. Is the backend running?'); });
  }

  function str(v) { return typeof v === 'string' && v.trim() ? v : null; }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function fail(kind, message, status) { return { ok: false, error: { kind: kind, message: message, status: status || null } }; }

  /* ---------- normalizers: validate shape, keep missing values as null ---------- */

  function normalizeSummary(raw) {
    if (!isObj(raw) || !Array.isArray(raw.meals)) return null;
    var meals = raw.meals.filter(isObj).filter(function (m) { return str(m.mealType); }).map(function (m) {
      return { mealType: m.mealType, expected: calc.toCount(m.expected), served: calc.toCount(m.served), prepared: calc.toCount(m.prepared) };
    }).sort(function (a, b) { return calc.sortMeals(a.mealType, b.mealType); });
    return {
      mess: str(raw.mess), date: str(raw.date), generatedAt: str(raw.generatedAt),
      exceptionCount: calc.toCount(raw.exceptionCount), meals: meals
    };
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); } // 'lunch' -> 'Lunch'
  function first(o) { for (var i = 1; i < arguments.length; i++) if (o[arguments[i]] !== undefined) return o[arguments[i]]; return undefined; }

  /*
   * Accepts both the dashboard contract (camelCase) and the ML service's native fields
   * (predicted_meals, prediction_range, recommended_preparation, model_version, meal_type, ...),
   * so a backend route may pass the ML response through unchanged.
   */
  function normalizeForecasts(raw) {
    if (!isObj(raw) || !Array.isArray(raw.forecasts)) return null;
    var list = raw.forecasts.filter(isObj).filter(function (f) { return str(first(f, 'mealType', 'meal_type')); }).map(function (f) {
      var rawPred = first(f, 'predictedCount', 'predicted_meals');
      var predicted = calc.toCount(rawPred);
      var rg = first(f, 'range', 'prediction_range');
      var lo = calc.toCount(rg && rg.low), hi = calc.toCount(rg && rg.high);
      var warnings = Array.isArray(f.warnings) ? f.warnings.filter(function (w) { return typeof w === 'string' && w.trim(); }).map(function (w) { return w.slice(0, 300); }) : [];
      var mess = first(f, 'messId', 'mess_id');
      return {
        messId: str(mess) || (typeof mess === 'number' ? String(mess) : null),
        targetDate: str(first(f, 'targetDate', 'date')), mealType: cap(str(first(f, 'mealType', 'meal_type'))),
        predictedCount: predicted,
        // present in the response but unusable (negative, text, ...): show an error, never a number
        invalidPredicted: predicted === null && rawPred !== null && rawPred !== undefined,
        range: lo !== null && hi !== null && lo <= hi ? { low: lo, high: hi } : null,
        modelVersion: str(first(f, 'modelVersion', 'model_version')), generatedAt: str(first(f, 'generatedAt', 'generated_at')),
        recommendedPrep: calc.toCount(first(f, 'recommendedPrep', 'recommended_preparation')),
        method: str(f.method), warnings: warnings,
        synthetic: warnings.some(function (w) { return /synthetic/i.test(w); })
      };
    }).sort(function (a, b) { return calc.sortMeals(a.mealType, b.mealType); });
    // meals for which the forecast source gave no forecast, with the reason (e.g. no history yet)
    var unavailable = (Array.isArray(raw.unavailable) ? raw.unavailable : []).filter(isObj).filter(function (u) { return str(first(u, 'mealType', 'meal_type')); }).map(function (u) {
      return { mealType: cap(str(first(u, 'mealType', 'meal_type'))), reason: (str(u.reason) || 'No forecast returned').slice(0, 300) };
    });
    return { forecasts: list, unavailable: unavailable };
  }

  function normalizeEvaluations(raw) {
    if (!isObj(raw) || !Array.isArray(raw.records)) return null;
    return {
      records: raw.records.filter(isObj).filter(function (r) { return calc.isDate(r.targetDate) && str(r.mealType); }).map(function (r) {
        return { targetDate: r.targetDate, mealType: r.mealType, predictedCount: calc.toCount(r.predictedCount), actualCount: calc.toCount(r.actualCount), modelVersion: str(r.modelVersion) };
      })
    };
  }

  function normalizeExceptions(raw) {
    if (!isObj(raw) || !Array.isArray(raw.exceptions)) return null;
    return {
      exceptions: raw.exceptions.filter(isObj).map(function (e, i) {
        return {
          id: str(e.id) || (typeof e.id === 'number' ? String(e.id) : 'row-' + i),
          timestamp: str(e.timestamp), type: str(e.type) || 'unknown', description: str(e.description),
          subjectRef: str(e.subjectRef), status: str(e.status)
        };
      })
    };
  }

  function normalizeReport(raw) {
    if (!isObj(raw) || !Array.isArray(raw.rows)) return null;
    return {
      rows: raw.rows.filter(isObj).filter(function (r) { return calc.isDate(r.date) && str(r.mealType); }).map(function (r) {
        return { date: r.date, mealType: r.mealType, expected: calc.toCount(r.expected), served: calc.toCount(r.served), prepared: calc.toCount(r.prepared), predictedCount: calc.toCount(r.predictedCount) };
      })
    };
  }

  /* ---------- client ---------- */

  function createClient(options) {
    var cfg = {
      apiBase: '', forecastBase: null, timeoutMs: 8000, credentials: 'same-origin', fetchImpl: null, messIds: {}
    };
    Object.keys(options || {}).forEach(function (k) { if (options[k] !== undefined) cfg[k] = options[k]; });
    var inflight = {};
    var stats = { requests: 0 };

    function messParam(name) { return name ? (cfg.messIds[name] || name) : null; }

    function buildUrl(base, path, params) {
      var q = [];
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v === null || v === undefined || v === '' || v === 'all') return;
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
      return String(base || '').replace(/\/+$/, '') + path + (q.length ? '?' + q.join('&') : '');
    }

    function doFetch(url) {
      var f = cfg.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (!f) return Promise.resolve(fail('network', 'fetch is not available in this environment'));
      stats.requests++;
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timedOut = false;
      var timer = ctl ? setTimeout(function () { timedOut = true; ctl.abort(); }, cfg.timeoutMs) : null;
      var headers = { Accept: 'application/json' };
      var token = getStoredToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      return f(url, { method: 'GET', headers: headers, credentials: cfg.credentials, signal: ctl ? ctl.signal : undefined })
        .then(function (res) {
          return res.text().then(function (text) {
            if (timer) clearTimeout(timer);
            var body = null, parsed = true;
            if (text) { try { body = JSON.parse(text); } catch (e) { parsed = false; } }
            if (res.status === 401) clearStoredToken();
            if (res.status === 401 || res.status === 403) {
              return fail('auth', res.status === 401 ? 'Not signed in to the backend (401).' : 'This account may not view manager data (403).', res.status);
            }
            if (!res.ok) {
              var m = isObj(body) ? (str(body.error) || str(body.message)) : null;
              return fail('http', 'Server returned ' + res.status + (m ? ': ' + m.slice(0, 200) : '.'), res.status);
            }
            if (!parsed || body === null) return fail('parse', 'The server response was not valid JSON.', res.status);
            return { ok: true, raw: body, fetchedAt: Date.now(), synthetic: isObj(body) && body.synthetic === true };
          });
        })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          return timedOut ? fail('timeout', 'The request timed out after ' + cfg.timeoutMs / 1000 + 's.') : fail('network', 'Could not reach the service. Is it running?');
        });
    }

    // Share one request per identical URL while it is in flight.
    function get(base, path, params, normalize) {
      var url = buildUrl(base, path, params);
      if (!inflight[url]) {
        inflight[url] = doFetch(url).then(function (r) {
          delete inflight[url];
          if (!r.ok) return r;
          var data = normalize(r.raw);
          if (data === null) return fail('shape', 'The server response did not match the expected format.');
          var synth = r.synthetic || (Array.isArray(data.forecasts) && data.forecasts.some(function (f) { return f.synthetic; }));
          return { ok: true, data: data, fetchedAt: r.fetchedAt, synthetic: synth };
        });
      }
      return inflight[url];
    }

    var forecastBase = function () { return cfg.forecastBase !== null && cfg.forecastBase !== undefined ? cfg.forecastBase : cfg.apiBase; };

    return {
      endpoints: ENDPOINTS,
      stats: stats,
      buildUrl: buildUrl,
      getSummary: function (p) { return get(cfg.apiBase, ENDPOINTS.summary, { mess: messParam(p.mess), date: p.date }, normalizeSummary); },
      getForecasts: function (p) { return get(forecastBase(), ENDPOINTS.forecasts, { mess: messParam(p.mess), date: p.date, from: p.from, to: p.to, meal: p.meal }, normalizeForecasts); },
      getEvaluations: function (p) { return get(forecastBase(), ENDPOINTS.evaluations, { mess: messParam(p.mess), from: p.from, to: p.to, meal: p.meal }, normalizeEvaluations); },
      getExceptions: function (p) { return get(cfg.apiBase, ENDPOINTS.exceptions, { mess: messParam(p.mess), from: p.from, to: p.to }, normalizeExceptions); },
      getReport: function (p) { return get(cfg.apiBase, ENDPOINTS.report, { mess: messParam(p.mess), from: p.from, to: p.to }, normalizeReport); }
    };
  }

  return {
    createClient: createClient, ENDPOINTS: ENDPOINTS,
    auth: { login: managerLogin, hasToken: function () { return !!getStoredToken(); }, signOut: clearStoredToken },
    normalizeSummary: normalizeSummary, normalizeForecasts: normalizeForecasts, normalizeEvaluations: normalizeEvaluations,
    normalizeExceptions: normalizeExceptions, normalizeReport: normalizeReport
  };
});
