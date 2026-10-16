export const REPORT_SUFFIX = `\n\n---\nFORMATO OBLIGATORIO DE TU MENSAJE FINAL (máximo 15 líneas, en español):\nRESULT: qué hiciste y el resultado\nFILES: archivos creados/modificados\nTESTS: qué pruebas corriste y su resultado real\nRISKS: riesgos, pendientes o dudas\nNo pegues código ni logs largos en el mensaje final; déjalos en los archivos.`;

const KEYS = ['RESULT', 'FILES', 'TESTS', 'RISKS'];

export function buildPrompt({ task, contextFiles = [], handoff = [] }) {
  let p = '';
  if (handoff.length) p += `## Contexto previo (resúmenes de otros agentes)\n${handoff.map((h, i) => `### Agente ${i + 1}\n${h}`).join('\n\n')}\n\n`;
  if (contextFiles.length) p += `## Archivos relevantes (léelos primero)\n${contextFiles.map(f => `- ${f}`).join('\n')}\n\n`;
  p += `## Tarea\n${task}`;
  return p + REPORT_SUFFIX;
}

export function parseReport(text) {
  const raw = typeof text === 'string' ? text : '';
  const re = /^(RESULT|FILES|TESTS|RISKS):[ \t]*/gm;
  const marks = [...raw.matchAll(re)];
  const sections = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    sections[m[1]] = raw.slice(m.index + m[0].length, end).trim();
  });
  const ok = KEYS.every(k => k in sections);
  return { ok, sections, text: ok ? raw.trim() : raw.trim().slice(0, 1500) };
}
