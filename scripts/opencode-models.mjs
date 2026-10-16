// Lists OpenCode models with their reported list prices, cheapest output first. Used to pick workers (esp. max-hive).
// Usage: node scripts/opencode-models.mjs [--provider opencode-go] [--contributor] [--free] [--max-out 0.6] [--json]
import { execFileSync } from 'node:child_process';
import { findOpencode } from '../src/config.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const provider = opt('provider') ?? 'opencode-go';

const out = execFileSync(findOpencode(), ['models', provider, '--verbose'], { encoding: 'utf8', maxBuffer: 1 << 26 });
const parts = out.split(new RegExp(`^(${provider}/\\S+)\\s*$`, 'm'));
let rows = [];
for (let i = 1; i < parts.length; i += 2) {
  try {
    const j = JSON.parse(parts[i + 1].trim());
    rows.push({ id: parts[i], in: j.cost?.input ?? null, out: j.cost?.output ?? null, ctx: j.limit?.context ?? null, variants: Object.keys(j.variants ?? {}).join('/') });
  } catch { /* skip entries that are not JSON */ }
}
if (flag('contributor')) rows = rows.filter(r => /contributor/i.test(r.id));
if (flag('free')) rows = rows.filter(r => r.out === 0);
const maxOut = Number(opt('max-out'));
if (maxOut) rows = rows.filter(r => r.out != null && r.out <= maxOut);
rows.sort((a, b) => (a.out ?? Infinity) - (b.out ?? Infinity));

if (flag('json')) console.log(JSON.stringify(rows, null, 2));
else console.table(rows);
