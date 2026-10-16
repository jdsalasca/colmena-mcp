// Fake codex CLI for tests. Honors -C, -o, `resume <id>`; prompt keywords SLEEP / FAIL / EDIT.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = argv[argv.length - 1];
const cwd = val('-C') || process.cwd();
const out = val('-o');
const ri = argv.indexOf('resume');
const session = ri >= 0 ? argv[ri + 1] : 'sess-' + Math.random().toString(16).slice(2, 8);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd, prompt }) + '\n');

const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'thread.started', thread_id: session });
emit({ type: 'turn.started' });
emit({ type: 'garbage-not-json-follows' });
process.stdout.write('this is not json\n');

if (prompt.includes('SLEEP')) setTimeout(() => {}, 600000);
else if (prompt.includes('FAIL')) { process.stderr.write('boom: fake failure\n'); process.exit(1); }
else {
  let files = 'ninguno';
  if (prompt.includes('EDIT')) { fs.writeFileSync(path.join(cwd, 'edited.txt'), 'hola\n'); files = 'edited.txt'; }
  const text = process.env.FAKE_RAW ? process.env.FAKE_RAW : `RESULT: ok (${session})\nFILES: ${files}\nTESTS: 1/1\nRISKS: ninguno`;
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  if (out) fs.writeFileSync(out, text);
}
