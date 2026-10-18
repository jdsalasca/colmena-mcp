function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return { kind: 'other' }; }
  if (o?.type === 'thread.started' && o.thread_id) return { kind: 'session', sessionId: o.thread_id };
  if (o?.type === 'item.completed' && o.item?.type === 'agent_message') return { kind: 'message', text: String(o.item.text ?? '') };
  if (o?.type === 'turn.completed') return { kind: 'usage', usage: o.usage ?? {} };
  // Verified against codex 0.162: tool items arrive as item.started/item.completed with item.type command_execution | file_change | mcp_tool_call | web_search.
  const item = o?.item;
  if ((o?.type === 'item.started' || o?.type === 'item.completed') && item?.type) {
    if (item.type === 'command_execution' && item.command) return { kind: 'tool', tool: `command: ${item.command}` };
    if (item.type === 'file_change') {
      const paths = (item.changes ?? []).map(c => c?.path).filter(Boolean);
      return { kind: 'tool', tool: `file_change: ${paths.slice(0, 3).join(', ') || 'patch'}` };
    }
    if (item.type === 'mcp_tool_call') return { kind: 'tool', tool: `mcp: ${[item.server, item.tool].filter(Boolean).join('.') || 'call'}` };
    if (item.type === 'web_search') return { kind: 'tool', tool: `web_search: ${item.query ?? ''}`.trim() };
  }
  return { kind: 'other' };
}

export const codexAdapter = {
  id: 'codex',
  parseLine,
  completesOn: event => event.kind === 'usage',
  cmd: config => config.codex,
  buildArgs({ prompt, workdir, lastMessagePath, readonly = false, resumeSessionId, ephemeral = false, worker }) {
    const a = ['--search', 'exec'];
    if (resumeSessionId) a.push('resume', resumeSessionId);
    a.push('--json', '--skip-git-repo-check', '-m', worker.model);
    if (worker.effort) a.push('-c', `model_reasoning_effort="${worker.effort}"`);
    // `exec resume` rejects -C and -s (verified on codex 0.162): the process already starts in workdir, and read-only goes through config.
    if (readonly) a.push(...(resumeSessionId ? ['-c', 'sandbox_mode="read-only"'] : ['-s', 'read-only']));
    else a.push('--dangerously-bypass-approvals-and-sandbox');
    if (ephemeral) a.push('--ephemeral');
    if (!resumeSessionId) a.push('-C', workdir);
    a.push('-o', lastMessagePath, prompt);
    return a;
  },
};
