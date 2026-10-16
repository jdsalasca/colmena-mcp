import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createJobManager } from './jobs.js';
import * as iso from './isolation.js';
import { notifyPlugin } from './plugins/notify.js';
import { createNotifier } from './notifier.js';
import { generateReport } from './plugins/report.js';
import { computeStats, DAY_MS } from './stats.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);
const isolationEnum = z.enum(['worktree', 'inplace', 'readonly']).optional()
  .describe('worktree (defecto en repos git: rama colmena/<id> aislada) | inplace (edita el directorio) | readonly (solo lectura)');
const detailEnum = z.enum(['min', 'normal', 'full']).optional().describe('min (defecto, ~300 tokens) | normal | full');

const changedFields = (before = {}, after = {}, prefix = '') => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .flatMap(key => {
    const oldValue = before[key]; const nextValue = after[key];
    const field = prefix ? `${prefix}.${key}` : key;
    const oldRecord = oldValue && typeof oldValue === 'object' && !Array.isArray(oldValue);
    const nextRecord = nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue);
    if ((oldRecord || oldValue == null) && (nextRecord || nextValue == null) && (oldRecord || nextRecord)) {
      return changedFields(oldRecord ? oldValue : {}, nextRecord ? nextValue : {}, field);
    }
    return JSON.stringify(oldValue) === JSON.stringify(nextValue) ? [] : [field];
  }).sort();

function settingsDiff(before, after) {
  const aliases = [...new Set([...Object.keys(before.workers), ...Object.keys(after.workers)])].sort();
  return {
    added: aliases.filter(alias => !before.workers[alias]),
    removed: aliases.filter(alias => !after.workers[alias]),
    changed: aliases.filter(alias => before.workers[alias] && after.workers[alias])
      .map(alias => ({ alias, fields: changedFields(before.workers[alias], after.workers[alias]) }))
      .filter(worker => worker.fields.length),
    roles: changedFields(before.roles, after.roles),
    defaults: changedFields(before.defaults, after.defaults),
    providers: changedFields(before.providers, after.providers),
  };
}

const taskShape = {
  task: z.string().min(1).describe('Brief claro y autocontenido: objetivo, archivos, criterio de aceptación. El agente no ve esta conversación.'),
  cwd: z.string().optional().describe('Directorio del proyecto (defecto: cwd del servidor)'),
  worker: z.string().optional().describe('Alias de worker de colmena.yml (ver tool workers). Si se omite, el router elige: defaults.worker o el siguiente con presupuesto'),
  kind: z.string().optional().describe('Tipo de tarea (code, docs, refactor, tests...) para que el router prefiera workers con esa fortaleza'),
  isolation: isolationEnum,
  context_files: z.array(z.string()).optional().describe('Rutas que el agente debe leer primero'),
  handoff_from: z.array(z.string()).optional().describe('job_ids cuyos resúmenes se inyectan como contexto'),
};

export function buildServer(config) {
  const jm = createJobManager(config);
  jm.recoverOrphans();
  const nc = config.settings.plugins.notify;
  const notify = notifyPlugin({ bus: jm.bus, jm, cfg: nc, notifier: createNotifier(config.notifier), logPath: config.activityPath });
  const server = new McpServer({ name: 'colmena', version: '0.2.0' });

  const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const fail = e => ({ isError: true, content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }] });
  const tool = (name, description, shape, fn) =>
    server.registerTool(name, { description, inputSchema: shape }, async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } });

  const toSpec = a => {
    const cwd = a.cwd ?? process.cwd();
    return { task: a.task, worker: a.worker, taskKind: a.kind, cwd, isolation: a.isolation ?? (iso.isGitRepo(cwd) ? 'worktree' : 'inplace'), contextFiles: a.context_files, handoff: a.handoff_from };
  };
  const terminalMeta = id => { const m = jm.meta(id); if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}`); return m; };

  tool('workers', 'Lista los workers de colmena.yml con prioridad, fortalezas, gasto del mes, presupuesto restante y disponibilidad. Úsalo para decidir a quién delegar.', {}, () => jm.workers());

  const reportTool = tool('report', 'Genera un reporte HTML bonito de lo logrado por los jobs indicados (ronda final). El worker del rol reporter lo redacta con el estilo elegido (defecto papercraft); si falla, se usa un renderizador de respaldo. Devuelve la ruta del HTML.',
    { job_ids: z.array(z.string()).min(1), style: z.string().optional().describe('Nombre de estilo (carpeta styles/<nombre>); defecto: plugins.report.default_style'), title: z.string().optional(), subtitle: z.string().optional(), open: z.boolean().optional().describe('Abrir en el navegador al terminar') },
    a => generateReport({ jm, config, ids: a.job_ids, style: a.style, title: a.title, subtitle: a.subtitle, open: a.open }));
  if (!config.settings.plugins.report.enabled) reportTool.disable();

  tool('reload_config', 'Vuelve a leer y validar colmena.yml. Los jobs existentes conservan su configuración; los siguientes usan la nueva.', {}, () => {
    const previous = config.settings;
    const next = config.reloadSettings();
    notify.update(next.plugins.notify);
    if (next.plugins.report.enabled) reportTool.enable(); else reportTool.disable();
    return settingsDiff(previous, next);
  });

  tool('run', 'Lanza un agente obrero (Codex u OpenCode según el worker; sin aprobaciones, con internet). Devuelve job_id; con wait=true espera el reporte (hasta timeout_s).',
    { ...taskShape, wait: z.boolean().optional(), timeout_s: z.number().optional() },
    async a => {
      const id = jm.submit(toSpec(a));
      if (!a.wait) return { job_id: id, ...jm.status(id) };
      const w = await jm.wait([id], { timeoutS: a.timeout_s ?? 120 });
      return w.done[0] ?? { job_id: id, ...w.pending[0] };
    });

  tool('run_many', 'Lanza varios agentes en paralelo (tope COLMENA_MAX_PARALLEL simultáneos, el resto en cola).',
    { tasks: z.array(z.object(taskShape)).min(1).max(20) },
    async ({ tasks }) => tasks.map(t => { try { return { job_id: jm.submit(toSpec(t)) }; } catch (e) { return { error: e.message }; } }));

  tool('handoff', 'Lanza un agente nuevo con el resumen de otros agentes como contexto.',
    { ...taskShape, from: z.array(z.string()).min(1) },
    async a => ({ job_id: jm.submit(toSpec({ ...a, handoff_from: [...(a.handoff_from ?? []), ...a.from] })) }));

  tool('status', 'Estado de un job.', { job_id: z.string() }, a => jm.status(a.job_id));
  tool('list', 'Lista jobs recientes.', { state: z.string().optional(), limit: z.number().optional() }, a => jm.list({ state: a.state, limit: a.limit ?? 15 }));
  tool('stats', 'Resume el uso de colmena por worker, tipo de job, estado, duración, costo, tokens y fallos.',
    { since_days: z.number().nonnegative().optional().default(30).describe('Ventana histórica en días; defecto: 30') },
    ({ since_days }) => {
      const now = Date.now();
      return computeStats(jm.metas(), { sinceMs: now - since_days * DAY_MS, now });
    });
  tool('wait', 'Espera a uno o todos los jobs (máx 600 s) y devuelve reportes compactos.',
    { job_ids: z.array(z.string()).min(1), timeout_s: z.number().optional(), mode: z.enum(['any', 'all']).optional() },
    a => jm.wait(a.job_ids, { mode: a.mode ?? 'all', timeoutS: a.timeout_s ?? 120 }));
  tool('result', 'Reporte compacto (RESULT/FILES/TESTS/RISKS), archivos tocados y rama.', { job_id: z.string(), detail: detailEnum }, a => jm.result(a.job_id, { detail: a.detail ?? 'min' }));

  tool('diff', 'Diff del trabajo (truncado; el completo queda en disco).', { job_id: z.string(), max_chars: z.number().optional() }, a => {
    const m = jm.meta(a.job_id);
    const max = a.max_chars ?? 6000;
    const full = iso.diff(m.workdir, m.base, 50_000_000);
    const d = { text: full.text.slice(0, max), truncated: full.text.length > max };
    const out = { text: d.text, truncated: d.truncated };
    if (d.truncated) { const f = path.join(jm.jobDir(a.job_id), 'diff.patch'); fs.writeFileSync(f, full.text); out.fullPath = f; }
    return out;
  });

  tool('continue', 'Reanuda la sesión de un agente con un mensaje de seguimiento (mismo workdir).', { job_id: z.string(), message: z.string().min(1) }, a => ({ job_id: jm.continueJob(a.job_id, a.message) }));
  tool('summarize', 'Un agente (rol summarizer) resume la sesión de un job.', { job_id: z.string(), focus: z.string().optional() }, a => ({ job_id: jm.summarize(a.job_id, a.focus) }));
  tool('compact', 'Comprime la sesión de un job en un brief de relevo (summary.md) reutilizable con handoff.', { job_id: z.string() }, a => ({ job_id: jm.compact(a.job_id) }));
  tool('review', 'Revisión en solo lectura de los cambios de un job (o de un cwd).', { job_id: z.string().optional(), cwd: z.string().optional(), focus: z.string().optional() }, a => {
    if (!a.job_id && !a.cwd) throw new Error('indica job_id o cwd');
    return { job_id: jm.review({ id: a.job_id, cwd: a.cwd, focus: a.focus }) };
  });
  tool('cancel', 'Cancela un job (mata el árbol de procesos).', { job_id: z.string() }, a => jm.cancel(a.job_id));

  tool('merge', 'Fusiona la rama colmena/<id> del job en la rama actual de su cwd. Manual: revisa antes con diff/review. Se niega si el destino tiene cambios sin commitear.',
    { job_id: z.string(), strategy: z.enum(['merge', 'squash']).optional() },
    a => {
      const m = terminalMeta(a.job_id);
      if (!m.branch) throw new Error('este job no usó worktree; no hay rama que fusionar');
      iso.commitAll(m.workdir, `luna: ${a.job_id}`);
      const res = iso.merge(m.cwd, m.branch, a.strategy ?? 'merge');
      if (res.ok) jm.mark(a.job_id, { merged: true });
      return res;
    });

  tool('cleanup', 'Elimina worktrees y ramas colmena/* creados por este servidor (de un job, o más viejos que N días).',
    { job_id: z.string().optional(), older_than_days: z.number().optional(), force: z.boolean().optional().describe('necesario para descartar trabajo no fusionado') },
    a => {
      if (!a.job_id && a.older_than_days == null) throw new Error('indica job_id u older_than_days');
      if (a.job_id) {
        const m = terminalMeta(a.job_id);
        if (m.branch && !m.merged && !a.force) throw new Error(`job ${a.job_id} no fusionado: su trabajo se perdería; usa merge o force:true`);
      } else if (!a.force) throw new Error('older_than_days puede descartar trabajo no fusionado; repite con force:true');
      return iso.cleanup(config, { id: a.job_id, olderThanDays: a.older_than_days });
    });

  return { server, jm, notify };
}
