import { setup, lt } from 'letopis';
import type { House, Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, lastLetter } from '../_shared/postman.ts';

// Модель: магазин и его товары — два класса из модели магазина главы 3.
const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int().min(0) }, {
  ends: { Shop }, key: ['Shop', 'sku'],
});
let pass: string, db: House, me: Room;

export default example({
  title: 'Первые 15 минут: дом, консьерж, квартира, жилец и три цепочки',
  summary:
    'От пустой базы до первых данных в одном процессе: setup() строит дом с моделью и отдаёт пропуск, ' +
    'connect(pass, { postman }) — консьерж, он заводит квартиру и зовёт в неё жильца, жилец открывает ссылку из письма и ' +
    'принимает приглашение со своим паролем, а три цепочки создают объекты, находят их и переходят к соседям.',
  setup: 'none',
  tables: ['entity', 'log'],
  covers: [
    'export.setup', 'setup.models', 'export.connect', 'connect.postman', 'house.createTenant', 'house.in', 'db.invite',
    'house.accept', 'house.open', 'chain.create', 'chain.rows', 'chain.sort', 'export.lt',
  ],
  steps: [
    {
      title: '1. setup(): дом с моделью',
      text:
        '`setup(ADMIN_DSN, имя)` вызывают мастер-ключом — строкой подключения администратора PostgreSQL. Он строит дом: ' +
        'схему `v2.<имя>` с таблицами, проверками и системными классами — это строки `Class`, `Account` и другие в ' +
        '`entity`. `models` — модель дома, она в начале кода: `hub` описывает класс, `key` — поля, по которым объект ' +
        'находится однозначно, `ends` — концы к объектам других классов. Ответ — пропуск консьержа. Повторный вызов ' +
        'безопасен и отдаёт тот же пропуск — его можно делать при каждом запуске.',
      run: async ({ ADMIN_DSN, name }) => {
        const r = await setup(ADMIN_DSN, name, { models: [Shop, Product], quiet: true });
        pass = r.pass;
        return { 'дом': r.schema, 'построен': r.created, 'классы модели': r.models?.created };
      },
    },
    {
      title: '2. connect(): консьерж и квартира',
      text:
        '`connect(pass, { postman })` — консьерж: одно подключение на процесс. Почтальон — функция приложения, которая ' +
        'доставляет письма со ссылками-приглашениями и кодами; здесь это заглушка, она складывает письма в ящик `mail` ' +
        '(в настоящем приложении — отправка письма или СМС). Своих данных у консьержа нет — цепочек `db.Shop()` у него ' +
        'нет. Он заводит квартиры: `createTenant(\'Ромашка\')` — чьи это данные (компания, магазин, клуб). Модель дома ' +
        'общая для всех квартир, а данные у каждой свои.',
      run: async ({ connect }) => {
        db = await connect(pass, { postman });
        await db.createTenant('Ромашка');
        return { 'квартиры': (await db.tenants()).map((t) => t.name) };
      },
    },
    {
      title: '3. Жилец: приглашение и accept()',
      text:
        'Регистрации нет — только приглашения. Консьерж в квартире (`db.in`) зовёт Анну с ролью `owner` — хозяйка ' +
        'квартиры, ей можно всё. Ссылку с токеном получает почтальон, Анна открывает её и задаёт пароль: ' +
        '`accept(token, { password, name })` заводит её аккаунт, прописку в «Ромашке» и пароль от неё и сразу открывает ' +
        'корень квартиры — от него и идут цепочки.',
      run: async () => {
        await (await db.in('Ромашка')).invite({ email: 'anna@romashka.ru' }, ['owner']);
        const { token } = lastLetter('anna@romashka.ru', 'invite'); // ссылка из письма
        me = await db.accept(token, { password: 'Ромашка-2026!', name: 'Анна' });
        return { 'квартира': me.tenantName, 'консьерж?': me.concierge };
      },
    },
    {
      title: '4. Цепочка: создать',
      text:
        'Цепочку читают слева направо: `me.Shop()` — шаг по классу, `create()` — глагол, `rows()` — выполнить и вернуть ' +
        'строки. `me.Shop(shop).Product()` — переход от магазина к его товарам: новый товар сразу ссылается на магазин. ' +
        'В `entity` — три новые строки, в журнале `log` — три записи `create`.',
      run: async () => {
        const [shop] = await me.Shop().create({ name: 'Лютик', city: 'Казань' }).rows();
        await me.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await me.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        return shop.data;
      },
    },
    {
      title: '5. Цепочка: найти',
      text:
        'Фильтр — объект в шаге: `{ price: lt(1000) }` — цена меньше 1000. Операторы (`lt`, `gte`, `like`, `inList` и ' +
        'другие) импортируют из `letopis`. Без `sort()` порядок строк не определён — сортировка явная. Чтение таблиц не ' +
        'меняет.',
      run: async () => (await me.Product({ price: lt(1000) }).sort('data.price').rows()).map((p) => p.data),
    },
    {
      title: '6. Цепочка: перейти к соседям',
      text:
        'Следующий шаг цепочки — переход по концу `Shop`: от чайника к его магазину. Переходы работают в обе стороны: ' +
        'в шаге 4 цепочка шла от магазина к товарам.',
      run: async () => (await me.Product({ title: 'Чайник' }).Shop().rows()).map((s) => s.data),
    },
    {
      title: '7. Вход ключом: open()',
      text:
        'Завтра Анна входит тем же паролем: `db.open(ключ)` — консьерж сверяет ключ и открывает корень её квартиры. ' +
        'Данные те же: ключ открывает ровно одну квартиру — ту, куда Анну позвали.',
      run: async () => {
        const again = await db.open({ email: 'anna@romashka.ru', password: 'Ромашка-2026!' });
        return { 'квартира': again.tenantName, 'товаров': await again.Product().count() };
      },
    },
  ],
});
