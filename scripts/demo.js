// One command for the hackathon demo: static app on :3000 + SYNTHETIC mock API on :4000.
// Open http://localhost:3000/?demo=1  (the ?demo=1 switch points the dashboard at the mock).
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
const procs = [
  spawn(process.execPath, ['server.js'], { cwd: root, env: Object.assign({}, process.env, { PORT: '3000' }), stdio: 'inherit' }),
  spawn(process.execPath, ['mock/mock-api.js'], { cwd: root, stdio: 'inherit' })
];
console.log('\nDemo: http://localhost:3000/?demo=1   (data is SYNTHETIC, from the mock API)\n' +
  'Error-state demos: curl -X POST localhost:4000/__mock/scenario -d \'{"name":"fail-forecast"}\'\n' +
  'Scenarios: normal | over | missing | empty | fail-summary | fail-forecast | auth\n');
const stop = () => procs.forEach(p => p.kill());
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
