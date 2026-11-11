#!/usr/bin/env node
/**
 * Тонкая обёртка над setup() для CI, бенчей и ручной работы: построить или достроить дом и получить его пропуск.
 *
 *   node db/apply.mjs --dsn=<мастер-ключ> --schema=<дом> [--seed=<имя|путь>]… [--default-rule=deny|allow] [--rotate]
 *     [--fresh] [--quiet]
 *   node db/apply.mjs --dsn=<мастер-ключ> --schema=<дом> --demolish
 *
 * --dsn — мастер-ключ (строка подключения администратора PostgreSQL; без флага — ENTITY_DSN); --schema — имя дома
 * (shop или v2.shop). --fresh — снести дом (demolish) и построить заново; --demolish — только снести; --rotate — новый
 * пропуск (прежний сразу перестаёт работать). Вывод — строка JSON: { schema, revision, created, pass } (pass — пропуск
 * консьержа, секрет: строка подключения его роли с ключом) или { schema, dropped }.
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
const USAGE = 'usage: node db/apply.mjs --dsn=<мастер-ключ> --schema=<дом | v2.дом> [--seed=<имя|путь>]… [--default-rule=deny|allow] [--rotate] [--fresh] [--quiet] | --demolish';
if (!dsn || typeof args.schema !== 'string') {
  console.error(USAGE);
  process.exit(2);
}
const name = args.schema.replace(/^v\d+\./, '');
if (args['default-rule'] !== undefined && !['deny', 'allow'].includes(args['default-rule'])) {
  console.error(USAGE);
  process.exit(2);
}

// в репозитории — исходники через tsx (сборка lib/dist может отстать), без них — собранный пакет
let mod;
try {
  const req = createRequire(new URL('../lib/package.json', import.meta.url));
  const { register } = await import(pathToFileURL(req.resolve('tsx/esm/api')).href);
  register();
  mod = await import('../lib/src/index.ts');
} catch {
  mod = await import('../lib/dist/index.js');
}

try {
  if (args.demolish || args.fresh) {
    const d = await mod.demolish(dsn, name, { quiet: true });
    if (args.demolish) {
      console.log(JSON.stringify(d));
      process.exit(0);
    }
  }
  const r = await mod.setup(dsn, name, {
    ...(args.seed.length ? { seeds: args.seed } : {}),
    ...(args['default-rule'] ? { defaultRule: args['default-rule'] } : {}),
    ...(args.rotate ? { rotate: true } : {}),
    quiet: Boolean(args.quiet),
  });
  console.log(JSON.stringify({ schema: r.schema, revision: r.revision, created: r.created, pass: r.pass }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
