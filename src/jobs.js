import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { EventEmitter } from 'node:events';
import { attachRun, isProcessAlive, startRun } from './runner.js';
import { getAdapter } from './providers/index.js';
import { createLedger } from './ledger.js';
import { chooseWorker, workerStatus, reserveUsdOf } from './router.js';
import { buildPrompt, parseReport } from './report.js';
import * as iso from './isolation.js';
import { writeFileAtomic } from './atomic-write.js';
import { TERMINAL, VERDICTS } from './job-states.js';

const RETRY_WINDOW_MS = 30_000;
const CHECKPOINT_MS = 1000;

export function createJobManager(config, { bus = new EventEmitter(), writeArtifact = writeFileAtomic } = {}) {
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
  const persistText = (file, text) => {
    try { writeArtifact(file, text); } catch { /* artifacts must never break the job */ }
  };
  function ensureFinished(id) {
    if (!finished.has(id)) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      finished.set(id, { promise, resolve });
    }
    return finished.get(id);
  }

  // Only budgeted, non-free workers reserve: a free plan has no balance to exhaust and the reserve would be noise.
  const reservableAmount = worker => (worker.free || worker.budget?.monthly_usd == null ? 0 : reserveUsdOf(config.settings, worker));
  const reserveBudget = (id, workerName, amount) => {
    if (!(amount > 0)) return;
    try { ledger.reserve(id, workerName, amount); } catch { /* bookkeeping must never break a job */ }
  };
  const releaseBudget = id => {
    try { ledger.release(id); } catch { /* bookkeeping must never break a job */ }
  };

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
    const reservedUsd = reservableAmount(worker);
    store.create({
      id, state: 'queued', kind, task: String(spec.task).slice(0, 300), cwd,
      isolation: spec.workspace ? 'reuse' : (spec.isolation ?? 'inplace'),
      workdir: ws.workdir, branch: ws.branch, base: ws.base, readonly: ws.readonly, warning: ws.warning,
      parentId: spec.parentId, resumeSessionId: spec.resumeSessionId, ephemeral: !!spec.ephemeral,
      worker: worker.name, provider: worker.provider, model: worker.model, effort: worker.effort ?? null, note: selection.note,
      workerConfig: { ...worker }, timeoutMin: config.timeoutMin, exitGraceS: config.exitGraceS, stallMin: config.stallTimeoutMin,
      ...(reservedUsd > 0 ? { reservedUsd } : {}),
      owner: process.pid, createdAt: Date.now(),
    });
    reserveBudget(id, worker.name, reservedUsd);
    persistText(path.join(store.jobDir(id), 'prompt.txt'), prompt);
    persistText(path.join(store.jobDir(id), 'brief.md'), prompt);
    store.audit({ id, kind, worker: worker.name, cwd, isolation: spec.isolation, briefHash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) });
    ensureFinished(id);
    queue.push({ id, prompt, worker, timeoutMin: config.timeoutMin, exitGraceS: config.exitGraceS, stallMin: config.stallTimeoutMin });
    pump();
    return id;
  }

  function pump() {
    while (live.size < config.maxParallel && queue.length) start(queue.shift());
    maxSeen = Math.max(maxSeen, live.size);
  }

  function start({ id, prompt, worker, timeoutMin, exitGraceS, stallMin }) {
    const meta = store.update(id, { state: 'running', startedAt: Date.now(), timeoutMin, exitGraceS, stallMin, logOffset: 0, usage: {}, retries: 0 });
    const dir = store.jobDir(id);
    const adapter = getAdapter(worker.provider);
    monitor(id, meta, worker, adapter, options => startRun(adapter.cmd(config), adapter.buildArgs({
      prompt, workdir: meta.workdir, lastMessagePath: path.join(dir, 'last_message.md'),
      readonly: meta.readonly, resumeSessionId: meta.resumeSessionId, ephemeral: meta.ephemeral, worker,
    }), {
      cwd: meta.workdir, logPath: path.join(dir, 'events.jsonl'), stderrPath: path.join(dir, 'stderr.log'),
      parseLine: adapter.parseLine, env: adapter.env?.(config), ...options,
    }));
    fs.rmSync(path.join(dir, 'prompt.txt'), { force: true });
  }

  function monitor(id, meta, worker, adapter, openHandle, { adopted = false } = {}) {
    const dir = store.jobDir(id);
    const savedText = lastMessage(id) ?? '';
    const state = {
      cancelled: !!meta.cancelRequested, timedOut: !!meta.timedOut, delivered: !!meta.delivered,
      hasFinalMessage: !!meta.hasFinalMessage || !!savedText, finishedByGrace: !!meta.finishedByGrace,
      message: meta.message, deliveredAt: meta.deliveredAt, lastText: savedText,
      usage: { ...(meta.usage ?? {}) }, logOffset: meta.logOffset ?? 0,
      adopted, timer: null, graceTimer: null, checkpointTimer: null, dirty: false, handle: null,
    };
    let lastSessionId = meta.sessionId;
    // A transient retry reuses the same job: the attempt appends to events.jsonl and the polling reader resumes at the saved offset.
    let retries = meta.retries ?? 0;
    let attemptError = null;
    let attemptStartedAt = Date.now();
    const retryLimit = config.retryTransient;
    const timeoutMin = meta.timeoutMin ?? config.timeoutMin;
    const exitGraceS = meta.exitGraceS ?? config.exitGraceS;
    const stallMin = Number(meta.stallMin ?? config.stallTimeoutMin ?? 0);
    const stallMs = stallMin * 60000;
    const stallEnabled = Number.isFinite(stallMs) && stallMs > 0;
    const hasValidReport = () => meta.provider === 'opencode' && parseReport(state.lastText).ok;
    const eventsPath = path.join(dir, 'events.jsonl');
    // Liveness comes from the log's size/mtime: bytes written by the provider count even if they never become parseable events.
    const logMtime = () => { try { return fs.statSync(eventsPath).mtimeMs; } catch { return null; } };
    const logStamp = () => { try { const s = fs.statSync(eventsPath); return `${s.size}:${s.mtimeMs}`; } catch { return ''; } };
    let lastStamp = logStamp();
    // An adopted job keeps the age of its log, so a long-mute provider dies at the next check instead of waiting a full window.
    let lastActivityAt = logMtime() ?? Date.now();

    const finishByGrace = message => {
      if (state.finishedByGrace) return;
      state.finishedByGrace = true;
      state.message = message;
      store.update(id, { finishedByGrace: true, message });
      clearTimeout(state.graceTimer);
      state.handle.kill();
    };
    const scheduleGrace = () => {
      const elapsed = Date.now() - (state.deliveredAt ?? Date.now());
      const remaining = Math.max(0, exitGraceS * 1000 - elapsed);
      state.graceTimer = setTimeout(() => finishByGrace(
        `El agente entregó su respuesta, pero el proceso no terminó dentro de la gracia de ${exitGraceS} s y fue finalizado.`,
      ), remaining);
    };
    const checkpoint = () => ({
      logOffset: state.logOffset,
      usage: { ...state.usage },
      hasFinalMessage: state.hasFinalMessage,
      ...(state.delivered ? { delivered: true, deliveredAt: state.deliveredAt } : {}),
    });
    const flushCheckpoint = () => {
      clearTimeout(state.checkpointTimer);
      state.checkpointTimer = null;
      if (!state.dirty) return;
      store.update(id, checkpoint());
      state.dirty = false;
    };
    const scheduleCheckpoint = () => {
      state.dirty = true;
      state.checkpointTimer ??= setTimeout(flushCheckpoint, CHECKPOINT_MS);
      state.checkpointTimer.unref?.();
    };
    const onEvent = (event, logOffset) => {
      state.logOffset = logOffset;
      if (event.kind === 'session' && event.sessionId !== lastSessionId) {
        lastSessionId = event.sessionId;
        clearTimeout(state.checkpointTimer);
        state.checkpointTimer = null;
        store.update(id, { ...checkpoint(), sessionId: event.sessionId });
        state.dirty = false;
      } else if (event.kind === 'message') {
        state.lastText = event.text;
        state.hasFinalMessage = true;
        persistText(path.join(dir, 'last_message.md'), event.text);
      } else if (event.kind === 'error') {
        attemptError = event;
        state.lastProviderError = event;
        scheduleCheckpoint();
      } else if (event.kind === 'usage') {
        for (const [key, value] of Object.entries(event.usage)) {
          if (typeof value === 'number') state.usage[key] = (state.usage[key] ?? 0) + value;
        }
        if (!state.delivered && state.hasFinalMessage && adapter.completesOn?.(event)) {
          state.delivered = true;
          state.deliveredAt = Date.now();
          clearTimeout(state.checkpointTimer);
          state.checkpointTimer = null;
          store.update(id, checkpoint());
          state.dirty = false;
          scheduleGrace();
        } else scheduleCheckpoint();
      } else scheduleCheckpoint();
      if (event.kind === 'session' && event.sessionId === lastSessionId && state.dirty) {
        scheduleCheckpoint();
      }
    };
    const onOffset = logOffset => { state.logOffset = logOffset; scheduleCheckpoint(); };

    const onTimeout = () => {
      if (state.delivered) finishByGrace('El agente ya había entregado su respuesta al alcanzar el timeout general; el proceso fue finalizado y el job se marcó done.');
      else {
        state.timedOut = true;
        store.update(id, { timedOut: true });
        state.handle.kill();
      }
    };

    const checkStall = () => {
      if (state.stalled || state.delivered || state.cancelled || state.timedOut || state.finishedByGrace) return;
      const stamp = logStamp();
      if (stamp !== lastStamp) { lastStamp = stamp; lastActivityAt = Date.now(); return; }
      if (Date.now() - lastActivityAt < stallMs) return;
      if (hasValidReport()) {
        finishByGrace('OpenCode ya había entregado un reporte válido; el proceso inactivo fue finalizado y el job se marcó done.');
        return;
      }
      state.stalled = true;
      state.stallError = `sin actividad durante ${stallMin} min; el proveedor no respondió`;
      state.handle.kill();
    };

    const beginAttempt = () => {
      attemptStartedAt = Date.now();
      attemptError = null;
      state.handle = openHandle({
        onEvent, onOffset,
        offset: state.logOffset,
        isDelivered: () => state.delivered || hasValidReport(),
      });
      store.update(id, { owner: process.pid, pid: state.handle.pid, ...(adopted ? { adopted: true } : {}) });
      if (stallEnabled && !state.stallTimer) {
        state.stallTimer = setInterval(checkStall, Math.max(20, Math.min(stallMs / 2, 30_000)));
        state.stallTimer.unref?.();
      }
      clearTimeout(state.timer);
      state.timer = setTimeout(onTimeout, Math.max(0, timeoutMin * 60000 - (Date.now() - (meta.startedAt ?? Date.now()))));
      if (state.finishedByGrace) state.handle.kill();
      else if (state.delivered) scheduleGrace();
      else if (state.timedOut || state.cancelled) state.handle.kill();
      state.handle.done.then(result => {
        clearTimeout(state.checkpointTimer);
        state.checkpointTimer = null;
        const fastTransient = result.code !== 0 && Date.now() - attemptStartedAt < RETRY_WINDOW_MS && attemptError?.retryable === true;
        // A stall can never fit the fast-retry window (it takes minutes), so it re-arms the clock and retries on its own.
        if ((fastTransient || state.stalled) && !state.cancelled && !state.timedOut && !state.finishedByGrace && retries < retryLimit) {
          retries += 1;
          state.delivered = false;
          state.deliveredAt = null;
          state.hasFinalMessage = false;
          state.lastText = '';
          state.stalled = false;
          clearTimeout(state.graceTimer);
          flushCheckpoint();
          store.update(id, { retries, delivered: false, deliveredAt: null, hasFinalMessage: false });
          lastActivityAt = Date.now();
          lastStamp = logStamp();
          beginAttempt();
          return;
        }
        finalize(id, meta, state, result, worker, timeoutMin);
      });
    };

    ensureFinished(id);
    live.set(id, state);
    maxSeen = Math.max(maxSeen, live.size);
    state.flushCheckpoint = flushCheckpoint;
    bus.emit('job.started', { id, worker: meta.worker, provider: meta.provider ?? 'desconocido', task: meta.task, kind: meta.kind, ...(adopted ? { adopted: true } : {}) });
    beginAttempt();
  }

  function finalize(id, meta, state, r, worker, timeoutMin) {
    clearTimeout(state.timer);
    clearTimeout(state.graceTimer);
    clearTimeout(state.stallTimer);
    live.delete(id);
    const dir = store.jobDir(id);
    let text = lastMessage(id);
    if (text == null && state.lastText) { text = state.lastText; persistText(path.join(dir, 'last_message.md'), text); }
    let patch = {
      endedAt: Date.now(), logOffset: state.logOffset, usage: { ...state.usage }, hasFinalMessage: state.hasFinalMessage,
      ...(state.delivered ? { delivered: true, deliveredAt: state.deliveredAt } : {}),
    };
    if (state.cancelled) patch.state = 'cancelled';
    else if (state.finishedByGrace) Object.assign(patch, { state: 'done', finishedByGrace: true, message: state.message });
    else if (state.timedOut) Object.assign(patch, { state: 'failed', error: `timeout tras ${timeoutMin} min` });
    else if (state.stalled) Object.assign(patch, { state: 'failed', error: state.stallError });
    else if (r.code === 0) patch.state = 'done';
    else if (state.adopted && r.code == null) Object.assign(patch, { state: 'orphaned', error: `el proceso terminó sin una entrega confirmada${r.stderrTail ? `: ${r.stderrTail}` : ''}`.slice(0, 1500) });
    else Object.assign(patch, {
      state: 'failed',
      error: `${meta.provider ?? 'agente'} salió con código ${r.code}: ${r.stderrTail || state.lastProviderError?.message || ''}`.slice(0, 1500),
    });
    if (patch.state === 'done' && meta.kind === 'compact' && meta.parentId && text) persistText(path.join(store.jobDir(meta.parentId), 'summary.md'), text);
    if (meta.kind === 'run' && !meta.readonly) {
      try { const ch = iso.changes(meta.workdir, meta.base); patch.files = ch.files; patch.diffstat = ch.diffstat; } catch {}
    }
    patch.nominalCostUsd = costOf(worker, state.usage);
    patch.costUsd = worker.free ? 0 : patch.nominalCostUsd;
    releaseBudget(id); // the real cost below replaces the estimate; a real overrun stays visible in the ledger
    try { ledger.record(meta.worker, state.usage, patch.costUsd); } catch { /* bookkeeping must never break a job */ }
    const updated = store.update(id, patch);
    bus.emit('job.finished', { id, worker: meta.worker, provider: meta.provider ?? 'desconocido', kind: meta.kind, state: updated.state, task: meta.task, error: updated.error, ...(updated.message ? { message: updated.message } : {}), costUsd: patch.costUsd, usage: state.usage, startedAt: updated.startedAt, endedAt: updated.endedAt });
    finished.get(id)?.resolve();
    pump();
  }

  function status(id) {
    const m = need(id);
    const end = m.endedAt ?? Date.now();
    return { id, state: m.state, kind: m.kind, worker: m.worker, model: m.model ?? null, provider: m.provider ?? null, effort: m.effort ?? null, elapsedS: Math.round((end - (m.startedAt ?? m.createdAt)) / 1000), task: (m.task ?? '').slice(0, 80), ...(m.branch ? { branch: m.branch } : {}), ...(m.note ? { note: m.note } : {}), ...(m.finishedByGrace ? { finishedByGrace: true } : {}), ...(m.message ? { message: m.message } : {}) };
  }

  function result(id, { detail = 'min' } = {}) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) return status(id);
    const text = lastMessage(id) ?? '';
    const out = {
      id, state: m.state, kind: m.kind, worker: m.worker,
      model: m.model ?? null, provider: m.provider ?? null, effort: m.effort ?? null,
      cost_usd: Number((m.costUsd ?? 0).toFixed(4)),
      nominal_cost_usd: Number((m.nominalCostUsd ?? m.costUsd ?? 0).toFixed(4)),
    };
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
    const maxS = Math.min(Math.max(config.waitMaxS ?? 600, 1), 1800);
    const t = Math.min(Math.max(timeoutS, 1), maxS) * 1000;
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
      releaseBudget(id);
      fs.rmSync(path.join(store.jobDir(id), 'prompt.txt'), { force: true });
      finished.get(id)?.resolve();
      return status(id);
    }
    const l = live.get(id);
    if (l) { l.cancelled = true; store.update(id, { cancelRequested: true }); await l.handle.kill(); }
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

  function retry(id, task) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine antes de reintentar`);
    const spec = {
      cwd: m.cwd, parentId: id, kind: m.kind ?? 'run', worker: m.worker, ephemeral: !!m.ephemeral,
      workspace: { workdir: m.workdir, branch: m.branch, base: m.base, readonly: m.readonly },
    };
    if (task != null) return submit({ ...spec, task });
    const brief = readFile(path.join(store.jobDir(id), 'brief.md'));
    if (brief == null) throw new Error(`job ${id} no guarda brief.md; reintenta con task para lanzarlo sin el brief original`);
    return submit({ ...spec, task: m.task ?? `retry de ${id}`, rawPrompt: brief });
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

  function verdict(id, { verdict: value, note } = {}) {
    need(id);
    if (!VERDICTS.has(value)) throw new Error(`veredicto inválido '${value}': usa accepted o needs_work`);
    const at = Date.now();
    store.update(id, { verdict: value, verdictNote: note ?? null, verdictAt: at });
    return { job_id: id, verdict: value, note: note ?? null, at };
  }

  function recoverOrphans() {
    for (const m of store.list({})) {
      if (!['running', 'queued'].includes(m.state) || live.has(m.id) || isProcessAlive(m.owner)) continue;
      const dir = store.jobDir(m.id);
      const promptPath = path.join(dir, 'prompt.txt');
      const savedPrompt = readFile(promptPath);
      const worker = m.workerConfig ?? config.settings.workers[m.worker] ?? { provider: m.provider, model: m.model, effort: m.effort };
      const provider = m.provider ?? worker.provider;

      const markOrphaned = error => {
        const updated = store.update(m.id, { state: 'orphaned', endedAt: Date.now(), error });
        releaseBudget(m.id);
        bus.emit('job.finished', { id: m.id, worker: m.worker, provider: provider ?? 'desconocido', kind: m.kind, state: updated.state, task: m.task, error: updated.error, endedAt: updated.endedAt });
      };
      const getExpectedAdapter = () => {
        if (worker.provider && provider && worker.provider !== provider) throw new Error('el proveedor guardado no coincide');
        return getAdapter(provider);
      };
      // A surviving job keeps its reservation; restoring it also heals a crash between release and the meta update.
      const restoreReservation = () => { if (m.reservedUsd > 0) reserveBudget(m.id, m.worker, m.reservedUsd); };

      if (m.state === 'queued' || (!m.pid && savedPrompt !== null)) {
        if (savedPrompt === null) {
          markOrphaned('el servidor se reinició antes de iniciar el job y no se encontró su prompt');
          continue;
        }
        try { getExpectedAdapter(); }
        catch (error) { markOrphaned(`no se pudo reanudar el job en cola: ${error.message}`); continue; }
        const started = m.state === 'running';
        store.update(m.id, {
          state: 'queued', owner: process.pid, adopted: true,
          ...(started ? { pid: null, startedAt: null, logOffset: 0, usage: {}, delivered: false, deliveredAt: null, hasFinalMessage: false } : {}),
        });
        restoreReservation();
        ensureFinished(m.id);
        queue.push({ id: m.id, prompt: savedPrompt, worker, timeoutMin: m.timeoutMin ?? config.timeoutMin, exitGraceS: m.exitGraceS ?? config.exitGraceS, stallMin: m.stallMin ?? config.stallTimeoutMin });
        continue;
      }
      let adapter;
      try {
        adapter = getExpectedAdapter();
      } catch (error) { markOrphaned(`no se pudo adoptar el job: ${error.message}`); continue; }
      const meta = store.update(m.id, { provider, adopted: true, owner: process.pid });
      restoreReservation();
      monitor(m.id, meta, worker, adapter, options => attachRun({
        pid: m.pid, logPath: path.join(dir, 'events.jsonl'), stderrPath: path.join(dir, 'stderr.log'),
        offset: m.logOffset ?? 0, parseLine: adapter.parseLine, ...options,
      }), { adopted: true });
      fs.rmSync(promptPath, { force: true });
    }
    // Reservations only survive for jobs that are still queued or running; everything else is a leak from a crash.
    try { ledger.reconcile(store.list({}).filter(m => !TERMINAL.has(m.state)).map(m => m.id)); } catch { /* bookkeeping must never break recovery */ }
    pump();
  }

  // Old terminal jobs are the only thing cleanup may purge: live jobs (even a stale meta raced ahead of its state) are never touched.
  function pruneTerminalJobs({ olderThanDays, id } = {}) {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const removed = [];
    for (const m of store.list({})) {
      if ((id && m.id !== id) || !TERMINAL.has(m.state) || live.has(m.id)) continue;
      if ((m.endedAt ?? m.createdAt) >= cutoff) continue;
      store.remove(m.id);
      removed.push(m.id);
    }
    return removed;
  }

  function shutdown() {
    for (const state of live.values()) {
      clearTimeout(state.timer);
      clearTimeout(state.graceTimer);
      clearTimeout(state.stallTimer);
      state.flushCheckpoint?.();
      state.handle.detach?.();
    }
    live.clear();
  }

  return {
    bus, resolveWorker, routeWorker: spec => chooseWorker(config.settings, ledger, spec), workers: () => workerStatus(config.settings, ledger),
    submit, status, result, wait, cancel, continueJob, retry, summarize, compact, review, verdict, recoverOrphans, pruneTerminalJobs, shutdown,
    list: f => store.list(f ?? {}).map(m => status(m.id)),
    metas: () => store.list({}),
    meta: id => need(id),
    mark: (id, patch) => store.update(id, patch),
    jobDir: store.jobDir,
    stats: () => ({ running: live.size, queued: queue.length, maxSeen }),
    active: () => [...live.keys()].map(id => store.get(id)).filter(Boolean),
  };
}
