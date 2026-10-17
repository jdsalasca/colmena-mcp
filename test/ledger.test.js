import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLedger } from '../src/ledger.js';
import { here, tmp, until } from './helpers.js';

const MONTH = '2026-10';
const AT = () => new Date('2026-10-16T10:00:00Z');
const ROUNDS = 20; // every round forces a read/read/write/write collision, so 20 are enough to expose a lost update and keep the test well under its deadline
const usagePathIn = prefix => path.join(tmp(prefix), 'usage.json');
const ledgerAt = usagePath => createLedger({ usagePath }, { now: AT });
const lockPathOf = usagePath => `${usagePath}.lock`;
const raceChild = path.join(here, 'ledger-race-child.js');

function spawnChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [raceChild, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`hijo ${args[2]} salió con código ${code}: ${stderr}`));
    });
  });
}

test('MC-10: dos procesos que reservan y registran 20 veces no pierden actualizaciones', async () => {
  const home = tmp('colmena-race-');
  const usagePath = path.join(home, 'usage.json');
  const rendezvous = path.join(home, 'rendezvous');
  fs.mkdirSync(rendezvous, { recursive: true });

  const children = ['a', 'b'].map(role => spawnChild([usagePath, rendezvous, role, String(ROUNDS), '20', role === 'a' ? '5' : '20']));
  await until(() => fs.existsSync(path.join(rendezvous, 'boot-a')) && fs.existsSync(path.join(rendezvous, 'boot-b')), 'ambos hijos deben arrancar');
  fs.writeFileSync(path.join(rendezvous, 'start'), '');
  const results = await Promise.all(children);

  const all = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  const reservations = all.reservations ?? {};
  assert.equal(Object.keys(reservations).length, 2 * ROUNDS, 'ninguna reserva puede perderse');
  for (const role of ['a', 'b']) {
    for (let i = 1; i <= ROUNDS; i += 1) {
      assert.ok(reservations[`${role}-${i}`], `falta la reserva ${role}-${i}`);
    }
  }
  const month = all[MONTH]?.w ?? {};
  assert.equal(month.runs, 2 * ROUNDS);
  assert.equal(month.input_tokens, 2 * ROUNDS);
  assert.equal(month.output_tokens, 2 * ROUNDS);
  assert.ok(Math.abs(month.cost_usd - 2 * ROUNDS * 0.01) < 1e-9, `costo ${month.cost_usd}`);
  for (const child of results) assert.deepEqual(child.failures, [], `el hijo ${child.role} no puede perder mutaciones`);
  assert.equal(fs.existsSync(lockPathOf(usagePath)), false, 'los hijos no pueden dejar locks residuales');
});

test('MC-10: un lock obsoleto por edad (> 10 s) se limpia y la mutación se aplica', () => {
  const usagePath = usagePathIn('colmena-lock-old-');
  const lockPath = lockPathOf(usagePath);
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(lockPath, `${process.pid}:0`); // dueño vivo, pero el lock tiene más de 10 s
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  ledgerAt(usagePath).reserve('j1', 'a', 0.5);

  assert.equal(fs.existsSync(lockPath), false, 'el lock viejo no queda residual');
  assert.equal(ledgerAt(usagePath).reserved('a'), 0.5);
});

test('MC-10: un lock reciente cuyo dueño ya no existe se limpia', () => {
  const usagePath = usagePathIn('colmena-lock-dead-');
  const lockPath = lockPathOf(usagePath);
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(lockPath, `2147483646:${Date.now()}`); // PID fuera de rango: no pertenece a ningún proceso vivo

  ledgerAt(usagePath).reserve('j2', 'a', 0.25);

  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(ledgerAt(usagePath).reserved('a'), 0.25);
});

test('MC-10: si el lock no se puede tomar, la mutación no lanza y no se roba el lock ajeno', () => {
  const usagePath = usagePathIn('colmena-lock-busy-');
  const lockPath = lockPathOf(usagePath);
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`); // lock fresco de un dueño vivo (este proceso)
  const ledger = createLedger({ usagePath }, { now: AT, lock: { timeoutMs: 60, retryMs: 10 } });

  ledger.reserve('j1', 'a', 0.5); // fail-soft: nunca lanza

  assert.ok(fs.existsSync(lockPath), 'un lock fresco con dueño vivo no se roba');
  assert.equal(ledger.reserved('a'), 0.5, 'la contabilidad se aplica en modo mejor esfuerzo');
  fs.unlinkSync(lockPath);
});

test('MC-9: snapshot() lee usage.json una sola vez y devuelve spent/reserved por worker', () => {
  const usagePath = usagePathIn('colmena-snap-');
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(usagePath, JSON.stringify({
    '2026-10': { a: { runs: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.3 }, b: { runs: 2, input_tokens: 0, output_tokens: 0, cost_usd: 0.2 } },
    reservations: { j1: { worker: 'a', amount: 0.1 }, j2: { worker: 'a', amount: 0.2 }, j3: { worker: 'b', amount: 0.05 } },
  }));
  let reads = 0;
  const readFile = (...args) => { reads += 1; return fs.readFileSync(...args); };
  const l = createLedger({ usagePath }, { now: AT, readFile });
  const snap = l.snapshot();
  assert.equal(reads, 1, 'snapshot debe leer usage.json exactamente una vez');
  assert.deepEqual(snap, {
    spentByWorker: { a: 0.3, b: 0.2 },
    reservedByWorker: { a: 0.3, b: 0.05 },
  });
  assert.equal(l.spent('a'), 0.3);
  assert.equal(l.reserved('a'), 0.3);
  assert.equal(l.month('b').cost_usd, 0.2);
});

test('MC-10: las mutaciones del camino normal no dejan locks ni añaden espera perceptible', () => {
  const usagePath = usagePathIn('colmena-lock-fast-');
  const ledger = ledgerAt(usagePath);
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) {
    ledger.reserve(`j${i}`, 'a', 0.01);
    ledger.record('a', { input_tokens: 1 }, 0.01);
  }
  ledger.release('j0');
  ledger.reconcile(['j1']);
  const elapsed = Date.now() - started;

  assert.equal(fs.existsSync(lockPathOf(usagePath)), false, 'sin locks residuales');
  assert.ok(elapsed < 15000, `20 mutaciones tardaron ${elapsed} ms (una espera por lock costaría >=2 s cada una)`); // generous: other processes may load the machine
});

test('las asignaciones por perfil se guardan con el lock, sobreviven al reinicio y se separan por mes', () => {
  const usagePath = usagePathIn('colmena-profile-alloc-');
  const ledger = ledgerAt(usagePath);
  assert.equal(ledger.allocate('balanced', counts => counts.luna ? 'flash' : 'luna'), 'luna');
  assert.equal(ledger.allocate('balanced', counts => counts.luna ? 'flash' : 'luna'), 'flash');
  assert.deepEqual(ledger.allocationCounts('balanced'), { luna: 1, flash: 1 });

  const restarted = ledgerAt(usagePath);
  assert.deepEqual(restarted.allocationCounts('balanced'), { luna: 1, flash: 1 });
  const nextMonth = createLedger({ usagePath }, { now: () => new Date('2026-11-01T00:00:00Z') });
  assert.deepEqual(nextMonth.allocationCounts('balanced'), {});
});
