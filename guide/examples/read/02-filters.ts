import { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull, not, or, isOp } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
const titles = async (p: Promise<{ data: Record<string, unknown> }[]>) => (await p).map((r) => r.data.title).sort();

export default example({
  title: 'Фильтры: все 18 операторов',
  summary:
    'Фильтр шага — объект полей: простое значение — равенство, оператор — сравнение. Значение сравнивается без ' +
    'приведения типов: { price: 900 } не найдёт цену "900". Роль конца в фильтре — id цели или null.',
  tables: [],
  covers: [
    'export.ne', 'export.gt', 'export.gte', 'export.lt', 'export.lte', 'export.between', 'export.inList',
    'export.like', 'export.ilike', 'export.starts', 'export.ends', 'export.has', 'export.hasAny', 'export.hasAll',
    'export.exists', 'export.isNull', 'export.not', 'export.or', 'export.isOp', 'nuance.filter-no-cast', 'nuance.filter-end-null',
  ],
  steps: [
    {
      title: 'Данные: четыре товара',
      text: 'Чайник 2500, Сенча 900, Пуэр 1500, Кружка 400. Метки: Чайник — «хит, стекло», Сенча — «хит», Кружка — «стекло».',
      run: async ({ db }) => {
        d = await seedShop(db);
        return (await db.Product().sort('data.price').rows()).map((r) => ({ title: r.data.title, price: r.data.price, labels: r.data.labels ?? null }));
      },
    },
    {
      title: 'Сравнения: ne, gt, gte, lt, lte',
      run: async ({ db }) => ({
        'ne(900)': await titles(db.Product({ price: ne(900) }).rows()),
        'gt(1500)': await titles(db.Product({ price: gt(1500) }).rows()),
        'gte(1500)': await titles(db.Product({ price: gte(1500) }).rows()),
        'lt(900)': await titles(db.Product({ price: lt(900) }).rows()),
        'lte(900)': await titles(db.Product({ price: lte(900) }).rows()),
      }),
    },
    {
      title: 'Диапазон и список: between, inList',
      run: async ({ db }) => ({
        'between(500, 2000)': await titles(db.Product({ price: between(500, 2000) }).rows()),
        "inList(['K-1', 'M-1'])": await titles(db.Product({ sku: inList(['K-1', 'M-1']) }).rows()),
      }),
    },
    {
      title: 'Текст: like, ilike, starts, ends',
      text: '`like` — шаблон с `%` и `_` с учётом регистра, `ilike` — без учёта, `starts` и `ends` — начало и конец.',
      run: async ({ db }) => ({
        "like('%а%')": await titles(db.Product({ title: like('%а%') }).rows()),
        "ilike('ч%')": await titles(db.Product({ title: ilike('ч%') }).rows()),
        "starts('T-')": await titles(db.Product({ sku: starts('T-') }).rows()),
        "ends('-1')": await titles(db.Product({ sku: ends('-1') }).rows()),
      }),
    },
    {
      title: 'Массивы: has, hasAny, hasAll',
      run: async ({ db }) => ({
        "has('хит')": await titles(db.Product({ labels: has('хит') }).rows()),
        "hasAny(['стекло', 'акция'])": await titles(db.Product({ labels: hasAny(['стекло', 'акция']) }).rows()),
        "hasAll(['хит', 'стекло'])": await titles(db.Product({ labels: hasAll(['хит', 'стекло']) }).rows()),
      }),
    },
    {
      title: 'Есть ли поле: exists, isNull',
      text: '`exists(true)` — поле есть; `isNull()` — поле `null` или его нет совсем.',
      run: async ({ db }) => ({
        'labels: exists(true)': await titles(db.Product({ labels: exists(true) }).rows()),
        'labels: exists(false)': await titles(db.Product({ labels: exists(false) }).rows()),
        'specs: isNull()': await titles(db.Product({ specs: isNull() }).rows()),
      }),
    },
    {
      title: 'Отрицание и «или»: not, or',
      run: async ({ db }) => ({
        "not('paid')": (await db.Order({ status: not('paid') }).rows()).map((o) => o.data.number),
        "not(gte(1000))": await titles(db.Product({ price: not(gte(1000)) }).rows()),
        "or({ sku: 'K-1' }, { price: lt(500) })": await titles(db.Product(or({ sku: 'K-1' }, { price: lt(500) })).rows()),
      }),
    },
    {
      title: 'Фильтр по концу и корневые категории',
      text: 'Роль конца в фильтре — id цели. `null` — «конец пуст»: так находятся корневые категории.',
      run: async ({ db }) => ({
        'товары «Лютика»': await titles(db.Product({ Shop: d.lutik }).rows()),
        'корневые категории': (await db.Category({ Parent: null }).rows()).map((c) => c.data.name).sort(),
      }),
    },
    {
      title: 'Без приведения типов',
      text: 'Цена — число 900. Строка `"900"` с ним не совпадает: простое значение сравнивается как есть.',
      run: async ({ db }) => ({
        'price: 900': await titles(db.Product({ price: 900 }).rows()),
        "price: '900'": await titles(db.Product({ price: '900' } as never).rows()),
      }),
    },
    {
      title: 'Оператор — это объект-маркер',
      text: '`isOp` отличает оператор от обычного значения фильтра.',
      run: async () => ({ 'isOp(gt(1))': isOp(gt(1)), 'isOp(1)': isOp(1) }),
    },
  ],
});
