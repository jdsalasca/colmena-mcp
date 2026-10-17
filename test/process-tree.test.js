import test from 'node:test';
import assert from 'node:assert/strict';
import { descendantsOf, killPlan, parseSnapshot } from '../src/process-tree.js';

test('descendantsOf follows the parent chain and excludes the root', () => {
  const snap = [
    { pid: 1, ppid: 0, name: 'root', created: 1, cpuMs: 0 },
    { pid: 2, ppid: 1, name: 'mid', created: 2, cpuMs: 0 },
    { pid: 3, ppid: 2, name: 'grand', created: 3, cpuMs: 0 },
    { pid: 4, ppid: 99, name: 'ajeno', created: 4, cpuMs: 0 },
  ];
  assert.deepEqual(descendantsOf(1, snap).map(p => p.pid).sort(), [2, 3]);
  assert.deepEqual(descendantsOf(99, snap).map(p => p.pid), [4]);
  assert.deepEqual(descendantsOf(undefined, snap), []);
});

test('descendantsOf tolerates cycles and a dead root', () => {
  const snap = [
    { pid: 1, ppid: 2, name: 'a', created: 1, cpuMs: 0 },
    { pid: 2, ppid: 1, name: 'b', created: 2, cpuMs: 0 },
  ];
  assert.deepEqual(descendantsOf(1, snap).map(p => p.pid), [2]);
  assert.deepEqual(descendantsOf(77, snap), []);
});

test('killPlan orders deepest first, includes the union and skips reused PIDs', () => {
  const snap = [
    { pid: 10, ppid: 0, name: 'agent', created: 1000, cpuMs: 0 },
    { pid: 11, ppid: 10, name: 'mid', created: 2000, cpuMs: 0 },
    { pid: 12, ppid: 11, name: 'grand', created: 3000, cpuMs: 0 },
    { pid: 13, ppid: 999, name: 'detached', created: 4000, cpuMs: 0 },
    { pid: 14, ppid: 12, name: 'reused', created: 9999, cpuMs: 0 },
  ];
  const known = new Map([[11, 2000], [12, 3000], [13, 4000], [14, 5000], [15, 6000]]);
  assert.deepEqual(killPlan(10, snap, known).map(p => p.pid), [12, 13, 11]);
});

test('parseSnapshot normalizes the PowerShell payload and ignores garbage', () => {
  const created = 1_700_000_000_000;
  const payload = JSON.stringify([
    { ProcessId: 44, ParentProcessId: 1, Name: 'find.exe', Created: created, CpuMs: 12.6 },
    { ProcessId: 0, ParentProcessId: 0, Name: 'idle', Created: 0, CpuMs: 0 },
  ]);
  assert.deepEqual(parseSnapshot(payload), [
    { pid: 44, ppid: 1, name: 'find.exe', created: 1_700_000_000_000, cpuMs: 13 },
  ]);
  assert.deepEqual(parseSnapshot(''), []);
  assert.deepEqual(parseSnapshot('no json'), []);
  assert.equal(parseSnapshot(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'x', Created: created, CpuMs: 1 })).length, 1);
});
