import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { example } from '../_shared/example.ts';
import { cli } from '../_shared/cli.ts';
import { shopModels } from '../_shared/shop.ts';

let dir: string;
// конец товара на магазин — ключом магазина: id цели загрузчик вычислит сам
const shop = { $key: ['Ромашка'] };

/** Файл NDJSON во временной папке: объект JSON на строку. */
async function ndjson(file: string, rows: Record<string, unknown>[]): Promise<string> {
  const path = join(dir, file);
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n'));
  return path;
}

/** Итог команды: отчёт загрузки (строка JSON в stdout) или текст ошибки из stderr. */
function result(r: { code: number; out: string; err: string }) {
  if (r.code === 0) return { 'код выхода': 0, 'отчёт': JSON.parse(r.out) };
  return { 'код выхода': r.code, 'ошибка': r.err.split('\n').find((l) => /^letopis: [a-z_]+: /.test(l)) ?? r.err };
}

export default example({
  title: 'Массовая загрузка: letopis load — файлы, концы по ключу, повторы, история',
  summary:
    'letopis load пишет тысячи строк пачками через COPY — команду PostgreSQL для быстрой массовой вставки, а данные ' +
    'проверяет тем же описанием классов, что и база. Вход — файлы NDJSON: объект JSON на строку, класс — в $class, цель ' +
    'конца — её ключ { $key } или внешний ключ { $ext }. Загрузка — служебная команда: мастер-ключом и в квартиру, ' +
    'названную явно (--tenant).',
  models: shopModels,
  tables: ['counts'],
  covers: [
    'cli.load', 'error.duplicate', 'error.exists', 'error.deleted', 'error.class_not_loadable', 'error.target_not_found',
    'error.admin_required', 'db.tenant', 'nuance.load-admin-only',
  ],
  steps: [
    {
      title: 'Магазин и два товара из двух файлов',
      text:
        'Команде нужны мастер-ключ (`--dsn`), дом (`--schema`) и квартира (`--tenant`, имя или id). Несколько файлов — ' +
        'одна загрузка и одна транзакция; порядок строк и классов не важен. Товар ссылается на магазин его ключом: ' +
        '`{ $key: [\'Ромашка\'] }`. `--agent` — кто загружал: имя попадает в журнал рядом с автором версии. Отчёт — ' +
        'строка JSON в stdout; Анна сразу видит товары в своей квартире.',
      run: async ({ ADMIN_DSN, name, me }) => {
        dir = await mkdtemp(join(tmpdir(), 'letopis-load-'));
        const shops = await ndjson('shops.ndjson', [{ $class: 'Shop', name: 'Ромашка', city: 'Казань' }]);
        const products = await ndjson('products.ndjson', [
          { $class: 'Product', sku: 'K-1', title: 'Чайник', price: 2500, Shop: shop },
          { $class: 'Product', sku: 'M-1', title: 'Кружка', price: 400, Shop: shop },
        ]);
        const r = await cli(['load', shops, products, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--agent', 'загрузка прайса']);
        const [v] = await me.Product({ sku: 'K-1' }).versions();
        return { ...result(r), 'товары у Анны': await me.Product().count(), 'исполнитель в журнале': v.agent };
      },
    },
    {
      title: 'Один товар дважды во входе — duplicate',
      text: 'По умолчанию (`--duplicates error`) повтор id во входе — ошибка `duplicate`: загрузка отменена целиком, ничего не записано.',
      run: async ({ ADMIN_DSN, name }) => {
        const f = await ndjson('twice.ndjson', [
          { $class: 'Product', sku: 'T-1', title: 'Чай', price: 300, Shop: shop },
          { $class: 'Product', sku: 'T-1', title: 'Чай', price: 350, Shop: shop },
        ]);
        return result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка']));
      },
    },
    {
      title: 'Повторы — последний, существующие — новой версией',
      text:
        '`--duplicates last` оставляет последнюю из повторяющихся строк, `--existing update` пишет новую версию ' +
        'объекта, который уже есть, если его данные отличаются. В отчёте: одна строка — повтор (`duplicates`), одна ' +
        'новая версия (`updated`).',
      run: async ({ ADMIN_DSN, name, me }) => {
        const f = await ndjson('prices.ndjson', [
          { $class: 'Product', sku: 'K-1', title: 'Чайник', price: 2600, Shop: shop },
          { $class: 'Product', sku: 'K-1', title: 'Чайник', price: 2700, Shop: shop },
        ]);
        const r = await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--duplicates', 'last', '--existing', 'update']);
        return { ...result(r), 'цена Чайника': (await me.Product({ sku: 'K-1' }).first())?.data.price };
      },
    },
    {
      title: 'Уже существующий объект — exists',
      text: 'Без `--existing` объект, который уже есть в квартире, — ошибка `exists`: так повторный запуск той же загрузки ничего не задвоит.',
      run: async ({ ADMIN_DSN, name }) => {
        const f = await ndjson('again.ndjson', [{ $class: 'Product', sku: 'M-1', title: 'Кружка', price: 450, Shop: shop }]);
        return result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка']));
      },
    },
    {
      title: 'Строки без $class, внешний ключ и порции',
      text:
        '`--class` — класс строк без `$class`. У покупателя нет ключа: его id вычисляется из внешнего ключа `$ext` (id ' +
        'в прежней системе), поэтому повторная загрузка того же файла находит тех же покупателей. `--commit-every` — ' +
        'фиксировать порциями примерно по N строк: ошибка отменит только текущую порцию.',
      run: async ({ ADMIN_DSN, name }) => {
        const f = await ndjson('customers.ndjson', [
          { $ext: 'crm-1', name: 'Ольга', email: 'olga@mail.ru' },
          { $ext: 'crm-2', name: 'Пётр', email: 'petr@mail.ru' },
        ]);
        return result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--class', 'Customer', '--commit-every', '1']));
      },
    },
    {
      title: 'Перенос истории: --with-history',
      text:
        'С `--with-history` каждая строка — версия объекта: номер `$rev` (с 1 подряд), время `$at` и вид операции `$op` ' +
        '(по умолчанию `create`, затем `update`). Так переносят архив из другой системы: `versions()` показывает версии с ' +
        'их прежними датами.',
      run: async ({ ADMIN_DSN, name, me }) => {
        const f = await ndjson('history.ndjson', [
          { $class: 'Customer', $ext: 'crm-3', $rev: 1, $at: '2025-01-10T09:00:00Z', name: 'Иван', email: 'ivan@old.ru' },
          { $class: 'Customer', $ext: 'crm-3', $rev: 2, $at: '2025-06-01T12:00:00Z', name: 'Иван', email: 'ivan@mail.ru' },
        ]);
        const r = await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--with-history']);
        const versions = await me.Customer({ name: 'Иван' }).versions();
        return { ...result(r), 'версии': versions.map((v) => `v${v.rev} ${v.op} ${v.at.slice(0, 10)}: ${v.data.email}`) };
      },
    },
    {
      title: 'Отказы: строки Class, чужая квартира, не мастер-ключ',
      text:
        'Строки `Class` загрузчик не принимает (`class_not_loadable`): классы записывают `setup(…, { models })` и ' +
        '`letopis sync`. Квартиры с таким именем нет — `target_not_found`, до чтения файлов. Строка подключения не ' +
        'мастер-ключа — здесь роль консьержа, пропуск без параметров дома, — `admin_required`: загрузчику нужна роль, ' +
        'которая может стать владельцем схемы. Квартиру можно назвать и по id — `me.tenant`.',
      run: async ({ ADMIN_DSN, name, pass, me }) => {
        const f = await ndjson('class.ndjson', [{ $class: 'Class', name: 'Новый' }]);
        const g = await ndjson('lutik.ndjson', [{ $class: 'Shop', name: 'Лютик' }]);
        const concierge = new URL(pass);
        concierge.search = '';
        return {
          'строка Class': result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка'])),
          'квартира «Нет такой»': result(await cli(['load', g, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Нет такой'])),
          'роль консьержа вместо мастер-ключа': result(await cli(['load', g, '--dsn', concierge.toString(), '--schema', name, '--tenant', me.tenant])),
        };
      },
    },
    {
      title: 'Удалённый объект — deleted, --existing update возвращает его',
      text:
        'Анна удаляет Кружку. Её id занят историей: загрузка объекта с тем же ключом по умолчанию — ошибка `deleted`. ' +
        'С `--existing update` Кружка оживает новой версией с тем же id, прежние версии остаются в журнале.',
      run: async ({ ADMIN_DSN, name, me }) => {
        const preview = await me.Product({ sku: 'M-1' }).delete().rows();
        await me.Product({ sku: 'M-1' }).delete({ confirm: true, expect: preview }).rows();
        const f = await ndjson('mug.ndjson', [{ $class: 'Product', sku: 'M-1', title: 'Кружка', price: 450, Shop: shop }]);
        const deleted = result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка']));
        const revived = result(await cli(['load', f, '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка', '--existing', 'update']));
        const versions = await me.Product({ sku: 'M-1' }).versions();
        await rm(dir, { recursive: true, force: true });
        return { 'по умолчанию': deleted, '--existing update': revived, 'версии': versions.map((v) => `v${v.rev} ${v.op} ${v.data.price}`) };
      },
    },
  ],
});
