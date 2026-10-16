import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createJobManager } from './jobs.js';
import * as iso from './isolation.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);
const isolationEnum = z.enum(['worktree', 'inplace', 'readonly']).optional()
  .describe('worktree (defecto en repos git: rama luna/<id> aislada) | inplace (edita el directorio) | readonly (solo lectura)');
const detailEnum = z.enum(['min', 'normal', 'full']).optional().describe('min (defecto, ~300 tokens) | normal | full');

const taskShape = {
  task: z.string().min(1).describe('Brief claro y autocontenido: objetivo, archivos, criterio de aceptación. Luna no ve esta conversación.'),
  cwd: z.string().optional().describe('Directorio del proyecto (defecto: cwd del servidor)'),
  isolation: isolationEnum,
  context_files: z.array(z.string()).optional().describe('Rutas que el agente debe leer primero'),
  handoff_from: z.array(z.string()).optional().describe('job_ids cuyos resúmenes se inyectan como contexto'),
};

export function buildServer(config) {
  const jm = createJobManager(config);
  jm.recoverOrphans();
  const server = new McpServer({ name: 'luna', version: '0.1.0' });

  const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const fail = e => ({ isError: true, content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }] });
  const tool = (name, description, shape, fn) =>
    server.registerTool(name, { description, inputSchema: shape }, async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } });

  const toSpec = a => {
    const cwd = a.cwd ?? process.cwd();
    return { task: a.task, cwd, isolation: a.isolation ?? (iso.isGitRepo(cwd) ? 'worktree' : 'inplace'), contextFiles: a.context_files, handoff: a.handoff_from };
  };
  const terminalMeta = id => { const m = jm.meta(id); if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}`); return m; };

  tool('luna_run', 'Lanza un agente Luna (gpt-6-luna, esfuerzo max, sin aprobaciones, con internet). Devuelve job_id; con wait=true espera el reporte (hasta timeout_s).',
    { ...taskShape, wait: z.boolean().optional(), timeout_s: z.number().optional() },
    async a => {
      const id = jm.submit(toSpec(a));
      if (!a.wait) return { job_id: id, ...jm.status(id) };
      const w = await jm.wait([id], { timeoutS: a.timeout_s ?? 120 });
      return w.done[0] ?? { job_id: id, ...w.pending[0] };
    });

  tool('luna_run_many', 'Lanza varios agentes Luna en paralelo (tope LUNA_MAX_PARALLEL simultáneos, el resto en cola).',
    { tasks: z.array(z.object(taskShape)).min(1).max(20) },
    async ({ tasks }) => tasks.map(t => { try { return { job_id: jm.submit(toSpec(t)) }; } catch (e) { return { error: e.message }; } }));

  tool('luna_handoff', 'Lanza un agente nuevo con el resumen de otros agentes como contexto.',
    { ...taskShape, from: z.array(z.string()).min(1) },
    async a => ({ job_id: jm.submit(toSpec({ ...a, handoff_from: [...(a.handoff_from ?? []), ...a.from] })) }));

  tool('luna_status', 'Estado de un job.', { job_id: z.string() }, a => jm.status(a.job_id));
  tool('luna_list', 'Lista jobs recientes.', { state: z.string().optional(), limit: z.number().optional() }, a => jm.list({ state: a.state, limit: a.limit ?? 15 }));
  tool('luna_wait', 'Espera a uno o todos los jobs (máx 600 s) y devuelve reportes compactos.',
    { job_ids: z.array(z.string()).min(1), timeout_s: z.number().optional(), mode: z.enum(['any', 'all']).optional() },
    a => jm.wait(a.job_ids, { mode: a.mode ?? 'all', timeoutS: a.timeout_s ?? 120 }));
  tool('luna_result', 'Reporte compacto (RESULT/FILES/TESTS/RISKS), archivos tocados y rama.', { job_id: z.string(), detail: detailEnum }, a => jm.result(a.job_id, { detail: a.detail ?? 'min' }));

  tool('luna_diff', 'Diff del trabajo (truncado; el completo queda en disco).', { job_id: z.string(), max_chars: z.number().optional() }, a => {
    const m = jm.meta(a.job_id);
    const max = a.max_chars ?? 6000;
    const full = iso.diff(m.workdir, m.base, 50_000_000);
    const d = { text: full.text.slice(0, max), truncated: full.text.length > max };
    const out = { text: d.text, truncated: d.truncated };
    if (d.truncated) { const f = path.join(jm.jobDir(a.job_id), 'diff.patch'); fs.writeFileSync(f, full.text); out.fullPath = f; }
    return out;
  });

  tool('luna_continue', 'Reanuda la sesión de un agente con un mensaje de seguimiento (mismo workdir).', { job_id: z.string(), message: z.string().min(1) }, a => ({ job_id: jm.continueJob(a.job_id, a.message) }));
  tool('luna_summarize', 'Un agente Luna (solo lectura) resume la sesión de un job.', { job_id: z.string(), focus: z.string().optional() }, a => ({ job_id: jm.summarize(a.job_id, a.focus) }));
  tool('luna_compact', 'Comprime la sesión de un job en un brief de relevo (summary.md) reutilizable con handoff.', { job_id: z.string() }, a => ({ job_id: jm.compact(a.job_id) }));
  tool('luna_review', 'Revisión en solo lectura de los cambios de un job (o de un cwd).', { job_id: z.string().optional(), cwd: z.string().optional(), focus: z.string().optional() }, a => {
    if (!a.job_id && !a.cwd) throw new Error('indica job_id o cwd');
    return { job_id: jm.review({ id: a.job_id, cwd: a.cwd, focus: a.focus }) };
  });
  tool('luna_cancel', 'Cancela un job (mata el árbol de procesos).', { job_id: z.string() }, a => jm.cancel(a.job_id));

  tool('luna_merge', 'Fusiona la rama luna/<id> del job en la rama actual de su cwd. Manual: revisa antes con luna_diff/luna_review. Se niega si el destino tiene cambios sin commitear.',
    { job_id: z.string(), strategy: z.enum(['merge', 'squash']).optional() },
    a => {
      const m = terminalMeta(a.job_id);
      if (!m.branch) throw new Error('este job no usó worktree; no hay rama que fusionar');
      iso.commitAll(m.workdir, `luna: ${a.job_id}`);
      const res = iso.merge(m.cwd, m.branch, a.strategy ?? 'merge');
      if (res.ok) jm.mark(a.job_id, { merged: true });
      return res;
    });

  tool('luna_cleanup', 'Elimina worktrees y ramas luna/* creados por este servidor (de un job, o más viejos que N días).',
    { job_id: z.string().optional(), older_than_days: z.number().optional(), force: z.boolean().optional().describe('necesario para descartar trabajo no fusionado') },
    a => {
      if (!a.job_id && a.older_than_days == null) throw new Error('indica job_id u older_than_days');
      if (a.job_id) {
        const m = terminalMeta(a.job_id);
        if (m.branch && !m.merged && !a.force) throw new Error(`job ${a.job_id} no fusionado: su trabajo se perdería; usa luna_merge o force:true`);
      } else if (!a.force) throw new Error('older_than_days puede descartar trabajo no fusionado; repite con force:true');
      return iso.cleanup(config, { id: a.job_id, olderThanDays: a.older_than_days });
    });

  return { server, jm };
}
