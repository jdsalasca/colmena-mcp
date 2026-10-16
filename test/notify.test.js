import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { formatOverview, notifyPlugin } from '../src/plugins/notify.js';
import { createNotifier } from '../src/notifier.js';
import { loadSettings } from '../src/settings.js';
import { buildServer } from '../src/tools.js';
import { baseEnv, codexOnlyHome, tmp, until, here } from './helpers.js';

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

function directNotify({ active = [], queued = 0, debounceMs = 0, workers = () => [] } = {}) {
  const bus = new EventEmitter(); const sent = []; const timers = [];
  const logPath = path.join(tmp('colmena-notify-'), 'activity.log');
  let snapshot = { active, queued };
  const plugin = notifyPlugin({
    bus,
    jm: {
      active: () => snapshot.active,
      stats: () => ({ running: snapshot.active.length, queued: snapshot.queued }),
      workers,
    },
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

const workerRow = (alias, { budget = 10, spent = 0, reserved = 0, free = false } = {}) =>
  ({ alias, free, budget_usd: budget, spent_usd: spent, reserved_usd: reserved });

test('presupuesto: aviso único al cruzar el umbral y otro al agotar el saldo', async () => {
  let rows = [];
  const h = directNotify({ workers: () => rows, active: [{ provider: 'codex' }] });
  const finish = () => h.bus.emit('job.finished', { worker: 'flash', provider: 'opencode', task: 'x', state: 'done', costUsd: 0 });

  rows = [workerRow('flash', { spent: 7.9 })];
  finish();
  await sleep(10);
  assert.equal(h.sent.filter(n => n.kind === 'budget').length, 0, 'por debajo del umbral no hay aviso');

  rows = [workerRow('flash', { spent: 6, reserved: 2.1 })];
  finish();
  await sleep(10);
  let alerts = h.sent.filter(n => n.kind === 'budget');
  assert.equal(alerts.length, 1, 'cruzar el 80% emite un único aviso');
  assert.match(alerts[0].body, /flash/);
  assert.match(alerts[0].body, /8\.10 de \$10\.00/);

  finish();
  await sleep(10);
  assert.equal(h.sent.filter(n => n.kind === 'budget').length, 1, 'el mismo cruce no repite el aviso');

  rows = [workerRow('flash', { spent: 9.99, reserved: 0.01 })];
  finish();
  await sleep(10);
  alerts = h.sent.filter(n => n.kind === 'budget');
  assert.equal(alerts.length, 2, 'agotar el saldo emite otro aviso');
  assert.match(alerts[1].body, /agotó/);

  const log = fs.readFileSync(h.logPath, 'utf8');
  assert.equal((log.match(/\[budget\]/g) ?? []).length, 2, 'activity.log guarda ambos avisos');
  h.plugin.stop();
});

test('budget_pct 0 silencia; free y sin budget nunca avisan; update recoge el knob', async () => {
  const rows = [
    workerRow('flash', { spent: 9 }),
    workerRow('free', { spent: 9, free: true }),
    workerRow('sin-budget', { spent: 9, budget: null }),
  ];
  const h = directNotify({ workers: () => rows });
  h.plugin.update({ enabled: true, on: ['start', 'finish', 'fail'], heartbeat_min: 10, budget_pct: 0 });
  h.bus.emit('job.finished', { worker: 'flash', provider: 'opencode', task: 'x', state: 'done', costUsd: 0 });
  await sleep(10);
  assert.equal(h.sent.filter(n => n.kind === 'budget').length, 0, 'budget_pct 0 desactiva los avisos');

  h.plugin.update({ enabled: true, on: ['start', 'finish', 'fail'], heartbeat_min: 10, budget_pct: 50 });
  h.bus.emit('job.finished', { worker: 'flash', provider: 'opencode', task: 'x', state: 'done', costUsd: 0 });
  await sleep(10);
  const alerts = h.sent.filter(n => n.kind === 'budget');
  assert.equal(alerts.length, 1, 'solo avisa el worker con budget por encima del umbral');
  assert.match(alerts[0].body, /flash/);
  h.plugin.stop();
});

test('plugins.notify.budget_pct: defecto 80, override y validación', () => {
  const defaultsHome = tmp('colmena-budget-');
  assert.equal(loadSettings(defaultsHome, {}).plugins.notify.budget_pct, 80);

  const ymlHome = tmp('colmena-budget-');
  fs.writeFileSync(path.join(ymlHome, 'colmena.yml'),
    'workers: {solo: {provider: codex, model: m}}\ndefaults: {worker: solo}\nroles: {reporter: solo, summarizer: solo, reviewer: solo, presenter: solo}\nplugins: {notify: {budget_pct: 50}}\n');
  assert.equal(loadSettings(ymlHome, {}).plugins.notify.budget_pct, 50);

  const badHome = tmp('colmena-budget-');
  fs.writeFileSync(path.join(badHome, 'colmena.yml'), 'plugins: {notify: {budget_pct: 150}}\n');
  assert.throws(() => loadSettings(badHome, {}), /plugins\.notify\.budget_pct/);
});

test('reload_config recoge plugins.notify.budget_pct para el siguiente job', async () => {
  const home = codexOnlyHome();
  const file = path.join(home, 'colmena.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace('strengths: [code]}', 'strengths: [code], budget: {monthly_usd: 10}}')
    .replace('notify: {enabled: false}', 'notify: {enabled: true, budget_pct: 0}'));
  const ym = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ [ym]: { 'luna-max': { runs: 1, input_tokens: 0, output_tokens: 0, cost_usd: 9 } } }));

  const config = getConfig(baseEnv(home));
  const { server } = buildServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'budget-reload-test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  try {
    const logText = () => (fs.existsSync(config.activityPath) ? fs.readFileSync(config.activityPath, 'utf8') : '');
    const first = await call('run', { task: 'hola', cwd: tmp('colmena-budget-c-'), isolation: 'inplace', wait: true });
    assert.equal(first.state, 'done');
    await until(() => logText().includes('[finish]'), 'el aviso de término debe quedar en activity.log', 6000);
    assert.equal(logText().includes('[budget]'), false, 'budget_pct 0 silencia el aviso');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('budget_pct: 0', 'budget_pct: 50'));
    assert.ok((await call('reload_config', {})).plugins.includes('notify.budget_pct'));

    const second = await call('run', { task: 'hola', cwd: tmp('colmena-budget-c-'), isolation: 'inplace', wait: true });
    assert.equal(second.state, 'done');
    await until(() => logText().includes('[budget]'), 'reload_config aplica budget_pct al siguiente job', 6000);
    assert.match(logText(), /\[budget\] Colmena · presupuesto: worker luna-max/);
  } finally {
    await client.close();
    await server.close();
  }
});
