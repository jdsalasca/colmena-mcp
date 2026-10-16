import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

const EMPTY = () => ({ runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
const round = n => Math.round(n * 1e6) / 1e6;

// Usage per worker per calendar month, persisted to usage.json. Spending is local bookkeeping, not an account balance.
export function createLedger(config, { now = () => new Date() } = {}) {
  const ym = () => now().toISOString().slice(0, 7);
  const read = () => { try { return JSON.parse(fs.readFileSync(config.usagePath, 'utf8')); } catch { return {}; } };
  return {
    record(worker, usage = {}, costUsd = 0) {
      const all = read();
      const m = (all[ym()] ??= {});
      const w = (m[worker] ??= EMPTY());
      w.runs += 1;
      w.input_tokens += usage.input_tokens ?? 0;
      w.output_tokens += usage.output_tokens ?? 0;
      w.cost_usd = round(w.cost_usd + (costUsd ?? 0));
      fs.mkdirSync(path.dirname(config.usagePath), { recursive: true });
      writeFileAtomic(config.usagePath, JSON.stringify(all, null, 2));
    },
    month(worker) { return read()[ym()]?.[worker] ?? EMPTY(); },
    spent(worker) { return this.month(worker).cost_usd; },
  };
}
