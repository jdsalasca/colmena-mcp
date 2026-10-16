import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { buildArgs, startRun } from './runner.js';
import { buildPrompt, parseReport } from './report.js';
import * as iso from './isolation.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'orphaned']);
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export function createJobManager(config) {
  const store = createStore(config);
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
    const cwd = spec.cwd ?? process.cwd();
    const id = store.newId();
    const ws = spec.workspace ?? iso.prepare(config, { cwd, isolation: spec.isolation ?? 'inplace', id });
    const prompt = spec.rawPrompt ?? buildPrompt({ task: spec.task, contextFiles: spec.contextFiles, handoff: handoffTexts });
    store.create({
      id, state: 'queued', kind: spec.kind ?? 'run', task: String(spec.task).slice(0, 300), cwd,
      isolation: spec.workspace ? 'reuse' : (spec.isolation ?? 'inplace'),
      workdir: ws.workdir, branch: ws.branch, base: ws.base, readonly: ws.readonly, warning: ws.warning,
      parentId: spec.parentId, resumeSessionId: spec.resumeSessionId, ephemeral: !!spec.ephemeral,
      owner: process.pid, createdAt: Date.now(),
    });
    store.audit({ id, kind: spec.kind ?? 'run', cwd, isolation: spec.isolation, briefHash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) });
    let resolve; const promise = new Promise(r => { resolve = r; });
    finished.set(id, { promise, resolve });
    queue.push({ id, prompt });
    pump();
    return id;
  }

  function pump() {
    while (live.size < config.maxParallel && queue.length) start(queue.shift());
    maxSeen = Math.max(maxSeen, live.size);
  }

  function start({ id, prompt }) {
    const meta = store.update(id, { state: 'running', startedAt: Date.now() });
    const dir = store.jobDir(id);
    const state = { cancelled: false, timedOut: false, timer: null, handle: null };
    live.set(id, state);
    maxSeen = Math.max(maxSeen, live.size);
    let usage = {}; let lastText = '';
    const handle = startRun(config, buildArgs({
      prompt, workdir: meta.workdir, lastMessagePath: path.join(dir, 'last_message.md'),
      readonly: meta.readonly, resumeSessionId: meta.resumeSessionId, ephemeral: meta.ephemeral,
    }), {
      cwd: meta.workdir, logPath: path.join(dir, 'events.jsonl'),
      onEvent: e => {
        if (e.kind === 'session') store.update(id, { sessionId: e.sessionId });
        else if (e.kind === 'message') lastText = e.text;
        else if (e.kind === 'usage') for (const [k, v] of Object.entries(e.usage)) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
      },
    });
    state.handle = handle;
    store.update(id, { pid: handle.pid });
    state.timer = setTimeout(() => { state.timedOut = true; handle.kill(); }, config.timeoutMin * 60000);
    handle.done.then(r => finalize(id, meta, state, r, lastText, usage));
  }

  function finalize(id, meta, state, r, lastText, usage) {
    clearTimeout(state.timer);
    live.delete(id);
    const dir = store.jobDir(id);
    let text = lastMessage(id);
    if (text == null && lastText) { text = lastText; fs.writeFileSync(path.join(dir, 'last_message.md'), text); }
    let patch = { endedAt: Date.now(), usage };
    if (state.cancelled) patch.state = 'cancelled';
    else if (state.timedOut) Object.assign(patch, { state: 'failed', error: `timeout tras ${config.timeoutMin} min` });
    else if (r.code === 0) patch.state = 'done';
    else Object.assign(patch, { state: 'failed', error: `codex salió con código ${r.code}: ${r.stderrTail}`.slice(0, 1500) });
    if (patch.state === 'done' && meta.kind === 'compact' && meta.parentId && text) fs.writeFileSync(path.join(store.jobDir(meta.parentId), 'summary.md'), text);
    if (meta.kind === 'run' && !meta.readonly) {
      try { const ch = iso.changes(meta.workdir, meta.base); patch.files = ch.files; patch.diffstat = ch.diffstat; } catch {}
    }
    store.update(id, patch);
    finished.get(id)?.resolve();
    pump();
  }

  function status(id) {
    const m = need(id);
    const end = m.endedAt ?? Date.now();
    return { id, state: m.state, kind: m.kind, elapsedS: Math.round((end - (m.startedAt ?? m.createdAt)) / 1000), task: (m.task ?? '').slice(0, 80), ...(m.branch ? { branch: m.branch } : {}) };
  }

  function result(id, { detail = 'min' } = {}) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) return status(id);
    const text = lastMessage(id) ?? '';
    const out = { id, state: m.state, kind: m.kind };
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
      task: message, cwd: m.cwd, parentId: id, resumeSessionId: m.sessionId, kind: 'run',
      workspace: { workdir: m.workdir, branch: m.branch, base: m.base, readonly: m.readonly },
    });
  }

  function helperJob(kind, id, rawPrompt) {
    const m = need(id);
    return submit({
      kind, task: `${kind} de ${id}`, cwd: m.cwd, parentId: id, rawPrompt, ephemeral: true,
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
      return helperJob('review', id, buildPrompt({ task: `Revisa en modo solo lectura los cambios de este directorio (${how}). Busca bugs, regresiones y pruebas faltantes.${focus ? ` Foco: ${focus}.` : ''} No modifiques archivos.` }));
    }
    return submit({
      kind: 'review', task: 'review de cwd', cwd, ephemeral: true,
      workspace: { workdir: cwd, readonly: true },
      rawPrompt: buildPrompt({ task: `Revisa en modo solo lectura los cambios pendientes (git diff HEAD y git status). Busca bugs, regresiones y pruebas faltantes.${focus ? ` Foco: ${focus}.` : ''} No modifiques archivos.` }),
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
    submit, status, result, wait, cancel, continueJob, summarize, compact, review, recoverOrphans,
    list: f => store.list(f ?? {}).map(m => status(m.id)),
    meta: id => need(id),
    jobDir: store.jobDir,
    stats: () => ({ running: live.size, queued: queue.length, maxSeen }),
  };
}
