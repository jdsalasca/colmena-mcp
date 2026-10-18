import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { baseEnv, codexOnlyHome, tmp, until } from './helpers.js';

const mk = (env = {}, options = {}) => {
  const config = getConfig(baseEnv(codexOnlyHome(), env));
  return { jm: createJobManager(config, options), config };
};
const S = (task, extra = {}) => ({ task, cwd: tmp('luna-act-'), isolation: 'inplace', ...extra });
const appendEvent = (jm, id, event) => fs.appendFileSync(path.join(jm.jobDir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
const toolEvent = command => ({ type: 'item.completed', item: { id: 'i-sintetico', type: 'command_execution', command, status: 'completed' } });

test('status y list exponen lastActivityAt, idleS y lastTool de eventos sinteticos', async () => {
  let clock = 1_000_000_000;
  const { jm } = mk({ COLMENA_STALL_TIMEOUT_MIN: '2' }, { now: () => clock, snapshot: () => [] });
  const id = jm.submit(S('SLEEP'));
  try {
    await until(() => jm.meta(id).state === 'running' && (jm.meta(id).logOffset ?? 0) > 0, 'el job debe correr y persistir eventos');
    appendEvent(jm, id, toolEvent('npm test'));
    await until(() => jm.status(id).lastTool === 'command: npm test', 'lastTool debe reflejar el evento sintetico');

    const alive = jm.status(id);
    assert.equal(alive.state, 'running');
    assert.equal(typeof alive.lastActivityAt, 'number');
    assert.equal(alive.idleS, 0);
    assert.equal(alive.looksStalled, undefined);

    clock += 61_000; // umbral = stall_timeout_min / 2 = 1 min
    const stale = jm.status(id);
    assert.equal(stale.idleS, 61);
    assert.equal(stale.looksStalled, true);
    const row = jm.list({}).find(job => job.id === id);
    assert.equal(row.lastTool, 'command: npm test');
    assert.equal(row.looksStalled, true);
  } finally {
    await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
  }
});

test('pending de wait incluye la actividad y lastTool es null sin llamadas a herramienta', async () => {
  const { jm } = mk();
  const id = jm.submit(S('SLEEP'));
  try {
    const w = await jm.wait([id], { timeoutS: 1 });
    assert.equal(w.pending.length, 1);
    const pending = w.pending[0];
    assert.equal(typeof pending.lastActivityAt, 'number');
    assert.equal(typeof pending.idleS, 'number');
    assert.equal(pending.lastTool, null);
    assert.equal(pending.looksStalled, undefined);
    assert.equal(jm.status(id).lastTool, null);
  } finally {
    await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
  }
});

test('lastTool se recorta a 80 caracteres', async () => {
  const { jm } = mk({}, { now: () => 2_000_000_000, snapshot: () => [] });
  const id = jm.submit(S('SLEEP'));
  try {
    await until(() => (jm.meta(id).logOffset ?? 0) > 0, 'el job debe persistir eventos');
    appendEvent(jm, id, toolEvent('x'.repeat(200)));
    await until(() => jm.status(id).lastTool != null, 'lastTool debe aparecer');
    assert.equal(jm.status(id).lastTool, `command: ${'x'.repeat(71)}`);
    assert.equal(jm.status(id).lastTool.length, 80);
  } finally {
    await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
  }
});

test('el lastTool persiste en meta y sobrevive al termine del job', async () => {
  process.env.FAKE_DELAY = '700';
  try {
    const { jm } = mk();
    const id = jm.submit(S('hola'));
    await until(() => jm.status(id).state === 'running' && (jm.meta(id).logOffset ?? 0) > 0, 'el job debe correr y persistir eventos');
    appendEvent(jm, id, toolEvent('npm run lint'));
    await jm.wait([id], { timeoutS: 20 });
    assert.equal(jm.result(id).state, 'done');
    assert.equal(jm.meta(id).lastTool, 'command: npm run lint');
    assert.equal(jm.status(id).lastTool, 'command: npm run lint');
    assert.equal(jm.status(id).lastActivityAt, jm.meta(id).endedAt);
  } finally {
    delete process.env.FAKE_DELAY;
  }
});
