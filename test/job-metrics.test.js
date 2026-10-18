import test from 'node:test';
import assert from 'node:assert/strict';
import { activityMetrics, shortTool, TOOL_SUMMARY_MAX } from '../src/job-metrics.js';

test('activityMetrics calcula idleS y looksStalled sobre la mitad de stall_timeout_min', () => {
  assert.deepEqual(activityMetrics({ now: 10_000, lastActivityAt: 4_000, stallTimeoutMin: 0.1, running: true }),
    { lastActivityAt: 4_000, idleS: 6, looksStalled: true });
  assert.deepEqual(activityMetrics({ now: 10_000, lastActivityAt: 8_000, stallTimeoutMin: 0.1, running: true }),
    { lastActivityAt: 8_000, idleS: 2, looksStalled: false });
});

test('activityMetrics no marca stalled en jobs terminales, con el vigilante apagado ni sin actividad conocida', () => {
  assert.equal(activityMetrics({ now: 10_000, lastActivityAt: 0, stallTimeoutMin: 15, running: false }).looksStalled, false);
  assert.equal(activityMetrics({ now: 10_000, lastActivityAt: 0, stallTimeoutMin: 0, running: true }).looksStalled, false);
  assert.deepEqual(activityMetrics({ now: 10_000, lastActivityAt: null, stallTimeoutMin: 15, running: true }),
    { lastActivityAt: null, idleS: null, looksStalled: false });
  assert.equal(activityMetrics({ now: 1_000, lastActivityAt: 9_000, stallTimeoutMin: 15, running: true }).idleS, 0);
});

test('shortTool normaliza espacios, recorta a 80 caracteres y devuelve null si no hay nada', () => {
  assert.equal(shortTool('  bash:   npm   test \n'), 'bash: npm test');
  assert.equal(shortTool(`command: ${'x'.repeat(200)}`).length, TOOL_SUMMARY_MAX);
  assert.equal(shortTool(''), null);
  assert.equal(shortTool(null), null);
  assert.equal(shortTool(undefined), null);
});
