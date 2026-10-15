/*
 * SYNTHETIC MOCK API - for demos and automated tests only.
 *
 * This is NOT the Smart Mess backend (Member 2) and NOT the ML service (Member 3).
 * It implements the proposed contract in docs/API_CONTRACT.md with deterministic,
 * invented numbers. Every JSON response contains "synthetic": true, which makes the
 * dashboard show a SYNTHETIC DATA badge. The dashboard never uses this server unless
 * API_BASE_URL points at it.
 *
 * Run:   node mock/mock-api.js            (port 4000)
 * Switch behaviour at runtime (for demos of error states):
 *   curl -X POST localhost:4000/__mock/scenario -d '{"name":"fail-forecast"}'
 * Scenarios: normal | over | missing | empty | fail-summary | fail-forecast | auth
 */
'use strict';
const http = require('http');

const MEALS = ['Breakfast', 'Lunch', 'Dinner'];
const WINDOW = { Breakfast: [450, 525], Lunch: [720, 825], Dinner: [1170, 1245] }; // minutes from midnight
const BASE = { 'South Mess': { Breakfast: 540, Lunch: 720, Dinner: 650 }, 'North Mess': { Breakfast: 480, Lunch: 690, Dinner: 610 } };
const SCENARIOS = ['normal', 'over', 'missing', 'empty', 'fail-summary', 'fail-forecast', 'auth'];

function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function unit(str) { return (hash(str) % 10000) / 10000; } // deterministic 0..1
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); const t = new Date(y, m - 1, d + n); return ymd(t); }
function dow(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function baseFor(mess, meal) { return (BASE[mess] || BASE['South Mess'])[meal]; }
function expectedFor(mess, meal, date) { const f = dow(date) === 0 ? 0.88 : 1; return Math.round(baseFor(mess, meal) * f); }
function actualFull(mess, meal, date) { return Math.round(expectedFor(mess, meal, date) * (0.93 + unit(`a|${mess}|${meal}|${date}`) * 0.09)); }
function predictedFor(mess, meal, date) { return Math.round(actualFull(mess, meal, date) * (0.95 + unit(`p|${mess}|${meal}|${date}`) * 0.11)); }
function forecastFuture(mess, meal, date) { return Math.round(expectedFor(mess, meal, date) * (0.96 + unit(`f|${mess}|${meal}|${date}`) * 0.06)); }

function createMock(opts) {
  const clock = (opts && opts.now) || (() => new Date());
  const allowedOrigin = (opts && opts.allowedOrigin) || process.env.MOCK_ALLOWED_ORIGIN || 'http://localhost:3000';
  let scenario = (opts && opts.scenario) || process.env.MOCK_SCENARIO || 'normal';
  const hits = [];

  function nowInfo() { const n = clock(); return { date: ymd(n), minutes: n.getHours() * 60 + n.getMinutes(), iso: n.toISOString() }; }

  function servedFor(mess, meal, date, now) {
    if (date > now.date) return null;
    const full = actualFull(mess, meal, date);
    if (date < now.date) return full;
    const [s, e] = WINDOW[meal];
    const f = Math.max(0, Math.min(1, (now.minutes - s) / (e - s)));
    return Math.round(full * f);
  }

  function summary(q, now) {
    const mess = q.mess || 'South Mess', date = q.date || now.date;
    let meals = MEALS.map(meal => ({
      mealType: meal, expected: expectedFor(mess, meal, date),
      served: servedFor(mess, meal, date, now),
      prepared: Math.round(predictedFor(mess, meal, date) * 1.02)
    }));
    if (scenario === 'over') meals = meals.map(m => m.mealType === 'Lunch' ? { ...m, served: m.expected + 17 } : m);
    if (scenario === 'missing') meals = meals.map(m => m.mealType === 'Lunch' ? { ...m, served: null } : m.mealType === 'Dinner' ? { ...m, expected: null } : { ...m, prepared: null });
    if (scenario === 'empty') meals = [];
    return { synthetic: true, mess, date, generatedAt: now.iso, exceptionCount: scenario === 'empty' ? 0 : exceptionsFor(mess, date, now).length, meals };
  }

  function forecasts(q, now) {
    const mess = q.mess || 'South Mess';
    const dates = [];
    if (q.date) dates.push(q.date);
    else if (q.from && q.to) { for (let d = q.from, i = 0; d <= q.to && i < 93; d = addDays(d, 1), i++) dates.push(d); }
    else dates.push(addDays(now.date, 1));
    const out = [];
    dates.forEach(date => MEALS.forEach(meal => {
      if (q.meal && q.meal !== meal) return;
      const p = date > now.date ? forecastFuture(mess, meal, date) : predictedFor(mess, meal, date);
      out.push({ messId: mess, targetDate: date, mealType: meal, predictedCount: p, range: { low: Math.round(p * 0.97), high: Math.round(p * 1.03) }, modelVersion: 'mock-synthetic-v0', generatedAt: now.iso });
    }));
    return { synthetic: true, forecasts: scenario === 'empty' ? [] : out };
  }

  function evaluations(q, now) {
    const mess = q.mess || 'South Mess', to = q.to && q.to < now.date ? q.to : addDays(now.date, -1), from = q.from || addDays(to, -13);
    const records = [];
    for (let d = from, i = 0; d <= to && i < 93; d = addDays(d, 1), i++) MEALS.forEach(meal => {
      if (q.meal && q.meal !== meal) return;
      records.push({ targetDate: d, mealType: meal, predictedCount: predictedFor(mess, meal, d), actualCount: actualFull(mess, meal, d), modelVersion: 'mock-synthetic-v0' });
    });
    return { synthetic: true, records: scenario === 'empty' ? [] : records };
  }

  const TYPES = [['duplicate_scan', 'Second scan attempt for the same meal', 'rejected'], ['leave_rejection', 'Scan rejected: approved leave on record', 'rejected'], ['invalid_scan', 'QR token not recognised', 'rejected'], ['sync_failure', 'Local server sync retry needed', 'resolved']];
  function exceptionsFor(mess, date, now) {
    const out = [];
    const n = Math.floor(unit(`n|${mess}|${date}`) * 5);
    for (let i = 0; i < n; i++) {
      const t = TYPES[hash(`t|${mess}|${date}|${i}`) % TYPES.length];
      const minute = 420 + Math.floor(unit(`m|${mess}|${date}|${i}`) * 780);
      if (date === now.date && minute > now.minutes) continue;
      out.push({ id: `${date}-${i}`, timestamp: `${date}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}:00`, type: t[0], description: t[1], subjectRef: 'S-' + hash(`s|${mess}|${date}|${i}`).toString(16).slice(0, 4).toUpperCase(), status: t[2] });
    }
    return out;
  }
  function exceptions(q, now) {
    const mess = q.mess || 'South Mess', to = q.to || now.date, from = q.from || addDays(to, -6);
    let list = [];
    for (let d = from, i = 0; d <= to && i < 93; d = addDays(d, 1), i++) list = list.concat(exceptionsFor(mess, d, now));
    return { synthetic: true, exceptions: scenario === 'empty' ? [] : list.reverse() };
  }

  function report(q, now) {
    const mess = q.mess || 'South Mess', to = q.to || q.from || now.date, from = q.from || to;
    const rows = [];
    for (let d = from, i = 0; d <= to && i < 93; d = addDays(d, 1), i++) {
      if (d > now.date) break;
      MEALS.forEach(meal => rows.push({
        date: d, mealType: meal, expected: expectedFor(mess, meal, d), served: servedFor(mess, meal, d, now),
        prepared: Math.round(predictedFor(mess, meal, d) * 1.02), predictedCount: predictedFor(mess, meal, d)
      }));
    }
    return { synthetic: true, rows: scenario === 'empty' ? [] : rows };
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://x'), q = Object.fromEntries(url.searchParams), origin = req.headers.origin;
    hits.push(req.method + ' ' + url.pathname + url.search);
    if (origin && origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    }
    res.setHeader('Vary', 'Origin'); res.setHeader('X-Data-Source', 'synthetic-mock'); res.setHeader('Cache-Control', 'no-store');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/__mock/scenario') {
      if (req.method === 'GET') return send(200, { scenario, scenarios: SCENARIOS });
      let b = ''; req.on('data', c => { b += c; });
      return req.on('end', () => { try { const n = JSON.parse(b).name; if (!SCENARIOS.includes(n)) return send(400, { error: 'unknown scenario' }); scenario = n; send(200, { scenario }); } catch (e) { send(400, { error: 'bad json' }); } });
    }
    if (url.pathname === '/__mock/hits') return send(200, { hits });
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (scenario === 'auth') return send(401, { error: 'not signed in' });
    for (const k of ['from', 'to', 'date']) if (q[k] && !isDate(q[k])) return send(400, { error: `invalid ${k}` });
    const now = nowInfo();
    switch (url.pathname) {
      case '/api/v1/dashboard/summary': return scenario === 'fail-summary' ? send(500, { error: 'summary unavailable (simulated)' }) : send(200, summary(q, now));
      case '/api/v1/forecasts': return scenario === 'fail-forecast' ? send(503, { error: 'ML service unavailable (simulated)' }) : send(200, forecasts(q, now));
      case '/api/v1/forecasts/evaluations': return scenario === 'fail-forecast' ? send(503, { error: 'ML service unavailable (simulated)' }) : send(200, evaluations(q, now));
      case '/api/v1/exceptions': return send(200, exceptions(q, now));
      case '/api/v1/reports/daily': return send(200, report(q, now));
      default: return send(404, { error: 'not found' });
    }
  }

  const server = http.createServer(handler);
  return { server, hits, setScenario: s => { scenario = s; }, getScenario: () => scenario };
}

module.exports = { createMock, SCENARIOS };

if (require.main === module) {
  const port = process.env.MOCK_PORT || 4000;
  createMock().server.listen(port, () => console.log(`SYNTHETIC mock API on http://localhost:${port}  (not the real backend)`));
}
