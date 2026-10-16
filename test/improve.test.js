import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildImprovePrompt, pendingFocuses } from '../src/plugins/improve.js';
import { baseEnv, tmp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const DAY_MS = 24 * 60 * 60 * 1000;

const improveHome = (extraPlugins = '') => {
  const home = tmp('colmena-imp-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, priority: 1, strengths: [code]}
  alt: {provider: codex, model: gpt-alt, priority: 2}
  docster: {provider: codex, model: gpt-docs, priority: 3, strengths: [docs]}
roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}
defaults: {worker: luna-max}
plugins:
  notify: {enabled: false}
${extraPlugins}`);
  return home;
};

function gitRepo() {
  const repo = tmp('colmena-imp-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo de prueba\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return repo;
}

async function connect(home, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(here, '..', 'src', 'server.js')],
    env: { ...process.env, ...baseEnv(home, extraEnv) },
  });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call };
}

test('buildImprovePrompt: cada focus pide su informe con fecha, evidencia y briefs TDD/DRY', () => {
  for (const focus of ['backlog', 'features', 'debt', 'all']) {
    const p = buildImprovePrompt(focus, { date: '2026-10-15' });
    assert.match(p, new RegExp(`docs/backlog/2026-10-15-${focus}\\.md`), focus);
    assert.match(p, /TDD/, focus);
    assert.match(p, /DRY/, focus);
    assert.match(p, /brief/i, focus);
    assert.match(p, /impacto/i, focus);
  }
  assert.match(buildImprovePrompt('debt', { date: '2026-10-15' }), /deuda técnica/i);
  assert.match(buildImprovePrompt('features', { date: '2026-10-15' }), /features/i);
  assert.match(buildImprovePrompt('all', { date: '2026-10-15' }), /backlog[\s\S]*features[\s\S]*deuda/i);
  assert.throws(() => buildImprovePrompt('nope', { date: '2026-10-15' }), /focus 'nope'/);
});

test('pendingFocuses: descuenta los foci lanzados en la ventana, por cwd', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const all = ['backlog', 'features', 'debt'];
  const meta = (over = {}) => ({ improveFocus: 'debt', cwd: 'C:\\repo', createdAt: now, ...over });
  assert.deepEqual(pendingFocuses([], { cwd: 'C:\\repo', now }), all);
  assert.deepEqual(pendingFocuses([meta()], { cwd: 'C:\\repo', now }), ['backlog', 'features']);
  assert.deepEqual(pendingFocuses([meta({ improveFocus: 'all' })], { cwd: 'C:\\repo', now }), []);
  assert.deepEqual(pendingFocuses([meta()], { cwd: 'C:\\otro', now }), all, 'otro repo no cuenta');
  assert.deepEqual(pendingFocuses([meta({ createdAt: now - DAY_MS - 1 })], { cwd: 'C:\\repo', now }), all, 'fuera de la ventana');
  assert.deepEqual(pendingFocuses([{ cwd: 'C:\\repo', createdAt: now }], { cwd: 'C:\\repo', now }), all, 'jobs sin improveFocus no cuentan');
  if (process.platform === 'win32') {
    assert.deepEqual(pendingFocuses([meta({ cwd: 'C:\\REPO' })], { cwd: 'c:\\repo', now }), ['backlog', 'features']);
  }
});

test('improve: lanza en worktree con el worker de docs y el prompt esperado (y worker explícito)', async () => {
  const log = path.join(tmp('colmena-imp-log-'), 'f.log');
  const { client, call } = await connect(improveHome(), { FAKE_LOG: log });
  try {
    const repo = gitRepo();
    const res = await call('improve', { cwd: repo });
    assert.ok(res.job_id);
    const w = await call('wait', { job_ids: [res.job_id], timeout_s: 60 });
    const done = w.done.find(d => d.id === res.job_id);
    assert.equal(done.state, 'done');
    assert.equal(done.worker, 'docster', 'el router elige un worker con fortaleza docs');
    assert.match(done.branch, /^colmena\//);
    const inv = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.match(inv.prompt, new RegExp(`docs/backlog/\\d{4}-\\d{2}-\\d{2}-all\\.md`));
    assert.match(inv.prompt, /TDD/);
    assert.match(inv.prompt, /DRY/);
    assert.ok(inv.cwd.includes('worktrees'), 'corre en un worktree, no en el repo original');

    const res2 = await call('improve', { cwd: repo, focus: 'debt', worker: 'alt' });
    const w2 = await call('wait', { job_ids: [res2.job_id], timeout_s: 60 });
    assert.equal(w2.done[0].worker, 'alt');
    const inv2 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[1]);
    assert.match(inv2.prompt, /-debt\.md/);

    const bad = await call('improve', { cwd: tmp('colmena-imp-ng-') });
    assert.match(bad.error, /no es un repositorio git/);
  } finally { await client.close(); }
});

test('wait: hint de mejora solo si todos terminaron y no hay improve reciente', async () => {
  const { client, call } = await connect(improveHome());
  try {
    const repo = gitRepo();
    const r = await call('run', { task: 'hola', cwd: repo, wait: true });
    const w = await call('wait', { job_ids: [r.id], timeout_s: 60 });
    assert.equal(w.pending.length, 0);
    assert.match(w.hint, /improve/);
    assert.match(w.hint, /backlog/);

    const imp = await call('improve', { cwd: repo, focus: 'debt' });
    const w2 = await call('wait', { job_ids: [imp.job_id], timeout_s: 60 });
    assert.equal(w2.hint, undefined, 'con improve reciente ya no invita');
  } finally { await client.close(); }
});

test('report: next invita a improve y deja de sugerir un focus ya lanzado', async () => {
  const { client, call } = await connect(improveHome());
  try {
    const repo = gitRepo();
    const r = await call('run', { task: 'hola', cwd: repo, wait: true });

    const rep1 = await call('report', { job_ids: [r.id], title: 'Ronda 1' });
    assert.ok(Array.isArray(rep1.next));
    assert.ok(rep1.next.some(s => s.includes('ronda cerrada')));
    for (const f of ['backlog', 'features', 'debt']) assert.ok(rep1.next.some(s => s.includes(`improve ${f}`)), f);

    await call('improve', { cwd: repo, focus: 'debt' });
    const rep2 = await call('report', { job_ids: [r.id], title: 'Ronda 2' });
    assert.ok(!rep2.next.some(s => s.includes('improve debt')));
    assert.ok(rep2.next.some(s => s.includes('improve backlog')));

    await call('improve', { cwd: repo, focus: 'backlog' });
    await call('improve', { cwd: repo, focus: 'features' });
    const rep3 = await call('report', { job_ids: [r.id], title: 'Ronda 3' });
    assert.deepEqual(rep3.next, []);
  } finally { await client.close(); }
});

test('prompt MCP continuous-improvement guía la ronda completa', async () => {
  const { client } = await connect(improveHome());
  try {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some(p => p.name === 'continuous-improvement'));
    const got = await client.getPrompt({ name: 'continuous-improvement' });
    const text = got.messages[0].content.text;
    for (const step of ['workers', 'run_many', 'wait', 'review', 'merge', 'report', 'improve']) {
      assert.match(text, new RegExp(step), step);
    }
  } finally { await client.close(); }
});

test('plugins.improve.enabled false: sin tool, sin prompt y sin invitaciones', async () => {
  const { client, call } = await connect(improveHome('  improve: {enabled: false}\n'));
  try {
    assert.ok(!(await client.listTools()).tools.some(t => t.name === 'improve'));
    assert.ok(!(await client.listPrompts()).prompts.some(p => p.name === 'continuous-improvement'));
    const repo = gitRepo();
    const r = await call('run', { task: 'hola', cwd: repo, wait: true });
    const w = await call('wait', { job_ids: [r.id], timeout_s: 60 });
    assert.equal(w.hint, undefined);
    const rep = await call('report', { job_ids: [r.id], title: 'Ronda' });
    assert.equal(rep.next, undefined);
  } finally { await client.close(); }
});

test('reload_config activa y desactiva improve (tool y prompt)', async () => {
  const home = improveHome('  improve: {enabled: false}\n');
  const { client, call } = await connect(home);
  try {
    const file = path.join(home, 'colmena.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('improve: {enabled: false}', 'improve: {enabled: true}'));
    await call('reload_config', {});
    assert.ok((await client.listTools()).tools.some(t => t.name === 'improve'));
    assert.ok((await client.listPrompts()).prompts.some(p => p.name === 'continuous-improvement'));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('improve: {enabled: true}', 'improve: {enabled: false}'));
    await call('reload_config', {});
    assert.ok(!(await client.listTools()).tools.some(t => t.name === 'improve'));
    assert.ok(!(await client.listPrompts()).prompts.some(p => p.name === 'continuous-improvement'));
  } finally { await client.close(); }
});

test('plugins.improve.hints false: la tool sigue, las invitaciones se callan', async () => {
  const { client, call } = await connect(improveHome('  improve: {hints: false}\n'));
  try {
    assert.ok((await client.listTools()).tools.some(t => t.name === 'improve'));
    const repo = gitRepo();
    const r = await call('run', { task: 'hola', cwd: repo, wait: true });
    const w = await call('wait', { job_ids: [r.id], timeout_s: 60 });
    assert.equal(w.hint, undefined);
    const rep = await call('report', { job_ids: [r.id], title: 'Ronda' });
    assert.equal(rep.next, undefined);
  } finally { await client.close(); }
});
