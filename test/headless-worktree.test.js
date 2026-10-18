// MEJORA A: prompt headless, reglas de rama, skills off, detección de cambio de rama y worktree sucio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildPrompt } from '../src/report.js';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { getAdapter } from '../src/providers/index.js';
import * as iso from '../src/isolation.js';
import { buildServer } from '../src/tools.js';
import { baseEnv, codexOnlyHome, tmp, fakeOpencode } from './helpers.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const d = tmp('luna-hw-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i');
  return d;
}
const mk = () => {
  const config = getConfig(baseEnv(codexOnlyHome()));
  return { jm: createJobManager(config), config };
};
const briefOf = (jm, id) => fs.readFileSync(path.join(jm.jobDir(id), 'brief.md'), 'utf8');

test('buildPrompt: los jobs run llevan Modo headless; los auxiliares no', () => {
  const run = buildPrompt({ task: 'x', kind: 'run' });
  assert.match(run, /Modo headless/);
  assert.match(run, /No pidas aprobación ni confirmación/i);
  assert.match(run, /brainstorming/);
  assert.match(run, /reporte/i);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'summarize' }), /Modo headless/);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'review' }), /Modo headless/);
});

test('buildPrompt: las reglas de git prohíben cambiar de rama', () => {
  const p = buildPrompt({ task: 'x', kind: 'run', branch: 'colmena/ab12' });
  for (const bad of ['checkout -B', 'switch -c', 'branch -m']) assert.ok(p.includes(bad), `falta prohibir ${bad}`);
  assert.match(p, /NO cambies de rama/i);
});

test('buildPrompt: skills off añade la instrucción de ignorar skills', () => {
  const off = buildPrompt({ task: 'x', kind: 'run', skills: 'off' });
  assert.match(off, /Skills desactivados/);
  assert.match(off, /ignora/i);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'run', skills: 'on' }), /Skills desactivados/);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'run' }), /Skills desactivados/);
});

test('isolation: branchMismatch detecta salir de la rama esperada; null en los casos correctos', () => {
  const r = repo();
  const base = git(r, 'rev-parse', 'HEAD');
  git(r, 'branch', 'colmena/j1', base);
  assert.equal(iso.branchMismatch(r, 'main', base), null);
  assert.deepEqual(iso.dirtyFiles(r), []);

  git(r, 'checkout', '-qB', 'work');
  fs.writeFileSync(path.join(r, 'w.txt'), 'w\n');
  git(r, 'add', '-A'); git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'w');

  const m = iso.branchMismatch(r, 'colmena/j1', base);
  assert.equal(m.expected, 'colmena/j1');
  assert.equal(m.actual, 'work');
  assert.equal(m.headCommit, git(r, 'rev-parse', 'HEAD'));
  assert.equal(git(r, 'rev-list', '--count', `${base}..colmena/j1`), '0', 'la rama esperada quedó sin commits');
  const d = iso.diffCommits(r, base, m.headCommit, 1000);
  assert.match(d.text, /w\.txt/);
  assert.equal(d.truncated, false);

  git(r, 'checkout', '-q', 'colmena/j1');
  fs.writeFileSync(path.join(r, 'x.txt'), 'x\n');
  git(r, 'add', '-A'); git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  assert.equal(iso.branchMismatch(r, 'colmena/j1', base), null, 'con commits en la rama esperada no hay mismatch');

  fs.writeFileSync(path.join(r, 'dirty.txt'), 'd');
  assert.deepEqual(iso.dirtyFiles(r), ['dirty.txt']);
});

test('job worktree que cambia de rama: meta.branchMismatch, warning y HEAD real', async () => {
  const { jm } = mk(); const r0 = repo();
  const id = jm.submit({ task: 'SWITCH cambia de rama', cwd: r0, isolation: 'worktree' });
  await jm.wait([id], { timeoutS: 30 });
  const meta = jm.meta(id);
  assert.equal(jm.result(id).state, 'done');
  assert.equal(meta.branchMismatch.expected, `colmena/${id}`);
  assert.equal(meta.branchMismatch.actual, 'work');
  assert.equal(meta.branchMismatch.headCommit, git(meta.workdir, 'rev-parse', 'HEAD'));
  assert.equal(meta.dirtyWorktree, undefined);
  assert.deepEqual(jm.result(id).branchMismatch, meta.branchMismatch);
  assert.match(jm.result(id).warning, /cambió de rama/);
});

test('job worktree con archivos sin commitear: meta.dirtyWorktree (máx 20) y warning', async () => {
  const { jm } = mk(); const r0 = repo();
  const id = jm.submit({ task: 'DIRTY21 deja pendientes', cwd: r0, isolation: 'worktree' });
  await jm.wait([id], { timeoutS: 30 });
  const meta = jm.meta(id);
  assert.equal(jm.result(id).state, 'done');
  assert.equal(meta.dirtyWorktree.length, 20);
  assert.ok(meta.dirtyWorktree.every(f => /^dirty-\d\d\.txt$/.test(f)), JSON.stringify(meta.dirtyWorktree));
  assert.match(jm.result(id).warning, /sin commitear/);
  assert.deepEqual(jm.result(id).dirtyWorktree, meta.dirtyWorktree);
});

test('submit con skills off guarda meta.skills y lo inyecta en el brief', async () => {
  const { jm } = mk();
  const id = jm.submit({ task: 'hola', cwd: tmp('luna-sk-'), isolation: 'inplace', skills: 'off' });
  await jm.wait([id]);
  assert.match(briefOf(jm, id), /Skills desactivados/);
  assert.equal(jm.meta(id).skills, 'off');

  const on = jm.submit({ task: 'hola', cwd: tmp('luna-sk2-'), isolation: 'inplace' });
  await jm.wait([on]);
  assert.doesNotMatch(briefOf(jm, on), /Skills desactivados/);
  assert.equal(jm.meta(on).skills, undefined);
});

test('opencode env: skills off desactiva la carga de .claude/skills', () => {
  const oc = getAdapter('opencode');
  const home = tmp('luna-oc-skills-');
  const settings = { providers: { opencode: { isolate_config: true } } };
  const off = oc.env({ home, settings }, { skills: 'off' });
  assert.equal(off.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, '1');
  assert.equal(off.XDG_CONFIG_HOME, path.join(home, 'opencode-config'));
  assert.equal(oc.env({ home, settings }, { skills: 'on' }).OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, undefined);
  assert.equal(oc.env({ home, settings }, {}).OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, undefined);
  assert.deepEqual(
    oc.env({ home, settings: { providers: { opencode: { isolate_config: false } } } }, { skills: 'off' }),
    { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' },
  );
});

function ocOnlyHome() {
  const home = tmp('luna-och-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  ds-flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, priority: 1}
roles: {reporter: ds-flash, summarizer: ds-flash, reviewer: ds-flash}
defaults: {worker: ds-flash}
plugins: {notify: {enabled: false}}
`);
  return home;
}

test('job opencode con skills off pasa OPENCODE_DISABLE_CLAUDE_CODE_SKILLS al proceso', async () => {
  const log = path.join(tmp('luna-oc-sk-log-'), 'f.log');
  process.env.FAKE_LOG = log;
  try {
    const config = getConfig({ ...baseEnv(ocOnlyHome(), { COLMENA_OPENCODE_BIN: fakeOpencode }) });
    const jm = createJobManager(config);
    const off = jm.submit({ task: 'hola', cwd: tmp('luna-oc-sk-c-'), isolation: 'inplace', skills: 'off', worker: 'ds-flash' });
    await jm.wait([off], { timeoutS: 30 });
    const on = jm.submit({ task: 'hola', cwd: tmp('luna-oc-sk-c2-'), isolation: 'inplace', worker: 'ds-flash' });
    await jm.wait([on], { timeoutS: 30 });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls[0].disableClaudeSkills, '1');
    assert.equal(calls[1].disableClaudeSkills, undefined);
  } finally { delete process.env.FAKE_LOG; }
});

async function memoryConnect(env = {}) {
  const config = getConfig(baseEnv(codexOnlyHome(), env));
  const { server } = buildServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hw-test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { client, server, call, config };
}

test('MCP: run acepta skills off; merge fusiona la rama real tras branchMismatch', async () => {
  const { client, server, call, config } = await memoryConnect();
  const r0 = repo();
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(Object.keys(tools.find(t => t.name === 'run').inputSchema.properties).includes('skills'));
    assert.ok(Object.keys(tools.find(t => t.name === 'run_many').inputSchema.properties.tasks.items.properties).includes('skills'));

    const job = await call('run', { task: 'SWITCH mcp', cwd: r0, isolation: 'worktree', skills: 'off', wait: true, timeout_s: 60 });
    assert.equal(job.state, 'done');
    assert.match(briefOf({ jobDir: id => path.join(config.jobsDir, id) }, job.id), /Modo headless/);
    assert.match(briefOf({ jobDir: id => path.join(config.jobsDir, id) }, job.id), /Skills desactivados/);
    assert.match(job.warning, /cambió de rama/);
    const meta = JSON.parse(fs.readFileSync(path.join(config.jobsDir, job.id, 'meta.json'), 'utf8'));
    assert.equal(meta.branchMismatch.actual, 'work');

    await call('verdict', { job_id: job.id, verdict: 'accepted' });
    const merged = await call('merge', { job_id: job.id });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.match(merged.warning, /cambió de rama/);
    assert.ok(fs.existsSync(path.join(r0, 'edited.txt')), 'merge debe traer el commit real de la rama work');
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP: diff avisa y usa el commit real cuando el worktree quedó fuera de la rama', async () => {
  const { client, server, call } = await memoryConnect();
  try {
    const job = await call('run', { task: 'WIPE borra el árbol', cwd: repo(), isolation: 'worktree', wait: true, timeout_s: 60 });
    assert.equal(job.state, 'done');
    const d = await call('diff', { job_id: job.id, max_chars: 100000 });
    assert.match(d.warning, /cambió de rama/);
    assert.match(d.text, /edited\.txt/);
  } finally {
    await client.close();
    await server.close();
  }
});
