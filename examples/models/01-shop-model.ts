import { setup, syncModels } from 'letopis';
import { hub, link, one, many } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Модель магазина: магазин, дерево категорий, товар, покупатель, заказ и строка заказа.
const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
const Category = hub('Category', { name: z.string() }, {
  key: ['name'],
  ends: { Parent: one('Category').optional().onDelete('unset') }, // дерево: конец к родителю
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
    'связка объектов со своими данными (строка заказа). Модель дома записывает setup() мастер-ключом — её классы ' +
    'общие для всех квартир, — а данные потом проверяет сама база.',
  covers: [
    'model.hub', 'model.link', 'model.one', 'model.many', 'class.key', 'class.ends', 'class.meta', 'class.onDelete',
    'export.syncModels', 'setup.models', 'db.refresh', 'db.idOf', 'chain.create', 'error.exists', 'nuance.sync-dry-run',
    'nuance.registry-refresh',
  ],
  steps: [
    {
      title: 'Сухой прогон: что будет создано',
      text:
        '`syncModels(корень, модели)` без `apply` ничего не пишет — только сверяет модели с классами, которые видит ' +
        'корень квартиры Анны (`me`), и отвечает, какие классы будут созданы или изменены.',
      run: async ({ me }) => {
        const plan = await syncModels(me, models);
        return { applied: plan.applied, created: plan.created };
      },
    },
    {
      title: 'Записываем модель в дом',
      text:
        'Модель — часть дома: `setup(ADMIN_DSN, name, { models })` мастер-ключом записывает описания классов, и они ' +
        'общие для всех квартир дома. Повторный `setup` ничего прежнего не трогает — только дописывает и правит классы. ' +
        'Ответ `r.models` — тот же отчёт, что у `syncModels`: в `lost` — ограничения модели, которые база выразить не ' +
        'может (здесь их нет). Корень Анны открыт раньше, чем появились классы: он перечитывает их по сигналу базы, а ' +
        'сразу — `me.refresh()`. Строк данных пока нет.',
      run: async ({ ADMIN_DSN, name, me }) => {
        const r = await setup(ADMIN_DSN, name, { models, quiet: true });
        await me.refresh();
        return { applied: r.models!.applied, created: r.models!.created, lost: r.models!.lost };
      },
    },
    {
      title: 'Что записано в базе: ключи и концы',
      text:
        'Корень квартиры прочёл описания классов из базы (`me.registry.all()`): у каждого класса — ключ и концы. Подпись ' +
        'конца — роль, класс цели и что будет при удалении цели (`restrict`, если не задано). Схема этой модели — под ' +
        'примером.',
      run: async ({ me }) =>
        me.registry.all()
          .filter((c) => models.some((m) => m.name === c.name))
          .map((c) => ({
            класс: c.name,
            ключ: c.key.join(' + ') || '—',
            концы: Object.entries(c.ends).map(([role, e]) => `${role} → ${[e.class].flat().join(' | ')} (${e.onDelete ?? 'restrict'})`).join(', ') || '—',
          })),
    },
    {
      title: 'Конец модели изнутри',
      text:
        '`one(…)` и `many(…)` возвращают конец (`End`) — его описание: на какие классы (`targets`, имена — ' +
        '`classNames()`), одиночный или множественный (`many`), обязательный ли (`required`), сколько целей (`min`, ' +
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
        'У магазина ключ — `name`. Поэтому id не случайный: он вычисляется из квартиры, класса и названия. ' +
        '`me.idOf` даёт тот же id заранее, без записи.',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка', city: 'Казань' }).rows();
        return { sameId: (await me.idOf('Shop', { name: 'Ромашка' })) === shop.id };
      },
    },
    {
      title: 'Дерево категорий: конец на родителя',
      text:
        'Конец `Parent` ведёт на класс самой категории. Вызов `.Parent.set(tea)` после глагола задаёт конец — он ' +
        'виден в колонке «концы».',
      run: async ({ me }) => {
        [tea] = await me.Category().create({ name: 'Чай' }).rows();
        [green] = await me.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows();
        return green;
      },
    },
    {
      title: 'Товар: магазин — из пути, категория — вызовом .Category.add()',
      text:
        '`me.Shop(shop).Product().create(…)` сам задаёт конец `Shop`: магазин берётся из пути цепочки. Категорий у ' +
        'товара может быть несколько (`many`, не больше 5) — `.Category.add(green)` добавляет одну.',
      run: async ({ me }) => {
        [sencha] = await me.Shop(shop).Product().create({ sku: 'T-7', title: 'Сенча', price: 900 }).Category.add(green).rows();
        return sencha;
      },
    },
    {
      title: 'Покупатель, заказ и строка заказа — одним планом',
      text:
        'Цепочка создаёт заказ (покупатель — из пути, магазин — вызовом `.Shop.set()`) и сразу строку заказа (заказ — из пути). ' +
        'Весь план — одна транзакция: ошибка любого звена откатила бы всё.',
      run: async ({ me }) => {
        [olga] = await me.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
        return me.Customer(olga).Order().create({ number: 'A-1' }).Shop.set(shop)
          .line().create({ qty: 2, price: 900 }).Product.set(sencha)
          .rows();
      },
    },
    {
      title: 'Второй магазин с тем же ключом — отказ',
      text:
        'Ключ гарантирует единственность: магазин «Ромашка» уже есть, поэтому `create` отвечает `exists`. Это же ' +
        'защищает от дубликатов, если запрос повторили после сбоя сети.',
      run: async ({ me }) => me.Shop().create({ name: 'Ромашка' }).rows(),
      expect: { error: 'exists' },
    },
  ],
});
