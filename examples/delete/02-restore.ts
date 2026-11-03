import type { Row } from 'letopis';
import { example } from '../_shared/example.ts';
import { seedShop, type ShopData } from '../_shared/shop.ts';

let d: ShopData;
let dishesTomb: Row, cancelled: Row[];
// причина удаления заказа: её получают надгробия цели и всего каскада этого удаления
const CANCEL = 'отмена заказа A-1 (op-7)';

export default example({
  title: 'Вернуть удалённое',
  summary:
    'restore({ expect }) возвращает удалённый объект с его последними данными — новой версией, с тем же id; expect — ' +
    'надгробия, которые видел пользователь (ответ delete() или withDeleted()). Возвращаются только цели шага, а не весь ' +
    'каскад; строки именно этого каскада находят по причине удаления и возвращают тем же restore({ expect }) — только ' +
    'если они всё ещё те, что ушли. restore() без expect — отказ. История удалённого объекта остаётся в журнале: ' +
    'стереть версии одного объекта нельзя.',
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
        // каждое удаление — по предпросмотру: подтверждение удаляет ровно показанное
        const sencha = await db.Order(d.order1).line({ qty: 2 }).delete().rows();
        await db.Order(d.order1).line({ qty: 2 }).delete({ confirm: true, expect: sencha, reason: 'покупатель убрал Сенчу' }).rows();
        const order = await db.Order(d.order1).delete().rows();
        cancelled = await db.Order(d.order1).delete({ confirm: true, expect: order, reason: CANCEL }).rows();
        return cancelled;
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
      text:
        '`restore({ expect: ответ удаления })` возвращает только цель шага — сам заказ, с тем же id и новой версией. ' +
        'Надгробия строк заказа тоже есть в ответе удаления, но они не цели шага `Order(id)` — строки пока удалены.',
      run: async ({ db }) => db.Order(d.order1).restore({ expect: cancelled }).rows(),
    },
    {
      title: 'restore() без expect — отказ; { all: true } вернул бы всё удалённое шага',
      text:
        '`restore()` без `expect` не принимается: `invalid_query` (`write.restore_without_expect`), ничего не ' +
        'восстановлено — даже по явному id: вернулся бы последний снимок, которого пользователь мог не видеть. ' +
        'Осознанно вернуть все удалённые цели шага без сверки — `restore({ all: true })`: `db.line().restore({ all: true })` ' +
        'вернул бы **все** удалённые строки класса любых заказов — здесь обе строки A-1, и Сенчу тоже. Этот вызов — в ' +
        'транзакции, которую пример откатывает: ничего не восстановлено.',
      run: async ({ db }) => {
        // @ts-expect-error — restore() без опций не пускают и типы
        const refused = await db.line().restore().rows().then(() => 'восстановлено', (e) => `${e.code} (${e.key})`);
        const tr = await db.begin();
        const all = await tr.line().restore({ all: true }).rows();
        await tr.rollback();
        return { 'restore()': refused, 'restore({ all: true }) вернул бы строк': all.length };
      },
    },
    {
      title: 'Вернуть строки только этого каскада — restore({ expect })',
      text:
        '`db.Order(order).line().withDeleted().restore({ all: true })` вернул бы обе строки — и Сенчу, которую убрали раньше и ' +
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
      title: 'Живой объект вернуть нельзя — ключ говорит почему',
      text:
        '`restore({ expect })` работает только для удалённых: живой объект — `not_deleted`. Почему он жив, говорит ключ ' +
        '`err.key`: `write.not_deleted` — объект не удалялся, `write.restore_already` — его уже вернули (заказ A-1 — в ' +
        'шаге 3; так же отвечает второй из двух одновременных `restore({ expect })`), `write.restore_id_taken` — id занял ' +
        'новый объект с тем же ключом (шаг 11).',
      run: async ({ db }) => {
        const olga = (await db.Customer(d.olga).first())!;
        return {
          'покупатель Ольга (не удалялась)': await db.Customer(d.olga).restore({ expect: [olga] }).rows()
            .then(() => 'восстановлено', (e) => `${e.code} (${e.key})`),
          'заказ A-1 (уже вернули)': await db.Order(d.order1).restore({ expect: cancelled }).rows()
            .then(() => 'восстановлено', (e) => `${e.code} (${e.key})`),
        };
      },
    },
    {
      title: 'Чужой или несуществующий id — пустой ответ, а не ошибка',
      text:
        'По id, которого нет или который не виден (чужой арендатор, нет права на чтение), предпросмотр удаления `delete()` и ' +
        'надгробия `withDeleted()` — пустой список без ошибки, как и ответ `update`. Подтверждать и восстанавливать ' +
        'нечего: проверяйте длину ответа и говорите пользователю «не найдено», а не «готово».',
      run: async ({ db }) => {
        const ghost = '00000000-0000-4000-8000-000000000000';
        const preview = await db.Order(ghost).delete().rows();
        const tombs = await db.Order(ghost).withDeleted().rows();
        return { 'delete() — превью': preview, 'withDeleted()': tombs, 'ответ пользователю': preview.length || tombs.length ? 'найдено' : 'не найдено' };
      },
    },
    {
      title: 'Удалённую категорию нашли по ключу',
      text:
        'Удалим категорию «Посуда» и попробуем завести её снова. Перед `create` проверьте ключ среди удалённых: ' +
        '`withDeleted().first()` найдёт надгробие с `$deleted: true` — значит, объект с этим ключом уже жил.',
      run: async ({ db }) => {
        const preview = await db.Category(d.dishes).delete().rows();
        await db.Category(d.dishes).delete({ confirm: true, expect: preview }).rows();
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
        'удалённого (`restore({ expect: [надгробие] })`) или выбрать другой ключ.',
      run: async ({ db }) => {
        const [again] = await db.Category().create({ name: 'Посуда' }).rows();
        return { 'тот же id': again.id === d.dishes, 'версии': (await db.Category(again).versions()).map((v) => `v${v.rev} ${v.op}`) };
      },
    },
    {
      title: 'Вернуть прежнюю «Посуду» уже нельзя',
      text:
        'id удалённой категории занял новый объект с тем же ключом. `restore({ expect: [надгробие] })` отвечает ' +
        '`not_deleted` с ключом `write.restore_id_taken` («id занят новым объектом с тем же ключом»); в ' +
        '`err.detail.stale` — каждая цель, которую не вернуть, с причиной `why: \'reissued\'`. Ничего не ' +
        'восстановлено — сообщите пользователю, что объект с этим ключом уже живёт. С `partial: true` та же цель ' +
        'пришла бы строкой-пропуском `$action: \'skip\'`, `$why: \'reissued\'`, без ошибки.',
      run: async ({ db }) => ({
        'restore({ expect })': await db.Category(dishesTomb.id).restore({ expect: [dishesTomb] }).rows()
          .then(() => 'восстановлено', (e) => ({ error: `${e.code} (${e.key})`, stale: e.detail?.stale })),
        'restore({ expect, partial: true })': (await db.Category(dishesTomb.id).restore({ expect: [dishesTomb], partial: true }).rows())
          .map((r) => ({ $action: r.$action, $why: r.$why })),
      }),
    },
  ],
});
