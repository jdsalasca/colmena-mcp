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

const waitFor = file => {
  const deadline = Date.now() + waitMs;
  while (!fs.existsSync(file) && Date.now() < deadline) sleep(1);
};

const ledger = createLedger({ usagePath }, {
  now: () => {
    fs.writeFileSync(path.join(rendezvousDir, `${role}-${round}`), '');
    waitFor(path.join(rendezvousDir, `${other}-${round}`));
    sleep(settleMs);
    return new Date('2026-10-16T10:00:00Z');
  },
});

const failures = [];
const attempt = fn => { try { fn(); } catch (error) { failures.push(error.code ?? error.message); } };

for (round = 1; round <= rounds; round += 1) {
  attempt(() => ledger.reserve(`${role}-${round}`, 'w', 0.01));
  attempt(() => ledger.record('w', { input_tokens: 1, output_tokens: 1 }, 0.01));
}

process.stdout.write(JSON.stringify({ role, failures }));

