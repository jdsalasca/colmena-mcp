import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { buildArgs, parseLine, startRun } from '../src/runner.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.js');
const cfg = () => getConfig({ LUNA_CODEX_BIN: fake, LUNA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'luna-r-')) });
const base = { workdir: 'C:\w d', lastMessagePath: 'C:\o.md', readonly: false };

test('buildArgs: fixed model/effort, search before exec, bypass', () => {
  const a = buildArgs({ ...base, prompt: 'hola' });
  assert.equal(a[0], '--search');
  assert.equal(a[1], 'exec');
  assert.ok(a.includes('--json'));
  assert.ok(a.includes('gpt-6-luna') && a[a.indexOf('gpt-6-luna') - 1] === '-m');
  assert.ok(a.includes('model_reasoning_effort="max"'));
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(a[a.indexOf('-C') + 1], 'C:\w d');
  assert.equal(a[a.length - 1], 'hola');
});
test('buildArgs: readonly uses -s read-only, no bypass', () => {
  const a = buildArgs({ ...base, readonly: true, prompt: 'x' });
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('buildArgs: resume + ephemeral + hostile prompt stays one argv', () => {
  const p = 'a "b"\n$x `y` \'z\'';
  const a = buildArgs({ ...base, prompt: p, resumeSessionId: 'S1', ephemeral: true });
  assert.deepEqual(a.slice(1, 4), ['exec', 'resume', 'S1']);
  assert.ok(a.includes('--ephemeral'));
  assert.equal(a[a.length - 1], p);
});
test('parseLine verified events and garbage', () => {
  assert.deepEqual(parseLine('{"type":"thread.started","thread_id":"T"}'), { kind: 'session', sessionId: 'T' });
  assert.deepEqual(parseLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}'), { kind: 'message', text: 'hi' });
  assert.equal(parseLine('{"type":"turn.completed","usage":{"output_tokens":5}}').kind, 'usage');
  assert.equal(parseLine('not json').kind, 'other');
  assert.equal(parseLine('{"type":"turn.started"}').kind, 'other');
  assert.equal(parseLine('').kind, 'other');
});
test('startRun with fake: events, exit 0, -o file, log', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-w-'));
  const out = path.join(dir, 'last.md'); const log = path.join(dir, 'events.jsonl');
  const evs = [];
  const h = startRun(c, buildArgs({ prompt: 'hola', workdir: dir, lastMessagePath: out, readonly: true }), { cwd: dir, onEvent: e => evs.push(e), logPath: log });
  const r = await h.done;
  assert.equal(r.code, 0);
  assert.ok(evs.some(e => e.kind === 'session'));
  assert.ok(evs.some(e => e.kind === 'message' && /RESULT/.test(e.text)));
  assert.match(fs.readFileSync(out, 'utf8'), /RESULT/);
  assert.ok(fs.readFileSync(log, 'utf8').includes('thread.started'));
});
test('startRun FAIL → code 1 + stderr tail', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-w-'));
  const r = await startRun(c, buildArgs({ prompt: 'FAIL', workdir: dir, lastMessagePath: path.join(dir, 'o'), readonly: true }), { cwd: dir, onEvent() {}, logPath: path.join(dir, 'l') }).done;
  assert.equal(r.code, 1);
  assert.match(r.stderrTail, /boom/);
});
test('kill ends a hanging process', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-w-'));
  const h = startRun(c, buildArgs({ prompt: 'SLEEP', workdir: dir, lastMessagePath: path.join(dir, 'o'), readonly: true }), { cwd: dir, onEvent() {}, logPath: path.join(dir, 'l') });
  await new Promise(r => setTimeout(r, 500));
  await h.kill();
  const r = await h.done;
  assert.notEqual(r.code, 0);
});
