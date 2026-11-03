/**
 * Раздел sql-time: lib/sql/70-read.sql, 90-time.sql, 95-seed.system.sql, 99-revision.sql и lib/sql/migrate —
 * чтение, история, обслуживание, сид. Русский текст собирает
 * база из этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и
 * параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlTime = {
  // 90-time.sql, signal_key()
  'sql-time.signals_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.signals',
  },
  // 90-time.sql, last_version_visible()
  'sql-time.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена',
  },
  // 90-time.sql, restore(), account_purge()
  'sql-time.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
  },
  // 90-time.sql, restore()
  'sql-time.restore_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: restore — только для удалённых',
  },
  // 90-time.sql, restore(): живой объект с этим id уже удаляли — id занял новый объект с тем же ключом
  'sql-time.restore_id_taken': {
    code: 'not_deleted',
    ru: 'id {id} занят новым объектом с тем же ключом — create по ключу удалённого берёт его id, восстанавливать нечего',
    hint: 'объект с этим ключом уже живёт: прочитайте его; перед create() по ключу удалённого проверьте db.Класс({ ключ }).withDeleted()',
  },
  // 90-time.sql, restore(p_id, p_rev): последняя версия id не p_rev (пересоздан, удалён снова) — restore({ expect }).
  // Код базы — not_deleted (conflict в каталоге базы нет); библиотека отдаёт его как write.restore_stale (conflict)
  'sql-time.restore_stale': {
    code: 'not_deleted',
    ru: 'restore: {id} уже не тот, что удаляли — последняя версия {rev}, ожидалась {expected}',
    hint: 'объект пересоздан или удалён снова: вещь уже у другого — сообщить пользователю, а не восстанавливать',
  },
  // 90-time.sql, restore()
  'sql-time.restore_class_row': {
    code: 'invalid_class',
    ru: 'описание класса восстанавливается созданием строки Class',
  },
  // 90-time.sql, restore()
  'sql-time.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден',
  },
  // 90-time.sql, restore()
  'sql-time.class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён',
  },
  // 90-time.sql, restore()
  'sql-time.class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
  },
  // 90-time.sql, restore()
  'sql-time.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // 90-time.sql, restore()
  'sql-time.restore_key_changed': {
    code: 'id_mismatch',
    ru: 'ключ класса {cls} изменился: id объекта не равен v5 от ключа',
  },
  // 90-time.sql, restore()
  'sql-time.no_write_row': {
    code: 'acl_denied',
    ru: 'нет права WRITE на строку класса {cls}',
  },
  // 90-time.sql, account_purge()
  'sql-time.purge_self': {
    code: 'acl_denied',
    ru: 'удалить себя нельзя',
  },
  // 90-time.sql, account_purge()
  'sql-time.account_purge_denied': {
    code: 'acl_denied',
    ru: 'удалить аккаунт может системный администратор или владелец его арендатора',
  },
  // 90-time.sql, account_purge()
  'sql-time.account_not_found': {
    code: 'target_not_found',
    ru: 'аккаунт не найден',
  },
  // 90-time.sql, account_purge(): аккаунт — единственный включённый владелец чужого арендатора; detail.tenant — он же
  'sql-time.last_owner': {
    code: 'acl_denied',
    ru: 'аккаунт — последний владелец арендатора {tenant}',
    hint: 'сначала дать роль owner в этом арендаторе другому аккаунту (db.acl.roles от фасада арендатора), затем удалять',
  },
  // 90-time.sql, account_purge()
  'sql-time.account_referenced': {
    code: 'delete_restricted',
    ru: 'на аккаунт ссылаются другие строки',
  },
  // 90-time.sql, maintain()
  'sql-time.maintain_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.maintain',
  },
} satisfies Section<'sql-time'>;
