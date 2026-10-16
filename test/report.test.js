import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_SUFFIX, buildPrompt, parseReport } from '../src/report.js';

const good = 'RESULT: hecho\nFILES: a.js\nTESTS: 3/3\nRISKS: ninguno';
test('well-formed report', () => {
  const r = parseReport(good);
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, 'hecho');
  assert.equal(r.sections.TESTS, '3/3');
});
test('multiline sections', () => {
  const r = parseReport('RESULT: x\n- y\nFILES: a\nb\nTESTS: t\nRISKS: r');
  assert.equal(r.ok, true);
  assert.match(r.sections.RESULT, /y/);
  assert.match(r.sections.FILES, /b/);
});
test('malformed → not ok, truncated', () => {
  const r = parseReport('x'.repeat(5000));
  assert.equal(r.ok, false);
  assert.ok(r.text.length <= 1500);
});
test('empty/undefined does not crash', () => {
  assert.equal(parseReport('').ok, false);
  assert.equal(parseReport(undefined).ok, false);
});
test('buildPrompt includes everything', () => {
  const p = buildPrompt({ task: 'haz X "con comillas"\n$HOME `x`', contextFiles: ['src/a.js'], handoff: ['resumen previo A'] });
  assert.ok(p.includes('haz X "con comillas"\n$HOME `x`'));
  assert.match(p, /Contexto previo/);
  assert.ok(p.includes('resumen previo A'));
  assert.ok(p.includes('src/a.js'));
  assert.ok(p.includes(REPORT_SUFFIX));
});
test('buildPrompt prepends configured standards only for run jobs', () => {
  const standards = { enabled: true, preamble: 'ESTÁNDARES DE PRUEBA' };
  const run = buildPrompt({ task: 'implementa', kind: 'run', standards });
  assert.ok(run.startsWith('ESTÁNDARES DE PRUEBA\n\n'));
  assert.ok(!buildPrompt({ task: 'implementa', kind: 'run' }).includes('ESTÁNDARES DE PRUEBA'));
  assert.ok(!buildPrompt({ task: 'resume', kind: 'summarize', standards }).includes('ESTÁNDARES DE PRUEBA'));
  assert.ok(!buildPrompt({ task: 'revisa', kind: 'review', standards }).includes('ESTÁNDARES DE PRUEBA'));
  assert.ok(!buildPrompt({ task: 'implementa', kind: 'run', standards: { ...standards, enabled: false } }).includes('ESTÁNDARES DE PRUEBA'));
});
