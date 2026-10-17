import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { createLedger } from '../src/ledger.js';
import { chooseWorker, pickWorker, workerStatus } from '../src/router.js';
import { loadSettings } from '../src/settings.js';
import { computeStats } from '../src/stats.js';
import { baseEnv, tmp, fakeCodex, fakeOpencode, until } from './helpers.js';

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
// Deja el proceso del test limpio aunque una aserción falle: sin jobs vivos no quedan lectores activos.
async function cancelAll(jm) {
  if (!jm) return;
  await Promise.all(jm.list({}).map(j => jm.cancel(j.id).catch(() => {})));
  jm.shutdown();
}

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

const mixSettings = () => settingsFor(`
workers:
  luna: {provider: codex, model: m1, priority: 1, strengths: [code]}
  flash: {provider: opencode, model: m2, priority: 2, strengths: [code, docs]}
  hive: {provider: opencode, model: m3, priority: 9, strengths: [bulk]}
  backup: {provider: codex, model: m4, priority: 10, strengths: [code]}
roles: {reporter: luna, summarizer: luna, reviewer: luna, presenter: luna}
defaults: {worker: backup}
profiles: {balanced: {mix: {luna: 1, flash: 1, hive: 2}}}
preferences: {profile: balanced}
`);

test('mix profile routes eight jobs in exact 1:1:2 shares and preview does not count', () => {
  const settings = mixSettings();
  const ledger = ledgerFor();
  assert.equal(chooseWorker(settings, ledger).alias, 'luna');
  assert.deepEqual(ledger.allocationCounts('balanced'), {});

  const selected = Array.from({ length: 8 }, () => chooseWorker(settings, ledger, { commitAllocation: true }).alias);
  assert.deepEqual(Object.fromEntries(['luna', 'flash', 'hive'].map(alias => [alias, selected.filter(worker => worker === alias).length])), {
    luna: 2, flash: 2, hive: 4,
  });
  assert.deepEqual(ledger.allocationCounts('balanced'), { luna: 2, flash: 2, hive: 4 });
  const shares = Object.fromEntries(workerStatus(settings, ledger).map(row => [row.alias, row.profile_share]));
  assert.deepEqual(shares, { luna: 0.25, flash: 0.25, hive: 0.5, backup: 0 });
});

test('JobManager reparte ocho jobs en 2/2/4 y conserva los conteos en usage.json', async () => {
  const home = tmp('colmena-mix-jobs-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  luna: {provider: codex, model: m1, priority: 1}
  flash: {provider: opencode, model: m2, priority: 2}
  hive: {provider: opencode, model: m3, priority: 9, strengths: [bulk]}
roles: {reporter: luna, summarizer: luna, reviewer: luna, presenter: luna}
defaults: {worker: luna, max_parallel: 4}
profiles: {balanced: {mix: {luna: 1, flash: 1, hive: 2}}}
preferences: {profile: balanced}
plugins: {notify: {enabled: false}}
`);
  const config = getConfig({ ...baseEnv(home), COLMENA_CODEX_BIN: fakeCodex, COLMENA_OPENCODE_BIN: fakeOpencode });
  const jm = createJobManager(config);
  try {
    const ids = Array.from({ length: 8 }, (_, i) => jm.submit({ task: `job ${i}`, cwd: tmp('colmena-mix-job-c-'), isolation: 'inplace' }));
    await jm.wait(ids);
    assert.deepEqual(Object.fromEntries(['luna', 'flash', 'hive'].map(alias => [alias, ids.filter(id => jm.meta(id).worker === alias).length])), {
      luna: 2, flash: 2, hive: 4,
    });
    assert.deepEqual(createLedger(config).allocationCounts('balanced'), { luna: 2, flash: 2, hive: 4 });
  } finally { await cancelAll(jm); }
});

test('mix profile skips disabled members with a note and falls back when all mix members are unavailable', () => {
  const settings = mixSettings();
  settings.workers.luna.enabled = false;
  settings.workers.flash.enabled = false;
  settings.workers.hive.enabled = false;
  const ledger = ledgerFor();
  const fallback = chooseWorker(settings, ledger, { commitAllocation: true });
  assert.equal(fallback.alias, 'backup');
  assert.match(fallback.note, /balanced.*sin workers disponibles.*ruteo normal/i);
  assert.equal(ledger.allocationCounts('balanced').hive ?? 0, 0);

  settings.workers.flash.enabled = true;
  const partial = chooseWorker(settings, ledger, { commitAllocation: true });
  assert.equal(partial.alias, 'flash');
  assert.match(partial.note, /luna.*deshabilitado/i);
  assert.deepEqual(ledger.allocationCounts('balanced'), { flash: 1 });
});

test('mix profile gives kind bulk preference within the mix and counts the selected worker', () => {
  const settings = mixSettings();
  const ledger = ledgerFor();
  const selection = chooseWorker(settings, ledger, { kind: 'bulk', commitAllocation: true });
  assert.equal(selection.alias, 'hive');
  assert.deepEqual(ledger.allocationCounts('balanced'), { hive: 1 });
});

test('explicit worker overrides the active mix and does not change its allocation counts', () => {
  const settings = mixSettings();
  const ledger = ledgerFor();
  assert.deepEqual(chooseWorker(settings, ledger, { worker: 'backup', commitAllocation: true }), { alias: 'backup' });
  assert.deepEqual(ledger.allocationCounts('balanced'), {});
});

test('provider profile changes the implicit route while explicit worker remains authoritative', () => {
  const settings = settingsFor(`
workers:
  codex: {provider: codex, model: m1, priority: 1}
  oc: {provider: opencode, model: m2, priority: 2}
roles: {reporter: codex, summarizer: codex, reviewer: codex, presenter: codex}
defaults: {worker: codex}
profiles: {remote: {provider: opencode}}
preferences: {profile: remote}
`);
  const ledger = ledgerFor();
  assert.equal(pickWorker(settings, ledger, {}), 'oc');
  assert.equal(workerStatus(settings, ledger).find(row => row.alias === 'oc').preferred, true);
  assert.equal(pickWorker(settings, ledger, { worker: 'codex' }), 'codex');
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

test('MC-2: el ledger acumula reservas por job, las libera y reconcilia las huérfanas', () => {
  const cfg = { usagePath: path.join(tmp('colmena-lg-'), 'usage.json') };
  const l = createLedger(cfg, { now: () => new Date('2026-10-16T10:00:00Z') });
  l.record('a', { input_tokens: 1 }, 0.1);
  l.reserve('job1', 'a', 0.3);
  l.reserve('job2', 'a', 0.2);
  l.reserve('job3', 'b', 0.1);
  assert.equal(l.reserved('a'), 0.5);
  assert.equal(l.reserved('b'), 0.1);
  assert.equal(l.spent('a'), 0.1);

  const reloaded = createLedger(cfg, { now: () => new Date('2026-10-16T10:00:00Z') });
  assert.equal(reloaded.reserved('a'), 0.5);
  assert.equal(reloaded.release('job1'), true);
  assert.equal(reloaded.release('job1'), false);
  assert.equal(reloaded.reserved('a'), 0.2);
  assert.equal(reloaded.spent('a'), 0.1);

  assert.equal(reloaded.reconcile(['job2']), 1);
  assert.equal(reloaded.reserved('a'), 0.2);
  assert.equal(reloaded.reserved('b'), 0);
});

test('MC-2: workerStatus y pickWorker descuentan reservas; los free quedan exentos', () => {
  const s = settingsFor(`
workers:
  a: {provider: codex, model: m1, priority: 1, budget: {monthly_usd: 1}, reserve_usd: 0.4}
  b: {provider: opencode, model: m3, priority: 2}
  borde: {provider: opencode, model: m0, priority: 3, budget: {monthly_usd: 1}}
  free: {provider: opencode, model: m2, priority: 4, budget: {monthly_usd: 0.01}, reserve_usd: 5, free: true}
roles: {reporter: b, summarizer: b, reviewer: a, presenter: a}
defaults: {worker: a, reserve_usd: 0.2}
`);
  const usagePath = path.join(tmp('colmena-lg-'), 'usage.json');
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(usagePath, JSON.stringify({
    '2026-10': { a: { runs: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.1 }, borde: { runs: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.5 } },
    reservations: {
      j1: { worker: 'a', amount: 0.3 }, j2: { worker: 'a', amount: 0.3 }, j3: { worker: 'a', amount: 0.3 },
      e1: { worker: 'borde', amount: 0.3 },
      f1: { worker: 'free', amount: 5 },
    },
  }));
  const l = createLedger({ usagePath }, { now: () => new Date('2026-10-16T10:00:00Z') });
  const rows = Object.fromEntries(workerStatus(s, l).map(r => [r.alias, r]));
  assert.equal(rows.a.reserved_usd, 0.9);
  assert.equal(rows.a.remaining_usd, 0, 'el restante descuenta el gasto y las reservas');
  assert.equal(rows.a.available, false);
  assert.equal(rows.borde.reserved_usd, 0.3);
  assert.equal(rows.borde.available, true, 'gasto + reservas + la próxima reserva (0.2) caben justo en el presupuesto');
  assert.equal(rows.free.reserved_usd, 5);
  assert.equal(rows.free.available, true);
  assert.throws(() => pickWorker(s, l, { worker: 'a' }), /sin presupuesto.*reservado \$0\.9/);
  assert.equal(pickWorker(s, l, {}), 'b');
  assert.equal(pickWorker(s, l, { worker: 'free' }), 'free');
});

test('MC-2: N jobs simultáneos con reserva no consumen el mismo saldo', async () => {
  process.env.FAKE_DELAY = '400';
  let jm;
  try {
    const home = tmp('colmena-res-');
    fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  capped: {provider: opencode, model: m, priority: 1, budget: {monthly_usd: 0.05}, reserve_usd: 0.02}
  backup: {provider: opencode, model: m, priority: 2}
roles: {reporter: backup, summarizer: backup, reviewer: backup, presenter: backup}
defaults: {worker: capped}
plugins: {notify: {enabled: false}}
`);
    const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
    jm = createJobManager(config);
    const S = (t, x = {}) => ({ task: t, cwd: tmp('colmena-res-c-'), isolation: 'inplace', ...x });

    const a = jm.submit(S('uno', { worker: 'capped' }));
    const b = jm.submit(S('dos', { worker: 'capped' }));
    assert.throws(() => jm.submit(S('tres', { worker: 'capped' })), /sin presupuesto.*reservado \$0\.04/);

    const running = jm.workers().find(r => r.alias === 'capped');
    assert.equal(running.reserved_usd, 0.04);
    assert.equal(running.remaining_usd, 0.01);
    assert.equal(running.available, false);
    assert.equal(jm.meta(a).reservedUsd, 0.02);

    const c = jm.submit(S('tres'));
    await jm.wait([a, b, c], { timeoutS: 30 });
    assert.equal(jm.result(c).worker, 'backup');
    assert.equal(jm.result(a).state, 'done');

    const released = jm.workers().find(r => r.alias === 'capped');
    assert.equal(released.reserved_usd, 0);
    assert.ok(Math.abs(released.spent_usd - 0.04) < 1e-9, `gastado ${released.spent_usd}`);
    assert.equal(released.available, false, 'con el gasto real ya no cabe otra reserva');
  } finally {
    await cancelAll(jm);
    delete process.env.FAKE_DELAY;
  }
});

test('MC-2: cancelar un job en cola libera su reserva', async () => {
  process.env.FAKE_DELAY = '300';
  let jm;
  try {
    const home = tmp('colmena-res-cancel-');
    fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  capped: {provider: opencode, model: m, budget: {monthly_usd: 0.05}, reserve_usd: 0.02}
roles: {reporter: capped, summarizer: capped, reviewer: capped, presenter: capped}
defaults: {worker: capped, max_parallel: 1}
plugins: {notify: {enabled: false}}
`);
    const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
    jm = createJobManager(config);
    const S = (t, x = {}) => ({ task: t, cwd: tmp('colmena-res-c-'), isolation: 'inplace', ...x });
    const a = jm.submit(S('SLEEP'));
    const b = jm.submit(S('hola'));
    assert.equal(jm.status(b).state, 'queued');
    assert.equal(jm.workers().find(r => r.alias === 'capped').reserved_usd, 0.04);

    await jm.cancel(b);
    assert.equal(jm.workers().find(r => r.alias === 'capped').reserved_usd, 0.02);
    await jm.cancel(a); await jm.wait([a], { timeoutS: 20 });
    assert.equal(jm.workers().find(r => r.alias === 'capped').reserved_usd, 0);
  } finally {
    await cancelAll(jm);
    delete process.env.FAKE_DELAY;
  }
});

test('MC-2: un job adoptado conserva su reserva (o la restaura si se perdió) y la libera al terminar', async () => {
  process.env.FAKE_DELAY = '500';
  let jmB;
  try {
    const home = tmp('colmena-res-adopt-');
    fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  capped: {provider: opencode, model: m, budget: {monthly_usd: 0.05}, reserve_usd: 0.02}
roles: {reporter: capped, summarizer: capped, reviewer: capped, presenter: capped}
defaults: {worker: capped}
plugins: {notify: {enabled: false}}
`);
    const env = { ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode };
    const configA = getConfig(env);
    const jmA = createJobManager(configA);
    const id = jmA.submit({ task: 'hola', cwd: tmp('colmena-res-c-'), isolation: 'inplace' });
    await until(() => (jmA.meta(id).logOffset ?? 0) > 0, 'manager A should persist a log offset');
    jmA.shutdown();
    jmA.mark(id, { owner: Number.MAX_SAFE_INTEGER });
    fs.writeFileSync(configA.usagePath, JSON.stringify({}), 'utf8'); // simula un crash que perdió la reserva en disco

    jmB = createJobManager(getConfig(env));
    jmB.recoverOrphans();
    assert.equal(jmB.meta(id).adopted, true);
    assert.equal(jmB.workers().find(r => r.alias === 'capped').reserved_usd, 0.02, 'el job adoptado sigue reservando su estimado');

    await jmB.wait([id], { timeoutS: 10 });
    assert.equal(jmB.result(id).state, 'done');
    assert.equal(jmB.workers().find(r => r.alias === 'capped').reserved_usd, 0);
    assert.ok(Math.abs(jmB.workers().find(r => r.alias === 'capped').spent_usd - 0.02) < 1e-9);
  } finally {
    await cancelAll(jmB);
    delete process.env.FAKE_DELAY;
  }
});

test('MC-2: un job huérfano libera su reserva al recuperarse', () => {
  const home = tmp('colmena-res-orphan-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  capped: {provider: opencode, model: m, budget: {monthly_usd: 0.05}, reserve_usd: 0.02}
roles: {reporter: capped, summarizer: capped, reviewer: capped, presenter: capped}
defaults: {worker: capped}
plugins: {notify: {enabled: false}}
`);
  const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
  fs.writeFileSync(config.usagePath, JSON.stringify({ reservations: { previo: { worker: 'capped', amount: 0.02 } } }));
  const dir = path.join(config.jobsDir, 'previo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: 'previo', state: 'queued', kind: 'run', task: 'previo', cwd: tmp('colmena-res-c-'), workdir: tmp('colmena-res-c-'),
    worker: 'capped', provider: 'opencode', model: 'm', owner: Number.MAX_SAFE_INTEGER, createdAt: Date.now(), reservedUsd: 0.02,
  }));

  const jm = createJobManager(config);
  jm.recoverOrphans();
  assert.equal(jm.status('previo').state, 'orphaned');
  const left = JSON.parse(fs.readFileSync(config.usagePath, 'utf8')).reservations?.previo;
  assert.equal(left, undefined, 'la reserva no puede quedar eterna');
});

test('MC-2: el costo real puede superar la reserva sin ocultarse; free no reserva ni se bloquea', async () => {
  let jm;
  try {
    const home = tmp('colmena-res-over-');
    fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  tight: {provider: opencode, model: m, priority: 1, budget: {monthly_usd: 0.05}, reserve_usd: 0.01}
  gratis: {provider: opencode, model: m, priority: 2, budget: {monthly_usd: 0.001}, reserve_usd: 0.5, free: true}
roles: {reporter: gratis, summarizer: gratis, reviewer: gratis, presenter: gratis}
defaults: {worker: tight}
plugins: {notify: {enabled: false}}
`);
    const config = getConfig({ ...baseEnv(home), COLMENA_OPENCODE_BIN: fakeOpencode });
    jm = createJobManager(config);
    const S = (t, x = {}) => ({ task: t, cwd: tmp('colmena-res-c-'), isolation: 'inplace', ...x });

    const a = jm.submit(S('uno', { worker: 'tight' }));
    await jm.wait([a]);
    const row = jm.workers().find(r => r.alias === 'tight');
    assert.equal(row.reserved_usd, 0);
    assert.ok(Math.abs(row.spent_usd - 0.02) < 1e-9, `gastado ${row.spent_usd}`);
    assert.ok(row.spent_usd > jm.meta(a).reservedUsd, 'el costo real supera la estimación y queda registrado');

    const f1 = jm.submit(S('libre uno', { worker: 'gratis' }));
    const f2 = jm.submit(S('libre dos', { worker: 'gratis' }));
    const freeRow = jm.workers().find(r => r.alias === 'gratis');
    assert.equal(freeRow.reserved_usd, 0);
    assert.equal(freeRow.available, true);
    await jm.wait([f1, f2]);
    assert.equal(jm.result(f1).state, 'done');
    assert.equal(jm.result(f2).state, 'done');
  } finally {
    await cancelAll(jm);
  }
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
