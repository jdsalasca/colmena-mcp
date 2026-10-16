import fs from 'node:fs';
import path from 'node:path';
import { createLedger } from '../src/ledger.js';

// Child of the MC-10 race test: reserves and records `rounds` times while a file rendezvous inside
// the injected clock (called between read and write of `reserve`) forces both children to read the
// same snapshot before either writes; the non-zero `settleMs` delays the write so the interleaving
// shows as a lost update instead of a Windows-only rename EPERM. Mutation failures are counted
// (not thrown) and reported on stdout as JSON, so the parent can assert exact totals and zero errors.
// Usage: node ledger-race-child.js <usagePath> <rendezvousDir> <role> <rounds> <waitMs> <settleMs>
const [usagePath, rendezvousDir, role, roundsText, waitMsText, settleMsText] = process.argv.slice(2);
const rounds = Number(roundsText);
const waitMs = Number(waitMsText);
const settleMs = Number(settleMsText);
const other = role === 'a' ? 'b' : 'a';
let round = 0;

const sleep = ms => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const waitFor = (file, timeoutMs, { required = false } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) sleep(1);
  if (required && !fs.existsSync(file)) throw new Error(`rendezvous timeout: ${file}`);
};

// Both children start at the same instant so neither pays the lock timeout while booting.
fs.writeFileSync(path.join(rendezvousDir, `boot-${role}`), '');
waitFor(path.join(rendezvousDir, 'start'), 10_000, { required: true });

const ledger = createLedger({ usagePath }, {
  // A longer wait than the 2 s default keeps a busy round from falling back to the unlocked
  // fail-soft path, which the unit tests already cover; the stale threshold (10 s) still wins.
  lock: { timeoutMs: 5_000 },
  now: () => {
    fs.writeFileSync(path.join(rendezvousDir, `${role}-${round}`), '');
    waitFor(path.join(rendezvousDir, `${other}-${round}`), waitMs);
    sleep(settleMs);
    return new Date('2026-10-16T10:00:00Z');
  },
});

const failures = [];
const attempt = fn => { try { fn(); } catch (error) { failures.push(error.code ?? error.message); } };

// Real clients mutate at job pace, not in a hot loop; without this pause one child re-acquires the
// lock back-to-back and starves the other until the fail-soft timeout.
const PAUSE_MS = 10;
for (round = 1; round <= rounds; round += 1) {
  attempt(() => ledger.reserve(`${role}-${round}`, 'w', 0.01));
  sleep(PAUSE_MS);
  attempt(() => ledger.record('w', { input_tokens: 1, output_tokens: 1 }, 0.01));
  sleep(PAUSE_MS);
}

process.stdout.write(JSON.stringify({ role, failures }));

