/**
 * Раздел query: sql.ts, ops.ts — построитель чтения, фильтры, сортировка, курсоры, агрегаты.
 */
import type { Section } from './types.js';

export const query = {
  // sql.ts, sortSpec: поле sort() не из списка
  'query.sort_field': {
    code: 'invalid_query',
    ru: "sort: поле 'at', 'rev', 'id' или 'data.<путь>', а не '{field}'",
    en: "sort: the field is 'at', 'rev', 'id' or 'data.<path>', not '{field}'",
  },
  // sql.ts: поле фильтра, sort() или агрегата не описано ни в одном классе шага — в 1.5 предупреждение (lwarn), в 2.0 —
  // ошибка; where — шаг или вызов, как в коде: Shop({ nmae }), sort('data.nmae'), sum('data.nmae')
  'query.unknown_field': {
    code: 'invalid_query',
    ru: '{where}: поле {field} не описано в классе {cls}',
    en: '{where}: field {field} is not described in class {cls}',
    hint: {
      ru: 'проверить имя поля: похожие названы в тексте, поля класса — db.registry.resolve(класс).schema или describe()',
      en: 'check the field name: similar ones are named in the text, the fields of a class are in db.registry.resolve(class).schema or describe()',
    },
  },
} satisfies Section<'query'>;
