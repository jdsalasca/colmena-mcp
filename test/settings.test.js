import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { getConfig } from '../src/config.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'colmena-set-'));
const withYml = (yml, env = {}) => { const h = home(); fs.writeFileSync(path.join(h, 'colmena.yml'), yml); return { h, env: { COLMENA_HOME: h, ...env } }; };

test('no yml → defaults', () => {
  const s = loadSettings(home(), {});
  assert.deepEqual(Object.keys(s.workers).sort(), ['luna-go', 'luna-max']);
  assert.equal(s.workers['luna-go'].model, 'opencode-go/gpt-6-luna');
  assert.equal(s.workers['luna-go'].budget.monthly_usd, 10);
  assert.equal(s.workers['luna-max'].model, 'gpt-6-luna');
  assert.equal(s.workers['luna-max'].effort, 'max');
  assert.equal(s.defaults.worker, 'luna-max');
  assert.equal(s.roles.reporter, 'luna-go');
  assert.equal(s.plugins.notify.heartbeat_min, 10);
  assert.equal(s.plugins.report.default_style, 'papercraft');
  assert.equal(s.standards.enabled, true);
  assert.match(s.standards.preamble, /red.*green.*refactor/i);
  assert.match(s.standards.preamble, /DRY/);
  assert.match(s.standards.preamble, /evidencia/i);
  assert.deepEqual(DEFAULT_SETTINGS.defaults.max_parallel, 4);
});
test('yml replaces workers, merges sections', () => {
  const { h, env } = withYml(`
workers:
  solo: {provider: opencode, model: opencode-go/deepseek-v4-pro, effort: max, priority: 1}
roles: {reporter: solo, summarizer: solo, reviewer: solo}
defaults: {worker: solo}
plugins: {notify: {heartbeat_min: 5}}
`);
  const s = loadSettings(h, env);
  assert.deepEqual(Object.keys(s.workers), ['solo']);
  assert.equal(s.workers.solo.enabled, true);
  assert.equal(s.defaults.max_parallel, 4);
  assert.equal(s.plugins.notify.heartbeat_min, 5);
  assert.equal(s.plugins.notify.enabled, true);
  assert.equal(s.plugins.report.enabled, true);
});
test('invalid provider → error names the field', () => {
  const { h, env } = withYml('workers:\n  x: {provider: nope, model: m}\n');
  assert.throws(() => loadSettings(h, env), /workers\.x\.provider/);
});
test('missing model → error names the field', () => {
  const { h, env } = withYml('workers:\n  x: {provider: codex}\n');
  assert.throws(() => loadSettings(h, env), /workers\.x\.model/);
});
test('role/default referencing unknown worker → error', () => {
  const { h, env } = withYml('workers:\n  a: {provider: codex, model: m}\ndefaults: {worker: ghost}\nroles: {reporter: a, summarizer: a, reviewer: a}\n');
  assert.throws(() => loadSettings(h, env), /defaults\.worker.*ghost/);
  const b = withYml('workers:\n  a: {provider: codex, model: m}\ndefaults: {worker: a}\nroles: {reporter: ghost}\n');
  assert.throws(() => loadSettings(b.h, b.env), /roles\.reporter.*ghost/);
});
test('broken yaml syntax → readable error', () => {
  const { h, env } = withYml('workers: [unclosed\n');
  assert.throws(() => loadSettings(h, env), /colmena\.yml/);
});
test('COLMENA_CONFIG points elsewhere', () => {
  const h = home(); const f = path.join(h, 'otro.yml');
  fs.writeFileSync(f, 'workers:\n  z: {provider: codex, model: m}\ndefaults: {worker: z}\nroles: {reporter: z, summarizer: z, reviewer: z}\n');
  assert.deepEqual(Object.keys(loadSettings(home(), { COLMENA_CONFIG: f }).workers), ['z']);
});
test('standards supports a custom preamble and can be disabled', () => {
  const custom = withYml('standards: {enabled: true, preamble: "Usa contratos y evidencia."}\n');
  assert.deepEqual(loadSettings(custom.h, custom.env).standards, { enabled: true, preamble: 'Usa contratos y evidencia.' });
  const disabled = withYml('standards: {enabled: false}\n');
  const settings = loadSettings(disabled.h, disabled.env);
  assert.equal(settings.standards.enabled, false);
  assert.match(settings.standards.preamble, /TDD/i);
});
test('invalid standards identify the field', () => {
  const { h, env } = withYml('standards: {enabled: yes, preamble: ""}\n');
  assert.throws(() => loadSettings(h, env), /standards\.enabled|standards\.preamble/);
  const scalar = withYml('standards: texto\n');
  assert.throws(() => loadSettings(scalar.h, scalar.env), /standards/);
});
test('config: COLMENA_* beats LUNA_*, settings attached, default home', () => {
  const c = getConfig({ COLMENA_HOME: 'C:\\a', LUNA_HOME: 'C:\\b', COLMENA_CODEX_BIN: 'x.js' });
  assert.ok(c.home.endsWith('a'));
  assert.equal(c.settings.defaults.worker, 'luna-max');
  const d = getConfig({ LUNA_CODEX_BIN: 'x.js' });
  assert.ok(d.home.endsWith('.colmena'));
  const e = getConfig({ COLMENA_HOME: 'C:\\a', COLMENA_MAX_PARALLEL: '2', LUNA_CODEX_BIN: 'x.js' });
  assert.equal(e.maxParallel, 2);
});
