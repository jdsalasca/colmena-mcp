import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';

// cmd = {bin, prefixArgs}; parseLine normalizes provider output into {kind, ...} events.
export function startRun(cmd, args, { cwd, onEvent = () => {}, logPath, parseLine, env = {} }) {
  const child = spawn(cmd.bin, [...cmd.prefixArgs, ...args], {
    cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
  let buf = ''; let errBuf = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!line) continue;
      log?.write(line + '\n');
      onEvent(parseLine(line));
    }
  });
  child.stderr.on('data', d => { errBuf = (errBuf + d.toString('utf8')).slice(-8000); });
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, signal: null, stderrTail: String(e.message) }));
    child.on('close', (code, signal) => {
      log?.end();
      const tail = errBuf.split('\n').filter(Boolean).slice(-20).join('\n');
      resolve({ code: code ?? -1, signal, stderrTail: tail });
    });
  });
  const kill = () => new Promise(resolve => {
    if (child.exitCode !== null || !child.pid) return resolve();
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
    else { try { child.kill('SIGKILL'); } catch {} resolve(); }
  });
  return { pid: child.pid, done, kill };
}
