import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/atomic-write.js';

test('writeFileAtomic replaces the destination and removes its temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-atomic-'));
  const file = path.join(dir, 'settings.yml');
  fs.writeFileSync(file, 'before');

  writeFileAtomic(file, 'after');

  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.deepEqual(fs.readdirSync(dir), ['settings.yml']);
});

test('writeFileAtomic preserves the original and cleans the temporary file when rename fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-atomic-fail-'));
  const file = path.join(dir, 'settings.yml');
  fs.writeFileSync(file, 'original');

  assert.throws(() => writeFileAtomic(file, 'replacement', {
    renameSync: () => { throw new Error('rename failed'); },
  }), /rename failed/);

  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir), ['settings.yml']);
});
