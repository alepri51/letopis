import {
  idOf, uuidv5, v5Name, hashPassword, verifyHash, compileValidator, applyDefaults, ValidationError, generateTypes, schemaToTs,
  Registry, CHAIN_METHODS, DB_METHODS, RESERVED_CLASS_NAMES, DDL_REVISION,
} from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

export default example({
  title: 'Служебные экспорты: id из ключа, пароли, валидатор, типы, зарезервированные имена',
  summary:
    'Помимо connect и цепочек пакет отдаёт помощников: вычислить id объекта по ключу без запроса, захэшировать ' +
    'пароль, проверить данные тем же валидатором, что и база, сгенерировать типы TypeScript, узнать занятые имена.',
  tables: [],
  covers: ['export.idOf', 'export.uuidv5', 'export.v5Name', 'export.hashPassword', 'export.verifyHash', 'export.compileValidator',
    'export.applyDefaults', 'export.ValidationError', 'export.generateTypes', 'export.schemaToTs', 'export.Registry',
    'export.CHAIN_METHODS', 'export.DB_METHODS', 'export.RESERVED_CLASS_NAMES', 'export.DDL_REVISION', 'export.connect'],
  steps: [
    {
      title: 'id объекта по ключу — без запроса к базе',
      text: '`idOf(класс, ключ, { tenant })` даёт тот же id, что и база: UUID v5 из арендатора, имени класса и значений ключа.',
      run: async ({ db, up }) => {
        await syncShop(db); // скрыть
        const [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        const tenant = up.tenant!.tenant;
        return {
          'idOf совпал с id строки': idOf({ name: 'Shop', key: ['name'], ends: [] }, { name: 'Ромашка' }, { tenant }) === shop.id,
          'uuidv5(v5Name(…), арендатор) — то же': uuidv5(v5Name('Shop', ['Ромашка']), tenant) === shop.id,
          'v5Name': v5Name('Shop', ['Ромашка']),
        };
      },
    },
    {
      title: 'Пароль: хэш scrypt и проверка',
      run: async () => {
        const h = await hashPassword('Секрет-2026');
        return { 'хэш начинается с': h.slice(0, 7), 'верный': await verifyHash('Секрет-2026', h), 'неверный': await verifyHash('не тот', h) };
      },
    },
    {
      title: 'Валидатор и значения по умолчанию — те же проверки, что в базе',
      text: '`compileValidator(схема)` проверяет данные до отправки; `applyDefaults` дописывает значения по умолчанию; ошибка — `ValidationError` со списком нарушений.',
      run: async ({ db }) => {
        const schema = db.registry.resolve('Product').schema;
        const check = compileValidator(schema);
        const bad = check({ sku: 'X', title: 'Ложка' });
        return {
          'ошибки на неполных данных': bad.map((i) => i.path?.join('.') ?? i.message).slice(0, 3),
          'умолчания': applyDefaults({ type: 'object', properties: { qty: { type: 'integer', default: 1 } } }, {}),
          'ValidationError': new ValidationError('Product', bad).code,
        };
      },
    },
    {
      title: 'Типы TypeScript по модели и реестр',
      run: async ({ db }) => ({
        'generateTypes, начало': generateTypes(db.registry).split('\n').find((l) => l.startsWith('export interface')),
        'schemaToTs': schemaToTs({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }),
        'реестр — экземпляр Registry': db.registry instanceof Registry,
      }),
    },
    {
      title: 'Зарезервированные имена и ревизия движка',
      text: 'Имена методов цепочки и `db` нельзя дать классу: библиотека сначала ищет метод с таким именем и только потом — класс.',
      run: async () => ({
        'методов цепочки': CHAIN_METHODS.length, 'методов db': DB_METHODS.length,
        'зарезервировано имён': RESERVED_CLASS_NAMES.length, 'среди них where?': RESERVED_CLASS_NAMES.includes('where'),
        'ревизия движка': DDL_REVISION,
      }),
    },
  ],
});
