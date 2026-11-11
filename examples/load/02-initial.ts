import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { example } from '../_shared/example.ts';
import { cli } from '../_shared/cli.ts';
import { shopModels } from '../_shared/shop.ts';

let dir: string, file: string;

export default example({
  title: 'Первая заливка: letopis load --initial',
  summary:
    'Для переезда с другой системы: пустой дом, одна транзакция, COPY без построчных триггеров и индексов — их база ' +
    'включает в конце и тогда же проверяет всё разом. Быстрее обычной загрузки в разы.',
  models: shopModels,
  tables: ['counts'],
  covers: ['cli.load', 'error.not_empty', 'nuance.initial-empty-schema'],
  steps: [
    {
      title: 'Дом с моделью — данных ещё нет',
      text:
        'Дом построен с моделью магазина, в нём квартира «Ромашка» и её жилец Анна — всё это строки системных классов ' +
        '(`Class`, `Account`, `member`, `Resource`, `rule`): первой заливке они не мешают. Данных нет. Файл заливки — ' +
        'магазин и 300 товаров, объект JSON на строку.',
      run: async ({ me }) => {
        dir = await mkdtemp(join(tmpdir(), 'letopis-initial-'));
        file = join(dir, 'shop.ndjson');
        const rows = [
          { $class: 'Shop', name: 'Ромашка', city: 'Казань' },
          ...Array.from({ length: 300 }, (_, i) => ({ $class: 'Product', sku: `P-${i + 1}`, title: `Товар ${i + 1}`, price: 100 + i, Shop: { $key: ['Ромашка'] } })),
        ];
        await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n'));
        return { 'магазинов': await me.Shop().count(), 'товаров': await me.Product().count(), 'строк в файле': rows.length };
      },
    },
    {
      title: 'Залить магазин и 300 товаров',
      text:
        '`--initial` — одна транзакция под исключительной блокировкой таблиц: на время заливки дом закрыт и для чтения. ' +
        'Индексы и триггеры сняты, строки идут через `COPY … FREEZE`; в конце база возвращает индексы и триггеры, ' +
        'разом проверяет ограничения и собирает статистику. Любая ошибка откатывает всё. Анна сразу видит товары.',
      run: async ({ ADMIN_DSN, name, me }) => {
        const r = await cli(['load', file, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--initial']);
        return { 'код выхода': r.code, 'отчёт': JSON.parse(r.out), 'товаров у Анны': await me.Product().count() };
      },
    },
    {
      title: 'Вторая первая заливка — not_empty',
      text:
        'Дом должен быть пустым: кроме строк системных классов — ничего. Теперь в нём магазин и товары, поэтому ' +
        '`--initial` отказывает `not_empty`, и ничего не меняется. Дописывать в непустой дом — обычной загрузкой, без ' +
        '`--initial`.',
      run: async ({ ADMIN_DSN, name }) => {
        const r = await cli(['load', file, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--initial']);
        await rm(dir, { recursive: true, force: true });
        return { 'код выхода': r.code, 'ошибка': r.err.split('\n').find((l) => /^letopis: [a-z_]+: /.test(l)) ?? r.err };
      },
    },
  ],
});
