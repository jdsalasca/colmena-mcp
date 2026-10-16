import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { formatOverview, notifyPlugin } from '../src/plugins/notify.js';
import { createNotifier } from '../src/notifier.js';
import { baseEnv, codexOnlyHome, tmp, here } from './helpers.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function setup(opts = {}, notifyCfg = {}) {
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const sent = [];
  const notifier = { send: n => sent.push(n) };
  const cfg = { enabled: true, on: ['start', 'finish', 'fail'], heartbeat_min: 10, ...notifyCfg };
  const plugin = notifyPlugin({ bus: jm.bus, jm, cfg, notifier, heartbeatMs: 80, debounceMs: 40, logPath: config.activityPath, ...opts });
  return { config, jm, sent, plugin };
}
const S = (task, extra = {}) => ({ task, cwd: tmp('colmena-c-'), isolation: 'inplace', ...extra });

function directNotify({ active = [], queued = 0, debounceMs = 0 } = {}) {
  const bus = new EventEmitter(); const sent = []; const timers = [];
  const logPath = path.join(tmp('colmena-notify-'), 'activity.log');
  let snapshot = { active, queued };
  const plugin = notifyPlugin({
    bus,
    jm: { active: () => snapshot.active, stats: () => ({ running: snapshot.active.length, queued: snapshot.queued }) },
    cfg: { enabled: true, on: ['start', 'finish', 'fail'], heartbeat_min: 10 },
    notifier: { send: n => sent.push(n) }, heartbeatMs: 100000, debounceMs, logPath,
    setIntervalFn: fn => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn() {},
  });
  return { bus, sent, plugin, logPath, timers, setSnapshot: next => { snapshot = next; } };
}

test('formatOverview groups running providers and reports queued/unknown work', () => {
  assert.equal(formatOverview([], 0), 'En curso: ninguno');
  assert.equal(formatOverview([{ provider: 'codex' }, { provider: 'codex' }], 0), 'En curso: codex 2');
  assert.equal(formatOverview([{ provider: 'opencode' }, { provider: 'codex' }], 0), 'En curso: codex 1 · opencode 1');
  assert.equal(formatOverview([{ provider: 'codex' }], 3), 'En curso: codex 1 · +3 en cola');
  assert.equal(formatOverview([], 2), 'En curso: ninguno · +2 en cola');
  assert.equal(formatOverview([{}], 0), 'En curso: desconocido 1');
});

test('notifications group starts by provider and append a fresh overview to all four types', async () => {
  const h = directNotify();
  h.setSnapshot({ active: [{ provider: 'codex' }, { provider: 'codex' }, { provider: 'opencode' }], queued: 1 });
  h.bus.emit('job.started', { worker: 'luna-max', provider: 'codex' });
  h.bus.emit('job.started', { worker: 'luna-max', provider: 'codex' });
  h.bus.emit('job.started', { worker: 'ds-flash', provider: 'opencode' });
  await sleep(25);
  const start = h.sent.find(n => n.kind === 'start');
  assert.match(start.body, /luna-max \(codex\)×2, ds-flash \(opencode\)/);
  assert.ok(start.body.endsWith('En curso: codex 2 · opencode 1 · +1 en cola'));

  h.setSnapshot({ active: [{ provider: 'codex' }], queued: 0 });
  h.bus.emit('job.finished', { worker: 'luna-max', provider: 'codex', task: 'terminar', state: 'done', costUsd: 0 });
  await sleep(25);
  const finish = h.sent.find(n => n.kind === 'finish');
  assert.match(finish.body, /^\[codex\] luna-max: terminar → terminó · \$0\.00/);
  assert.ok(finish.body.endsWith('En curso: codex 1'));

  h.setSnapshot({ active: [{ provider: 'desconocido' }], queued: 0 });
  h.bus.emit('job.finished', { worker: 'worker-x', task: 'rompió', state: 'failed', error: 'boom', costUsd: 0 });
  await sleep(25);
  const fail = h.sent.find(n => n.kind === 'fail');
  assert.match(fail.body, /^\[desconocido\] worker-x falló: boom/);
  assert.ok(fail.body.endsWith('En curso: desconocido 1'));

  h.setSnapshot({ active: [{ provider: 'opencode' }, { provider: 'opencode' }], queued: 2 });
  h.timers[0].fn();
  const heartbeat = h.sent.find(n => n.kind === 'heartbeat');
  assert.ok(heartbeat.body.endsWith('En curso: opencode 2 · +2 en cola'));
  const log = fs.readFileSync(h.logPath, 'utf8');
  assert.ok(log.includes(`${start.title}: ${start.body}`), 'activity.log keeps the complete sent body');
  h.plugin.stop();
});

test('finish toast truncates a long task while preserving the overview under 300 characters', async () => {
  const h = directNotify({ active: [{ provider: 'codex' }] });
  h.bus.emit('job.finished', { worker: 'luna-max', provider: 'codex', task: 't'.repeat(1000), state: 'done', costUsd: 0 });
  await sleep(25);
  const body = h.sent.find(n => n.kind === 'finish').body;
  assert.ok(body.length <= 300, `toast length=${body.length}`);
  assert.ok(body.includes('t'.repeat(60)));
  assert.ok(!body.includes('t'.repeat(61)));
  assert.ok(body.endsWith('En curso: codex 1'));
  h.plugin.stop();
});

test('3 launches inside the window → one start toast mentioning 3', async () => {
  const { jm, sent, plugin } = setup({ heartbeatMs: 100000 });
  const ids = [jm.submit(S('SLEEP a')), jm.submit(S('SLEEP b')), jm.submit(S('SLEEP c'))];
  await sleep(250);
  const starts = sent.filter(n => n.kind === 'start');
  assert.equal(starts.length, 1);
  assert.match(starts[0].body, /3/);
  assert.match(starts[0].body, /luna-max/);
  for (const id of ids) await jm.cancel(id);
  await jm.wait(ids, { timeoutS: 20 }); plugin.stop();
});
test('heartbeat while running; silent when idle', async () => {
  const { jm, sent, plugin } = setup({ heartbeatMs: 80 });
  await sleep(250);
  assert.equal(sent.filter(n => n.kind === 'heartbeat').length, 0);
  const id = jm.submit(S('SLEEP'));
  await sleep(450);
  const beats = sent.filter(n => n.kind === 'heartbeat');
  assert.ok(beats.length >= 2, `beats=${beats.length}`);
  assert.match(beats[0].body, /1 corriendo/);
  await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
  await sleep(150);
  const after = sent.filter(n => n.kind === 'heartbeat').length;
  await sleep(300);
  assert.equal(sent.filter(n => n.kind === 'heartbeat').length, after);
  plugin.stop();
});
test('finish and fail toasts', async () => {
  const { jm, sent, plugin } = setup({ heartbeatMs: 100000 });
  const ok = jm.submit(S('hola')); await jm.wait([ok]);
  await sleep(150);
  const fin = sent.find(n => n.kind === 'finish');
  assert.ok(fin); assert.match(fin.body, /luna-max/); assert.match(fin.body, /done|terminó/i);
  const bad = jm.submit(S('FAIL')); await jm.wait([bad]);
  await sleep(150);
  const fail = sent.find(n => n.kind === 'fail');
  assert.ok(fail); assert.match(fail.body, /boom/);
  plugin.stop();
});
test('"on" filter: only fail → no start/finish toasts', async () => {
  const { jm, sent, plugin } = setup({ heartbeatMs: 100000 }, { on: ['fail'] });
  const ok = jm.submit(S('hola')); await jm.wait([ok]); await sleep(150);
  assert.equal(sent.length, 0);
  plugin.stop();
});
test('activity.log gets lines even when toasts are off', async () => {
  const { config, jm, plugin } = setup({ heartbeatMs: 100000 });
  const ok = jm.submit(S('hola')); await jm.wait([ok]); await sleep(150);
  const log = fs.readFileSync(config.activityPath, 'utf8');
  assert.match(log, /start/); assert.match(log, /finish/);
  plugin.stop();
});
test('heartbeat timer does not keep the process alive', () => {
  const script = `
    import { notifyPlugin } from ${JSON.stringify('file:///' + path.join(here, '..', 'src', 'plugins', 'notify.js').replace(/\\/g, '/'))};
    const bus = new (await import('node:events')).EventEmitter();
    notifyPlugin({ bus, jm: { stats: () => ({ running: 0, queued: 0 }), active: () => [] }, cfg: { enabled: true, on: ['start'] }, notifier: { send() {} }, heartbeatMs: 50, debounceMs: 10, logPath: ${JSON.stringify(path.join(tmp('colmena-n-'), 'a.log'))} });
    console.log('done');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /done/);
});
test('update replaces notification filter and restarts heartbeat timer', async () => {
  const bus = new EventEmitter(); const timers = []; const cleared = []; const sent = [];
  const plugin = notifyPlugin({
    bus,
    jm: { stats: () => ({ running: 0, queued: 0 }), active: () => [] },
    cfg: { enabled: true, on: ['start'], heartbeat_min: 5 },
    notifier: { send: n => sent.push(n) }, debounceMs: 0,
    setIntervalFn: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn: timer => cleared.push(timer),
  });
  assert.equal(timers[0].ms, 300000);
  plugin.update({ enabled: true, on: ['finish'], heartbeat_min: 2 });
  assert.deepEqual(cleared, [timers[0]]);
  assert.equal(timers[1].ms, 120000);
  bus.emit('job.started', { worker: 'a' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.some(n => n.kind === 'start'), false);
  bus.emit('job.finished', { worker: 'a', task: 'x', state: 'done', costUsd: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.some(n => n.kind === 'finish'), true);
  plugin.update({ enabled: false, on: ['start'], heartbeat_min: 1 });
  assert.deepEqual(cleared, [timers[0], timers[1]]);
  assert.equal(timers.length, 2);
  plugin.stop();
});
test('createNotifier: none/log never throw; toast returns an object with send', () => {
  assert.doesNotThrow(() => createNotifier('none').send({ title: 't', body: 'b' }));
  assert.doesNotThrow(() => createNotifier('log').send({ title: 't', body: 'b' }));
  assert.equal(typeof createNotifier('toast').send, 'function');
});
