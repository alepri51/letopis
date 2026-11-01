/**
 * Раздел sql-write: lib/sql/60-write.sql — триггеры записи, merge, inc, каскад, reclass. Русский текст собирает база из
 * этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят
 * в DETAIL.
 */
import type { Section } from './types.js';

export const sqlWrite = {
  // 60-write.sql, триггеры вставки и правки, move_row: данные не проходят описание класса; detail.issues — нарушения
  'sql-write.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
    en: 'the data does not match the description of class {cls}',
  },
} satisfies Section<'sql-write'>;
