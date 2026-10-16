import { jobMetrics } from './job-metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_LIMIT = 5;
const ERROR_LIMIT = 200;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);
const VERDICTS = new Set(['accepted', 'needs_work']);

const numberOrZero = value => Number.isFinite(value) ? value : 0;
const successRate = (done, terminal) => terminal ? done / terminal : null;
const ratio = (part, total) => total ? part / total : null;

function newGroup({ nominalCost = false, review = false } = {}) {
  return {
    runs: 0, done: 0, failed: 0, terminal: 0, durationS: 0, durationCount: 0, costUsd: 0, inputTokens: 0, outputTokens: 0,
    ...(nominalCost ? { nominalCostUsd: 0 } : {}),
    ...(review ? { reviewed: 0, accepted: 0, needsWork: 0 } : {}),
  };
}

function addMeta(group, meta, metrics) {
  group.runs++;
  if (meta.state === 'done') group.done++;
  if (meta.state === 'failed') group.failed++;
  if (TERMINAL.has(meta.state)) group.terminal++;
  if (Object.hasOwn(group, 'reviewed') && VERDICTS.has(meta.verdict)) {
    group.reviewed++;
    if (meta.verdict === 'accepted') group.accepted++;
    else group.needsWork++;
  }

  group.durationS += metrics.durationS;
  if (metrics.durationValid) group.durationCount++;
  group.costUsd += metrics.costUsd;
  if (Object.hasOwn(group, 'nominalCostUsd')) group.nominalCostUsd += metrics.nominalCostUsd;
  group.inputTokens += numberOrZero(meta.usage?.input_tokens);
  group.outputTokens += numberOrZero(meta.usage?.output_tokens);
}

function publicGroup(group) {
  return {
    runs: group.runs,
    done: group.done,
    failed: group.failed,
    successRate: successRate(group.done, group.terminal),
    ...(Object.hasOwn(group, 'reviewed') ? {
      reviewed: group.reviewed,
      accepted: group.accepted,
      needsWork: group.needsWork,
      reviewCoverage: ratio(group.reviewed, group.runs),
      acceptanceRate: ratio(group.accepted, group.reviewed),
    } : {}),
    avgDurationS: group.durationCount ? group.durationS / group.durationCount : 0,
    costUsd: group.costUsd,
    inputTokens: group.inputTokens,
    outputTokens: group.outputTokens,
    ...(Object.hasOwn(group, 'nominalCostUsd') ? { nominalCostUsd: group.nominalCostUsd } : {}),
  };
}

function sortedGroups(groups) {
  return Object.fromEntries(Object.keys(groups).sort().map(key => [key, publicGroup(groups[key])]));
}

function collectFailures(metas) {
  const counts = new Map();
  for (const meta of metas) {
    if (!['failed', 'orphaned'].includes(meta.state) || typeof meta.error !== 'string') continue;
    const error = meta.error.replace(/\s+/g, ' ').trim();
    if (error) counts.set(error, (counts.get(error) ?? 0) + 1);
  }
  return [...counts].map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, FAILURE_LIMIT)
    .map(({ message, count }) => ({ error: message.slice(0, ERROR_LIMIT), count }));
}

export function computeStats(metas, { sinceMs = 0, now = Date.now() } = {}) {
  const inRange = metas.filter(meta => Number.isFinite(meta.createdAt) && meta.createdAt >= sinceMs && meta.createdAt <= now);
  const totals = { jobs: inRange.length, done: 0, failed: 0, cancelled: 0, orphaned: 0, terminal: 0, costUsd: 0, durationS: 0 };
  const byWorker = Object.create(null);
  const byKind = Object.create(null);

  for (const meta of inRange) {
    const metrics = jobMetrics(meta);
    if (Object.hasOwn(totals, meta.state)) totals[meta.state]++;
    if (TERMINAL.has(meta.state)) totals.terminal++;
    totals.durationS += metrics.durationS;
    totals.costUsd += metrics.costUsd;

    const worker = meta.worker ?? 'unknown';
    const kind = meta.kind ?? 'unknown';
    (byWorker[worker] ??= newGroup({ nominalCost: true, review: true }));
    (byKind[kind] ??= newGroup());
    addMeta(byWorker[worker], meta, metrics);
    addMeta(byKind[kind], meta, metrics);
  }

  return {
    range: { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString() },
    totals: {
      jobs: totals.jobs,
      done: totals.done,
      failed: totals.failed,
      cancelled: totals.cancelled,
      orphaned: totals.orphaned,
      successRate: successRate(totals.done, totals.terminal),
      costUsd: totals.costUsd,
      durationS: totals.durationS,
    },
    byWorker: sortedGroups(byWorker),
    byKind: sortedGroups(byKind),
    topFailures: collectFailures(inRange),
  };
}

export { DAY_MS };
