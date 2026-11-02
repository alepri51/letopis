/**
 * Раздел sql-time: lib/sql/70-read.sql, 75-history.sql, 88-derived.sql, 90-time.sql, 95-seed.system.sql,
 * 99-revision.sql и lib/sql/migrate — чтение, история, агрегаты и проекторы, хранение, сид. Русский текст собирает
 * база из этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и
 * параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlTime = {
  // 88-derived.sql, derived_apply()
  'sql-time.projector_unknown_op': {
    code: 'invalid_data',
    ru: 'проектор {projector}: неизвестная операция {op}',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_row_not_object': {
    code: 'invalid_data',
    ru: 'проектор {projector}: строка — не объект',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_tenant_not_uuid': {
    code: 'invalid_data',
    ru: 'проектор {projector}: арендатор строки — не uuid',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_not_derived': {
    code: 'derived_class',
    ru: 'класс {cls} не производный проектора {projector} (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_no_id': {
    code: 'invalid_data',
    ru: 'класс {cls} без ключа: проектору нужен $id строки (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_id_mismatch': {
    code: 'id_mismatch',
    ru: '$id не равен v5 от ключа класса {cls} (проектор {projector}, арендатор {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_id_taken': {
    code: 'id_mismatch',
    ru: 'id занят строкой другого класса или арендатора (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_inc_not_number': {
    code: 'invalid_data',
    ru: 'приращение поля {field} — не число (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply(): отказ концов check_links — запись sql-write.<ключ> с хвостом проектора; ключ
  // строит derived_apply: sql-time.projector_<ключ sql-write без раздела>, код — тот же
  'sql-time.projector_links_not_object': {
    code: 'invalid_data',
    ru: 'links — не объект (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_undeclared': {
    code: 'undeclared_end',
    ru: 'конец {end} не объявлен в классе {cls} (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_not_list': {
    code: 'invalid_data',
    ru: 'конец {end} — список id (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_not_uuid': {
    code: 'invalid_data',
    ru: 'конец {end}: значение не uuid (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_target_repeated': {
    code: 'invalid_data',
    ru: 'конец {end}: цель повторяется (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком мало целей (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком много целей (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {end} не задан (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_target_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на строку производного класса (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  'sql-time.projector_end_target_missing': {
    code: 'target_not_found',
    ru: 'цель конца {end} не найдена (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_tags': {
    code: 'invalid_data',
    ru: '$tags — список строк (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_owner_uuid': {
    code: 'invalid_data',
    ru: '$owner — не uuid (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец строки не найден (проектор {projector}, арендатор {tenant}, строка {id})',
  },
  // 88-derived.sql, agg_guard()
  'sql-time.agg_field_readonly': {
    code: 'aggregate_field',
    ru: 'поле {field} класса {cls} считает база (aggregate) — его не меняют',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_system': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: системный класс {src} не бывает источником агрегата',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_derived': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: производный класс {src} не бывает источником агрегата',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_no_end': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: у источника {src} нет конца {via}',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_end_many': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: конец {via} источника {src} множественный — агрегат считается через одиночный конец',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_end_class': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: конец {via} источника {src} не принимает класс {cls}',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_sum_not_number': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: поле суммы {sum} источника {src} — число (integer или number)',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_sum_number_to_integer': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: сумма поля number {src}.{sum} в поле integer не помещается',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_target_system': {
    code: 'invalid_class',
    ru: 'системный класс не бывает целью агрегата',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_target_derived': {
    code: 'invalid_class',
    ru: 'производный класс {cls} не бывает целью агрегата: его строки строит проектор',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_sum_or_count': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: нужно ровно одно из sum (поле источника) и count: true',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_missing': {
    code: 'invalid_class',
    ru: 'агрегатного поля {field} нет среди полей класса {cls}',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_not_number': {
    code: 'invalid_class',
    ru: 'агрегатное поле {cls}.{field} — число (integer или number)',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_in_key': {
    code: 'invalid_class',
    ru: 'агрегатное поле {cls}.{field} в ключ не входит',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_cycle': {
    code: 'invalid_class',
    ru: 'цикл агрегатов: {cycle}',
  },
  // 88-derived.sql, agg_source_admit()
  'sql-time.agg_source_read': {
    code: 'acl_denied',
    ru: 'класс {cls} становится источником агрегата {agg}.{field}: нужно право READ на все его строки',
  },
  // 88-derived.sql, agg_author_admit()
  'sql-time.agg_author_read': {
    code: 'acl_denied',
    ru: 'класс {cls} становится источником агрегата {agg}.{field}, а описавший агрегат не читает все его строки (право READ без условий): агрегат описывает заново тот, кто их читает',
  },
  // 88-derived.sql, agg_check()
  'sql-time.agg_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (агрегатное поле)',
  },
  // 88-derived.sql, rebuild_aggregates()
  'sql-time.aggregates_none': {
    code: 'invalid_class',
    ru: 'у класса {cls} и его потомков нет агрегатов (aggregate) — пересчитывать нечего',
  },
  // 88-derived.sql, agg_fill()
  'sql-time.agg_fill_diverged': {
    code: 'invalid_class',
    ru: 'первая заливка: агрегаты не сошлись за 32 прохода',
  },
  // 88-derived.sql, agg_fill()
  'sql-time.agg_fill_invalid': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (агрегатное поле строки {id} после первой заливки)',
  },
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
  // 90-time.sql, restore(), rekey(), rekey_class()
  'sql-time.class_derived': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
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
  'sql-time.purge_projector_pending': {
    code: 'projector_pending',
    ru: 'проектор источника ещё не прочёл удаление: purge — после его run()',
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
  // 90-time.sql, trim_history()
  'sql-time.trim_projector_pending': {
    code: 'projector_pending',
    ru: 'проектор источника ещё не прочёл версии: trimHistory — после его run()',
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
  'sql-time.rekey_aggregate': {
    code: 'aggregate_field',
    ru: 'агрегатные поля класса {cls} считает база — в rekey их не передают',
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
  'sql-time.rekey_derived_child': {
    code: 'derived_class',
    ru: 'у класса {cls} производный потомок {child}: его строки пишет проектор',
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
  // 90-time.sql, reset()
  'sql-time.reset_disabled': {
    code: 'reset_disabled',
    ru: 'reset выключен в этой установке (up({ allowReset }))',
  },
  // 90-time.sql, reset()
  'sql-time.reset_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.reset',
  },
  // 90-time.sql, reset()
  'sql-time.reset_confirm': {
    code: 'confirm_mismatch',
    ru: 'подтверждение сброса — имя схемы установки',
  },
  // 90-time.sql, reset()
  'sql-time.reset_system': {
    code: 'tenant_denied',
    ru: 'System сбрасывается только целиком (level all)',
  },
  // 90-time.sql, reset()
  'sql-time.tenant_not_found': {
    code: 'target_not_found',
    ru: 'арендатор не найден',
  },
  // 90-time.sql, reset()
  'sql-time.reset_level': {
    code: 'invalid_data',
    ru: 'уровень сброса {level}: sessions, tenant или all',
  },
  // 90-time.sql, maintain()
  'sql-time.maintain_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.maintain',
  },
  // 90-time.sql, maintain()
  'sql-time.maintain_now': {
    code: 'reset_disabled',
    ru: 'maintain(now) — только в установке с allow_reset',
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
  // агрегатное поле не равно итогу живых источников; stored, expected — значения JSON текстом; в строке значения нет —
  // своя запись
  'sql-time.verify_aggregate': {
    code: 'invalid_data',
    ru: 'агрегат {field} не равен итогу живых источников: в строке {stored}, по источникам {expected} — ремонт rebuildAggregates',
  },
  'sql-time.verify_aggregate_unset': {
    code: 'invalid_data',
    ru: 'агрегат {field} не равен итогу живых источников: в строке нет значения, по источникам {expected} — ремонт rebuildAggregates',
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
