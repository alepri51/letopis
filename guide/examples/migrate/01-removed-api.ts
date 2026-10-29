import { connect, uuidv7, LETOPIS_NS } from 'letopis';
import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

/** Вызвать снятое API: ошибка removed и подсказка, чем заменить. */
async function tryIt(api: string, fn: () => unknown) {
  try {
    await fn();
    return { api, 'ошибка': 'нет' };
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { api, code: err.code ?? null, 'что вместо': err.message.replace(/^letopis: removed: /, '').slice(0, 150) };
  }
}
const any = (x: unknown) => x as Record<string, (...a: unknown[]) => unknown> & Db;

export default example({
  title: 'Снятое в 1.0 API: что вызвать вместо',
  summary:
    'Код с 0.21 не ломается молча: снятые методы, опции и экспорты бросают ошибку removed с подсказкой замены. ' +
    'Пройдитесь по ним — и перенос сведётся к замене вызовов по подсказкам.',
  tables: [],
  covers: [
    'removed.account', 'removed.execute', 'removed.run', 'removed.batch.execute', 'removed.compact', 'removed.reloadSchema',
    'removed.db.acl.reload', 'removed.db.auth.sessions(store)', 'removed.watch(cb) и watch(класс, cb)', 'removed.load({ trust })',
    'removed.uuidv7', 'removed.LETOPIS_NS', 'removed.фасад db.<…>',
    'removed.опция connect({ container })', 'removed.опция connect({ dataDir })', 'removed.опция connect({ enforceAccount })',
    'removed.опция connect({ enforceAcl })', 'removed.опция connect({ image })', 'removed.опция connect({ partition })',
    'removed.опция connect({ redisPort })', 'removed.опция connect({ version })',
    'chain.account', 'chain.execute', 'chain.run', 'db.compact', 'db.reloadSchema', 'db.accounts', 'db.credentials', 'db.resources', 'db.rules',
    'export.uuidv7', 'export.LETOPIS_NS', 'error.removed',
  ],
  steps: [
    {
      title: 'Методы цепочки и объекта db',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        return [
          await tryIt('db.Shop().account(…)', () => any(db.Shop()).account('x')),
          await tryIt('db.Shop().execute()', () => any(db.Shop()).execute()),
          await tryIt('db.Shop().run()', () => any(db.Shop()).run()),
          await tryIt('db.batch(…).execute()', () => any(db.batch('b')).execute()),
          await tryIt('db.compact()', () => any(db).compact()),
          await tryIt('db.reloadSchema()', () => any(db).reloadSchema()),
          await tryIt('db.acl.reload()', () => (db.acl as unknown as { reload: () => unknown }).reload()),
          await tryIt('db.auth.sessions', () => (db.auth as unknown as { sessions: unknown }).sessions),
          await tryIt('db.watch(cb)', () => (db.watch as unknown as (cb: () => void) => unknown)(() => {})),
          await tryIt('db.load(…, { trust })', () => db.load([], { trust: true } as never)),
          await tryIt('db.accounts (и credentials, resources, rules)', () => any(db).accounts),
        ];
      },
    },
    {
      title: 'Экспорты',
      run: async () => [
        await tryIt('uuidv7()', () => uuidv7()),
        await tryIt('LETOPIS_NS', () => String((LETOPIS_NS as unknown as { x: string }).x)),
      ],
    },
    {
      title: 'Опции connect()',
      text: 'Разделение установок — схемами `v2.<имя>`, изоляция арендаторов и права включены всегда, Docker и Redis не нужны.',
      run: async ({ dsn, schema, up }) => {
        const out = [];
        for (const opt of ['container', 'dataDir', 'enforceAccount', 'enforceAcl', 'image', 'partition', 'redisPort', 'version']) {
          out.push(await tryIt(`connect({ ${opt} })`, () => connect({ dsn: dsn.app, schema, token: up.tenant!.token!, [opt]: 'x' } as never)));
        }
        return out;
      },
    },
  ],
});
