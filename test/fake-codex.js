// Fake codex CLI for tests. Honors -C, -o, `resume <id>`; prompt keywords SLEEP / FAIL / EDIT,
// plus git misbehavior: SWITCH (checkout -B work + commit), WIPE (commit then restore base content),
// DIRTY (untracked file), DIRTY21 (21 untracked files).
// Contract-error knobs (no network): FAKE_NO_FINAL omits the turn.completed final signal;
// FAKE_EXPOSE_MODEL=<id> makes the provider expose a model id in its events.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = argv[argv.length - 1];
const cwd = val('-C') || process.cwd();
const out = val('-o');
const ri = argv.indexOf('resume');
const session = ri >= 0 ? argv[ri + 1] : 'sess-' + Math.random().toString(16).slice(2, 8);
// The real `codex exec resume` rejects -C and -s (verified against codex 0.162): mimic it so tests catch regressions.
if (ri >= 0) for (const bad of ['-C', '-s']) if (argv.includes(bad)) { process.stderr.write(`error: unexpected argument '${bad}' found\n`); process.exit(2); }
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd, prompt }) + '\n');

const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
emit({ type: 'garbage-not-json-follows' });
process.stdout.write('this is not json\n');

if (prompt.includes('COLMENA_REPORT') && process.env.FAKE_REPORT === 'fail') { process.stderr.write('boom: reporter down\n'); process.exit(1); }
if (prompt.includes('COLMENA_REPORT') && process.env.FAKE_REPORT !== 'skip') fs.writeFileSync(path.join(cwd, 'report.html'), '<!doctype html><html><body><h1>fake report</h1>' + '<p>relleno</p>'.repeat(60) + '</body></html>');
if (prompt.includes('COLMENA_PRESENT') && process.env.FAKE_PRESENT === 'fail') { process.stderr.write('boom: presenter down\n'); process.exit(1); }
if (prompt.includes('COLMENA_PRESENT') && process.env.FAKE_PRESENT !== 'skip') {
  const html = process.env.FAKE_PRESENT === 'invalid'
    ? '<!doctype html><html><body>fake presentation without slides</body></html>'
    : '<!doctype html><html><body><h1>fake presentation</h1>' + '<section class="slide">uno</section><section class="slide">dos</section><section class="slide">tres</section>' + '<p>contenido de la presentación</p>'.repeat(40) + '</body></html>';
  fs.writeFileSync(path.join(cwd, 'deck.html'), html);
}
if (prompt.includes('SLEEP')) setTimeout(() => {}, 600000);
else if (prompt.includes('FAIL')) { process.stderr.write('boom: fake failure\n'); process.exit(1); }
else setTimeout(() => {
  let files = 'ninguno';
  const makeCommit = () => {
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fake work'], { cwd });
    files = 'edited.txt';
  };
  if (prompt.includes('EDIT')) { fs.writeFileSync(path.join(cwd, 'edited.txt'), 'hola\n'); files = 'edited.txt'; }
  if (prompt.includes('SWITCH')) {
    execFileSync('git', ['checkout', '-B', 'work'], { cwd });
    fs.writeFileSync(path.join(cwd, 'edited.txt'), 'hola\n');
    makeCommit();
  }
  if (prompt.includes('WIPE')) {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-B', 'work'], { cwd });
    fs.writeFileSync(path.join(cwd, 'edited.txt'), 'hola\n');
    makeCommit();
    execFileSync('git', ['checkout', base, '--', '.'], { cwd });
  }
  if (prompt.includes('DIRTY21')) {
    for (let i = 1; i <= 21; i++) fs.writeFileSync(path.join(cwd, `dirty-${String(i).padStart(2, '0')}.txt`), 'd\n');
    files = '21 archivos';
  } else if (prompt.includes('DIRTY')) { fs.writeFileSync(path.join(cwd, 'edited.txt'), 'hola\n'); files = 'edited.txt'; }
  const text = process.env.FAKE_RAW ? process.env.FAKE_RAW : `RESULT: ok (${session})\nFILES: ${files}\nTESTS: 1/1\nRISKS: ninguno`;
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  if (!process.env.FAKE_NO_FINAL) emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 }, ...(process.env.FAKE_EXPOSE_MODEL ? { model: process.env.FAKE_EXPOSE_MODEL } : {}) });
  if (out) fs.writeFileSync(out, text);
  if (prompt.includes('LINGER')) setTimeout(() => {}, 600000);
}, Number(process.env.FAKE_DELAY || 0));
