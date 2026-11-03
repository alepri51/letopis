import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
// причина удаления заказа: её получают надгробия цели и всего каскада этого удаления
const CANCEL = 'отмена заказа A-1 (op-7)';

export default example({
  title: 'Вернуть удалённое',
  summary:
    'restore() возвращает удалённый объект с его последними данными — новой версией, с тем же id. Возвращаются только ' +
    'цели шага, а не весь каскад; строки именно этого каскада находят по причине удаления. Пустой ответ — цели не ' +
    'нашлось. История удалённого объекта остаётся в журнале: стереть версии одного объекта нельзя.',
  tables: ['entity', 'log'],
  covers: [
    'chain.restore', 'chain.withDeleted', 'error.not_deleted', 'nuance.restore-only-targets', 'nuance.restore-cascade-by-reason',
    'nuance.empty-target-delete-restore', 'nuance.create-revives-deleted',
  ],
  steps: [
    {
      title: 'Строку «Сенча» убрали из заказа, потом заказ отменили',
      text:
        'Сначала покупатель убрал из заказа A-1 строку с Сенчей — отдельным удалением. Потом заказ отменили: заказ и ' +
        'оставшаяся строка ушли каскадом. Удаление заказа идёт с причиной `reason` — её получают надгробия и цели, и ' +
        'всего каскада.',
      run: async ({ db }) => {
        d = await seedShop(db);
        await db.Order(d.order1).line({ qty: 2 }).delete({ confirm: true, reason: 'покупатель убрал Сенчу' }).rows();
        return db.Order(d.order1).delete({ confirm: true, reason: CANCEL }).rows();
      },
    },
    {
      title: 'Удалённое видно через withDeleted',
      text:
        'Обычное чтение удалённого не находит. `withDeleted()` показывает и надгробия — с `$deleted: true` и причиной ' +
        'удаления `reason`. У заказа удалены обе строки, но по разным причинам.',
      run: async ({ db }) => ({
        'обычно': await db.Order(d.order1).count(),
        'с удалёнными': (await db.Order(d.order1).withDeleted().rows()).map((r) => ({ number: r.data.number, deleted: r.$deleted })),
        'строки заказа': (await db.Order(d.order1).line().withDeleted().rows()).map((r) => ({ qty: r.data.qty, deleted: r.$deleted, reason: r.reason })),
      }),
    },
    {
      title: 'Вернуть заказ',
      text: '`restore()` возвращает только цель шага — сам заказ, с тем же id и новой версией. Строки заказа пока удалены.',
      run: async ({ db }) => db.Order(d.order1).restore().rows(),
    },
    {
      title: 'Вернуть строки только этого каскада',
      text:
        '`db.Order(order).line().withDeleted().restore()` вернул бы обе строки — и Сенчу, которую убрали раньше и ' +
        'отдельно. Строки именно этого удаления отличает причина: отберите надгробия с причиной отмены заказа и ' +
        'верните их по списку id. Причина — свободный текст, поэтому делайте её своей для каждого удаления (здесь — ' +
        'с номером операции).',
      run: async ({ db }) => {
        const dead = await db.Order(d.order1).line().withDeleted().rows();
        const ours = dead.filter((r) => r.$deleted && r.reason === CANCEL).map((r) => r.id);
        return db.line(ours).withDeleted().restore().rows();
      },
    },
    {
      title: 'История заказа: создание, удаление, возврат',
      text:
        'Журнал хранит все версии, и удаление их не стирает: у заказа — создание, надгробие и возврат. Стереть версии ' +
        'одного объекта нельзя; данные и журнал арендатора целиком стирает только удаление аккаунта (`db.auth.purgeAccount`).',
      run: async ({ db }) => (await db.Order(d.order1).versions()).map((v) => `v${v.rev} ${v.op}`),
    },
    {
      title: 'Живой объект вернуть нельзя',
      text: '`restore()` работает только для удалённых: живой объект — `not_deleted`.',
      run: async ({ db }) => db.Customer(d.olga).restore().rows(),
      expect: { error: 'not_deleted' },
    },
    {
      title: 'Чужой или несуществующий id — пустой ответ, а не ошибка',
      text:
        '`restore()` и `delete({ confirm: true })` по id, которого нет или который не виден (чужой арендатор, нет права ' +
        'на чтение), возвращают пустой список без ошибки — как и `update`. Проверяйте длину ответа и говорите ' +
        'пользователю «не найдено», а не «готово».',
      run: async ({ db }) => {
        const ghost = '00000000-0000-4000-8000-000000000000';
        const restored = await db.Order(ghost).restore().rows();
        const deleted = await db.Order(ghost).delete({ confirm: true }).rows();
        return { 'restore()': restored, 'delete({ confirm: true })': deleted, 'ответ пользователю': restored.length ? 'возвращено' : 'не найдено' };
      },
    },
    {
      title: 'Удалённую категорию нашли по ключу',
      text:
        'Удалим категорию «Посуда» и попробуем завести её снова. Перед `create` проверьте ключ среди удалённых: ' +
        '`withDeleted().first()` найдёт надгробие с `$deleted: true` — значит, объект с этим ключом уже жил.',
      run: async ({ db }) => {
        await db.Category(d.dishes).delete({ confirm: true }).rows();
        const was = await db.Category({ name: 'Посуда' }).withDeleted().first();
        return { 'найдено среди удалённых': was?.$deleted === true, 'id': was?.id };
      },
    },
    {
      title: 'create тем же ключом продолжает историю удалённого',
      text:
        '`create` с ключом удалённого объекта не даёт ошибки: id вычисляется из ключа, поэтому это тот же объект — его ' +
        'история продолжается новой версией `create`, а надгробие уходит из корзины. Концы, очищенные при удалении ' +
        '(у товаров), не возвращаются. Если пользователь заводит «нового» с занятым ключом, спросите его: вернуть ' +
        'удалённого (`restore()`) или выбрать другой ключ.',
      run: async ({ db }) => {
        const [again] = await db.Category().create({ name: 'Посуда' }).rows();
        return { 'тот же id': again.id === d.dishes, 'версии': (await db.Category(again).versions()).map((v) => `v${v.rev} ${v.op}`) };
      },
    },
  ],
});
