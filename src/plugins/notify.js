import fs from 'node:fs';
import path from 'node:path';

const count = (items, key) => {
  const m = new Map();
  for (const i of items) m.set(i[key], (m.get(i[key]) ?? 0) + 1);
  return [...m].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ');
};

// Subscribes to the job bus: grouped start toasts, finish/fail toasts, and a heartbeat while work is running.
export function notifyPlugin({ bus, jm, cfg, notifier, heartbeatMs, debounceMs = 2000, logPath }) {
  const on = new Set(cfg.on ?? ['start', 'finish', 'fail']);
  let spent = 0;
  const bufs = { start: [], finish: [], fail: [] };
  const timers = { start: null, finish: null, fail: null };

  const emit = n => {
    if (logPath) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${new Date().toISOString()} [${n.kind}] ${n.title}: ${n.body}\n`);
      } catch { /* log is best-effort */ }
    }
    if (n.kind === 'heartbeat' || on.has(n.kind)) {
      try { notifier.send(n); } catch { /* never let a toast break the server */ }
    }
  };

  const flush = kind => {
    const items = bufs[kind].splice(0);
    timers[kind] = null;
    if (!items.length) return;
    if (kind === 'start') {
      emit({ kind, title: 'Colmena · agentes lanzados', body: `${items.length} lanzado${items.length > 1 ? 's' : ''}: ${count(items, 'worker')}` });
    } else if (kind === 'finish') {
      const cost = items.reduce((s, i) => s + (i.costUsd ?? 0), 0);
      const body = items.length === 1
        ? `${items[0].worker}: ${String(items[0].task).slice(0, 60)} → ${items[0].state === 'cancelled' ? 'cancelado' : 'terminó (done)'} · $${cost.toFixed(2)}`
        : `${items.length} terminaron (${count(items, 'worker')}) · $${cost.toFixed(2)}`;
      emit({ kind, title: 'Colmena · terminó', body });
    } else {
      const body = items.length === 1
        ? `${items[0].worker} falló: ${String(items[0].error ?? items[0].state).slice(0, 100)}`
        : `${items.length} fallaron (${count(items, 'worker')}): ${String(items[0].error ?? items[0].state).slice(0, 70)}`;
      emit({ kind, title: 'Colmena · falló', body });
    }
  };
  const push = (kind, item) => {
    bufs[kind].push(item);
    timers[kind] ??= setTimeout(() => flush(kind), debounceMs);
    timers[kind].unref?.();
  };

  const onStart = e => push('start', e);
  const onFinish = e => {
    spent += e.costUsd ?? 0;
    push(e.state === 'failed' || e.state === 'orphaned' ? 'fail' : 'finish', e);
  };
  bus.on('job.started', onStart);
  bus.on('job.finished', onFinish);

  const beat = setInterval(() => {
    const { running, queued } = jm.stats();
    if (running + queued === 0) return;
    const starts = (jm.active?.() ?? []).map(a => a.startedAt).filter(Boolean);
    const mins = starts.length ? Math.round((Date.now() - Math.min(...starts)) / 60000) : 0;
    emit({ kind: 'heartbeat', title: 'Colmena · trabajando', body: `${running} corriendo · ${queued} en cola · ${mins} min · $${spent.toFixed(2)}` });
  }, heartbeatMs ?? (cfg.heartbeat_min ?? 10) * 60000);
  beat.unref();

  return {
    stop() {
      clearInterval(beat);
      for (const k of Object.keys(timers)) clearTimeout(timers[k]);
      bus.off('job.started', onStart);
      bus.off('job.finished', onFinish);
    },
  };
}
