import { up, syncModels, lt } from 'letopis';
import type { Db, UpResult } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Модель: магазин и его товары — два класса из модели магазина главы 3.
const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int().min(0) }, {
  ends: { Shop }, key: ['Shop', 'sku'],
});
let r: UpResult, db: Db;

export default example({
  title: 'Первые 15 минут: установка, подключение, модель и три цепочки',
  summary:
    'От пустой базы до первых данных в одном процессе: up() ставит схему, заводит арендатора с пользователем и роль ' +
    'приложения, connect() подключается этой ролью, syncModels записывает модель, а три цепочки создают объекты, ' +
    'находят их и переходят к соседям.',
  setup: 'none',
  tables: ['entity', 'log'],
  covers: ['up.tenant', 'up.login', 'connect.admin'],
  steps: [
    {
      title: '1. up(): схема, арендатор, роль приложения',
      text:
        '`up()` вызывают от администратора базы (`dsn.admin`). Он ставит схему: таблицы, проверки, системные классы — ' +
        'это строки `Class`, `Account` и другие в `entity`. `tenant` заводит арендатора «Ромашка» и его первого ' +
        'пользователя Анну, `login` — роль приложения `guide_first_app`: ею приложение и будет ходить в базу. Повторный ' +
        'вызов безопасен — его можно делать при каждом запуске приложения.',
      run: async ({ dsn, schema }) => {
        r = await up({
          dsn: dsn.admin, schema, quiet: true,
          tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } },
          login: { user: 'guide_first_app', password: 'app-secret' },
        });
        return { схема: r.schema, арендатор: r.tenant!.tenant, пользователь: r.tenant!.user, 'роль приложения': r.login!.user };
      },
    },
    {
      title: '2. connect(): приложение подключается',
      text:
        'Приложение подключается ролью из шага 1 — строка `r.login.dsn` — и работает от имени Анны: `token` — её ' +
        'сессия в арендаторе «Ромашка». Цепочки идут ролью приложения, права проверяет база. `admin` — строка ' +
        'администратора: по ней при первой надобности откроется второй пул — только для администраторских вызовов: ' +
        '`syncModels`, `load` и `maintain`.',
      run: async ({ connect, dsn, schema }) => {
        db = await connect({ dsn: r.login!.dsn!, admin: dsn.admin, schema, token: r.tenant!.token! });
        return { арендатор: db.tenant };
      },
    },
    {
      title: '3. Модель: магазин и товар',
      text:
        'Модель — в начале кода примера (кнопка «Весь код примера»). `hub` описывает класс, `key` — поля, по которым ' +
        'объект находится однозначно, `ends` — концы к объектам других классов: у товара конец `Shop` — его магазин. ' +
        '`syncModels` записывает описания в базу: в `entity` появились строки `Class` для `Shop` и `Product`, и дальше ' +
        'база сама проверяет данные по ним.',
      run: async () => (await syncModels(db, [Shop, Product], { apply: true })).created,
    },
    {
      title: '4. Цепочка: создать',
      text:
        'Цепочку читают слева направо: `db.Shop()` — шаг по классу, `create()` — глагол, `rows()` — выполнить и вернуть ' +
        'строки. `db.Shop(shop).Product()` — переход от магазина к его товарам: новый товар сразу ссылается на магазин. ' +
        'В `entity` — три новые строки, в журнале `log` — три записи `create`.',
      run: async () => {
        const [shop] = await db.Shop().create({ name: 'Лютик', city: 'Казань' }).rows();
        await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await db.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        return shop;
      },
    },
    {
      title: '5. Цепочка: найти',
      text:
        'Фильтр — объект в шаге: `{ price: lt(1000) }` — цена меньше 1000. Операторы (`lt`, `gte`, `like`, `inList` и ' +
        'другие) импортируют из `letopis`. Чтение таблиц не меняет.',
      run: async () => db.Product({ price: lt(1000) }).rows(),
    },
    {
      title: '6. Цепочка: перейти к соседям',
      text:
        'Следующий шаг цепочки — переход по концу `Shop`: от чайника к его магазину. Переходы работают в обе ' +
        'стороны: в шаге 4 цепочка шла от магазина к товарам.',
      run: async () => db.Product({ title: 'Чайник' }).Shop().rows(),
    },
  ],
});
