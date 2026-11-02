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
    en: 'projector {projector}: unknown operation {op}',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_row_not_object': {
    code: 'invalid_data',
    ru: 'проектор {projector}: строка — не объект',
    en: 'projector {projector}: the row is not an object',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_tenant_not_uuid': {
    code: 'invalid_data',
    ru: 'проектор {projector}: арендатор строки — не uuid',
    en: 'projector {projector}: the row tenant is not a uuid',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден (проектор {projector}, арендатор {tenant})',
    en: 'class {cls} not found (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён (проектор {projector}, арендатор {tenant})',
    en: 'class {cls} is deleted (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_not_derived': {
    code: 'derived_class',
    ru: 'класс {cls} не производный проектора {projector} (проектор {projector}, арендатор {tenant})',
    en: 'class {cls} is not derived by projector {projector} (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный (проектор {projector}, арендатор {tenant})',
    en: 'class {cls} is abstract (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_no_id': {
    code: 'invalid_data',
    ru: 'класс {cls} без ключа: проектору нужен $id строки (проектор {projector}, арендатор {tenant})',
    en: 'class {cls} has no key: the projector needs the row $id (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_id_mismatch': {
    code: 'id_mismatch',
    ru: '$id не равен v5 от ключа класса {cls} (проектор {projector}, арендатор {tenant})',
    en: '$id is not the v5 of the key of class {cls} (projector {projector}, tenant {tenant})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_id_taken': {
    code: 'id_mismatch',
    ru: 'id занят строкой другого класса или арендатора (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'the id is taken by a row of another class or tenant (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_inc_not_number': {
    code: 'invalid_data',
    ru: 'приращение поля {field} — не число (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'the increment of field {field} is not a number (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'the data does not match the description of class {cls} (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply(): отказ концов check_links — запись sql-write.<ключ> с хвостом проектора; ключ
  // строит derived_apply: sql-time.projector_<ключ sql-write без раздела>, код — тот же
  'sql-time.projector_links_not_object': {
    code: 'invalid_data',
    ru: 'links — не объект (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'links is not an object (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_undeclared': {
    code: 'undeclared_end',
    ru: 'конец {end} не объявлен в классе {cls} (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end} is not declared in class {cls} (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_not_list': {
    code: 'invalid_data',
    ru: 'конец {end} — список id (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end} is a list of ids (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_not_uuid': {
    code: 'invalid_data',
    ru: 'конец {end}: значение не uuid (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end}: the value is not a uuid (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_target_repeated': {
    code: 'invalid_data',
    ru: 'конец {end}: цель повторяется (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end}: the target is repeated (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком мало целей (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end} has too few targets (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком много целей (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end} has too many targets (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {end} не задан (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'required end {end} is not set (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_target_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на строку производного класса (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'end {end} points to a row of a derived class (projector {projector}, tenant {tenant}, row {id})',
  },
  'sql-time.projector_end_target_missing': {
    code: 'target_not_found',
    ru: 'цель конца {end} не найдена (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'the target of end {end} is not found (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_tags': {
    code: 'invalid_data',
    ru: '$tags — список строк (проектор {projector}, арендатор {tenant}, строка {id})',
    en: '$tags is a list of strings (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_owner_uuid': {
    code: 'invalid_data',
    ru: '$owner — не uuid (проектор {projector}, арендатор {tenant}, строка {id})',
    en: '$owner is not a uuid (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, derived_apply()
  'sql-time.projector_owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец строки не найден (проектор {projector}, арендатор {tenant}, строка {id})',
    en: 'the row owner is not found (projector {projector}, tenant {tenant}, row {id})',
  },
  // 88-derived.sql, agg_guard()
  'sql-time.agg_field_readonly': {
    code: 'aggregate_field',
    ru: 'поле {field} класса {cls} считает база (aggregate) — его не меняют',
    en: 'field {field} of class {cls} is computed by the database (aggregate); it is not changed',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_system': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: системный класс {src} не бывает источником агрегата',
    en: 'aggregate {cls}.{field}: system class {src} cannot be an aggregate source',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_derived': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: производный класс {src} не бывает источником агрегата',
    en: 'aggregate {cls}.{field}: derived class {src} cannot be an aggregate source',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_no_end': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: у источника {src} нет конца {via}',
    en: 'aggregate {cls}.{field}: source {src} has no end {via}',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_end_many': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: конец {via} источника {src} множественный — агрегат считается через одиночный конец',
    en: 'aggregate {cls}.{field}: end {via} of source {src} is multiple; an aggregate is computed through a single end',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_source_end_class': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: конец {via} источника {src} не принимает класс {cls}',
    en: 'aggregate {cls}.{field}: end {via} of source {src} does not accept class {cls}',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_sum_not_number': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: поле суммы {sum} источника {src} — число (integer или number)',
    en: 'aggregate {cls}.{field}: the sum field {sum} of source {src} must be a number (integer or number)',
  },
  // 88-derived.sql, agg_check_source()
  'sql-time.agg_sum_number_to_integer': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: сумма поля number {src}.{sum} в поле integer не помещается',
    en: 'aggregate {cls}.{field}: a sum of the number field {src}.{sum} does not fit into an integer field',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_target_system': {
    code: 'invalid_class',
    ru: 'системный класс не бывает целью агрегата',
    en: 'a system class cannot be an aggregate target',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_target_derived': {
    code: 'invalid_class',
    ru: 'производный класс {cls} не бывает целью агрегата: его строки строит проектор',
    en: 'derived class {cls} cannot be an aggregate target: its rows are built by a projector',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_sum_or_count': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: нужно ровно одно из sum (поле источника) и count: true',
    en: 'aggregate {cls}.{field}: exactly one of sum (a source field) and count: true is required',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_missing': {
    code: 'invalid_class',
    ru: 'агрегатного поля {field} нет среди полей класса {cls}',
    en: 'aggregate field {field} is not among the fields of class {cls}',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_not_number': {
    code: 'invalid_class',
    ru: 'агрегатное поле {cls}.{field} — число (integer или number)',
    en: 'aggregate field {cls}.{field} must be a number (integer or number)',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_field_in_key': {
    code: 'invalid_class',
    ru: 'агрегатное поле {cls}.{field} в ключ не входит',
    en: 'aggregate field {cls}.{field} cannot be part of the key',
  },
  // 88-derived.sql, agg_prepare()
  'sql-time.agg_cycle': {
    code: 'invalid_class',
    ru: 'цикл агрегатов: {cycle}',
    en: 'aggregate cycle: {cycle}',
  },
  // 88-derived.sql, agg_source_admit()
  'sql-time.agg_source_read': {
    code: 'acl_denied',
    ru: 'класс {cls} становится источником агрегата {agg}.{field}: нужно право READ на все его строки',
    en: 'class {cls} becomes a source of aggregate {agg}.{field}: the READ right on all its rows is required',
  },
  // 88-derived.sql, agg_author_admit()
  'sql-time.agg_author_read': {
    code: 'acl_denied',
    ru: 'класс {cls} становится источником агрегата {agg}.{field}, а описавший агрегат не читает все его строки (право READ без условий): агрегат описывает заново тот, кто их читает',
    en: 'class {cls} becomes a source of aggregate {agg}.{field}, but the author of the aggregate does not read all its rows (the READ right without conditions): the aggregate is described again by someone who reads them',
  },
  // 88-derived.sql, agg_check()
  'sql-time.agg_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (агрегатное поле)',
    en: 'the data does not match the description of class {cls} (aggregate field)',
  },
  // 88-derived.sql, rebuild_aggregates()
  'sql-time.aggregates_none': {
    code: 'invalid_class',
    ru: 'у класса {cls} и его потомков нет агрегатов (aggregate) — пересчитывать нечего',
    en: 'class {cls} and its descendants have no aggregates (aggregate): nothing to recompute',
  },
  // 88-derived.sql, agg_fill()
  'sql-time.agg_fill_diverged': {
    code: 'invalid_class',
    ru: 'первая заливка: агрегаты не сошлись за 32 прохода',
    en: 'initial fill: aggregates did not converge in 32 passes',
  },
  // 88-derived.sql, agg_fill()
  'sql-time.agg_fill_invalid': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls} (агрегатное поле строки {id} после первой заливки)',
    en: 'the data does not match the description of class {cls} (aggregate field of row {id} after the initial fill)',
  },
  // 90-time.sql, signal_key()
  'sql-time.signals_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.signals',
    en: 'no letopis.signals right',
  },
  // 90-time.sql, last_version_visible(), trim_history(), rekey()
  'sql-time.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена',
    en: 'the target is not found',
  },
  // 90-time.sql, restore(), purge(), trim_history(), rekey(), rekey_class(), account_purge()
  'sql-time.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
    en: 'no active session',
  },
  // 90-time.sql, restore()
  'sql-time.restore_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: restore — только для удалённых',
    en: 'the object is not deleted: restore is only for deleted objects',
  },
  // 90-time.sql, restore()
  'sql-time.restore_class_row': {
    code: 'invalid_class',
    ru: 'описание класса восстанавливается созданием строки Class',
    en: 'a class description is restored by creating a Class row',
  },
  // 90-time.sql, restore()
  'sql-time.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден',
    en: 'class {cls} not found',
  },
  // 90-time.sql, restore(), rekey()
  'sql-time.class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён',
    en: 'class {cls} is deleted',
  },
  // 90-time.sql, restore()
  'sql-time.class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
    en: 'class {cls} is abstract',
  },
  // 90-time.sql, restore(), rekey(), rekey_class()
  'sql-time.class_derived': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
    en: 'class {cls} is derived: its rows are written by projector {projector}',
  },
  // 90-time.sql, restore(), rekey()
  'sql-time.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
    en: 'the data does not match the description of class {cls}',
  },
  // 90-time.sql, restore()
  'sql-time.restore_key_changed': {
    code: 'id_mismatch',
    ru: 'ключ класса {cls} изменился: id объекта не равен v5 от ключа',
    en: 'the key of class {cls} has changed: the object id is not the v5 of the key',
  },
  // 90-time.sql, restore(), rekey(), rekey_class()
  'sql-time.no_write_row': {
    code: 'acl_denied',
    ru: 'нет права WRITE на строку класса {cls}',
    en: 'no WRITE right on a row of class {cls}',
  },
  // 90-time.sql, purge()
  'sql-time.purge_not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: purge — только для удалённых, сначала delete()',
    en: 'the object is not deleted: purge is only for deleted objects, call delete() first',
  },
  // 90-time.sql, purge()
  'sql-time.purge_system': {
    code: 'invalid_class',
    ru: 'история системных классов — аудит прав и схемы: purge недоступен',
    en: 'the history of system classes is the audit of rights and schema: purge is not available',
  },
  // 90-time.sql, purge(), trim_history()
  'sql-time.no_delete_class': {
    code: 'acl_denied',
    ru: 'нет права DELETE на класс {cls}',
    en: 'no DELETE right on class {cls}',
  },
  // 90-time.sql, purge()
  'sql-time.purge_projector_pending': {
    code: 'projector_pending',
    ru: 'проектор источника ещё не прочёл удаление: purge — после его run()',
    en: 'the source projector has not read the deletion yet: purge after its run()',
  },
  // 90-time.sql, purge()
  'sql-time.purge_restored': {
    code: 'not_deleted',
    ru: 'объект восстановлен во время purge',
    en: 'the object was restored during purge',
  },
  // 90-time.sql, trim_history()
  'sql-time.trim_args': {
    code: 'invalid_data',
    ru: 'обрезка истории: нужны цели и момент',
    en: 'history trim: targets and a moment are required',
  },
  // 90-time.sql, trim_history()
  'sql-time.trim_system': {
    code: 'invalid_class',
    ru: 'история системных классов — аудит прав и схемы: обрезка недоступна',
    en: 'the history of system classes is the audit of rights and schema: trimming is not available',
  },
  // 90-time.sql, trim_history()
  'sql-time.trim_projector_pending': {
    code: 'projector_pending',
    ru: 'проектор источника ещё не прочёл версии: trimHistory — после его run()',
    en: 'the source projector has not read the versions yet: trimHistory after its run()',
  },
  // 90-time.sql, rekey(), rekey_class()
  'sql-time.rekey_isolation': {
    code: 'isolation_level',
    ru: 'смена ключа разрешена только в read committed',
    en: 'a key change is allowed only in read committed',
  },
  // 90-time.sql, rekey()
  'sql-time.rekey_system_row': {
    code: 'invalid_class',
    ru: 'ключ системной строки не меняется',
    en: 'the key of a system row does not change',
  },
  // 90-time.sql, rekey()
  'sql-time.rekey_no_key': {
    code: 'invalid_class',
    ru: 'у класса {cls} нет ключа: id выдаёт база, менять нечего',
    en: 'class {cls} has no key: the id is issued by the database, nothing to change',
  },
  // 90-time.sql, rekey()
  'sql-time.rekey_aggregate': {
    code: 'aggregate_field',
    ru: 'агрегатные поля класса {cls} считает база — в rekey их не передают',
    en: 'the aggregate fields of class {cls} are computed by the database; they are not passed to rekey',
  },
  // 90-time.sql, rekey()
  'sql-time.no_write_class': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
    en: 'no WRITE right on class {cls}',
  },
  // 90-time.sql, rekey()
  'sql-time.refs_denied_class': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки класса {cls}',
    en: 'no WRITE right on the referencing rows of class {cls}',
  },
  // 90-time.sql, rekey()
  'sql-time.refs_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки',
    en: 'no WRITE right on the referencing rows',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден среди классов арендатора',
    en: 'class {cls} not found among the classes of the tenant',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_system_class': {
    code: 'invalid_class',
    ru: 'ключ системного класса не меняется',
    en: 'the key of a system class does not change',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_derived_child': {
    code: 'derived_class',
    ru: 'у класса {cls} производный потомок {child}: его строки пишет проектор',
    en: 'class {cls} has a derived descendant {child}: its rows are written by a projector',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_class_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс Class',
    en: 'no WRITE right on class Class',
  },
  // 90-time.sql, rekey_class()
  'sql-time.rekey_conflict': {
    code: 'tightening_conflict',
    ru: 'новому ключу класса {cls} не соответствуют строки',
    en: 'rows do not match the new key of class {cls}',
  },
  // 90-time.sql, account_purge()
  'sql-time.purge_self': {
    code: 'acl_denied',
    ru: 'удалить себя нельзя',
    en: 'you cannot delete yourself',
  },
  // 90-time.sql, account_purge()
  'sql-time.account_purge_denied': {
    code: 'acl_denied',
    ru: 'удалить аккаунт может системный администратор или владелец его арендатора',
    en: 'an account can be deleted by the system administrator or an owner of its tenant',
  },
  // 90-time.sql, account_purge()
  'sql-time.account_not_found': {
    code: 'target_not_found',
    ru: 'аккаунт не найден',
    en: 'the account is not found',
  },
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
  // 90-time.sql, account_purge()
  'sql-time.account_referenced': {
    code: 'delete_restricted',
    ru: 'на аккаунт ссылаются другие строки',
    en: 'other rows reference the account',
  },
  // 90-time.sql, reset()
  'sql-time.reset_disabled': {
    code: 'reset_disabled',
    ru: 'reset выключен в этой установке (up({ allowReset }))',
    en: 'reset is disabled in this installation (up({ allowReset }))',
  },
  // 90-time.sql, reset()
  'sql-time.reset_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.reset',
    en: 'no letopis.reset right',
  },
  // 90-time.sql, reset()
  'sql-time.reset_confirm': {
    code: 'confirm_mismatch',
    ru: 'подтверждение сброса — имя схемы установки',
    en: 'the reset confirmation is the schema name of the installation',
  },
  // 90-time.sql, reset()
  'sql-time.reset_system': {
    code: 'tenant_denied',
    ru: 'System сбрасывается только целиком (level all)',
    en: 'System is reset only as a whole (level all)',
  },
  // 90-time.sql, reset()
  'sql-time.tenant_not_found': {
    code: 'target_not_found',
    ru: 'арендатор не найден',
    en: 'the tenant is not found',
  },
  // 90-time.sql, reset()
  'sql-time.reset_level': {
    code: 'invalid_data',
    ru: 'уровень сброса {level}: sessions, tenant или all',
    en: 'reset level {level}: sessions, tenant or all',
  },
  // 90-time.sql, maintain()
  'sql-time.maintain_denied': {
    code: 'acl_denied',
    ru: 'нет права letopis.maintain',
    en: 'no letopis.maintain right',
  },
  // 90-time.sql, maintain()
  'sql-time.maintain_now': {
    code: 'reset_disabled',
    ru: 'maintain(now) — только в установке с allow_reset',
    en: 'maintain(now) only in an installation with allow_reset',
  },
  // 90-time.sql, verify()
  'sql-time.verify_denied': {
    code: 'acl_denied',
    ru: 'verify доступен только системному администратору',
    en: 'verify is available only to the system administrator',
  },
  // 90-time.sql, verify(): находка — надгробие не совпадает с предыдущей версией (план 2.0, 7.3 №5)
  'sql-time.verify_tombstone': {
    code: 'invalid_data',
    ru: 'надгробие не совпадает с предыдущей версией',
    en: 'the tombstone does not match the previous version',
  },
  // 90-time.sql, verify(): находка — колонку hash считает не выражение установки (ревью: снятое выражение)
  'sql-time.verify_hash_column': {
    code: 'invalid_data',
    ru: 'колонка hash таблицы {table} не генерируемая или её выражение — не то, что ставит установка: подмену хэшей не выдадут ни цепочки, ни якорь',
    en: 'column hash of table {table} is not generated or its expression is not the one the installer sets: neither the chains nor the anchor would expose forged hashes',
  },
  // 90-time.sql, verify(p_data): находка — хранимый хэш версии не равен пересчитанному (ревью: подмена тела функции хэша)
  'sql-time.verify_hash_recomputed': {
    code: 'invalid_data',
    ru: 'хэш версии не равен пересчитанному из её содержимого: версию записали при подменённой функции хэша или выражении колонки hash',
    en: 'the version hash does not equal the one recomputed from its content: the version was written with a substituted hash function or hash column expression',
  },
  // 90-time.sql, watch_read()
  'sql-time.cursor_expired': {
    code: 'cursor_expired',
    ru: 'курсор подписки старше яруса all — события могли проредиться, перечитайте текущее состояние',
    en: 'the subscription cursor is older than the all tier: events may have been thinned out, re-read the current state',
  },
} satisfies Section<'sql-time'>;
