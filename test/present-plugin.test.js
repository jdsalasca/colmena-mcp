import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createJobManager } from '../src/jobs.js';
import { generatePresentation } from '../src/plugins/present.js';
import { generateReport } from '../src/plugins/report.js';
import { baseEnv, codexOnlyHome, tmp } from './helpers.js';

const task = (name, extra = {}) => ({ task: name, cwd: tmp('colmena-present-job-'), isolation: 'inplace', ...extra });
async function setup(raw) {
  if (raw) process.env.FAKE_RAW = raw;
  const config = getConfig(baseEnv(codexOnlyHome()));
  const jm = createJobManager(config);
  const ids = [jm.submit(task('Implementar acceso')), jm.submit(task('FAIL prueba'))];
  await jm.wait(ids);
  delete process.env.FAKE_RAW;
  return { config, jm, ids };
}
const withEnv = async (key, value, fn) => {
  process.env[key] = value;
  try { return await fn(); } finally { delete process.env[key]; }
};

test('presenter writes a valid deck.html → used without fallback', async () => {
  const { config, jm, ids } = await setup();
  const log = path.join(tmp('colmena-present-log-'), 'fake.log');
  const result = await withEnv('FAKE_LOG', log, () => generatePresentation({ jm, config, ids, title: 'Hito de acceso', notes: 'Objetivo: habilitar acceso seguro.' }));
  assert.equal(result.usedFallback, false);
  assert.equal(result.style, 'papercraft-deck');
  assert.ok(result.presenterJob);
  assert.ok(result.cost_usd >= 0);
  assert.ok(fs.existsSync(result.path));
  assert.match(fs.readFileSync(result.path, 'utf8'), /fake presentation/);
  const meta = jm.meta(result.presenterJob);
  assert.equal(meta.worker, config.settings.roles.presenter);
  assert.equal(meta.cwd, result.dir);
  assert.equal(meta.isolation, 'inplace');
  const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.match(invocation.prompt, /styles[\\/]papercraft-deck[\\/]style\.md/);
  assert.match(invocation.prompt, /styles[\\/]papercraft-deck[\\/]template\.html/);
  assert.match(invocation.prompt, /data\.json/);
  assert.match(invocation.prompt, /deck\.html/);
  assert.match(path.basename(result.dir), /-hito-de-acceso-deck$/);
  const data = JSON.parse(fs.readFileSync(path.join(result.dir, 'data.json'), 'utf8'));
  assert.deepEqual(data.notes, 'Objetivo: habilitar acceso seguro.');
  assert.equal(data.jobs.length, 2);
  assert.equal(data.totals.jobs, 2);
});

test('presenter writes nothing → fallback has a cover, notes, job slides, metrics and closing', async () => {
  const raw = 'RESULT: cambió <script>alert(1)</script> & más\nFILES: src/a.js\nTESTS: 4/4\nRISKS: revisar <img src=x> & acceso';
  const { config, jm, ids } = await setup(raw);
  await withEnv('FAKE_PRESENT', 'skip', async () => {
    const result = await generatePresentation({ jm, config, ids, title: 'Cierre <script>ñandú</script>', notes: 'Decisiones: mantener API.\nRiesgos: revisar accesibilidad.' });
    assert.equal(result.usedFallback, true);
    const html = fs.readFileSync(result.path, 'utf8');
    assert.match(html, /Portada|Hito/);
    assert.match(html, /Decisiones: mantener API\./);
    assert.match(html, /cambió &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; más/);
    assert.match(html, /src\/a\.js/);
    assert.match(html, /4\/4/);
    assert.match(html, /revisar &lt;img src=x&gt; &amp; acceso/);
    assert.match(html, /Cierre &lt;script&gt;ñandú&lt;\/script&gt;/);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /Métricas/);
    assert.match(html, /Cierre/);
    assert.ok((html.match(/class="slide"/g) ?? []).length >= 4);
    assert.equal((html.match(/<h3>RESULT<\/h3>/g) ?? []).length, 2);
    assert.ok(!html.includes('{{') && !html.includes('COLMENA:SLIDES'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  });
});

test('presenter job fails or produces invalid HTML → deterministic fallback', async () => {
  const { config, jm, ids } = await setup();
  for (const behavior of ['fail', 'invalid']) {
    await withEnv('FAKE_PRESENT', behavior, async () => {
      const result = await generatePresentation({ jm, config, ids, title: `Hito ${behavior}` });
      assert.equal(result.usedFallback, true, behavior);
      const html = fs.readFileSync(result.path, 'utf8');
      assert.ok((html.match(/class="slide"/g) ?? []).length >= 3, behavior);
    });
  }
});

test('unknown style lists available styles; accented title makes a safe folder', async () => {
  const { config, jm, ids } = await setup();
  await assert.rejects(generatePresentation({ jm, config, ids, style: 'missing-style' }), /estilo 'missing-style'.*papercraft-deck/);
  const result = await generatePresentation({ jm, config, ids, title: 'Hito ñandú Ágil' });
  assert.match(path.basename(result.dir), /hito-nandu-agil-deck$/);
  assert.ok(!/[<>:"|?*]/.test(path.basename(result.dir)));
});

test('report and presentation reject templates for the other output format', async () => {
  const { config, jm, ids } = await setup();
  await assert.rejects(generateReport({ jm, config, ids, style: 'papercraft-deck' }), /estilo 'papercraft-deck'.*papercraft/);
  await assert.rejects(generatePresentation({ jm, config, ids, style: 'papercraft' }), /estilo 'papercraft'.*papercraft-deck/);
});

test('papercraft-deck template is self-contained, navigable and complete after fallback rendering', async () => {
  const styleDir = path.join(process.cwd(), 'styles', 'papercraft-deck');
  const template = fs.readFileSync(path.join(styleDir, 'template.html'), 'utf8');
  for (const marker of ['{{title}}', '{{subtitle}}', '{{generated}}', '{{slides_count}}', '<!--COLMENA:SLIDES-->']) assert.ok(template.includes(marker), marker);
  assert.match(template, /scroll-snap/);
  assert.match(template, /ArrowRight/);
  assert.match(template, /ArrowLeft/);
  assert.match(template, /Home/);
  assert.match(template, /End/);
  assert.ok(template.includes("' ', 'PageDown'"));
  assert.match(template, /@media\s+print/);
  assert.match(template, /break-after:\s*page/);
  assert.match(template, /prefers-color-scheme:\s*dark/);
  assert.match(template, /prefers-reduced-motion/);
  assert.doesNotMatch(template, /https?:\/\//);
  assert.doesNotMatch(template, /@import/i);

  const { config, jm, ids } = await setup();
  await withEnv('FAKE_PRESENT', 'skip', async () => {
    const result = await generatePresentation({ jm, config, ids });
    const html = fs.readFileSync(result.path, 'utf8');
    assert.ok(!html.includes('{{') && !html.includes('COLMENA:SLIDES'));
    assert.match(html, /id="progress"/);
    assert.match(html, /id="page-number"/);
  });
});
