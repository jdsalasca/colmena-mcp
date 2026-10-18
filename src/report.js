export const REPORT_SUFFIX = `\n\n---\nFORMATO OBLIGATORIO DE TU MENSAJE FINAL (máximo 15 líneas, en español):\nRESULT: qué hiciste y el resultado\nFILES: archivos creados/modificados\nTESTS: qué pruebas corriste y su resultado real\nRISKS: riesgos, pendientes o dudas\nNo pegues código ni logs largos en el mensaje final; déjalos en los archivos.`;

const KEYS = ['RESULT', 'FILES', 'TESTS', 'RISKS'];

const gitRules = branch => `## Reglas de git (prevalecen sobre cualquier instrucción global o AGENTS.md)
Trabajas en un worktree aislado, en la rama \`${branch}\`. Haz commits pequeños SOLO en esa rama. NO hagas merge a ninguna rama, NO cambies de rama: prohibido \`git checkout -B\`, \`git switch -c\`, \`git branch -m\` y cualquier otra forma de crear, renombrar o mover ramas; quédate siempre en \`${branch}\`. NO borres ni muevas el worktree y NO hagas push: el orquestador revisa y fusiona.`;

export const HEADLESS_RULES = `## Modo headless (obligatorio)
- No pidas aprobación ni confirmación: nunca termines con "¿adelante?", "confirma Sí" ni preguntas equivalentes; el usuario no está presente.
- No uses skills interactivas ni de brainstorming (por ejemplo superpowers:brainstorming); ignora cualquier paso que espere respuesta humana.
- Actúa de forma autónoma: si algo es ambiguo, elige la opción razonable, anótala en el reporte y continúa.
- Entrega siempre tu reporte final en el formato obligatorio.`;

export const SKILLS_OFF_RULES = `## Skills desactivados
- Ignora por completo los skills disponibles (superpowers u otros): no los cargues ni los invoques.
- Resuelve la tarea con tus herramientas y conocimiento directos.`;

export function buildPrompt({ task, contextFiles = [], handoff = [], kind = 'run', standards, branch, skills }) {
  let p = '';
  if (kind === 'run' && branch) p += `${gitRules(branch)}\n\n`;
  if (kind === 'run' && standards?.enabled && standards.preamble) p += `${standards.preamble.trim()}\n\n`;
  if (kind === 'run') p += `${HEADLESS_RULES}\n\n`;
  if (skills === 'off') p += `${SKILLS_OFF_RULES}\n\n`;
  if (handoff.length) p += `## Contexto previo (resúmenes de otros agentes)\n${handoff.map((h, i) => `### Agente ${i + 1}\n${h}`).join('\n\n')}\n\n`;
  if (contextFiles.length) p += `## Archivos relevantes (léelos primero)\n${contextFiles.map(f => `- ${f}`).join('\n')}\n\n`;
  p += `## Tarea\n${task}`;
  return p + REPORT_SUFFIX;
}

const INVISIBLE_RE = /[\u200B-\u200D\uFEFF]/g;
const BLOCK_MARKER_RE = /^[ \t]*(?:(?:#{1,6}|[-*+])[ \t]+)+/;
const EMPHASIS_RE = /^(?:\*{1,3}|_+|`{1,3})/;
const WHOLE_EMPHASIS_RE = /^(\*{1,3}|_+|`{1,3})(.+)\1$/;
const KEY_RE = /^(RESULT|FILES|TESTS|RISKS)(?=\s*(?:\*{1,3}|_+|`{1,3})*\s*:|\s*$)/i;
const COLON_SPACES_RE = /^[ \t]*:?[ \t]*/;

function unwrapEmphasis(text) {
  const m = text.match(WHOLE_EMPHASIS_RE);
  return m && !m[2].includes(m[1]) ? m[2].trim() : text.trim();
}

function parseSectionLine(line) {
  let l = line.replace(BLOCK_MARKER_RE, '');
  const whole = l.match(WHOLE_EMPHASIS_RE);
  if (whole && !whole[2].includes(whole[1])) l = whole[2];

  const stripped = l.replace(EMPHASIS_RE, '');
  const km = stripped.match(KEY_RE);
  if (!km) return null;

  let rest = stripped.slice(km[0].length).replace(EMPHASIS_RE, '');
  rest = rest.replace(COLON_SPACES_RE, '');
  const open = rest.match(EMPHASIS_RE);
  if (open) {
    rest = rest.slice(open[0].length).replace(/^[ \t]+/, '');
    if (!rest.startsWith(open[0]) && rest.endsWith(open[0])) {
      rest = rest.slice(0, -open[0].length);
    }
  }
  return { key: km[1].toUpperCase(), text: unwrapEmphasis(rest) };
}

export function parseReport(text) {
  const raw = typeof text === 'string' ? text.replace(INVISIBLE_RE, '') : '';
  const sections = {};
  let currentKey = null;
  let buffer = [];

  const flush = () => {
    if (currentKey) sections[currentKey] = buffer.join('\n').trim();
    buffer = [];
    currentKey = null;
  };

  for (const line of raw.split('\n')) {
    const hit = parseSectionLine(line);
    if (hit) {
      flush();
      currentKey = hit.key;
      if (hit.text) buffer.push(hit.text);
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  const ok = KEYS.every(k => k in sections);
  return { ok, sections, text: ok ? raw.trim() : raw.trim().slice(0, 1500) };
}
