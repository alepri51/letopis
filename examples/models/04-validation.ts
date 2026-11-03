import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

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
// преобразование .trim() при записи никто не исполнит
const Guest = hub('Guest', { name: z.string().trim().min(1) }, {});

export default example({
  title: 'Проверка данных: база не примет неправильное',
  summary:
    'Модель превращается в JSON Schema, и каждую запись проверяет сама база — даже запись прямым SQL-запросом. ' +
    'Значения по умолчанию подставляет база. Новое обязательное поле ужесточает модель: база проверит, подходят ли ' +
    'под неё старые строки.',
  covers: ['error.invalid_data', 'error.tightening_conflict', 'error.invalid_class', 'nuance.refine-lost', 'nuance.defaults-by-db', 'nuance.safe-change'],
  steps: [
    {
      title: 'Класс «Товар»',
      run: async ({ db }) => (await syncModels(db, [Product], { apply: true })).created,
    },
    {
      title: 'Значение по умолчанию подставляет база',
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
        'У «Чайника» нет поля `sku`, а модель теперь требует его. Такое изменение — ужесточение: старые данные могут ' +
        'под него не подойти. База проверяет все строки класса и отвечает `tightening_conflict` со списком строк, ' +
        'которые не подходят. Описание класса не изменилось.',
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
      title: 'Проверки refine база не выполняет',
      text:
        '`refine` и `superRefine` в JSON Schema не выражаются. `syncModels` не теряет их молча: ' +
        'возвращает в `lost`. Такие проверки выполняйте в приложении.',
      run: async ({ db }) => {
        const r = await syncModels(db, [Coupon], { apply: true });
        return { created: r.created, lost: r.lost };
      },
    },
    {
      title: 'Преобразования Zod — отказ при syncModels',
      text:
        '`.trim()`, `.toLowerCase()`, `.transform()`, `z.preprocess()`, `.pipe()` меняют значение, а при записи их не ' +
        'исполняет ни база, ни валидатор letopis: имя из пробелов записалось бы как есть. Поэтому `syncModels` отклоняет ' +
        'такую модель до записи — `invalid_class` (ключ `model.transform_unsupported`, в `err.detail.rules` — путь и вид). ' +
        'Приводите значение в коде сервиса (`name.trim()`), а в модели оставьте проверку.',
      run: async ({ db }) => syncModels(db, [Guest], { apply: true }),
      expect: { error: 'invalid_class' },
    },
  ],
});
