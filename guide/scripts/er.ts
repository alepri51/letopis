/**
 * ER-схемы сервисов-примеров — из реестра, а не руками. Для каждого сервиса — свежая схема на базе примеров
 * (ENTITY_DSN), его модель (services/<имя>/src/models.mjs; у салона — сид booking), описания классов из реестра
 * подключения (`db.registry.all()`) и Mermaid erDiagram (kit/diagram.ts). Схема вставляется в страницу сервиса между метками
 * `<!-- er:<имя> -->` и `<!-- /er -->`; временные схемы удаляются.
 *   cd guide && npx tsx scripts/er.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { up, connect, syncModels } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { erDiagram } from '../kit/diagram.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERVICES = join(ROOT, '..', 'services');
const ADMIN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const check = process.argv.includes('--check');

/** Модель сервиса: фабрика из его src/models.mjs получает конструкторы letopis/model и zod. */
async function modelsOf(service: string, factory: string): Promise<unknown[]> {
  const mod = await import(pathToFileURL(join(SERVICES, service, 'src', 'models.mjs')).href);
  const out = mod[factory](model, z);
  return Array.isArray(out) ? out : Object.values(out);
}

const TARGETS: { service: string; seeds?: string[]; models?: () => Promise<unknown[]> }[] = [
  { service: 'salon', seeds: ['booking'] },
  { service: 'wallet', models: () => modelsOf('wallet', 'walletModels') },
  { service: 'helpdesk', models: () => modelsOf('helpdesk', 'helpdeskModels') },
  { service: 'documents', models: () => modelsOf('documents', 'documentModels') },
];

const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
const stale: string[] = [];
try {
  for (const t of TARGETS) {
    const schema = `er_${t.service}`;
    const r = await up({
      dsn: ADMIN, schema, fresh: true, quiet: true, seeds: t.seeds,
      tenant: { name: 'ER', user: { name: 'Схема', login: `er@${t.service}.example`, password: 'Er-diagram-2026!' } },
    });
    const db = await connect({ dsn: ADMIN, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true });
    try {
      if (t.models) await syncModels(db, (await t.models()) as never, { apply: true });
      await db.refresh();
      const { $mermaid } = erDiagram(db.registry.all());
      const file = join(ROOT, 'pages', 'services', `${t.service}.md`);
      const page = await readFile(file, 'utf8');
      const re = new RegExp(`(<!-- er:${t.service} -->)[\\s\\S]*?(<!-- /er -->)`);
      if (!re.test(page)) throw new Error(`er: в pages/services/${t.service}.md нет меток <!-- er:${t.service} --> … <!-- /er -->`);
      const eol = page.includes('\r\n') ? '\r\n' : '\n';
      const block = ['```mermaid', ...$mermaid.split('\n'), '```'].join(eol);
      const next = page.replace(re, (_m, open: string, close: string) => `${open}${eol}${block}${eol}${close}`);
      if (next !== page) {
        if (check) stale.push(`pages/services/${t.service}.md`);
        else await writeFile(file, next);
      }
      console.log(`${t.service}: классов на схеме ${$mermaid.split('\n').filter((l) => / \{$/.test(l)).length}${next !== page ? (check ? ' — устарела' : ' — обновлена') : ''}`);
    } finally {
      await db.close();
      await admin.unsafe(`drop schema if exists "${r.schema}" cascade`);
    }
  }
} finally {
  await admin.end();
}
if (stale.length) {
  console.error(`ER-схемы устарели: ${stale.join(', ')} — npx tsx scripts/er.ts`);
  process.exit(1);
}
