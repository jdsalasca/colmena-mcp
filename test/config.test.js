import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

test('defaults', () => {
  const c = getConfig({ LUNA_HOME: 'X:\h', LUNA_CODEX_BIN: 'C:\c\codex.exe' });
  assert.equal(c.maxParallel, 4);
  assert.equal(c.timeoutMin, 60);
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
