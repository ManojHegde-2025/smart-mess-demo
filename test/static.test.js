'use strict';
// Static guards for the project rules: no invented metrics, no secrets, no silent fake fallbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const webFiles = fs.readdirSync(path.join(root, 'web')).filter(f => f.endsWith('.js'));

test('browser code has no randomness, no sample arrays, no password storage', () => {
  for (const f of webFiles) {
    const s = read('web/' + f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code only, comments ignored
    assert.ok(!/Math\.random/.test(s), f + ' uses Math.random');
    // Only the API client may use localStorage, and only for the manager Bearer token (never a password).
    if (f !== 'api.js') assert.ok(!/localStorage/.test(s), f + ' touches localStorage');
    assert.ok(!/sessionStorage|document\.cookie/.test(s), f + ' touches session storage or cookies');
    if (f === 'api.js') assert.ok(!/password\s*[:=]\s*[^,;)]*(getItem|setItem)/.test(s), 'api.js must not store a password');
    assert.ok(!/\[\s*600\s*,\s*640/.test(s), f + ' contains the old hardcoded trend array');
    // 'password' is allowed as a parameter name in the sign-in function; no secret value may appear.
    const secretWords = f === 'api.js' ? /(secret|api[_-]?key|DATABASE_URL|postgres:\/\/)/i : /(password|secret|api[_-]?key|DATABASE_URL|postgres:\/\/)/i;
    assert.ok(!secretWords.test(s), f + ' mentions a secret');
  }
});

test('manager dashboard does not import the synthetic mock', () => {
  for (const f of webFiles) assert.ok(!/mock-api|require\(['"]\.\.\/mock/.test(read('web/' + f)), f);
});

test('old simulated forecast/trend functions are gone from index.html', () => {
  const html = read('index.html');
  assert.ok(!/function pred\(/.test(html));
  assert.ok(!/function trend\(/.test(html));
  assert.ok(!/Recommended preparation: \$\{Math\.ceil/.test(html)); // invented 4% buffer
});

test('student portal code in index.html is still present', () => {
  const html = read('index.html');
  for (const needle of ['function sim(', 'function doLogin(', 'function sendFb(', 'scan(){return', 'hist(){return', 'prof(){return']) assert.ok(html.includes(needle), needle);
});

test('every API response normalizer keeps missing values null (no "|| 0" defaults)', () => {
  assert.ok(!/\|\|\s*0\b/.test(read('web/api.js')));
  assert.ok(!/\|\|\s*0\b/.test(read('web/calc.js')));
});
