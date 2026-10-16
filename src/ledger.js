import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

const EMPTY = () => ({ runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
const round = n => Math.round(n * 1e6) / 1e6;

// Usage per worker per calendar month, persisted to usage.json. Spending is local bookkeeping, not an account balance.
// `reservations` (keyed by job id) holds the estimated cost of live jobs so concurrent submits cannot drain the same balance.
export function createLedger(config, { now = () => new Date() } = {}) {
  const ym = () => now().toISOString().slice(0, 7);
  const read = () => { try { return JSON.parse(fs.readFileSync(config.usagePath, 'utf8')); } catch { return {}; } };
  const write = all => {
    fs.mkdirSync(path.dirname(config.usagePath), { recursive: true });
    writeFileAtomic(config.usagePath, JSON.stringify(all, null, 2));
  };
  return {
    record(worker, usage = {}, costUsd = 0) {
      const all = read();
      const m = (all[ym()] ??= {});
      const w = (m[worker] ??= EMPTY());
      w.runs += 1;
      w.input_tokens += usage.input_tokens ?? 0;
      w.output_tokens += usage.output_tokens ?? 0;
      w.cost_usd = round(w.cost_usd + (costUsd ?? 0));
      write(all);
    },
    month(worker) { return read()[ym()]?.[worker] ?? EMPTY(); },
    spent(worker) { return this.month(worker).cost_usd; },
    reserve(id, worker, amount) {
      const all = read();
      (all.reservations ??= {})[id] = { worker, amount: round(amount), at: now().toISOString() };
      write(all);
    },
    release(id) {
      const all = read();
      if (!all.reservations?.[id]) return false;
      delete all.reservations[id];
      write(all);
      return true;
    },
    reserved(worker) {
      const entries = Object.values(read().reservations ?? {});
      return round(entries.filter(r => r.worker === worker).reduce((sum, r) => sum + (r.amount ?? 0), 0));
    },
    // A job that is no longer active cannot keep its reservation (crash between release and meta update, deleted job dirs).
    reconcile(activeIds) {
      const keep = new Set(activeIds);
      const all = read();
      const stale = Object.keys(all.reservations ?? {}).filter(id => !keep.has(id));
      if (!stale.length) return 0;
      for (const id of stale) delete all.reservations[id];
      write(all);
      return stale.length;
    },
  };
}
