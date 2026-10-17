import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getConfig } from '../src/config.js';
import * as iso from '../src/isolation.js';
import { buildServer } from '../src/tools.js';

import { baseEnv, codexOnlyHome, fakeOpencode } from './helpers.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const cwd = tmp('colmena-restart-repo-');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'initial.txt'), 'initial\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

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

const NAMES = ['workers', 'preferences', 'report', 'present', 'reload_config', 'stats', 'improve', 'widget', 'doctor', 'run', 'run_many', 'status', 'list', 'wait', 'result', 'diff', 'continue', 'retry', 'summarize', 'compact', 'handoff', 'review', 'verdict', 'cancel', 'merge', 'cleanup'];

function providerHome({ codexEnabled = true } = {}) {
  const home = tmp('colmena-pref-');
  const file = path.join(home, 'colmena.yml');
  fs.writeFileSync(file, `
# comentario que debe conservarse
preferences:
  # preferencia del usuario
  provider: auto
workers:
  luna: {provider: codex, model: gpt-6-luna, priority: 1, strengths: [code], enabled: ${codexEnabled}}
  flash: {provider: opencode, model: opencode-go/deepseek-v4.1-flash, priority: 2, strengths: [code, docs]}
roles: {reporter: luna, summarizer: luna, reviewer: luna}
defaults: {worker: luna}
plugins: {notify: {enabled: false}}
`);
  return { home, file };
}

test('workers + report tools end to end', async () => {
  const { client, call } = await connect();
  try {
    const rows = await call('workers', {});
    assert.deepEqual(rows.map(r => r.alias).sort(), ['alt', 'luna-max']);
    assert.equal(rows.find(r => r.alias === 'luna-max').available, true);
    const r1 = await call('run', { task: 'hola', cwd: tmp('colmena-c-'), wait: true, kind: 'code' });
    const deck = await call('present', { job_ids: [r1.id], title: 'Hito E2E', notes: 'Objetivo: terminar la función.' });
    assert.equal(deck.usedFallback, false);
    assert.match(deck.path, /-hito-e2e-deck[\\/]/);
    assert.ok(fs.existsSync(deck.path));
    const rep = await call('report', { job_ids: [r1.id], title: 'Ronda E2E' });
    assert.equal(rep.usedFallback, false);
    assert.ok(fs.existsSync(rep.path));
    assert.ok(rep.next.some(item => /present/.test(item)));
    assert.match((await call('report', { job_ids: [r1.id], style: 'nope' })).error, /estilo 'nope'/);
  } finally { await client.close(); }
});

test('MC-9: initialize reporta la versión de package.json', async () => {
  const { client } = await connect();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    assert.deepEqual(client.getServerVersion(), { name: 'colmena', version: pkg.version });
  } finally { await client.close(); }
});

test('MC-9: package-lock.json coincide en nombre y versión con package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(here, '..', 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('plugins.present.enabled false oculta la tool MCP', async () => {
  const home = codexOnlyHome();
  const file = path.join(home, 'colmena.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  notify: {enabled: false}', '  notify: {enabled: false}\n  present: {enabled: false}'));
  const { client } = await connect({ COLMENA_HOME: home });
  try {
    assert.equal((await client.listTools()).tools.some(item => item.name === 'present'), false);
  } finally { await client.close(); }
});

test('widget MCP solo publica action y plugins.widget.enabled la oculta', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const widget = (await client.listTools()).tools.find(item => item.name === 'widget');
    assert.deepEqual(Object.keys(widget.inputSchema.properties), ['action']);
    assert.equal((await call('widget', { action: 'status' })).state, 'stopped');
    assert.match((await call('widget', { action: 'restart' })).error, /action/i);
  } finally { await client.close(); }

  const configPath = path.join(home, 'colmena.yml');
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('  notify: {enabled: false}', '  notify: {enabled: false}\n  widget: {enabled: false}'));
  const disabled = await connect({ COLMENA_HOME: home });
  try {
    assert.equal((await disabled.client.listTools()).tools.some(item => item.name === 'widget'), false);
  } finally { await disabled.client.close(); }
});

test('MC-1: reload_config aplica plugins.widget.enabled en caliente', async () => {
  const home = codexOnlyHome();
  const file = path.join(home, 'colmena.yml');
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'widget'), true);

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  notify: {enabled: false}', '  notify: {enabled: false}\n  widget: {enabled: false}'));
    const diff = await call('reload_config', {});
    assert.ok(diff.plugins.includes('widget.enabled'));
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'widget'), false);

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  widget: {enabled: false}', '  widget: {enabled: true}'));
    await call('reload_config', {});
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'widget'), true);
  } finally { await client.close(); }
});

test('widget MCP despacha start, status y stop con el controlador inyectado', async () => {
  const home = codexOnlyHome();
  const executable = path.join(home, 'widget.exe');
  fs.writeFileSync(executable, 'fake executable');
  const registry = path.join(home, 'widget-process.json');
  const processState = { alive: false };
  const spawnCalls = [];
  const config = getConfig(baseEnv(home));
  const { server } = buildServer(config, {
    widgetDependencies: {
      executable,
      handshakeTimeoutMs: 100,
      pollIntervalMs: 2,
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        processState.alive = true;
        fs.writeFileSync(registry, JSON.stringify({ pid: 4812, executable }));
        return { pid: 4812, unref() {} };
      },
      processControl: {
        isAlive: async () => processState.alive,
        executablePath: async () => processState.alive ? executable : undefined,
        close: async () => { processState.alive = false; },
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'widget-test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async action => {
    const result = await client.callTool({ name: 'widget', arguments: { action } });
    return JSON.parse(result.content[0].text);
  };
  try {
    const started = await call('start');
    assert.equal(started.state, 'running');
    assert.equal(started.pid, 4812);
    assert.equal((await call('status')).pid, 4812);
    assert.equal((await call('stop')).state, 'stopped');
    assert.equal(spawnCalls.length, 1);
    assert.equal(fs.existsSync(registry), false);
  } finally {
    await client.close();
    await server.close();
  }
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
test('MC-7: doctor verifica los requisitos sin lanzar jobs', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_OPENCODE_BIN: fakeOpencode });
  try {
    const diag = await call('doctor', {});
    assert.deepEqual(diag.checks.map(c => c.name), ['node', 'git', 'config', 'home', 'codex', 'opencode', 'widget', 'locks']);
    assert.equal(diag.ok, true, JSON.stringify(diag.checks));
    const byName = Object.fromEntries(diag.checks.map(c => [c.name, c]));
    assert.equal(byName.codex.status, 'ok');
    assert.equal(byName.opencode.status, 'ok');
    assert.equal(byName.locks.status, 'ok');
    assert.deepEqual(await call('list', {}), []);
  } finally { await client.close(); }
});

test('MC-7: doctor falla con hint cuando COLMENA_CODEX_BIN no existe', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CODEX_BIN: path.join(home, 'codex-nope.exe') });
  try {
    const diag = await call('doctor', {});
    const codex = diag.checks.find(c => c.name === 'codex');
    assert.equal(codex.status, 'fail');
    assert.match(codex.detail, /instala/i);
    assert.match(codex.detail, /COLMENA_CODEX_BIN/);
    assert.equal(diag.ok, false);
  } finally { await client.close(); }
});

test('a running MCP job survives client close and finishes after server restart', async () => {
  const home = codexOnlyHome();
  const first = await connect({ COLMENA_HOME: home, FAKE_DELAY: '900' });
  const started = await first.call('run', { task: 'EDIT tras reinicio', cwd: repo(), isolation: 'worktree' });
  assert.equal(started.state, 'running');
  await first.client.close();

  const second = await connect({ COLMENA_HOME: home, FAKE_DELAY: '900' });
  try {
    const waited = await second.call('wait', { job_ids: [started.job_id], timeout_s: 10 });
    assert.equal(waited.done[0].state, 'done');
    const result = await second.call('result', { job_id: started.job_id });
    assert.match(result.report.RESULT, /^ok/);
    assert.deepEqual(result.files, ['edited.txt']);
  } finally { await second.client.close(); }
});
test('reload_config can restore cancellation on server shutdown', async () => {
  const home = codexOnlyHome();
  const file = path.join(home, 'colmena.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'defaults: {worker: luna-max}',
    'defaults: {worker: luna-max, max_parallel: 1}',
  ));
  const first = await connect({ COLMENA_HOME: home });
  const started = await first.call('run_many', { tasks: [
    { task: 'SLEEP hasta cerrar el servidor', cwd: tmp('colmena-shutdown-'), isolation: 'inplace' },
    { task: 'EDIT estaba en cola', cwd: tmp('colmena-queued-shutdown-'), isolation: 'inplace' },
  ] });
  const ids = started.map(job => job.job_id);
  const beforeClose = await first.call('list', {});
  assert.equal(beforeClose.find(job => job.id === ids[0]).state, 'running');
  assert.equal(beforeClose.find(job => job.id === ids[1]).state, 'queued');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'defaults: {worker: luna-max, max_parallel: 1}',
    'defaults: {worker: luna-max, max_parallel: 1, cancel_jobs_on_shutdown: true}',
  ));
  const diff = await first.call('reload_config', {});
  assert.ok(diff.defaults.includes('cancel_jobs_on_shutdown'));
  await first.client.close();

  const second = await connect({ COLMENA_HOME: home });
  try {
    const results = await Promise.all(ids.map(job_id => second.call('result', { job_id })));
    assert.deepEqual(results.map(result => result.state), ['cancelled', 'cancelled']);
    assert.equal(fs.existsSync(path.join(home, 'jobs', ids[1], 'prompt.txt')), false);
  } finally { await second.client.close(); }
});

test('stats MCP tool applies since_days to persisted jobs', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const oldRun = await call('run', { task: 'hola viejo', cwd: tmp('luna-stats-old-'), wait: true });
    const recentRun = await call('run', { task: 'hola reciente', cwd: tmp('luna-stats-new-'), wait: true });
    assert.equal(oldRun.state, 'done');
    assert.equal(recentRun.state, 'done');

    const oldMetaPath = path.join(home, 'jobs', oldRun.id, 'meta.json');
    const oldMeta = JSON.parse(fs.readFileSync(oldMetaPath, 'utf8'));
    oldMeta.createdAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(oldMetaPath, JSON.stringify(oldMeta));

    const stats = await call('stats', { since_days: 1 });
    assert.equal(stats.totals.jobs, 1);
    assert.equal(stats.totals.done, 1);
    assert.equal(stats.byWorker['luna-max'].runs, 1);
    assert.equal(stats.byWorker['luna-max'].done, 1);
    assert.equal(stats.byKind.run.runs, 1);
    assert.equal(typeof stats.range.since, 'string');
    assert.equal(typeof stats.range.until, 'string');
  } finally { await client.close(); }
});

test('MC-6: verdict registra la aceptación solo con id válido y stats la separa del estado de ejecución', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const job = await call('run', { task: 'hola', cwd: tmp('luna-mc6-'), wait: true });
    assert.equal(job.state, 'done');
    const metaPath = path.join(home, 'jobs', job.id, 'meta.json');
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).verdict, undefined);

    assert.match((await call('verdict', { job_id: 'nope', verdict: 'accepted' })).error, /no existe/);
    assert.match((await call('verdict', { job_id: job.id, verdict: 'aprobado' })).error, /accepted|needs_work/i);

    const saved = await call('verdict', { job_id: job.id, verdict: 'accepted', note: 'revisado con diff' });
    assert.equal(saved.job_id, job.id);
    assert.equal(saved.verdict, 'accepted');
    assert.equal(saved.note, 'revisado con diff');
    assert.equal(typeof saved.at, 'number');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.verdict, 'accepted');
    assert.equal(meta.verdictNote, 'revisado con diff');
    assert.equal(typeof meta.verdictAt, 'number');

    await call('reload_config', {});
    const worker = (await call('stats', { since_days: 1 })).byWorker['luna-max'];
    assert.equal(worker.done, 1);
    assert.equal(worker.successRate, 1);
    assert.equal(worker.reviewed, 1);
    assert.equal(worker.accepted, 1);
    assert.equal(worker.needsWork, 0);
    assert.equal(worker.reviewCoverage, 1);
    assert.equal(worker.acceptanceRate, 1);
  } finally { await client.close(); }
});

test('MC-6: needs_work persiste tras reiniciar y los jobs sin veredicto no cuentan como rechazados', async () => {
  const home = codexOnlyHome();
  const first = await connect({ COLMENA_HOME: home });
  const job = await first.call('run', { task: 'hola', cwd: tmp('luna-mc6-restart-'), wait: true });
  const pending = await first.call('run', { task: 'hola segundo', cwd: tmp('luna-mc6-restart2-'), wait: true });
  assert.equal((await first.call('verdict', { job_id: job.id, verdict: 'needs_work', note: 'falta prueba' })).verdict, 'needs_work');
  assert.equal((await first.call('verdict', { job_id: pending.id, verdict: 'accepted' })).verdict, 'accepted');
  await first.client.close();

  const second = await connect({ COLMENA_HOME: home });
  try {
    const rerun = await second.call('run', { task: 'hola tercero', cwd: tmp('luna-mc6-restart3-'), wait: true });
    const worker = (await second.call('stats', { since_days: 1 })).byWorker['luna-max'];
    assert.equal(worker.runs, 3);
    assert.equal(worker.done, 3);
    assert.equal(worker.successRate, 1);
    assert.equal(worker.reviewed, 2);
    assert.equal(worker.accepted, 1);
    assert.equal(worker.needsWork, 1);
    assert.equal(worker.reviewCoverage, 2 / 3);
    assert.equal(worker.acceptanceRate, 0.5);
    assert.equal((await second.call('result', { job_id: rerun.id })).state, 'done');
  } finally { await second.client.close(); }
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
    fs.writeFileSync(file, original.replace('model: gpt-6-luna', 'model: gpt-luna-reloaded, budget: {monthly_usd: 3}, free: true')
      .replace('  alt: {provider: codex, model: gpt-alt, effort: high, priority: 2}', '  new: {provider: codex, model: gpt-new, priority: 2}')
      .replace('roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}', 'roles: {reporter: luna-max, summarizer: luna-max, reviewer: new}')
      .replace('defaults: {worker: luna-max}', 'defaults: {worker: new, max_parallel: 8, exit_grace_s: 25}')
      .replace('plugins:\n  notify: {enabled: false}', 'plugins:\n  notify: {enabled: false}\n  improve: {hints: false}\n  report: {enabled: false}')
      + '\nproviders: {opencode: {isolate_config: false}}\nprofiles: {balanced: {mix: {new: 2}}}\n');
    const diff = await call('reload_config', {});
    assert.deepEqual(diff, {
      added: ['new'], removed: ['alt'], changed: [{ alias: 'luna-max', fields: ['budget.monthly_usd', 'free', 'model'] }],
      roles: ['presenter', 'reviewer'], defaults: ['exit_grace_s', 'max_parallel', 'worker'], providers: ['opencode.isolate_config'],
      plugins: ['improve.hints', 'report.enabled'], preferences: [], profiles: ['balanced.mix.new'],
    });
    assert.equal((await client.listTools()).tools.some(tool => tool.name === 'report'), false);
    const run = await call('run', { task: 'modelo renovado', worker: 'luna-max', cwd: tmp('luna-reload-c-'), wait: true });
    assert.equal(run.state, 'done');
    assert.equal((await call('workers', {})).find(worker => worker.alias === 'luna-max').free, true);
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

test('preferences gets current routing, changes the next run, persists comments, and validates input', async () => {
  const { home, file } = providerHome();
  const log = path.join(tmp('colmena-pref-log-'), 'agents.log');
  const { client, call } = await connect({
    COLMENA_HOME: home, COLMENA_CONFIG: file, COLMENA_CODEX_BIN: path.join(here, 'fake-codex.js'),
    COLMENA_OPENCODE_BIN: path.join(here, 'fake-opencode.js'), FAKE_LOG: log,
  });
  try {
    assert.deepEqual(await call('preferences', {}), {
      provider: 'auto', profile: null, profiles: {}, assignments: {}, worker: 'luna', would_choose: 'luna',
    });
    const selected = await call('preferences', { provider: 'opencode' });
    assert.deepEqual(selected, {
      provider: 'opencode', profile: null, profiles: {}, assignments: {}, worker: 'flash', would_choose: 'flash',
    });
    const rows = await call('workers', {});
    assert.equal(rows.find(row => row.alias === 'flash').preferred, true);
    assert.equal(rows.find(row => row.alias === 'luna').preferred, false);

    const cwd = tmp('colmena-pref-cwd-');
    const run = await call('run', { task: 'usar preferencia en caliente', cwd, wait: true });
    assert.equal(run.state, 'done');
    assert.equal(run.worker, 'flash');
    const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1));
    assert.equal(invocation.argv[0], 'run');
    assert.equal(invocation.argv[invocation.argv.indexOf('-m') + 1], 'opencode-go/deepseek-v4.1-flash');
    assert.equal(invocation.dir, cwd);

    const saved = fs.readFileSync(file, 'utf8');
    assert.match(saved, /# comentario que debe conservarse/);
    assert.match(saved, /# preferencia del usuario/);
    assert.match(saved, /provider: opencode/);
    assert.match(saved, /model: gpt-6-luna/);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.tmp')), []);

    const beforeInvalid = fs.readFileSync(file, 'utf8');
    const invalid = await call('preferences', { provider: 'other' });
    assert.match(invalid.error, /provider|opencode|codex|auto/i);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeInvalid);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.tmp')), []);
  } finally { await client.close(); }
});

test('preferences guarda perfiles mix, los activa para el siguiente run y reporta reparto y conteos', async () => {
  const { home, file } = providerHome();
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CONFIG: file, COLMENA_OPENCODE_BIN: fakeOpencode });
  try {
    const saved = await call('preferences', { save_profile: { name: 'flash-only', mix: { flash: 1 } } });
    assert.equal(saved.saved_profile, 'flash-only');
    const afterSave = fs.readFileSync(file, 'utf8');
    assert.match(afterSave, /# comentario que debe conservarse/);
    assert.match(afterSave, /# preferencia del usuario/);
    assert.match(afterSave, /flash-only/);

    const active = await call('preferences', { profile: 'flash-only' });
    assert.equal(active.profile, 'flash-only');
    assert.equal(active.worker, 'flash');
    assert.deepEqual(active.assignments, { flash: 0 });
    assert.equal((await call('workers', {})).find(row => row.alias === 'flash').profile_share, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /# comentario que debe conservarse/);
    assert.match(fs.readFileSync(file, 'utf8'), /# preferencia del usuario/);

    const run = await call('run', { task: 'usar el perfil activo', cwd: tmp('colmena-profile-run-'), wait: true });
    assert.equal(run.worker, 'flash');
    const summary = await call('preferences', {});
    assert.equal(summary.profile, 'flash-only');
    assert.deepEqual(summary.assignments, { flash: 1 });
    assert.deepEqual(summary.profiles['flash-only'], { mix: { flash: 1 }, assignments: { flash: 1 } });

    const beforeInvalid = fs.readFileSync(file, 'utf8');
    const invalid = await call('preferences', { save_profile: { name: 'bad', mix: { ghost: 1 } } });
    assert.match(invalid.error, /ghost.*no existe/);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeInvalid);
  } finally { await client.close(); }
});

test('preferences creates the effective config file when absent', async () => {
  const home = tmp('colmena-pref-missing-');
  const file = path.join(home, 'nested', 'colmena.yml');
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CONFIG: file });
  try {
    assert.deepEqual(await call('preferences', { provider: 'opencode' }), {
      provider: 'opencode', profile: null, profiles: {}, assignments: {}, worker: 'ds-flash', would_choose: 'ds-flash',
    });
    assert.match(fs.readFileSync(file, 'utf8'), /preferences:\s+provider: opencode/);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp')), []);
  } finally { await client.close(); }
});

for (const [label, original] of [['vacío', ''], ['solo comentarios', '# comentario conservado\n# otra nota\n']]) {
  test(`preferences añade su clave a un archivo ${label}`, async () => {
    const { home, file } = providerHome();
    const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CONFIG: file });
    try {
      fs.writeFileSync(file, original);
      const result = await call('preferences', { provider: 'opencode' });
      assert.equal(result.provider, 'opencode');
      assert.equal(result.would_choose, 'flash');
      const saved = fs.readFileSync(file, 'utf8');
      assert.match(saved, /preferences:\s+provider: opencode/);
      if (original) assert.match(saved, /# comentario conservado/);
    } finally { await client.close(); }
  });
}

test('preferences guarda el cambio aunque no haya workers y devuelve would_choose nulo', async () => {
  const { home, file } = providerHome({ codexEnabled: false });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('strengths: [code, docs]}', 'strengths: [code, docs], enabled: false}'));
  const { client, call } = await connect({ COLMENA_HOME: home, COLMENA_CONFIG: file });
  try {
    const result = await call('preferences', { provider: 'codex' });
    assert.equal(result.provider, 'codex');
    assert.equal(result.worker, null);
    assert.equal(result.would_choose, null);
    assert.match(result.note, /preferencia guardada.*router no pudo calcular.*ningún worker disponible/i);
    assert.match(fs.readFileSync(file, 'utf8'), /provider: codex/);
    const workers = await call('workers', {});
    assert.equal(workers.every(worker => !worker.available), true);
    assert.equal(workers.filter(worker => worker.provider === 'codex').every(worker => worker.preferred), true);
  } finally { await client.close(); }
});

test('preferences conserva archivo y memoria si falla el rename', async () => {
  const { home, file } = providerHome();
  const original = fs.readFileSync(file, 'utf8');
  const config = getConfig({
    ...process.env,
    COLMENA_HOME: home,
    COLMENA_CONFIG: file,
    COLMENA_CODEX_BIN: path.join(here, 'fake-codex.js'),
    COLMENA_OPENCODE_BIN: path.join(here, 'fake-opencode.js'),
    COLMENA_NOTIFIER: 'none',
  });
  const { server } = buildServer(config, {
    atomicWriteDependencies: { renameSync: () => { throw new Error('rename failure for test'); } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'injected-test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  try {
    const failed = await call('preferences', { provider: 'opencode' });
    assert.match(failed.error, /rename failure for test/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal((await call('workers', {})).every(worker => !worker.preferred), true);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.endsWith('.tmp')), []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MC-7: diff.patch se publica con writeFileAtomic: rename fallido conserva el previo y no deja .tmp', async () => {
  const home = codexOnlyHome();
  const config = getConfig({ ...process.env, ...baseEnv(home) });
  const { server } = buildServer(config, {
    atomicWriteDependencies: { renameSync: () => { throw new Error('rename failure for test'); } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'injected-test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return r.isError ? { error: text } : JSON.parse(text);
  };
  try {
    const repo = tmp('luna-diff-atomic-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const job = await call('run', { task: 'EDIT uno', cwd: repo, wait: true });
    assert.equal(job.state, 'done');
    const d = await call('diff', { job_id: job.id, max_chars: 20 });
    assert.match(d.error, /rename failure for test/);
    const jobDir = path.join(home, 'jobs', job.id);
    assert.deepEqual(fs.readdirSync(jobDir).filter(name => name.endsWith('.tmp')), []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('preferences falls back across providers with a note, and reload_config reads manual edits', async () => {
  const { home, file } = providerHome({ codexEnabled: false });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('provider: auto', 'provider: codex'));
  const { client, call } = await connect({
    COLMENA_HOME: home, COLMENA_CONFIG: file, COLMENA_CODEX_BIN: path.join(here, 'fake-codex.js'),
    COLMENA_OPENCODE_BIN: path.join(here, 'fake-opencode.js'),
  });
  try {
    assert.deepEqual(await call('preferences', {}), {
      provider: 'codex', worker: 'flash', would_choose: 'flash', note: 'sin workers disponibles de codex; se usó flash',
      profile: null, profiles: {}, assignments: {},
    });
    const fallback = await call('run', { task: 'usar fallback', cwd: tmp('colmena-pref-fallback-'), wait: true });
    assert.equal(fallback.worker, 'flash');
    assert.equal(fallback.note, 'sin workers disponibles de codex; se usó flash');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('provider: codex', 'provider: opencode'));
    const diff = await call('reload_config', {});
    assert.deepEqual(diff.preferences, ['provider']);
    assert.deepEqual(await call('preferences', {}), {
      provider: 'opencode', profile: null, profiles: {}, assignments: {}, worker: 'flash', would_choose: 'flash',
    });
  } finally { await client.close(); }
});

test('MC-2: merge exige veredicto salvo force y devuelve verdict/verdictAt', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const repo = tmp('luna-mc2-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');

    const unreviewed = await call('run', { task: 'EDIT sin veredicto', cwd: repo, wait: true });
    const denied = await call('merge', { job_id: unreviewed.id });
    assert.match(denied.error, /verdict/);
    assert.equal(fs.existsSync(path.join(repo, 'edited.txt')), false);

    const reviewed = await call('run', { task: 'EDIT aceptado', cwd: repo, wait: true });
    const saved = await call('verdict', { job_id: reviewed.id, verdict: 'accepted', note: 'revisado con diff' });
    const merged = await call('merge', { job_id: reviewed.id });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(merged.verdict, 'accepted');
    assert.equal(merged.verdictAt, saved.at);
    assert.ok(fs.existsSync(path.join(repo, 'edited.txt')));

    const forced = await call('run', { task: 'EDIT forzado', cwd: repo, wait: true });
    const forcedMerge = await call('merge', { job_id: forced.id, force: true });
    assert.equal(forcedMerge.ok, true, JSON.stringify(forcedMerge));
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
    await call('verdict', { job_id: edit.id, verdict: 'accepted' });
    const m = await call('merge', { job_id: edit.id });
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.equal(m.verdict, 'accepted');
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

test('cleanup accepts a job branch merged manually without force', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const repo = tmp('luna-manual-merge-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const job = await call('run', { task: 'EDIT manual', cwd: repo, wait: true });
    const metaPath = path.join(home, 'jobs', job.id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(job.state, 'done');
    assert.equal(meta.merged, undefined);

    git(meta.workdir, 'add', '-A');
    git(meta.workdir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'manual worker commit');
    git(repo, 'merge', '--no-ff', '-m', 'manual merge', meta.branch);

    const cleaned = await call('cleanup', { job_id: job.id });
    assert.ok(!cleaned.error, cleaned.error);
    assert.equal(cleaned.removed.length, 1);
  } finally { await client.close(); }
});

test('cleanup accepts a squash completed through the merge tool', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const repo = tmp('luna-squash-cleanup-'); git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    const job = await call('run', { task: 'EDIT squash', cwd: repo, wait: true });
    await call('verdict', { job_id: job.id, verdict: 'accepted' });
    const merged = await call('merge', { job_id: job.id, strategy: 'squash' });
    assert.equal(merged.ok, true);
    const meta = JSON.parse(fs.readFileSync(path.join(home, 'jobs', job.id, 'meta.json'), 'utf8'));
    assert.equal(meta.merged, true);
    assert.equal(iso.isMerged(repo, meta.branch), false);

    const cleaned = await call('cleanup', { job_id: job.id });
    assert.equal(cleaned.removed.length, 1);
  } finally { await client.close(); }
});

test('MC-3: wait valida timeout_s entre 1 y 1800 sin cancelar al vencer', async () => {
  const { client, call } = await connect({ COLMENA_WAIT_MAX_S: '1800' });
  try {
    assert.match((await call('wait', { job_ids: ['nope'], timeout_s: 0 })).error, /timeout_s|1|1800/i);
    assert.match((await call('wait', { job_ids: ['nope'], timeout_s: 5000 })).error, /timeout_s|1|1800/i);
    const fast = await call('run', { task: 'hola', cwd: tmp('luna-mc3-'), wait: true, timeout_s: 1200 });
    assert.equal(fast.state, 'done');
    const slow = await call('run', { task: 'SLEEP', cwd: tmp('luna-mc3-slow-') });
    const w = await call('wait', { job_ids: [slow.job_id], timeout_s: 1 });
    assert.equal(w.pending.length, 1);
    assert.equal(typeof w.pending[0].elapsedS, 'number');
    assert.ok(['queued', 'running'].includes(w.pending[0].state));
    assert.equal((await call('status', { job_id: slow.job_id })).state, w.pending[0].state);
    await call('cancel', { job_id: slow.job_id });
  } finally { await client.close(); }
});
test('MC-4: retry MCP relanza un job fallido con su brief y rechaza los vivos', async () => {
  const home = codexOnlyHome();
  const log = path.join(tmp('luna-retry-mcp-'), 'fake.log');
  const { client, call } = await connect({ COLMENA_HOME: home, FAKE_LOG: log });
  try {
    const failed = await call('run', { task: 'FAIL ronda mcp', cwd: tmp('luna-retry-mcp-c-'), isolation: 'inplace', wait: true });
    assert.equal(failed.state, 'failed');
    assert.match((await call('retry', { job_id: 'nope' })).error, /no existe/);

    const brief = 'corrige la ronda: ' + 'detalle '.repeat(50);
    const retried = await call('retry', { job_id: failed.id, task: brief });
    const done = await call('wait', { job_ids: [retried.job_id], timeout_s: 60 });
    assert.equal(done.done[0].state, 'done');
    const meta = JSON.parse(fs.readFileSync(path.join(home, 'jobs', retried.job_id, 'meta.json'), 'utf8'));
    assert.equal(meta.parentId, failed.id);
    assert.ok((await call('list', {})).some(job => job.id === retried.job_id));
    const prompt = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).prompt;
    assert.ok(prompt.includes(brief));

    const saved = await call('retry', { job_id: retried.job_id });
    const again = await call('wait', { job_ids: [saved.job_id], timeout_s: 60 });
    assert.equal(again.done[0].state, 'done');
    const prompt2 = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).prompt;
    assert.equal(prompt2, fs.readFileSync(path.join(home, 'jobs', retried.job_id, 'brief.md'), 'utf8'));

    const live = await call('run', { task: 'SLEEP mcp', cwd: tmp('luna-retry-live-'), isolation: 'inplace' });
    assert.match((await call('retry', { job_id: live.job_id })).error, /sigue/);
    await call('cancel', { job_id: live.job_id });
  } finally { await client.close(); }
});

test('MC-5: retry MCP acepta worker explícito y lo conserva en el job nuevo', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const failed = await call('run', {
      task: 'FAIL primer intento', cwd: tmp('luna-retry-worker-mcp-'), isolation: 'inplace', worker: 'alt', wait: true,
    });
    assert.equal(failed.state, 'failed');

    const { job_id } = await call('retry', { job_id: failed.id, task: 'reintento correcto', worker: 'luna-max' });
    const waited = await call('wait', { job_ids: [job_id], timeout_s: 60 });
    assert.equal(waited.done[0].state, 'done');
    assert.equal(waited.done[0].worker, 'luna-max');
    assert.equal((await call('status', { job_id })).worker, 'luna-max');
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

test('MC-3: cleanup purge old terminal jobs only', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const jobsDir = path.join(home, 'jobs');
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const seed = (id, meta) => {
      const dir = path.join(jobsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, kind: 'run', task: id, cwd: tmp('luna-mc3-cwd-'), ...meta }));
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
      return dir;
    };
    const removed = [
      seed('viejo-done', { state: 'done', createdAt: now - 9 * day, endedAt: now - 8 * day }),
      seed('viejo-failed', { state: 'failed', createdAt: now - 6 * day, endedAt: now - 5 * day }),
      seed('viejo-sin-ended', { state: 'cancelled', createdAt: now - 7 * day }),
    ];
    const kept = [
      seed('largo-reciente', { state: 'done', createdAt: now - 10 * day, endedAt: now - day / 2 }),
      seed('reciente', { state: 'done', createdAt: now - day, endedAt: now - day / 2 }),
      seed('en-curso', { state: 'running', createdAt: now - 10 * day }),
      seed('en-cola', { state: 'queued', createdAt: now - 10 * day }),
    ];

    const res = await call('cleanup', { older_than_days: 3, force: true });
    assert.deepEqual(res.jobsRemoved.sort(), ['viejo-done', 'viejo-failed', 'viejo-sin-ended']);
    for (const dir of removed) assert.equal(fs.existsSync(dir), false, dir);
    for (const dir of kept) assert.equal(fs.existsSync(dir), true, dir);
    const listed = await call('list', { limit: 50 });
    assert.equal(listed.some(job => job.id.startsWith('viejo')), false);
    assert.equal((await call('stats', { since_days: 30 })).totals.jobs, 4);
    assert.deepEqual((await call('cleanup', { older_than_days: 3, force: true })).jobsRemoved, []);
  } finally { await client.close(); }
});

test('MC-4: cleanup purga también los reports antiguos con force y older_than_days', async () => {
  const home = codexOnlyHome();
  const { client, call } = await connect({ COLMENA_HOME: home });
  try {
    const reportsDir = path.join(home, 'reports');
    const day = 24 * 60 * 60 * 1000;
    const seed = (name, ageDays) => {
      const dir = path.join(reportsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'data.json'), '{}');
      const when = new Date(Date.now() - ageDays * day);
      fs.utimesSync(dir, when, when);
      return dir;
    };
    const oldReport = seed('20260101000000-informe-viejo', 9);
    const oldDeck = seed('20260101000000-hito-deck', 8);
    const recent = seed('20261016000000-reciente', 1);

    assert.match((await call('cleanup', { older_than_days: 3 })).error, /force/);
    const res = await call('cleanup', { older_than_days: 3, force: true });
    assert.deepEqual(res.reportsRemoved.sort(), [oldDeck, oldReport].sort());
    assert.equal(fs.existsSync(oldReport), false);
    assert.equal(fs.existsSync(oldDeck), false);
    assert.ok(fs.existsSync(recent), 'el reporte reciente se conserva');
    assert.deepEqual((await call('cleanup', { older_than_days: 3, force: true })).reportsRemoved, []);
  } finally { await client.close(); }
});
