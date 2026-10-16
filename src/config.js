import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadSettings } from './settings.js';

function newestCodex() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'codex.exe') found.push({ p, t: fs.statSync(p).mtimeMs });
      else if (e.isDirectory() && depth < 1) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  found.sort((a, b) => b.t - a.t);
  return found[0]?.p ?? 'codex';
}

// opencode is an npm shim (.cmd/.ps1) on Windows, which can't take arbitrary args safely; find the real exe next to it.
export function findOpencode(pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const real = path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(real)) return real;
    const direct = path.join(dir, 'opencode.exe');
    if (fs.existsSync(direct)) return direct;
  }
  return 'opencode';
}

// A .js path (test fakes) runs through node; anything else is spawned as-is.
export function resolveCmd(binPath) {
  return /\.(m?js|cjs)$/i.test(binPath) ? { bin: process.execPath, prefixArgs: [binPath] } : { bin: binPath, prefixArgs: [] };
}

export function getConfig(env = process.env) {
  const e = name => env[`COLMENA_${name}`] ?? env[`LUNA_${name}`];
  const home = e('HOME') || path.join(os.homedir(), '.colmena');
  const settings = loadSettings(home, env);
  const config = {
    home,
    settingsPath: env.COLMENA_CONFIG || path.join(home, 'colmena.yml'),
    jobsDir: path.join(home, 'jobs'),
    worktreesDir: path.join(home, 'worktrees'),
    reportsDir: path.join(home, 'reports'),
    auditPath: path.join(home, 'audit.log'),
    activityPath: path.join(home, 'activity.log'),
    usagePath: path.join(home, 'usage.json'),
    settings,
    maxParallel: Number(e('MAX_PARALLEL')) || settings.defaults.max_parallel,
    timeoutMin: Number(e('JOB_TIMEOUT_MIN')) || settings.defaults.timeout_min,
    exitGraceS: Number(e('EXIT_GRACE_S')) || settings.defaults.exit_grace_s,
    waitMaxS: Math.min(Math.max(Math.floor(Number(e('WAIT_MAX_S')) || settings.defaults.wait_max_s), 1), 1800),
    codex: resolveCmd(e('CODEX_BIN') || newestCodex()),
    opencode: resolveCmd(e('OPENCODE_BIN') || findOpencode()),
    notifier: e('NOTIFIER') || 'toast',
  };
  config.reloadSettings = () => {
    const next = loadSettings(home, env);
    config.settings = next;
    config.maxParallel = Number(e('MAX_PARALLEL')) || next.defaults.max_parallel;
    config.timeoutMin = Number(e('JOB_TIMEOUT_MIN')) || next.defaults.timeout_min;
    config.exitGraceS = Number(e('EXIT_GRACE_S')) || next.defaults.exit_grace_s;
    config.waitMaxS = Math.min(Math.max(Math.floor(Number(e('WAIT_MAX_S')) || next.defaults.wait_max_s), 1), 1800);
    return next;
  };
  return config;
}
