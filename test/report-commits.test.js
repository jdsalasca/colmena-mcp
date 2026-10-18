import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { buildReportData, generateReport, githubRepoSlug, jobCommits, renderFallback } from '../src/plugins/report.js';
import { baseEnv, codexOnlyHome, tmp } from './helpers.js';

const styleDir = path.join(process.cwd(), 'styles', 'papercraft');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = path.join(tmp('colmena-rep-'), 'repo');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

function fallbackData(over = {}) {
  return {
    title: 'Informe', subtitle: 'sub', generatedAt: '2026-10-17T10:00:00.000Z',
    jobs: [{
      id: 'j1', worker: 'luna', task: 'Tarea', state: 'done',
      report: { RESULT: 'ok', FILES: 'a.js', TESTS: '1/1', RISKS: 'ninguno' }, text: null,
      files: [], diffstat: '', cost_usd: 0.1, durationS: 30, branch: 'colmena/j1', error: null,
      commits: [{ hash: 'abc1234', subject: 'arregla <script>alert(1)</script> & más', url: 'https://github.com/acme/repo/commit/abc1234' }],
    }],
    totals: { jobs: 1, done: 1, failed: 0, cancelled: 0, costUsd: 0.1, durationS: 30 },
    ...over,
  };
}

test('buildReportData sin git no añade commits (los decks de present no cambian)', async () => {
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const r0 = repo();
  const id = jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' });
  await jm.wait([id]);
  const data = buildReportData(jm, [id]);
  assert.equal(data.jobs[0].branch, `colmena/${id}`);
  assert.ok(!('commits' in data.jobs[0]));
});

test('githubRepoSlug reconoce remotos GitHub y descarta el resto', () => {
  assert.equal(githubRepoSlug('https://github.com/acme/repo.git'), 'acme/repo');
  assert.equal(githubRepoSlug('https://github.com/acme/repo'), 'acme/repo');
  assert.equal(githubRepoSlug('git@github.com:acme/repo.git'), 'acme/repo');
  assert.equal(githubRepoSlug('ssh://git@github.com/acme/repo.git'), 'acme/repo');
  assert.equal(githubRepoSlug('https://gitlab.com/acme/repo.git'), null);
  assert.equal(githubRepoSlug('https://github.example.com/acme/repo.git'), null);
  assert.equal(githubRepoSlug(''), null);
  assert.equal(githubRepoSlug(undefined), null);
});

test('jobCommits: máximo 10, hash corto + asunto y URL GitHub si el remoto lo es', () => {
  const calls = [];
  const fake = (cwd, ...args) => {
    calls.push([cwd, ...args]);
    if (args[0] === 'remote') return 'git@github.com:acme/repo.git';
    return Array.from({ length: 12 }, (_, i) => `abc${i}\tasunto ${i}`).join('\n');
  };
  const commits = jobCommits({ cwd: 'C:/repo', branch: 'colmena/j1', base: 'deadbeef' }, { git: fake });
  assert.equal(commits.length, 10);
  assert.deepEqual(commits[0], { hash: 'abc0', subject: 'asunto 0', url: 'https://github.com/acme/repo/commit/abc0' });
  const logCall = calls.find(c => c[1] === 'log');
  assert.deepEqual(logCall.slice(1, 3), ['log', '--max-count=10']);
  assert.equal(logCall.at(-1), 'deadbeef..colmena/j1');
});

test('jobCommits: sin rama no consulta git; remoto no GitHub deja hashes sin enlace', () => {
  let called = false;
  assert.deepEqual(jobCommits({ cwd: 'x', branch: null }, { git: () => { called = true; return ''; } }), []);
  assert.equal(called, false);
  const commits = jobCommits({ cwd: 'x', branch: 'colmena/j1', base: 'b' }, {
    git: (cwd, ...args) => (args[0] === 'remote' ? 'https://gitlab.com/acme/repo.git' : 'abc123\tsujeto'),
  });
  assert.deepEqual(commits, [{ hash: 'abc123', subject: 'sujeto' }]);
});

test('jobCommits sobre un repo git temporal: commits de colmena/<id> frente a su base', () => {
  const r = repo();
  const base = git(r, 'rev-parse', 'HEAD');
  git(r, 'checkout', '-q', '-b', 'colmena/j1');
  fs.writeFileSync(path.join(r, 'b.txt'), 'b\n'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'añade b');
  fs.writeFileSync(path.join(r, 'c.txt'), 'c\n'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'añade c');
  const commits = jobCommits({ cwd: r, branch: 'colmena/j1', base });
  assert.deepEqual(commits.map(c => c.subject), ['añade c', 'añade b']);
  for (const c of commits) assert.match(c.hash, /^[0-9a-f]{7,}$/);
  assert.ok(!('url' in commits[0]), 'sin remoto GitHub no hay enlace');
  git(r, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git');
  const linked = jobCommits({ cwd: r, branch: 'colmena/j1', base });
  assert.equal(linked[0].url, `https://github.com/acme/repo/commit/${linked[0].hash}`);
});

test('fallback: snapshot de la sección de commits con enlaces y HTML escapado', () => {
  const html = renderFallback(fallbackData(), styleDir);
  assert.ok(html.includes('<section class="commits"><h4>Commits</h4><ul><li><a href="https://github.com/acme/repo/commit/abc1234">abc1234</a> arregla &lt;script&gt;alert(1)&lt;/script&gt; &amp; más</li></ul></section>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const plain = fallbackData();
  plain.jobs[0].commits = [{ hash: 'abc1234', subject: 'sin remoto' }];
  const noLink = renderFallback(plain, styleDir);
  assert.ok(noLink.includes('<section class="commits"><h4>Commits</h4><ul><li><code>abc1234</code> sin remoto</li></ul></section>'));
  const none = fallbackData();
  none.jobs[0].commits = [];
  assert.ok(!renderFallback(none, styleDir).includes('class="commits"'));
});

test('fallback: "Decisiones del orquestador" solo con notes y siempre escapada', () => {
  const withNotes = renderFallback(fallbackData({ notes: 'Decisiones: mantener la API.\nRiesgo: <script>alert(1)</script>' }), styleDir);
  assert.ok(withNotes.includes('<section class="notes">\n<h2 class="hand">Decisiones del orquestador</h2>\n<p>Decisiones: mantener la API.<br>Riesgo: &lt;script&gt;alert(1)&lt;/script&gt;</p>\n</section>'));
  assert.ok(!withNotes.includes('<script>alert(1)</script>'));
  const withoutNotes = renderFallback(fallbackData({ notes: '' }), styleDir);
  assert.ok(!withoutNotes.includes('Decisiones del orquestador'));
  assert.ok(!withoutNotes.includes('COLMENA:NOTES'), 'el marcador no puede quedar en el HTML');
});

test('generateReport: data.json y fallback incluyen commits de la rama (GitHub) y las notas', async () => {
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const r0 = repo();
  const id = jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' });
  await jm.wait([id]);
  const m = jm.meta(id);
  fs.writeFileSync(path.join(m.workdir, 'extra.txt'), 'x\n');
  git(m.workdir, 'add', '-A'); git(m.workdir, 'commit', '-qm', 'añade extra');
  git(r0, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
  process.env.FAKE_REPORT = 'skip';
  try {
    const out = await generateReport({ jm, config, ids: [id], title: 'Ronda commits', notes: 'Decisión: fusionar ya.' });
    const data = JSON.parse(fs.readFileSync(path.join(out.dir, 'data.json'), 'utf8'));
    assert.equal(data.notes, 'Decisión: fusionar ya.');
    assert.equal(data.jobs[0].commits.length, 1);
    assert.equal(data.jobs[0].commits[0].subject, 'añade extra');
    assert.equal(data.jobs[0].commits[0].url, `https://github.com/acme/repo/commit/${data.jobs[0].commits[0].hash}`);
    const html = fs.readFileSync(out.path, 'utf8');
    assert.match(html, /Decisiones del orquestador/);
    assert.match(html, /<a href="https:\/\/github\.com\/acme\/repo\/commit\/[0-9a-f]+">[0-9a-f]+<\/a> añade extra/);
  } finally { delete process.env.FAKE_REPORT; }
});

test('generateReport sin notes: el fallback no muestra la sección', async () => {
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const ids = [jm.submit({ task: 'hola', cwd: tmp('colmena-c-'), isolation: 'inplace' })];
  await jm.wait(ids);
  process.env.FAKE_REPORT = 'skip';
  try {
    const out = await generateReport({ jm, config, ids, title: 'Sin notas' });
    const html = fs.readFileSync(out.path, 'utf8');
    assert.ok(!html.includes('Decisiones del orquestador'));
    assert.ok(!html.includes('COLMENA:NOTES'));
    const data = JSON.parse(fs.readFileSync(path.join(out.dir, 'data.json'), 'utf8'));
    assert.equal(data.notes, '');
  } finally { delete process.env.FAKE_REPORT; }
});

test('generateReport acepta un git inyectable: commits del doble en data.json', async () => {
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const r0 = repo();
  const id = jm.submit({ task: 'EDIT', cwd: r0, isolation: 'worktree' });
  await jm.wait([id]);
  const fakeGit = (cwd, ...args) => {
    if (args[0] === 'remote') throw new Error('sin remoto');
    return 'ff00aa\tsujeto inyectado';
  };
  process.env.FAKE_REPORT = 'skip';
  try {
    const out = await generateReport({ jm, config, ids: [id], title: 'Ronda doble', git: fakeGit });
    const data = JSON.parse(fs.readFileSync(path.join(out.dir, 'data.json'), 'utf8'));
    assert.deepEqual(data.jobs[0].commits, [{ hash: 'ff00aa', subject: 'sujeto inyectado' }]);
  } finally { delete process.env.FAKE_REPORT; }
});
