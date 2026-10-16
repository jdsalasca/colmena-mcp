import fs from 'node:fs';
import crypto from 'node:crypto';

export function writeFileAtomic(file, data, dependencies = {}) {
  const writeFileSync = dependencies.writeFileSync ?? fs.writeFileSync;
  const renameSync = dependencies.renameSync ?? fs.renameSync;
  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const unlinkSync = dependencies.unlinkSync ?? fs.unlinkSync;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    writeFileSync(temporary, data);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
