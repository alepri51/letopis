import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Product = hub('Product', {
  title: z.string(),
  price: z.number().int().min(0),
  status: z.enum(['draft', 'active']).default('draft'),
}, {});
// та же модель с новым обязательным полем — ужесточение
const ProductV2 = hub('Product', {
  title: z.string(),
  price: z.number().int().min(0),
  status: z.enum(['draft', 'active']).default('draft'),
  sku: z.string(),
}, {});
// новое необязательное поле — безопасное изменение
const ProductV3 = hub('Product', {
  title: z.string(),
  price: z.number().int().min(0),
  status: z.enum(['draft', 'active']).default('draft'),
  note: z.string().optional(),
}, {});
// правило refine база выразить не может
const Coupon = hub('Coupon', { code: z.string().refine((s) => s.startsWith('C-'), 'код начинается с C-') }, {});

export default example({
  title: 'Проверка данных: база не примет неправильное',
  summary:
    'Модель превращается в JSON Schema, и каждую запись проверяет сама база — даже сырой SQL. Умолчания ' +
    'подставляет база. Новое обязательное поле — ужесточение: база проверит, что старые строки ему не мешают.',
  covers: ['error.invalid_data', 'error.tightening_conflict', 'nuance.refine-lost', 'nuance.defaults-by-db', 'nuance.safe-change'],
  steps: [
    {
      title: 'Класс «Товар»',
      run: async ({ db }) => (await syncModels(db, [Product], { apply: true })).created,
    },
    {
      title: 'Умолчание подставляет база',
      text: 'Поле `status` не передали — база подставила `draft` из `.default()` модели.',
      run: async ({ db }) => db.Product().create({ title: 'Чайник', price: 2500 }).rows(),
    },
    {
      title: 'Отрицательная цена — отказ',
      text: 'Цена по модели — целое число не меньше 0. Строка с `-1` в базу не попадёт: `invalid_data`, данные не изменились.',
      run: async ({ db }) => db.Product().create({ title: 'Кружка', price: -1 }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Новое обязательное поле — ужесточение',
      text:
        'У «Чайника» нет поля `sku`, а модель теперь требует его. Такое изменение — ужесточение: база проверяет все ' +
        'строки класса и отвечает `tightening_conflict` со списком мешающих строк. Описание не изменилось.',
      run: async ({ db }) => syncModels(db, [ProductV2], { apply: true }),
      expect: { error: 'tightening_conflict' },
    },
    {
      title: 'Необязательное поле — безопасно',
      text: 'Новое необязательное поле старым строкам не мешает — изменение применяется сразу (`updated`).',
      run: async ({ db }) => {
        const r = await syncModels(db, [ProductV3], { apply: true });
        return { updated: r.updated };
      },
    },
    {
      title: 'Правила refine база не исполняет',
      text:
        '`refine`, `superRefine` и `transform` в JSON Schema не выражаются. `syncModels` не теряет их молча: ' +
        'возвращает в `lost`. Такие правила проверяйте в приложении.',
      run: async ({ db }) => {
        const r = await syncModels(db, [Coupon], { apply: true });
        return { created: r.created, lost: r.lost };
      },
    },
  ],
});
