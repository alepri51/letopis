/**
 * ER-схемы сервисов-примеров — из реестра, а не руками. Для каждого сервиса — свежий дом на базе примеров (мастер-ключ
 * ENTITY_DSN): `setup()` с его моделью (services/<имя>/src/models.mjs; у салона — сид booking), квартира `ER`, описания
 * классов из реестра её корня (`me.registry.all()`) и Mermaid erDiagram (examples/_shared/diagram.ts). Схема
 * вставляется в страницу сервиса между метками `<!-- er:<имя> -->` и `<!-- /er -->`; временные дома сносит `demolish()`.
 * Имя дома — `<ER_PREFIX><сервис>`, по умолчанию `er_salon` и т. д.
 *   cd guide && npx tsx scripts/er.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, demolish, connect } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { erDiagram } from '../../examples/_shared/diagram.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERVICES = join(ROOT, '..', 'services');
const ADMIN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const PREFIX = process.env.ER_PREFIX ?? 'er_';
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

const stale: string[] = [];
for (const t of TARGETS) {
  const name = `${PREFIX}${t.service}`;
  // дом остался от прерванного прогона — снести: схема строится заново
  await demolish(ADMIN, name, { quiet: true });
  try {
    const r = await setup(ADMIN, name, {
      quiet: true, ...(t.seeds ? { seeds: t.seeds } : {}), ...(t.models ? { models: (await t.models()) as never } : {}),
    });
    const db = await connect(r.pass, { listen: false, cache: false });
    try {
      await db.createTenant('ER');
      const me = await db.in('ER');
      const { $mermaid } = erDiagram(me.registry.all());
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
    }
  } finally {
    await demolish(ADMIN, name, { quiet: true });
  }
}
if (stale.length) {
  console.error(`ER-схемы устарели: ${stale.join(', ')} — npx tsx scripts/er.ts`);
  process.exit(1);
}
