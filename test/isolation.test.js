import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import * as iso from '../src/isolation.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
function repo(name = 'repo') {
  const d = path.join(tmp('luna-i-'), name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  return d;
}
const cfg = () => getConfig({ LUNA_HOME: tmp('luna-h-'), LUNA_CODEX_BIN: 'x.js' });

test('worktree creates colmena/<id> under worktreesDir', () => {
  const c = cfg(); const r = repo();
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'abc' });
  assert.ok(p.workdir.startsWith(c.worktreesDir));
  assert.equal(p.branch, 'colmena/abc');
  assert.equal(git(p.workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'colmena/abc');
  assert.equal(p.readonly, false);
  assert.ok(p.base);
});
test('worktree from a subdir keeps the relative subdir', () => {
  const c = cfg(); const r = repo(); fs.mkdirSync(path.join(r, 'sub'));
  fs.writeFileSync(path.join(r, 'sub', 'f.txt'), 'x'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 's');
  const p = iso.prepare(c, { cwd: path.join(r, 'sub'), isolation: 'worktree', id: 'sub1' });
  assert.ok(p.workdir.endsWith('sub'));
  assert.ok(fs.existsSync(path.join(p.workdir, 'f.txt')));
});
test('inplace and readonly return cwd', () => {
  const c = cfg(); const r = repo();
  assert.equal(iso.prepare(c, { cwd: r, isolation: 'inplace', id: 'x' }).workdir, r);
  const ro = iso.prepare(c, { cwd: r, isolation: 'readonly', id: 'y' });
  assert.equal(ro.workdir, r); assert.equal(ro.readonly, true);
});
test('non-git + worktree throws, leaves nothing', () => {
  const c = cfg(); const d = tmp('luna-ng-');
  assert.throws(() => iso.prepare(c, { cwd: d, isolation: 'worktree', id: 'z' }), /no es un repositorio git/);
  assert.equal(fs.existsSync(c.worktreesDir) ? fs.readdirSync(c.worktreesDir).length : 0, 0);
});
test('dirty source tree gives a warning; path with spaces and accents works', () => {
  const c = cfg(); const r = repo('mi proyecto investigación');
  fs.writeFileSync(path.join(r, 'dirty.txt'), 'd');
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'sp' });
  assert.match(p.warning, /sin commitear/);
});
test('changes/diff see edits and new files in worktree', () => {
  const c = cfg(); const r = repo();
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'chg' });
  fs.writeFileSync(path.join(p.workdir, 'new.txt'), 'n\n'); fs.appendFileSync(path.join(p.workdir, 'a.txt'), 'b\n');
  const ch = iso.changes(p.workdir, p.base);
  assert.deepEqual(ch.files.sort(), ['a.txt', 'new.txt']);
  assert.match(ch.diffstat, /2 files? changed/);
  const d = iso.diff(p.workdir, p.base, 50);
  assert.equal(d.truncated, true); assert.ok(d.text.length <= 50);
});
test('merge ok (merge and squash)', () => {
  for (const strategy of ['merge', 'squash']) {
    const c = cfg(); const r = repo();
    const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'm' + strategy });
    fs.writeFileSync(path.join(p.workdir, 'new.txt'), 'n\n');
    iso.commitAll(p.workdir, 'luna work');
    const m = iso.merge(r, p.branch, strategy);
    assert.equal(m.ok, true, m.message);
    assert.ok(fs.existsSync(path.join(r, 'new.txt')));
    assert.equal(git(r, 'status', '--porcelain'), '');
  }
});
test('isMerged detects a branch merged manually into HEAD', () => {
  const r = repo();
  git(r, 'checkout', '-qb', 'colmena/manual');
  fs.writeFileSync(path.join(r, 'manual.txt'), 'merged\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'manual branch');
  git(r, 'checkout', '-q', 'main');
  git(r, 'merge', '--no-ff', '-qm', 'manual merge', 'colmena/manual');

  assert.equal(iso.isMerged(r, 'colmena/manual'), true);
});
test('isMerged rejects a branch that still points to its original base', () => {
  const r = repo();
  const base = git(r, 'rev-parse', 'HEAD');
  git(r, 'branch', 'colmena/empty', base);

  assert.equal(iso.isMerged(r, 'colmena/empty', base), false);
});
test('isMerged returns false for unmerged or missing branches and a cwd outside git', () => {
  const r = repo();
  git(r, 'checkout', '-qb', 'colmena/pending');
  fs.writeFileSync(path.join(r, 'pending.txt'), 'pending\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'pending branch');
  git(r, 'checkout', '-q', 'main');
  const base = git(r, 'rev-parse', 'HEAD');

  assert.equal(iso.isMerged(r, 'colmena/pending'), false);
  assert.equal(iso.isMerged(r, 'colmena/deleted', base), false);
  assert.equal(iso.isMerged(tmp('luna-not-repo-'), 'colmena/pending', base), false);
});
test('merge refused when target dirty', () => {
  const c = cfg(); const r = repo();
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'd1' });
  fs.writeFileSync(path.join(p.workdir, 'n.txt'), 'n'); iso.commitAll(p.workdir, 'w');
  fs.appendFileSync(path.join(r, 'a.txt'), 'dirty\n');
  const m = iso.merge(r, p.branch, 'merge');
  assert.equal(m.ok, false); assert.match(m.message, /sin commitear/);
});
test('merge conflict → ok:false and repo clean', () => {
  const c = cfg(); const r = repo();
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'cf' });
  fs.writeFileSync(path.join(p.workdir, 'a.txt'), 'luna\n'); iso.commitAll(p.workdir, 'w');
  fs.writeFileSync(path.join(r, 'a.txt'), 'main\n'); git(r, 'commit', '-qam', 'main change');
  for (const s of ['merge', 'squash']) {
    const m = iso.merge(r, p.branch, s);
    assert.equal(m.ok, false); assert.match(m.message, /conflict/i);
    assert.equal(git(r, 'status', '--porcelain'), '');
  }
});
test('cleanup removes only luna worktrees and branches', () => {
  const c = cfg(); const r = repo();
  const p = iso.prepare(c, { cwd: r, isolation: 'worktree', id: 'cl1' });
  git(r, 'branch', 'keepme');
  const res = iso.cleanup(c, { id: 'cl1' });
  assert.equal(res.removed.length, 1);
  assert.ok(!fs.existsSync(p.workdir));
  const branches = git(r, 'branch', '--list');
  assert.ok(!branches.includes('colmena/cl1')); assert.ok(branches.includes('keepme'));
});
