import type { Row } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
let dishesTomb: Row;
// причина удаления заказа: её получают надгробия цели и всего каскада этого удаления
const CANCEL = 'отмена заказа A-1 (op-7)';

export default example({
  title: 'Вернуть удалённое',
  summary:
    'restore() возвращает удалённый объект с его последними данными — новой версией, с тем же id. Возвращаются только ' +
    'цели шага, а не весь каскад; строки именно этого каскада находят по причине удаления и возвращают с ' +
    'restore({ expect }) — только если они всё ещё те, что ушли. Пустой ответ — цели не нашлось. История удалённого ' +
    'объекта остаётся в журнале: стереть версии одного объекта нельзя.',
  tables: ['entity', 'log'],
  covers: [
    'chain.restore', 'chain.withDeleted', 'chain.versions', 'error.not_deleted', 'error.conflict', 'nuance.restore-only-targets',
    'nuance.restore-cascade-by-reason', 'nuance.empty-target-delete-restore', 'nuance.create-revives-deleted',
    'nuance.with-deleted-per-step', 'nuance.restore-no-filter', 'nuance.restore-expect-stale',
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
      title: 'Удалённое видно через withDeleted — у каждого шага свой',
      text:
        'Обычное чтение удалённого не находит. `withDeleted()` — модификатор своего шага: `db.Order(id).withDeleted()` — ' +
        'удалённый заказ, а `db.Order(id).withDeleted().line().withDeleted()` — удалённые строки удалённого заказа ' +
        '(надгробия с `$deleted: true` и причиной `reason`). У заказа удалены обе строки, но по разным причинам. ' +
        '`withDeleted()` только у первого шага относится к нему: строки там — живые (их нет), и letopis один раз ' +
        'предупреждает. История удалённого — `versions()` по его id: шаг с явным id берёт и удалённые.',
      run: async ({ db, warnings }) => {
        const lost = await warnings(() => db.Order(d.order1).withDeleted().line().rows());
        return {
          'обычно': await db.Order(d.order1).count(),
          'с удалёнными': (await db.Order(d.order1).withDeleted().rows()).map((r) => ({ number: r.data.number, deleted: r.$deleted })),
          'строки удалённого заказа': (await db.Order(d.order1).withDeleted().line().withDeleted().rows())
            .map((r) => ({ qty: r.data.qty, deleted: r.$deleted, reason: r.reason })),
          'withDeleted() только у заказа': { 'строк': lost.result.length, 'предупреждение': lost.warnings },
          'версии заказа': (await db.Order(d.order1).versions()).map((v) => `v${v.rev} ${v.op}`),
        };
      },
    },
    {
      title: 'Вернуть заказ',
      text: '`restore()` возвращает только цель шага — сам заказ, с тем же id и новой версией. Строки заказа пока удалены.',
      run: async ({ db }) => db.Order(d.order1).restore().rows(),
    },
    {
      title: 'restore() без сужения вернул бы всё удалённое шага',
      text:
        '`db.line().restore()` без фильтра, id и `expect` восстанавливает **все** удалённые строки класса любых заказов — ' +
        'здесь обе строки A-1, и Сенчу тоже. Это не отказ, а предупреждение: letopis печатает его один раз. Здесь вызов — в ' +
        'транзакции, которую пример откатывает: ничего не восстановлено.',
      run: async ({ db, warnings }) => {
        const tr = await db.begin();
        const all = await warnings(() => tr.line().restore().rows());
        await tr.rollback();
        return { 'вернул бы строк': all.result.length, 'предупреждение': all.warnings };
      },
    },
    {
      title: 'Вернуть строки только этого каскада — restore({ expect })',
      text:
        '`db.Order(order).line().withDeleted().restore()` вернул бы обе строки — и Сенчу, которую убрали раньше и ' +
        'отдельно. Строки именно этого удаления отличает причина: отберите надгробия с причиной отмены заказа и верните ' +
        'их `restore({ expect: надгробия })` — по `{ id, rev }` каждой. Строка вернётся, только если её последняя версия — ' +
        'то самое надгробие; иначе отказ `conflict` и ничего не восстановлено (так ловится случай «вещь тем временем ' +
        'выдали другому» — [глава 7](../money/#одна-открытая-запись-на-объект-выдача-бронь-смена)). Причина — свободный ' +
        'текст, поэтому делайте её своей для каждого удаления (здесь — с номером операции).',
      run: async ({ db }) => {
        const dead = await db.Order(d.order1).line().withDeleted().rows();
        const ours = dead.filter((r) => r.$deleted && r.reason === CANCEL);
        return db.line(ours.map((r) => r.id)).restore({ expect: ours }).rows();
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
        dishesTomb = (await db.Category({ name: 'Посуда' }).withDeleted().first())!;
        return { 'найдено среди удалённых': dishesTomb.$deleted === true, 'id': dishesTomb.id, 'rev надгробия': dishesTomb.rev };
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
    {
      title: 'Вернуть прежнюю «Посуду» уже нельзя',
      text:
        'id удалённой категории занял новый объект с тем же ключом. `restore()` отвечает `not_deleted` с ключом ' +
        '`write.restore_id_taken` («id занят новым объектом с тем же ключом»), а `restore({ expect: [надгробие] })` — ' +
        '`conflict` (`write.restore_stale`): последняя версия уже не то надгробие. В обоих случаях ничего не ' +
        'восстановлено — сообщите пользователю, что объект с этим ключом уже живёт.',
      run: async ({ db }) => ({
        'restore()': await db.Category(dishesTomb.id).restore().rows().then(() => 'восстановлено', (e) => `${e.code} (${e.key})`),
        'restore({ expect })': await db.Category(dishesTomb.id).restore({ expect: [dishesTomb] }).rows()
          .then(() => 'восстановлено', (e) => `${e.code} (${e.key})`),
      }),
    },
  ],
});
