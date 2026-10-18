import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 8000;
const URL_TIMEOUT_MS = 5000;

// Los binarios conocidos saben qué comando demuestra que funcionan de verdad: `docker info` prueba el
// daemon (no solo el CLI) y `java -version` escribe en stderr. El resto cae a `<bin> --version`.
const BINARIES = {
  docker: {
    args: ['info'], timeoutMs: 8000,
    hint: 'instala Docker (https://www.docker.com/products/docker-desktop) o quítalo de requires',
    failHint: 'el daemon de Docker no responde: arráncalo (Docker Desktop o `dockerd`) y comprueba con `docker info`',
  },
  node: { args: ['--version'], hint: 'instala Node.js 22+ (https://nodejs.org) o quítalo de requires' },
  git: { args: ['--version'], hint: 'instala Git (https://git-scm.com) o quítalo de requires' },
  python: { args: ['--version'], hint: 'instala Python (https://www.python.org) o quítalo de requires' },
  java: { args: ['-version'], hint: 'instala un JDK (https://adoptium.net) o quítalo de requires' },
  mvn: { args: ['--version'], hint: 'instala Maven (https://maven.apache.org) o quítalo de requires' },
  npm: { args: ['--version'], hint: 'instala Node.js (incluye npm) o quítalo de requires' },
  npx: { args: ['--version'], hint: 'instala Node.js (incluye npx) o quítalo de requires' },
  yarn: { args: ['--version'], hint: 'instala Yarn (https://yarnpkg.com) o quítalo de requires' },
  pnpm: { args: ['--version'], hint: 'instala pnpm (https://pnpm.io) o quítalo de requires' },
  cargo: { args: ['--version'], hint: 'instala Rust (https://rustup.rs) o quítalo de requires' },
  rustc: { args: ['--version'], hint: 'instala Rust (https://rustup.rs) o quítalo de requires' },
  go: { args: ['version'], hint: 'instala Go (https://go.dev/dl) o quítalo de requires' },
  dotnet: { args: ['--version'], hint: 'instala el SDK de .NET (https://dotnet.microsoft.com) o quítalo de requires' },
  psql: { args: ['--version'], hint: 'instala PostgreSQL (cliente psql) o quítalo de requires' },
};

const genericHint = name => `instala '${name}' o quítalo de requires`;
const invalidHint = "usa un binario ('docker'), 'port:5432' o 'url:http://host:puerto/ruta'";
const isFile = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };
const isBareName = cmd => !path.isAbsolute(cmd) && !cmd.includes('/') && !cmd.includes('\\');

const onPath = (name, env) => {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (isFile(path.join(dir, name))) return path.join(dir, name);
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
};

// Windows: spawn no resuelve PATHEXT (npm ENOENT) y los .cmd/.bat no son ejecutables directos (EINVAL),
// así que los nombres pelados se resuelven aquí y los wrappers van por cmd.exe.
const resolveCommand = (cmd, args, env) => {
  if (process.platform !== 'win32') return { bin: cmd, args };
  const bare = isBareName(cmd);
  const resolved = bare ? onPath(cmd, env) : cmd;
  if (bare && !resolved) {
    const error = new Error(`spawn ${cmd} ENOENT`);
    error.code = 'ENOENT';
    return { error };
  }
  if (/\.(cmd|bat)$/i.test(resolved)) return { bin: env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] };
  return { bin: resolved, args };
};

export function spawnExec(cmd, args = [], { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const target = resolveCommand(cmd, args, env);
  if (target.error) return Promise.resolve({ code: null, stdout: '', stderr: '', error: target.error });
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(target.bin, target.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ code: null, stdout: '', stderr: '', error }); return; }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => finish({ code: null, error }));
    child.once('close', code => finish({ code: timedOut ? null : code, ...(timedOut ? { timedOut: true } : {}) }));
  });
}

const probePort = (host, port, timeoutMs) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  let settled = false;
  const done = outcome => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(outcome);
  };
  const timer = setTimeout(() => done('timeout'), timeoutMs);
  socket.once('connect', () => done('ok'));
  socket.once('error', error => done(error.code ?? 'error'));
});

const checkBinary = async (name, { cwd, exec }) => {
  const known = BINARIES[name];
  const args = known?.args ?? ['--version'];
  const timeoutMs = known?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = `${name} ${args.join(' ')}`;
  const hint = known?.hint ?? genericHint(name);
  const failHint = known?.failHint ?? hint;
  let result;
  try { result = await exec(name, args, { cwd, timeoutMs }); }
  catch (error) { result = { error }; }
  if (result?.timedOut) return { name, reason: `'${command}' no respondió en ${timeoutMs / 1000} s`, hint: failHint };
  if (result?.error?.code === 'ENOENT') return { name, reason: `no se encontró el binario '${name}'`, hint };
  if (result?.error) return { name, reason: `no se pudo ejecutar '${name}': ${result.error.message}`, hint };
  if (result?.code !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? '').trim().split('\n')[0].slice(0, 160);
    return { name, reason: `'${command}' falló con código ${result?.code}${detail ? `: ${detail}` : ''}`, hint: failHint };
  }
  return null;
};

const checkPort = async (spec, name) => {
  const match = /^(?:([^:\s]+):)?(\d{1,5})$/.exec(spec);
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) return { name, reason: `requerimiento inválido '${name}'`, hint: 'usa port:5432 o port:host:5432' };
  const host = match[1] ?? '127.0.0.1';
  const outcome = await probePort(host, port, DEFAULT_TIMEOUT_MS);
  if (outcome === 'ok') return null;
  return {
    name,
    reason: outcome === 'timeout' ? `nadie respondió en ${host}:${port} tras ${DEFAULT_TIMEOUT_MS / 1000} s` : `nadie escucha en ${host}:${port} (${outcome})`,
    hint: `levanta el servicio que escucha en ${host}:${port} o quítalo de requires`,
  };
};

// Cualquier respuesta HTTP demuestra que el servicio está de pie (404 incluido); solo el fallo de red cuenta.
const checkUrl = async (raw, name) => {
  let url;
  try { url = new URL(raw); } catch { return { name, reason: `requerimiento inválido '${name}'`, hint: invalidHint }; }
  if (!/^https?:$/.test(url.protocol)) return { name, reason: `requerimiento inválido '${name}'`, hint: invalidHint };
  try {
    await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
    return null;
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    return {
      name,
      reason: timedOut ? `${url} no respondió en ${URL_TIMEOUT_MS / 1000} s` : `${url} no responde (${error?.cause?.code ?? error?.message ?? 'error de red'})`,
      hint: `levanta el servicio en ${url} o quítalo de requires`,
    };
  }
};

const checkOne = async (entry, { cwd, exec }) => {
  if (typeof entry !== 'string' || !entry.trim()) return { name: String(entry), reason: `requerimiento inválido '${String(entry)}'`, hint: invalidHint };
  const spec = entry.trim();
  if (spec.startsWith('port:')) return checkPort(spec.slice(5), spec);
  if (spec.startsWith('url:')) return checkUrl(spec.slice(4), spec);
  return checkBinary(spec, { cwd, exec });
};

export async function checkRequirements(requires, { cwd, exec = spawnExec } = {}) {
  const list = Array.isArray(requires) ? requires : [];
  const failed = (await Promise.all(list.map(entry => checkOne(entry, { cwd, exec })))).filter(Boolean);
  return { ok: failed.length === 0, failed };
}
