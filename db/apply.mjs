#!/usr/bin/env node
/**
 * Тонкая обёртка над up() (план, этап 6, п. 9) для CI и бенчей: поставить или обновить установку.
 *
 *   node db/apply.mjs --dsn=postgres://user:pass@host:5432/db --schema=salon [--seed=booking] [--fresh]
 *     [--upgrade] [--quiet]
 *
 * Берёт исходники через tsx из lib/node_modules, без них — собранный пакет (lib/dist).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = { seed: [] };
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  if (m[1] === 'seed') args.seed.push(m[2]);
  else args[m[1]] = m[2] ?? true;
}
const dsn = args.dsn ?? process.env.ENTITY_DSN;
if (!dsn || typeof args.schema !== 'string') {
  console.error('usage: node db/apply.mjs --dsn=postgres://… --schema=<имя | v2.имя> [--seed=<имя|путь>]… [--fresh] [--upgrade] [--quiet]');
  process.exit(2);
}

// в репозитории — исходники через tsx (сборка lib/dist может отстать), без них — собранный пакет
let mod;
try {
  const req = createRequire(new URL('../lib/package.json', import.meta.url));
  const { register } = await import(pathToFileURL(req.resolve('tsx/esm/api')).href);
  register();
  mod = await import('../lib/src/up.ts');
} catch {
  mod = await import('../lib/dist/up.js');
}

try {
  const r = await mod.up({
    dsn, schema: args.schema, seeds: args.seed, fresh: Boolean(args.fresh), upgrade: Boolean(args.upgrade),
    quiet: Boolean(args.quiet),
  });
  console.log(JSON.stringify({ schema: r.schema, revision: r.revision, created: r.created, upgraded: r.upgraded, serviceKey: r.serviceKey }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
