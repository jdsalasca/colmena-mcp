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

test('decorated headers (bold/heading/list/backticks, lowercase, colon spacing) are recognized and cleaned', () => {
  const cases = [
    '**RESULT:** hecho',
    '**RESULT**: hecho',
    '__RESULT__: hecho',
    '`RESULT`: hecho',
    '## RESULT: hecho',
    '### RESULT : hecho',
    '- RESULT: hecho',
    '* RESULT: hecho',
    '*RESULT*: hecho',
    'result: hecho',
    '- **RESULT:** hecho',
  ];
  for (const header of cases) {
    const r = parseReport(`${header}\nFILES: a.js\nTESTS: 3/3\nRISKS: r`);
    assert.equal(r.ok, true, `header: ${header}`);
    assert.equal(r.sections.RESULT, 'hecho', `header: ${header}`);
  }
});

test('emphasis wrapping section content is unwrapped', () => {
  const r = parseReport('**RESULT:** **hecho**\n**FILES:** `a.js`\n__TESTS__: todo verde\nRISKS: **ninguno**');
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, 'hecho');
  assert.equal(r.sections.FILES, 'a.js');
  assert.equal(r.sections.RISKS, 'ninguno');
});

test('decorated multiline sections keep their body intact', () => {
  const r = parseReport('- **RESULT:** hecho\n  detalle uno\n  detalle dos\n## FILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, 'hecho\n  detalle uno\n  detalle dos');
});

test('false positives: phrases, mid-line mentions, code strings are not sections', () => {
  const r = parseReport([
    'El resultado fue: bueno',
    'Nota: RESULT: esto no es sección',
    'ver `RESULT:` mencionado',
    'const code = "RESULT: falso";',
    'resultados: no',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.sections, {});
});

test('mid-line RESULT mention inside a section does not split it', () => {
  const r = parseReport('RESULT: explica `RESULT:` aquí\nFILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, 'explica `RESULT:` aquí');
});

test('code fences around a valid report still parse', () => {
  const r = parseReport('```\nRESULT: x\nFILES: a.js\nTESTS: t\nRISKS: r\n```');
  assert.equal(r.ok, true);
  assert.match(r.sections.RISKS, /^r/);
});

test('reordered sections still ok', () => {
  const r = parseReport('FILES: a.js\nRESULT: hecho\nRISKS: r\nTESTS: t');
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, 'hecho');
  assert.equal(r.sections.FILES, 'a.js');
});

test('missing section → not ok', () => {
  const r = parseReport('RESULT: x\nFILES: a.js\nTESTS: t');
  assert.equal(r.ok, false);
});

test('empty sections present are still ok', () => {
  const r = parseReport('**RESULT:**\nFILES:\nTESTS:\nRISKS:');
  assert.equal(r.ok, true);
  assert.equal(r.sections.RESULT, '');
  assert.equal(r.sections.FILES, '');
});

test('keyword followed by free text without colon is not a header (real values kept)', () => {
  const r1 = parseReport('RESULT: listo\nResult of the migration was fine.\nFILES: a.js\nTESTS: ok\nRISKS: no');
  assert.equal(r1.ok, true);
  assert.equal(r1.sections.RESULT, 'listo\nResult of the migration was fine.');
  const r2 = parseReport('RESULT: hecho\nTests ejecutados en CI y verdes.\nFILES: a.js\nTESTS: 3/3\nRISKS: ninguno');
  assert.equal(r2.ok, true);
  assert.equal(r2.sections.RESULT, 'hecho\nTests ejecutados en CI y verdes.');
  assert.equal(r2.sections.TESTS, '3/3');
  const r3 = parseReport('RESULT: x\nFILES: a.js\nTESTS: t\nRISKS: baja\nRisks remain low overall.');
  assert.equal(r3.ok, true);
  assert.equal(r3.sections.RISKS, 'baja\nRisks remain low overall.');
  const r4 = parseReport('RESULT: x\n- files touched in this PR\nFILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r4.ok, true);
  assert.equal(r4.sections.RESULT, 'x\n- files touched in this PR');
});

test('keyword followed by free text after decoration is not a header', () => {
  const r = parseReport('## RESULT hecho\nFILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r.ok, false);
  assert.equal('RESULT' in r.sections, false);
});

test('keyword-only decorated header without colon is a header', () => {
  const r1 = parseReport('## RESULT\nFILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r1.ok, true);
  assert.equal(r1.sections.RESULT, '');
  const r2 = parseReport('**RESULT**\nFILES: a.js\nTESTS: t\nRISKS: r');
  assert.equal(r2.ok, true);
  assert.equal(r2.sections.RESULT, '');
  const r3 = parseReport('- FILES\nRESULT: x\nTESTS: t\nRISKS: r');
  assert.equal(r3.ok, true);
  assert.equal(r3.sections.FILES, '');
});

test('worktree run jobs get git rules naming the branch; other jobs do not', () => {
  const withBranch = buildPrompt({ task: 'x', kind: 'run', branch: 'colmena/ab12' });
  assert.match(withBranch, /colmena\/ab12/);
  assert.match(withBranch, /NO hagas merge/i);
  assert.match(withBranch, /prevalecen sobre cualquier instrucción global/i);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'run' }), /NO hagas merge/i);
  assert.doesNotMatch(buildPrompt({ task: 'x', kind: 'review', branch: 'colmena/ab12' }), /NO hagas merge/i);
});
