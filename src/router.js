const round = n => Math.round(n * 1e6) / 1e6;

export function workerStatus(settings, ledger) {
  return Object.entries(settings.workers).map(([alias, w]) => {
    const spent = ledger.spent(alias);
    const budget = w.budget?.monthly_usd ?? null;
    return {
      alias, provider: w.provider, model: w.model, effort: w.effort ?? null, priority: w.priority, strengths: w.strengths,
      enabled: w.enabled !== false, spent_usd: spent, budget_usd: budget,
      remaining_usd: budget == null ? null : round(Math.max(0, budget - spent)),
      available: w.enabled !== false && (budget == null || spent < budget),
    };
  });
}

// Explicit worker → must be available (never a silent fallback). None → default if available, else lowest priority.
// `kind` prefers workers whose strengths include it.
export function pickWorker(settings, ledger, { worker, kind } = {}) {
  const rows = workerStatus(settings, ledger).sort((a, b) => a.priority - b.priority);
  const avail = rows.filter(r => r.available);
  const alts = alias => avail.filter(r => r.alias !== alias).map(r => r.alias).join(', ') || 'ninguna';
  if (worker) {
    const r = rows.find(x => x.alias === worker);
    if (!r) throw new Error(`worker '${worker}' no existe; disponibles: ${rows.map(x => x.alias).join(', ')}`);
    if (!r.available) throw new Error(`worker '${worker}' sin presupuesto${r.enabled ? ` (gastado $${r.spent_usd} de $${r.budget_usd})` : ' (deshabilitado)'}; alternativas: ${alts(worker)}`);
    return worker;
  }
  if (!avail.length) throw new Error('ningún worker disponible (todos sin presupuesto o deshabilitados); revisa colmena.yml');
  const matching = kind ? avail.filter(r => r.strengths.includes(kind)) : [];
  if (matching.length) return matching[0].alias;
  const def = avail.find(r => r.alias === settings.defaults.worker);
  return (def ?? avail[0]).alias;
}
