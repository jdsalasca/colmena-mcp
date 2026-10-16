import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { EventEmitter } from 'node:events';
import { startRun } from './runner.js';
import { getAdapter } from './providers/index.js';
import { createLedger } from './ledger.js';
import { chooseWorker, workerStatus } from './router.js';
import { buildPrompt, parseReport } from './report.js';
import * as iso from './isolation.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export function createJobManager(config, { bus = new EventEmitter() } = {}) {
  const store = createStore(config);
  const ledger = createLedger(config);

  function resolveWorker(alias) {
    const settings = config.settings;
    const workers = settings.workers;
    const name = alias ?? settings.defaults.worker;
    const w = workers[name];
    if (!w || w.enabled === false) {
      const avail = Object.keys(workers).filter(k => workers[k].enabled !== false);
      throw new Error(`worker '${name}' ${w ? 'está deshabilitado' : 'no existe'}; disponibles: ${avail.join(', ')}`);
    }
    return { name, ...w };
  }

  function costOf(w, usage) {
    if (typeof usage.cost_usd === 'number') return usage.cost_usd;
    const p = w?.price_per_mtok;
    if (!p) return 0;
    return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1e6;
  }
  const queue = [];
  const live = new Map();      // id -> { handle, cancelled, timedOut, timer }
  const finished = new Map();  // id -> { promise, resolve }
  let maxSeen = 0;

  const readFile = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const lastMessage = id => readFile(path.join(store.jobDir(id), 'last_message.md'));
  const need = id => { const m = store.get(id); if (!m) throw new Error(`job ${id} no existe`); return m; };

  function summaryText(id) {
    need(id);
    const t = readFile(path.join(store.jobDir(id), 'summary.md')) ?? lastMessage(id);
    if (!t) throw new Error(`job ${id} no tiene resultado todavía`);
    return t;
  }

  function submit(spec) {
    const handoffTexts = (spec.handoff ?? []).map(summaryText);
    if (spec.worker) resolveWorker(spec.worker); // unknown/disabled → clear error before touching anything
    const selection = chooseWorker(config.settings, ledger, { worker: spec.worker, kind: spec.taskKind });
    const worker = resolveWorker(selection.alias);
    const cwd = spec.cwd ?? process.cwd();
    const id = store.newId();
    const ws = spec.workspace ?? iso.prepare(config, { cwd, isolation: spec.isolation ?? 'inplace', id });
    const kind = spec.kind ?? 'run';
    const prompt = spec.rawPrompt ?? buildPrompt({
      task: spec.task, contextFiles: spec.contextFiles, handoff: handoffTexts, kind, standards: config.settings.standards, branch: ws.branch,
    });
    store.create({
      id, state: 'queued', kind, task: String(spec.task).slice(0, 300), cwd,
      isolation: spec.workspace ? 'reuse' : (spec.isolation ?? 'inplace'),
      workdir: ws.workdir, branch: ws.branch, base: ws.base, readonly: ws.readonly, warning: ws.warning,
      parentId: spec.parentId, resumeSessionId: spec.resumeSessionId, ephemeral: !!spec.ephemeral,
      worker: worker.name, provider: worker.provider, note: selection.note,
      owner: process.pid, createdAt: Date.now(),
    });
    store.audit({ id, kind, worker: worker.name, cwd, isolation: spec.isolation, briefHash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) });
    let resolve; const promise = new Promise(r => { resolve = r; });
    finished.set(id, { promise, resolve });
    queue.push({ id, prompt, worker, timeoutMin: config.timeoutMin, exitGraceS: config.exitGraceS });
    pump();
    return id;
  }

  function pump() {
    while (live.size < config.maxParallel && queue.length) start(queue.shift());
    maxSeen = Math.max(maxSeen, live.size);
  }

  function start({ id, prompt, worker, timeoutMin, exitGraceS }) {
    const meta = store.update(id, { state: 'running', startedAt: Date.now() });
    const dir = store.jobDir(id);
    const state = { cancelled: false, timedOut: false, delivered: false, hasFinalMessage: false, finishedByGrace: false, timer: null, graceTimer: null, handle: null };
    live.set(id, state);
    maxSeen = Math.max(maxSeen, live.size);
    let usage = {}; let lastText = ''; let lastSessionId;
    const adapter = getAdapter(worker.provider);
    const finishByGrace = message => {
      if (state.finishedByGrace) return;
      state.finishedByGrace = true;
      state.message = message;
      clearTimeout(state.graceTimer);
      handle.kill();
    };
    const handle = startRun(adapter.cmd(config), adapter.buildArgs({
      prompt, workdir: meta.workdir, lastMessagePath: path.join(dir, 'last_message.md'),
      readonly: meta.readonly, resumeSessionId: meta.resumeSessionId, ephemeral: meta.ephemeral, worker,
    }), {
      cwd: meta.workdir, logPath: path.join(dir, 'events.jsonl'), parseLine: adapter.parseLine,
      env: adapter.env?.(config),
      onEvent: e => {
        if (e.kind === 'session' && e.sessionId !== lastSessionId) { lastSessionId = e.sessionId; store.update(id, { sessionId: e.sessionId }); }
        else if (e.kind === 'message') { lastText = e.text; state.hasFinalMessage = true; }
        else if (e.kind === 'usage') {
          for (const [k, v] of Object.entries(e.usage)) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
          if (!state.delivered && state.hasFinalMessage && adapter.completesOn?.(e)) {
            state.delivered = true;
            state.graceTimer = setTimeout(() => finishByGrace(
              `El agente entregó su respuesta, pero el proceso no terminó dentro de la gracia de ${exitGraceS} s y fue finalizado.`,
            ), exitGraceS * 1000);
          }
        }
      },
    });
    state.handle = handle;
    store.update(id, { pid: handle.pid });
    state.timer = setTimeout(() => {
      if (state.delivered) finishByGrace('El agente ya había entregado su respuesta al alcanzar el timeout general; el proceso fue finalizado y el job se marcó done.');
      else { state.timedOut = true; handle.kill(); }
    }, timeoutMin * 60000);
    bus.emit('job.started', { id, worker: meta.worker, provider: meta.provider ?? 'desconocido', task: meta.task, kind: meta.kind });
    handle.done.then(r => finalize(id, meta, state, r, lastText, usage, worker, timeoutMin));
  }

  function finalize(id, meta, state, r, lastText, usage, worker, timeoutMin) {
    clearTimeout(state.timer);
    clearTimeout(state.graceTimer);
    live.delete(id);
    const dir = store.jobDir(id);
    let text = lastMessage(id);
    if (text == null && lastText) { text = lastText; fs.writeFileSync(path.join(dir, 'last_message.md'), text); }
    let patch = { endedAt: Date.now(), usage };
    if (state.cancelled) patch.state = 'cancelled';
    else if (state.finishedByGrace) Object.assign(patch, { state: 'done', finishedByGrace: true, message: state.message });
    else if (state.timedOut) Object.assign(patch, { state: 'failed', error: `timeout tras ${timeoutMin} min` });
    else if (r.code === 0) patch.state = 'done';
    else Object.assign(patch, { state: 'failed', error: `codex salió con código ${r.code}: ${r.stderrTail}`.slice(0, 1500) });
    if (patch.state === 'done' && meta.kind === 'compact' && meta.parentId && text) fs.writeFileSync(path.join(store.jobDir(meta.parentId), 'summary.md'), text);
    if (meta.kind === 'run' && !meta.readonly) {
      try { const ch = iso.changes(meta.workdir, meta.base); patch.files = ch.files; patch.diffstat = ch.diffstat; } catch {}
    }
    patch.costUsd = costOf(worker, usage);
    try { ledger.record(meta.worker, usage, patch.costUsd); } catch { /* bookkeeping must never break a job */ }
    const updated = store.update(id, patch);
    bus.emit('job.finished', { id, worker: meta.worker, provider: meta.provider ?? 'desconocido', kind: meta.kind, state: updated.state, task: meta.task, error: updated.error, ...(updated.message ? { message: updated.message } : {}), costUsd: patch.costUsd, usage, startedAt: updated.startedAt, endedAt: updated.endedAt });
    finished.get(id)?.resolve();
    pump();
  }

  function status(id) {
    const m = need(id);
    const end = m.endedAt ?? Date.now();
    return { id, state: m.state, kind: m.kind, worker: m.worker, elapsedS: Math.round((end - (m.startedAt ?? m.createdAt)) / 1000), task: (m.task ?? '').slice(0, 80), ...(m.branch ? { branch: m.branch } : {}), ...(m.note ? { note: m.note } : {}), ...(m.finishedByGrace ? { finishedByGrace: true } : {}), ...(m.message ? { message: m.message } : {}) };
  }

  function result(id, { detail = 'min' } = {}) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) return status(id);
    const text = lastMessage(id) ?? '';
    const out = { id, state: m.state, kind: m.kind, worker: m.worker, cost_usd: Number((m.costUsd ?? 0).toFixed(4)) };
    if (m.note) out.note = m.note;
    if (m.finishedByGrace) out.finishedByGrace = true;
    if (m.message) out.message = m.message;
    if (m.kind === 'run' || m.kind === 'review') {
      const rep = parseReport(text);
      out.reportOk = rep.ok;
      if (rep.ok) out.report = rep.sections; else out.text = rep.text;
    } else out.text = text.slice(0, 4000);
    if (m.files?.length) out.files = m.files.slice(0, 15);
    if (m.diffstat) out.diffstat = m.diffstat;
    if (m.branch) out.branch = m.branch;
    out.workdir = m.workdir;
    if (m.warning) out.warning = m.warning;
    if (m.error) out.error = m.error;
    if (detail !== 'min') {
      Object.assign(out, { sessionId: m.sessionId, usage: m.usage, jobDir: store.jobDir(id), eventsLog: path.join(store.jobDir(id), 'events.jsonl') });
      if (m.files?.length > 15) out.files = m.files;
    }
    if (detail === 'full') out.fullText = text;
    return out;
  }

  async function wait(ids, { mode = 'all', timeoutS = 120 } = {}) {
    ids.forEach(need);
    const t = Math.min(Math.max(timeoutS, 1), 600) * 1000;
    const ps = ids.map(id => finished.get(id)?.promise ?? Promise.resolve());
    const cond = mode === 'any' ? Promise.race(ps) : Promise.all(ps);
    let timer;
    await Promise.race([cond, new Promise(r => { timer = setTimeout(r, t); })]);
    clearTimeout(timer);
    const isTerm = id => TERMINAL.has(need(id).state);
    return { done: ids.filter(isTerm).map(id => result(id)), pending: ids.filter(id => !isTerm(id)).map(status) };
  }

  async function cancel(id) {
    const m = need(id);
    if (TERMINAL.has(m.state)) return status(id);
    const qi = queue.findIndex(q => q.id === id);
    if (qi >= 0) {
      queue.splice(qi, 1);
      store.update(id, { state: 'cancelled', endedAt: Date.now() });
      finished.get(id)?.resolve();
      return status(id);
    }
    const l = live.get(id);
    if (l) { l.cancelled = true; await l.handle.kill(); }
    return status(id);
  }

  function continueJob(id, message) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine`);
    if (!m.sessionId) throw new Error(`job ${id} no guardó session id; no se puede reanudar`);
    return submit({
      task: message, cwd: m.cwd, parentId: id, resumeSessionId: m.sessionId, kind: 'run', worker: m.worker,
      workspace: { workdir: m.workdir, branch: m.branch, base: m.base, readonly: m.readonly },
    });
  }

  const roleWorker = kind => config.settings.roles[kind === 'review' ? 'reviewer' : 'summarizer'];

  function helperJob(kind, id, rawPrompt) {
    const m = need(id);
    return submit({
      kind, task: `${kind} de ${id}`, cwd: m.cwd, parentId: id, rawPrompt, ephemeral: true, worker: roleWorker(kind),
      workspace: { workdir: kind === 'review' ? m.workdir : store.jobDir(id), readonly: true, base: m.base },
    });
  }

  function summarize(id, focus) {
    const d = store.jobDir(id);
    return helperJob('summarize', id, `Lee ${path.join(d, 'events.jsonl')} y ${path.join(d, 'last_message.md')}. Resume lo ocurrido en máximo 20 líneas, en español, sin código largo.${focus ? ` Enfócate en: ${focus}.` : ''}`);
  }

  function compact(id) {
    const d = store.jobDir(id);
    return helperJob('compact', id, `Lee ${path.join(d, 'events.jsonl')} y ${path.join(d, 'last_message.md')}. Escribe un brief de relevo de máximo 40 líneas, en español, para que otro agente continúe sin leer el log: objetivo, decisiones tomadas, archivos tocados, estado actual y pendientes. Responde solo con el brief.`);
  }

  function review({ id, cwd, focus }) {
    if (id) {
      const m = need(id);
      const how = m.base ? `git diff ${m.base}` : 'git diff HEAD y git status';
      return helperJob('review', id, buildPrompt({ kind: 'review', task: `Revisa en modo solo lectura los cambios de este directorio (${how}). Busca bugs, regresiones y pruebas faltantes.${focus ? ` Foco: ${focus}.` : ''} No modifiques archivos.` }));
    }
    return submit({
      kind: 'review', task: 'review de cwd', cwd, ephemeral: true, worker: roleWorker('review'),
      workspace: { workdir: cwd, readonly: true },
      rawPrompt: buildPrompt({ kind: 'review', task: `Revisa en modo solo lectura los cambios pendientes (git diff HEAD y git status). Busca bugs, regresiones y pruebas faltantes.${focus ? ` Foco: ${focus}.` : ''} No modifiques archivos.` }),
    });
  }

  function recoverOrphans() {
    for (const m of store.list({})) {
      if ((m.state === 'running' || m.state === 'queued') && !live.has(m.id) && !alive(m.owner)) {
        if (alive(m.pid) && process.platform === 'win32') { try { process.kill(m.pid); } catch {} }
        store.update(m.id, { state: 'orphaned', endedAt: Date.now(), error: 'el servidor se reinició mientras corría' });
      }
    }
  }

  return {
    bus, resolveWorker, routeWorker: spec => chooseWorker(config.settings, ledger, spec), workers: () => workerStatus(config.settings, ledger),
    submit, status, result, wait, cancel, continueJob, summarize, compact, review, recoverOrphans,
    list: f => store.list(f ?? {}).map(m => status(m.id)),
    metas: () => store.list({}),
    meta: id => need(id),
    mark: (id, patch) => store.update(id, patch),
    jobDir: store.jobDir,
    stats: () => ({ running: live.size, queued: queue.length, maxSeen }),
    active: () => [...live.keys()].map(id => store.get(id)).filter(Boolean),
  };
}
