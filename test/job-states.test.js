import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL, VERDICTS } from '../src/job-states.js';

test('TERMINAL y VERDICTS viven en el módulo compartido src/job-states.js', () => {
  assert.ok(TERMINAL instanceof Set);
  assert.ok(VERDICTS instanceof Set);
  assert.deepEqual([...TERMINAL].sort(), ['cancelled', 'done', 'failed', 'orphaned']);
  assert.deepEqual([...VERDICTS].sort(), ['accepted', 'needs_work']);
});
