/**
 * Раздел sql-write: lib/sql/60-write.sql — триггеры записи, merge, inc, каскад, reclass. Русский текст собирает база из
 * этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят
 * в DETAIL.
 */
import type { Section } from './types.js';

export const sqlWrite = {
  // 60-write.sql, lock_row(), family_lock(): внутренняя ошибка (SQLSTATE XX000) — строки-замка нет и после вставки или
  // блокировка её не нашла; name — имя строки-замка
  'sql-write.lock_row_not_created': {
    code: 'internal',
    ru: 'строка-замок {name} не создана',
  },
  'sql-write.lock_row_not_found': {
    code: 'internal',
    ru: 'строка-замок {name} не найдена',
  },
  // 60-write.sql, триггеры вставки и правки, move_row: данные не проходят описание класса; detail.issues — нарушения
  'sql-write.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // links_shape(): разбор концов строки (триггеры вставки и правки; check_links — reclass, restore, rekey, проектор)
  'sql-write.links_not_object': {
    code: 'invalid_data',
    ru: 'links — не объект',
  },
  'sql-write.end_undeclared': {
    code: 'undeclared_end',
    ru: 'конец {end} не объявлен в классе {cls}',
  },
  'sql-write.end_not_list': {
    code: 'invalid_data',
    ru: 'конец {end} — список id',
  },
  'sql-write.end_not_uuid': {
    code: 'invalid_data',
    ru: 'конец {end}: значение не uuid',
  },
  'sql-write.end_target_repeated': {
    code: 'invalid_data',
    ru: 'конец {end}: цель повторяется',
  },
  'sql-write.end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком мало целей',
  },
  'sql-write.end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком много целей',
  },
  'sql-write.end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {end} не задан',
  },
  // check_links(), триггеры после вставки и правки (targets_bad): цель конца — строка производного класса или не найдена
  'sql-write.end_target_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на строку производного класса',
  },
  'sql-write.end_target_missing': {
    code: 'target_not_found',
    ru: 'цель конца {end} не найдена',
  },
  // family_conflicts(): чем строка семейства не проходит новое описание — поле problem в detail.rows отказа
  // tightening_conflict (ужесточение класса, rekeyClass); у строки ещё key и params — fromDbError их убирает
  'sql-write.problem_abstract': {
    code: 'tightening_conflict',
    ru: 'класс абстрактный',
  },
  // issues — нарушения текстом JSON без key и params; в params строки — сами нарушения с ключами (массив)
  'sql-write.problem_data': {
    code: 'tightening_conflict',
    ru: 'данные: {issues}',
  },
  'sql-write.problem_key': {
    code: 'tightening_conflict',
    ru: 'id не соответствует ключу класса',
  },
  // ссылающаяся строка видна актору — её роль и id; не видна — ни роли, ни id
  'sql-write.problem_ref': {
    code: 'tightening_conflict',
    ru: 'на строку ссылается роль {role} строки {id}, которая не принимает класс',
  },
  'sql-write.problem_ref_hidden': {
    code: 'tightening_conflict',
    ru: 'на строку ссылается строка, которой актор не видит, и она не принимает класс',
  },
  // class_rows_admit(): нет права без условий на все строки класса {target} (сам класс {cls} или его потомок); что
  // меняется — p_what: reparent, history, tighten, rekey; иной p_what — прежний готовый текст {what}
  'sql-write.reparent_needs_all': {
    code: 'acl_denied',
    ru: 'класс {cls} меняет предков, алиас или derivedBy: нужно право {op} на все строки класса {target}',
  },
  'sql-write.history_needs_all': {
    code: 'acl_denied',
    ru: 'класс {cls} меняет политику хранения истории: нужно право {op} на все строки класса {target}',
  },
  'sql-write.tighten_needs_all': {
    code: 'acl_denied',
    ru: 'ужесточение класса {cls}: нужно право {op} на все строки класса {target}',
  },
  'sql-write.rekey_needs_all': {
    code: 'acl_denied',
    ru: 'смена ключа класса {cls}: нужно право {op} на все строки класса {target}',
  },
  'sql-write.change_needs_all': {
    code: 'acl_denied',
    ru: '{what}: нужно право {op} на все строки класса {target}',
  },
  // class_admit(): проверки строки Class сверх метасхемы
  'sql-write.system_name_reserved': {
    code: 'invalid_class',
    ru: 'имя {name} зарезервировано за системным классом',
  },
  'sql-write.system_flag': {
    code: 'invalid_class',
    ru: 'признак system задаёт только установка',
  },
  'sql-write.system_name_taken': {
    code: 'invalid_class',
    ru: 'имя {name} занято системным классом',
  },
  'sql-write.link_name_reserved': {
    code: 'invalid_class',
    ru: 'имя связи {name} совпадает с методом цепочки',
  },
  // хаб с зарезервированным именем (план 2.0, этап 4, п. 2; 7.10 №3): прежние такие хабы up() оставляет и называет в
  // предупреждении (boot.reserved_hubs), но описание их строки Class база больше не пишет
  'sql-write.hub_name_reserved': {
    code: 'invalid_class',
    ru: 'имя хаба {name} совпадает с методом цепочки',
  },
  'sql-write.alias_taken': {
    code: 'invalid_class',
    ru: 'алиас {alias} класса {cls} совпадает с именем или алиасом другого класса',
  },
  'sql-write.name_is_alias': {
    code: 'invalid_class',
    ru: 'имя класса {cls} совпадает с алиасом другого класса',
  },
  // class_admit(), trg_entity_ad(): производный класс заводит, меняет и удаляет только администратор
  'sql-write.derived_admin': {
    code: 'acl_denied',
    ru: 'класс {cls} производный: его описание задаёт только администратор (право letopis.projector)',
  },
  'sql-write.derived_ancestor_admin': {
    code: 'acl_denied',
    ru: 'класс {cls} — предок производного класса {derived}: его описание задаёт только администратор (право letopis.projector)',
  },
  // агрегат {cls}.{field} класса-источника {of}: источника нет — в System (класс System) или у арендатора
  'sql-write.aggregate_source_missing_system': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: класса-источника {of} и его потомков в System нет — источник описывают раньше агрегата',
  },
  'sql-write.aggregate_source_missing': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: класса-источника {of} и его потомков у арендатора нет — источник описывают раньше агрегата',
  },
  'sql-write.aggregate_source_read': {
    code: 'acl_denied',
    ru: 'агрегат {cls}.{field}: нужно право READ на все строки класса {source}',
  },
  'sql-write.alias_orphan_history': {
    code: 'invalid_class',
    ru: 'удалённые потомки класса {cls} хранят историю строк: алиас меняется после purge() их строк',
  },
  'sql-write.end_other_class': {
    code: 'invalid_class',
    ru: 'конец {end} в классе {cls} ведёт на другой класс',
  },
  'sql-write.end_to_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на производный класс {cls}',
  },
  'sql-write.derived_referenced': {
    code: 'derived_class',
    ru: 'класс {cls} не может стать производным: на него ссылается конец {end} класса {ref}',
  },
  // триггеры вставки и правки, reclass()
  'sql-write.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
  },
  'sql-write.foreign_tenant': {
    code: 'tenant_denied',
    ru: 'запись в чужого арендатора',
  },
  'sql-write.account_tenant': {
    code: 'tenant_denied',
    ru: 'аккаунты лежат в арендаторе System',
  },
  'sql-write.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден',
  },
  // класс удалили, пока писатель ждал блокировку семейства
  'sql-write.class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён',
  },
  'sql-write.class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
  },
  'sql-write.derived_write_projector': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
  },
  'sql-write.derived_write': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор',
  },
  'sql-write.derived_reclass': {
    code: 'derived_class',
    ru: 'строки производного класса пишет только его проектор',
  },
  'sql-write.aggregate_given': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — их не передают',
  },
  'sql-write.aggregate_given_reclass': {
    code: 'aggregate_field',
    ru: 'агрегатные поля класса {cls} считает база — в данных reclass их не передают',
  },
  'sql-write.member_tenant': {
    code: 'invalid_data',
    ru: 'конец Tenant членства — арендатор строки',
  },
  'sql-write.id_from_db': {
    code: 'id_from_db',
    ru: 'id класса без ключа {cls} выдаёт база',
  },
  // detail.expected — id от ключа
  'sql-write.id_mismatch': {
    code: 'id_mismatch',
    ru: 'id не равен v5 от ключа класса {cls}',
  },
  'sql-write.history_recreate': {
    code: 'invalid_class',
    ru: 'журнал хранит историю строк класса {cls} или его удалённых потомков: создать его можно только заново и с прежними parent, alias, derivedBy и history (или сначала стереть её purge())',
  },
  'sql-write.owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец строки не найден',
  },
  'sql-write.immutable_columns': {
    code: 'immutable_key',
    ru: 'id, арендатора, владельца и время создания менять нельзя',
  },
  'sql-write.class_row_kind': {
    code: 'invalid_class',
    ru: 'строку Class нельзя превратить в данные и наоборот',
  },
  'sql-write.system_row_reclass': {
    code: 'reclass_denied',
    ru: 'класс системной строки не меняется',
  },
  'sql-write.reclass_isolation': {
    code: 'isolation_level',
    ru: 'смена класса разрешена только в read committed',
  },
  'sql-write.use_reclass': {
    code: 'use_reclass',
    ru: 'у класса {from} или {to} есть ключ: id меняется, используйте reclass()',
  },
  'sql-write.reclass_delete_denied': {
    code: 'acl_denied',
    ru: 'нет права DELETE на строку класса {cls}: смена класса убирает её из класса',
  },
  // detail — видимые актору ссылающиеся строки и число остальных (visible_detail)
  'sql-write.reclass_refs': {
    code: 'reclass_denied',
    ru: 'роли ссылающихся строк не принимают класс {cls}',
  },
  'sql-write.key_changed': {
    code: 'immutable_key',
    ru: 'ключевое поле класса {cls} менять нельзя: id изменился бы (rekey)',
  },
  // class_evolve(): detail — видимые нарушающие строки и число остальных (visible_detail)
  'sql-write.tightening_mismatch': {
    code: 'tightening_conflict',
    ru: 'новому описанию класса {cls} не соответствуют строки',
  },
  // триггеры удаления
  'sql-write.delete_isolation': {
    code: 'isolation_level',
    ru: 'удаление разрешено только в read committed',
  },
  'sql-write.system_account_delete': {
    code: 'acl_denied',
    ru: 'аккаунт System не удаляется: ему принадлежат служебные строки установки',
  },
  'sql-write.recreated_in_statement': {
    code: 'recreated_in_statement',
    ru: 'id удалён и создан заново одним оператором',
  },
  'sql-write.derived_delete': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки удаляет проектор',
  },
  'sql-write.aggregate_source_delete': {
    code: 'invalid_class',
    ru: 'класс {cls} — источник агрегата {aggregate}: сначала уберите агрегат из описания цели',
  },
  'sql-write.class_not_empty': {
    code: 'invalid_class',
    ru: 'у класса {cls} есть строки или потомки',
  },
  'sql-write.class_has_history': {
    code: 'invalid_class',
    ru: 'у класса {cls} есть история строк в журнале: сначала стереть её purge() удалённых строк',
  },
  // каскад и снятие конца: класс отказавшей строки — только если актор её видит (visible_class)
  'sql-write.cascade_delete_denied': {
    code: 'acl_denied',
    ru: 'нет права DELETE на класс {cls} в каскаде удаления',
  },
  'sql-write.cascade_delete_denied_hidden': {
    code: 'acl_denied',
    ru: 'нет права DELETE на строки в каскаде удаления',
  },
  'sql-write.unset_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}: снятие конца при удалении',
  },
  'sql-write.unset_write_denied_hidden': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающуюся строку: снятие конца при удалении',
  },
  // detail — видимые актору мешающие строки и число остальных (visible_detail)
  'sql-write.delete_restricted': {
    code: 'delete_restricted',
    ru: 'на удаляемые строки ссылаются другие строки (onDelete: restrict)',
  },
  // move_row(), reclass(): перевод ссылок; класс ссылающейся строки — только если актор её видит
  'sql-write.derived_ref': {
    code: 'derived_class',
    ru: 'на строку ссылается строка производного класса {cls}: её пишет проектор',
  },
  'sql-write.derived_ref_hidden': {
    code: 'derived_class',
    ru: 'на строку ссылается строка производного класса: её пишет проектор',
  },
  'sql-write.refs_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки',
  },
  'sql-write.refs_class_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки класса {cls}',
  },
  // reclass()
  'sql-write.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена',
  },
  'sql-write.row_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на строку класса {cls}',
  },
  'sql-write.class_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
  },
  // links_patch() и inc() исполняет приложение: raise с lt_text(), в detail — key и params
  'sql-write.links_patch_op': {
    code: 'invalid_data',
    ru: 'links_patch: неизвестная операция {op}',
  },
  // inc(): нарушение — и в detail.issues[0].message
  'sql-write.inc_args': {
    code: 'invalid_data',
    ru: 'inc: нужны путь и величина',
  },
  'sql-write.inc_path_missing': {
    code: 'invalid_data',
    ru: 'inc: путь {path} идёт через отсутствующий объект',
  },
  'sql-write.inc_path_not_object': {
    code: 'invalid_data',
    ru: 'inc: путь {path} идёт не через объект',
  },
  'sql-write.inc_no_field': {
    code: 'invalid_data',
    ru: 'inc: поля {path} нет — задайте start',
  },
  'sql-write.inc_not_number': {
    code: 'invalid_data',
    ru: 'inc: в поле {path} не число',
  },
} satisfies Section<'sql-write'>;
