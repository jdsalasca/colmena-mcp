import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const Worker = z.object({
  provider: z.enum(['codex', 'opencode']),
  model: z.string().min(1),
  effort: z.string().optional(),
  priority: z.number().default(10),
  strengths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  budget: z.object({ monthly_usd: z.number().positive() }).optional(),
  price_per_mtok: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
});

const Roles = z.object({ reporter: z.string(), summarizer: z.string(), reviewer: z.string() });
const Defaults = z.object({ worker: z.string(), max_parallel: z.number().int().positive().default(4), timeout_min: z.number().positive().default(60) });
const Notify = z.object({
  enabled: z.boolean().default(true),
  on: z.array(z.enum(['start', 'finish', 'fail'])).default(['start', 'finish', 'fail']),
  heartbeat_min: z.number().positive().default(10),
});
const Report = z.object({ enabled: z.boolean().default(true), default_style: z.string().default('papercraft') });

export const DEFAULT_SETTINGS = {
  workers: {
    'luna-max': { provider: 'codex', model: 'gpt-6-luna', effort: 'max', priority: 1, strengths: ['code', 'refactor', 'tests'] },
    'deepseek-pro': { provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', effort: 'max', priority: 2, strengths: ['code'] },
    'deepseek-flash': { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', priority: 3, strengths: ['docs', 'summary', 'report'] },
  },
  roles: { reporter: 'deepseek-flash', summarizer: 'deepseek-flash', reviewer: 'luna-max' },
  defaults: { worker: 'luna-max', max_parallel: 4, timeout_min: 60 },
  plugins: { notify: {}, report: {} },
};

const fmt = err => err.issues.map(i => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');

export function loadSettings(home, env = process.env) {
  const file = env.COLMENA_CONFIG || path.join(home, 'colmena.yml');
  let user = {};
  if (fs.existsSync(file)) {
    try { user = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; }
    catch (e) { throw new Error(`colmena.yml inválido (${file}): ${e.message.split('\n')[0]}`); }
  }
  const merged = {
    workers: user.workers ?? DEFAULT_SETTINGS.workers,
    roles: { ...DEFAULT_SETTINGS.roles, ...(user.roles ?? {}) },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(user.defaults ?? {}) },
    plugins: {
      notify: { ...DEFAULT_SETTINGS.plugins.notify, ...(user.plugins?.notify ?? {}) },
      report: { ...DEFAULT_SETTINGS.plugins.report, ...(user.plugins?.report ?? {}) },
    },
  };
  const schema = z.object({
    workers: z.record(z.string(), Worker).refine(w => Object.keys(w).length > 0, 'debe haber al menos un worker'),
    roles: Roles, defaults: Defaults,
    plugins: z.object({ notify: Notify, report: Report }),
  });
  const r = schema.safeParse(merged);
  if (!r.success) throw new Error(`colmena.yml inválido (${file}): ${fmt(r.error)}`);
  const s = r.data;
  const names = Object.keys(s.workers);
  const check = (field, alias) => { if (!s.workers[alias]) throw new Error(`colmena.yml inválido (${file}): ${field}: worker '${alias}' no existe (workers: ${names.join(', ')})`); };
  check('defaults.worker', s.defaults.worker);
  for (const [k, v] of Object.entries(s.roles)) check(`roles.${k}`, v);
  return s;
}
