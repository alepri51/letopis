import { cursorOf, loose } from 'letopis';
import { createMcpServer } from 'letopis/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels } from '../_shared/shop.ts';

/** Код и ключ каталога отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => `${e.code} (${e.key})`);

export default example({
  title: 'Ошибки строгого режима, MCP и квартир',
  summary:
    'Строгий режим ловит ошибки до обращения к базе: правку и удаление без условия, неизвестную опцию и поле, курсор ' +
    'у счёта, undefined в фильтре. Здесь же — подтверждение удаления через MCP и квартиры: несуществующая, удалённая, ' +
    'метод жильца у консьержа.',
  models: shopModels,
  tables: [],
  covers: [
    'error.invalid_query', 'error.invalid_data', 'error.confirmation_required', 'error.tenant_denied', 'error.target_not_found',
    'house.in', 'db.deleteTenant', 'export.loose', 'export.cursorOf', 'nuance.update-needs-filter', 'nuance.unknown-option',
    'nuance.unknown-field', 'nuance.after-before-count',
  ],
  steps: [
    {
      title: 'invalid_query — правка без условия',
      text:
        'Ни у одного шага нет фильтра, id, `tags()`, `owner()` или `limit()` — правка прошла бы по всем строкам. ' +
        'Библиотека отказывает до записи, ничего не записано. Что делать: сузить цели фильтром или id; править все ' +
        'строки шага — явно, опцией `{ all: true }`.',
      run: async ({ me }) => {
        await seedShop(me);
        return me.Product().update({ views: 0 }).rows();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'Все строки — явно: { all: true }',
      text: 'С `{ all: true }` правка идёт по всем товарам квартиры. Удалить все строки шага — `delete({ confirm: true, all: true })`.',
      run: async ({ me }) => (await me.Product().update({ views: 0 }, { all: true }).rows()).map((p) => `${p.data.title}: ${p.data.views}`).sort(),
    },
    {
      title: 'invalid_query — удаление без условия',
      text:
        'То же правило у удаления: `delete({ confirm: true, expect })` без фильтра, id и прочего — отказ ' +
        '`write.no_filter`. Предпросмотр `delete()` без подтверждения ничего не удаляет — ему условие не нужно.',
      run: async ({ me }) => {
        const preview = await me.Category().delete().rows();
        return me.Category().delete({ confirm: true, expect: preview }).rows();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_query — подтверждение удаления без expect',
      text:
        '`delete({ confirm: true })` без `expect` — отказ `write.confirm_without_expect` до записи: подтверждение ' +
        'не сверено с предпросмотром, который видел пользователь. Что делать: передать в `expect` ответ `delete()`; ' +
        'осознанно удалить текущий состав без сверки — `delete({ confirm: true, all: true })`. Так же `restore()` ' +
        'без `expect` — `write.restore_without_expect`.',
      run: async ({ me }) => {
        const [cat] = await me.Category().sort('data.name').rows();
        // @ts-expect-error — подтверждение без expect не пускают и типы
        return me.Category(cat).delete({ confirm: true }).rows();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_data — неизвестная опция',
      text:
        'Опечатка в опции `connect()`, `setup()`, `me.watch()` или `createMcpServer()` — отказ до подключения, ' +
        'с похожими именами в тексте и в `err.params.similar`. Что делать: исправить имя опции.',
      run: async ({ connect, pass }) => connect(pass, { maxx: 2 } as never),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'invalid_query — неизвестное поле фильтра',
      text:
        'Поле фильтра, `sort()` или итога, которого нет в описании класса шага, — отказ до запроса, с похожими именами в ' +
        'тексте и в `err.params.similar`: такое условие ничего бы не нашло. С моделями опечатку ловит ещё компилятор, а имя, ' +
        'известное только во время выполнения (`loose(me)`), проверяет библиотека. Что делать: исправить имя поля.',
      run: async ({ me }) => loose(me).Product({ titel: 'Чай' }).rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'Предупреждение — undefined в фильтре',
      text:
        '`{ поле: undefined }` в фильтре условия не задаёт: шаг найдёт все строки. Это не отказ, а предупреждение ' +
        '`query.filter_undefined` в консоли (или событием `warning` журнала): чаще всего так в фильтр попала пустая ' +
        'переменная. Что делать: проверить переменную; строки без значения поля ищет `isNull()`.',
      run: async ({ me, warnings }) => {
        const title: string | undefined = undefined;
        const { result, warnings: said } = await warnings(() => me.Product({ title }).count());
        return { 'найдено товаров': result, 'предупреждение': said };
      },
    },
    {
      title: 'invalid_query — after() перед count()',
      text: 'Курсор `after()` листает строки `rows()`, а `count()` и итоги считают по всем объектам шага. Что делать: убрать `after()` перед счётом; сузить счёт — фильтром шага.',
      run: async ({ me }) => {
        const [first] = await me.Product().sort('data.title').limit(1).rows();
        return me.Product().sort('data.title').after(cursorOf(first, 'data.title')).count();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'confirmation_required — удаление через MCP без подтверждения человека',
      text: 'Прежде чем удалить по просьбе агента, сервер спрашивает подтверждение у человека (запрос elicitation). Клиент, который не умеет передать такой вопрос, получает отказ. Что делать: взять клиент MCP, который поддерживает подтверждение.',
      run: async ({ me }) => {
        const [temp] = await me.Customer().create({ name: 'Тест', email: 'test@example.com' }).rows();
        const server = await createMcpServer(me, { write: true });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name: 'без подтверждения', version: '1' });
        await client.connect(a);
        const res = (await client.callTool({ name: 'letopis_write', arguments: { op: 'delete', class: 'Customer', id: temp.id, confirm: true } })) as { structuredContent?: { error?: { code: string } } };
        await client.close();
        return { 'код': res.structuredContent?.error?.code, 'покупатель на месте': (await me.Customer(temp).count()) === 1 };
      },
    },
    {
      title: 'Квартиры: нет такой, удалённая, метод жильца у консьержа',
      text:
        '`db.in()` с именем, которого нет, — `target_not_found` (`api.tenant_unknown`). Квартиру «Лютик» завёл и удалил ' +
        'другой процесс (свой консьерж): по её id `db.in()` — `tenant_denied`, квартиры больше нет. Ключи, выписка и ' +
        'выход — только у жильца, вошедшего ключом: у консьержа в квартире — `invalid_query` (`api.resident_only`). Что ' +
        'делать: брать имя квартиры из `db.tenants()`; методы жильца вызывать у корня, который открыл его ключ.',
      run: async ({ db, connect, pass }) => {
        const other = await connect(pass);
        const lutik = await other.createTenant('Лютик');
        await (await other.in('Лютик')).deleteTenant();
        return {
          'квартира «Нет такой»': await why(db.in('Нет такой')),
          'удалённая квартира по id': await why(db.in(lutik.id)),
          'keys.list() у консьержа': await why((async () => (await db.in('Ромашка')).keys.list())()),
        };
      },
    },
  ],
});
