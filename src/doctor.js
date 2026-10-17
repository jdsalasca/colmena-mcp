import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isStale, LOCK_DEFAULTS } from './ledger.js';
import { resolveWidgetExecutable } from './plugins/widget.js';

const NODE_MIN_MAJOR = 22;

const BINARY_HINTS = {
  codex: 'instala Codex CLI y autentícalo (codex login), o define COLMENA_CODEX_BIN con la ruta del ejecutable',
  opencode: 'instala OpenCode o define COLMENA_OPENCODE_BIN con la ruta del ejecutable real (el shim .cmd de npm no sirve)',
};

const isFile = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };

// spawn() sin shell solo resuelve .exe en Windows; en POSIX el PATH del sistema hace el trabajo.
const onPath = (name, pathEnv) => {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (pathEnv ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
};

const inspectCommand = (cmd, env) => {
  const parts = [cmd.bin, ...(cmd.prefixArgs ?? [])];
  if (parts.every(isFile)) return parts.join(' ');
  const bare = !path.isAbsolute(cmd.bin) && !cmd.bin.includes('/') && !cmd.bin.includes('\\');
  return bare ? onPath(cmd.bin, env.PATH ?? '') : null;
};

export function runDoctor(config, { env = process.env } = {}) {
  const checks = [];
  const check = (name, status, detail) => { checks.push({ name, status, detail }); };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node', nodeMajor >= NODE_MIN_MAJOR ? 'ok' : 'fail',
    nodeMajor >= NODE_MIN_MAJOR
      ? `Node ${process.version}`
      : `Node ${process.version} es anterior a 22; actualiza Node (https://nodejs.org) y reinicia el servidor`);

  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  check('git', git.status === 0 ? 'ok' : 'fail',
    git.status === 0
      ? git.stdout.trim()
      : `git no está disponible (${git.error?.message ?? 'salida no reconocida'}); instala Git (https://git-scm.com): isolation worktree lo necesita`);

  const settingsFile = config.settingsPath ?? path.join(config.home, 'colmena.yml');
  check('config', 'ok', fs.existsSync(settingsFile)
    ? `colmena.yml válido en ${settingsFile}`
    : `sin colmena.yml en ${settingsFile}; se usan los valores por defecto`);

  try {
    fs.mkdirSync(config.jobsDir, { recursive: true });
    const probe = fs.mkdtempSync(path.join(config.jobsDir, '.doctor-'));
    fs.rmSync(probe, { recursive: true, force: true });
    check('home', 'ok', `${config.home} es escribible (jobs/ incluido)`);
  } catch (error) {
    check('home', 'fail', `no se puede escribir en ${config.home}: ${error.message}; revisa permisos o define COLMENA_HOME en una ruta escribible`);
  }

  for (const name of ['codex', 'opencode']) {
    const cmd = config[name];
    const found = inspectCommand(cmd, env);
    check(name, found ? 'ok' : 'fail', found
      ? `binario ${name} listo: ${found}`
      : `no se encontró el binario ${name} ("${cmd.bin}"); ${BINARY_HINTS[name]}`);
  }

  const widgetEnabled = config.settings?.plugins?.widget?.enabled !== false;
  const widgetExe = resolveWidgetExecutable({ env });
  if (!widgetEnabled) check('widget', 'ok', 'plugin widget deshabilitado');
  else if (isFile(widgetExe)) check('widget', 'ok', `widget listo: ${widgetExe}`);
  else check('widget', 'warn', `sin ejecutable del widget en ${widgetExe} (opcional); compílalo con cargo build --release o define COLMENA_WIDGET_BIN`);

  const lockPath = `${config.usagePath}.lock`;
  if (!fs.existsSync(lockPath)) check('locks', 'ok', 'sin locks en usage.json');
  else if (isStale(lockPath, LOCK_DEFAULTS.staleMs)) check('locks', 'warn', `lock obsoleto en ${lockPath} (> ${LOCK_DEFAULTS.staleMs / 1000} s sin dueño vivo); no se borra desde doctor: la próxima mutación lo recupera sola`);
  else check('locks', 'ok', `lock activo en ${lockPath}; otro proceso está escribiendo usage.json`);

  return { ok: checks.every(c => c.status !== 'fail'), checks };
}
