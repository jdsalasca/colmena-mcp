import fs from 'node:fs';
import path from 'node:path';

// Verified against opencode 1.18.30: `run --format json` emits step_start{sessionID}, text{part.text}, step_finish{part.tokens, part.cost},
// and on provider failures error{error.name, error.data.message, error.data.isRetryable} (seen: UnknownError, APIError).
function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return { kind: 'other' }; }
  if (o?.type === 'step_start' && o.sessionID) return { kind: 'session', sessionId: o.sessionID };
  if (o?.type === 'text' && typeof o.part?.text === 'string') return { kind: 'message', text: o.part.text };
  if (o?.type === 'error') {
    const data = o.error?.data ?? {};
    const message = String(data.message || o.error?.name || 'error del proveedor');
    return { kind: 'error', message, retryable: data.isRetryable === true || message.includes('Unexpected server error') };
  }
  if (o?.type === 'step_finish' && o.part) {
    const t = o.part.tokens ?? {};
    const usage = { input_tokens: t.input ?? 0, output_tokens: t.output ?? 0, reasoning_tokens: t.reasoning ?? 0 };
    if (typeof o.part.cost === 'number') usage.cost_usd = o.part.cost;
    return { kind: 'usage', usage };
  }
  return { kind: 'other' };
}

export const opencodeAdapter = {
  id: 'opencode',
  parseLine,
  completesOn: () => false,
  cmd: config => config.opencode,
  env(config, { skills } = {}) {
    const env = {};
    const provider = config.settings.providers.opencode;
    if (provider.isolate_config) {
      const configDir = path.resolve(config.home, provider.config_dir ?? 'opencode-config');
      fs.mkdirSync(configDir, { recursive: true });
      env.XDG_CONFIG_HOME = configDir;
    }
    if (skills === 'off') env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1';
    return Object.keys(env).length ? env : undefined;
  },
  // --agent plan is OpenCode's read-only agent (verified: it refuses to write files even with --auto).
  buildArgs({ prompt, workdir, readonly = false, resumeSessionId, worker }) {
    const a = ['run', '--format', 'json', '--pure', '--auto', '-m', worker.model];
    if (worker.effort) a.push('--variant', worker.effort);
    if (readonly) a.push('--agent', 'plan');
    if (resumeSessionId) a.push('-s', resumeSessionId);
    a.push('--dir', workdir, prompt);
    return a;
  },
};
