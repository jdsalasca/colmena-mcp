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
  assert.deepEqual(s.preferences, { provider: 'auto' });
  assert.deepEqual(Object.keys(s.workers).sort(), ['ds-flash', 'luna-max', 'max-hive']);
  assert.equal(s.workers['ds-flash'].model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(s.workers['ds-flash'].effort, 'max');
  assert.equal(s.workers['max-hive'].model, 'opencode-go/muse-spark-1.3-contributor');
  assert.deepEqual(s.workers['max-hive'].strengths, ['bulk']);
  assert.ok(s.workers['max-hive'].priority > s.workers['ds-flash'].priority);
  assert.equal(s.workers['ds-flash'].budget.monthly_usd, 10);
  assert.ok(s.workers['max-hive'].budget.monthly_usd > 0);
  assert.equal(s.workers['luna-max'].model, 'gpt-6-luna');
  assert.equal(s.workers['luna-max'].effort, 'max');
  assert.equal(s.defaults.worker, 'luna-max');
  assert.equal(s.defaults.exit_grace_s, 20);
  assert.equal(s.roles.reporter, 'ds-flash');
  assert.equal(s.roles.summarizer, 'ds-flash');
  assert.equal(s.roles.presenter, 'luna-max');
  assert.equal(s.plugins.notify.heartbeat_min, 10);
  assert.equal(s.plugins.report.default_style, 'papercraft');
  assert.deepEqual(s.plugins.present, { enabled: true, default_style: 'papercraft-deck' });
  assert.equal(s.standards.enabled, true);
  assert.match(s.standards.preamble, /red.*green.*refactor/i);
  assert.match(s.standards.preamble, /DRY/);
  assert.match(s.standards.preamble, /evidencia/i);
  assert.deepEqual(s.providers, { opencode: { isolate_config: true } });
  assert.match(s.standards.preamble, /internet/i);
  assert.match(s.standards.preamble, /webfetch/i);
  assert.match(s.standards.preamble, /fuente/i);
  assert.match(s.standards.preamble, /No crees archivos de plan, notas, capturas ni temporales dentro del repositorio fuera de los entregables pedidos/);
  assert.deepEqual(DEFAULT_SETTINGS.defaults.max_parallel, 4);
});
test('workers admiten free y validan que sea booleano', () => {
  const { h, env } = withYml(`
workers:
  sin-costo: {provider: opencode, model: m, free: true}
roles: {reporter: sin-costo, summarizer: sin-costo, reviewer: sin-costo}
defaults: {worker: sin-costo}
`);
  assert.equal(loadSettings(h, env).workers['sin-costo'].free, true);

  const invalid = withYml('workers: {x: {provider: codex, model: m, free: "yes"}}\n');
  assert.throws(() => loadSettings(invalid.h, invalid.env), /workers\.x\.free/);
});
test('preferences.provider defaults to auto and accepts both providers', () => {
  for (const provider of ['codex', 'opencode']) {
    const { h, env } = withYml(`preferences: {provider: ${provider}}\n`);
    assert.deepEqual(loadSettings(h, env).preferences, { provider });
  }
});
test('invalid preferences.provider identifies the field', () => {
  const { h, env } = withYml('preferences: {provider: nope}\n');
  assert.throws(() => loadSettings(h, env), /preferences\.provider/);
});
test('exit_grace_s has a default and must be positive', () => {
  const { h, env } = withYml('defaults: {worker: luna-max, exit_grace_s: 0}\n');
  assert.throws(() => loadSettings(h, env), /defaults\.exit_grace_s/);
});
test('yml replaces workers, merges sections', () => {
  const { h, env } = withYml(`
workers:
  solo: {provider: opencode, model: opencode-go/deepseek-v4-pro, effort: max, priority: 1}
roles: {reporter: solo, summarizer: solo, reviewer: solo, presenter: solo}
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
  fs.writeFileSync(f, 'workers:\n  z: {provider: codex, model: m}\ndefaults: {worker: z}\nroles: {reporter: z, summarizer: z, reviewer: z, presenter: z}\n');
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
test('OpenCode config isolation defaults on and supports a custom directory', () => {
  const { h, env } = withYml("providers:\n  opencode: {isolate_config: true, config_dir: 'C:/custom/opencode'}\n");
  assert.deepEqual(loadSettings(h, env).providers, {
    opencode: { isolate_config: true, config_dir: 'C:/custom/opencode' },
  });
  const disabled = withYml('providers: {opencode: {isolate_config: false}}\n');
  assert.deepEqual(loadSettings(disabled.h, disabled.env).providers, { opencode: { isolate_config: false } });
});
test('invalid OpenCode provider settings identify the field', () => {
  const isolate = withYml('providers: {opencode: {isolate_config: "yes"}}\n');
  assert.throws(() => loadSettings(isolate.h, isolate.env), /providers\.opencode\.isolate_config/);
  const directory = withYml('providers: {opencode: {config_dir: 7}}\n');
  assert.throws(() => loadSettings(directory.h, directory.env), /providers\.opencode\.config_dir/);
});
test('plugins.improve: defaults y override', () => {
  const s = loadSettings(home(), {});
  assert.deepEqual(s.plugins.improve, { enabled: true, hints: true });
  const { h, env } = withYml('plugins: {improve: {enabled: false, hints: false}}\n');
  assert.deepEqual(loadSettings(h, env).plugins.improve, { enabled: false, hints: false });
});
test('plugins.present: default, override and validation', () => {
  const defaults = loadSettings(home(), {});
  assert.deepEqual(defaults.plugins.present, { enabled: true, default_style: 'papercraft-deck' });
  assert.equal(defaults.roles.presenter, 'luna-max');

  const { h, env } = withYml('workers: {alt: {provider: codex, model: m}}\ndefaults: {worker: alt}\nroles: {reporter: alt, summarizer: alt, reviewer: alt, presenter: alt}\nplugins: {present: {enabled: false, default_style: custom}}\n');
  const configured = loadSettings(h, env);
  assert.equal(configured.roles.presenter, 'alt');
  assert.deepEqual(configured.plugins.present, { enabled: false, default_style: 'custom' });

  const invalidRole = withYml('roles: {presenter: ghost}\n');
  assert.throws(() => loadSettings(invalidRole.h, invalidRole.env), /roles\.presenter.*ghost/);
  const invalidPlugin = withYml('plugins: {present: {enabled: yes}}\n');
  assert.throws(() => loadSettings(invalidPlugin.h, invalidPlugin.env), /plugins\.present\.enabled/);
});
test('invalid plugins.improve identify the field', () => {
  const { h, env } = withYml('plugins: {improve: {enabled: maybe}}\n');
  assert.throws(() => loadSettings(h, env), /plugins\.improve\.enabled/);
});
test('plugins.widget defaults enabled and supports override and validation', () => {
  assert.deepEqual(loadSettings(home(), {}).plugins.widget, { enabled: true });

  const disabled = withYml('plugins: {widget: {enabled: false}}\n');
  assert.deepEqual(loadSettings(disabled.h, disabled.env).plugins.widget, { enabled: false });

  const invalid = withYml('plugins: {widget: {enabled: "yes"}}\n');
  assert.throws(() => loadSettings(invalid.h, invalid.env), /plugins\.widget\.enabled/);
});
test('config: COLMENA_* beats LUNA_*, settings attached, default home', () => {
  const c = getConfig({ COLMENA_HOME: 'C:\\a', LUNA_HOME: 'C:\\b', COLMENA_CODEX_BIN: 'x.js' });
  assert.ok(c.home.endsWith('a'));
  assert.equal(c.settingsPath, path.join(c.home, 'colmena.yml'));
  assert.equal(c.settings.defaults.worker, 'luna-max');
  const d = getConfig({ LUNA_CODEX_BIN: 'x.js' });
  assert.ok(d.home.endsWith('.colmena'));
  const e = getConfig({ COLMENA_HOME: 'C:\\a', COLMENA_MAX_PARALLEL: '2', LUNA_CODEX_BIN: 'x.js' });
  assert.equal(e.maxParallel, 2);
  const custom = getConfig({ COLMENA_HOME: 'C:\\a', COLMENA_CONFIG: 'C:\\custom.yml', LUNA_CODEX_BIN: 'x.js' });
  assert.equal(custom.settingsPath, 'C:\\custom.yml');
});

test('custom workers without a presenter role: presenter falls back to defaults.worker (configs from before the role keep loading)', () => {
  const { h, env } = withYml('workers:\n  a: {provider: codex, model: m}\n  b: {provider: opencode, model: n}\ndefaults: {worker: b}\nroles: {reporter: a, summarizer: a, reviewer: a}\n');
  assert.equal(loadSettings(h, env).roles.presenter, 'b');
  const explicit = withYml('workers:\n  a: {provider: codex, model: m}\n  b: {provider: opencode, model: n}\ndefaults: {worker: b}\nroles: {reporter: a, summarizer: a, reviewer: a, presenter: a}\n');
  assert.equal(loadSettings(explicit.h, explicit.env).roles.presenter, 'a');
  assert.equal(loadSettings(home(), {}).roles.presenter, 'luna-max');
});
