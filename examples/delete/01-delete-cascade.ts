import type { Row } from 'letopis';
import { example } from '../_shared/example.ts';
import { seedShop, type ShopData } from '../_shared/shop.ts';

let d: ShopData;
let preview: Row[], shown: Row[], gone: Row[];

export default example({
  title: 'Удаление: предпросмотр, каскад, запрет, очистка конца',
  summary:
    'delete() без подтверждения — только предпросмотр: что удалится и как. С { confirm: true, expect: предпросмотр } ' +
    'удаляется ровно показанное, а что ' +
    'делать с концами, ведущими на них, решает действие при удалении у конца: cascade — удалить вместе, ' +
    'restrict — запретить, unset — очистить конец. Модель магазина — помощник _shared/shop.ts: его код — в «Весь код примера».',
  tables: ['entity', 'log'],
  covers: ['chain.delete', 'error.delete_restricted', 'error.conflict', 'nuance.cascade-unset-restrict', 'nuance.preview-depth', 'nuance.delete-as-shown', 'nuance.restore-partial'],
  steps: [
    {
      title: 'Данные магазина',
      text:
        '`seedShop` — помощник сайта (`_shared/shop.ts`): записывает модель магазина и заводит магазины, товары, покупателей ' +
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
        'В базе ничего не изменилось. Ответ сохраняем: подтверждение удаления принимает его в `expect`.',
      run: async ({ db }) => (preview = await db.Order(d.order1).delete().rows()),
    },
    {
      title: 'Удаляем заказ',
      text:
        '`delete({ confirm: true, expect: предпросмотр })` удаляет ровно показанное. Заказ и обе его строки ушли из ' +
        '`entity`; в журнале три надгробия `delete`. История осталась.',
      run: async ({ db }) => db.Order(d.order1).delete({ confirm: true, expect: preview }).rows(),
    },
    {
      title: 'Магазин с товарами: предпросмотр показывает запрет',
      text:
        'Товары ссылаются на магазин с действием при удалении по умолчанию — `restrict`. ' +
        'Предпросмотр помечает их `$action: restrict`.',
      run: async ({ db }) => (preview = await db.Shop(d.lutik).delete().rows()).map((r) => ({ id: r.id, action: r.$action })),
    },
    {
      title: 'Удалить магазин нельзя, пока есть товары',
      text: 'Отказ `delete_restricted` со списком строк, которые мешают удалению. Ничего не удалено.',
      run: async ({ db }) => db.Shop(d.lutik).delete({ confirm: true, expect: preview }).rows(),
      expect: { error: 'delete_restricted' },
    },
    {
      title: 'Удалить категорию — концы очистятся',
      text:
        'У товаров конец `Category` с действием при удалении `unset`. Удаляем «Посуду»: категория ушла, ' +
        'а из конца `Category` у Чайника и Кружки она убрана (подсвечено) — это новая версия каждого товара. ' +
        'Предпросмотр показывает их строками `$action: unset`.',
      run: async ({ db }) => {
        const p = await db.Category(d.dishes).delete().rows();
        return db.Category(d.dishes).delete({ confirm: true, expect: p }).rows();
      },
    },
    {
      title: 'Пользователю показали предпросмотр заказа A-2',
      text:
        'Предпросмотр — снимок на момент вызова, а между показом и подтверждением база может измениться. Поэтому ' +
        'предпросмотр сохраняют и при подтверждении передают в `expect`: удалится ровно показанное или ничего.',
      run: async ({ db }) => {
        shown = await db.Order(d.order2).delete().rows();
        return shown;
      },
    },
    {
      title: 'Пока он смотрел, в заказ добавили строку',
      run: async ({ db }) => db.Order(d.order2).line().create({ qty: 1, price: 2500 }).Product.set(d.kettle).rows(),
    },
    {
      title: 'Подтверждение по старому предпросмотру — отказ',
      text:
        '`delete({ confirm: true, expect: показанное })` в той же транзакции, что и удаление, строит предпросмотр заново ' +
        'и сравнивает его с `expect` — строки по `id`, их `rev` и `$action`. Не совпало — отказ `conflict` ' +
        '(`write.preview_changed`): ничего не удалено, а новый предпросмотр — в `err.detail.preview`, его и показывают ' +
        'пользователю.',
      run: async ({ db }) => {
        const answer = await db.Order(d.order2).delete({ confirm: true, expect: shown, reason: 'отмена заказа A-2' }).rows()
          .then(() => 'удалено', (e) => {
            if (e.code !== 'conflict') throw e;
            shown = e.detail.preview; // новый предпросмотр — показать пользователю
            return `${e.key}: ничего не удалено, покажите новый предпросмотр (${shown.length} строки)`;
          });
        return { 'ответ': answer, 'строк в заказе': await db.Order(d.order2).line().count() };
      },
    },
    {
      title: 'Подтверждение нового предпросмотра',
      text:
        'Пользователь посмотрел новый предпросмотр и подтвердил: он совпал с базой — удалены заказ и обе строки, ровно ' +
        'как показано.',
      run: async ({ db }) => {
        gone = await db.Order(d.order2).delete({ confirm: true, expect: shown, reason: 'отмена заказа A-2' }).rows();
        return gone;
      },
    },
    {
      title: 'Заказ вернули, а чайник в него тем временем добавили заново',
      text:
        'Ответ `delete` — надгробия этого удаления (`id` и `rev` каждой строки): сохраните его, по нему удалённое и ' +
        'возвращают. Заказ возвращает `restore({ expect: ответ })` — id из `expect`, которых нет среди строк шага ' +
        '(строки заказа), он пропускает. Сразу после этого в заказ снова положили чайник: строка с ключом «заказ + ' +
        'товар» получила тот же id, что удалённая, и её история продолжилась версией `create`.',
      run: async ({ db }) => {
        const [order] = await db.Order(d.order2).restore({ expect: gone }).rows();
        await db.Order(d.order2).line().create({ qty: 3, price: 2500 }).Product.set(d.kettle).rows();
        return order;
      },
    },
    {
      title: 'Вернуть строки удаления — restore({ expect, partial: true })',
      text:
        'Строки заказа возвращают тем же ответом `delete`, одним вызовом. Без `partial` строка, которую уже не вернуть, ' +
        'роняет весь вызов: ничего не восстановлено. С `partial: true` возвращаются строки, чья последняя версия — то ' +
        'самое надгробие, а остальные приходят в ответе строками-пропусками `$action: \'skip\'` с причиной `$why`: ' +
        '`reissued` — id занял новый живой объект с тем же ключом (здесь — чайник), `changed` — после удаления строку ' +
        'пересоздавали, правили или удалили снова, `restored` — её уже вернули. Пропуски покажите пользователю: «не ' +
        'вернулась — уже есть новая».',
      run: async ({ db }) => db.Order(d.order2).line().restore({ expect: gone, partial: true }).rows(),
    },
  ],
});
