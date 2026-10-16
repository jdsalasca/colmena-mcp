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

function ocHome(extra = '') {
  const home = tmp('colmena-oh-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, effort: max, priority: 1}
  ds-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, effort: max, priority: 3}
roles: {reporter: ds-flash, summarizer: ds-flash, reviewer: luna-max}
defaults: {worker: luna-max}
plugins: {notify: {enabled: false}}
${extra}`);
  return home;
}
const mk = () => {
  const config = getConfig({ ...baseEnv(ocHome()), COLMENA_OPENCODE_BIN: fakeOpencode });
  return { jm: createJobManager(config), config };
};
const S = (task, extra = {}) => ({ task, cwd: tmp('colmena-c-'), isolation: 'inplace', ...extra });

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
test('unused import guard', () => { assert.ok(fakeCodex); });
