import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';
import { baseEnv, codexOnlyHome, fakeCodex, fakeOpencode, tmp } from './helpers.js';

const CHECK_NAMES = ['node', 'git', 'config', 'home', 'codex', 'opencode', 'widget', 'locks'];
const configWithFakes = extra => getConfig(baseEnv(codexOnlyHome(), { COLMENA_OPENCODE_BIN: fakeOpencode, ...extra }));
const byName = diag => Object.fromEntries(diag.checks.map(c => [c.name, c]));

test('MC-7: doctor da ok con los fakes configurados y un home escribible sin crear jobs', () => {
  const config = configWithFakes();
  const diag = runDoctor(config);
  assert.deepEqual(diag.checks.map(c => c.name), CHECK_NAMES);
  assert.equal(diag.ok, true, JSON.stringify(diag.checks));
  const checks = byName(diag);
  assert.equal(checks.node.status, 'ok');
  assert.equal(checks.git.status, 'ok');
  assert.equal(checks.config.status, 'ok');
  assert.equal(checks.home.status, 'ok');
  assert.equal(checks.codex.status, 'ok');
  assert.ok(checks.codex.detail.includes(fakeCodex), checks.codex.detail);
  assert.equal(checks.opencode.status, 'ok');
  assert.ok(checks.opencode.detail.includes(fakeOpencode), checks.opencode.detail);
  assert.equal(checks.locks.status, 'ok');
  assert.ok(['ok', 'warn'].includes(checks.widget.status), checks.widget.detail);
  assert.deepEqual(fs.readdirSync(config.jobsDir), []);
});

test('MC-7: un binario de Codex inexistente falla con hint y sin lanzar nada', () => {
  const missing = path.join(tmp('colmena-doctor-miss-'), 'codex-nope.exe');
  const config = configWithFakes({ COLMENA_CODEX_BIN: missing });
  const diag = runDoctor(config);
  const codex = byName(diag).codex;
  assert.equal(codex.status, 'fail');
  assert.match(codex.detail, /COLMENA_CODEX_BIN/);
  assert.match(codex.detail, /instala/i);
  assert.equal(diag.ok, false);
});

test('MC-7: un binario de OpenCode inexistente también falla', () => {
  const missing = path.join(tmp('colmena-doctor-miss-oc-'), 'opencode-nope.exe');
  const config = getConfig(baseEnv(codexOnlyHome(), { COLMENA_OPENCODE_BIN: missing }));
  const diag = runDoctor(config);
  const opencode = byName(diag).opencode;
  assert.equal(opencode.status, 'fail');
  assert.match(opencode.detail, /COLMENA_OPENCODE_BIN/);
  assert.equal(diag.ok, false);
});

test('MC-7: un lock obsoleto de usage.json sale warn sin borrarlo', () => {
  const config = configWithFakes();
  const lock = `${config.usagePath}.lock`;
  fs.writeFileSync(lock, `${process.pid}:0`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  const diag = runDoctor(config);

  assert.equal(byName(diag).locks.status, 'warn');
  assert.match(byName(diag).locks.detail, /obsoleto/i);
  assert.equal(diag.ok, true);
  assert.ok(fs.existsSync(lock), 'doctor no borra el lock');
});

test('MC-7: el ejecutable del widget es opcional (warn si falta, ok si existe)', () => {
  const config = configWithFakes();
  const exe = path.join(tmp('colmena-doctor-widget-'), 'colmena-widget.exe');
  fs.writeFileSync(exe, 'fake executable');
  const present = runDoctor(config, { env: { ...process.env, COLMENA_WIDGET_BIN: exe } });
  assert.equal(byName(present).widget.status, 'ok');
  assert.equal(present.ok, true);

  const absent = runDoctor(config, { env: { ...process.env, COLMENA_WIDGET_BIN: path.join(path.dirname(exe), 'nope.exe') } });
  assert.equal(byName(absent).widget.status, 'warn');
  assert.equal(absent.ok, true);
});
