import { round } from './job-metrics.js';

// Estimated cost reserved per job so N concurrent submits cannot drain the same balance; worker overrides defaults.
export const reserveUsdOf = (settings, worker) => worker.reserve_usd ?? settings.defaults.reserve_usd ?? 0;

// With a reserve, the next job's estimate must also fit (equality fits); without one, the strict "spent < budget" holds.
const canAfford = (committed, budget, reserve) => (reserve > 0 ? committed + reserve <= budget : committed < budget);

const activeProfile = settings => {
  const name = settings.preferences?.profile;
  const profile = name ? settings.profiles?.[name] : null;
  return profile ? { name, ...profile } : null;
};

const preferredProviderOf = settings => {
  const profile = activeProfile(settings);
  return profile?.provider ?? settings.preferences?.provider ?? 'auto';
};

export function workerStatus(settings, ledger) {
  const preferredProvider = preferredProviderOf(settings);
  const mix = activeProfile(settings)?.mix;
  const totalWeight = mix ? Object.values(mix).reduce((sum, weight) => sum + weight, 0) : 0;
  return Object.entries(settings.workers).map(([alias, w]) => {
    const spent = ledger.spent(alias);
    const reserved = ledger.reserved(alias);
    const budget = w.budget?.monthly_usd ?? null;
    const free = w.free === true;
    const committed = round(spent + reserved);
    const reserve = reserveUsdOf(settings, w);
    return {
      alias, provider: w.provider, model: w.model, effort: w.effort ?? null, priority: w.priority, strengths: w.strengths, free,
      enabled: w.enabled !== false, spent_usd: spent, reserved_usd: reserved, budget_usd: budget,
      remaining_usd: budget == null ? null : round(Math.max(0, budget - committed)),
      available: w.enabled !== false && (free || budget == null || canAfford(committed, budget, reserve)),
      preferred: preferredProvider !== 'auto' && w.provider === preferredProvider,
      profile_share: mix ? (mix[alias] ?? 0) / totalWeight : null,
    };
  });
}

function chooseNormalWorker(settings, ledger, { worker, kind } = {}, preferredProvider = settings.preferences?.provider ?? 'auto') {
  const rows = workerStatus(settings, ledger).sort((a, b) => a.priority - b.priority);
  const avail = rows.filter(r => r.available);
  const alts = alias => avail.filter(r => r.alias !== alias).map(r => r.alias).join(', ') || 'ninguna';
  if (worker) {
    const r = rows.find(x => x.alias === worker);
    if (!r) throw new Error(`worker '${worker}' no existe; disponibles: ${rows.map(x => x.alias).join(', ')}`);
    if (!r.available) throw new Error(`worker '${worker}' sin presupuesto${r.enabled ? ` (gastado $${r.spent_usd} de $${r.budget_usd}${r.reserved_usd ? `, reservado $${r.reserved_usd}` : ''})` : ' (deshabilitado)'}; alternativas: ${alts(worker)}`);
    return { alias: worker };
  }
  if (!avail.length) throw new Error('ningún worker disponible (todos sin presupuesto o deshabilitados); revisa colmena.yml');
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

function weightedChoice(candidates, counts) {
  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const candidateCount = counts[candidate.alias] ?? 0;
    const bestCount = counts[best.alias] ?? 0;
    const comparison = candidateCount * best.weight - bestCount * candidate.weight;
    return comparison < 0 || (comparison === 0 && candidate.priority < best.priority) ? candidate : best;
  }, null)?.alias;
}

const addNote = (selection, note) => {
  const notes = [note, selection.note].filter(Boolean);
  return { ...selection, ...(notes.length ? { note: notes.join('; ') } : {}) };
};

// Explicit worker → must be available and always wins. A mix profile distributes only implicit selections.
export function chooseWorker(settings, ledger, { worker, kind, commitAllocation = false } = {}) {
  if (worker) return chooseNormalWorker(settings, ledger, { worker, kind });

  const profile = activeProfile(settings);
  if (!profile?.mix) {
    return chooseNormalWorker(settings, ledger, { kind }, preferredProviderOf(settings));
  }

  const rows = workerStatus(settings, ledger);
  const members = Object.entries(profile.mix).map(([alias, weight]) => ({
    ...rows.find(row => row.alias === alias), weight,
  }));
  const available = members.filter(row => row.available);
  const matching = kind ? available.filter(row => row.strengths.includes(kind)) : [];
  const candidates = matching.length ? matching : available;
  const skipped = members.filter(row => !row.available);
  const skipNote = skipped.length
    ? `perfil '${profile.name}': se omitieron workers no disponibles: ${skipped.map(row => `${row.alias} (${row.enabled ? 'sin presupuesto/reservas' : 'deshabilitado'})`).join(', ')}`
    : null;

  if (!candidates.length) {
    const fallbackNote = `perfil '${profile.name}' sin workers disponibles; se usó el ruteo normal`;
    return addNote(chooseNormalWorker(settings, ledger, { kind }, preferredProviderOf(settings)), [fallbackNote, skipNote].filter(Boolean).join('; '));
  }

  const select = counts => weightedChoice(candidates, counts);
  const alias = commitAllocation
    ? ledger.allocate(profile.name, select)
    : select(ledger.allocationCounts(profile.name));
  return addNote({ alias }, skipNote);
}

export function pickWorker(settings, ledger, options) {
  return chooseWorker(settings, ledger, options).alias;
}
