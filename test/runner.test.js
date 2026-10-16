import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { startRun } from '../src/runner.js';
import { getAdapter } from '../src/providers/index.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.js');
const fakeEnv = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-env.js');
const cfg = () => getConfig({ COLMENA_CODEX_BIN: fake, COLMENA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-r-')) });
const codex = getAdapter('codex');
const luna = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
const base = { workdir: 'C:\\w d', lastMessagePath: 'C:\\o.md', readonly: false, worker: luna };

test('getAdapter: known and unknown', () => {
  assert.equal(getAdapter('codex').id, 'codex');
  assert.throws(() => getAdapter('nope'), /proveedor/);
});
test('codex buildArgs: model/effort from worker, search before exec, bypass', () => {
  const a = codex.buildArgs({ ...base, prompt: 'hola' });
  assert.equal(a[0], '--search');
  assert.equal(a[1], 'exec');
  assert.ok(a.includes('--json'));
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(a.includes('model_reasoning_effort="max"'));
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(a[a.indexOf('-C') + 1], 'C:\\w d');
  assert.equal(a[a.length - 1], 'hola');
});
test('codex buildArgs: another worker is reflected; no effort → no -c', () => {
  const a = codex.buildArgs({ ...base, prompt: 'x', worker: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'high' } });
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-5.6-terra');
  assert.ok(a.includes('model_reasoning_effort="high"'));
  const b = codex.buildArgs({ ...base, prompt: 'x', worker: { provider: 'codex', model: 'm' } });
  assert.ok(!b.some(x => x.startsWith('model_reasoning_effort')));
});
test('codex buildArgs: readonly uses -s read-only, no bypass', () => {
  const a = codex.buildArgs({ ...base, readonly: true, prompt: 'x' });
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('codex buildArgs: resume + ephemeral + hostile prompt stays one argv', () => {
  const p = 'a "b"\n$x `y` \'z\'';
  const a = codex.buildArgs({ ...base, prompt: p, resumeSessionId: 'S1', ephemeral: true });
  assert.deepEqual(a.slice(1, 4), ['exec', 'resume', 'S1']);
  assert.ok(a.includes('--ephemeral'));
  assert.equal(a[a.length - 1], p);
});
test('codex parseLine verified events and garbage', () => {
  const { parseLine } = codex;
  assert.deepEqual(parseLine('{"type":"thread.started","thread_id":"T"}'), { kind: 'session', sessionId: 'T' });
  assert.deepEqual(parseLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'), { kind: 'message', text: 'hi' });
  assert.equal(parseLine('{"type":"turn.completed","usage":{"output_tokens":5}}').kind, 'usage');
  assert.equal(parseLine('not json').kind, 'other');
  assert.equal(parseLine('{"type":"turn.started"}').kind, 'other');
  assert.equal(parseLine('').kind, 'other');
});
const run = (c, dir, prompt, extra = {}) => startRun(c.codex, codex.buildArgs({ prompt, workdir: dir, lastMessagePath: path.join(dir, 'last.md'), readonly: true, worker: luna }), { cwd: dir, parseLine: codex.parseLine, logPath: path.join(dir, 'events.jsonl'), onEvent() {}, ...extra });

test('startRun with fake: events, exit 0, -o file, log', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-w-'));
  const evs = [];
  const r = await run(c, dir, 'hola', { onEvent: e => evs.push(e) }).done;
  assert.equal(r.code, 0);
  assert.ok(evs.some(e => e.kind === 'session'));
  assert.ok(evs.some(e => e.kind === 'message' && /RESULT/.test(e.text)));
  assert.match(fs.readFileSync(path.join(dir, 'last.md'), 'utf8'), /RESULT/);
  assert.ok(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('thread.started'));
});
test('startRun merges optional env into the child process environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-env-'));
  const previous = process.env.COLMENA_RUNNER_INHERITED;
  process.env.COLMENA_RUNNER_INHERITED = 'inherited';
  try {
    const events = [];
    const r = startRun({ bin: process.execPath, prefixArgs: [fakeEnv] }, [], {
      cwd: dir,
      env: { COLMENA_RUNNER_TEST: 'overridden' },
      parseLine: line => JSON.parse(line),
      onEvent: event => events.push(event),
    });
    assert.equal((await r.done).code, 0);
    assert.deepEqual(events, [{ setting: 'overridden', inherited: 'inherited' }]);
  } finally {
    if (previous === undefined) delete process.env.COLMENA_RUNNER_INHERITED;
    else process.env.COLMENA_RUNNER_INHERITED = previous;
  }
});
test('startRun FAIL → code 1 + stderr tail', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-w-'));
  const r = await run(c, dir, 'FAIL').done;
  assert.equal(r.code, 1);
  assert.match(r.stderrTail, /boom/);
});
test('kill ends a hanging process', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-w-'));
  const h = run(c, dir, 'SLEEP');
  await new Promise(r => setTimeout(r, 500));
  await h.kill();
  assert.notEqual((await h.done).code, 0);
});
