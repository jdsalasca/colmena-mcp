import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { generateReport, buildReportData, renderFallback, listStyles } from '../src/plugins/report.js';
import { baseEnv, codexOnlyHome, tmp } from './helpers.js';

const S = (task, extra = {}) => ({ task, cwd: tmp('colmena-c-'), isolation: 'inplace', ...extra });
async function setup(raw) {
  if (raw) process.env.FAKE_RAW = raw;
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const ids = [jm.submit(S('Implementar login')), jm.submit(S('FAIL migración'))];
  await jm.wait(ids);
  delete process.env.FAKE_RAW;
  return { config, jm, ids };
}
const withEnv = async (k, v, fn) => { process.env[k] = v; try { return await fn(); } finally { delete process.env[k]; } };

test('buildReportData: jobs, totals, report sections', async () => {
  const { jm, ids } = await setup();
  const d = buildReportData(jm, ids, { title: 'Ronda 1' });
  assert.equal(d.title, 'Ronda 1');
  assert.equal(d.jobs.length, 2);
  assert.equal(d.totals.jobs, 2); assert.equal(d.totals.done, 1); assert.equal(d.totals.failed, 1);
  assert.match(d.jobs[0].report.RESULT, /^ok/);
  assert.equal(d.jobs[0].worker, 'luna-max');
  assert.ok(d.jobs[1].error);
});
test('non-terminal job → error', async () => {
  const config = getConfig(baseEnv(codexOnlyHome())); const jm = createJobManager(config);
  const id = jm.submit(S('SLEEP'));
  await assert.rejects(generateReport({ jm, config, ids: [id], title: 'x' }), /sigue/);
  await jm.cancel(id); await jm.wait([id], { timeoutS: 20 });
});
test('reporter writes report.html → used, no fallback', async () => {
  const { jm, config, ids } = await setup();
  const r = await generateReport({ jm, config, ids, title: 'Ronda 1' });
  assert.equal(r.usedFallback, false);
  assert.match(fs.readFileSync(r.path, 'utf8'), /fake report/);
  assert.ok(fs.existsSync(path.join(path.dirname(r.path), 'data.json')));
});
test('reporter writes nothing → fallback html with each RESULT, escaped', async () => {
  const { jm, config, ids } = await setup('RESULT: arreglé <script>alert(1)</script> & más\nFILES: a.js\nTESTS: 3/3\nRISKS: ninguno');
  await withEnv('FAKE_REPORT', 'skip', async () => {
    const r = await generateReport({ jm, config, ids, title: 'Ronda <1>' });
    assert.equal(r.usedFallback, true);
    const html = fs.readFileSync(r.path, 'utf8');
    assert.match(html, /arreglé &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; más/);
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /Ronda &lt;1&gt;/);
    assert.ok(!html.includes('{{'), 'no leftover placeholders');
    assert.match(html, /class="washi"/);
    assert.match(html, /stamp done/); assert.match(html, /stamp failed/);
  });
});
test('reporter job fails → fallback still produced', async () => {
  const { jm, config, ids } = await setup();
  await withEnv('FAKE_REPORT', 'fail', async () => {
    const r = await generateReport({ jm, config, ids, title: 'Ronda' });
    assert.equal(r.usedFallback, true);
    assert.match(fs.readFileSync(r.path, 'utf8'), /<html/);
  });
});
test('user style in <home>/styles overrides the built-in; unknown style lists available', async () => {
  const { jm, config, ids } = await setup();
  const dir = path.join(config.home, 'styles', 'papercraft'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'template.html'), '<html><body>MI ESTILO {{title}}<!--COLMENA:CARDS--></body></html>');
  fs.writeFileSync(path.join(dir, 'style.md'), 'mi estilo');
  await withEnv('FAKE_REPORT', 'skip', async () => {
    const r = await generateReport({ jm, config, ids, title: 'T' });
    assert.match(fs.readFileSync(r.path, 'utf8'), /MI ESTILO T/);
  });
  await assert.rejects(generateReport({ jm, config, ids, style: 'nope', title: 'T' }), /estilo 'nope'.*papercraft/);
  assert.ok(listStyles(config).includes('papercraft'));
});
test('title with spaces and accents → safe folder, file exists', async () => {
  const { jm, config, ids } = await setup();
  const r = await generateReport({ jm, config, ids, title: 'Informe ñandú ÁÉ: "final"/1' });
  assert.ok(fs.existsSync(r.path));
  assert.ok(!/[:"<>|?*]/.test(path.basename(path.dirname(r.path))));
});
test('built-in papercraft template fills every placeholder', async () => {
  const { jm, ids } = await setup();
  const d = buildReportData(jm, ids, { title: 'Prueba', subtitle: 'sub' });
  const html = renderFallback(d, path.join(process.cwd(), 'styles', 'papercraft'));
  assert.ok(!html.includes('{{') && !html.includes('COLMENA:CARDS'));
  assert.match(html, /<article class="card"/);
});
