import { syncModels } from 'letopis';
import { hub, link, one, many } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';
import { erDiagram } from '../../kit/diagram.ts';

// Модель магазина: магазин, дерево категорий, товар, покупатель, заказ и строка заказа.
const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
const Category = hub('Category', { name: z.string() }, {
  key: ['name'],
  ends: { Parent: one('Category').optional().onDelete('unset') }, // дерево: ссылка на родителя
});
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int().min(0) }, {
  ends: { Shop, Category: many(Category, { max: 5, onDelete: 'unset' }) },
  key: ['Shop', 'sku'],
  meta: { title: 'Товар', icon: 'mdi:package-variant' },
});
const Customer = hub('Customer', { name: z.string(), email: z.string() }, {}); // без ключа: id выдаёт база
const Order = hub('Order', { number: z.string() }, { ends: { Customer, Shop }, key: ['Shop', 'number'] });
const line = link('line', { qty: z.number().int().min(1), price: z.number().int().min(0) }, {
  ends: { Order: one(Order).onDelete('cascade'), Product },
  key: ['Order', 'Product'],
});
const models = [Shop, Category, Product, Customer, Order, line];

let shop: { id: string }, tea: { id: string }, green: { id: string }, sencha: { id: string }, olga: { id: string };

export default example({
  title: 'Модель магазина: классы, концы, ключи',
  summary:
    'Класс описывают моделью на Zod: поля, концы (они ведут на другие объекты) и ключ. hub — обычный объект, link — ' +
    'связка объектов со своими данными (строка заказа). syncModels записывает описания в базу, а данные потом ' +
    'проверяет сама база.',
  covers: [
    'model.hub', 'model.link', 'model.one', 'model.many', 'class.key', 'class.ends', 'class.meta', 'class.onDelete',
    'db.idOf', 'chain.create', 'error.exists', 'nuance.sync-dry-run',
  ],
  steps: [
    {
      title: 'Сухой прогон: что будет создано',
      text: '`syncModels` без `apply` ничего не пишет — только отвечает, какие классы будут созданы или изменены.',
      run: async ({ db }) => {
        const plan = await syncModels(db, models);
        return { applied: plan.applied, created: plan.created };
      },
    },
    {
      title: 'Записываем модель',
      text:
        'С `{ apply: true }` описания классов записаны в базу. В `lost` — ограничения модели, которые база выразить не может ' +
        '(здесь их нет). Строк данных пока нет.',
      run: async ({ db }) => {
        const applied = await syncModels(db, models, { apply: true });
        return { applied: applied.applied, created: applied.created, lost: applied.lost };
      },
    },
    {
      title: 'Схема модели — из того, что записано в базе',
      text:
        'Схему ниже рисует код по описанию классов из базы (`db.describe()`), а не человек — поэтому она не ' +
        'расходится с моделью. PK — поле ключа; подпись связи — роль конца и что будет при удалении цели.',
      run: async ({ db }) => erDiagram(await db.describe(), ['Shop', 'Category', 'Product', 'Customer', 'Order', 'line']),
    },
    {
      title: 'Конец модели изнутри',
      text:
        '`one(…)` и `many(…)` возвращают конец (`End`) — его описание: на какие классы (`targets`, имена — ' +
        '`classNames()`), одиночная или множественная (`many`), обязательная ли (`required`), сколько целей (`min`, ' +
        '`max`), что делать при удалении цели (`onDeleteRule`) и метаданные (`metaData`). `optional()`, `onDelete()` и ' +
        '`meta()` не меняют конец, а возвращают новый.',
      run: async () => {
        const categories = many(Category, { max: 5, onDelete: 'unset' });
        const plain = one('Category');
        const parent = plain.optional().onDelete('unset').meta({ title: 'Родитель' });
        const show = (e: typeof categories | typeof parent) => ({
          targets: e.targets.map((t) => (typeof t === 'string' ? `имя «${t}»` : `модель ${t.name}`)),
          classNames: e.classNames(), many: e.many, required: e.required, min: e.min ?? null, max: e.max ?? null,
          onDeleteRule: e.onDeleteRule ?? null, metaData: e.metaData ?? null,
        });
        return { 'Product.Category': show(categories), 'Category.Parent': show(parent), 'исходный one(\'Category\') не изменился': plain.required && plain.metaData === undefined };
      },
    },
    {
      title: 'Магазин: id вычисляется из ключа',
      text:
        'У магазина ключ — `name`. Поэтому id не случайный: он вычисляется из арендатора, класса и названия. ' +
        '`db.idOf` даёт тот же id заранее, без записи.',
      run: async ({ db }) => {
        [shop] = await db.Shop().create({ name: 'Ромашка', city: 'Казань' }).rows();
        return { sameId: (await db.idOf('Shop', { name: 'Ромашка' })) === shop.id };
      },
    },
    {
      title: 'Дерево категорий: конец на родителя',
      text:
        'Конец `Parent` ведёт на класс самой категории. Вызов `.Parent.set(tea)` после глагола задаёт конец — он ' +
        'виден в колонке «концы».',
      run: async ({ db }) => {
        [tea] = await db.Category().create({ name: 'Чай' }).rows();
        [green] = await db.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows();
        return green;
      },
    },
    {
      title: 'Товар: магазин — из пути, категория — вызовом .Category.add()',
      text:
        '`db.Shop(shop).Product().create(…)` сам задаёт конец `Shop`: магазин берётся из пути цепочки. Категорий у ' +
        'товара может быть несколько (`many`, не больше 5) — `.Category.add(green)` добавляет одну.',
      run: async ({ db }) => {
        [sencha] = await db.Shop(shop).Product().create({ sku: 'T-7', title: 'Сенча', price: 900 }).Category.add(green).rows();
        return sencha;
      },
    },
    {
      title: 'Покупатель, заказ и строка заказа — одним планом',
      text:
        'Цепочка создаёт заказ (покупатель — из пути, магазин — вызовом `.Shop.set()`) и сразу строку заказа (заказ — из пути). ' +
        'Весь план — одна транзакция: ошибка любого звена откатила бы всё.',
      run: async ({ db }) => {
        [olga] = await db.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
        return db.Customer(olga).Order().create({ number: 'A-1' }).Shop.set(shop)
          .line().create({ qty: 2, price: 900 }).Product.set(sencha)
          .rows();
      },
    },
    {
      title: 'Второй магазин с тем же ключом — отказ',
      text:
        'Ключ гарантирует единственность: магазин «Ромашка» уже есть, поэтому `create` отвечает `exists`. Это же ' +
        'защищает от дубликатов, если запрос повторили после сбоя сети.',
      run: async ({ db }) => db.Shop().create({ name: 'Ромашка' }).rows(),
      expect: { error: 'exists' },
    },
  ],
});
