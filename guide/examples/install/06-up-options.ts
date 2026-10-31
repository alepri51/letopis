import { fileURLToPath } from 'node:url';
import { up } from 'letopis';
import { End, one, hub, normalizeSchema, translatePattern } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../lib/sql/migrate', import.meta.url));

export default example({
  title: 'Опции up(): свой пул, роли, миграции, первый арендатор, режим сигналов none',
  summary:
    'up() может работать через готовый пул postgres.js (sql), с другими именами ролей (owner, app), своим ' +
    'каталогом миграций (migrationsDir) и сразу завести первого арендатора (tenant). Режим сигналов none — для ' +
    'пулов в режиме транзакций (PgBouncer): база не шлёт сигналы (NOTIFY), поэтому кэш выключен — включить его можно ' +
    'только по сроку (ttlOnly).',
  setup: 'none',
  tables: ['counts'],
  covers: ['up.sql', 'up.tenant', 'up.owner', 'up.app', 'up.migrationsDir', 'signals.none', 'model.End', 'model.normalizeSchema', 'model.translatePattern'],
  steps: [
    {
      title: 'Установка через готовый пул, с ролями по умолчанию и первым арендатором',
      run: async ({ admin, schema }) => {
        const r = await up({
          sql: admin as never, schema, fresh: true, quiet: true, owner: 'letopis_owner', app: 'letopis_app', migrationsDir: MIGRATIONS,
          signals: 'none', tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } },
        });
        return { created: r.created, revision: r.revision, 'арендатор создан': r.tenant!.created, signals: (r as { signals?: string }).signals ?? 'none' };
      },
    },
    {
      title: 'Режим none: подключение не слушает сигналы, кэш выключен',
      run: async ({ connect, dsn, schema }) => {
        const r = await up({ dsn: dsn.admin, schema, quiet: true, tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } } });
        const db = await connect({ dsn: dsn.app, schema, token: r.tenant!.token! });
        return { 'кэш включён': db.cache.stats().enabled, 'слушателей': db.cache.stats().listens };
      },
    },
    {
      title: 'Помощники схемы из letopis/model',
      text: '`one(…)` и `many(…)` — концы (`End`); `normalizeSchema` приводит JSON Schema к виду, который понимает база; `translatePattern` переводит регулярное выражение в синтаксис jsonpath.',
      run: async () => {
        const Shop = hub('Shop', { name: z.string() }, { key: ['name'] });
        return {
          'one(Shop) — End': one(Shop) instanceof End,
          'normalizeSchema': normalizeSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 1 } } }),
          'translatePattern': translatePattern('^\\d{3}$'),
        };
      },
    },
  ],
});
