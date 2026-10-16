import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildReportData, escapeHtml, formatDuration, resolveStyle, slugify } from './report.js';

const PRESENTATION_MIN_BYTES = 600;
const PRESENTATION_MAX_BYTES = 2_000_000;

const paragraphs = value => escapeHtml(value).replace(/\r?\n/g, '<br>');

function notesText(notes) {
  if (typeof notes === 'string') return notes.trim() || 'No se incluyeron notas del orquestador.';
  if (notes == null) return 'No se incluyeron notas del orquestador.';
  return JSON.stringify(notes, null, 2);
}

function slideStart(page, label) {
  return `<section class="slide" aria-label="${escapeHtml(label)}" data-page="${page}">\n<div class="paper-stack"><article class="paper">\n<span class="washi" aria-hidden="true"></span>\n`;
}

function slideEnd() {
  return '</article></div>\n</section>';
}

function notesSlide(notes, page) {
  return `${slideStart(page, 'Objetivo, decisiones y riesgos')}<p class="eyebrow">Contexto del hito</p><h2>Objetivo, decisiones y riesgos</h2><div class="note-copy">${paragraphs(notes)}</div>${slideEnd()}`;
}

function jobSlide(job, index) {
  const report = job.report ?? {};
  const result = report.RESULT ?? job.text ?? '(sin resultado reportado)';
  const files = report.FILES ?? (job.files?.length ? job.files.join('\n') : '(sin archivos reportados)');
  const tests = report.TESTS ?? '(sin pruebas reportadas)';
  const risks = report.RISKS ?? job.error ?? '(sin riesgos reportados)';
  const stamp = job.state === 'done' ? 'done' : ['failed', 'orphaned'].includes(job.state) ? 'failed' : job.state === 'cancelled' ? 'cancelled' : 'other';
  const section = (title, content, cls = '') => `<section${cls ? ` class="${cls}"` : ''}><h3>${title}</h3><p>${paragraphs(content)}</p></section>`;
  return `${slideStart(index, `Resultado ${index}`)}
<header class="slide-heading"><div><p class="eyebrow">Resultado ${index}</p><h2>${escapeHtml(job.task)}</h2></div><span class="stamp ${stamp}">${escapeHtml(job.state)}</span></header>
<p class="meta"><span class="chip">${escapeHtml(job.worker)}</span><span class="chip">${formatDuration(job.durationS)}</span><span class="chip">$${job.cost_usd.toFixed(2)}</span></p>
<div class="job-sections">${section('RESULT', result)}${section('FILES', files)}${section('TESTS', tests)}${section('RISKS', risks, 'risk')}</div>
${slideEnd()}`;
}

function metricsSlide(data, page) {
  const { totals } = data;
  return `${slideStart(page, 'Métricas del hito')}
<p class="eyebrow">Cifras registradas</p><h2>Métricas</h2>
<ul class="metrics"><li><b>${totals.jobs}</b><span>tareas revisadas</span></li><li><b>${totals.done}</b><span>terminaron bien</span></li><li><b>${totals.failed}</b><span>fallaron</span></li><li><b>${totals.cancelled}</b><span>canceladas</span></li><li><b>$${totals.costUsd.toFixed(2)}</b><span>costo reportado</span></li><li><b>${formatDuration(totals.durationS)}</b><span>duración acumulada</span></li></ul>
${slideEnd()}`;
}

function renderFallback(data, styleDir) {
  const template = fs.readFileSync(path.join(styleDir, 'template.html'), 'utf8');
  const notes = notesText(data.notes);
  const slides = [
    `${slideStart(1, 'Portada')}
<p class="eyebrow">Cierre de hito · Colmena</p><h1 class="hand">${escapeHtml(data.title)}</h1><p class="subtitle">${escapeHtml(data.subtitle)}</p>
<div class="cover-meta"><span>${data.totals.jobs} tareas</span><span>${data.totals.done} completadas</span><span>$${data.totals.costUsd.toFixed(2)} reportados</span></div>
${slideEnd()}`,
    notesSlide(notes, 2),
    ...data.jobs.map((job, index) => jobSlide(job, index + 1)),
    metricsSlide(data, data.jobs.length + 3),
    `${slideStart(data.jobs.length + 4, 'Cierre')}
<p class="eyebrow">Fin de la presentación</p><h2>Cierre</h2><p class="closing-copy">Esta presentación reúne los resultados registrados para <strong>${escapeHtml(data.title)}</strong>. Contrasta sus datos con los resultados de cada job antes de compartirla.</p>
${slideEnd()}`,
  ];
  const values = {
    title: escapeHtml(data.title), subtitle: escapeHtml(data.subtitle),
    generated: escapeHtml(data.generatedAt.replace('T', ' ').slice(0, 16)),
    slides_count: slides.length,
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''))
    .replace('<!--COLMENA:SLIDES-->', slides.join('\n'));
}

function presenterPrompt(styleDir, dir) {
  return `COLMENA_PRESENT\nEres quien redacta la presentación HTML de cierre de un hito de software.\nLee, en este orden:\n1. ${path.join(styleDir, 'style.md')} (criterios narrativos y estructura)\n2. ${path.join(styleDir, 'template.html')} (plantilla visual obligatoria)\n3. ${path.join(dir, 'data.json')} (única fuente de verdad)\nEscribe ${path.join(dir, 'deck.html')} como una presentación autocontenida y fiel a los datos. Conserva los controles y estilos de la plantilla; reemplaza todos sus marcadores y el comentario de diapositivas por al menos tres <section class="slide">. No modifiques otros archivos. Al terminar responde solo: listo.`;
}

function validPresentation(file) {
  try {
    const html = fs.readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(html, 'utf8');
    const slides = html.match(/\bclass\s*=\s*(["'])[^"']*\bslide\b[^"']*\1/gi) ?? [];
    return bytes >= PRESENTATION_MIN_BYTES && bytes <= PRESENTATION_MAX_BYTES && /<html\b/i.test(html) && slides.length >= 3;
  } catch { return false; }
}

function uniquePresentationDir(config, title) {
  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${slugify(title)}-deck`;
  let dir = path.join(config.reportsDir, base);
  for (let suffix = 2; fs.existsSync(dir); suffix++) dir = path.join(config.reportsDir, `${date}-${slugify(title)}-${suffix}-deck`);
  return dir;
}

export async function generatePresentation({ jm, config, ids, style, title, subtitle, notes, open = false }) {
  if (!ids?.length) throw new Error('indica al menos un job_id');
  const styleName = style ?? config.settings.plugins.present.default_style;
  const styleDir = resolveStyle(config, styleName, { marker: '<!--COLMENA:SLIDES-->' });
  const reportData = buildReportData(jm, ids, { title: title || 'Cierre de hito', subtitle });
  const data = { ...reportData, notes: notes ?? '' };
  const dir = uniquePresentationDir(config, data.title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 2));

  const out = path.join(dir, 'deck.html');
  let presenterJob = null;
  let cost = 0;
  try {
    presenterJob = jm.submit({
      kind: 'present', task: `presentación: ${data.title}`, cwd: dir, isolation: 'inplace',
      worker: config.settings.roles.presenter, rawPrompt: presenterPrompt(styleDir, dir),
    });
    const waited = await jm.wait([presenterJob], { timeoutS: 300 });
    if (waited.pending.length) await jm.cancel(presenterJob);
    try { cost = jm.result(presenterJob).cost_usd ?? 0; } catch { /* job incompleto: conserva el costo conocido */ }
  } catch { /* si el agente no puede generar, se conserva el respaldo determinista */ }

  const usedFallback = !validPresentation(out);
  if (usedFallback) fs.writeFileSync(out, renderFallback(data, styleDir));
  if (open && process.platform === 'win32') {
    try { spawn('explorer.exe', [out], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best-effort */ }
  }
  return { path: out, dir, style: styleName, usedFallback, presenterJob, cost_usd: cost };
}
