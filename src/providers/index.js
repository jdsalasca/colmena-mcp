import { codexAdapter } from './codex.js';

const adapters = { codex: codexAdapter };

export function registerAdapter(adapter) { adapters[adapter.id] = adapter; }

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`proveedor desconocido: ${name} (disponibles: ${Object.keys(adapters).join(', ')})`);
  return a;
}
