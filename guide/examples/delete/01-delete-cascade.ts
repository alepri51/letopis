import type { Db, Row } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
let shown: string;

/** Отпечаток предпросмотра: какие строки, в какой версии и что с ними будет. */
const mark = (preview: Row[]) => preview.map((r) => `${r.id}:${r.rev}:${r.$action}`).join('|');

/**
 * Удалить ровно то, что видел пользователь: одна транзакция — заказ под блокировкой forUpdate(), предпросмотр
 * пересчитан и сверен с показанным; не совпал — откат, ничего не удалено.
 */
async function deleteAsShown(db: Db, order: string, expected: string, reason: string) {
  const tr = await db.begin({ reason });
  try {
    if (!(await tr.Order(order).forUpdate().first())) {
      await tr.rollback();
      return 'заказа уже нет — ничего не удалено';
    }
    if (mark(await tr.Order(order).delete().rows()) !== expected) {
      await tr.rollback();
      return 'предпросмотр устарел — ничего не удалено, покажите новый';
    }
    const gone = await tr.Order(order).delete({ confirm: true }).rows();
    await tr.commit();
    return gone;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

export default example({
  title: 'Удаление: предпросмотр, каскад, запрет, очистка конца',
  summary:
    'delete() без подтверждения — только предпросмотр: что удалится и как. С { confirm: true } удаляются цели, а что ' +
    'делать с концами, ведущими на них, решает действие при удалении у конца: cascade — удалить вместе, ' +
    'restrict — запретить, unset — очистить конец. Модель магазина — помощник kit/shop.ts: его код — в «Весь код примера».',
  tables: ['entity', 'log'],
  covers: ['chain.delete', 'error.delete_restricted', 'nuance.cascade-unset-restrict', 'nuance.preview-depth', 'nuance.delete-as-shown'],
  steps: [
    {
      title: 'Данные магазина',
      text:
        '`seedShop` — помощник сайта (`kit/shop.ts`): записывает модель магазина и заводит магазины, товары, покупателей ' +
        'и заказы. Для удаления важны концы: у строки заказа `line` конец `Order: one(Order).onDelete(\'cascade\')`, ' +
        'у товара конец `Shop` без `onDelete` (по умолчанию `restrict`), у товара конец `Category` с `onDelete: \'unset\'`.',
      run: async ({ db }) => {
        d = await seedShop(db);
        return 'готово';
      },
    },
    {
      title: 'Предпросмотр удаления заказа',
      text:
        'Строки заказа ссылаются на заказ с действием при удалении `cascade` — они удалятся вместе с ним. ' +
        'В каждой строке предпросмотра — `$action` (что будет) и `$depth` (уровень каскада). У строк каскада `$action` ' +
        'тоже `delete`: цель от каскада отличает `$depth` — 0 у самой цели, 1 и дальше у строк, которые уйдут вместе с ней. ' +
        'В базе ничего не изменилось.',
      run: async ({ db }) => db.Order(d.order1).delete().rows(),
    },
    {
      title: 'Удаляем заказ',
      text: 'Заказ и обе его строки ушли из `entity`; в журнале три надгробия `delete`. История осталась.',
      run: async ({ db }) => db.Order(d.order1).delete({ confirm: true }).rows(),
    },
    {
      title: 'Магазин с товарами: предпросмотр показывает запрет',
      text:
        'Товары ссылаются на магазин с действием при удалении по умолчанию — `restrict`. ' +
        'Предпросмотр помечает их `$action: restrict`.',
      run: async ({ db }) => (await db.Shop(d.lutik).delete().rows()).map((r) => ({ id: r.id, action: r.$action })),
    },
    {
      title: 'Удалить магазин нельзя, пока есть товары',
      text: 'Отказ `delete_restricted` со списком строк, которые мешают удалению. Ничего не удалено.',
      run: async ({ db }) => db.Shop(d.lutik).delete({ confirm: true }).rows(),
      expect: { error: 'delete_restricted' },
    },
    {
      title: 'Удалить категорию — концы очистятся',
      text:
        'У товаров конец `Category` с действием при удалении `unset`. Удаляем «Посуду»: категория ушла, ' +
        'а из конца `Category` у Чайника и Кружки она убрана (подсвечено) — это новая версия каждого товара.',
      run: async ({ db }) => db.Category(d.dishes).delete({ confirm: true }).rows(),
    },
    {
      title: 'Пользователю показали предпросмотр заказа A-2',
      text:
        'Предпросмотр — снимок на момент вызова, а `delete({ confirm: true })` удаляет то, что есть в момент ' +
        'подтверждения. Чтобы удалить ровно показанное, запомните отпечаток предпросмотра — id, `rev` и `$action` ' +
        'каждой строки (функция `mark` в коде примера).',
      run: async ({ db }) => {
        const preview = await db.Order(d.order2).delete().rows();
        shown = mark(preview);
        return preview;
      },
    },
    {
      title: 'Пока он смотрел, в заказ добавили строку',
      run: async ({ db }) => db.Order(d.order2).line().create({ qty: 1, price: 2500 }).Product.set(d.kettle).rows(),
    },
    {
      title: 'Подтверждение по старому предпросмотру — отказ',
      text:
        '`deleteAsShown` (в коде примера) в одной транзакции `db.begin()` блокирует заказ `forUpdate()`, пересчитывает ' +
        'предпросмотр и сверяет отпечаток. Не совпал — откат: ничего не удалено, пользователю показывают новый ' +
        'предпросмотр. Блокировка защищает, только если её берут все, кто добавляет строки в этот каскад: добавляя ' +
        'строку заказа, тоже возьмите `tr.Order(order).forUpdate()` в своей транзакции (или общий `tr.lock(…)`).',
      run: async ({ db }) => ({
        'ответ': await deleteAsShown(db, d.order2, shown, 'отмена заказа A-2'),
        'строк в заказе': await db.Order(d.order2).line().count(),
      }),
    },
    {
      title: 'Новый предпросмотр и подтверждение',
      text: 'Отпечаток нового предпросмотра совпал — удалены заказ и обе строки, ровно как показано.',
      run: async ({ db }) => {
        shown = mark(await db.Order(d.order2).delete().rows());
        return deleteAsShown(db, d.order2, shown, 'отмена заказа A-2');
      },
    },
  ],
});
