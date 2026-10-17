import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { round } from './job-metrics.js';

const EMPTY = () => ({ runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });

// Advisory lock around each read-modify-write of usage.json so two MCP servers sharing COLMENA_HOME
// cannot lose updates. Acquisition is fail-soft: retries are short, a lock older than `staleMs` or
// whose owner PID is gone is stolen, and after `timeoutMs` the mutation runs anyway (bookkeeping must
// never block or break a job). Reads stay lock-free because writes are published atomically.
export const LOCK_DEFAULTS = { staleMs: 10_000, timeoutMs: 2_000, retryMs: 10 };
// Keep retries frequent while contended: a hot holder releases for less than a millisecond, so a
// long backoff would starve the loser until the fail-soft deadline.
const LOCK_RETRY_CAP_MS = 25;

const sleep = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const isStale = (lockPath, staleMs) => {
  let stat;
  try { stat = fs.statSync(lockPath); } catch { return false; }
  if (Date.now() - stat.mtimeMs > staleMs) return true;
  let pid;
  try { pid = Number(fs.readFileSync(lockPath, 'utf8').split(':')[0]); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false; // lock still being created: age decides
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};

const tryLock = lockPath => {
  const token = `${process.pid}:${Date.now()}`;
  let fd;
  try { fd = fs.openSync(lockPath, 'wx'); } catch { return null; }
  try {
    fs.writeFileSync(fd, token);
  } catch {
    try { fs.closeSync(fd); } catch { /* already broken */ }
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    return null;
  }
  try { fs.closeSync(fd); } catch { /* the lock is already written */ }
  return () => { try { if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath); } catch { /* stolen or gone */ } };
};

const acquireLock = (lockPath, options) => {
  const { staleMs, timeoutMs, retryMs } = { ...LOCK_DEFAULTS, ...options };
  const deadline = Date.now() + timeoutMs;
  let delay = retryMs;
  for (;;) {
    const release = tryLock(lockPath);
    if (release) return release;
    // Any create error counts as contention: Windows reports EPERM while another process is removing
    // the lock file, and giving up then would mutate unserialized. The deadline still bounds the wait.
    if (isStale(lockPath, staleMs)) { try { fs.unlinkSync(lockPath); } catch { /* another process won */ } continue; }
    if (Date.now() >= deadline) return null;
    sleep(Math.min(delay, deadline - Date.now()));
    delay = Math.min(delay * 2, LOCK_RETRY_CAP_MS);
  }
};

function withLock(usagePath, options, fn) {
  const lockPath = `${usagePath}.lock`;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* write() will retry */ }
  let release = null;
  try { release = acquireLock(lockPath, options); } catch { release = null; }
  try { return fn(); } finally { if (release) release(); }
}

// Usage per worker per calendar month, persisted to usage.json. Spending is local bookkeeping, not an account balance.
// `reservations` (keyed by job id) holds the estimated cost of live jobs so concurrent submits cannot drain the same balance.
export function createLedger(config, { now = () => new Date(), lock = {} } = {}) {
  const ym = () => now().toISOString().slice(0, 7);
  const read = () => { try { return JSON.parse(fs.readFileSync(config.usagePath, 'utf8')); } catch { return {}; } };
  const write = all => {
    fs.mkdirSync(path.dirname(config.usagePath), { recursive: true });
    writeFileAtomic(config.usagePath, JSON.stringify(all, null, 2));
  };
  const mutate = fn => withLock(config.usagePath, lock, fn);
  return {
    record(worker, usage = {}, costUsd = 0) {
      return mutate(() => {
        const all = read();
        const m = (all[ym()] ??= {});
        const w = (m[worker] ??= EMPTY());
        w.runs += 1;
        w.input_tokens += usage.input_tokens ?? 0;
        w.output_tokens += usage.output_tokens ?? 0;
        w.cost_usd = round(w.cost_usd + (costUsd ?? 0));
        write(all);
      });
    },
    month(worker) { return read()[ym()]?.[worker] ?? EMPTY(); },
    spent(worker) { return this.month(worker).cost_usd; },
    reserve(id, worker, amount) {
      return mutate(() => {
        const all = read();
        (all.reservations ??= {})[id] = { worker, amount: round(amount), at: now().toISOString() };
        write(all);
      });
    },
    release(id) {
      return mutate(() => {
        const all = read();
        if (!all.reservations?.[id]) return false;
        delete all.reservations[id];
        write(all);
        return true;
      });
    },
    reserved(worker) {
      const entries = Object.values(read().reservations ?? {});
      return round(entries.filter(r => r.worker === worker).reduce((sum, r) => sum + (r.amount ?? 0), 0));
    },
    // A job that is no longer active cannot keep its reservation (crash between release and meta update, deleted job dirs).
    reconcile(activeIds) {
      return mutate(() => {
        const keep = new Set(activeIds);
        const all = read();
        const stale = Object.keys(all.reservations ?? {}).filter(id => !keep.has(id));
        if (!stale.length) return 0;
        for (const id of stale) delete all.reservations[id];
        write(all);
        return stale.length;
      });
    },
  };
}
