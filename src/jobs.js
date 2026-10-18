import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createStore } from './store.js';
import { EventEmitter } from 'node:events';
import { attachRun, isProcessAlive, killTree, startRun } from './runner.js';
import { descendantsOf, killPlan, sameCreated, snapshot as processSnapshot } from './process-tree.js';
import { getAdapter } from './providers/index.js';
import { createLedger } from './ledger.js';
import { chooseWorker, workerStatus, reserveUsdOf } from './router.js';
import { buildPrompt, parseReport } from './report.js';
import * as iso from './isolation.js';
import { checkRequirements, spawnExec } from './preflight.js';
import { writeFileAtomic } from './atomic-write.js';
import { TERMINAL, VERDICTS } from './job-states.js';

const RETRY_WINDOW_MS = 30_000;
const CHECKPOINT_MS = 1000;
const TREE_SNAPSHOT_MS = 30_000;
const KILL_VERIFY_MS = 100;

function runSetup({ workdir, setup, timeoutMin, logPath, onSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn(setup, [], { cwd: workdir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    const logFd = fs.openSync(logPath, 'a');
    const write = chunk => { try { fs.writeSync(logFd, chunk); } catch {} };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout tras ${timeoutMin} min`));
    }, Math.max(1, timeoutMin * 60000));
    child.once('error', error => { clearTimeout(timer); try { fs.closeSync(logFd); } catch {} reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { fs.closeSync(logFd); } catch {}
      if (code === 0) resolve();
      else reject(new Error(`el comando salió con código ${code}`));
    });
  });
}

export function createJobManager(config, {
  bus = new EventEmitter(), writeArtifact = writeFileAtomic, snapshot = processSnapshot,
  now = Date.now, treeIntervalMs = TREE_SNAPSHOT_MS, preflightExec = spawnExec,
} = {}) {
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
  // `continue` links the old job to the new one; following the chain from an old id lands on its latest descendant.
  function chainFrom(id) {
    const from = id;
    const seen = new Set();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const next = need(current).continuedBy;
      const latest = Array.isArray(next) ? next.at(-1) : next;
      if (!latest || !store.get(latest)) break;
      current = latest;
    }
    return current === from ? { id: from, followed: null } : { id: current, followed: { from, to: current } };
  }
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

  // El preflight corre como primer paso asíncrono del job (submit sigue siendo síncrono): hasta que no
  // pasa no se reserva presupuesto ni se lanza nada. Si falla, el job queda `failed` al momento con
  // error `preflight: …` y los hints accionables, sin gastar cuota.
  const failPreflight = (meta, result) => {
    const failed = result.failed ?? [];
    const hints = [...new Set(failed.map(f => f.hint).filter(Boolean))];
    const error = `preflight: ${failed.map(f => `${f.name}: ${f.reason}`).join('; ') || 'requisitos incumplidos'}`.slice(0, 1500);
    const qi = queue.findIndex(q => q.id === meta.id);
    if (qi >= 0) queue.splice(qi, 1);
    const updated = store.update(meta.id, { state: 'failed', endedAt: Date.now(), error, phase: null, ...(hints.length ? { hints } : {}) });
    releaseBudget(meta.id);
    fs.rmSync(path.join(store.jobDir(meta.id), 'prompt.txt'), { force: true });
    emitFinished(meta, { ...updated, costUsd: 0, usage: {} });
    finished.get(meta.id)?.resolve();
  };

  const runPreflight = async entry => {
    const meta = store.get(entry.id);
    if (!meta || meta.state !== 'queued') return;
    store.update(entry.id, { phase: 'preflight' });
    let result;
    try { result = await checkRequirements(entry.requires, { cwd: meta.workdir ?? meta.cwd, exec: preflightExec }); }
    catch (error) { result = { ok: false, failed: [{ name: 'preflight', reason: error.message, hint: 'revisa los requires del job' }] }; }
    const current = store.get(entry.id);
    if (!current || current.state !== 'queued') return;
    if (!result.ok) { failPreflight(current, result); return; }
    reserveBudget(entry.id, entry.worker.name, entry.reservedUsd);
    entry.ready = true;
    store.update(entry.id, { phase: null });
    pump();
  };

  const enqueue = (entry, { pumpNow = true } = {}) => {
    queue.push(entry);
    if (!entry.ready) runPreflight(entry).catch(() => {});
    else if (pumpNow) pump();
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
    const selection = chooseWorker(config.settings, ledger, { worker: spec.worker, kind: spec.taskKind, commitAllocation: true });
    const worker = resolveWorker(selection.alias);
    const cwd = spec.cwd ?? process.cwd();
    const id = store.newId();
    const ws = spec.workspace ?? iso.prepare(config, { cwd, isolation: spec.isolation ?? 'inplace', id });
    const kind = spec.kind ?? 'run';
    const isolation = spec.workspace ? 'reuse' : (spec.isolation ?? 'inplace');
    const requires = spec.requires ?? [
      ...(config.settings.defaults.requires ?? []),
      ...(isolation === 'worktree' ? config.settings.worktree.requires ?? [] : []),
    ];
    const prompt = spec.rawPrompt ?? buildPrompt({
      task: spec.task, contextFiles: spec.contextFiles, handoff: handoffTexts, kind, standards: config.settings.standards, branch: ws.branch,
    });
    const reservedUsd = reservableAmount(worker);
    store.create({
      id, state: 'queued', kind, task: String(spec.task).slice(0, 300), cwd,
      isolation,
      workdir: ws.workdir, branch: ws.branch, base: ws.base, readonly: ws.readonly, warning: ws.warning,
      parentId: spec.parentId, resumeSessionId: spec.resumeSessionId, ephemeral: !!spec.ephemeral,
      worker: worker.name, provider: worker.provider, model: worker.model, effort: worker.effort ?? null,
      note: [selection.note, spec.note].filter(Boolean).join('; ') || undefined,
      workerConfig: { ...worker }, timeoutMin: config.timeoutMin, exitGraceS: config.exitGraceS, stallMin: config.stallTimeoutMin,
      ...(requires.length ? { requires } : {}),
      ...(reservedUsd > 0 ? { reservedUsd } : {}),
      owner: process.pid, createdAt: Date.now(),
    });
    if (!requires.length) reserveBudget(id, worker.name, reservedUsd);
    persistText(path.join(store.jobDir(id), 'prompt.txt'), prompt);
    persistText(path.join(store.jobDir(id), 'brief.md'), prompt);
    store.audit({ id, kind, worker: worker.name, cwd, isolation: spec.isolation, briefHash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12) });
    ensureFinished(id);
    enqueue({ id, prompt, worker, timeoutMin: config.timeoutMin, exitGraceS: config.exitGraceS, stallMin: config.stallTimeoutMin, ready: requires.length === 0, requires, reservedUsd });
    return id;
  }

  function pump() {
    while (live.size < config.maxParallel) {
      const next = queue.findIndex(entry => entry.ready);
      if (next < 0) break;
      start(queue.splice(next, 1)[0]);
    }
    maxSeen = Math.max(maxSeen, live.size);
  }

  function start({ id, prompt, worker, timeoutMin, exitGraceS, stallMin }) {
    const meta = store.update(id, { state: 'running', startedAt: Date.now(), timeoutMin, exitGraceS, stallMin, logOffset: 0, usage: {}, retries: 0 });
    const dir = store.jobDir(id);
    const setupCfg = meta.isolation === 'worktree' ? config.settings.worktree : null;
    if (setupCfg?.setup) {
      const setupState = { phase: 'setup', cancelled: false, timedOut: false, delivered: false, hasFinalMessage: false, finishedByGrace: false, usage: {}, logOffset: 0, setupError: null, handle: null };
      live.set(id, setupState);
      maxSeen = Math.max(maxSeen, live.size);
      store.update(id, { phase: 'setup' });
      let child = null;
      setupState.handle = { kill: () => { try { child?.kill('SIGKILL'); } catch {} } };
      runSetup({
        workdir: meta.workdir, setup: setupCfg.setup,
        timeoutMin: setupCfg.setup_timeout_min ?? 10,
        logPath: path.join(dir, 'setup.log'),
        onSpawn: c => { child = c; },
      }).then(() => {
        live.delete(id);
        store.update(id, { phase: null });
        launchAgent();
      }).catch(error => {
        live.delete(id);
        setupState.setupError = `setup falló: ${error.message}`;
        finalize(id, meta, setupState, { code: 1, signal: null, stderrTail: '' }, worker, timeoutMin);
      });
      return;
    }
    launchAgent();

    function launchAgent() {
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
      treeSeen: new Map(), treeSampled: false, treeTimer: null, treeBusy: false, stallBusy: false, lastCpuMs: null,
      killPromise: null, killReport: null,
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
    const logAgeMs = logMtime() == null ? 0 : Math.max(0, Date.now() - logMtime());
    let lastActivityAt = now() - logAgeMs;

    // The union of every PID seen under the agent root survives dead intermediates: taskkill /T of
    // the root cannot reach a detached grandchild whose ParentProcessId no longer exists.
    const mergeTree = (snap, rootPid) => {
      const root = snap.find(proc => proc.pid === rootPid);
      if (root && !state.treeSeen.has(rootPid)) state.treeSeen.set(rootPid, root.created);
      const descendants = descendantsOf(rootPid, snap);
      for (const proc of descendants) if (!state.treeSeen.has(proc.pid)) state.treeSeen.set(proc.pid, proc.created);
      const cpuMs = (root?.cpuMs ?? 0) + descendants.reduce((sum, proc) => sum + proc.cpuMs, 0);
      return { root, descendants, cpuMs };
    };
    const takeTreeSnapshot = async () => {
      const rootPid = state.handle?.pid;
      if (!rootPid || state.treeBusy) return null;
      state.treeBusy = true;
      try {
        const snap = await snapshot();
        if (!Array.isArray(snap)) return null;
        state.treeSampled = true;
        return mergeTree(snap, rootPid);
      } catch { return null; } finally { state.treeBusy = false; }
    };
    const startTreeTracking = () => {
      if (state.treeTimer || !(treeIntervalMs > 0)) return;
      state.treeTimer = setInterval(() => { takeTreeSnapshot().catch(() => {}); }, treeIntervalMs);
      state.treeTimer.unref?.();
    };

    const killNow = () => {
      if (state.killPromise) return state.killPromise;
      state.killPromise = (async () => {
        clearInterval(state.treeTimer);
        state.treeTimer = null;
        const rootPid = state.handle?.pid;
        if (!rootPid) return;
        // Without a single tree sample there is no union to replay: the plain taskkill /T of the root
        // already covers the current tree, and skipping PowerShell keeps short cancels cheap.
        if (!state.treeSampled) {
          await killTree(rootPid);
          await delay(80);
          const alive = isProcessAlive(rootPid);
          state.killReport = { killedPids: alive ? [] : [rootPid], survivors: alive ? [rootPid] : [] };
          store.update(id, state.killReport);
          return;
        }
        let snap;
        try { snap = await snapshot(); } catch { snap = []; }
        if (!Array.isArray(snap)) snap = [];
        if (snap.length) mergeTree(snap, rootPid);
        const current = new Map(snap.map(proc => [proc.pid, proc]));
        const known = state.treeSeen;
        const targets = killPlan(rootPid, snap, known).map(proc => proc.pid);
        const rootNow = current.get(rootPid);
        const rootKnown = known.get(rootPid);
        const rootIsOurs = process.platform !== 'win32' || !snap.length ||
          (rootNow && (!rootKnown || sameCreated(rootNow.created, rootKnown)));
        if (rootIsOurs) targets.push(rootPid);
        for (const pid of targets) await killTree(pid);
        await delay(KILL_VERIFY_MS);
        let after;
        try { after = await snapshot(); } catch { after = []; }
        const remaining = new Map((Array.isArray(after) ? after : []).map(proc => [proc.pid, proc]));
        const survivors = [...new Set(targets)].filter(pid => {
          const proc = remaining.get(pid);
          if (!proc) return false;
          const created = pid === rootPid ? rootKnown : known.get(pid);
          return created == null || sameCreated(proc.created, created);
        });
        state.killReport = { killedPids: [...new Set(targets)].filter(pid => !survivors.includes(pid)), survivors };
        store.update(id, state.killReport);
      })();
      return state.killPromise;
    };

    const finishByGrace = message => {
      if (state.finishedByGrace) return;
      state.finishedByGrace = true;
      state.message = message;
      store.update(id, { finishedByGrace: true, message });
      clearTimeout(state.graceTimer);
      killNow();
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
        killNow();
      }
    };

    const checkStall = async () => {
      if (state.stallBusy || state.stalled || state.delivered || state.cancelled || state.timedOut || state.finishedByGrace) return;
      state.stallBusy = true;
      try {
        const stamp = logStamp();
        if (stamp !== lastStamp) { lastStamp = stamp; lastActivityAt = now(); return; }
        if (now() - lastActivityAt < stallMs) return;
        if (hasValidReport()) {
          finishByGrace('OpenCode ya había entregado un reporte válido; el proceso inactivo fue finalizado y el job se marcó done.');
          return;
        }
        // A mute agent may still be running a long legitimate command: CPU growth in its tree proves it is alive.
        const tree = await takeTreeSnapshot();
        if (!tree) return;
        if (state.lastCpuMs == null) { state.lastCpuMs = tree.cpuMs; return; }
        if (tree.cpuMs > state.lastCpuMs) {
          state.lastCpuMs = tree.cpuMs;
          lastActivityAt = now();
          return;
        }
        state.lastCpuMs = tree.cpuMs;
        state.stalled = true;
        state.stallError = `sin eventos ni actividad de CPU durante ${stallMin} min`;
        killNow();
      } finally { state.stallBusy = false; }
    };

    const beginAttempt = () => {
      attemptStartedAt = Date.now();
      attemptError = null;
      state.killPromise = null;
      state.handle = openHandle({
        onEvent, onOffset,
        offset: state.logOffset,
        isDelivered: () => state.delivered || hasValidReport(),
      });
      store.update(id, { owner: process.pid, pid: state.handle.pid, ...(adopted ? { adopted: true } : {}) });
      if (stallEnabled && !state.stallTimer) {
        state.stallTimer = setInterval(() => { checkStall().catch(() => {}); }, Math.max(20, Math.min(stallMs / 2, 30_000)));
        state.stallTimer.unref?.();
      }
      startTreeTracking();
      state.lastCpuMs = null;
      clearTimeout(state.timer);
      state.timer = setTimeout(onTimeout, Math.max(0, timeoutMin * 60000 - (Date.now() - (meta.startedAt ?? Date.now()))));
      if (state.finishedByGrace) killNow();
      else if (state.delivered) scheduleGrace();
      else if (state.timedOut || state.cancelled) killNow();
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
          lastActivityAt = now();
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
    state.kill = killNow;
    bus.emit('job.started', { id, worker: meta.worker, provider: meta.provider ?? 'desconocido', task: meta.task, kind: meta.kind, ...(adopted ? { adopted: true } : {}) });
    beginAttempt();
  }

  const emitFinished = (meta, { state, error, message, costUsd, usage, startedAt, endedAt }) => bus.emit('job.finished', {
    id: meta.id, worker: meta.worker, provider: meta.provider ?? 'desconocido', kind: meta.kind,
    state, task: meta.task, error, ...(message ? { message } : {}), costUsd, usage, startedAt, endedAt,
  });

  function finalize(id, meta, state, r, worker, timeoutMin) {
    clearTimeout(state.timer);
    clearTimeout(state.graceTimer);
    clearTimeout(state.stallTimer);
    clearInterval(state.treeTimer);
    state.treeTimer = null;
    live.delete(id);
    const dir = store.jobDir(id);
    let text = lastMessage(id);
    if (text == null && state.lastText) { text = state.lastText; persistText(path.join(dir, 'last_message.md'), text); }
    let patch = {
      endedAt: Date.now(), logOffset: state.logOffset, usage: { ...state.usage }, hasFinalMessage: state.hasFinalMessage,
      ...(state.delivered ? { delivered: true, deliveredAt: state.deliveredAt } : {}),
    };
    if (state.cancelled) patch.state = 'cancelled';
    else if (state.setupError) Object.assign(patch, { state: 'failed', error: state.setupError });
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
    emitFinished(meta, { ...updated, costUsd: patch.costUsd, usage: state.usage });
    finished.get(id)?.resolve();
    pump();
  }

  function baseStatus(id) {
    const m = need(id);
    const end = m.endedAt ?? Date.now();
    return { id, state: m.state, kind: m.kind, worker: m.worker, model: m.model ?? null, provider: m.provider ?? null, effort: m.effort ?? null, elapsedS: Math.round((end - (m.startedAt ?? m.createdAt)) / 1000), task: (m.task ?? '').slice(0, 80), ...(m.branch ? { branch: m.branch } : {}), ...(m.note ? { note: m.note } : {}), ...(m.phase ? { phase: m.phase } : {}), ...(m.finishedByGrace ? { finishedByGrace: true } : {}), ...(m.message ? { message: m.message } : {}) };
  }

  function status(id) {
    const c = chainFrom(id);
    const s = baseStatus(c.id);
    return c.followed ? { ...s, followed: c.followed } : s;
  }

  function baseResult(id, { detail = 'min' } = {}) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) return baseStatus(id);
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
    if (m.hints?.length) out.hints = m.hints;
    if (detail !== 'min') {
      Object.assign(out, { sessionId: m.sessionId, usage: m.usage, jobDir: store.jobDir(id), eventsLog: path.join(store.jobDir(id), 'events.jsonl') });
      if (m.files?.length > 15) out.files = m.files;
    }
    if (detail === 'full') out.fullText = text;
    return out;
  }

  function result(id, options) {
    const c = chainFrom(id);
    const out = baseResult(c.id, options);
    return c.followed ? { ...out, followed: c.followed } : out;
  }

  async function wait(ids, { mode = 'all', timeoutS = 120 } = {}) {
    ids.forEach(need);
    // A continued job is substituted by its latest descendant so a stale old id never returns the obsolete report.
    const chains = ids.map(id => chainFrom(id));
    const finals = [...new Set(chains.map(c => c.id))];
    const followedBy = new Map(chains.filter(c => c.followed).map(c => [c.id, c.followed]));
    const note = id => (followedBy.has(id) ? { followed: followedBy.get(id) } : {});
    const maxS = Math.min(Math.max(config.waitMaxS ?? 600, 1), 1800);
    const t = Math.min(Math.max(timeoutS, 1), maxS) * 1000;
    const ps = finals.map(id => finished.get(id)?.promise ?? Promise.resolve());
    const cond = mode === 'any' ? Promise.race(ps) : Promise.all(ps);
    let timer;
    await Promise.race([cond, new Promise(r => { timer = setTimeout(r, t); })]);
    clearTimeout(timer);
    const isTerm = id => TERMINAL.has(need(id).state);
    return {
      done: finals.filter(isTerm).map(id => ({ ...baseResult(id), ...note(id) })),
      pending: finals.filter(id => !isTerm(id)).map(id => ({ ...baseStatus(id), ...note(id) })),
    };
  }

  async function cancel(id) {
    const m = need(id);
    if (TERMINAL.has(m.state)) return baseStatus(id);
    const qi = queue.findIndex(q => q.id === id);
    if (qi >= 0) {
      queue.splice(qi, 1);
      const updated = store.update(id, { state: 'cancelled', endedAt: Date.now() });
      emitFinished(m, { ...updated, costUsd: 0, usage: {} });
      releaseBudget(id);
      fs.rmSync(path.join(store.jobDir(id), 'prompt.txt'), { force: true });
      finished.get(id)?.resolve();
      return baseStatus(id);
    }
    const l = live.get(id);
    if (l) { l.cancelled = true; store.update(id, { cancelRequested: true }); await l.kill(); }
    return baseStatus(id);
  }

  function continueJob(id, message) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine`);
    if (!m.sessionId) throw new Error(`job ${id} no guardó session id; no se puede reanudar`);
    const nextId = submit({
      task: message, cwd: m.cwd, parentId: id, resumeSessionId: m.sessionId, kind: 'run', worker: m.worker,
      workspace: { workdir: m.workdir, branch: m.branch, base: m.base, readonly: m.readonly },
    });
    store.update(id, { continuedBy: m.continuedBy == null ? nextId : [...(Array.isArray(m.continuedBy) ? m.continuedBy : [m.continuedBy]), nextId] });
    return nextId;
  }

  function retry(id, task, worker) {
    const m = need(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine antes de reintentar`);
    const spec = {
      cwd: m.cwd, parentId: id, kind: m.kind ?? 'run', worker: worker ?? m.worker, ephemeral: !!m.ephemeral,
      workspace: { workdir: m.workdir, branch: m.branch, base: m.base, readonly: m.readonly },
    };
    if (worker == null) {
      try {
        resolveWorker(m.worker);
      } catch (error) {
        const selection = chooseWorker(config.settings, ledger);
        spec.worker = selection.alias;
        spec.note = [error.message.split(';')[0], `se usó ${selection.alias}`, selection.note].filter(Boolean).join('; ');
      }
    }
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
    const m = need(id);
    if (!TERMINAL.has(m.state)) throw new Error(`job ${id} sigue ${m.state}; espera a que termine`);
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
        const requires = m.requires ?? [];
        enqueue({ id: m.id, prompt: savedPrompt, worker, timeoutMin: m.timeoutMin ?? config.timeoutMin, exitGraceS: m.exitGraceS ?? config.exitGraceS, stallMin: m.stallMin ?? config.stallTimeoutMin, ready: requires.length === 0, requires, reservedUsd: m.reservedUsd ?? 0 }, { pumpNow: false });
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
      clearInterval(state.treeTimer);
      state.treeTimer = null;
      state.flushCheckpoint?.();
      state.handle.detach?.();
    }
    live.clear();
  }

  return {
    bus, resolveWorker, routeWorker: spec => chooseWorker(config.settings, ledger, spec), workers: () => workerStatus(config.settings, ledger),
    allocationCounts: profile => ledger.allocationCounts(profile),
    submit, status, result, wait, cancel, continueJob, retry, summarize, compact, review, verdict, recoverOrphans, pruneTerminalJobs, shutdown,
    list: f => store.list(f ?? {}).map(m => baseStatus(m.id)),
    metas: () => store.list({}),
    meta: id => need(id),
    mark: (id, patch) => store.update(id, patch),
    jobDir: store.jobDir,
    stats: () => ({ running: live.size, queued: queue.length, maxSeen }),
    active: () => [...live.keys()].map(id => store.get(id)).filter(Boolean),
  };
}
