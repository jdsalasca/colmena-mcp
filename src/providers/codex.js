function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return { kind: 'other' }; }
  if (o?.type === 'thread.started' && o.thread_id) return { kind: 'session', sessionId: o.thread_id };
  if (o?.type === 'item.completed' && o.item?.type === 'agent_message') return { kind: 'message', text: String(o.item.text ?? '') };
  if (o?.type === 'turn.completed') return { kind: 'usage', usage: o.usage ?? {} };
  return { kind: 'other' };
}

export const codexAdapter = {
  id: 'codex',
  parseLine,
  cmd: config => config.codex,
  buildArgs({ prompt, workdir, lastMessagePath, readonly = false, resumeSessionId, ephemeral = false, worker }) {
    const a = ['--search', 'exec'];
    if (resumeSessionId) a.push('resume', resumeSessionId);
    a.push('--json', '--skip-git-repo-check', '-m', worker.model);
    if (worker.effort) a.push('-c', `model_reasoning_effort="${worker.effort}"`);
    if (readonly) a.push('-s', 'read-only');
    else a.push('--dangerously-bypass-approvals-and-sandbox');
    if (ephemeral) a.push('--ephemeral');
    a.push('-C', workdir, '-o', lastMessagePath, prompt);
    return a;
  },
};
