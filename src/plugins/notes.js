import { z } from 'zod';

export const NotesSchema = z.string().optional().describe('Objetivo del hito, decisiones y riesgos del orquestador');

export function notesText(notes, fallback = '') {
  if (typeof notes === 'string') return notes.trim() || fallback;
  if (notes == null) return fallback;
  return JSON.stringify(notes, null, 2);
}
