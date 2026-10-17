import { execFile } from 'node:child_process';

// Win32_Process exposes ParentProcessId and cumulative user+kernel CPU time. Created is emitted as
// Unix milliseconds (safe integer) so snapshots can compare process identity without PID reuse risks.
const SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, " +
    "@{n='Created';e={ if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }}, " +
    "@{n='CpuMs';e={ [math]::Round(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000) }}) | " +
    'ConvertTo-Json -Compress',
].join('; ');

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SNAPSHOT_SCRIPT];

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function parseSnapshot(text) {
  if (!text || !text.trim()) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(data) ? data : [data];
  const out = [];
  for (const row of rows) {
    const pid = Number(row?.ProcessId ?? row?.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      ppid: Number(row?.ParentProcessId ?? row?.ppid) || 0,
      name: String(row?.Name ?? row?.name ?? ''),
      created: toMs(row?.Created ?? row?.created),
      cpuMs: Math.max(0, Math.round(Number(row?.CpuMs ?? row?.cpuMs) || 0)),
    });
  }
  return out;
}

// Injectable boundary: tests replace this with a pure list of processes.
export function snapshot() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(resolve => {
    execFile('powershell.exe', POWERSHELL_ARGS, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parseSnapshot(stdout));
    });
  });
}

export function descendantsOf(rootPid, snap = []) {
  if (!rootPid) return [];
  const children = new Map();
  for (const proc of snap) {
    const parent = String(proc.ppid);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(proc);
  }
  const out = [];
  const seen = new Set([Number(rootPid)]);
  const queue = [Number(rootPid)];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(String(parent)) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export function sameCreated(a, b) {
  if (!a || !b) return false;
  return Math.abs(Number(a) - Number(b)) < 1;
}

// Deepest-first victims: the PIDs seen during the run that still exist with the same creation date,
// plus current descendants. A reused PID (different creation date) is never touched.
export function killPlan(rootPid, snap = [], known = new Map()) {
  if (!rootPid) return [];
  const current = new Map(snap.map(proc => [proc.pid, proc]));
  const depth = pid => {
    let d = 0;
    let cursor = current.get(pid);
    const visited = new Set();
    while (cursor && cursor.ppid && cursor.ppid !== Number(rootPid) && !visited.has(cursor.pid)) {
      visited.add(cursor.pid);
      cursor = current.get(cursor.ppid);
      d += 1;
    }
    return d;
  };
  const victims = new Map();
  for (const [rawPid, created] of known) {
    const pid = Number(rawPid);
    if (pid === Number(rootPid)) continue;
    const proc = current.get(pid);
    if (proc && sameCreated(proc.created, created)) victims.set(pid, proc);
  }
  for (const proc of descendantsOf(rootPid, snap)) {
    const created = known.get(proc.pid) ?? known.get(String(proc.pid));
    if (created != null && !sameCreated(proc.created, created)) continue;
    victims.set(proc.pid, proc);
  }
  return [...victims.values()].sort((a, b) => depth(b.pid) - depth(a.pid) || a.pid - b.pid);
}
