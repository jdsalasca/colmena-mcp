// Real smoke test: one read-only run per chosen worker + per-worker contract checks + optional real report.
// Optional and never in CI: it spends real agent calls. Usage: node scripts/smoke.js [worker1,worker2,...] [--report]
// Contract checks per provider: worker selection + persisted metadata vs config, RESULT/FILES/TESTS/RISKS report,
// provider final signal when it emits one, and model id exposed in events (never claimed when not exposed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { generateReport } from '../src/plugins/report.js';
import { getAdapter } from '../src/providers/index.js';

// Providers whose final signal is part of the contract (cf. adapter.completesOn: codex emits turn.completed; opencode never does).
const PROVIDERS_WITH_FINAL_SIGNAL = new Set(['codex']);

function collectModelIds(value, out = []) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'model' && typeof v === 'string') out.push(v);
      else collectModelIds(v, out);
    }
  }
  return out;
}

function contractChecks({ jm, config, id, r }) {
  const alias = r.worker;
  const w = config.settings.workers[alias];
  const adapter = getAdapter(r.provider ?? jm.meta(id).provider);
  const meta = jm.meta(id);
  const rawLines = fs.readFileSync(path.join(jm.jobDir(id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  const events = rawLines.flatMap(line => { try { return [adapter.parseLine(line)]; } catch { return []; } });
  const checks = [];
  const check = (label, ok, detail) => { checks.push({ label, ok }); console.log(`[${alias}] ${label}: ${ok ? 'OK' : 'FALLO'} — ${detail}`); };

  const expected = { provider: w.provider, model: w.model, effort: w.effort ?? null };
  const got = { provider: meta.provider, model: meta.model, effort: meta.effort ?? null };
  const diffs = Object.entries(expected).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: meta ${JSON.stringify(got[k])} ≠ config ${JSON.stringify(v)}`);
  check('worker', meta.worker === alias && diffs.length === 0, diffs.length ? diffs.join('; ') : `${meta.worker} → ${expected.provider}/${expected.model}/${expected.effort}`);

  if (r.reportOk) check('reporte', true, 'RESULT/FILES/TESTS/RISKS');
  else check('reporte', false, `sin formato (${(r.text ?? r.error ?? '(vacío)').slice(0, 100)})`);

  const finals = events.filter(e => adapter.completesOn?.(e) === true);
  if (finals.length) check('señal-final', meta.delivered === true, meta.delivered ? 'entrega confirmada' : 'señal emitida, entrega no confirmada');
  else if (PROVIDERS_WITH_FINAL_SIGNAL.has(r.provider)) check('señal-final', false, 'el proveedor no emitió su señal final');
  else check('señal-final', true, 'n/a (el proveedor no emite señal final)');

  const exposed = rawLines.flatMap(line => { try { return collectModelIds(JSON.parse(line)); } catch { return []; } });
  if (!exposed.length) check('modelo', true, 'no expuesto en eventos; no se afirma modelo ejecutado');
  else {
    const bad = [...new Set(exposed)].filter(m => m !== w.model);
    check('modelo', bad.length === 0, bad.length ? `expone ${[...new Set(exposed)].join(', ')} ≠ configurado ${w.model}` : `expuesto ${exposed[0]} (coincide)`);
  }
  return checks;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-smoke-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-smoke-cwd-'));
let pass = false;
try {
  const config = getConfig({ ...process.env, COLMENA_HOME: home, COLMENA_NOTIFIER: 'none' });
  console.log('codex:', config.codex.bin, '\nopencode:', config.opencode.bin, '\nhome:', home, '\ncwd:', cwd);
  const jm = createJobManager(config);
  const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : ['luna-max', 'ds-flash'];
  const task = 'Responde únicamente con la palabra pong en RESULT. No ejecutes ninguna herramienta.';

  const submitted = only.map(worker => ({ worker, id: jm.submit({ task, cwd, isolation: 'readonly', worker }) }));
  const ids = submitted.map(s => s.id);
  const w = await jm.wait(ids, { timeoutS: 300 });
  for (const r of w.done) console.log(JSON.stringify({ worker: r.worker, state: r.state, report: r.report ?? r.text, cost_usd: r.cost_usd, error: r.error }));
  pass = w.done.length === ids.length && w.done.every(r => r.state === 'done');

  const checks = w.done.flatMap(r => contractChecks({ jm, config, id: submitted.find(s => s.worker === r.worker).id, r }));
  const failed = checks.filter(c => !c.ok);
  console.log(failed.length ? `${failed.length} comprobación(es) de contrato fallida(s)` : 'contrato OK');
  pass = pass && failed.length === 0;

  if (pass && process.argv.includes('--report')) {
    const rep = await generateReport({ jm, config, ids, title: 'Humo de Colmena', open: false });
    console.log('report:', JSON.stringify(rep));
    pass = fs.existsSync(rep.path);
  }
  console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
} finally {
  for (const dir of [home, cwd]) fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(pass ? 0 : 1);
