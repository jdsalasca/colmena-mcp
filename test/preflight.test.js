import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { checkRequirements, spawnExec } from '../src/preflight.js';

const enoent = cmd => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => server.close(resolve));

test('checkRequirements: todo ok no reporta fallos y pide versiones', async () => {
  const calls = [];
  const exec = async (cmd, args, options) => { calls.push({ cmd, args, options }); return { code: 0, stdout: `${cmd} v1`, stderr: '' }; };
  const r = await checkRequirements(['git', 'node', 'npm', 'python', 'java', 'mvn', 'cargo'], { cwd: 'C:/x', exec });
  assert.deepEqual(r, { ok: true, failed: [] });
  const byCmd = Object.fromEntries(calls.map(c => [c.cmd, c.args]));
  assert.deepEqual(byCmd.git, ['--version']);
  assert.deepEqual(byCmd.npm, ['--version']);
  assert.deepEqual(byCmd.java, ['-version']);
  assert.equal(calls[0].options.cwd, 'C:/x');
});

test('checkRequirements: binario ausente falla con pista de instalación', async () => {
  const exec = async cmd => ({ code: null, error: enoent(cmd), stdout: '', stderr: '' });
  const r = await checkRequirements(['node'], { exec });
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, 'node');
  assert.match(r.failed[0].reason, /no se encontró el binario 'node'/);
  assert.match(r.failed[0].hint, /Node/);
});

test('checkRequirements: docker caído (daemon apagado) explica el código y cómo arrancarlo', async () => {
  const exec = async (cmd, args) => cmd === 'docker' && args[0] === 'info'
    ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }
    : { code: 0, stdout: '', stderr: '' };
  const r = await checkRequirements(['docker'], { exec });
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].name, 'docker');
  assert.match(r.failed[0].reason, /'docker info' falló con código 1/);
  assert.match(r.failed[0].reason, /Docker daemon/);
  assert.match(r.failed[0].hint, /daemon/i);
});

test('checkRequirements: timeout reporta el comando y los segundos', async () => {
  const exec = async () => ({ code: null, timedOut: true, stdout: '', stderr: '' });
  const r = await checkRequirements(['docker'], { exec });
  assert.equal(r.ok, false);
  assert.match(r.failed[0].reason, /'docker info' no respondió en 8 s/);
  assert.match(r.failed[0].hint, /daemon/i);
});

test('checkRequirements: binario desconocido usa --version y pista genérica', async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, args]); return { code: 127, stdout: '', stderr: 'not found' }; };
  const r = await checkRequirements(['mytool'], { exec });
  assert.deepEqual(calls, [['mytool', ['--version']]]);
  assert.equal(r.failed[0].name, 'mytool');
  assert.match(r.failed[0].reason, /'mytool --version' falló con código 127/);
  assert.match(r.failed[0].hint, /mytool/);
});

test('checkRequirements: exec que rechaza cuenta como fallo del binario', async () => {
  const r = await checkRequirements(['docker'], { exec: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].name, 'docker');
  assert.match(r.failed[0].reason, /no se pudo ejecutar 'docker': boom/);
});

test('checkRequirements: port: abierto pasa y cerrado falla', async () => {
  const server = net.createServer();
  const port = await listen(server);
  const exec = async () => ({ code: 0 });
  const ok = await checkRequirements([`port:${port}`], { exec });
  assert.deepEqual(ok, { ok: true, failed: [] });
  await close(server);
  const down = await checkRequirements([`port:${port}`], { exec });
  assert.equal(down.ok, false);
  assert.equal(down.failed[0].name, `port:${port}`);
  assert.match(down.failed[0].reason, /nadie escucha/);
  assert.match(down.failed[0].hint, new RegExp(String(port)));
});

test('checkRequirements: port inválido se reporta sin lanzar', async () => {
  const r = await checkRequirements(['port:abc', 'port:99999'], { exec: async () => ({ code: 0 }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => f.name), ['port:abc', 'port:99999']);
  assert.match(r.failed[0].hint, /port:5432/);
});

test('checkRequirements: url responde → ok; url caída → fallo con hint', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server);
  const exec = async () => ({ code: 0 });
  const ok = await checkRequirements([`url:http://127.0.0.1:${port}/salud`], { exec });
  assert.deepEqual(ok, { ok: true, failed: [] });
  await close(server);
  const down = await checkRequirements([`url:http://127.0.0.1:${port}/salud`], { exec });
  assert.equal(down.ok, false);
  assert.match(down.failed[0].reason, /no responde/);
  assert.match(down.failed[0].hint, new RegExp(String(port)));
});

test('checkRequirements: entradas no válidas o no array no rompen', async () => {
  const r = await checkRequirements([42, ''], { exec: async () => ({ code: 0 }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => f.name), ['42', '']);
  assert.deepEqual(await checkRequirements(undefined, { exec: async () => ({ code: 0 }) }), { ok: true, failed: [] });
});

test('spawnExec real: captura stdout y código 0', async () => {
  const r = await spawnExec(process.execPath, ['-e', "console.log('v9')"], { timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /v9/);
});

test('spawnExec real: timeout mata el proceso y lo marca', async () => {
  const r = await spawnExec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
});

test('spawnExec real: binario inexistente reporta ENOENT', async () => {
  const r = await spawnExec('colmena-binario-inexistente-xyz', ['--version'], { timeoutMs: 5000 });
  assert.equal(r.error?.code, 'ENOENT');
});
