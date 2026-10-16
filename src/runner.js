import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

const TAIL_BYTES = 8000;
const TAIL_LINES = 20;
const READ_CHUNK = TAIL_BYTES * 4;

export function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return '';
    const toRead = Math.min(size, READ_CHUNK);
    const start = size - toRead;
    const buf = Buffer.allocUnsafe(toRead);
    let read = 0;
    while (read < toRead) {
      const n = fs.readSync(fd, buf, read, toRead - read, start + read);
      if (!n) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString('utf8');
    return text.slice(-TAIL_BYTES).split('\n').filter(Boolean).slice(-TAIL_LINES).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') return execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    try { process.kill(-pid, 'SIGKILL'); }
    catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    resolve();
  });
}

function createEventReader({ logPath, offset = 0, parseLine = line => line, onEvent = () => {}, onOffset = () => {} }) {
  let consumed = offset;
  let readAt = offset;
  let pending = Buffer.alloc(0);
  let stopped = false;

  function poll({ flush = false } = {}) {
    if (stopped) return;
    let fd;
    try { fd = fs.openSync(logPath, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      while (readAt < size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - readAt));
        const count = fs.readSync(fd, chunk, 0, chunk.length, readAt);
        if (!count) break;
        readAt += count;
        const data = Buffer.concat([pending, chunk.subarray(0, count)]);
        let start = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 10) continue;
          const line = data.subarray(start, i);
          consumed += i - start + 1;
          if (line.length) onEvent(parseLine(line.toString('utf8').replace(/\r$/, '')), consumed);
          else onOffset(consumed);
          start = i + 1;
        }
        pending = data.subarray(start);
      }
    } finally { fs.closeSync(fd); }
    if (flush && pending.length) {
      consumed += pending.length;
      onEvent(parseLine(pending.toString('utf8').replace(/\r$/, '')), consumed);
      pending = Buffer.alloc(0);
    }
  }

  return {
    poll,
    stop() { stopped = true; },
    get offset() { return consumed; },
  };
}

function logPaths(logPath, stderrPath, cwd) {
  const events = logPath ?? path.join(cwd, 'events.jsonl');
  return { events, stderr: stderrPath ?? path.join(path.dirname(events), 'stderr.log') };
}

// cmd = {bin, prefixArgs}; parseLine normalizes provider output into {kind, ...} events.
// offset lets a retry resume the reader after the previous attempt's appended output.
export function startRun(cmd, args, { cwd, onEvent = () => {}, onOffset = () => {}, offset = 0, logPath, stderrPath, parseLine, env = {} }) {
  const paths = logPaths(logPath, stderrPath, cwd);
  fs.mkdirSync(path.dirname(paths.events), { recursive: true });
  fs.mkdirSync(path.dirname(paths.stderr), { recursive: true });
  const outFd = fs.openSync(paths.events, 'a');
  const errFd = fs.openSync(paths.stderr, 'a');
  let child;
  try {
    child = spawn(cmd.bin, [...cmd.prefixArgs, ...args], {
      cwd, env: { ...process.env, ...env }, detached: true, windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.unref();

  const reader = createEventReader({ logPath: paths.events, offset, parseLine, onEvent, onOffset });
  const interval = setInterval(() => reader.poll(), 40);
  let resolveDone;
  let settled = false;
  let detached = false;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = result => {
    if (settled || detached) return;
    settled = true;
    try { reader.poll({ flush: true }); } finally {
      clearInterval(interval);
      reader.stop();
      resolveDone({ ...result, stderrTail: result.stderrTail ?? tail(paths.stderr) });
    }
  };
  child.once('error', error => finish({ code: -1, signal: null, stderrTail: String(error.message) }));
  child.once('close', (code, signal) => finish({ code: code ?? -1, signal, stderrTail: tail(paths.stderr) }));

  return {
    pid: child.pid,
    done,
    kill: () => killTree(child.pid),
    detach() { detached = true; clearInterval(interval); reader.stop(); },
  };
}

export function attachRun({ pid, logPath, stderrPath, offset = 0, parseLine, onEvent, onOffset, pollIntervalMs = 50, isAlive = isProcessAlive, isDelivered = () => false }) {
  const paths = logPaths(logPath, stderrPath, path.dirname(logPath));
  const reader = createEventReader({ logPath: paths.events, offset, parseLine, onEvent, onOffset });
  let resolveDone;
  let settled = false;
  let detached = false;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = () => {
    if (settled || detached) return;
    settled = true;
    try { reader.poll({ flush: true }); } finally {
      clearInterval(interval);
      reader.stop();
      resolveDone({ code: isDelivered() ? 0 : null, signal: null, stderrTail: tail(paths.stderr) });
    }
  };
  const check = () => {
    try { reader.poll(); }
    finally { if (!isAlive(pid)) finish(); }
  };
  const interval = setInterval(check, pollIntervalMs);
  check();

  return {
    pid,
    done,
    kill: () => killTree(pid),
    detach() {
      detached = true;
      clearInterval(interval);
      reader.stop();
    },
  };
}
