/**
 * Раздел sql-access: lib/sql/50-acl.sql, lib/sql/80-auth.sql — права, креды, вход. Русский текст собирает база из этих же записей:
 * установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlAccess = {} satisfies Section<'sql-access'>;
