// Fake opencode CLI for tests. Mimics `opencode run --format json`: honors --dir, -s, --agent; keywords SLEEP / FAIL / EDIT.
import fs from 'node:fs';
import path from 'node:path';

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

if (prompt.includes('SLEEP')) setTimeout(() => {}, 600000);
else if (prompt.includes('FAIL')) { process.stderr.write('oc boom\n'); process.exit(1); }
else setTimeout(() => {
  let files = 'ninguno';
  if (prompt.includes('EDIT') && agent !== 'plan') { fs.writeFileSync(path.join(dir, 'edited.txt'), 'hola\n'); files = 'edited.txt'; }
  emit({ type: 'text', sessionID: session, part: { type: 'text', text: 'pensando en voz alta…' } });
  emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', tokens: { input: 1000, output: 10, reasoning: 5 }, cost: 0.01 } });
  emit({ type: 'text', sessionID: session, part: { type: 'text', text: `RESULT: ok oc (${session})\nFILES: ${files}\nTESTS: 1/1\nRISKS: ninguno` } });
  emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', tokens: { input: 500, output: 20, reasoning: 0 }, cost: 0.01 } });
  if (prompt.includes('LINGER')) setTimeout(() => {}, 600000);
}, Number(process.env.FAKE_DELAY || 0));
