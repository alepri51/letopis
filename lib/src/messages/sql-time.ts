/**
 * Раздел sql-time: lib/sql/70-read.sql, 90-time.sql, 95-seed.system.sql, 99-revision.sql — чтение, история,
 * обслуживание, удаление аккаунта, сид. Русский текст собирает база из этих же записей: установщик кладёт разделы
 * sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят в DETAIL.
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
  // 90-time.sql, restore()
  'sql-time.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
  },
  // 90-time.sql, restore()
  'sql-time.restore_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: restore — только для удалённых',
  },
  // 90-time.sql, restore(): живой объект, за последним надгробием которого — create: id занял новый объект с тем же
  // ключом; detail — { id, rev }
  'sql-time.restore_id_taken': {
    code: 'not_deleted',
    ru: 'id {id} занят новым объектом с тем же ключом — create по ключу удалённого берёт его id, восстанавливать нечего',
    hint: 'объект с этим ключом уже живёт: прочитайте его; перед create() по ключу удалённого проверьте me.Класс({ ключ }).withDeleted()',
  },
  // 90-time.sql, restore(): живой объект, за последним надгробием которого — restore: уже восстановлен (другой запрос
  // успел первым); detail — { id, rev }; библиотека отдаёт его как write.restore_already
  'sql-time.restore_already': {
    code: 'not_deleted',
    ru: 'restore: {id} уже восстановлен — объект живой, восстанавливать нечего',
    hint: 'его вернул другой запрос: прочитайте объект; восстанавливать снова не нужно',
  },
  // 90-time.sql, restore(p_id, p_rev): последняя версия id не p_rev, и это не «уже восстановлен» и не «id занят» (удалён
  // снова, не удалялся, гонка). detail — { id, rev, expected, after, deleted, live }: after — вид записи журнала сразу
  // за p_rev (в тексте «—», если её нет). Код базы — not_deleted (conflict в каталоге базы нет); библиотека отдаёт его
  // как write.restore_stale (conflict)
  'sql-time.restore_stale': {
    code: 'not_deleted',
    ru: 'restore: {id} уже не тот, что удаляли — последняя версия {rev}, ожидалась {expected}; после того удаления — {after}',
    hint: 'объект менялся после показанного удаления (detail.after, detail.deleted, detail.live): вещь уже у другого — сообщить пользователю, а не восстанавливать',
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
  // 90-time.sql, account_remove()
  'sql-time.account_not_found': {
    code: 'target_not_found',
    ru: 'аккаунт не найден',
  },
  // 90-time.sql, account_remove()
  'sql-time.account_referenced': {
    code: 'delete_restricted',
    ru: 'на аккаунт ссылаются другие строки',
  },
  // 90-time.sql, maintain(): не подключение мастер-ключом и нет права letopis.maintain по правилам System
  'sql-time.maintain_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.maintain',
  },
} satisfies Section<'sql-time'>;
