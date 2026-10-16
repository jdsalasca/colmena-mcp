import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex.js');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
import { baseEnv, codexOnlyHome } from './helpers.js';
const mk = () => { const config = getConfig(baseEnv(codexOnlyHome())); return { jm: createJobManager(config), config }; };
const withLog = async fn => {
  const log = path.join(tmp('luna-hl-'), 'f.log'); process.env.FAKE_LOG = log;
  try { await fn(log); } finally { delete process.env.FAKE_LOG; }
};
const calls = log => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('compact writes summary.md in the source job dir', async () => {
  const { jm, config } = mk();
  const src = jm.submit({ task: 'hola', cwd: tmp('luna-c-'), isolation: 'inplace' }); await jm.wait([src]);
  const c = jm.compact(src); await jm.wait([c]);
  const f = path.join(config.jobsDir, src, 'summary.md');
  assert.ok(fs.existsSync(f));
  assert.match(fs.readFileSync(f, 'utf8'), /RESULT|ok/);
});
test('handoff injects source summary into the next prompt', async () => {
  await withLog(async log => {
    const { jm } = mk();
    const a = jm.submit({ task: 'primero', cwd: tmp('luna-c-'), isolation: 'inplace' }); await jm.wait([a]);
    const b = jm.submit({ task: 'segundo', cwd: tmp('luna-c-'), isolation: 'inplace', handoff: [a] }); await jm.wait([b]);
    const last = calls(log).pop();
    assert.match(last.prompt, /Contexto previo/);
    assert.match(last.prompt, /RESULT: ok/);
  });
});
test('handoff from unknown job throws', () => {
  const { jm } = mk();
  assert.throws(() => jm.submit({ task: 'x', cwd: tmp('luna-c-'), isolation: 'inplace', handoff: ['nope'] }), /nope/);
});
test('summarize/review run read-only; summarize is ephemeral', async () => {
  await withLog(async log => {
    const { jm } = mk(); const cwd = tmp('luna-c-');
    const a = jm.submit({ task: 'hola', cwd, isolation: 'inplace' }); await jm.wait([a]);
    const s = jm.summarize(a, 'foco'); await jm.wait([s]);
    const rv = jm.review({ id: a, focus: 'bugs' }); await jm.wait([rv]);
    const [, sc, rc] = calls(log);
    assert.equal(sc.argv[sc.argv.indexOf('-s') + 1], 'read-only'); assert.ok(sc.argv.includes('--ephemeral'));
    assert.equal(rc.argv[rc.argv.indexOf('-s') + 1], 'read-only');
    assert.match(sc.prompt, /foco/);
  });
});
