import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_FILE = 'widget-process.json';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizedPath(value) {
  let absolute = path.resolve(value);
  try { absolute = fs.realpathSync.native(absolute); } catch { /* la ruta puede referirse al proceso ya cerrado */ }
  if (process.platform === 'win32') {
    absolute = absolute.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  }
  return absolute;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const [a, b] = [normalizedPath(left), normalizedPath(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function powershell(script) {
  if (process.platform !== 'win32') throw new Error('El control del widget solo está disponible en Windows.');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

function createSystemProcessControl() {
  return {
    async isAlive(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if (error.code === 'ESRCH') return false;
        if (error.code === 'EPERM') return true;
        throw error;
      }
    },
    async executablePath(pid) {
      const result = powershell(`$ErrorActionPreference = 'Stop'; $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $process) { [Console]::Out.Write($process.ExecutablePath) }`);
      if (result.status !== 0) throw new Error((result.stderr || 'no se pudo consultar la ruta del proceso').trim());
      return result.stdout.trim() || undefined;
    },
    async close(pid, expectedExecutable) {
      const expected = String(expectedExecutable).replaceAll("'", "''");
      const result = powershell(`$ErrorActionPreference = 'Stop'; $process = [Diagnostics.Process]::GetProcessById(${pid}); try { $actual = [IO.Path]::GetFullPath($process.MainModule.FileName); $expected = [IO.Path]::GetFullPath('${expected}'); if (-not [String]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) { exit 3 }; if (-not $process.CloseMainWindow()) { exit 4 } } finally { $process.Dispose() }`);
      if (result.status !== 0) {
        const reason = result.status === 3 ? 'la ruta del proceso cambió antes del cierre'
          : result.status === 4 ? 'el proceso no expone una ventana que se pueda cerrar'
            : (result.stderr || 'no se pudo cerrar el widget').trim();
        throw new Error(reason);
      }
    },
  };
}

export function resolveWidgetExecutable({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  return env.COLMENA_WIDGET_BIN || path.join(repoRoot, 'widget', 'dist', 'colmena-widget.exe');
}

function missingExecutableMessage(executable) {
  return `No se encontró el ejecutable del widget en "${executable}". Configura COLMENA_WIDGET_BIN o compílalo desde widget/ con cargo build --release y copia target/release/colmena-widget.exe a widget/dist/colmena-widget.exe.`;
}

function readSnapshot(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const record = JSON.parse(raw);
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || record.pid > 0xffffffff || typeof record.executable !== 'string' || !record.executable) {
      return { raw, record: null };
    }
    return { raw, record };
  } catch { return { raw, record: null }; }
}

function clearIfUnchanged(file, snapshot) {
  if (!snapshot) return;
  try {
    if (fs.readFileSync(file, 'utf8') === snapshot.raw) fs.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function stopped(home) {
  return { state: 'stopped', pid: null, exe: null, home };
}

export function createWidgetController({
  home,
  executable,
  spawn = nodeSpawn,
  processControl = createSystemProcessControl(),
  logger = console,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  if (!home) throw new TypeError('home es obligatorio');
  const registry = path.join(home, REGISTRY_FILE);
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const getExecutable = () => executable ?? resolveWidgetExecutable();
  const inspect = async (snapshot = readSnapshot(registry)) => {
    if (!snapshot) return stopped(home);
    if (!snapshot.record) {
      clearIfUnchanged(registry, snapshot);
      return stopped(home);
    }

    const { pid, executable: registeredExecutable } = snapshot.record;
    const alive = await processControl.isAlive(pid);
    if (!alive) {
      clearIfUnchanged(registry, snapshot);
      return stopped(home);
    }
    const actualExecutable = await processControl.executablePath(pid);
    if (!samePath(actualExecutable, registeredExecutable)) {
      clearIfUnchanged(registry, snapshot);
      return stopped(home);
    }
    return { state: 'running', pid, exe: normalizedPath(actualExecutable), home };
  };
  const waitForExit = async (pid, expectedExecutable, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (await processControl.isAlive(pid)) {
      const currentExecutable = await processControl.executablePath(pid);
      if (!samePath(currentExecutable, expectedExecutable)) return;
      if (Date.now() >= deadline) throw new Error(`el widget (PID ${pid}) no terminó dentro de ${timeoutMs} ms`);
      await delay(pollIntervalMs);
    }
  };
  const tryCloseLaunchedProcess = async (pid, expectedExecutable) => {
    if (!pid || !(await processControl.isAlive(pid))) return;
    const actualExecutable = await processControl.executablePath(pid);
    if (!samePath(actualExecutable, expectedExecutable)) return;
    let exited = false;
    try {
      await processControl.close(pid, expectedExecutable);
      await waitForExit(pid, expectedExecutable, stopTimeoutMs);
      exited = true;
    } catch (error) {
      logger.warn?.(`No se pudo cerrar el widget tras fallar el handshake: ${error.message}`);
    }
    if (!exited) return;
    const current = readSnapshot(registry);
    if (current?.record?.pid === pid && samePath(current.record.executable, expectedExecutable)) clearIfUnchanged(registry, current);
  };

  return {
    start() {
      return serialize(async () => {
        const current = await inspect();
        if (current.state === 'running') return current;

        const executablePath = path.resolve(getExecutable());
        let fileStat;
        try { fileStat = fs.statSync(executablePath); }
        catch { throw new Error(missingExecutableMessage(executablePath)); }
        if (!fileStat.isFile()) throw new Error(missingExecutableMessage(executablePath));
        const verifiedExecutable = normalizedPath(executablePath);
        fs.mkdirSync(home, { recursive: true });

        let child;
        let launchError;
        try {
          child = spawn(executablePath, [], {
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, COLMENA_HOME: home },
          });
        } catch (error) { throw new Error(`No se pudo iniciar el widget: ${error.message}`); }
        child.once?.('error', error => { launchError = error; });
        child.unref?.();
        const childPid = child.pid;
        const deadline = Date.now() + handshakeTimeoutMs;
        while (Date.now() < deadline) {
          if (launchError) throw new Error(`No se pudo iniciar el widget: ${launchError.message}`);
          const snapshot = readSnapshot(registry);
          const status = await inspect(snapshot);
          if (status.state === 'running' && samePath(status.exe, verifiedExecutable)) return status;
          await delay(pollIntervalMs);
        }
        await tryCloseLaunchedProcess(childPid, verifiedExecutable);
        throw new Error(`Tiempo agotado esperando el handshake del widget en ${registry}; verifica que el ejecutable pueda abrirse y publicar widget-process.json.`);
      });
    },
    stop() {
      return serialize(async () => {
        const snapshot = readSnapshot(registry);
        if (!snapshot) return stopped(home);
        if (!snapshot.record) {
          clearIfUnchanged(registry, snapshot);
          return stopped(home);
        }
        const { pid, executable: registeredExecutable } = snapshot.record;
        if (!(await processControl.isAlive(pid))) {
          clearIfUnchanged(registry, snapshot);
          return stopped(home);
        }
        const actualExecutable = await processControl.executablePath(pid);
        if (!samePath(actualExecutable, registeredExecutable)) {
          clearIfUnchanged(registry, snapshot);
          return stopped(home);
        }

        await processControl.close(pid, normalizedPath(registeredExecutable));
        await waitForExit(pid, registeredExecutable, stopTimeoutMs);
        clearIfUnchanged(registry, snapshot);
        return stopped(home);
      });
    },
    status() { return serialize(() => inspect()); },
  };
}
