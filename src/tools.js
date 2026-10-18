import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import YAML from 'yaml';
import { createJobManager } from './jobs.js';
import * as iso from './isolation.js';
import { notifyPlugin } from './plugins/notify.js';
import { createNotifier } from './notifier.js';
import { generateReport, pruneReportDirs } from './plugins/report.js';
import { generatePresentation } from './plugins/present.js';
import { computeStats, DAY_MS } from './stats.js';
import { buildImprovePrompt, hasRecentImprove, PENDING_FOCUSES, CONTINUOUS_IMPROVEMENT_PROMPT } from './plugins/improve.js';
import { createWidgetController } from './plugins/widget.js';
import { writeFileAtomic } from './atomic-write.js';
import { TERMINAL } from './job-states.js';
import { MixWeights, ProfileProvider } from './settings.js';
import { runDoctor } from './doctor.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json');

const isolationEnum = z.enum(['worktree', 'inplace', 'readonly']).optional()
  .describe('worktree (defecto en repos git: rama colmena/<id> aislada) | inplace (edita el directorio) | readonly (solo lectura)');
const detailEnum = z.enum(['min', 'normal', 'full']).optional().describe('min (defecto, ~300 tokens) | normal | full');
const timeoutSShape = z.number().min(1).max(1800).optional()
  .describe('segundos de espera (1 a 1800; se recorta al máximo configurado defaults.wait_max_s, defecto 600)');

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
    preferences: changedFields(before.preferences, after.preferences),
    profiles: changedFields(before.profiles, after.profiles),
    providers: changedFields(before.providers, after.providers),
    plugins: changedFields(before.plugins, after.plugins),
    standards: changedFields(before.standards, after.standards),
    worktree: changedFields(before.worktree, after.worktree),
  };
}

function editConfig(config, edit, atomicWriteDependencies) {
  const file = config.settingsPath ?? path.join(config.home, 'colmena.yml');
  const exists = fs.existsSync(file);
  const document = exists
    ? YAML.parseDocument(fs.readFileSync(file, 'utf8'))
    : new YAML.Document({});
  if (document.errors.length) throw new Error(`no se pudo actualizar preferences en ${file}: ${document.errors[0].message}`);
  if (document.contents == null) document.contents = document.createNode({});
  edit(document);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, document.toString(), atomicWriteDependencies);
}

const saveProfileShape = z.union([
  z.object({ name: z.string().min(1), mix: MixWeights }).strict(),
  z.object({ name: z.string().min(1), provider: ProfileProvider }).strict(),
]);

const taskShape = {
  task: z.string().min(1).describe('Brief claro y autocontenido: objetivo, archivos, criterio de aceptación. El agente no ve esta conversación.'),
  cwd: z.string().optional().describe('Directorio del proyecto (defecto: cwd del servidor)'),
  worker: z.string().optional().describe('Alias de worker de colmena.yml (ver tool workers). Si se omite, respeta preferences.profile (o preferences.provider) y aplica kind, defaults.worker compatible y prioridad'),
  kind: z.string().optional().describe('Tipo de tarea (code, docs, refactor, tests...) para que el router prefiera workers con esa fortaleza'),
  isolation: isolationEnum,
  context_files: z.array(z.string()).optional().describe('Rutas que el agente debe leer primero'),
  handoff_from: z.array(z.string()).optional().describe('job_ids cuyos resúmenes se inyectan como contexto'),
  skills: z.enum(['on', 'off']).optional().describe('on (defecto): skills disponibles | off: el prompt ordena ignorar skills y en OpenCode se desactiva la carga de .claude/skills; Codex no ofrece un interruptor global, así que solo aplica el prompt'),
};

export function buildServer(config, { atomicWriteDependencies, widgetDependencies } = {}) {
  const jm = createJobManager(config);
  const nc = config.settings.plugins.notify;
  const notify = notifyPlugin({ bus: jm.bus, jm, cfg: nc, notifier: createNotifier(config.notifier), logPath: config.activityPath });
  jm.recoverOrphans();
  const server = new McpServer({ name: 'colmena', version: packageVersion });

  const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const fail = e => ({ isError: true, content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }] });
  const tool = (name, description, shape, fn) =>
    server.registerTool(name, { description, inputSchema: shape }, async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } });

  const toSpec = a => {
    const cwd = a.cwd ?? process.cwd();
    return { task: a.task, worker: a.worker, taskKind: a.kind, cwd, isolation: a.isolation ?? (iso.isGitRepo(cwd) ? 'worktree' : 'inplace'), contextFiles: a.context_files, handoff: a.handoff_from, skills: a.skills };
  };
  const terminalMeta = id => { const m = jm.meta(id); if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}`); return m; };
  const countsForProfile = name => {
    const mix = config.settings.profiles[name]?.mix;
    if (!mix) return {};
    const counts = jm.allocationCounts(name);
    return Object.fromEntries(Object.keys(mix).map(alias => [alias, counts[alias] ?? 0]));
  };
  const profilesForTool = () => Object.fromEntries(Object.entries(config.settings.profiles).map(([name, profile]) => [
    name, profile.mix ? { mix: profile.mix, assignments: countsForProfile(name) } : { provider: profile.provider },
  ]));
  const preferenceResult = (selection, note) => {
    const active = config.settings.preferences.profile ?? null;
    return {
      provider: config.settings.preferences.provider,
      profile: active,
      profiles: profilesForTool(),
      assignments: active ? countsForProfile(active) : {},
      worker: selection?.alias ?? null,
      would_choose: selection?.alias ?? null,
      ...(selection?.note || note ? { note: [selection?.note, note].filter(Boolean).join('; ') } : {}),
    };
  };

  tool('workers', 'Lista los workers de colmena.yml con prioridad, fortalezas, preferencia, participación del perfil activo, gasto del mes, reservas de jobs vivos, presupuesto restante y disponibilidad. Úsalo para decidir a quién delegar.', {}, () => jm.workers());

  tool('doctor', 'Verificación previa sin gastar llamadas ni lanzar agentes: revisa Node, git, binarios de Codex/OpenCode resueltos, colmena.yml cargado, COLMENA_HOME escribible, ejecutable del widget (warn) y locks obsoletos de usage.json. Devuelve ok y checks con instrucciones accionables.', {}, () => runDoctor(config));

  const widget = createWidgetController({ home: config.home, ...widgetDependencies });
  const widgetTool = tool('widget', 'Agrega el widget animado al escritorio, consulta su estado o ciérralo. El ejecutable y COLMENA_HOME se resuelven desde la configuración del servidor.',
    { action: z.enum(['start', 'stop', 'status']).describe('start inicia el widget | status consulta el proceso | stop cierra el widget') },
    ({ action }) => widget[action]());
  if (!config.settings.plugins.widget.enabled) widgetTool.disable();

  tool('preferences', 'Consulta o cambia en caliente el proveedor o perfil activo, y crea o actualiza perfiles guardándolos en colmena.yml.',
    {
      provider: ProfileProvider.optional().describe('auto conserva el ruteo actual; codex u opencode priorizan ese proveedor'),
      profile: z.string().min(1).optional().describe('Nombre de un perfil existente que quedará activo para los siguientes run'),
      save_profile: saveProfileShape.optional().describe('Crea o actualiza un perfil con una mezcla ponderada o un proveedor preferido'),
    },
    ({ provider, profile, save_profile }) => {
      const nextProfiles = { ...config.settings.profiles };
      const savedDefinition = save_profile && (save_profile.mix ? { mix: save_profile.mix } : { provider: save_profile.provider });
      if (save_profile?.mix) {
        const missing = Object.keys(save_profile.mix).find(alias => !Object.hasOwn(config.settings.workers, alias));
        if (missing) throw new Error(`profiles.${save_profile.name}.mix: worker '${missing}' no existe (workers: ${Object.keys(config.settings.workers).join(', ')})`);
      }
      if (save_profile) nextProfiles[save_profile.name] = savedDefinition;
      if (profile !== undefined && !Object.hasOwn(nextProfiles, profile)) throw new Error(`preferences.profile: perfil '${profile}' no existe (profiles: ${Object.keys(nextProfiles).join(', ') || 'ninguno'})`);

      const changedPreferences = provider !== undefined || profile !== undefined;
      if (save_profile || changedPreferences) {
        editConfig(config, document => {
          if (save_profile) document.setIn(['profiles', save_profile.name], savedDefinition);
          if (provider !== undefined) document.setIn(['preferences', 'provider'], provider);
          if (profile !== undefined) document.setIn(['preferences', 'profile'], profile);
        }, atomicWriteDependencies);
        config.settings = {
          ...config.settings,
          profiles: nextProfiles,
          preferences: {
            ...config.settings.preferences,
            ...(provider !== undefined ? { provider } : {}),
            ...(profile !== undefined ? { profile } : {}),
          },
        };
      }
      let selection;
      try { selection = jm.routeWorker(); } catch (error) {
        const message = error?.message ?? String(error);
        return {
          ...preferenceResult(null, `${changedPreferences ? 'preferencia guardada; ' : ''}el router no pudo calcular qué worker elegir: ${message}`),
          ...(save_profile ? { saved_profile: save_profile.name } : {}),
        };
      }
      return { ...preferenceResult(selection), ...(save_profile ? { saved_profile: save_profile.name } : {}) };
    });

  const reportTool = tool('report', 'Genera un reporte HTML bonito de lo logrado por los jobs indicados (ronda final). El worker del rol reporter lo redacta con el estilo elegido (defecto papercraft); si falla, se usa un renderizador de respaldo. Devuelve la ruta del HTML.',
    { job_ids: z.array(z.string()).min(1), style: z.string().optional().describe('Nombre de estilo (carpeta styles/<nombre>); defecto: plugins.report.default_style'), title: z.string().optional(), subtitle: z.string().optional(), open: z.boolean().optional().describe('Abrir en el navegador al terminar') },
    a => generateReport({ jm, config, ids: a.job_ids, style: a.style, title: a.title, subtitle: a.subtitle, open: a.open, atomicWriteDependencies }));
  if (!config.settings.plugins.report.enabled) reportTool.disable();

  const presentTool = tool('present', 'Genera una presentación HTML autocontenida en estilo papercraft para cerrar un hito; el rol presenter la redacta y, si falla, se crea un respaldo determinista.',
    {
      job_ids: z.array(z.string()).min(1), title: z.string().optional(), subtitle: z.string().optional(),
      notes: z.string().optional().describe('Objetivo del hito, decisiones y riesgos del orquestador'),
      style: z.string().optional().describe('Nombre de estilo (carpeta styles/<nombre>); defecto: plugins.present.default_style'),
      open: z.boolean().optional().describe('Abrir en el navegador al terminar'),
    },
    a => generatePresentation({ jm, config, ids: a.job_ids, title: a.title, subtitle: a.subtitle, notes: a.notes, style: a.style, open: a.open, atomicWriteDependencies }));
  if (!config.settings.plugins.present.enabled) presentTool.disable();

  const improveTool = tool('improve', 'Mejora continua: un agente analiza el repo en un worktree y escribe docs/backlog/<fecha>-<focus>.md con ítems priorizados (impacto, esfuerzo, riesgo) y briefs listos para delegar con TDD y DRY.',
    {
      cwd: z.string().optional().describe('Repositorio a analizar (defecto: cwd del servidor)'),
      focus: z.enum(['backlog', 'features', 'debt', 'all']).optional().describe('backlog (pendientes) | features (nuevas) | debt (deuda técnica) | all (defecto)'),
      worker: z.string().optional().describe('Alias de worker; sin él, el router elige con kind docs'),
    },
    a => {
      const focus = a.focus ?? 'all';
      const id = jm.submit({
        task: buildImprovePrompt(focus), taskKind: 'docs', worker: a.worker,
        cwd: a.cwd ?? process.cwd(), isolation: 'worktree',
      });
      jm.mark(id, { improveFocus: focus });
      return { job_id: id, ...jm.status(id) };
    });
  if (!config.settings.plugins.improve.enabled) improveTool.disable();

  const improvePrompt = server.registerPrompt('continuous-improvement',
    { title: 'Mejora continua', description: 'Ronda completa de colmena: workers → run_many → wait → review → verdict → merge → report → improve.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: CONTINUOUS_IMPROVEMENT_PROMPT } }] }));
  if (!config.settings.plugins.improve.enabled) improvePrompt.disable();

  tool('reload_config', 'Vuelve a leer y validar colmena.yml. Los jobs existentes conservan su configuración; los siguientes usan la nueva.', {}, () => {
    const previous = config.settings;
    const next = config.reloadSettings();
    notify.update(next.plugins.notify);
    if (next.plugins.widget.enabled) widgetTool.enable(); else widgetTool.disable();
    if (next.plugins.report.enabled) reportTool.enable(); else reportTool.disable();
    if (next.plugins.present.enabled) presentTool.enable(); else presentTool.disable();
    if (next.plugins.improve.enabled) { improveTool.enable(); improvePrompt.enable(); } else { improveTool.disable(); improvePrompt.disable(); }
    return settingsDiff(previous, next);
  });

  tool('run', 'Lanza un agente obrero (según perfil o proveedor preferido, disponibilidad, kind y prioridad; worker explícito siempre manda). Devuelve job_id; con wait=true espera el reporte (hasta timeout_s).',
    { ...taskShape, wait: z.boolean().optional(), timeout_s: timeoutSShape },
    async a => {
      const id = jm.submit(toSpec(a));
      if (!a.wait) return { job_id: id, ...jm.status(id) };
      const w = await jm.wait([id], { timeoutS: a.timeout_s ?? 120 });
      return w.done[0] ?? { job_id: id, ...w.pending[0] };
    });

  tool('run_many', 'Lanza varios agentes en paralelo (tope COLMENA_MAX_PARALLEL simultáneos, el resto en cola). Con wait:true espera la ronda (mismo tope defaults.wait_max_s que wait) y devuelve { done, pending } con los reportes, sin cancelar al vencer.',
    { tasks: z.array(z.object(taskShape)).min(1).max(20), wait: z.boolean().optional(), timeout_s: timeoutSShape },
    async ({ tasks, wait, timeout_s }) => {
      const submitted = tasks.map(t => { try { return { job_id: jm.submit(toSpec(t)) }; } catch (e) { return { error: e.message }; } });
      if (!wait) return submitted;
      const ids = submitted.filter(s => s.job_id).map(s => s.job_id);
      return jm.wait(ids, { timeoutS: timeout_s ?? 120 });
    });

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
  const improveHint = id => {
    const { enabled, hints } = config.settings.plugins.improve;
    if (!enabled || !hints) return undefined;
    const cwd = jm.meta(id).cwd;
    if (hasRecentImprove(jm, cwd)) return undefined;
    return `todos terminaron: sin improve en las últimas 24 h para ${cwd}; considera \`improve\` (${PENDING_FOCUSES.join(', ')})`;
  };

  tool('wait', 'Espera a uno o todos los jobs (máx configurable defaults.wait_max_s, defecto 600 s, tope 1800 s) y devuelve reportes compactos; al vencer devuelve pending con estado y progreso sin cancelar; si la ronda terminó, añade un hint de mejora continua.',
    { job_ids: z.array(z.string()).min(1), timeout_s: timeoutSShape, mode: z.enum(['any', 'all']).optional() },
    async a => {
      const w = await jm.wait(a.job_ids, { mode: a.mode ?? 'all', timeoutS: a.timeout_s ?? 120 });
      const hint = w.pending.length ? undefined : improveHint(a.job_ids[0]);
      return hint ? { ...w, hint } : w;
    });
  tool('result', 'Reporte compacto (RESULT/FILES/TESTS/RISKS), archivos tocados y rama.', { job_id: z.string(), detail: detailEnum }, a => jm.result(a.job_id, { detail: a.detail ?? 'min' }));

  tool('diff', 'Diff del trabajo (truncado; el completo queda en disco). Si el job cambió de rama, avisa y usa el commit real.', { job_id: z.string(), max_chars: z.number().optional() }, a => {
    const m = jm.meta(a.job_id);
    const max = a.max_chars ?? 6000;
    let full = iso.diff(m.workdir, m.base, 50_000_000);
    const bm = m.branchMismatch;
    if (bm && !full.text.trim() && bm.headCommit && bm.headCommit !== m.base) full = iso.diffCommits(m.workdir, m.base, bm.headCommit, 50_000_000);
    const d = { text: full.text.slice(0, max), truncated: full.text.length > max };
    const out = { text: d.text, truncated: d.truncated };
    if (bm) out.warning = `el job cambió de rama (esperada ${bm.expected}, actual ${bm.actual}); diff desde el commit real ${String(bm.headCommit).slice(0, 12)}`;
    if (d.truncated) { const f = path.join(jm.jobDir(a.job_id), 'diff.patch'); writeFileAtomic(f, full.text, atomicWriteDependencies); out.fullPath = f; }
    return out;
  });

  tool('continue', 'Reanuda la sesión de un agente con un mensaje de seguimiento (mismo workdir).', { job_id: z.string(), message: z.string().min(1) }, a => ({ job_id: jm.continueJob(a.job_id, a.message) }));
  tool('retry', 'Relanza un job terminal con su brief original completo (brief.md) o con task nuevo; conserva cwd y workspace, usa worker explícito o sustituye uno retirado por router, y guarda parentId.',
    {
      job_id: z.string(),
      task: z.string().min(1).optional().describe('Brief nuevo; sin él se reutiliza el brief.md íntegro del job'),
      worker: z.string().min(1).optional().describe('Alias explícito; si falta y el worker original ya no existe o está deshabilitado, el router elige otro disponible'),
    },
    a => ({ job_id: jm.retry(a.job_id, a.task, a.worker) }));
  tool('summarize', 'Un agente (rol summarizer) resume la sesión de un job.', { job_id: z.string(), focus: z.string().optional() }, a => ({ job_id: jm.summarize(a.job_id, a.focus) }));
  tool('compact', 'Comprime la sesión de un job en un brief de relevo (summary.md) reutilizable con handoff.', { job_id: z.string() }, a => ({ job_id: jm.compact(a.job_id) }));
  tool('review', 'Revisión en solo lectura de los cambios de un job (o de un cwd).', { job_id: z.string().optional(), cwd: z.string().optional(), focus: z.string().optional() }, a => {
    if (!a.job_id && !a.cwd) throw new Error('indica job_id o cwd');
    return { job_id: jm.review({ id: a.job_id, cwd: a.cwd, focus: a.focus }) };
  });
  tool('verdict', 'Registra el veredicto humano del orquestador sobre un job ya revisado con review/diff: accepted o needs_work. Solo esta llamada lo cambia; no se infiere del estado done. stats lo separa por worker.',
    {
      job_id: z.string(),
      verdict: z.enum(['accepted', 'needs_work']).describe('accepted: el resultado satisface el brief | needs_work: requiere correcciones'),
      note: z.string().optional().describe('Motivo corto del veredicto'),
    },
    a => jm.verdict(a.job_id, { verdict: a.verdict, note: a.note }));
  tool('cancel', 'Cancela un job (mata el árbol de procesos).', { job_id: z.string() }, a => jm.cancel(a.job_id));

  tool('merge', 'Fusiona la rama colmena/<id> del job en la rama actual de su cwd. Manual: revisa antes con diff/review y registra el veredicto con verdict. Se niega si el destino tiene cambios sin commitear. Si el job cambió de rama, avisa y fusiona el commit real del worktree.',
    { job_id: z.string(), strategy: z.enum(['merge', 'squash']).optional(), force: z.boolean().optional().describe('fusiona aunque el job no tenga veredicto registrado') },
    a => {
      const m = terminalMeta(a.job_id);
      if (!m.branch) throw new Error('este job no usó worktree; no hay rama que fusionar');
      if (!a.force && !m.verdict) throw new Error(`job ${a.job_id} sin veredicto: llama verdict o repite con force:true`);
      iso.commitAll(m.workdir, `luna: ${a.job_id}`);
      let source = m.branch;
      if (m.branchMismatch) {
        const head = iso.headRef(m.workdir);
        source = head && head.branch !== 'HEAD' ? head.branch : (head?.commit ?? m.branchMismatch.headCommit ?? m.branch);
      }
      const res = iso.merge(m.cwd, source, a.strategy ?? 'merge');
      if (res.ok) jm.mark(a.job_id, { merged: true });
      const out = m.verdict ? { ...res, verdict: m.verdict, verdictAt: m.verdictAt } : res;
      return m.branchMismatch
        ? { ...out, warning: `el job cambió de rama (esperada ${m.branchMismatch.expected}, actual ${m.branchMismatch.actual}); se fusionó ${source}` }
        : out;
    });

  tool('cleanup', 'Elimina worktrees y ramas colmena/* creados por este servidor (de un job, o más viejos que N días). Con older_than_days y force purga además las carpetas de jobs terminales (done/failed/cancelled/orphaned) terminados antes del umbral y las carpetas de $COLMENA_HOME/reports/ (reportes y decks) anteriores al umbral; los no terminales, vivos y lo reciente nunca se borran.',
    { job_id: z.string().optional(), older_than_days: z.number().optional(), force: z.boolean().optional().describe('necesario para descartar trabajo no fusionado y purgar jobs y reports antiguos') },
    a => {
      if (!a.job_id && a.older_than_days == null) throw new Error('indica job_id u older_than_days');
      if (a.job_id) {
        const m = terminalMeta(a.job_id);
        if (m.branch && !m.merged && !a.force && !iso.isMerged(m.cwd, m.branch, m.base)) throw new Error(`job ${a.job_id} no fusionado: su trabajo se perdería; usa merge o force:true`);
      } else if (!a.force) throw new Error('older_than_days puede descartar trabajo no fusionado; repite con force:true');
      const result = iso.cleanup(config, { id: a.job_id, olderThanDays: a.older_than_days });
      const jobsRemoved = a.older_than_days == null ? [] : jm.pruneTerminalJobs({ olderThanDays: a.older_than_days, id: a.job_id });
      const reportsRemoved = a.older_than_days == null || !a.force ? [] : pruneReportDirs(config, { olderThanDays: a.older_than_days });
      return { ...result, jobsRemoved, reportsRemoved };
    });

  return { server, jm, notify };
}
