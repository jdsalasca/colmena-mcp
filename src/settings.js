import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const DEFAULT_STANDARDS_PREAMBLE = `## Estándares de trabajo
- Aplica TDD en ciclos red → green → refactor: escribe primero una prueba que falle por la razón correcta, luego el código mínimo y después refactoriza.
- Mantén el código limpio y DRY; busca y reutiliza lo que ya existe antes de escribir helpers o lógica nuevos.
- Verifica cada resultado con pruebas o comandos y reporta evidencia real; no afirmes éxito sin comprobarlo.
- Si están disponibles, usa los skills de superpowers para TDD y verificación antes de completar.
- Respeta el formato obligatorio de reporte RESULT/FILES/TESTS/RISKS incluido al final del brief.`;

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
const Standards = z.object({ enabled: z.boolean().default(true), preamble: z.string().min(1).default(DEFAULT_STANDARDS_PREAMBLE) });
const Providers = z.object({
  opencode: z.object({ isolate_config: z.boolean().default(true), config_dir: z.string().min(1).optional() }),
});

export const DEFAULT_SETTINGS = {
  workers: {
    'luna-max': { provider: 'codex', model: 'gpt-6-luna', effort: 'max', priority: 1, strengths: ['code', 'refactor', 'tests'] },
    // OpenCode Go flagship: DeepSeek V4.1 Flash ($0.15 in / $0.60 out per Mtok). Never Luna through OpenCode (owner's rule).
    'ds-flash': { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', priority: 2, strengths: ['code', 'docs', 'summary', 'report'], budget: { monthly_usd: 10 } },
    // max-hive: massive parallel bulk work at ~zero cost on a Go "contributor" model (no zero data retention). See README "max-hive".
    'max-hive': { provider: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor', effort: 'high', priority: 9, strengths: ['bulk'], budget: { monthly_usd: 5 } },
  },
  roles: { reporter: 'ds-flash', summarizer: 'ds-flash', reviewer: 'luna-max' },
  defaults: { worker: 'luna-max', max_parallel: 4, timeout_min: 60 },
  plugins: { notify: {}, report: {} },
  standards: { enabled: true, preamble: DEFAULT_STANDARDS_PREAMBLE },
  providers: { opencode: { isolate_config: true } },
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
    standards: user.standards == null ? DEFAULT_SETTINGS.standards
      : typeof user.standards === 'object' && !Array.isArray(user.standards)
        ? { ...DEFAULT_SETTINGS.standards, ...user.standards }
        : user.standards,
    providers: user.providers == null ? DEFAULT_SETTINGS.providers
      : typeof user.providers === 'object' && !Array.isArray(user.providers)
        ? {
            ...DEFAULT_SETTINGS.providers,
            ...user.providers,
            opencode: user.providers.opencode == null ? DEFAULT_SETTINGS.providers.opencode
              : typeof user.providers.opencode === 'object' && !Array.isArray(user.providers.opencode)
                ? { ...DEFAULT_SETTINGS.providers.opencode, ...user.providers.opencode }
                : user.providers.opencode,
          }
        : user.providers,
  };
  const schema = z.object({
    workers: z.record(z.string(), Worker).refine(w => Object.keys(w).length > 0, 'debe haber al menos un worker'),
    roles: Roles, defaults: Defaults,
    plugins: z.object({ notify: Notify, report: Report }),
    standards: Standards,
    providers: Providers,
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
