import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { baseEnv, codexOnlyHome } from './helpers.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(here, '..', 'src', 'server.js')],
    env: { ...process.env, ...baseEnv(codexOnlyHome(), extraEnv) },
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

const NAMES = ['workers', 'report', 'reload_config', 'stats', 'improve', 'run', 'run_many', 'status', 'list', 'wait', 'result', 'diff', 'continue', 'summarize', 'compact', 'handoff', 'review', 'cancel', 'merge', 'cleanup'];

test('workers + report tools end to end', async () => {
  const { client, call } = await connect();
  try {
    const rows = await call('workers', {});
    assert.deepEqual(rows.map(r => r.alias).sort(), ['alt', 'luna-max']);
    assert.equal(rows.find(r => r.alias === 'luna-max').available, true);
    const r1 = await call('run', { task: 'hola', cwd: tmp('colmena-c-'), wait: true, kind: 'code' });
    const rep = await call('report', { job_ids: [r1.id], title: 'Ronda E2E' });
    assert.equal(rep.usedFallback, false);
    assert.ok(fs.existsSync(rep.path));
    assert.match((await call('report', { job_ids: [r1.id], style: 'nope' })).error, /estilo 'nope'/);
  } finally { await client.close(); }
});

test('lists all tools; no model/effort knobs', async () => {
  const { client } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...NAMES].sort());
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      assert.ok(!props.includes('model') && !props.includes('effort') && !props.includes('reasoning_effort'), t.name);
    }
  } finally { await client.close(); }
});

test('stats MCP tool aggregates complete metadata from finished jobs', async () => {
  const { client, call } = await connect();
  try {
    const run = await call('run', { task: 'hola', cwd: tmp('luna-stats-'), wait: true });
    assert.equal(run.state, 'done');

    const stats = await call('stats', {});
    assert.equal(stats.totals.jobs, 1);
    assert.equal(stats.totals.done, 1);
    assert.equal(stats.byWorker['luna-max'].runs, 1);
    assert.equal(stats.byWorker['luna-max'].done, 1);
    assert.equal(stats.byKind.run.runs, 1);
    assert.equal(typeof stats.range.since, 'string');
    assert.equal(typeof stats.range.until, 'string');
  } finally { await client.close(); }
});

test('run wait:true returns report; extra "model" arg cannot change the model', async () => {
  const log = path.join(tmp('luna-sl-'), 'f.log');
  const { client, call } = await connect({ FAKE_LOG: log });
  try {
    const r = await call('run', { task: 'hola', cwd: tmp('luna-c-'), wait: true, model: 'gpt-evil' });
    assert.equal(r.state, 'done');
    assert.match(r.report.RESULT, /^ok/);
    const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).argv;
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-luna');
    assert.ok(argv.includes('model_reasoning_effort="max"'));
  } finally { await client.close(); }
});

test('reload_config updates workers, reports a compact diff, and preserves settings on invalid YAML', async () => {
  const home = codexOnlyHome(); const log = path.join(tmp('luna-rl-'), 'f.log');
  const file = path.join(home, 'colmena.yml');
  const original = fs.readFileSync(file, 'utf8');
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CONFIG: file, FAKE_LOG: log, COLMENA_MAX_PARALLEL: '2' });
  try {
    fs.writeFileSync(file, original.replace('model: gpt-6-luna', 'model: gpt-luna-reloaded, budget: {monthly_usd: 3}')
      .replace('  alt: {provider: codex, model: gpt-alt, effort: high, priority: 2}', '  new: {provider: codex, model: gpt-new, priority: 2}')
      .replace('roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}', 'roles: {reporter: luna-max, summarizer: luna-max, reviewer: new}')
      .replace('defaults: {worker: luna-max}', 'defaults: {worker: new, max_parallel: 8}')
      .replace('plugins:\n  notify: {enabled: false}', 'plugins:\n  notify: {enabled: false}\n  report: {enabled: false}')
      + '\nproviders: {opencode: {isolate_config: false}}\n');
    const diff = await call('reload_config', {});
    assert.deepEqual(diff, {
      added: ['new'], removed: ['alt'], changed: [{ alias: 'luna-max', fields: ['budget.monthly_usd', 'model'] }],
      roles: ['reviewer'], defaults: ['max_parallel', 'worker'], providers: ['opencode.isolate_config'],
    });
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'report'), false);
    const run = await call('run', { task: 'modelo renovado', worker: 'luna-max', cwd: tmp('luna-reload-c-'), wait: true });
    assert.equal(run.state, 'done');
    const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
    assert.equal(invocation.argv[invocation.argv.indexOf('-m') + 1], 'gpt-luna-reloaded');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('report: {enabled: false}', 'report: {enabled: true}'));
    await call('reload_config', {});
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'report'), true);

    fs.writeFileSync(file, 'standards: {enabled: maybe}\n');
    const invalid = await call('reload_config', {});
    assert.match(invalid.error, /standards\.enabled/);
    const workers = await call('workers', {});
    assert.equal(workers.find(w => w.alias === 'luna-max').model, 'gpt-luna-reloaded');
    assert.equal(workers.some(w => w.alias === 'new'), true);
  } finally { await client.close(); }
});

test('run_many + wait, worktree flow, diff, merge, cleanup', async () => {
  const { client, call } = await connect();
  try {
    const repo = tmp('luna-sr-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const many = await call('run_many', { tasks: [{ task: 'EDIT uno', cwd: repo }, { task: 'hola', cwd: tmp('luna-c-') }] });
    assert.equal(many.length, 2);
    const w = await call('wait', { job_ids: many.map(m => m.job_id), timeout_s: 60 });
    assert.equal(w.done.length, 2);
    const edit = w.done.find(d => d.files?.includes('edited.txt'));
    assert.ok(edit && edit.branch);
    const d = await call('diff', { job_id: edit.id, max_chars: 20 });
    assert.equal(d.truncated, true); assert.ok(fs.existsSync(d.fullPath));
    const m = await call('merge', { job_id: edit.id });
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.ok(fs.existsSync(path.join(repo, 'edited.txt')));
    const c = await call('cleanup', { job_id: edit.id });
    assert.equal(c.removed.length, 1);
  } finally { await client.close(); }
});

test('cleanup refuses to discard unmerged work unless force', async () => {
  const { client, call } = await connect();
  try {
    const repo = tmp('luna-su-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const { job_id } = await call('run', { task: 'EDIT x', cwd: repo });
    await call('wait', { job_ids: [job_id], timeout_s: 60 });
    const denied = await call('cleanup', { job_id });
    assert.match(denied.error, /no fusionado/);
    assert.match((await call('cleanup', { older_than_days: 0 })).error, /force/);
    const forced = await call('cleanup', { job_id, force: true });
    assert.equal(forced.removed.length, 1);
  } finally { await client.close(); }
});

test('errors are returned as tool errors, not crashes', async () => {
  const { client, call } = await connect();
  try {
    assert.match((await call('status', { job_id: 'nope' })).error, /no existe/);
    assert.match((await call('cleanup', {})).error, /job_id u older_than_days/);
    assert.match((await call('run', { task: 'x', cwd: tmp('luna-ng-'), isolation: 'worktree' })).error, /no es un repositorio git/);
  } finally { await client.close(); }
});
