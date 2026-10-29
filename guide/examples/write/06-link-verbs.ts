import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;

export default example({
  title: 'Ссылки шагами: set, unset, add, remove; entity(), cache(); await цепочки — не запрос',
  summary:
    'Ссылку меняют шагом по роли конца: одиночную — set и unset, множественную — add и remove. Цепочку можно ' +
    'продолжить с готовой строки — entity(), повтор чтения взять из кэша — cache(). await цепочки ничего не читает — нужен rows().',
  tables: ['entity'],
  classes: ['Product', 'Category'],
  covers: ['chain.set', 'chain.unset', 'chain.add', 'chain.remove', 'chain.then', 'chain.entity', 'chain.cache', 'class.fields', 'class.cache', 'nuance.chain-not-thenable', 'nuance.cache-raced'],
  steps: [
    {
      title: 'Кружке — две категории (множественный конец)',
      text: '`Category` у товара — `many`: `add` добавляет, `remove` убирает, остальные остаются.',
      run: async ({ db }) => {
        d = await seedShop(db);
        await db.Product(d.mug).update({}).Category.add(d.tea).rows();
        return db.Product(d.mug).update({}).Category.add(d.green).rows();
      },
    },
    {
      title: 'Убрать одну категорию',
      run: async ({ db }) => db.Product(d.mug).update({}).Category.remove(d.tea).rows(),
    },
    {
      title: 'Одиночный конец: set и unset',
      text: '`Parent` у категории — одиночный необязательный: `set` ставит, `unset` снимает.',
      run: async ({ db }) => {
        await db.Category(d.green).update({}).Parent.set(d.tea).rows();
        return db.Category(d.green).update({}).Parent.unset().rows();
      },
    },
    {
      title: 'await цепочки — не запрос; продолжение с готовой строки',
      text: 'У цепочки нет `then`: `await db.Product(…)` отдаёт саму цепочку и ничего не читает — запрос выполняет терминал, завершающий вызов (`.rows()`, `.first()`, `.count()`). `db.entity(строка)` начинает путь с уже прочитанной строки.',
      run: async ({ db }) => {
        const awaited = await (db.Product(d.mug) as unknown as Promise<unknown>);
        const mug = (await db.Product(d.mug).first())!;
        return { 'await дал строки?': Array.isArray(awaited), 'категории через entity()': (await db.entity(mug).Category().rows()).map((c) => c.data.name) };
      },
    },
    {
      title: 'Кэш результатов и описание класса',
      text:
        '`.cache()` — повтор того же чтения без запроса к базе, пока данные не изменились. Попадания считаем на свежем ' +
        'подключении Анны. У `db` сигнал о записи из прошлого шага мог бы прийти во время первого чтения: такой ответ ' +
        'мог устареть, и кэш его не сохраняет (защита от гонки чтения и сигнала, счётчик `raced`). В описании класса — ' +
        'его поля (`fields`) и настройка кэша (`cache`).',
      run: async ({ connect, dsn, schema, up }) => {
        const anna = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        await anna.Product().cache({ ttl: 30 }).count(); // запрос к базе — ответ сохраняется в кэше
        await anna.Product().cache({ ttl: 30 }).count(); // то же чтение — из кэша
        const { hits, raced } = anna.cache.stats();
        const desc = anna.describe().classes.find((c) => c.name === 'Product')!;
        return { 'попаданий в кэш': hits, raced, 'поля Product': Object.keys((desc.fields as { properties?: object }).properties ?? desc.fields).slice(0, 4), cache: desc.cache ?? null };
      },
    },
  ],
});
