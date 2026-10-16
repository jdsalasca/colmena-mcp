import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';

export const MODEL = 'gpt-6-luna';
export const EFFORT = 'max';

export function buildArgs({ prompt, workdir, lastMessagePath, readonly = false, resumeSessionId, ephemeral = false }) {
  const a = ['--search', 'exec'];
  if (resumeSessionId) a.push('resume', resumeSessionId);
  a.push('--json', '--skip-git-repo-check', '-m', MODEL, '-c', `model_reasoning_effort="${EFFORT}"`);
  if (readonly) a.push('-s', 'read-only');
  else a.push('--dangerously-bypass-approvals-and-sandbox');
  if (ephemeral) a.push('--ephemeral');
  a.push('-C', workdir, '-o', lastMessagePath, prompt);
  return a;
}

export function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return { kind: 'other' }; }
  if (o?.type === 'thread.started' && o.thread_id) return { kind: 'session', sessionId: o.thread_id };
  if (o?.type === 'item.completed' && o.item?.type === 'agent_message') return { kind: 'message', text: String(o.item.text ?? '') };
  if (o?.type === 'turn.completed') return { kind: 'usage', usage: o.usage ?? {} };
  return { kind: 'other' };
}

export function startRun(config, args, { cwd, onEvent = () => {}, logPath }) {
  const child = spawn(config.codex.bin, [...config.codex.prefixArgs, ...args], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
