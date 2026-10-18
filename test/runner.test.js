import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { attachRun, startRun, tail } from '../src/runner.js';
import { getAdapter } from '../src/providers/index.js';
import { fakeCodex, fakeOpencode, tmp } from './helpers.js';

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
test('codex parseLine: los items de herramienta exponen la última llamada', () => {
  const { parseLine } = codex;
  assert.deepEqual(parseLine('{"type":"item.started","item":{"id":"i","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}'), { kind: 'tool', tool: 'command: bash -lc ls' });
  assert.deepEqual(parseLine('{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"src/a.js"},{"path":"src/b.js"}],"status":"completed"}}'), { kind: 'tool', tool: 'file_change: src/a.js, src/b.js' });
  assert.deepEqual(parseLine('{"type":"item.completed","item":{"type":"mcp_tool_call","server":"colmena","tool":"wait"}}'), { kind: 'tool', tool: 'mcp: colmena.wait' });
  assert.deepEqual(parseLine('{"type":"item.completed","item":{"type":"web_search","query":"opencode json"}}'), { kind: 'tool', tool: 'web_search: opencode json' });
  assert.equal(parseLine('{"type":"item.completed","item":{"type":"reasoning","text":"pensando"}}').kind, 'other');
});
test('Codex completion signal is turn usage after a final message', () => {
  assert.equal(codex.completesOn(codex.parseLine('{"type":"turn.completed","usage":{}}')), true);
  assert.equal(codex.completesOn(codex.parseLine('{"type":"turn.started"}')), false);
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
test('attachRun follows appended JSONL from a byte offset and holds partial lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-attach-'));
  const logPath = path.join(dir, 'events.jsonl');
  const first = Buffer.from('{"value":1}\n');
  fs.writeFileSync(logPath, Buffer.concat([first, Buffer.from('{"value":')]));
  const events = [];
  let alive = true;
  const handle = attachRun({
    pid: process.pid,
    logPath,
    offset: 0,
    parseLine: line => JSON.parse(line),
    onEvent: (event, offset) => events.push({ event, offset }),
    isAlive: () => alive,
    pollIntervalMs: 10,
    isDelivered: () => true,
  });
  const until = async predicate => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'condition should become true');
  };

  await until(() => events.length === 1);
  assert.deepEqual(events[0], { event: { value: 1 }, offset: first.length });
  assert.equal(events.length, 1);

  fs.appendFileSync(logPath, '2}\n');
  await until(() => events.length === 2);
  assert.deepEqual(events[1], { event: { value: 2 }, offset: fs.statSync(logPath).size });
  alive = false;
  assert.equal((await handle.done).code, 0);
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
test('tail: archivo grande se resume sin leerlo completo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-tail-'));
  const file = path.join(dir, 'stderr.log');
  const lines = Array.from({ length: 200000 }, (_, i) => `line ${i}`).join('\\n') + '\\nFINAL TAIL LINE\\n';
  fs.writeFileSync(file, lines);
  const original = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('tail no debe usar readFileSync'); };
  try {
    const out = tail(file);
    assert.match(out, /FINAL TAIL LINE/);
    assert.ok(out.split('\n').length <= 20);
  } finally {
    fs.readFileSync = original;
  }
});
test('tail: archivo ausente o vacío devuelve cadena vacía', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-tail-'));
  assert.equal(tail(path.join(dir, 'nope.log')), '');
  const empty = path.join(dir, 'empty.log');
  fs.writeFileSync(empty, '');
  assert.equal(tail(empty), '');
});
test('startRun FAIL → code 1 + stderr tail', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-w-'));
  const r = await run(c, dir, 'FAIL').done;
  assert.equal(r.code, 1);
  assert.match(r.stderrTail, /boom/);
  assert.match(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'), /boom/);
});
test('kill ends a hanging process', async () => {
  const c = cfg(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-w-'));
  const h = run(c, dir, 'SLEEP');
  await new Promise(r => setTimeout(r, 500));
  await h.kill();
  assert.notEqual((await h.done).code, 0);
});

test('codex resume: no -C/-s (real resume rejects them); readonly via sandbox_mode config', () => {
  const a = codex.buildArgs({ ...base, prompt: 'x', resumeSessionId: 'S1' });
  assert.ok(!a.includes('-C') && !a.includes('-s'));
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(a[a.length - 1], 'x');
  const ro = codex.buildArgs({ ...base, prompt: 'x', resumeSessionId: 'S1', readonly: true });
  assert.ok(!ro.includes('-C') && !ro.includes('-s') && !ro.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(ro.includes('sandbox_mode="read-only"'));
});

// Contract smoke (scripts/smoke.js) exercised against the fakes: no network, real provider CLI shims.
const smoke = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'smoke.js');
const smokeHome = () => {
  const home = tmp('colmena-sm-home-');
  const yml = path.join(home, 'colmena.yml');
  fs.writeFileSync(yml, `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, effort: max, priority: 1}
  ds-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, effort: max, priority: 3}
roles: {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max}
defaults: {worker: luna-max, max_parallel: 2}
plugins:
  notify: {enabled: false}
  report: {enabled: false}
  present: {enabled: false}
  improve: {enabled: false}
  widget: {enabled: false}`);
  return { home, yml };
};
const runSmoke = (extraEnv = {}, argv = ['luna-max,ds-flash']) => {
  const { home, yml } = smokeHome();
  const res = spawnSync(process.execPath, [smoke, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, COLMENA_HOME: home, COLMENA_CONFIG: yml, COLMENA_CODEX_BIN: fakeCodex, COLMENA_OPENCODE_BIN: fakeOpencode, COLMENA_NOTIFIER: 'none', ...extraEnv },
  });
  const out = res.stdout + res.stderr;
  return { status: res.status, out, homeLine: /^home: (.*)$/m.exec(out)?.[1], cwdLine: /^cwd: (.*)$/m.exec(out)?.[1] };
};

test('fake-codex: FAKE_NO_FINAL omits turn.completed; FAKE_EXPOSE_MODEL exposes it', () => {
  const dir = tmp('colmena-sm-fc-');
  const out = path.join(dir, 'out.md');
  const run = env => spawnSync(process.execPath, [fakeCodex, '-C', dir, '-o', out, 'hola'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.ok(!run({ FAKE_NO_FINAL: '1' }).stdout.includes('turn.completed'));
  assert.ok(run({}).stdout.includes('turn.completed'));
  assert.ok(run({ FAKE_EXPOSE_MODEL: 'gpt-6-luna' }).stdout.includes('"model":"gpt-6-luna"'));
});
test('fake-opencode: FAKE_EXPOSE_MODEL exposes a model id in events', () => {
  const dir = tmp('colmena-sm-fo-');
  const res = spawnSync(process.execPath, [fakeOpencode, '--dir', dir, 'hola'], { encoding: 'utf8', env: { ...process.env, FAKE_EXPOSE_MODEL: 'oc-expuesto' } });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('"model":"oc-expuesto"'));
});
test('smoke con fakes: contrato OK por proveedor, no afirma modelo sin exponer y limpia temporales', () => {
  const r = runSmoke();
  assert.equal(r.status, 0, r.out);
  for (const worker of ['luna-max', 'ds-flash']) for (const label of ['worker', 'reporte', 'señal-final', 'modelo']) assert.ok(r.out.includes(`[${worker}] ${label}:`), `falta [${worker}] ${label}`);
  assert.match(r.out, /modelo: OK .*no expuesto.*no se afirma modelo ejecutado/);
  assert.ok(r.homeLine && !fs.existsSync(r.homeLine), 'home temporal eliminado');
  assert.ok(r.cwdLine && !fs.existsSync(r.cwdLine), 'cwd temporal eliminado');
});
test('smoke: reporte inválido → exit 1, nombra la comprobación y limpia temporales', () => {
  const r = runSmoke({ FAKE_RAW: 'texto sin formato' });
  assert.equal(r.status, 1);
  assert.match(r.out, /reporte: FALLO/);
  assert.ok(r.homeLine && !fs.existsSync(r.homeLine), 'temporales limpiados incluso en fallo');
});
test('smoke: señal final ausente en codex → exit 1; opencode no falla por no emitirla', () => {
  const r = runSmoke({ FAKE_NO_FINAL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.out, /\[luna-max\] señal-final: FALLO/);
  assert.match(r.out, /\[ds-flash\] señal-final: OK/);
});
test('smoke: modelo expuesto distinto → exit 1; expuesto igual → OK', () => {
  const bad = runSmoke({ FAKE_EXPOSE_MODEL: 'gpt-6-otra' }, ['luna-max']);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /modelo: FALLO/);
  const good = runSmoke({ FAKE_EXPOSE_MODEL: 'gpt-6-luna' }, ['luna-max']);
  assert.equal(good.status, 0);
  assert.match(good.out, /modelo: OK/);
});
