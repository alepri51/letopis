import { gte } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, kettle: { id: string };

export default example({
  title: 'Создать, изменить, создать-или-заменить',
  summary:
    'create только создаёт, update только правит, upsert создаёт или заменяет целиком. Глагол ничего не делает ' +
    'сам: план исполняет терминал (rows, first, ids, count), и весь план — одна транзакция.',
  covers: ['chain.create', 'chain.update', 'chain.upsert', 'chain.first', 'export.gte', 'error.no_key', 'nuance.update-merge', 'nuance.update-empty-target', 'nuance.upsert-replaces', 'nuance.mods-after-verb'],
  steps: [
    {
      title: 'Модель магазина и магазин',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка', city: 'Казань' }).rows();
        return shop;
      },
    },
    {
      title: 'Два товара',
      text: 'Ссылка на магазин берётся из пути цепочки `db.Shop(shop).Product()`.',
      run: async ({ db }) => {
        [kettle] = await db.Shop(shop).Product()
          .create({ sku: 'K-1', title: 'Чайник', price: 2500, specs: { color: 'белый', volume: 1.7 }, labels: ['хит'] }).rows();
        return db.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
      },
    },
    {
      title: 'update меняет только переданные поля',
      text:
        'Вложенный объект `specs` меняется по полям: передали только цвет — объём остался. Массив `labels` и простые ' +
        'значения (строки, числа) заменяются целиком. Изменения применяет сама база, поэтому одновременные правки ' +
        'разных полей не теряются.',
      run: async ({ db }) => db.Product(kettle).update({ specs: { color: 'чёрный' }, labels: ['хит', 'новинка'] }).rows(),
    },
    {
      title: 'update по фильтру правит все найденные',
      text: 'Шаг с фильтром `price ≥ 1000` нашёл один товар — он и изменён. Без фильтра `update` правит все строки шага.',
      run: async ({ db }) => db.Shop(shop).Product({ price: gte(1000) }).update({ title: 'Чайник стеклянный' }).rows(),
    },
    {
      title: 'Ничего не нашлось — пустой ответ, не ошибка',
      text: 'Если шаг не нашёл строк, `update` возвращает пустой список. Проверяйте длину ответа.',
      run: async ({ db }) => db.Shop(shop).Product({ price: gte(100_000) }).update({ title: 'Золотой чайник' }).rows(),
    },
    {
      title: 'Сузить правку — модификатором до глагола',
      text:
        '`sort` и `limit` перед `update` выбирают его цели: здесь — один самый дорогой товар магазина. Кружка не ' +
        'изменилась. Так же действует `offset`.',
      run: async ({ db }) => db.Shop(shop).Product().sort('data.price', 'desc').limit(1).update({ labels: ['дорогой'] }).rows(),
    },
    {
      title: 'limit после глагола — ошибка',
      text:
        'Модификатор между глаголом и терминалом уже ничего не сужает: `update` прошёл бы по всем товарам, а `limit` ' +
        'обрезал бы только ответ. Поэтому библиотека отказывает `invalid_query` и ничего не пишет — проверьте журнал.',
      run: async ({ db }) => db.Shop(shop).Product().update({ labels: ['распродажа'] }).limit(1).rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'upsert: такого нет — создать',
      text:
        '`upsert` — один SQL-оператор `INSERT … ON CONFLICT`. Поэтому не бывает гонки, когда два запроса одновременно ' +
        'убедились, что объекта нет, и оба его создают. Поле `$upsert` в ответе говорит, что произошло: здесь `created`.',
      run: async ({ db }) => db.Shop().upsert({ name: 'Лютик', city: 'Уфа' }).rows(),
    },
    {
      title: 'upsert: то же самое — без изменений',
      run: async ({ db }) => db.Shop().upsert({ name: 'Лютик', city: 'Уфа' }).rows(),
    },
    {
      title: 'upsert заменяет целиком',
      text:
        'Объект передаётся целиком: поля, которых нет в переданном объекте, пропадают. Здесь не передали `city` — ' +
        'город исчез. Для денег `upsert` не годится: он затирает параллельные приращения.',
      run: async ({ db }) => db.Shop().upsert({ name: 'Лютик' }).rows(),
    },
    {
      title: 'upsert без ключа невозможен',
      text: 'У покупателя нет ключа — найти «тот же» объект не по чему. Отказ `no_key` приходит ещё до обращения к базе.',
      run: async ({ db }) => db.Customer().upsert({ name: 'Ольга', email: 'olga@mail.ru' }).rows(),
      expect: { error: 'no_key' },
    },
  ],
});
