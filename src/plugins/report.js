import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { improveNext } from './improve.js';
import { jobMetrics } from '../job-metrics.js';
import { writeFileAtomic } from '../atomic-write.js';

const BUILTIN_STYLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles');
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);

export const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const esc = escapeHtml;
const para = s => esc(s).replace(/\n/g, '<br>');
export const formatDuration = s => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const fmtDuration = formatDuration;
export const slugify = t => (String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'informe';

function hasTemplate(dir, marker) {
  const template = path.join(dir, 'template.html');
  return fs.existsSync(template) && (!marker || fs.readFileSync(template, 'utf8').includes(marker));
}

export function listStyles(config, { marker } = {}) {
  const names = new Set();
  for (const base of [path.join(config.home, 'styles'), BUILTIN_STYLES]) {
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && hasTemplate(path.join(base, d.name), marker)) names.add(d.name);
      }
    } catch { /* missing dir */ }
  }
  return [...names].sort();
}

export function resolveStyle(config, name, { marker } = {}) {
  for (const base of [path.join(config.home, 'styles'), BUILTIN_STYLES]) {
    const dir = path.join(base, name);
    if (hasTemplate(dir, marker)) return dir;
  }
  throw new Error(`estilo '${name}' no existe; disponibles: ${listStyles(config, { marker }).join(', ') || '(ninguno)'}`);
}

export function buildReportData(jm, ids, { title = 'Informe de Colmena', subtitle } = {}) {
  const jobs = ids.map(id => {
    const m = jm.meta(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine antes de generar el reporte`);
    const r = jm.result(id, { detail: 'normal' });
    const { durationS, costUsd } = jobMetrics(m);
    return { id, worker: m.worker, task: m.task, state: m.state, report: r.report ?? null, text: r.text ?? null, files: m.files ?? [], diffstat: m.diffstat ?? '', cost_usd: costUsd, durationS, branch: m.branch ?? null, error: m.error ?? null };
  });
  const done = jobs.filter(j => j.state === 'done').length;
  const failed = jobs.filter(j => j.state === 'failed' || j.state === 'orphaned').length;
  return {
    title, subtitle: subtitle ?? `${done} de ${jobs.length} tareas terminaron correctamente`, generatedAt: new Date().toISOString(), jobs,
    totals: { jobs: jobs.length, done, failed, cancelled: jobs.filter(j => j.state === 'cancelled').length, costUsd: jobs.reduce((s, j) => s + j.cost_usd, 0), durationS: jobs.reduce((s, j) => s + j.durationS, 0) },
  };
}

function card(j) {
  const stamp = j.state === 'done' ? 'done' : j.state === 'failed' || j.state === 'orphaned' ? 'failed' : j.state === 'cancelled' ? 'cancelled' : 'other';
  const sec = (h, v, cls = '') => (v ? `<section${cls ? ` class="${cls}"` : ''}><h4>${h}</h4><p>${para(v)}</p></section>` : '');
  const rep = j.report;
  const body = rep
    ? sec('Resultado', rep.RESULT) + sec('Archivos', rep.FILES) + sec('Pruebas', rep.TESTS) + (rep.RISKS && !/^ninguno\.?$/i.test(rep.RISKS.trim()) ? sec('Riesgos', rep.RISKS, 'risks') : '')
    : sec('Resultado', j.text || '(sin reporte)') + sec('Error', j.error, 'risks');
  return `<article class="card" data-state="${esc(j.state)}">
  <span class="washi"></span>
  <header><h3>${esc(String(j.task).slice(0, 90))}</h3><span class="stamp ${stamp}">${esc(j.state)}</span></header>
  <p class="meta"><span class="chip">${esc(j.worker)}</span><span class="chip">${fmtDuration(j.durationS)}</span><span class="chip">$${j.cost_usd.toFixed(2)}</span>${j.branch ? `<span class="chip">rama ${esc(j.branch)}</span>` : ''}</p>
  ${body}
</article>`;
}

export function renderFallback(data, styleDir) {
  const tpl = fs.readFileSync(path.join(styleDir, 'template.html'), 'utf8');
  const vals = {
    title: esc(data.title), subtitle: esc(data.subtitle), generated: esc(data.generatedAt.replace('T', ' ').slice(0, 16)),
    jobs: data.totals.jobs, done: data.totals.done, failed: data.totals.failed + data.totals.cancelled,
    cost: data.totals.costUsd.toFixed(2), duration: fmtDuration(data.totals.durationS),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vals[k] ?? '')).replace('<!--COLMENA:CARDS-->', data.jobs.map(card).join('\n'));
}

function reporterPrompt(styleDir, dir) {
  return `COLMENA_REPORT
Eres el reportero de un equipo de agentes de programación. Genera el reporte HTML final de la ronda.
Lee, en este orden:
1. ${path.join(styleDir, 'style.md')}  (instrucciones del estilo; síguelas al pie de la letra)
2. ${path.join(styleDir, 'template.html')}  (plantilla base)
3. ${path.join(dir, 'data.json')}  (datos de la ronda: única fuente de verdad)
Escribe el resultado en ${path.join(dir, 'report.html')} (un solo archivo autocontenido). No modifiques ningún otro archivo. Al terminar responde solo: listo.`;
}

function nextSuggestions(jm, ids, config) {
  const { enabled, hints } = config.settings.plugins.improve;
  if (!enabled || !hints) return null;
  const suggestions = improveNext(jm, jm.meta(ids[0]).cwd);
  const closesWork = ids.some(id => !jm.meta(id).improveFocus);
  if (config.settings.plugins.present.enabled && closesWork && suggestions.length) suggestions.unshift('hito cerrado: genera y audita la presentación con `present`');
  return suggestions;
}

export async function generateReport({ jm, config, ids, style, title, subtitle, open = false, atomicWriteDependencies } = {}) {
  if (!ids?.length) throw new Error('indica al menos un job_id');
  const styleName = style ?? config.settings.plugins.report.default_style;
  const styleDir = resolveStyle(config, styleName, { marker: '<!--COLMENA:CARDS-->' });
  const data = buildReportData(jm, ids, { title: title || undefined, subtitle });

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  let dir = path.join(config.reportsDir, `${stamp}-${slugify(data.title)}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(config.reportsDir, `${stamp}-${slugify(data.title)}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'data.json'), JSON.stringify(data, null, 2), atomicWriteDependencies);

  const out = path.join(dir, 'report.html');
  let reporterJob = null; let cost = 0; let reporterError = null;
  try {
    reporterJob = jm.submit({
      kind: 'report', task: `reporte: ${data.title}`, cwd: dir, worker: config.settings.roles.reporter,
      rawPrompt: reporterPrompt(styleDir, dir), workspace: { workdir: dir, readonly: false },
    });
    const w = await jm.wait([reporterJob], { timeoutS: 300 });
    if (w.pending.length) await jm.cancel(reporterJob);
    cost = jm.result(reporterJob).cost_usd ?? 0;
  } catch (e) { reporterError = e.message; }

  const valid = () => { try { const t = fs.readFileSync(out, 'utf8'); return t.length > 500 && /<html/i.test(t); } catch { return false; } };
  let usedFallback = false;
  if (!valid()) { writeFileAtomic(out, renderFallback(data, styleDir), atomicWriteDependencies); usedFallback = true; }

  if (open && process.platform === 'win32') { try { spawn('explorer.exe', [out], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best-effort */ } }
  const next = nextSuggestions(jm, ids, config);
  return { path: out, dir, style: styleName, usedFallback, reporterJob, cost_usd: cost, ...(next ? { next } : {}), ...(reporterError ? { reporterError } : {}) };
}
