const numberOrZero = value => Number.isFinite(value) ? value : 0;

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
