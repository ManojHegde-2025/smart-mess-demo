/*
 * FAKE of Member 3's ML service, written from reading ml/api/app.py and ml/src/predict.py.
 * It is NOT their service: it only reproduces the documented HTTP contract (POST /predict, X-API-Key,
 * 422 when a mess/meal has no history, prediction_range only for the xgboost method, SYNTHETIC warning)
 * so the adapter and dashboard can be tested. Real-service tests stay blocked until it can be run.
 */
'use strict';
const http = require('http');

function createFakeMl(opts) {
  opts = opts || {};
  const key = opts.apiKey === undefined ? 'test-key' : opts.apiKey;
  const state = { mode: 'normal', calls: [] };
  const HAVE = { 'south|lunch': 'xgboost', 'south|dinner': 'baseline' }; // south breakfast: no history
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (state.mode === 'down') return req.socket.destroy();
      if (req.method !== 'POST' || req.url !== '/predict') return send(404, { detail: 'Not Found' });
      state.calls.push({ headers: req.headers, body: raw });
      if (key && req.headers['x-api-key'] !== key) return send(401, { detail: 'invalid API key' });
      if (state.mode === 'error') return send(500, { detail: 'boom' });
      let b; try { b = JSON.parse(raw); } catch (e) { return send(422, { detail: 'bad json' }); }
      const method = HAVE[b.mess_id + '|' + b.meal_type];
      if (!method) return send(422, { detail: `No history for mess='${b.mess_id}' meal='${b.meal_type}' before ${b.date}` });
      const pred = b.meal_type === 'lunch' ? 704 : 648;
      const out = { mess: b.mess_id, mess_id: b.mess_id, date: b.date, meal_type: b.meal_type, predicted_meals: pred,
        recommended_preparation: Math.round(pred * 1.02), safety_buffer: 0.02, model_version: method === 'xgboost' ? 'xgb_v1' : 'baseline_ma7',
        method: method === 'xgboost' ? 'xgboost' : 'moving_average_7', warnings: ['model was trained on SYNTHETIC data'], internal_note: 'must not be forwarded' };
      if (method === 'xgboost') out.prediction_range = { low: 680, high: 731, coverage: '~80% (validation residuals)' };
      send(200, out);
    });
  });
  return { server, state };
}
module.exports = { createFakeMl };
