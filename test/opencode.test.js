import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { getAdapter } from '../src/providers/index.js';
import { baseEnv, tmp, fakeOpencode, fakeCodex } from './helpers.js';

const oc = getAdapter('opencode');
const flash = { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max' };
const base = { workdir: 'C:\\w d', lastMessagePath: 'unused', readonly: false, worker: flash };

test('opencode buildArgs: model, variant, auto, pure, dir; prompt last and intact', () => {
  const p = 'a "b"\n$x `y`';
  const a = oc.buildArgs({ ...base, prompt: p });
  assert.deepEqual(a.slice(0, 2), ['run', '--format']);
  assert.equal(a[a.indexOf('--format') + 1], 'json');
  assert.ok(a.includes('--pure') && a.includes('--auto'));
  assert.equal(a[a.indexOf('-m') + 1], 'opencode-go/deepseek-v4.1-flash');
  assert.equal(a[a.indexOf('--variant') + 1], 'max');
  assert.equal(a[a.indexOf('--dir') + 1], 'C:\\w d');
  assert.ok(!a.includes('--agent'));
  assert.equal(a[a.length - 1], p);
});
test('opencode buildArgs: readonly → --agent plan; resume → -s; no effort → no --variant', () => {
  const a = oc.buildArgs({ ...base, prompt: 'x', readonly: true, resumeSessionId: 'ses_1', worker: { provider: 'opencode', model: 'm' } });
  assert.equal(a[a.indexOf('--agent') + 1], 'plan');
  assert.equal(a[a.indexOf('-s') + 1], 'ses_1');
  assert.ok(!a.includes('--variant'));
});
test('opencode parseLine: session, text, usage with cost, garbage', () => {
  const { parseLine } = oc;
  assert.deepEqual(parseLine('{"type":"step_start","sessionID":"ses_9"}'), { kind: 'session', sessionId: 'ses_9' });
  assert.deepEqual(parseLine('{"type":"text","part":{"text":"hola"}}'), { kind: 'message', text: 'hola' });
  const u = parseLine('{"type":"step_finish","part":{"tokens":{"input":10,"output":2,"reasoning":1},"cost":0.5}}');
  assert.deepEqual(u, { kind: 'usage', usage: { input_tokens: 10, output_tokens: 2, reasoning_tokens: 1, cost_usd: 0.5 } });
  assert.equal(parseLine('nope').kind, 'other');
  assert.equal(parseLine('{"type":"tool_use"}').kind, 'other');
});
test('opencode parseLine: provider error events expose message and retryable', () => {
  const { parseLine } = oc;
  const unknown = parseLine('{"type":"error","timestamp":1,"sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_ae29f0e4"}}}');
  assert.deepEqual(unknown, { kind: 'error', message: 'Unexpected server error. Check server logs for details.', retryable: true });
  const api = parseLine(`{"type":"error","error":{"name":"APIError","data":{"message":"Upstream request failed: [invalid_value] Invalid value for 'tools': maximum number of items is 128.","statusCode":400,"isRetryable":false}}}`);
  assert.deepEqual(api, { kind: 'error', message: "Upstream request failed: [invalid_value] Invalid value for 'tools': maximum number of items is 128.", retryable: false });
  assert.equal(parseLine('{"type":"error","error":{"name":"APIError","data":{"message":"busy","isRetryable":true}}}').retryable, true);
  assert.deepEqual(parseLine('{"type":"error","error":{"name":"Mystery"}}'), { kind: 'error', message: 'Mystery', retryable: false });
});
test('OpenCode step_finish is not a reliable end-of-turn signal', () => {
  assert.equal(oc.completesOn(oc.parseLine('{"type":"step_finish","part":{"tokens":{}}}')), false);
});
test('opencode env isolates config by default and creates the selected config directory', () => {
  const home = tmp('colmena-oc-env-');
  const isolatedPath = path.join(home, 'opencode-config');
  assert.deepEqual(oc.env({ home, settings: { providers: { opencode: { isolate_config: true } } } }), {
    XDG_CONFIG_HOME: isolatedPath,
  });
  assert.ok(fs.statSync(isolatedPath).isDirectory());
  const relativeHome = path.relative(process.cwd(), home);
  assert.equal(oc.env({ home: relativeHome, settings: { providers: { opencode: { isolate_config: true } } } }).XDG_CONFIG_HOME,
    path.resolve(relativeHome, 'opencode-config'));

  const customPath = path.join(home, 'custom-config');
  assert.deepEqual(oc.env({ home, settings: { providers: { opencode: { isolate_config: true, config_dir: customPath } } } }), {
    XDG_CONFIG_HOME: customPath,
  });
  assert.ok(fs.statSync(customPath).isDirectory());
  assert.equal(oc.env({ home, settings: { providers: { opencode: { isolate_config: false } } } }), undefined);
});

function ocHome(extra = '', defaultsLine = 'defaults: {worker: luna-max}') {
  const home = tmp('colmena-oh-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, effort: max, priority: 1}
  ds-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, effort: max, priority: 3}
roles: {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max}
${defaultsLine}
plugins: {notify: {enabled: false}}
${extra}`);
  return home;
}
const mk = () => {
  const config = getConfig({ ...baseEnv(ocHome()), COLMENA_OPENCODE_BIN: fakeOpencode });
  return { jm: createJobManager(config), config };
};
const S = (task, extra = {}) => ({ task, cwd: tmp('colmena-c-'), isolation: 'inplace', ...extra });

test('OpenCode job conserva modelo, proveedor y esfuerzo del worker', async () => {
  const { jm } = mk();
  const id = jm.submit(S('metadatos', { worker: 'ds-flash' }));
  const expected = { model: 'opencode-go/deepseek-v4.1-flash', provider: 'opencode', effort: 'max' };

  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.meta(id)[key]])), expected);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.status(id)[key]])), expected);
  await jm.wait([id]);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, jm.result(id)[key]])), expected);
});

test('OpenCode jobs pass the configured XDG_CONFIG_HOME to the fake process', async () => {
  const log = path.join(tmp('colmena-oc-config-log-'), 'fake.log');
  const previousLog = process.env.FAKE_LOG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.FAKE_LOG = log;
  process.env.XDG_CONFIG_HOME = 'inherited-opencode-config';
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  try {
    const standard = mk();
    const first = standard.jm.submit(S('default isolation', { worker: 'ds-flash' }));
    await standard.jm.wait([first]);
    assert.equal(calls()[0].xdgConfigHome, path.join(standard.config.home, 'opencode-config'));
    assert.ok(fs.statSync(path.join(standard.config.home, 'opencode-config')).isDirectory());

    const disabled = getConfig({ ...baseEnv(ocHome('providers: {opencode: {isolate_config: false}}\n')), COLMENA_OPENCODE_BIN: fakeOpencode });
    const disabledManager = createJobManager(disabled);
    const second = disabledManager.submit(S('disabled isolation', { worker: 'ds-flash' }));
    await disabledManager.wait([second]);
    assert.equal(calls()[1].xdgConfigHome, 'inherited-opencode-config');

    const customPath = path.join(tmp('colmena-oc-custom-'), 'config');
    const yamlPath = customPath.replaceAll('\\', '/');
    const custom = getConfig({ ...baseEnv(ocHome(`providers:\n  opencode: {config_dir: '${yamlPath}'}\n`)), COLMENA_OPENCODE_BIN: fakeOpencode });
    const customManager = createJobManager(custom);
    const third = customManager.submit(S('custom isolation', { worker: 'ds-flash' }));
    await customManager.wait([third]);
    assert.equal(calls()[2].xdgConfigHome, path.resolve(customPath));
    assert.ok(fs.statSync(customPath).isDirectory());
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_LOG;
    else process.env.FAKE_LOG = previousLog;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test('end-to-end opencode worker: last text wins, cost summed, session saved', async () => {
  const { jm } = mk();
  const id = jm.submit(S('hola', { worker: 'ds-flash' })); await jm.wait([id]);
  const r = jm.result(id, { detail: 'normal' });
  assert.equal(r.state, 'done');
  assert.equal(r.worker, 'ds-flash');
  assert.match(r.report.RESULT, /^ok oc/);
  assert.equal(r.cost_usd, 0.02);
  assert.match(r.sessionId, /^ses_/);
});
test('opencode continue passes -s; summarize (role ds-flash) runs with --agent plan', async () => {
  const log = path.join(tmp('colmena-ol-'), 'f.log'); process.env.FAKE_LOG = log;
  try {
    const { jm } = mk();
    const id = jm.submit(S('uno', { worker: 'ds-flash' })); await jm.wait([id]);
    const sid = jm.result(id, { detail: 'normal' }).sessionId;
    const c = jm.continueJob(id, 'sigue'); await jm.wait([c]);
    const s = jm.summarize(id); await jm.wait([s]);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls[1].argv[calls[1].argv.indexOf('-s') + 1], sid);
    assert.equal(calls[2].argv[calls[2].argv.indexOf('--agent') + 1], 'plan');
    assert.equal(jm.result(s).state, 'done');
  } finally { delete process.env.FAKE_LOG; }
});
test('opencode failure keeps stderr; cancel kills it', async () => {
  const { jm } = mk();
  const f = jm.submit(S('FAIL', { worker: 'ds-flash' })); await jm.wait([f]);
  assert.match(jm.result(f).error, /oc boom/);
  const s = jm.submit(S('SLEEP', { worker: 'ds-flash' }));
  await new Promise(r => setTimeout(r, 500));
  await jm.cancel(s); await jm.wait([s], { timeoutS: 20 });
  assert.equal(jm.status(s).state, 'cancelled');
});
test('transient provider error: one automatic retry in the same job, cost recorded once', async () => {
  const { jm, config } = mk();
  const seen = [];
  jm.bus.on('job.started', () => seen.push('started'));
  jm.bus.on('job.finished', e => seen.push(`finished:${e.state}`));
  const id = jm.submit(S('ERROR_ONCE', { worker: 'ds-flash' }));
  await jm.wait([id], { timeoutS: 30 });
  const r = jm.result(id, { detail: 'normal' });
  assert.equal(r.state, 'done');
  assert.equal(r.worker, 'ds-flash');
  assert.equal(jm.meta(id).retries, 1);
  assert.equal(r.cost_usd, 0.03);
  assert.deepEqual(seen, ['started', 'finished:done']);
  const events = fs.readFileSync(path.join(jm.jobDir(id), 'events.jsonl'), 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  assert.equal(events.filter(e => e.type === 'step_start').length, 2, 'two executions share the same job dir');
  const month = JSON.parse(fs.readFileSync(path.join(config.home, 'usage.json'), 'utf8'))[new Date().toISOString().slice(0, 7)]['ds-flash'];
  assert.equal(month.runs, 1, 'ledger records the job once');
  assert.equal(month.cost_usd, 0.03, 'failed attempt usage is not lost nor double-counted');
});
test('exhausted transient retry fails with the provider name and the event message', async () => {
  const { jm } = mk();
  const id = jm.submit(S('ERROR', { worker: 'ds-flash' }));
  await jm.wait([id], { timeoutS: 30 });
  const r = jm.result(id);
  assert.equal(r.state, 'failed');
  assert.equal(jm.meta(id).retries, 1);
  assert.equal(r.cost_usd, 0.02);
  assert.match(r.error, /^opencode salió con código 1: Unexpected server error\. Check server logs for details\.$/);
  const events = fs.readFileSync(path.join(jm.jobDir(id), 'events.jsonl'), 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  assert.equal(events.filter(e => e.type === 'step_start').length, 2);
});
test('retry_transient: 0 disables retry and non-retryable failures are never retried', async () => {
  const disabled = getConfig({ ...baseEnv(ocHome('', 'defaults: {worker: luna-max, retry_transient: 0}')), COLMENA_OPENCODE_BIN: fakeOpencode });
  const jm0 = createJobManager(disabled);
  const id0 = jm0.submit(S('ERROR', { worker: 'ds-flash' }));
  await jm0.wait([id0], { timeoutS: 30 });
  assert.equal(jm0.result(id0).state, 'failed');
  assert.equal(jm0.meta(id0).retries, 0);
  assert.match(jm0.result(id0).error, /^opencode salió con código 1: Unexpected server error/);

  const { jm } = mk();
  const id = jm.submit(S('FAIL', { worker: 'ds-flash' }));
  await jm.wait([id], { timeoutS: 30 });
  assert.equal(jm.meta(id).retries, 0);
  assert.match(jm.result(id).error, /^opencode salió con código 1: oc boom$/);
});
test('OpenCode job with a finished step still follows general timeout', async () => {
  const config = getConfig({ ...baseEnv(ocHome(), { COLMENA_JOB_TIMEOUT_MIN: '0.02', COLMENA_EXIT_GRACE_S: '0.1' }), COLMENA_OPENCODE_BIN: fakeOpencode });
  const jm = createJobManager(config);
  const id = jm.submit(S('LINGER', { worker: 'ds-flash' }));
  await jm.wait([id], { timeoutS: 10 });
  assert.equal(jm.result(id).state, 'failed');
  assert.match(jm.result(id).error, /timeout/i);
});
test('sessionId repetido escribe meta.json una sola vez (dedupe)', async () => {
  const dir = tmp('colmena-oc-dedupe-');
  const fake = path.join(dir, 'fake-oc-dedupe.mjs');
  fs.writeFileSync(fake, `const emit = o => process.stdout.write(JSON.stringify(o) + '\\n');
for (let i = 0; i < 3; i++) emit({ type: 'step_start', sessionID: 'ses_dedupe', part: { type: 'step-start' } });
emit({ type: 'text', sessionID: 'ses_dedupe', part: { type: 'text', text: 'RESULT: ok\\nFILES: ninguno\\nTESTS: 1/1\\nRISKS: ninguno' } });
emit({ type: 'step_finish', sessionID: 'ses_dedupe', part: { type: 'step-finish', tokens: { input: 10, output: 2, reasoning: 0 }, cost: 0.01 } });
`);
  const config = getConfig({ ...baseEnv(ocHome()), COLMENA_OPENCODE_BIN: fake });
  const jm = createJobManager(config);
  const orig = fs.writeFileSync;
  let sessionWrites = 0;
  fs.writeFileSync = (f, data, ...rest) => {
    const s = String(data);
    // Escrituras por evento de sesión: llevan sessionId pero aún no endedAt (el cierre final sí lo lleva).
    if (String(f).includes('meta.json') && s.includes('"sessionId"') && !s.includes('"endedAt"')) sessionWrites++;
    return orig(f, data, ...rest);
  };
  try {
    const id = jm.submit(S('dedupe', { worker: 'ds-flash' }));
    await jm.wait([id]);
    assert.equal(jm.result(id, { detail: 'normal' }).sessionId, 'ses_dedupe');
    assert.equal(sessionWrites, 1);
  } finally {
    fs.writeFileSync = orig;
  }
});
test('unused import guard', () => { assert.ok(fakeCodex); });
