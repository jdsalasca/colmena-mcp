const round = n => Math.round(n * 1e6) / 1e6;

export function workerStatus(settings, ledger) {
  const preferredProvider = settings.preferences?.provider ?? 'auto';
  return Object.entries(settings.workers).map(([alias, w]) => {
    const spent = ledger.spent(alias);
    const budget = w.budget?.monthly_usd ?? null;
    return {
      alias, provider: w.provider, model: w.model, effort: w.effort ?? null, priority: w.priority, strengths: w.strengths,
      enabled: w.enabled !== false, spent_usd: spent, budget_usd: budget,
      remaining_usd: budget == null ? null : round(Math.max(0, budget - spent)),
      available: w.enabled !== false && (budget == null || spent < budget),
      preferred: preferredProvider !== 'auto' && w.provider === preferredProvider,
    };
  });
}

// Explicit worker → must be available (never a silent fallback). None → default if available, else lowest priority.
// A provider preference narrows the candidate set before applying `kind` and `defaults.worker`.
export function chooseWorker(settings, ledger, { worker, kind } = {}) {
  const rows = workerStatus(settings, ledger).sort((a, b) => a.priority - b.priority);
  const avail = rows.filter(r => r.available);
  const alts = alias => avail.filter(r => r.alias !== alias).map(r => r.alias).join(', ') || 'ninguna';
  if (worker) {
    const r = rows.find(x => x.alias === worker);
    if (!r) throw new Error(`worker '${worker}' no existe; disponibles: ${rows.map(x => x.alias).join(', ')}`);
    if (!r.available) throw new Error(`worker '${worker}' sin presupuesto${r.enabled ? ` (gastado $${r.spent_usd} de $${r.budget_usd})` : ' (deshabilitado)'}; alternativas: ${alts(worker)}`);
    return { alias: worker };
  }
  if (!avail.length) throw new Error('ningún worker disponible (todos sin presupuesto o deshabilitados); revisa colmena.yml');
  const preferredProvider = settings.preferences?.provider ?? 'auto';
  const preferred = preferredProvider === 'auto' ? avail : avail.filter(r => r.provider === preferredProvider);
  const candidates = preferred.length ? preferred : avail;
  const matching = kind ? candidates.filter(r => r.strengths.includes(kind)) : [];
  const def = candidates.find(r => r.alias === settings.defaults.worker);
  const alias = (matching[0] ?? def ?? candidates[0]).alias;
  return {
    alias,
    ...(!preferred.length && preferredProvider !== 'auto'
      ? { note: `sin workers disponibles de ${preferredProvider}; se usó ${alias}` }
      : {}),
  };
}

export function pickWorker(settings, ledger, options) {
  return chooseWorker(settings, ledger, options).alias;
}
