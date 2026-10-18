import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, workerDurationEstimates } from '../src/stats.js';

const now = Date.UTC(2026, 9, 15, 12);

test('computeStats agrega estados, workers, kinds, costos, tokens y duración en la ventana', () => {
  const sinceMs = now - 20_000;
  const metas = [
    { id: '1', createdAt: now - 10_000, startedAt: now - 9_000, endedAt: now - 6_000, state: 'done', worker: 'luna', kind: 'run', costUsd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } },
    { id: '2', createdAt: now - 8_000, startedAt: now - 7_000, endedAt: now - 5_000, state: 'failed', worker: 'luna', kind: 'run', costUsd: 1, usage: { input_tokens: 5, output_tokens: 2 }, error: 'misma falla' },
    { id: '3', createdAt: now - 7_000, startedAt: now - 6_500, endedAt: now - 6_500, state: 'cancelled', worker: 'alt', kind: 'review', usage: {} },
    { id: '4', createdAt: now - 6_000, state: 'orphaned', worker: 'alt', kind: 'run', error: 'misma falla' },
    { id: '5', createdAt: sinceMs, state: 'queued', worker: 'luna', kind: 'run' },
    { id: 'old', createdAt: sinceMs - 1, state: 'done', worker: 'luna', kind: 'run', costUsd: 99 },
  ];

  assert.deepEqual(computeStats(metas, { sinceMs, now }), {
    range: { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString() },
    totals: { jobs: 5, done: 1, failed: 1, cancelled: 1, orphaned: 1, successRate: 0.25, costUsd: 1.25, durationS: 5 },
    byWorker: {
      alt: { runs: 2, done: 0, failed: 0, successRate: 0, reviewed: 0, accepted: 0, needsWork: 0, reviewCoverage: 0, acceptanceRate: null, avgDurationS: 0, costUsd: 0, nominalCostUsd: 0, inputTokens: 0, outputTokens: 0 },
      luna: { runs: 3, done: 1, failed: 1, successRate: 0.5, reviewed: 0, accepted: 0, needsWork: 0, reviewCoverage: 0, acceptanceRate: null, avgDurationS: 2.5, costUsd: 1.25, nominalCostUsd: 1.25, inputTokens: 15, outputTokens: 22 },
    },
    byKind: {
      review: { runs: 1, done: 0, failed: 0, successRate: 0, avgDurationS: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      run: { runs: 4, done: 1, failed: 1, successRate: 1 / 3, avgDurationS: 2.5, costUsd: 1.25, inputTokens: 15, outputTokens: 22 },
    },
    topFailures: [{ error: 'misma falla', count: 2 }],
  });
});

test('computeStats trunca y agrupa errores y limita el resultado a cinco', () => {
  const errorPrefix = 'x'.repeat(250);
  const metas = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: String(i), createdAt: now, state: 'failed', error: errorPrefix })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `other-${i}`, createdAt: now, state: 'failed', error: `error ${i}` })),
  ];

  const stats = computeStats(metas, { sinceMs: now, now });
  assert.equal(stats.topFailures.length, 5);
  assert.deepEqual(stats.topFailures[0], { error: errorPrefix.slice(0, 200), count: 7 });
  assert.equal(stats.topFailures[1].count, 1);
  assert.equal(stats.topFailures[1].error, 'error 0');
});

test('computeStats conserva errores distintos que comparten el prefijo mostrado', () => {
  const prefix = 'x'.repeat(200);
  const stats = computeStats([
    { id: '1', createdAt: now, state: 'failed', error: `${prefix} primer detalle` },
    { id: '2', createdAt: now, state: 'failed', error: `${prefix} segundo detalle` },
  ], { sinceMs: now, now });

  assert.deepEqual(stats.topFailures, [
    { error: prefix, count: 1 },
    { error: prefix, count: 1 },
  ]);
});

test('avgDurationS divide solo entre jobs con duración válida', () => {
  const stats = computeStats([
    { id: 'finished', createdAt: now, startedAt: now - 4000, endedAt: now, state: 'done', worker: 'luna', kind: 'run' },
    { id: 'running', createdAt: now, startedAt: now - 1000, state: 'running', worker: 'luna', kind: 'run' },
  ], { sinceMs: now, now });

  assert.equal(stats.byWorker.luna.avgDurationS, 4);
  assert.equal(stats.byKind.run.avgDurationS, 4);
});

test('computeStats acepta el worker __proto__ sin alterar el prototipo', () => {
  const stats = computeStats([
    { id: 'proto', createdAt: now, state: 'done', worker: '__proto__', kind: '__proto__' },
  ], { sinceMs: now, now });

  assert.equal(Object.hasOwn(stats.byWorker, '__proto__'), true);
  assert.equal(Object.hasOwn(stats.byKind, '__proto__'), true);
  assert.equal(stats.byWorker.__proto__.runs, 1);
  assert.equal(stats.byKind.__proto__.runs, 1);
  assert.equal(Object.hasOwn(Object.prototype, 'runs'), false);
});

test('computeStats separa por worker cobertura de revisión y aceptación sin contar sin veredicto como rechazo', () => {
  const metas = [
    { id: 'a1', createdAt: now, state: 'done', worker: 'luna', kind: 'run', verdict: 'accepted' },
    { id: 'a2', createdAt: now, state: 'done', worker: 'luna', kind: 'run', verdict: 'accepted' },
    { id: 'a3', createdAt: now, state: 'failed', worker: 'luna', kind: 'run', verdict: 'needs_work' },
    { id: 'a4', createdAt: now, state: 'done', worker: 'luna', kind: 'run' },
    { id: 'b1', createdAt: now, state: 'done', worker: 'alt', kind: 'run' },
    { id: 'b2', createdAt: now, state: 'done', worker: 'alt', kind: 'run', verdict: 'needs_work' },
    { id: 'c1', createdAt: now, state: 'done', worker: 'otro', kind: 'run', verdict: 'banana' },
  ];

  const stats = computeStats(metas, { sinceMs: now, now });

  assert.deepEqual(stats.byWorker.luna, {
    runs: 4, done: 3, failed: 1, successRate: 0.75,
    reviewed: 3, accepted: 2, needsWork: 1, reviewCoverage: 0.75, acceptanceRate: 2 / 3,
    avgDurationS: 0, costUsd: 0, nominalCostUsd: 0, inputTokens: 0, outputTokens: 0,
  });
  assert.deepEqual(stats.byWorker.alt, {
    runs: 2, done: 2, failed: 0, successRate: 1,
    reviewed: 1, accepted: 0, needsWork: 1, reviewCoverage: 0.5, acceptanceRate: 0,
    avgDurationS: 0, costUsd: 0, nominalCostUsd: 0, inputTokens: 0, outputTokens: 0,
  });
  assert.equal(stats.byWorker.otro.reviewed, 0);
  assert.equal(stats.byWorker.otro.reviewCoverage, 0);
  assert.equal(stats.byWorker.otro.acceptanceRate, null);
  assert.equal('reviewed' in stats.byKind.run, false);
});

test('computeStats devuelve ceros y tasa nula cuando no hay metas', () => {
  assert.deepEqual(computeStats([], { sinceMs: now - 1000, now }), {
    range: { since: new Date(now - 1000).toISOString(), until: new Date(now).toISOString() },
    totals: { jobs: 0, done: 0, failed: 0, cancelled: 0, orphaned: 0, successRate: null, costUsd: 0, durationS: 0 },
    byWorker: {}, byKind: {}, topFailures: [],
  });
});

test('computeStats agrega costo nominal por worker además del costo contabilizado', () => {
  const stats = computeStats([
    { createdAt: now, state: 'done', worker: 'gratis', kind: 'run', costUsd: 0, nominalCostUsd: 0.02 },
  ], { sinceMs: now, now });

  assert.equal(stats.byWorker.gratis.costUsd, 0);
  assert.equal(stats.byWorker.gratis.nominalCostUsd, 0.02);
});

const finished = (id, worker, durationS, state = 'done') => ({
  id, worker, state, createdAt: now - durationS * 1000, startedAt: now - durationS * 1000, endedAt: now,
});

test('workerDurationEstimates calcula avg/p90 en minutos y exige 3 muestras', () => {
  const estimates = workerDurationEstimates([
    finished('a', 'luna', 3600), finished('b', 'luna', 5400), finished('c', 'luna', 7200),
    finished('d', 'alt', 60, 'failed'), finished('e', 'alt', 180, 'cancelled'),
    { id: 'f', worker: 'luna', state: 'running', createdAt: now, startedAt: now - 10_000 },
    { id: 'g', worker: 'alt', state: 'done', createdAt: now },
  ]);

  assert.deepEqual(estimates, {
    luna: { samples: 3, avgDurationMin: 90, p90DurationMin: 120, etaHint: '~90 min (p90 120 min, n=3)' },
    alt: { samples: 2, avgDurationMin: null, p90DurationMin: null, etaHint: 'sin muestras suficientes (2/3)' },
  });
});

test('workerDurationEstimates usa nearest-rank para p90', () => {
  const metas = Array.from({ length: 10 }, (_, i) => finished(`j${i}`, 'luna', (i + 1) * 60));
  assert.deepEqual(workerDurationEstimates(metas).luna, {
    samples: 10, avgDurationMin: 5.5, p90DurationMin: 9, etaHint: '~5.5 min (p90 9 min, n=10)',
  });
  assert.deepEqual(workerDurationEstimates([], {}), {});
});
