import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { createLedger } from '../src/ledger.js';
import { pickWorker, workerStatus } from '../src/router.js';
import { loadSettings } from '../src/settings.js';
import { computeStats } from '../src/stats.js';
import { baseEnv, tmp, fakeOpencode } from './helpers.js';

const settingsFor = yml => { const h = tmp('colmena-rt-'); fs.writeFileSync(path.join(h, 'colmena.yml'), yml); return loadSettings(h, {}); };
const YML = `
workers:
  a: {provider: codex, model: m1, priority: 1, strengths: [code], budget: {monthly_usd: 1}}
  b: {provider: opencode, model: m2, priority: 2, strengths: [docs]}
  c: {provider: opencode, model: m3, priority: 3, strengths: [docs, summary], enabled: false}
  d: {provider: opencode, model: m4, priority: 4, strengths: [code]}
roles: {reporter: b, summarizer: b, reviewer: a, presenter: a}
defaults: {worker: a}
`;
const ledgerFor = (now = () => new Date('2026-10-16T10:00:00Z')) => createLedger({ usagePath: path.join(tmp('colmena-lg-'), 'usage.json') }, { now });

test('ledger accumulates per worker and month; persists to disk', () => {
  const cfg = { usagePath: path.join(tmp('colmena-lg-'), 'usage.json') };
  let d = new Date('2026-10-16T10:00:00Z');
  const l = createLedger(cfg, { now: () => d });
  l.record('a', { input_tokens: 10, output_tokens: 2 }, 0.25);
  l.record('a', { input_tokens: 5, output_tokens: 1 }, 0.5);
  assert.equal(l.spent('a'), 0.75);
  assert.deepEqual(l.month('a'), { runs: 2, input_tokens: 15, output_tokens: 3, cost_usd: 0.75 });
  d = new Date('2026-11-01T00:00:00Z');
  assert.equal(l.spent('a'), 0);
  assert.equal(createLedger(cfg, { now: () => new Date('2026-10-20T00:00:00Z') }).spent('a'), 0.75);
});
test('workerStatus: spent, remaining, availability', () => {
  const s = settingsFor(YML); const l = ledgerFor();
  l.record('a', {}, 0.4);
  const rows = Object.fromEntries(workerStatus(s, l).map(r => [r.alias, r]));
  assert.equal(rows.a.remaining_usd, 0.6);
  assert.equal(rows.a.available, true);
  assert.equal(rows.b.budget_usd, null);
  assert.equal(rows.c.available, false);
  s.preferences.provider = 'opencode';
  assert.equal(workerStatus(s, l).find(r => r.alias === 'a').preferred, false);
  assert.equal(workerStatus(s, l).find(r => r.alias === 'b').preferred, true);
  l.record('a', {}, 0.7);
  assert.equal(workerStatus(s, l).find(r => r.alias === 'a').available, false);
});
test('pickWorker: default → priority fallback → kind preference', () => {
  const s = settingsFor(YML); const l = ledgerFor();
  assert.equal(pickWorker(s, l, {}), 'a');
  assert.equal(pickWorker(s, l, { kind: 'docs' }), 'b');
  assert.equal(pickWorker(s, l, { kind: 'code' }), 'a');
  assert.equal(pickWorker(s, l, { kind: 'nonexistent' }), 'a');
  l.record('a', {}, 5);
  assert.equal(pickWorker(s, l, {}), 'b');
});
test('pickWorker: provider preference scopes kind and default, while explicit worker wins', () => {
  const codex = settingsFor(`${YML}\npreferences: {provider: codex}\n`);
  const opencode = settingsFor(`${YML}\npreferences: {provider: opencode}\n`);
  const l = ledgerFor();

  assert.equal(pickWorker(codex, l, { kind: 'docs' }), 'a');
  assert.equal(pickWorker(opencode, l, {}), 'b');
  assert.equal(pickWorker(opencode, l, { kind: 'code' }), 'd');
  assert.equal(pickWorker(opencode, l, { worker: 'a' }), 'a');
});
test('pickWorker: explicit exhausted worker → error with alternatives, no silent fallback', () => {
  const s = settingsFor(YML); const l = ledgerFor(); l.record('a', {}, 5);
  assert.throws(() => pickWorker(s, l, { worker: 'a' }), /sin presupuesto.*alternativas: b/);
  assert.equal(pickWorker(s, l, { worker: 'b' }), 'b');
});
test('pickWorker: nothing available → error', () => {
  const s = settingsFor(`
workers:
  a: {provider: codex, model: m1, budget: {monthly_usd: 1}}
roles: {reporter: a, summarizer: a, reviewer: a, presenter: a}
defaults: {worker: a}
`);
  const l = ledgerFor(); l.record('a', {}, 2);
  assert.throws(() => pickWorker(s, l, {}), /ningún worker disponible/);
});

test('JobManager: cost recorded, budget exhausts, routing falls to next worker', async () => {
  const home = tmp('colmena-jr-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  cheap: {provider: opencode, model: m, priority: 1, budget: {monthly_usd: 0.015}}
  backup: {provider: opencode, model: m, priority: 2}
roles: {reporter: backup, summarizer: backup, reviewer: backup, presenter: backup}
defaults: {worker: cheap}
plugins: {notify: {enabled: false}}
`);
  const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
  const jm = createJobManager(config);
  const S = (t, x = {}) => ({ task: t, cwd: tmp('colmena-c-'), isolation: 'inplace', ...x });
  const a = jm.submit(S('uno')); await jm.wait([a]);
  assert.equal(jm.result(a).worker, 'cheap');
  assert.equal(jm.result(a).cost_usd, 0.02);
  assert.throws(() => jm.submit(S('dos', { worker: 'cheap' })), /sin presupuesto/);
  const b = jm.submit(S('tres')); await jm.wait([b]);
  assert.equal(jm.result(b).worker, 'backup');
  const rows = jm.workers();
  assert.equal(rows.find(r => r.alias === 'cheap').available, false);
  assert.ok(rows.find(r => r.alias === 'cheap').spent_usd >= 0.02);
});

test('worker free registra cero, conserva costo nominal y nunca se bloquea por presupuesto', async () => {
  const home = tmp('colmena-free-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  gratis: {provider: opencode, model: cat-jam-free, effort: high, priority: 1, budget: {monthly_usd: 0.001}, free: true}
  backup: {provider: opencode, model: m, priority: 2}
roles: {reporter: backup, summarizer: backup, reviewer: backup, presenter: backup}
defaults: {worker: gratis}
plugins: {notify: {enabled: false}}
`);
  const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
  const month = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(config.usagePath, JSON.stringify({
    [month]: { gratis: { runs: 1, input_tokens: 0, output_tokens: 0, cost_usd: 1 } },
  }));
  const jm = createJobManager(config);
  const id = jm.submit({ task: 'gratis', cwd: tmp('colmena-free-c-'), isolation: 'inplace', worker: 'gratis' });
  await jm.wait([id]);

  const meta = jm.meta(id);
  const result = jm.result(id);
  const row = jm.workers().find(worker => worker.alias === 'gratis');
  assert.equal(meta.costUsd, 0);
  assert.equal(meta.nominalCostUsd, 0.02);
  assert.equal(result.cost_usd, 0);
  assert.equal(result.nominal_cost_usd, 0.02);
  assert.equal(row.free, true);
  assert.equal(row.spent_usd, 1);
  assert.equal(row.available, true);
  const ledger = JSON.parse(fs.readFileSync(config.usagePath, 'utf8'))[month].gratis;
  assert.equal(ledger.runs, 2);
  assert.equal(ledger.cost_usd, 1);
  assert.equal(computeStats(jm.metas(), { sinceMs: 0 }).byWorker.gratis.nominalCostUsd, 0.02);
  assert.equal(pickWorker(loadSettings(home, {}), createLedger(config), { worker: 'gratis' }), 'gratis');
});
