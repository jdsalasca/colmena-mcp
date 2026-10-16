import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './atomic-write.js';

export function createStore(config) {
  const jobDir = id => path.join(config.jobsDir, id);
  const metaPath = id => path.join(jobDir(id), 'meta.json');
  const write = (file, data) => writeFileAtomic(file, JSON.stringify(data, null, 2));
  return {
    newId: () => crypto.randomBytes(4).toString('hex'),
    jobDir,
    create(meta) {
      fs.mkdirSync(jobDir(meta.id), { recursive: true });
      write(metaPath(meta.id), meta);
      return meta;
    },
    get(id) {
      try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
    },
    update(id, patch) {
      const cur = this.get(id);
      if (!cur) throw new Error(`job ${id} no existe`);
      const next = { ...cur, ...patch };
      write(metaPath(id), next);
      return next;
    },
    remove(id) {
      fs.rmSync(jobDir(id), { recursive: true, force: true });
    },
    list({ state, limit } = {}) {
      let ids = [];
      try { ids = fs.readdirSync(config.jobsDir); } catch { return []; }
      let jobs = ids.map(i => this.get(i)).filter(Boolean);
      if (state) jobs = jobs.filter(j => j.state === state);
      jobs.sort((a, b) => (b.createdAt - a.createdAt) || (b.id > a.id ? 1 : -1));
      return limit ? jobs.slice(0, limit) : jobs;
    },
    audit(entry) {
      fs.mkdirSync(path.dirname(config.auditPath), { recursive: true });
      fs.appendFileSync(config.auditPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
    },
  };
}
