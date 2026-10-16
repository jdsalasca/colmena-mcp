import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWidgetController, resolveWidgetExecutable } from '../src/plugins/widget.js';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const registryPath = home => path.join(home, 'widget-process.json');
const publish = (home, pid, executable) => fs.writeFileSync(registryPath(home), JSON.stringify({ pid, executable }));
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('el ejecutable usa COLMENA_WIDGET_BIN o widget/dist desde la raíz del repo', () => {
  assert.equal(resolveWidgetExecutable({ env: { COLMENA_WIDGET_BIN: 'C:\\widgets\\custom.exe' } }), 'C:\\widgets\\custom.exe');
  assert.equal(
    resolveWidgetExecutable({ env: {}, repoRoot: 'C:\\repo' }),
    path.join('C:\\repo', 'widget', 'dist', 'colmena-widget.exe'),
  );
});

function harness({ handshake = true, handshakeDelayMs = 5, closeDelayMs = 0, pid = 4201, registeredPid = pid, registeredExecutable } = {}) {
  const home = tmp('colmena-widget-');
  const executable = path.join(home, 'colmena-widget.exe');
  fs.writeFileSync(executable, 'fake executable');
  const processes = new Map();
  const calls = [];
  const processControl = {
    isAlive: async processId => processes.get(processId)?.alive === true,
    executablePath: async processId => processes.get(processId)?.executable,
    close: async (processId, expectedExecutable) => {
      const instance = processes.get(processId);
      calls.push({ type: 'close', pid: processId, expectedExecutable });
      if (!instance?.alive) return;
      if (instance.executable !== expectedExecutable) throw new Error('ruta no coincide');
      if (closeDelayMs) await tick(closeDelayMs);
      instance.alive = false;
    },
  };
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    processes.set(pid, { alive: true, executable });
    if (handshake) setTimeout(() => publish(home, registeredPid, registeredExecutable ?? executable), handshakeDelayMs);
    return { pid, unref() {} };
  };
  const makeController = (overrides = {}) => createWidgetController({
    home,
    executable,
    spawn,
    processControl,
    logger: { warn() {}, error() {} },
    handshakeTimeoutMs: 100,
    pollIntervalMs: 2,
    ...overrides,
  });
  return { home, executable, processes, calls, spawnCalls, processControl, spawn, makeController };
}

test('start lanza el ejecutable oculto, verifica el handshake y evita duplicados', async () => {
  const h = harness();
  const controller = h.makeController();

  const first = await controller.start();
  const second = await controller.start();

  assert.equal(first.state, 'running');
  assert.equal(first.pid, 4201);
  assert.equal(first.exe, h.executable);
  assert.equal(first.home, h.home);
  assert.deepEqual(second, first);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.spawnCalls[0].command, h.executable);
  assert.deepEqual(h.spawnCalls[0].args, []);
  assert.equal(h.spawnCalls[0].options.detached, true);
  assert.equal(h.spawnCalls[0].options.windowsHide, true);
  assert.equal(h.spawnCalls[0].options.stdio, 'ignore');
  assert.equal(h.spawnCalls[0].options.env.COLMENA_HOME, h.home);
});

test('dos start concurrentes comparten el mismo proceso', async () => {
  const h = harness();
  const controller = h.makeController();

  const [first, second] = await Promise.all([controller.start(), controller.start()]);

  assert.equal(first.pid, second.pid);
  assert.equal(h.spawnCalls.length, 1);
});

test('status de un controlador nuevo reconoce un registro válido', async () => {
  const h = harness();
  h.processes.set(4201, { alive: true, executable: h.executable });
  publish(h.home, 4201, h.executable);

  const status = await h.makeController().status();

  assert.deepEqual(status, { state: 'running', pid: 4201, exe: h.executable, home: h.home });
});

test('timeout de handshake devuelve una explicación útil y cierra solo el hijo verificado', async () => {
  const h = harness({ handshake: false });

  await assert.rejects(h.makeController({ handshakeTimeoutMs: 12 }).start(), /handshake.*widget-process\.json/i);
  assert.equal(h.calls.filter(call => call.type === 'close').length, 1);
  assert.equal(h.processes.get(4201).alive, false);
});

test('timeout no borra el registro si el cierre seguro no confirma la salida', async () => {
  const h = harness({ handshake: false });
  h.processControl.executablePath = async pid => {
    publish(h.home, pid, h.executable);
    return h.executable;
  };
  h.processControl.close = async () => { throw new Error('cierre no confirmado'); };

  await assert.rejects(h.makeController({ handshakeTimeoutMs: 12 }).start(), /handshake/i);

  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath(h.home), 'utf8')), {
    pid: 4201, executable: h.executable,
  });
});

test('start no acepta un handshake cuya ruta registrada no coincide con el proceso', async () => {
  const h = harness({ registeredExecutable: 'C:\\Windows\\System32\\unrelated.exe' });

  await assert.rejects(h.makeController({ handshakeTimeoutMs: 16 }).start(), /handshake.*widget-process\.json/i);
  assert.equal(h.processes.get(4201).alive, false);
  assert.equal(h.calls[0].pid, 4201);
  assert.equal(h.calls[0].expectedExecutable, h.executable);
});

test('registro con PID muerto no bloquea start ni intenta cerrar ese PID', async () => {
  const h = harness({ pid: 4202 });
  h.processes.set(4201, { alive: false, executable: h.executable });
  publish(h.home, 4201, h.executable);

  const status = await h.makeController().start();

  assert.equal(status.pid, 4202);
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.calls.filter(call => call.type === 'close').length, 0);
});

test('PID reutilizado por otra ruta nunca se cierra', async () => {
  const h = harness();
  h.processes.set(4201, { alive: true, executable: 'C:\\Windows\\System32\\unrelated.exe' });
  publish(h.home, 4201, h.executable);

  const status = await h.makeController().stop();

  assert.equal(status.state, 'stopped');
  assert.equal(h.calls.filter(call => call.type === 'close').length, 0);
  assert.equal(fs.existsSync(registryPath(h.home)), false);
});

test('stop espera la salida antes de eliminar el registro propio', async () => {
  const h = harness({ closeDelayMs: 25 });
  h.processes.set(4201, { alive: true, executable: h.executable });
  publish(h.home, 4201, h.executable);
  const stopping = h.makeController({ processControl: h.processControl }).stop();

  await tick(5);
  assert.equal(fs.existsSync(registryPath(h.home)), true);
  const status = await stopping;

  assert.equal(status.state, 'stopped');
  assert.equal(h.processes.get(4201).alive, false);
  assert.equal(fs.existsSync(registryPath(h.home)), false);
});

test('stop no limpia el registro si el proceso no confirma la salida', async () => {
  const h = harness();
  h.processes.set(4201, { alive: true, executable: h.executable });
  publish(h.home, 4201, h.executable);
  h.processControl.close = async () => {};

  await assert.rejects(h.makeController({ stopTimeoutMs: 12, pollIntervalMs: 2 }).stop(), /no terminó/i);
  assert.equal(fs.existsSync(registryPath(h.home)), true);
});

test('stop conserva un registro que cambió mientras el proceso salía', async () => {
  const h = harness();
  h.processes.set(4201, { alive: true, executable: h.executable });
  publish(h.home, 4201, h.executable);
  h.processControl.close = async pid => {
    h.processes.get(pid).alive = false;
    publish(h.home, 4202, 'C:\\widget\\new-instance.exe');
  };

  await h.makeController().stop();

  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath(h.home), 'utf8')), {
    pid: 4202, executable: 'C:\\widget\\new-instance.exe',
  });
});

test('exe ausente devuelve instrucciones para compilarlo', async () => {
  const h = harness();

  await assert.rejects(h.makeController({ executable: path.join(h.home, 'missing.exe') }).start(), error =>
    /cargo build --release/i.test(error.message) && /COLMENA_WIDGET_BIN/i.test(error.message));
});
