import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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

export function getConfig(env = process.env) {
  const home = env.LUNA_HOME || path.join(os.homedir(), '.luna-mcp');
  const binPath = env.LUNA_CODEX_BIN || newestCodex();
  const isJs = /\.(m?js|cjs)$/i.test(binPath);
  return {
    home,
    jobsDir: path.join(home, 'jobs'),
    worktreesDir: path.join(home, 'worktrees'),
    auditPath: path.join(home, 'audit.log'),
    maxParallel: Number(env.LUNA_MAX_PARALLEL) || 4,
    timeoutMin: Number(env.LUNA_JOB_TIMEOUT_MIN) || 60,
    codex: isJs ? { bin: process.execPath, prefixArgs: [binPath] } : { bin: binPath, prefixArgs: [] },
  };
}
