import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { loadSettings } from '../src/settings.js';
import { baseEnv, until } from './helpers.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const d = tmp('colmena-pf-repo-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'i');
  return d;
}
const home = extra => {
  const h = tmp('colmena-pf-h-');
  fs.writeFileSync(path.join(h, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, effort: max, priority: 1, strengths: [code], budget: {monthly_usd: 10}, reserve_usd: 0.5}
roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}
plugins: {notify: {enabled: false}}
${extra}`);
  return h;
};
const enoent = cmd => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
const readUsage = config => { try { return JSON.parse(fs.readFileSync(config.usagePath, 'utf8')); } catch { return {}; } };
const CWD = () => tmp('colmena-pf-c-');

test('jobs: preflight falla → failed rápido, con hints, sin reservar cuota ni lanzar agente', async () => {
  const config = getConfig(baseEnv(home('defaults: {worker: luna-max, requires: [docker]}\n')));
  const calls = [];
  const exec = async cmd => { calls.push(cmd); return { code: null, error: enoent(cmd), stdout: '', stderr: '' }; };
  const jm = createJobManager(config, { preflightExec: exec });
  const id = jm.submit({ task: 'hola', cwd: CWD(), isolation: 'inplace' });
  assert.deepEqual(jm.meta(id).requires, ['docker']);
  const [r] = (await jm.wait([id], { timeoutS: 20 })).done;
  assert.equal(r.state, 'failed');
  assert.match(r.error, /^preflight: docker: no se encontró el binario 'docker'/);
  assert.ok(r.hints.some(hint => /instala Docker/.test(hint)));
  assert.equal(jm.meta(id).pid, undefined);
  assert.equal(fs.existsSync(path.join(jm.jobDir(id), 'events.jsonl')), false);
  assert.deepEqual(calls, ['docker']);
  const usage = readUsage(config);
  assert.deepEqual(Object.keys(usage.reservations ?? {}), []);
  assert.equal(usage[new Date().toISOString().slice(0, 7)]?.['luna-max']?.runs ?? 0, 0);
});

test('jobs: requires: [] explícito anula defaults.requires', async () => {
  const config = getConfig(baseEnv(home('defaults: {worker: luna-max, requires: [docker]}\n')));
  let called = 0;
  const jm = createJobManager(config, { preflightExec: async () => { called += 1; return { code: 0, stdout: '', stderr: '' }; } });
  const id = jm.submit({ task: 'hola', cwd: CWD(), isolation: 'inplace', requires: [] });
  const [r] = (await jm.wait([id], { timeoutS: 20 })).done;
  assert.equal(r.state, 'done');
  assert.equal(called, 0);
});

test('jobs: worktree.requires se suma a defaults.requires en jobs worktree', async () => {
  const config = getConfig(baseEnv(home('defaults: {worker: luna-max, requires: [git]}\nworktree: {requires: [docker]}\n')));
  const calls = [];
  const exec = async cmd => {
    calls.push(cmd);
    return cmd === 'docker'
      ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }
      : { code: 0, stdout: '', stderr: '' };
  };
  const jm = createJobManager(config, { preflightExec: exec });
  const id = jm.submit({ task: 'hola', cwd: repo(), isolation: 'worktree' });
  assert.deepEqual(jm.meta(id).requires, ['git', 'docker']);
  const [r] = (await jm.wait([id], { timeoutS: 30 })).done;
  assert.equal(r.state, 'failed');
  assert.match(r.error, /preflight: docker: 'docker info' falló con código 1/);
  assert.ok(calls.includes('git') && calls.includes('docker'));
});

test('jobs: preflight ok reserva presupuesto solo tras pasar y lo libera al terminar', async () => {
  const config = getConfig(baseEnv(home('defaults: {worker: luna-max, requires: [docker]}\n'), { COLMENA_MAX_PARALLEL: '1' }));
  const jm = createJobManager(config, { preflightExec: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const blocker = jm.submit({ task: 'SLEEP', cwd: CWD(), isolation: 'inplace' });
  const id = jm.submit({ task: 'hola', cwd: CWD(), isolation: 'inplace' });
  await until(() => readUsage(config).reservations?.[id], 'la reserva aparece tras pasar el preflight');
  assert.equal(jm.meta(id).state, 'queued');
  await jm.cancel(blocker);
  const [r] = (await jm.wait([id], { timeoutS: 20 })).done;
  assert.equal(r.state, 'done');
  assert.deepEqual(Object.keys(readUsage(config).reservations ?? {}), []);
});

test('jobs: timeout de un requisito falla con el comando y los segundos', async () => {
  const config = getConfig(baseEnv(home('defaults: {worker: luna-max, requires: [docker]}\n')));
  const jm = createJobManager(config, { preflightExec: async () => ({ code: null, timedOut: true, stdout: '', stderr: '' }) });
  const id = jm.submit({ task: 'hola', cwd: CWD(), isolation: 'inplace' });
  const [r] = (await jm.wait([id], { timeoutS: 20 })).done;
  assert.equal(r.state, 'failed');
  assert.match(r.error, /^preflight: docker: 'docker info' no respondió en 8 s/);
});

test('settings: defaults.requires y worktree.requires aceptan listas y rechazan basura', () => {
  const h = tmp('colmena-pf-s-');
  fs.writeFileSync(path.join(h, 'colmena.yml'), 'defaults: {worker: luna-max, requires: [docker, "port:5432"]}\nworktree: {requires: ["url:http://localhost:3000"]}\n');
  const s = loadSettings(h, {});
  assert.deepEqual(s.defaults.requires, ['docker', 'port:5432']);
  assert.deepEqual(s.worktree.requires, ['url:http://localhost:3000']);
  const empty = tmp('colmena-pf-s2-');
  assert.deepEqual(loadSettings(empty, {}).defaults.requires, []);
  assert.deepEqual(loadSettings(empty, {}).worktree.requires, []);
  fs.writeFileSync(path.join(h, 'colmena.yml'), 'defaults: {worker: luna-max, requires: docker}\n');
  assert.throws(() => loadSettings(h, {}), /defaults\.requires/);
  fs.writeFileSync(path.join(h, 'colmena.yml'), 'worktree: {requires: [1]}\n');
  assert.throws(() => loadSettings(h, {}), /worktree\.requires/);
});
