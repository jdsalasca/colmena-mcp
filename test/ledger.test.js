import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLedger } from '../src/ledger.js';
import { here, tmp, until } from './helpers.js';

const MONTH = '2026-10';
const AT = () => new Date('2026-10-16T10:00:00Z');
const ROUNDS = 50;
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

test('MC-10: dos procesos que reservan y registran 50 veces no pierden actualizaciones', async () => {
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
  assert.ok(elapsed < 2000, `20 mutaciones tardaron ${elapsed} ms`);
});
