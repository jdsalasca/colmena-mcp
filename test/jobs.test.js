import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { writeFileAtomic } from '../src/atomic-write.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.js');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const d = tmp('luna-jr-'); git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i');
  return d;
}
import { baseEnv, codexOnlyHome } from './helpers.js';
const mk = (env = {}) => {
  const config = getConfig(baseEnv(codexOnlyHome(), env));
  return { jm: createJobManager(config), config };
};
const S = (task, extra = {}) => ({ task, cwd: tmp('luna-cwd-'), isolation: 'inplace', ...extra });

test('submit → done with ok report', async () => {
  const { jm } = mk();
  const id = jm.submit(S('hola'));
  const [r] = (await jm.wait([id])).done;
  assert.equal(r.state, 'done');
  assert.equal(r.report.RESULT.startsWith('ok'), true);
  assert.equal(jm.meta(id).finishedByGrace, undefined);
});
test('Codex delivered output then lingered: grace kills it and preserves done result', async () => {
  const { jm } = mk({ COLMENA_JOB_TIMEOUT_MIN: '0.02', COLMENA_EXIT_GRACE_S: '0.1' });
  const id = jm.submit(S('LINGER'));
  await jm.wait([id], { timeoutS: 10 });
  const result = jm.result(id);
  assert.equal(result.state, 'done');
  assert.equal(jm.meta(id).finishedByGrace, true);
  assert.match(result.message, /entregó su respuesta/i);
  assert.throws(() => process.kill(jm.meta(id).pid, 0));
});
test('Codex delivery at the general timeout is completed as done', async () => {
  const { jm } = mk({ COLMENA_JOB_TIMEOUT_MIN: '0.02', COLMENA_EXIT_GRACE_S: '5' });
  const id = jm.submit(S('LINGER'));
  await jm.wait([id], { timeoutS: 10 });
  assert.equal(jm.result(id).state, 'done');
  assert.equal(jm.meta(id).finishedByGrace, true);
});
test('job conserva modelo, proveedor y esfuerzo en meta, status y result', async () => {
  const { jm } = mk();
  const id = jm.submit(S('hola'));
  const expected = { model: 'gpt-6-luna', provider: 'codex', effort: 'max' };

  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.meta(id)[key]])), expected);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.status(id)[key]])), expected);
  await jm.wait([id]);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.result(id)[key]])), expected);
});
test('never exceeds maxParallel', async () => {
  process.env.FAKE_DELAY = '300';
  try {
    const { jm } = mk({ LUNA_MAX_PARALLEL: '2' });
    const ids = Array.from({ length: 6 }, (_, i) => jm.submit(S('t' + i)));
    const w = await jm.wait(ids, { mode: 'all', timeoutS: 60 });
    assert.equal(w.done.length, 6);
    assert.ok(jm.stats().maxSeen <= 2 && jm.stats().maxSeen >= 1);
  } finally { delete process.env.FAKE_DELAY; }
});
test('cancel running → cancelled', async () => {
  const { jm } = mk();
  const id = jm.submit(S('SLEEP'));
  await new Promise(r => setTimeout(r, 600));
  assert.equal(jm.status(id).state, 'running');
  await jm.cancel(id);
  await jm.wait([id], { timeoutS: 20 });
  assert.equal(jm.status(id).state, 'cancelled');
});
test('cancel queued → cancelled without running', async () => {
  const { jm } = mk({ LUNA_MAX_PARALLEL: '1' });
  const a = jm.submit(S('SLEEP')); const b = jm.submit(S('hola'));
  assert.equal(jm.status(b).state, 'queued');
  await jm.cancel(b);
  assert.equal(jm.status(b).state, 'cancelled');
  await jm.cancel(a); await jm.wait([a], { timeoutS: 20 });
});
test('timeout → failed with reason', async () => {
  const { jm } = mk({ LUNA_JOB_TIMEOUT_MIN: '0.02' });
  const id = jm.submit(S('SLEEP'));
  await jm.wait([id], { timeoutS: 30 });
  const r = jm.result(id);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /timeout/i);
});
test('failed exit keeps stderr', async () => {
  const { jm } = mk();
  const id = jm.submit(S('FAIL'));
  await jm.wait([id]);
  const r = jm.result(id);
  assert.equal(r.state, 'failed'); assert.match(r.error, /boom/);
});
test('wait any returns as soon as one finishes; pending listed', async () => {
  const { jm } = mk();
  const slow = jm.submit(S('SLEEP')); const fast = jm.submit(S('hola'));
  const w = await jm.wait([slow, fast], { mode: 'any', timeoutS: 30 });
  assert.equal(w.done.length, 1); assert.equal(w.pending.length, 1);
  await jm.cancel(slow); await jm.wait([slow], { timeoutS: 20 });
});
test('wait timeout returns pending without throwing', async () => {
  const { jm } = mk();
  const id = jm.submit(S('SLEEP'));
  const w = await jm.wait([id], { timeoutS: 1 });
  assert.equal(w.pending.length, 1);
  await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
});
test('worktree job: result lists edited file and branch', async () => {
  const { jm } = mk(); const r0 = repo();
  const id = jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' });
  await jm.wait([id]);
  const r = jm.result(id);
  assert.equal(r.state, 'done');
  assert.ok(r.files.includes('edited.txt'));
  assert.match(r.branch, /^colmena\//);
  assert.equal(fs.existsSync(path.join(r0, 'edited.txt')), false);
});
test('two parallel worktree jobs do not collide', async () => {
  const { jm } = mk(); const r0 = repo();
  const ids = [jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' }), jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' })];
  await jm.wait(ids);
  const [a, b] = ids.map(i => jm.result(i));
  assert.notEqual(a.workdir, b.workdir);
  assert.deepEqual(a.files, ['edited.txt']); assert.deepEqual(b.files, ['edited.txt']);
});
test('non-git worktree submit throws and creates no job', () => {
  const { jm } = mk();
  assert.throws(() => jm.submit(S('x', { isolation: 'worktree' })), /no es un repositorio git/);
  assert.equal(jm.list({}).length, 0);
});
test('continueJob resumes saved session in same workdir', async () => {
  const log = path.join(tmp('luna-log-'), 'fake.log'); process.env.FAKE_LOG = log;
  try {
    const { jm } = mk();
    const id = jm.submit(S('uno')); await jm.wait([id]);
    const sid = jm.result(id, { detail: 'normal' }).sessionId;
    assert.ok(sid);
    const id2 = jm.continueJob(id, 'sigue');
    await jm.wait([id2]);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const last = calls[calls.length - 1];
    assert.deepEqual(last.argv.slice(1, 4), ['exec', 'resume', sid]);
    assert.ok(last.prompt.includes('sigue'));
    assert.equal(jm.result(id2).state, 'done');
  } finally { delete process.env.FAKE_LOG; }
});
test('reload uses the new worker model for subsequent runs', async () => {
  const log = path.join(tmp('luna-reload-'), 'fake.log'); process.env.FAKE_LOG = log;
  try {
    const { jm, config } = mk();
    const before = fs.readFileSync(path.join(config.home, 'colmena.yml'), 'utf8');
    fs.writeFileSync(path.join(config.home, 'colmena.yml'), before.replace('model: gpt-6-luna', 'model: gpt-luna-reloaded'));
    config.reloadSettings();
    const id = jm.submit(S('usa modelo recargado'));
    await jm.wait([id]);
    const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.equal(call.argv[call.argv.indexOf('-m') + 1], 'gpt-luna-reloaded');
  } finally { delete process.env.FAKE_LOG; }
});
test('reload keeps environment parallelism and timeout overrides above YAML values', () => {
  const { config } = mk({ COLMENA_MAX_PARALLEL: '1', COLMENA_JOB_TIMEOUT_MIN: '7', COLMENA_EXIT_GRACE_S: '8' });
  const file = path.join(config.home, 'colmena.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'defaults: {worker: luna-max}', 'defaults: {worker: luna-max, max_parallel: 6, timeout_min: 1, exit_grace_s: 2}',
  ));
  config.reloadSettings();
  assert.equal(config.maxParallel, 1);
  assert.equal(config.timeoutMin, 7);
  assert.equal(config.exitGraceS, 8);
});
test('continue fails clearly when its previous worker was removed by reload', async () => {
  const { jm, config } = mk();
  const id = jm.submit(S('usa alt', { worker: 'alt' })); await jm.wait([id]);
  fs.writeFileSync(path.join(config.home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna}
  alt: {provider: codex, model: gpt-alt, enabled: false}
roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}
defaults: {worker: luna-max}
`);
  config.reloadSettings();
  assert.throws(() => jm.continueJob(id, 'continúa'), /worker 'alt' está deshabilitado/);

  fs.writeFileSync(path.join(config.home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna}
roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}
defaults: {worker: luna-max}
`);
  config.reloadSettings();
  assert.throws(() => jm.continueJob(id, 'continúa'), /worker 'alt' no existe/);
});
test('malformed agent reply → raw truncated text, no crash', async () => {
  process.env.FAKE_RAW = 'sin formato '.repeat(300);
  try {
    const { jm } = mk(); const id = jm.submit(S('x')); await jm.wait([id]);
    const r = jm.result(id);
    assert.equal(r.state, 'done'); assert.equal(r.reportOk, false);
    assert.ok(r.text.length <= 1500);
  } finally { delete process.env.FAKE_RAW; }
});
test('recoverOrphans marks stale running jobs', () => {
  const { jm, config } = mk();
  fs.mkdirSync(path.join(config.jobsDir, 'old1'), { recursive: true });
  fs.writeFileSync(path.join(config.jobsDir, 'old1', 'meta.json'), JSON.stringify({ id: 'old1', state: 'running', createdAt: 1 }));
  jm.recoverOrphans();
  assert.equal(jm.status('old1').state, 'orphaned');
});
test('tokens: min result is compact', async () => {
  const { jm } = mk(); const id = jm.submit(S('hola')); await jm.wait([id]);
  assert.ok(JSON.stringify(jm.result(id)).length < 1200);
});

test('unknown worker alias → error listing valid ones, no job created', () => {
  const { jm } = mk();
  assert.throws(() => jm.submit(S('x', { worker: 'ghost' })), /worker 'ghost' no existe; disponibles: luna-max, alt/);
  assert.equal(jm.list({}).length, 0);
});
test('explicit worker reaches the adapter; continue reuses it; summarize uses role worker', async () => {
  const log = path.join(tmp('colmena-log-'), 'f.log'); process.env.FAKE_LOG = log;
  try {
    const { jm } = mk();
    const id = jm.submit(S('uno', { worker: 'alt' })); await jm.wait([id]);
    assert.equal(jm.result(id).worker, 'alt');
    const id2 = jm.continueJob(id, 'sigue'); await jm.wait([id2]);
    assert.equal(jm.result(id2).worker, 'alt');
    const s = jm.summarize(id); await jm.wait([s]);
    assert.equal(jm.result(s).worker, 'luna-max');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls[0].argv[calls[0].argv.indexOf('-m') + 1], 'gpt-alt');
    assert.ok(calls[0].argv.includes('model_reasoning_effort="high"'));
    assert.equal(calls[1].argv[calls[1].argv.indexOf('-m') + 1], 'gpt-alt');
    assert.equal(calls[2].argv[calls[2].argv.indexOf('-m') + 1], 'gpt-6-luna');
  } finally { delete process.env.FAKE_LOG; }
});
test('artifact writes go through writeFileAtomic: rename failure keeps previous file and cleans temp', async () => {
  const config = getConfig(baseEnv(codexOnlyHome(), {}));
  const calls = [];
  const jm = createJobManager(config, {
    writeArtifact: (file, data) => {
      calls.push(path.basename(file));
      try {
        return writeFileAtomic(file, data, { renameSync: () => { throw new Error('rename falló'); } });
      } catch { return null; }
    },
  });
  const parent = jm.submit(S('padre'));
  await jm.wait([parent]);
  const parentDir = jm.jobDir(parent);
  fs.writeFileSync(path.join(parentDir, 'summary.md'), 'previo');
  const compactId = jm.compact(parent);
  await jm.wait([compactId], { timeoutS: 30 });
  assert.ok(calls.includes('summary.md'));
  assert.equal(fs.readFileSync(path.join(parentDir, 'summary.md'), 'utf8'), 'previo');
  assert.ok(fs.readdirSync(parentDir).every(f => !f.includes('.tmp')));
  assert.equal(jm.result(compactId).state, 'done');
});
test('compact job publishes summary.md and last_message.md complete, without temp files', async () => {
  const { jm } = mk();
  const parent = jm.submit(S('padre'));
  await jm.wait([parent]);
  const compactId = jm.compact(parent);
  await jm.wait([compactId]);
  const parentDir = jm.jobDir(parent);
  const compactDir = jm.jobDir(compactId);
  const summary = fs.readFileSync(path.join(parentDir, 'summary.md'), 'utf8');
  const lastMessage = fs.readFileSync(path.join(compactDir, 'last_message.md'), 'utf8');
  assert.equal(summary, lastMessage);
  assert.match(summary, /RESULT: ok/);
  assert.ok(fs.readdirSync(parentDir).every(f => !f.includes('.tmp')));
  assert.ok(fs.readdirSync(compactDir).every(f => !f.includes('.tmp')));
  assert.equal(jm.result(compactId).state, 'done');
});
test('job.started / job.finished events on the bus', async () => {
  const { jm } = mk(); const seen = [];
  jm.bus.on('job.started', e => seen.push(['s', e.worker, e.provider]));
  jm.bus.on('job.finished', e => seen.push(['f', e.state, e.provider]));
  const id = jm.submit(S('hola')); await jm.wait([id]);
  assert.deepEqual(seen, [['s', 'luna-max', 'codex'], ['f', 'done', 'codex']]);
});
test('MC-3: wait respeta el máximo configurado y el pendiente trae estado y progreso sin cancelar', async () => {
  const { jm } = mk({ COLMENA_WAIT_MAX_S: '2' });
  const id = jm.submit(S('SLEEP'));
  const t0 = Date.now();
  const w = await jm.wait([id], { timeoutS: 8 });
  const elapsed = (Date.now() - t0) / 1000;
  assert.equal(w.done.length, 0);
  assert.equal(w.pending.length, 1);
  assert.ok(elapsed < 5, `esperó ${elapsed}s, debió recortar al máximo configurado (2 s)`);
  assert.ok(elapsed >= 1.5, `esperó ${elapsed}s, debió esperar hasta el máximo configurado`);
  assert.equal(w.pending[0].id, id);
  assert.ok(['queued', 'running'].includes(w.pending[0].state), `state: ${w.pending[0].state}`);
  assert.equal(typeof w.pending[0].elapsedS, 'number');
  assert.ok(!['done', 'failed', 'cancelled', 'orphaned'].includes(jm.status(id).state), 'el vencimiento no debe cancelar el job');
  await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
  assert.equal(jm.status(id).state, 'cancelled');
});
test('MC-3: wait admite timeout_s por encima de 600 hasta el límite configurado', async () => {
  const { jm } = mk({ COLMENA_WAIT_MAX_S: '1800' });
  const id = jm.submit(S('hola'));
  const w = await jm.wait([id], { timeoutS: 1200 });
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].state, 'done');
});
test('MC-3: el vencimiento deja continuar esperando hasta el reporte', async () => {
  process.env.FAKE_DELAY = '1500';
  try {
    const { jm } = mk();
    const id = jm.submit(S('hola con demora'));
    const first = await jm.wait([id], { timeoutS: 1 });
    assert.equal(first.pending.length, 1);
    assert.equal(typeof first.pending[0].elapsedS, 'number');
    const second = await jm.wait([id], { timeoutS: 10 });
    assert.equal(second.done.length, 1);
    assert.equal(second.done[0].state, 'done');
  } finally { delete process.env.FAKE_DELAY; }
});
