import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

let d: ShopData;

export default example({
  title: 'Концы шагами ролей: set, unset, add, remove; entity(), cache(); await цепочки — не запрос',
  summary:
    'Конец меняют шагом роли: одиночный — set и unset, множественный — add и remove. Цепочку можно ' +
    'продолжить с готовой строки — entity(), повтор чтения взять из кэша — cache(). await цепочки ничего не читает — нужен rows().',
  tables: ['entity'],
  classes: ['Product', 'Category'],
  covers: ['chain.set', 'chain.unset', 'chain.add', 'chain.remove', 'chain.then', 'chain.entity', 'chain.cache', 'class.fields', 'class.cache', 'nuance.chain-not-thenable', 'nuance.cache-raced'],
  models: shopModels,
  steps: [
    {
      title: 'Кружке — две категории (множественный конец)',
      text: '`Category` у товара — `many`: `add` добавляет, `remove` убирает, остальные остаются.',
      run: async ({ me }) => {
        d = await seedShop(me);
        await me.Product(d.mug).update({}).Category.add(d.tea).rows();
        return me.Product(d.mug).update({}).Category.add(d.green).rows();
      },
    },
    {
      title: 'Убрать одну категорию',
      run: async ({ me }) => me.Product(d.mug).update({}).Category.remove(d.tea).rows(),
    },
    {
      title: 'Одиночный конец: set и unset',
      text: '`Parent` у категории — одиночный необязательный: `set` ставит, `unset` снимает.',
      run: async ({ me }) => {
        await me.Category(d.green).update({}).Parent.set(d.tea).rows();
        return me.Category(d.green).update({}).Parent.unset().rows();
      },
    },
    {
      title: 'await цепочки — не запрос; продолжение с готовой строки',
      text: 'У цепочки нет `then`: `await me.Product(…)` отдаёт саму цепочку и ничего не читает — запрос выполняет терминал, завершающий вызов (`.rows()`, `.first()`, `.count()`). `me.entity(строка)` начинает путь с уже прочитанной строки.',
      run: async ({ me }) => {
        const awaited = await (me.Product(d.mug) as unknown as Promise<unknown>);
        const mug = (await me.Product(d.mug).first())!;
        return { 'await дал строки?': Array.isArray(awaited), 'категории через entity()': (await me.entity(mug).Category().sort('data.name').rows()).map((c) => c.data.name) };
      },
    },
    {
      title: 'Кэш результатов и описание класса',
      text:
        '`.cache()` — повтор того же чтения без запроса к базе, пока данные не изменились. Кэш общий у консьержа и ' +
        'его корней квартир, записи в нём — свои у каждой сессии: `me.cache.stats()` — его счётчики. Сигнал о записи ' +
        'из прошлого шага может прийти во время первого чтения: такой ответ мог устареть, и кэш его не сохраняет ' +
        '(защита от гонки чтения и сигнала, счётчик `raced`). Поэтому чтение повторяем, пока очередной повтор не ' +
        'придёт из кэша: число попаданий (`hits`) растёт. В описании класса из реестра корня квартиры ' +
        '(`me.registry.find()`) — поля класса (`schema.properties`, их задаёт `fields` модели) и настройка кэша (`cache`).',
      run: async ({ me }) => {
        const read = () => me.Product().cache({ ttl: 30 }).count();
        await read(); // запрос к базе — ответ ложится в кэш, если сигнал о записи не пришёл во время чтения
        let fromCache = false;
        for (let i = 0; i < 10 && !fromCache; i++) {
          const before = me.cache.stats().hits;
          await read(); // то же чтение — из кэша, если ответ сохранён
          fromCache = me.cache.stats().hits > before;
        }
        const desc = me.registry.find('Product')!;
        return { 'повтор из кэша': fromCache ? 'да' : 'нет', 'поля Product': Object.keys(desc.schema.properties ?? {}).slice(0, 4), cache: desc.cache ?? null };
      },
    },
  ],
});
