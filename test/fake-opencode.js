// Fake opencode CLI for tests. Mimics `opencode run --format json`: honors --dir, -s, --agent; keywords SLEEP / MUTE / DRIP / FAIL / ERROR / ERROR_ONCE / EDIT.
// Contract-error knob (no network): FAKE_EXPOSE_MODEL=<id> makes the provider expose a model id in its events.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = argv[argv.length - 1];
const dir = val('--dir') || process.cwd();
const session = val('-s') || 'ses_' + Math.random().toString(16).slice(2, 8);
const agent = val('--agent');
if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, dir, prompt, xdgConfigHome: process.env.XDG_CONFIG_HOME }) + '\n');
}

const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'step_start', sessionID: session, part: { type: 'step-start' } });
process.stdout.write('not json at all\n');

const finish = () => {
  let files = 'ninguno';
  if (prompt.includes('EDIT') && agent !== 'plan') { fs.writeFileSync(path.join(dir, 'edited.txt'), 'hola\n'); files = 'edited.txt'; }
  emit({ type: 'text', sessionID: session, part: { type: 'text', text: 'pensando en voz alta…' } });
  emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', tokens: { input: 1000, output: 10, reasoning: 5 }, cost: 0.01 } });
  emit({ type: 'text', sessionID: session, part: { type: 'text', text: `RESULT: ok oc (${session})\nFILES: ${files}\nTESTS: 1/1\nRISKS: ninguno` } });
  emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', tokens: { input: 500, output: 20, reasoning: 0 }, cost: 0.01 }, ...(process.env.FAKE_EXPOSE_MODEL ? { model: process.env.FAKE_EXPOSE_MODEL } : {}) });
  if (prompt.includes('LINGER')) setTimeout(() => {}, 600000);
};
// Same shape as `opencode run --format json` on upstream failures: a step_finish that still reports cost, then an error event.
const failTransient = () => {
  emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0.01 } });
  emit({ type: 'error', timestamp: Date.now(), sessionID: session, error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_test' } } });
  process.exitCode = 1;
};

// DRIP keeps appending raw bytes (no newlines, nothing parseable) so only size/mtime prove the provider is alive.
const drip = () => {
  let n = 0;
  const t = setInterval(() => {
    process.stdout.write('ruido-sin-salto '.repeat(8));
    if (++n >= 20) { clearInterval(t); finish(); }
  }, Number(process.env.FAKE_DRIP_MS || 50));
};

// ORPHAN reproduces the leaked-process bug: an intermediate spawns a detached grandchild, publishes
// both PIDs, and dies; the grandchild keeps running with a ParentProcessId that no longer exists.
if (prompt.includes('ORPHAN')) {
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 600000)'], { detached: true, stdio: 'ignore' });
    grandchild.unref();
    fs.writeFileSync(process.env.FAKE_ORPHAN_PID_FILE, JSON.stringify({ intermediate: process.pid, grandchild: grandchild.pid }));
    setTimeout(() => process.exit(0), Number(process.env.FAKE_ORPHAN_LIFE_MS || 3000));
  `;
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', env: process.env }).unref();
}

if (prompt.includes('SLEEP') || prompt.includes('MUTE') || prompt.includes('ORPHAN')) setTimeout(() => {}, 600000);
else if (prompt.includes('DRIP')) drip();
else if (prompt.includes('ERROR_ONCE')) {
  const marker = path.join(dir, '.fake-opencode-error-once');
  if (fs.existsSync(marker)) setTimeout(finish, Number(process.env.FAKE_DELAY || 0));
  else { fs.writeFileSync(marker, 'retried\n'); failTransient(); }
}
else if (prompt.includes('ERROR')) failTransient();
else if (prompt.includes('FAIL')) { process.stderr.write('oc boom\n'); process.exit(1); }
else setTimeout(finish, Number(process.env.FAKE_DELAY || 0));
