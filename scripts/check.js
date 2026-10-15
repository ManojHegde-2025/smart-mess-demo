// "Lint" for a dependency-free project: every JS file parses, and index.html inline scripts parse.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
let bad = 0, n = 0;
function parse(label, code) { n++; try { new vm.Script(code, { filename: label }); } catch (e) { bad++; console.error('SYNTAX ERROR in ' + label + ': ' + e.message); } }
for (const d of ['web', 'mock', 'adapters', 'test', 'scripts']) for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith('.js')) parse(d + '/' + f, fs.readFileSync(path.join(root, d, f), 'utf8'));
parse('server.js', fs.readFileSync(path.join(root, 'server.js'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => parse('index.html inline script #' + (i + 1), m[1]));
console.log(bad ? bad + ' file(s) failed' : 'check OK: ' + n + ' scripts parse');
process.exit(bad ? 1 : 0);
