// Real smoke test: one read-only run per chosen worker + optional real report. Costs a few real agent calls.
// Usage: node scripts/smoke.js [worker1,worker2,...] [--report]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { generateReport } from '../src/plugins/report.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-smoke-'));
const config = getConfig({ ...process.env, COLMENA_HOME: home, COLMENA_NOTIFIER: 'none' });
console.log('codex:', config.codex.bin, '\nopencode:', config.opencode.bin, '\nhome:', home);
const jm = createJobManager(config);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-smoke-cwd-'));
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : ['luna-max', 'ds-flash'];

const ids = only.map(worker => jm.submit({ task: 'Responde únicamente con la palabra pong en RESULT. No ejecutes ninguna herramienta.', cwd, isolation: 'readonly', worker }));
const w = await jm.wait(ids, { timeoutS: 300 });
for (const r of w.done) console.log(JSON.stringify({ worker: r.worker, state: r.state, report: r.report ?? r.text, cost_usd: r.cost_usd, error: r.error }));
let pass = w.done.length === ids.length && w.done.every(r => r.state === 'done');

if (pass && process.argv.includes('--report')) {
  const rep = await generateReport({ jm, config, ids, title: 'Humo de Colmena', open: false });
  console.log('report:', JSON.stringify(rep));
  pass = fs.existsSync(rep.path);
}
console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(pass ? 0 : 1);
