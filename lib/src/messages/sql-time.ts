/**
 * Раздел sql-time: lib/sql/70-read.sql, 75-history.sql, 88-derived.sql, 90-time.sql, 95-seed.system.sql,
 * 99-revision.sql и lib/sql/migrate — чтение, история, агрегаты и проекторы, хранение, сид. Русский текст собирает
 * база из этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и
 * параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlTime = {
  // 90-time.sql, account_purge(): аккаунт — единственный включённый владелец чужого арендатора; detail.tenant — он же
  'sql-time.last_owner': {
    code: 'acl_denied',
    ru: 'аккаунт — последний владелец арендатора {tenant}',
    en: 'the account is the last owner of tenant {tenant}',
    hint: {
      ru: 'сначала дать роль owner в этом арендаторе другому аккаунту (db.acl.roles от фасада арендатора), затем удалять',
      en: 'first give the owner role in this tenant to another account (db.acl.roles on a facade of the tenant), then delete',
    },
  },
} satisfies Section<'sql-time'>;
