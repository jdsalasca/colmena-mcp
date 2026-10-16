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

// A .js path (test fakes) runs through node; anything else is spawned as-is.
export function resolveCmd(binPath) {
  return /\.(m?js|cjs)$/i.test(binPath) ? { bin: process.execPath, prefixArgs: [binPath] } : { bin: binPath, prefixArgs: [] };
}

export function getConfig(env = process.env) {
  const e = name => env[`COLMENA_${name}`] ?? env[`LUNA_${name}`];
  const home = e('HOME') || path.join(os.homedir(), '.colmena');
  const settings = loadSettings(home, env);
  return {
    home,
    jobsDir: path.join(home, 'jobs'),
    worktreesDir: path.join(home, 'worktrees'),
    reportsDir: path.join(home, 'reports'),
    auditPath: path.join(home, 'audit.log'),
    activityPath: path.join(home, 'activity.log'),
    usagePath: path.join(home, 'usage.json'),
    settings,
    maxParallel: Number(e('MAX_PARALLEL')) || settings.defaults.max_parallel,
    timeoutMin: Number(e('JOB_TIMEOUT_MIN')) || settings.defaults.timeout_min,
    codex: resolveCmd(e('CODEX_BIN') || newestCodex()),
    opencode: resolveCmd(e('OPENCODE_BIN') || 'opencode'),
    notifier: e('NOTIFIER') || 'toast',
  };
}
