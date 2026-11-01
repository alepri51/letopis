/**
 * Раздел sql-core: lib/sql/10-core.sql, 15-errors.sql, 20-context.sql, 30-validate.sql, 40-class.sql — таблицы,
 * контекст и сессии, проверка данных, классы. Русский текст собирает база из этих же записей: установщик кладёт разделы
 * sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlCore = {
  // 20-context.sql, ctx(): рабочий арендатор чужой, а членства в нём нет (или арендатор выключен)
  'sql-core.no_membership': {
    code: 'tenant_denied',
    ru: 'нет членства в арендаторе',
    en: 'no membership in the tenant',
  },
} satisfies Section<'sql-core'>;
