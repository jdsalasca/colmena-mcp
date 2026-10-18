export const numberOrZero = value => Number.isFinite(value) ? value : 0;
export const round = n => Math.round(n * 1e6) / 1e6;
export const TOOL_SUMMARY_MAX = 80;

// Idle/progress derived from the last event of events.jsonl or CPU growth of the process tree.
export function activityMetrics({ now, lastActivityAt, stallTimeoutMin, running = true } = {}) {
  const known = Number.isFinite(lastActivityAt);
  const idleMs = known ? Math.max(0, now - lastActivityAt) : null;
  const stallMs = Number.isFinite(stallTimeoutMin) ? stallTimeoutMin * 60000 : 0;
  return {
    lastActivityAt: known ? lastActivityAt : null,
    idleS: idleMs == null ? null : Math.round(idleMs / 1000),
    looksStalled: !!(running && known && stallMs > 0 && idleMs > stallMs / 2),
  };
}

export function shortTool(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, TOOL_SUMMARY_MAX) : null;
}

export function jobMetrics(meta) {
  const durationValid = Number.isFinite(meta.startedAt)
    && Number.isFinite(meta.endedAt)
    && meta.endedAt >= meta.startedAt;

  return {
    durationValid,
    durationS: durationValid ? (meta.endedAt - meta.startedAt) / 1000 : 0,
    costUsd: Number(numberOrZero(meta.costUsd).toFixed(4)),
    nominalCostUsd: Number(numberOrZero(meta.nominalCostUsd ?? meta.costUsd).toFixed(4)),
  };
}
