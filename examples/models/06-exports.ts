import {
  idOf, uuidv5, v5Name, hashPassword, verifyHash, compileValidator, applyDefaults, ValidationError, generateTypes, schemaToTs,
  Registry, CHAIN_METHODS, DB_METHODS, RESERVED_CLASS_NAMES, DDL_REVISION, loose,
} from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { syncShop, shopModels } from '../_shared/shop.ts';

export default example({
  title: 'Служебные экспорты: id из ключа, пароли, валидатор, типы, строгие типы, зарезервированные имена',
  summary:
    'Помимо connect и цепочек пакет отдаёт помощников: вычислить id объекта по ключу без запроса, захэшировать ' +
    'пароль, проверить данные тем же валидатором, что и база, сгенерировать типы TypeScript, снять строгие типы ' +
    'для имени из переменной, узнать занятые имена.',
  tables: [],
  covers: ['export.idOf', 'export.uuidv5', 'export.v5Name', 'export.hashPassword', 'export.verifyHash', 'export.compileValidator',
    'export.applyDefaults', 'export.ValidationError', 'export.generateTypes', 'export.schemaToTs', 'export.Registry',
    'export.CHAIN_METHODS', 'export.DB_METHODS', 'export.RESERVED_CLASS_NAMES', 'export.DDL_REVISION', 'export.connect',
    'export.loose', 'connect.models', 'nuance.strict-types-loose'],
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
      title: 'Хэш, которому нужно слишком много памяти, — понятный отказ',
      text:
        'Параметры scrypt берутся из строки хэша, поэтому подходят и хэши из других систем — пока scrypt укладывается в ' +
        '64 МБ памяти. Хэшу с N = 2²⁰ нужен гигабайт: ответ — `invalid_data` с объяснением, а не сырая ошибка Node.js и не ' +
        '«неверный пароль».',
      run: async () => verifyHash('Секрет-2026', 'scrypt$1048576$8$1$c2FsdA==$aGFzaA=='),
      expect: { error: 'invalid_data' },
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
      title: 'Неверный шаблон pattern — отказ invalid_class',
      text: 'Шаблон, неверный уже для JavaScript (здесь — незакрытая скобка), валидатор отвергает с путём поля — так же, как база отвергла бы такое описание класса.',
      run: async () => compileValidator({ type: 'object', properties: { sku: { type: 'string', pattern: '^(K' } } }),
      expect: { error: 'invalid_class' },
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
      title: 'Строгие типы и loose(db)',
      text:
        'Подключение с моделями (`connect({ models })`) или с объявлениями `letopis types` (`connect<Models>()`) — со ' +
        'строгими типами: опечатку в имени класса, роли или поля TypeScript находит при компиляции. Имя, известное ' +
        'только во время выполнения (из настроек, из запроса), — `loose(db)[имя]()`: то же подключение без строгих ' +
        'типов, проверки во время выполнения те же.',
      run: async ({ connect, dsn, schema, up }) => {
        const typed = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, models: shopModels });
        const shops = await typed.Shop({ name: 'Ромашка' }).count(); // класс Shop есть в моделях — типы строгие
        const name: string = 'Shop'; // имя из переменной
        return { 'typed.Shop(…).count()': shops, 'loose(typed) — тот же объект': (loose(typed) as unknown) === typed, 'loose(typed)[name]().count()': await loose(typed)[name]().count() };
      },
    },
    {
      title: 'Зарезервированные имена и ревизия движка',
      text:
        'Имена методов цепочки и `db` классам не дают: библиотека разбирает их раньше классов. Класс hub с таким именем ' +
        'отклоняют `hub()`, `syncModels` и база, связь — база (`invalid_class`).',
      run: async () => ({
        'методов цепочки': CHAIN_METHODS.length, 'методов db': DB_METHODS.length,
        'зарезервировано имён': RESERVED_CLASS_NAMES.length, 'среди них where?': RESERVED_CLASS_NAMES.includes('where'),
        'ревизия движка': DDL_REVISION,
      }),
    },
    {
      title: 'Класс hub с зарезервированным именем — отказ',
      text: '`hub("count", …)` отказывает сразу, до базы: шаг `db.count()` цепочка приняла бы за метод.',
      run: async () => hub('count', { n: z.number() }, {}),
      expect: { error: 'invalid_class' },
    },
  ],
});
