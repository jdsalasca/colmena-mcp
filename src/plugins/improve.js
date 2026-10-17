import path from 'node:path';

export const PENDING_FOCUSES = ['backlog', 'features', 'debt'];
export const IMPROVE_FOCUSES = [...PENDING_FOCUSES, 'all'];
export const IMPROVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IMPROVE_SUGGESTION = 'ronda cerrada: considera `improve` (debt/backlog/features)';

const GUIDE = {
  backlog: 'Ordena el backlog pendiente: trabajo ya identificado o a medio hacer (planes, TODOs reales, hallazgos previos en docs/backlog) que merezca ejecutarse pronto.',
  features: 'Propón nuevas features que aporten valor real: revisa lo que el repositorio promete (README, planes), los datos de uso disponibles y lo que falta para cerrar el ciclo.',
  debt: 'Ataca la deuda técnica: duplicación, código muerto, tests frágiles o faltantes, errores mal manejados, rendimiento, seguridad y documentación desactualizada.',
  all: 'Cubre las tres dimensiones en secciones separadas: backlog pendiente, nuevas features y deuda técnica.',
};

export function buildImprovePrompt(focus, { date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!IMPROVE_FOCUSES.includes(focus)) throw new Error(`focus '${focus}' no existe; usa: ${IMPROVE_FOCUSES.join(', ')}`);
  const file = `docs/backlog/${date}-${focus}.md`;
  return [
    `Mejora continua (${focus}) — informe en ${file}`,
    '',
    'Analiza este repositorio a fondo: lee el README y los planes/specs si existen, recorre src/, los tests y los scripts, y revisa `git log` para no proponer lo que ya está hecho.',
    '',
    `Escribe tu informe SOLO en ${file} (créalo tú; no modifiques código ni otros archivos).`,
    '',
    GUIDE[focus],
    '',
    'Formato del informe (markdown, en español):',
    `# Mejora continua ${date} (${focus})`,
    '## Resumen',
    '- ≤ 15 líneas con lo esencial.',
    '## Ítems priorizados',
    'Una ficha por ítem: id (MC-1, MC-2…), título, impacto (alto|medio|bajo), esfuerzo (S|M|L), riesgo, evidencia concreta (archivo/línea o dato) y un brief autocontenido listo para delegar: objetivo, archivos a tocar y criterio de aceptación verificable, exigiendo TDD red→green→refactor, código limpio y DRY, y reutilizar lo que ya existe.',
    '',
    'Al terminar responde con tu resumen en el formato obligatorio de reporte.',
  ].join('\n');
}

export const CONTINUOUS_IMPROVEMENT_PROMPT = `Cierra una ronda de colmena y deja lista la siguiente:
1. workers — mira qué workers están disponibles (presupuesto, fortalezas).
2. run_many — lanza los briefs en paralelo: objetivo, archivos y criterio de aceptación.
3. wait — espera a que terminen (máx. 600 s por defecto, hasta 1800 s si se configura wait_max_s; vuelve a esperar si sigue pendiente).
4. result + review/diff + verdict — valida cada job con evidencia y registra accepted/needs_work antes de fusionar nada.
5. merge — integra lo aprobado; usa cleanup para borrar worktrees y ramas colmena/*.
6. report — genera el HTML de cierre; su campo next te dice qué improve falta.
7. improve — lanza backlog/features/debt (o all) para levantar el backlog de la siguiente ronda y revisa docs/backlog/*.md al fusionar.
Repite el ciclo mientras queden ítems de alto impacto.`;

const normalize = p => (p == null ? '' : path.resolve(String(p)));
const sameCwd = (a, b) => {
  const [x, y] = [normalize(a), normalize(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export function recentFocuses(metas, { cwd, sinceMs = IMPROVE_WINDOW_MS, now = Date.now() } = {}) {
  return new Set(metas
    .filter(m => m.improveFocus && Number.isFinite(m.createdAt) && m.createdAt <= now && now - m.createdAt <= sinceMs && sameCwd(m.cwd, cwd))
    .map(m => m.improveFocus));
}

export function pendingFocuses(metas, opts) {
  const launched = recentFocuses(metas, opts);
  return launched.has('all') ? [] : PENDING_FOCUSES.filter(f => !launched.has(f));
}

export const pendingFocusesFor = (jm, cwd, opts) => pendingFocuses(jm.metas(), { cwd, ...opts });
export const hasRecentImprove = (jm, cwd, opts) => recentFocuses(jm.metas(), { cwd, ...opts }).size > 0;

export function improveNext(jm, cwd, opts) {
  const pending = pendingFocusesFor(jm, cwd, opts);
  return pending.length ? [IMPROVE_SUGGESTION, ...pending.map(f => `improve ${f}: sin lanzar en las últimas 24 h para ${cwd}`)] : [];
}
