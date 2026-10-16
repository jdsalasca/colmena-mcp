import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const tryGit = (cwd, ...args) => { try { return { ok: true, out: git(cwd, ...args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` }; } };

export function isGitRepo(cwd) { return tryGit(cwd, 'rev-parse', '--show-toplevel').ok; }

export function prepare(config, { cwd, isolation, id }) {
  if (isolation === 'inplace') return { workdir: cwd, readonly: false };
  if (isolation === 'readonly') return { workdir: cwd, readonly: true };
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel');
  if (!top.ok) throw new Error(`no es un repositorio git: ${cwd} (usa isolation "inplace" o "readonly")`);
  const base = tryGit(cwd, 'rev-parse', 'HEAD');
  if (!base.ok) throw new Error('el repositorio no tiene commits; haz un commit inicial o usa isolation "inplace"');
  const topDir = path.resolve(top.out);
  const dirty = git(cwd, 'status', '--porcelain').length > 0;
  const wt = path.join(config.worktreesDir, `${path.basename(topDir)}-${id}`);
  const branch = `colmena/${id}`;
  fs.mkdirSync(config.worktreesDir, { recursive: true });
  git(topDir, 'worktree', 'add', '-q', '-b', branch, wt, base.out);
  const rel = path.relative(topDir, path.resolve(cwd));
  return {
    workdir: rel ? path.join(wt, rel) : wt, branch, base: base.out, readonly: false,
    ...(dirty ? { warning: 'el árbol tiene cambios sin commitear; el worktree parte de HEAD y NO los incluye' } : {}),
  };
}

export function changes(workdir, base) {
  if (!isGitRepo(workdir)) return { files: [], diffstat: '' };
  if (base) {
    git(workdir, 'add', '-A');
    const files = git(workdir, 'diff', base, '--name-only').split('\n').filter(Boolean);
    return { files, diffstat: files.length ? git(workdir, 'diff', base, '--shortstat') : '' };
  }
  const files = git(workdir, 'status', '--porcelain').split('\n').filter(Boolean).map(l => l.slice(3));
  return { files, diffstat: tryGit(workdir, 'diff', '--shortstat', 'HEAD').out };
}

export function diff(workdir, base, maxChars = 20000) {
  if (base) git(workdir, 'add', '-A');
  const text = base ? git(workdir, 'diff', base) : git(workdir, 'diff', 'HEAD');
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

export function commitAll(workdir, message) {
  git(workdir, 'add', '-A');
  if (!git(workdir, 'status', '--porcelain')) return false;
  git(workdir, '-c', 'user.name=luna', '-c', 'user.email=luna@local', 'commit', '-q', '-m', message);
  return true;
}

export function merge(cwd, branch, strategy = 'merge') {
  if (git(cwd, 'status', '--porcelain', '--untracked-files=no')) return { ok: false, message: 'el destino tiene cambios sin commitear; haz commit o stash antes de fusionar' };
  const msg = `luna: merge ${branch}`;
  if (strategy === 'squash') {
    const r = tryGit(cwd, 'merge', '--squash', branch);
    if (!r.ok) { tryGit(cwd, 'reset', '--merge'); return { ok: false, message: `conflict al fusionar (squash); repo restaurado. ${r.out.slice(0, 300)}` }; }
    tryGit(cwd, '-c', 'user.name=luna', '-c', 'user.email=luna@local', 'commit', '-q', '-m', msg);
    return { ok: true, message: `squash de ${branch} aplicado` };
  }
  const r = tryGit(cwd, '-c', 'user.name=luna', '-c', 'user.email=luna@local', 'merge', '--no-ff', '-m', msg, branch);
  if (!r.ok) { tryGit(cwd, 'merge', '--abort'); return { ok: false, message: `conflict al fusionar; repo restaurado. ${r.out.slice(0, 300)}` }; }
  return { ok: true, message: `${branch} fusionada` };
}

export function cleanup(config, { id, olderThanDays } = {}) {
  const removed = [];
  let dirs = [];
  try { dirs = fs.readdirSync(config.worktreesDir); } catch { return { removed }; }
  const root = path.resolve(config.worktreesDir);
  for (const d of dirs) {
    const wt = path.resolve(config.worktreesDir, d);
    if (!wt.startsWith(root + path.sep)) continue;
    if (id && !d.endsWith(`-${id}`)) continue;
    if (olderThanDays != null && Date.now() - fs.statSync(wt).mtimeMs < olderThanDays * 86400000) continue;
    const branch = tryGit(wt, 'rev-parse', '--abbrev-ref', 'HEAD').out;
    const common = tryGit(wt, 'rev-parse', '--git-common-dir');
    const mainRepo = common.ok ? path.dirname(path.resolve(wt, common.out)) : null;
    if (mainRepo) {
      tryGit(mainRepo, 'worktree', 'remove', '--force', wt);
      if (branch.startsWith('colmena/')) tryGit(mainRepo, 'branch', '-D', branch);
    }
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
    removed.push(wt);
  }
  return { removed };
}
