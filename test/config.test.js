import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';

test('defaults', () => {
  const c = getConfig({ LUNA_HOME: 'X:\h', LUNA_CODEX_BIN: 'C:\c\codex.exe' });
  assert.equal(c.maxParallel, 4);
  assert.equal(c.timeoutMin, 60);
  assert.equal(c.exitGraceS, 20);
});
test('LUNA_HOME moves dirs', () => {
  const c = getConfig({ LUNA_HOME: 'X:\h', LUNA_CODEX_BIN: 'a.exe' });
  assert.ok(c.jobsDir.startsWith('X:\h') || c.jobsDir.startsWith('X:/h') || c.jobsDir.includes('h'));
  assert.ok(c.jobsDir.endsWith('jobs'));
  assert.ok(c.worktreesDir.endsWith('worktrees'));
});
test('js bin runs through node', () => {
  const c = getConfig({ LUNA_CODEX_BIN: 'x.js', LUNA_HOME: 'h' });
  assert.equal(c.codex.bin, process.execPath);
  assert.deepEqual(c.codex.prefixArgs, ['x.js']);
});
test('exe bin as-is', () => {
  const c = getConfig({ LUNA_CODEX_BIN: 'C:\c\codex.exe', LUNA_HOME: 'h' });
  assert.equal(c.codex.bin, 'C:\c\codex.exe');
  assert.deepEqual(c.codex.prefixArgs, []);
});
test('env numbers', () => {
  const c = getConfig({ LUNA_MAX_PARALLEL: '2', LUNA_JOB_TIMEOUT_MIN: '0.5', LUNA_CODEX_BIN: 'a.exe', LUNA_HOME: 'h' });
  assert.equal(c.maxParallel, 2);
  assert.equal(c.timeoutMin, 0.5);
});
test('COLMENA_EXIT_GRACE_S overrides YAML default, including after reload', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-exit-grace-'));
  fs.writeFileSync(path.join(home, 'colmena.yml'), 'defaults: {worker: luna-max, exit_grace_s: 1}\n');
  const c = getConfig({ COLMENA_HOME: home, COLMENA_EXIT_GRACE_S: '3.5' });
  assert.equal(c.exitGraceS, 3.5);
  fs.writeFileSync(path.join(home, 'colmena.yml'), 'defaults: {worker: luna-max, exit_grace_s: 2}\n');
  c.reloadSettings();
  assert.equal(c.exitGraceS, 3.5);
});
test('reloadSettings picks up a changed YAML exit_grace_s', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-reload-grace-'));
  const file = path.join(home, 'colmena.yml');
  fs.writeFileSync(file, 'defaults: {worker: luna-max, exit_grace_s: 1}\n');
  const c = getConfig({ COLMENA_HOME: home });
  assert.equal(c.exitGraceS, 1);
  fs.writeFileSync(file, 'defaults: {worker: luna-max, exit_grace_s: 2}\n');
  c.reloadSettings();
  assert.equal(c.exitGraceS, 2);
});
