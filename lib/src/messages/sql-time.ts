/**
 * Раздел sql-time: lib/sql/70-read.sql, 75-history.sql, 90-time.sql, 95-seed.system.sql,
 * 99-revision.sql и lib/sql/migrate — чтение, история, хранение, сид. Русский текст собирает
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
  // 90-time.sql, last_version_visible(), trim_history(), rekey()
  'sql-time.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена',
  },
  // 90-time.sql, restore(), purge(), trim_history(), rekey(), rekey_class(), account_purge()
  'sql-time.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
  },
  // 90-time.sql, restore()
  'sql-time.restore_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: restore — только для удалённых',
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
  // 90-time.sql, restore(), rekey()
  'sql-time.class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён',
  },
  // 90-time.sql, restore()
  'sql-time.class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
  },
  // 90-time.sql, restore(), rekey()
  'sql-time.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // 90-time.sql, restore()
  'sql-time.restore_key_changed': {
    code: 'id_mismatch',
    ru: 'ключ класса {cls} изменился: id объекта не равен v5 от ключа',
  },
  // 90-time.sql, restore(), rekey(), rekey_class()
  'sql-time.no_write_row': {
    code: 'acl_denied',
    ru: 'нет права WRITE на строку класса {cls}',
  },
  // 90-time.sql, purge()
  'sql-time.purge_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: purge — только для удалённых, сначала delete()',
  },
  // 90-time.sql, purge()
  'sql-time.purge_system': {
    code: 'invalid_class',
    ru: 'история системных классов — аудит прав и схемы: purge недоступен',
  },
  // 90-time.sql, purge(), trim_history()
  'sql-time.no_delete_class': {
    code: 'acl_denied',
    ru: 'нет права DELETE на класс {cls}',
  },
  // 90-time.sql, purge()
  'sql-time.purge_restored': {
    code: 'not_deleted',
    ru: 'объект восстановлен во время purge',
  },
  // 90-time.sql, trim_history()
  'sql-time.trim_args': {
    code: 'invalid_data',
    ru: 'обрезка истории: нужны цели и момент',
  },
  // 90-time.sql, trim_history()
  'sql-time.trim_system': {
    code: 'invalid_class',
    ru: 'история системных классов — аудит прав и схемы: обрезка недоступна',
  },
  // 90-time.sql, rekey(), rekey_class()
  'sql-time.rekey_isolation': {
    code: 'isolation_level',
    ru: 'смена ключа разрешена только в read committed',
  },
  // 90-time.sql, rekey()
  'sql-time.rekey_system_row': {
    code: 'invalid_class',
    ru: 'ключ системной строки не меняется',
  },
  // 90-time.sql, rekey()
  'sql-time.rekey_no_key': {
    code: 'invalid_class',
    ru: 'у класса {cls} нет ключа: id выдаёт база, менять нечего',
  },
  // 90-time.sql, rekey()
  'sql-time.no_write_class': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
  },
  // 90-time.sql, rekey()
  'sql-time.refs_denied_class': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки класса {cls}',
  },
  // 90-time.sql, rekey()
  'sql-time.refs_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден среди классов арендатора',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_system_class': {
    code: 'invalid_class',
    ru: 'ключ системного класса не меняется',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_class_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс Class',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_conflict': {
    code: 'tightening_conflict',
    ru: 'новому ключу класса {cls} не соответствуют строки',
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
  // 90-time.sql, maintain(): момент «сейчас» (p_now) — не от администраторской роли подключения (admin_role)
  'sql-time.maintain_now': {
    code: 'acl_denied',
    ru: 'maintain(now) — только на администраторском подключении',
  },
  // 90-time.sql, verify()
  'sql-time.verify_denied': {
    code: 'acl_denied',
    ru: 'verify доступен только системному администратору',
  },
  // 90-time.sql, verify(): находки — тексты problem (код записи не печатается). Находка несёт ещё key и params — verify()
  // библиотеки (admin.ts) их убирает
  'sql-time.verify_chain_start': {
    code: 'invalid_data',
    ru: 'цепочка начинается не с версии 1',
  },
  'sql-time.verify_prev_hash': {
    code: 'invalid_data',
    ru: 'хэш версии не совпадает с prev_hash следующей',
  },
  // from, to — номера пропавших версий
  'sql-time.verify_gap': {
    code: 'invalid_data',
    ru: 'разрыв: нет версий {from}…{to}',
  },
  'sql-time.verify_trim_rev': {
    code: 'invalid_data',
    ru: 'номер версии меньше ожидаемого после обрезки',
  },
  'sql-time.verify_entity_head': {
    code: 'invalid_data',
    ru: 'строка entity не совпадает с последней версией журнала',
  },
  // verify(p_data): данные строк
  'sql-time.verify_class': {
    code: 'invalid_data',
    ru: 'класс строки не найден или абстрактный',
  },
  // нарушения — в поле issues находки
  'sql-time.verify_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса',
  },
  'sql-time.verify_key_id': {
    code: 'invalid_data',
    ru: 'id не равен v5 от ключа класса',
  },
  'sql-time.verify_tenant': {
    code: 'invalid_data',
    ru: 'арендатор строки не существует',
  },
  'sql-time.verify_owner': {
    code: 'invalid_data',
    ru: 'владелец строки не существует',
  },
  'sql-time.verify_end_target': {
    code: 'invalid_data',
    ru: 'цель конца не найдена',
  },
  // 90-time.sql, verify(): находка — надгробие не совпадает с предыдущей версией (план 2.0, 7.3 №5)
  'sql-time.verify_tombstone': {
    code: 'invalid_data',
    ru: 'надгробие не совпадает с предыдущей версией',
  },
  // 90-time.sql, verify(): находка — колонку hash считает не выражение установки (ревью: снятое выражение)
  'sql-time.verify_hash_column': {
    code: 'invalid_data',
    ru: 'колонка hash таблицы {table} не генерируемая или её выражение — не то, что ставит установка: подмену хэшей не выдадут ни цепочки, ни якорь',
  },
  // 90-time.sql, verify(p_data): находка — хранимый хэш версии не равен пересчитанному (ревью: подмена тела функции хэша)
  'sql-time.verify_hash_recomputed': {
    code: 'invalid_data',
    ru: 'хэш версии не равен пересчитанному из её содержимого: версию записали при подменённой функции хэша или выражении колонки hash',
  },
  // 90-time.sql, watch_read()
  'sql-time.cursor_expired': {
    code: 'cursor_expired',
    ru: 'курсор подписки старше яруса all — события могли проредиться, перечитайте текущее состояние',
  },
} satisfies Section<'sql-time'>;
