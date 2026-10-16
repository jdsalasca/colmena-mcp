// Real smoke test: one read-only Luna run through the JobManager. Costs one real Codex call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';

const config = getConfig({ ...process.env, LUNA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'luna-smoke-')) });
console.log('codex:', config.codex.bin);
const jm = createJobManager(config);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-smoke-cwd-'));
const id = jm.submit({ task: 'Responde únicamente con la palabra pong en RESULT. No ejecutes ninguna herramienta.', cwd, isolation: 'readonly' });
const w = await jm.wait([id], { timeoutS: 300 });
const r = w.done[0];
console.log(JSON.stringify(r, null, 2));
const events = fs.readFileSync(path.join(jm.jobDir(id), 'events.jsonl'), 'utf8');
const pass = r?.state === 'done' && events.includes('thread.started') && events.includes('turn.completed');
console.log(pass ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(pass ? 0 : 1);
