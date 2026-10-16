import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(here, '..', 'src', 'server.js')],
    env: { ...process.env, LUNA_CODEX_BIN: path.join(here, 'fake-codex.js'), LUNA_HOME: tmp('luna-sv-'), ...extraEnv },
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

const NAMES = ['luna_run', 'luna_run_many', 'luna_status', 'luna_list', 'luna_wait', 'luna_result', 'luna_diff', 'luna_continue', 'luna_summarize', 'luna_compact', 'luna_handoff', 'luna_review', 'luna_cancel', 'luna_merge', 'luna_cleanup'];

test('lists the 15 tools; no model/effort knobs', async () => {
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

test('luna_run wait:true returns report; extra "model" arg cannot change the model', async () => {
  const log = path.join(tmp('luna-sl-'), 'f.log');
  const { client, call } = await connect({ FAKE_LOG: log });
  try {
    const r = await call('luna_run', { task: 'hola', cwd: tmp('luna-c-'), wait: true, model: 'gpt-evil' });
    assert.equal(r.state, 'done');
    assert.match(r.report.RESULT, /^ok/);
    const argv = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).argv;
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-luna');
    assert.ok(argv.includes('model_reasoning_effort="max"'));
  } finally { await client.close(); }
});

test('run_many + wait, worktree flow, diff, merge, cleanup', async () => {
  const { client, call } = await connect();
  try {
    const repo = tmp('luna-sr-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const many = await call('luna_run_many', { tasks: [{ task: 'EDIT uno', cwd: repo }, { task: 'hola', cwd: tmp('luna-c-') }] });
    assert.equal(many.length, 2);
    const w = await call('luna_wait', { job_ids: many.map(m => m.job_id), timeout_s: 60 });
    assert.equal(w.done.length, 2);
    const edit = w.done.find(d => d.files?.includes('edited.txt'));
    assert.ok(edit && edit.branch);
    const d = await call('luna_diff', { job_id: edit.id, max_chars: 20 });
    assert.equal(d.truncated, true); assert.ok(fs.existsSync(d.fullPath));
    const m = await call('luna_merge', { job_id: edit.id });
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.ok(fs.existsSync(path.join(repo, 'edited.txt')));
    const c = await call('luna_cleanup', { job_id: edit.id });
    assert.equal(c.removed.length, 1);
  } finally { await client.close(); }
});

test('errors are returned as tool errors, not crashes', async () => {
  const { client, call } = await connect();
  try {
    assert.match((await call('luna_status', { job_id: 'nope' })).error, /no existe/);
    assert.match((await call('luna_cleanup', {})).error, /job_id u older_than_days/);
    assert.match((await call('luna_run', { task: 'x', cwd: tmp('luna-ng-'), isolation: 'worktree' })).error, /no es un repositorio git/);
  } finally { await client.close(); }
});
