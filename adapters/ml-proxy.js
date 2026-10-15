/*
 * INTERIM ML adapter (Member 4) - dependency-free Node.
 *
 * Why it exists: Member 3's ML service is POST /predict, one meal per call, and it needs a secret
 * X-API-Key that must never reach the browser. The dashboard wants  GET /api/v1/forecasts?mess=&date=
 * (all meals). This adapter holds the key server-side, makes the per-meal calls and returns the
 * dashboard's shape. It is the job of Member 2's backend route (README step 4 of the ML service);
 * delete this file once that route exists - the field mapping is the same.
 *
 * It does NOT authenticate callers, so it binds to 127.0.0.1 by default: local demo/dev only.
 * It invents nothing: no generatedAt (the ML service sends none), no buffer, no fallback numbers.
 *
 * Run:  ML_SERVICE_URL=http://localhost:8000 ML_API_KEY=... node adapters/ml-proxy.js   (port 4100)
 *       then open  http://localhost:3000/?demo=1&mlproxy=1
 */
'use strict';
const http = require('http');

const MEALS = ['breakfast', 'lunch', 'dinner'];
const KEEP = ['mess_id', 'date', 'meal_type', 'predicted_meals', 'recommended_preparation', 'prediction_range', 'model_version', 'method', 'warnings'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
const clip = (s, n) => String(s).slice(0, n);

function createProxy(opts) {
  opts = opts || {};
  const cfg = {
    mlUrl: String(opts.mlUrl || 'http://localhost:8000').replace(/\/+$/, ''),
    apiKey: opts.apiKey || '',
    messIds: opts.messIds || { 'South Mess': 'south', 'North Mess': 'north' }, // ASSUMPTION until Member 2 fixes the ids
    allowedOrigin: opts.allowedOrigin || 'http://localhost:3000',
    timeoutMs: opts.timeoutMs || 5000,
    fetchImpl: opts.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  };

  /** One /predict call. Returns {ok:true, body} | {ok:false, soft, status, reason}. soft = a clear "no forecast possible" answer. */
  async function predict(messId, date, meal) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (cfg.apiKey) headers['X-API-Key'] = cfg.apiKey;
      const res = await cfg.fetchImpl(cfg.mlUrl + '/predict', { method: 'POST', headers, body: JSON.stringify({ mess_id: messId, date, meal_type: meal }), signal: ctl.signal });
      let body = null;
      try { body = JSON.parse(await res.text()); } catch (e) { /* not JSON */ }
      if (res.ok && body && typeof body === 'object') {
        const out = {};
        KEEP.forEach(k => { if (body[k] !== undefined) out[k] = body[k]; });
        return { ok: true, body: out };
      }
      if (res.status === 422 || res.status === 400) return { ok: false, soft: true, status: res.status, reason: clip(body && typeof body.detail === 'string' ? body.detail : 'The ML service cannot forecast this meal', 300) };
      if (res.status === 401 || res.status === 403) return { ok: false, soft: false, status: 502, reason: 'The ML service rejected the adapter credentials (check ML_API_KEY).' };
      return { ok: false, soft: false, status: 502, reason: 'The ML service returned an error (' + res.status + ').' };
    } catch (e) {
      return { ok: false, soft: false, status: 502, reason: 'The ML service could not be reached.' };
    } finally { clearTimeout(timer); }
  }

  async function forecasts(q) {
    const messId = cfg.messIds[q.mess] || String(q.mess || '').trim().toLowerCase();
    if (!messId) return { code: 400, body: { error: 'mess is required' } };
    if (q.from || q.to) return { code: 400, body: { error: 'date ranges are not supported; pass date=YYYY-MM-DD' } };
    if (!isDate(q.date)) return { code: 400, body: { error: 'date=YYYY-MM-DD is required' } };
    const meals = q.meal ? [String(q.meal).toLowerCase()] : MEALS;
    if (meals.some(m => !MEALS.includes(m))) return { code: 400, body: { error: 'unknown meal' } };
    const results = await Promise.all(meals.map(m => predict(messId, q.date, m)));
    const ok = [], unavailable = [];
    results.forEach((r, i) => { if (r.ok) ok.push(r.body); else unavailable.push({ meal_type: meals[i], reason: r.reason, hard: !r.soft }); });
    if (!ok.length && unavailable.every(u => u.hard)) return { code: 502, body: { error: unavailable[0].reason } };
    return { code: 200, body: { forecasts: ok, unavailable: unavailable.map(u => ({ meal_type: u.meal_type, reason: u.reason })) } };
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x'), origin = req.headers.origin;
    if (origin && origin === cfg.allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    }
    res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/api/v1/forecasts') { const r = await forecasts(Object.fromEntries(url.searchParams)); return send(r.code, r.body); }
    if (url.pathname === '/api/v1/forecasts/evaluations') return send(501, { error: 'Not available: forecast history lives in the backend database (forecasts + forecast_evaluations); the ML service only scores pairs it is sent.' });
    return send(404, { error: 'not found' });
  }

  return { server: http.createServer((req, res) => { handler(req, res).catch(() => { res.writeHead(500); res.end('{"error":"internal error"}'); }); }), config: cfg };
}

module.exports = { createProxy };

if (require.main === module) {
  let ids; try { ids = process.env.MESS_ID_MAP ? JSON.parse(process.env.MESS_ID_MAP) : undefined; } catch (e) { console.error('MESS_ID_MAP must be JSON'); process.exit(1); }
  const p = createProxy({ mlUrl: process.env.ML_SERVICE_URL, apiKey: process.env.ML_API_KEY, messIds: ids, allowedOrigin: process.env.ALLOWED_ORIGIN });
  const port = process.env.PROXY_PORT || 4100;
  p.server.listen(port, '127.0.0.1', () => console.log(`ML adapter on http://127.0.0.1:${port} -> ${p.config.mlUrl} (interim; no caller auth; key stays server-side)`));
}
