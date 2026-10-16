import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';

const adapters = { codex: codexAdapter, opencode: opencodeAdapter };

export function registerAdapter(adapter) { adapters[adapter.id] = adapter; }

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) throw new Error(`proveedor desconocido: ${name} (disponibles: ${Object.keys(adapters).join(', ')})`);
  return a;
}
