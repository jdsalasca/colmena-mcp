import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const fakeCodex = path.join(here, 'fake-codex.js');
export const fakeOpencode = path.join(here, 'fake-opencode.js');
export const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A COLMENA_HOME whose colmena.yml routes EVERYTHING to the fake codex provider, so tests never launch real agents.
export function codexOnlyHome(extraYaml = '') {
  const home = tmp('colmena-h-');
  fs.writeFileSync(path.join(home, 'colmena.yml'), `
workers:
  luna-max: {provider: codex, model: gpt-6-luna, effort: max, priority: 1, strengths: [code]}
  alt: {provider: codex, model: gpt-alt, effort: high, priority: 2}
roles: {reporter: luna-max, summarizer: luna-max, reviewer: luna-max}
defaults: {worker: luna-max}
plugins:
  notify: {enabled: false}
${extraYaml}`);
  return home;
}

export const baseEnv = (home = codexOnlyHome(), extra = {}) => ({ COLMENA_HOME: home, COLMENA_CODEX_BIN: fakeCodex, COLMENA_NOTIFIER: 'none', ...extra });
