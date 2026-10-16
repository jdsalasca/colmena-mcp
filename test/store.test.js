import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createStore } from '../src/store.js';

const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-store-'));
  return createStore(getConfig({ LUNA_HOME: home, LUNA_CODEX_BIN: 'x.js' }));
};
test('create/get roundtrip + unknown id', () => {
  const s = mk();
  const id = s.newId();
  s.create({ id, state: 'queued', task: 't', createdAt: 1 });
  assert.equal(s.get(id).task, 't');
  assert.equal(s.get('nope'), null);
});
test('update merges', () => {
  const s = mk(); const id = s.newId();
  s.create({ id, state: 'queued', createdAt: 1 });
  s.update(id, { state: 'running' });
  assert.equal(s.get(id).state, 'running');
  assert.equal(s.get(id).createdAt, 1);
});
test('list filters, limit, newest first', () => {
  const s = mk();
  for (let i = 1; i <= 4; i++) s.create({ id: 'j' + i, state: i % 2 ? 'done' : 'failed', createdAt: i });
  assert.deepEqual(s.list({ state: 'done' }).map(j => j.id), ['j3', 'j1']);
  assert.equal(s.list({ limit: 2 }).length, 2);
  assert.equal(s.list({})[0].id, 'j4');
});
test('audit appends json line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-audit-'));
  const cfg = getConfig({ LUNA_HOME: home, LUNA_CODEX_BIN: 'x.js' });
  const s = createStore(cfg);
  s.audit({ id: 'a' }); s.audit({ id: 'b' });
  const lines = fs.readFileSync(cfg.auditPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).id, 'b');
});
