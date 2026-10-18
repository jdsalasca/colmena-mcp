import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const DEFAULT_STANDARDS_PREAMBLE = `## Estándares de trabajo
- Aplica TDD en ciclos red → green → refactor: escribe primero una prueba que falle por la razón correcta, luego el código mínimo y después refactoriza.
- Mantén el código limpio y DRY; busca y reutiliza lo que ya existe antes de escribir helpers o lógica nuevos.
- Verifica cada resultado con pruebas o comandos y reporta evidencia real; no afirmes éxito sin comprobarlo.
- Tienes internet por defecto (búsqueda web en vivo / webfetch): consulta documentación y versiones actuales cuando dependas de una API o dato externo, y cita la fuente.
- No crees archivos de plan, notas, capturas ni temporales dentro del repositorio fuera de los entregables pedidos; usa una carpeta temporal fuera del repo para capturas.
- Si están disponibles, usa los skills de superpowers para TDD y verificación antes de completar (nunca skills interactivas ni de brainstorming: trabajas en modo headless).
- No busques fuera del repositorio ni sobre la raíz del disco (nada de \`find /\`, \`dir C:\\\\ /s\`, \`Get-ChildItem C:\\\\ -Recurse\`); si falta \`node_modules\` ejecuta \`npm ci\` en tu worktree.
- Respeta el formato obligatorio de reporte RESULT/FILES/TESTS/RISKS incluido al final del brief.`;

const Worker = z.object({
  provider: z.enum(['codex', 'opencode']),
  model: z.string().min(1),
  effort: z.string().optional(),
  priority: z.number().default(10),
  strengths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  free: z.boolean().default(false),
  budget: z.object({ monthly_usd: z.number().positive() }).optional(),
  reserve_usd: z.number().nonnegative().optional(),
  price_per_mtok: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).optional(),
});

const Roles = z.object({ reporter: z.string(), summarizer: z.string(), reviewer: z.string(), presenter: z.string() });
export const MixWeights = z.record(z.string(), z.number().int().positive()).refine(mix => Object.keys(mix).length > 0, 'debe incluir al menos un worker');
export const ProfileProvider = z.enum(['auto', 'codex', 'opencode']);
const Profile = z.union([
  z.object({ mix: MixWeights }).strict(),
  z.object({ provider: ProfileProvider }).strict(),
]);
const Defaults = z.object({
  worker: z.string(), max_parallel: z.number().int().positive().default(4), timeout_min: z.number().positive().default(60),
  exit_grace_s: z.number().positive().default(20), retry_transient: z.number().int().nonnegative().default(1), wait_max_s: z.number().int().positive().max(1800).default(600),
  stall_timeout_min: z.number().nonnegative().default(15),
  cancel_jobs_on_shutdown: z.boolean().default(false),
  reserve_usd: z.number().nonnegative().default(0),
});
const Preferences = z.object({ provider: z.enum(['auto', 'codex', 'opencode']).default('auto'), profile: z.string().min(1).optional() });
const Notify = z.object({
  enabled: z.boolean().default(true),
  on: z.array(z.enum(['start', 'finish', 'fail'])).default(['start', 'finish', 'fail']),
  heartbeat_min: z.number().positive().default(10),
  budget_pct: z.number().int().min(0).max(100).default(80),
});
const Report = z.object({ enabled: z.boolean().default(true), default_style: z.string().default('papercraft') });
const Present = z.object({ enabled: z.boolean().default(true), default_style: z.string().default('papercraft-deck') });
const Improve = z.object({ enabled: z.boolean().default(true), hints: z.boolean().default(true) });
const Widget = z.object({ enabled: z.boolean().default(true) });
const Standards = z.object({ enabled: z.boolean().default(true), preamble: z.string().min(1).default(DEFAULT_STANDARDS_PREAMBLE) });
const Worktree = z.object({
  setup: z.string().min(1).optional(),
  setup_timeout_min: z.number().positive().default(10),
});
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
  roles: { reporter: 'ds-flash', summarizer: 'ds-flash', reviewer: 'luna-max', presenter: 'luna-max' },
  defaults: { worker: 'luna-max', max_parallel: 4, timeout_min: 60, exit_grace_s: 20, retry_transient: 1, wait_max_s: 600, stall_timeout_min: 15, cancel_jobs_on_shutdown: false, reserve_usd: 0 },
  preferences: { provider: 'auto' },
  profiles: {},
  plugins: { notify: {}, report: {}, present: {}, improve: {}, widget: {} },
  standards: { enabled: true, preamble: DEFAULT_STANDARDS_PREAMBLE },
  worktree: {},
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
    // A config that defines its own workers cannot be expected to know the default presenter alias: use its default worker.
    roles: {
      ...DEFAULT_SETTINGS.roles,
      ...(user.workers && !user.roles?.presenter ? { presenter: (user.defaults ?? {}).worker ?? DEFAULT_SETTINGS.defaults.worker } : {}),
      ...(user.roles ?? {}),
    },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(user.defaults ?? {}) },
    preferences: user.preferences == null ? DEFAULT_SETTINGS.preferences
      : typeof user.preferences === 'object' && !Array.isArray(user.preferences)
        ? { ...DEFAULT_SETTINGS.preferences, ...user.preferences }
        : user.preferences,
    profiles: user.profiles ?? DEFAULT_SETTINGS.profiles,
    plugins: {
      notify: { ...DEFAULT_SETTINGS.plugins.notify, ...(user.plugins?.notify ?? {}) },
      report: { ...DEFAULT_SETTINGS.plugins.report, ...(user.plugins?.report ?? {}) },
      present: { ...DEFAULT_SETTINGS.plugins.present, ...(user.plugins?.present ?? {}) },
      improve: { ...DEFAULT_SETTINGS.plugins.improve, ...(user.plugins?.improve ?? {}) },
      widget: { ...DEFAULT_SETTINGS.plugins.widget, ...(user.plugins?.widget ?? {}) },
    },
    standards: user.standards == null ? DEFAULT_SETTINGS.standards
      : typeof user.standards === 'object' && !Array.isArray(user.standards)
        ? { ...DEFAULT_SETTINGS.standards, ...user.standards }
        : user.standards,
    worktree: user.worktree == null ? DEFAULT_SETTINGS.worktree
      : typeof user.worktree === 'object' && !Array.isArray(user.worktree)
        ? { ...DEFAULT_SETTINGS.worktree, ...user.worktree }
        : user.worktree,
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
    roles: Roles, defaults: Defaults, preferences: Preferences, profiles: z.record(z.string().min(1), Profile),
    plugins: z.object({ notify: Notify, report: Report, present: Present, improve: Improve, widget: Widget }),
    standards: Standards,
    worktree: Worktree,
    providers: Providers,
  }).superRefine((settings, ctx) => {
    const names = Object.keys(settings.workers);
    for (const [profileName, profile] of Object.entries(settings.profiles)) {
      if (!profile.mix) continue;
      for (const alias of Object.keys(profile.mix)) {
        if (!Object.hasOwn(settings.workers, alias)) ctx.addIssue({
          code: 'custom', path: ['profiles', profileName, 'mix', alias],
          message: `worker '${alias}' no existe (workers: ${names.join(', ')})`,
        });
      }
    }
    const activeProfile = settings.preferences.profile;
    if (activeProfile && !Object.hasOwn(settings.profiles, activeProfile)) ctx.addIssue({
      code: 'custom', path: ['preferences', 'profile'],
      message: `perfil '${activeProfile}' no existe (profiles: ${Object.keys(settings.profiles).join(', ') || 'ninguno'})`,
    });
  });
  const r = schema.safeParse(merged);
  if (!r.success) throw new Error(`colmena.yml inválido (${file}): ${fmt(r.error)}`);
  const s = r.data;
  const names = Object.keys(s.workers);
  const check = (field, alias) => { if (!Object.hasOwn(s.workers, alias)) throw new Error(`colmena.yml inválido (${file}): ${field}: worker '${alias}' no existe (workers: ${names.join(', ')})`); };
  check('defaults.worker', s.defaults.worker);
  for (const [k, v] of Object.entries(s.roles)) check(`roles.${k}`, v);
  return s;
}
