import {
  idOf, uuidv5, v5Name, compileValidator, applyDefaults, ValidationError, generateTypes, schemaToTs,
  Registry, CHAIN_METHODS, DB_METHODS, RESERVED_CLASS_NAMES, DDL_REVISION, loose,
} from 'letopis';
import type { TypedDb } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

export default example({
  title: 'Служебные экспорты: id из ключа, валидатор, типы, строгие типы, зарезервированные имена',
  summary:
    'Помимо setup, connect и цепочек пакет отдаёт помощников: вычислить id объекта по ключу без запроса, проверить ' +
    'данные тем же валидатором, что и база, сгенерировать типы TypeScript, снять строгие типы для имени из ' +
    'переменной, узнать занятые имена.',
  tables: [],
  covers: ['export.idOf', 'export.uuidv5', 'export.v5Name', 'export.compileValidator',
    'export.applyDefaults', 'export.ValidationError', 'export.generateTypes', 'export.schemaToTs', 'export.Registry',
    'export.CHAIN_METHODS', 'export.DB_METHODS', 'export.RESERVED_CLASS_NAMES', 'export.DDL_REVISION',
    'export.loose', 'nuance.strict-types-loose'],
  models: shopModels,
  steps: [
    {
      title: 'id объекта по ключу — без запроса к базе',
      text:
        '`idOf(класс, ключ, { tenant })` даёт тот же id, что и база: UUID v5 из квартиры, имени класса и значений ' +
        'ключа. id квартиры — `me.tenant`.',
      run: async ({ me }) => {
        const [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        const tenant = me.tenant;
        return {
          'idOf совпал с id строки': idOf({ name: 'Shop', key: ['name'], ends: [] }, { name: 'Ромашка' }, { tenant }) === shop.id,
          'uuidv5(v5Name(…), квартира) — то же': uuidv5(v5Name('Shop', ['Ромашка']), tenant) === shop.id,
          'v5Name': v5Name('Shop', ['Ромашка']),
        };
      },
    },
    {
      title: 'Валидатор и значения по умолчанию — те же проверки, что в базе',
      text: '`compileValidator(схема)` проверяет данные до отправки; `applyDefaults` дописывает значения по умолчанию; ошибка — `ValidationError` со списком нарушений.',
      run: async ({ me }) => {
        const schema = me.registry.resolve('Product').schema;
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
      run: async ({ me }) => ({
        'generateTypes, начало': generateTypes(me.registry).split('\n').find((l) => l.startsWith('export interface')),
        'schemaToTs': schemaToTs({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }),
        'реестр — экземпляр Registry': me.registry instanceof Registry,
      }),
    },
    {
      title: 'Строгие типы и loose()',
      text:
        'Строгие типы цепочек задаёт тип `TypedDb<typeof модели>` (или объявления `letopis types`): опечатку в имени ' +
        'класса, роли или поля TypeScript находит при компиляции. Корень квартиры приводят к нему одной строкой — это ' +
        'только тип, объект тот же. Имя, известное только во время выполнения (из настроек, из запроса), — ' +
        '`loose(typed)[имя]()`: тот же корень без строгих типов, проверки во время выполнения те же.',
      run: async ({ me }) => {
        const typed = me as unknown as TypedDb<typeof shopModels>; // только тип: объект тот же
        const shops = await typed.Shop({ name: 'Ромашка' }).count(); // класс Shop есть в моделях — типы строгие
        const name: string = 'Shop'; // имя из переменной
        return { 'typed.Shop(…).count()': shops, 'loose(typed) — тот же объект': (loose(typed) as unknown) === me, 'loose(typed)[name]().count()': await loose(typed)[name]().count() };
      },
    },
    {
      title: 'Зарезервированные имена и ревизия движка',
      text:
        'Имена методов цепочки и корня квартиры классам не дают: библиотека разбирает их раньше классов. Класс hub с ' +
        'таким именем отклоняют `hub()`, `syncModels` и база, связь — база (`invalid_class`).',
      run: async () => ({
        'методов цепочки': CHAIN_METHODS.length, 'методов корня': DB_METHODS.length,
        'зарезервировано имён': RESERVED_CLASS_NAMES.length, 'среди них where?': RESERVED_CLASS_NAMES.includes('where'),
        'ревизия движка': DDL_REVISION,
      }),
    },
    {
      title: 'Класс hub с зарезервированным именем — отказ',
      text: '`hub("count", …)` отказывает сразу, до базы: шаг `me.count()` цепочка приняла бы за метод.',
      run: async () => hub('count', { n: z.number() }, {}),
      expect: { error: 'invalid_class' },
    },
  ],
});
