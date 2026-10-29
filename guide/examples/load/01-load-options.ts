import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let adm: Db;
const shop = { $key: ['Ромашка'] };

export default example({
  title: 'Массовая загрузка db.load: входные данные, ссылки по ключу, повторы, уже существующие объекты',
  summary:
    'load пишет тысячи строк пачками через COPY — команду PostgreSQL для быстрой массовой вставки, а проверки ' +
    'делает сама база. Входные данные — объект «класс → строки» или массив строк с $class; ссылка на объект — его ' +
    'ключ { $key } или внешний идентификатор { $ext }. Загружать может только администраторское подключение.',
  tables: ['counts'],
  covers: [
    'db.load', 'load.duplicates', 'load.existing', 'load.batch', 'load.commitEvery', 'load.verify', 'load.class', 'load.tenant',
    'load.agent', 'load.as', 'error.duplicate', 'error.class_not_loadable', 'error.admin_required', 'nuance.load-admin-only',
  ],
  steps: [
    {
      title: 'Администраторское подключение',
      text: 'Нужны обход RLS (`allowBypassRls`) и право стать владельцем схемы; сессия задаёт арендатора, куда пишем.',
      run: async ({ db, connect, dsn, schema, up }) => {
        await syncShop(db); // скрыть
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        return { tenant: adm.tenant };
      },
    },
    {
      title: 'Магазин и два товара одним вызовом',
      text: 'Товар ссылается на магазин его ключом: `{ $key: [\'Ромашка\'] }`. `verify: true` — в конце база ещё раз проверяет загруженные строки.',
      run: async () => adm.load({
        Shop: [{ name: 'Ромашка' }],
        Product: [{ sku: 'K-1', title: 'Чайник', price: 2500, Shop: shop }, { sku: 'M-1', title: 'Кружка', price: 400, Shop: shop }],
      }, { verify: true, agent: 'загрузка прайса' }),
    },
    {
      title: 'Один товар дважды во входе',
      text: 'По умолчанию повтор id во входных данных — ошибка `duplicate`, и ничего не записано.',
      run: async () => adm.load({ Product: [{ sku: 'T-1', title: 'Чай', price: 300, Shop: shop }, { sku: 'T-1', title: 'Чай', price: 350, Shop: shop }] }),
      expect: { error: 'duplicate' },
    },
    {
      title: 'Повторы — берём последний, существующие — обновляем',
      text: '`duplicates: \'last\'` оставляет последнюю строку, `existing: \'update\'` пишет новую версию, если содержимое отличается.',
      run: async () => adm.load({ Product: [{ sku: 'K-1', title: 'Чайник', price: 2600, Shop: shop }, { sku: 'K-1', title: 'Чайник', price: 2700, Shop: shop }] },
        { duplicates: 'last', existing: 'update' }),
    },
    {
      title: 'Уже существующий объект по умолчанию — ошибка',
      run: async () => adm.load({ Product: [{ sku: 'M-1', title: 'Кружка', price: 450, Shop: shop }] }),
      expect: { error: 'exists' },
    },
    {
      title: 'Массив строк, порции и пачки',
      text: 'Строки с `$class`; у покупателя нет ключа — id вычисляется из внешнего идентификатора `$ext`. `commitEvery` — размер порции, после которой загрузка фиксируется; `batch` — сколько строк в одной пачке COPY.',
      run: async () => adm.load([
        { $class: 'Customer', $ext: 'crm-1', name: 'Ольга', email: 'olga@mail.ru' },
        { $class: 'Customer', $ext: 'crm-2', name: 'Пётр', email: 'petr@mail.ru' },
      ], { commitEvery: 1, batch: 1 }),
    },
    {
      title: 'Строки без $class и от имени пользователя',
      text: '`class` — класс для строк без `$class`. `as` — загрузка от имени пользователя: автор версий — он, и проверяются его права.',
      run: async ({ up }) => {
        const report = await adm.load([{ $ext: 'crm-3', name: 'Иван', email: 'ivan@mail.ru' }], { class: 'Customer', as: up.tenant!.user!, tenant: up.tenant!.tenant });
        const [v] = await adm.Customer({ name: 'Иван' }).versions();
        return { report, 'автор': v.author };
      },
    },
    {
      title: 'Классы не грузятся',
      text: 'Описания классов записывает `syncModels`, а не `load`.',
      run: async () => adm.load({ Class: [{ name: 'Новый' }] }),
      expect: { error: 'class_not_loadable' },
    },
    {
      title: 'Обычное подключение загружать не может',
      run: async ({ db }) => db.load({ Product: [{ sku: 'X-1', title: 'Ложка', price: 100, Shop: shop }] }),
      expect: { error: 'admin_required' },
    },
  ],
});
