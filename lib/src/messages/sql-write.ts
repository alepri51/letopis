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
  // links_shape(): разбор концов строки (триггеры вставки и правки; check_links — reclass, restore, rekey, проектор)
  'sql-write.links_not_object': {
    code: 'invalid_data',
    ru: 'links — не объект',
    en: 'links is not an object',
  },
  'sql-write.end_undeclared': {
    code: 'undeclared_end',
    ru: 'конец {end} не объявлен в классе {cls}',
    en: 'end {end} is not declared in class {cls}',
  },
  'sql-write.end_not_list': {
    code: 'invalid_data',
    ru: 'конец {end} — список id',
    en: 'end {end} is a list of ids',
  },
  'sql-write.end_not_uuid': {
    code: 'invalid_data',
    ru: 'конец {end}: значение не uuid',
    en: 'end {end}: the value is not a uuid',
  },
  'sql-write.end_target_repeated': {
    code: 'invalid_data',
    ru: 'конец {end}: цель повторяется',
    en: 'end {end}: the target is repeated',
  },
  'sql-write.end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком мало целей',
    en: 'end {end} has too few targets',
  },
  'sql-write.end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {end} слишком много целей',
    en: 'end {end} has too many targets',
  },
  'sql-write.end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {end} не задан',
    en: 'required end {end} is not set',
  },
  // check_links(), триггеры после вставки и правки (targets_bad): цель конца — строка производного класса или не найдена
  'sql-write.end_target_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на строку производного класса',
    en: 'end {end} points to a row of a derived class',
  },
  'sql-write.end_target_missing': {
    code: 'target_not_found',
    ru: 'цель конца {end} не найдена',
    en: 'the target of end {end} is not found',
  },
  // family_conflicts(): чем строка семейства не проходит новое описание — поле problem в detail.rows отказа
  // tightening_conflict (ужесточение класса, rekeyClass)
  'sql-write.problem_abstract': {
    code: 'tightening_conflict',
    ru: 'класс абстрактный',
    en: 'the class is abstract',
  },
  'sql-write.problem_data': {
    code: 'tightening_conflict',
    ru: 'данные: {issues}',
    en: 'data: {issues}',
  },
  'sql-write.problem_key': {
    code: 'tightening_conflict',
    ru: 'id не соответствует ключу класса',
    en: 'the id does not match the class key',
  },
  // ссылающаяся строка видна актору — её роль и id; не видна — ни роли, ни id
  'sql-write.problem_ref': {
    code: 'tightening_conflict',
    ru: 'на строку ссылается роль {role} строки {id}, которая не принимает класс',
    en: 'role {role} of row {id} refers to the row and does not accept the class',
  },
  'sql-write.problem_ref_hidden': {
    code: 'tightening_conflict',
    ru: 'на строку ссылается строка, которой актор не видит, и она не принимает класс',
    en: 'a row the actor cannot see refers to the row and does not accept the class',
  },
  // class_rows_admit(): нет права без условий на все строки класса {target} (сам класс {cls} или его потомок); что
  // меняется — p_what: reparent, history, tighten, rekey; иной p_what — прежний готовый текст {what}
  'sql-write.reparent_needs_all': {
    code: 'acl_denied',
    ru: 'класс {cls} меняет предков, алиас или derivedBy: нужно право {op} на все строки класса {target}',
    en: 'class {cls} changes ancestors, alias or derivedBy: the {op} right on all rows of class {target} is required',
  },
  'sql-write.history_needs_all': {
    code: 'acl_denied',
    ru: 'класс {cls} меняет политику хранения истории: нужно право {op} на все строки класса {target}',
    en: 'class {cls} changes the history retention policy: the {op} right on all rows of class {target} is required',
  },
  'sql-write.tighten_needs_all': {
    code: 'acl_denied',
    ru: 'ужесточение класса {cls}: нужно право {op} на все строки класса {target}',
    en: 'tightening of class {cls}: the {op} right on all rows of class {target} is required',
  },
  'sql-write.rekey_needs_all': {
    code: 'acl_denied',
    ru: 'смена ключа класса {cls}: нужно право {op} на все строки класса {target}',
    en: 'key change of class {cls}: the {op} right on all rows of class {target} is required',
  },
  'sql-write.change_needs_all': {
    code: 'acl_denied',
    ru: '{what}: нужно право {op} на все строки класса {target}',
    en: '{what}: the {op} right on all rows of class {target} is required',
  },
  // class_admit(): проверки строки Class сверх метасхемы
  'sql-write.system_name_reserved': {
    code: 'invalid_class',
    ru: 'имя {name} зарезервировано за системным классом',
    en: 'name {name} is reserved for a system class',
  },
  'sql-write.system_flag': {
    code: 'invalid_class',
    ru: 'признак system задаёт только установка',
    en: 'the system flag is set only by the installation',
  },
  'sql-write.system_name_taken': {
    code: 'invalid_class',
    ru: 'имя {name} занято системным классом',
    en: 'name {name} is taken by a system class',
  },
  'sql-write.link_name_reserved': {
    code: 'invalid_class',
    ru: 'имя связи {name} совпадает с методом цепочки',
    en: 'link name {name} coincides with a chain method',
  },
  'sql-write.alias_taken': {
    code: 'invalid_class',
    ru: 'алиас {alias} класса {cls} совпадает с именем или алиасом другого класса',
    en: 'alias {alias} of class {cls} coincides with the name or alias of another class',
  },
  'sql-write.name_is_alias': {
    code: 'invalid_class',
    ru: 'имя класса {cls} совпадает с алиасом другого класса',
    en: 'class name {cls} coincides with the alias of another class',
  },
  // class_admit(), trg_entity_ad(): производный класс заводит, меняет и удаляет только администратор
  'sql-write.derived_admin': {
    code: 'acl_denied',
    ru: 'класс {cls} производный: его описание задаёт только администратор (право letopis.projector)',
    en: 'class {cls} is derived: only an administrator sets its description (the letopis.projector right)',
  },
  'sql-write.derived_ancestor_admin': {
    code: 'acl_denied',
    ru: 'класс {cls} — предок производного класса {derived}: его описание задаёт только администратор (право letopis.projector)',
    en: 'class {cls} is an ancestor of derived class {derived}: only an administrator sets its description (the letopis.projector right)',
  },
  // агрегат {cls}.{field} класса-источника {of}: источника нет — в System (класс System) или у арендатора
  'sql-write.aggregate_source_missing_system': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: класса-источника {of} и его потомков в System нет — источник описывают раньше агрегата',
    en: 'aggregate {cls}.{field}: source class {of} and its descendants do not exist in System — describe the source before the aggregate',
  },
  'sql-write.aggregate_source_missing': {
    code: 'invalid_class',
    ru: 'агрегат {cls}.{field}: класса-источника {of} и его потомков у арендатора нет — источник описывают раньше агрегата',
    en: 'aggregate {cls}.{field}: source class {of} and its descendants do not exist in the tenant — describe the source before the aggregate',
  },
  'sql-write.aggregate_source_read': {
    code: 'acl_denied',
    ru: 'агрегат {cls}.{field}: нужно право READ на все строки класса {source}',
    en: 'aggregate {cls}.{field}: the READ right on all rows of class {source} is required',
  },
  'sql-write.alias_orphan_history': {
    code: 'invalid_class',
    ru: 'удалённые потомки класса {cls} хранят историю строк: алиас меняется после purge() их строк',
    en: 'deleted descendants of class {cls} keep row history: the alias can change after purge() of their rows',
  },
  'sql-write.end_other_class': {
    code: 'invalid_class',
    ru: 'конец {end} в классе {cls} ведёт на другой класс',
    en: 'end {end} in class {cls} points to another class',
  },
  'sql-write.end_to_derived': {
    code: 'derived_class',
    ru: 'конец {end} ведёт на производный класс {cls}',
    en: 'end {end} points to derived class {cls}',
  },
  'sql-write.derived_referenced': {
    code: 'derived_class',
    ru: 'класс {cls} не может стать производным: на него ссылается конец {end} класса {ref}',
    en: 'class {cls} cannot become derived: end {end} of class {ref} refers to it',
  },
  // триггеры вставки и правки, reclass()
  'sql-write.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
    en: 'there is no valid session',
  },
  'sql-write.foreign_tenant': {
    code: 'tenant_denied',
    ru: 'запись в чужого арендатора',
    en: 'writing into another tenant',
  },
  'sql-write.account_tenant': {
    code: 'tenant_denied',
    ru: 'аккаунты лежат в арендаторе System',
    en: 'accounts live in tenant System',
  },
  'sql-write.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден',
    en: 'class {cls} not found',
  },
  // класс удалили, пока писатель ждал блокировку семейства
  'sql-write.class_deleted': {
    code: 'invalid_class',
    ru: 'класс {cls} удалён',
    en: 'class {cls} is deleted',
  },
  'sql-write.class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
    en: 'class {cls} is abstract',
  },
  'sql-write.derived_write_projector': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
    en: 'class {cls} is derived: its rows are written by projector {projector}',
  },
  'sql-write.derived_write': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор',
    en: 'class {cls} is derived: its rows are written by the projector',
  },
  'sql-write.derived_reclass': {
    code: 'derived_class',
    ru: 'строки производного класса пишет только его проектор',
    en: 'rows of a derived class are written only by its projector',
  },
  'sql-write.aggregate_given': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — их не передают',
    en: 'fields {fields} of class {cls} are computed by the database (aggregate) — do not pass them',
  },
  'sql-write.aggregate_given_reclass': {
    code: 'aggregate_field',
    ru: 'агрегатные поля класса {cls} считает база — в данных reclass их не передают',
    en: 'aggregate fields of class {cls} are computed by the database — do not pass them in reclass data',
  },
  'sql-write.member_tenant': {
    code: 'invalid_data',
    ru: 'конец Tenant членства — арендатор строки',
    en: 'the Tenant end of a membership is the tenant of the row',
  },
  'sql-write.id_from_db': {
    code: 'id_from_db',
    ru: 'id класса без ключа {cls} выдаёт база',
    en: 'the database assigns the id of class {cls} without a key',
  },
  // detail.expected — id от ключа
  'sql-write.id_mismatch': {
    code: 'id_mismatch',
    ru: 'id не равен v5 от ключа класса {cls}',
    en: 'the id is not the v5 of the key of class {cls}',
  },
  'sql-write.history_recreate': {
    code: 'invalid_class',
    ru: 'журнал хранит историю строк класса {cls} или его удалённых потомков: создать его можно только заново и с прежними parent, alias, derivedBy и history (или сначала стереть её purge())',
    en: 'the log keeps row history of class {cls} or of its deleted descendants: it can be created only anew and with the same parent, alias, derivedBy and history (or erase the history with purge() first)',
  },
  'sql-write.owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец строки не найден',
    en: 'the row owner is not found',
  },
  'sql-write.immutable_columns': {
    code: 'immutable_key',
    ru: 'id, арендатора, владельца и время создания менять нельзя',
    en: 'the id, tenant, owner and creation time cannot be changed',
  },
  'sql-write.class_row_kind': {
    code: 'invalid_class',
    ru: 'строку Class нельзя превратить в данные и наоборот',
    en: 'a Class row cannot be turned into data and vice versa',
  },
  'sql-write.system_row_reclass': {
    code: 'reclass_denied',
    ru: 'класс системной строки не меняется',
    en: 'the class of a system row does not change',
  },
  'sql-write.reclass_isolation': {
    code: 'isolation_level',
    ru: 'смена класса разрешена только в read committed',
    en: 'changing the class is allowed only in read committed',
  },
  'sql-write.use_reclass': {
    code: 'use_reclass',
    ru: 'у класса {from} или {to} есть ключ: id меняется, используйте reclass()',
    en: 'class {from} or {to} has a key: the id changes, use reclass()',
  },
  'sql-write.reclass_delete_denied': {
    code: 'acl_denied',
    ru: 'нет права DELETE на строку класса {cls}: смена класса убирает её из класса',
    en: 'no DELETE right on the row of class {cls}: changing the class removes it from the class',
  },
  // detail — видимые актору ссылающиеся строки и число остальных (visible_detail)
  'sql-write.reclass_refs': {
    code: 'reclass_denied',
    ru: 'роли ссылающихся строк не принимают класс {cls}',
    en: 'roles of the referencing rows do not accept class {cls}',
  },
  'sql-write.key_changed': {
    code: 'immutable_key',
    ru: 'ключевое поле класса {cls} менять нельзя: id изменился бы (rekey)',
    en: 'a key field of class {cls} cannot be changed: the id would change (rekey)',
  },
  // class_evolve(): detail — видимые нарушающие строки и число остальных (visible_detail)
  'sql-write.tightening_mismatch': {
    code: 'tightening_conflict',
    ru: 'новому описанию класса {cls} не соответствуют строки',
    en: 'rows do not match the new description of class {cls}',
  },
  // триггеры удаления
  'sql-write.delete_isolation': {
    code: 'isolation_level',
    ru: 'удаление разрешено только в read committed',
    en: 'deletion is allowed only in read committed',
  },
  'sql-write.system_account_delete': {
    code: 'acl_denied',
    ru: 'аккаунт System не удаляется: ему принадлежат служебные строки установки',
    en: 'account System is not deleted: it owns the service rows of the installation',
  },
  'sql-write.recreated_in_statement': {
    code: 'recreated_in_statement',
    ru: 'id удалён и создан заново одним оператором',
    en: 'the id was deleted and created again in one statement',
  },
  'sql-write.derived_delete': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки удаляет проектор',
    en: 'class {cls} is derived: its rows are deleted by the projector',
  },
  'sql-write.aggregate_source_delete': {
    code: 'invalid_class',
    ru: 'класс {cls} — источник агрегата {aggregate}: сначала уберите агрегат из описания цели',
    en: 'class {cls} is the source of aggregate {aggregate}: first remove the aggregate from the description of the target',
  },
  'sql-write.class_not_empty': {
    code: 'invalid_class',
    ru: 'у класса {cls} есть строки или потомки',
    en: 'class {cls} has rows or descendants',
  },
  'sql-write.class_has_history': {
    code: 'invalid_class',
    ru: 'у класса {cls} есть история строк в журнале: сначала стереть её purge() удалённых строк',
    en: 'class {cls} has row history in the log: first erase it with purge() of the deleted rows',
  },
  // каскад и снятие конца: класс отказавшей строки — только если актор её видит (visible_class)
  'sql-write.cascade_delete_denied': {
    code: 'acl_denied',
    ru: 'нет права DELETE на класс {cls} в каскаде удаления',
    en: 'no DELETE right on class {cls} in the delete cascade',
  },
  'sql-write.cascade_delete_denied_hidden': {
    code: 'acl_denied',
    ru: 'нет права DELETE на строки в каскаде удаления',
    en: 'no DELETE right on rows in the delete cascade',
  },
  'sql-write.unset_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}: снятие конца при удалении',
    en: 'no WRITE right on class {cls}: unsetting an end on delete',
  },
  'sql-write.unset_write_denied_hidden': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающуюся строку: снятие конца при удалении',
    en: 'no WRITE right on a referencing row: unsetting an end on delete',
  },
  // detail — видимые актору мешающие строки и число остальных (visible_detail)
  'sql-write.delete_restricted': {
    code: 'delete_restricted',
    ru: 'на удаляемые строки ссылаются другие строки (onDelete: restrict)',
    en: 'other rows refer to the rows being deleted (onDelete: restrict)',
  },
  // move_row(), reclass(): перевод ссылок; класс ссылающейся строки — только если актор её видит
  'sql-write.derived_ref': {
    code: 'derived_class',
    ru: 'на строку ссылается строка производного класса {cls}: её пишет проектор',
    en: 'a row of derived class {cls} refers to the row: it is written by the projector',
  },
  'sql-write.derived_ref_hidden': {
    code: 'derived_class',
    ru: 'на строку ссылается строка производного класса: её пишет проектор',
    en: 'a row of a derived class refers to the row: it is written by the projector',
  },
  'sql-write.refs_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки',
    en: 'no WRITE right on the referencing rows',
  },
  'sql-write.refs_class_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на ссылающиеся строки класса {cls}',
    en: 'no WRITE right on the referencing rows of class {cls}',
  },
  // reclass()
  'sql-write.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена',
    en: 'the target is not found',
  },
  'sql-write.row_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на строку класса {cls}',
    en: 'no WRITE right on the row of class {cls}',
  },
  'sql-write.class_write_denied': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
    en: 'no WRITE right on class {cls}',
  },
  // links_patch() и inc() исполняет приложение: raise с lt_text(), в detail — key и params
  'sql-write.links_patch_op': {
    code: 'invalid_data',
    ru: 'links_patch: неизвестная операция {op}',
    en: 'links_patch: unknown operation {op}',
  },
  // inc(): нарушение — и в detail.issues[0].message
  'sql-write.inc_args': {
    code: 'invalid_data',
    ru: 'inc: нужны путь и величина',
    en: 'inc: a path and an amount are required',
  },
  'sql-write.inc_path_missing': {
    code: 'invalid_data',
    ru: 'inc: путь {path} идёт через отсутствующий объект',
    en: 'inc: path {path} goes through a missing object',
  },
  'sql-write.inc_path_not_object': {
    code: 'invalid_data',
    ru: 'inc: путь {path} идёт не через объект',
    en: 'inc: path {path} does not go through an object',
  },
  'sql-write.inc_no_field': {
    code: 'invalid_data',
    ru: 'inc: поля {path} нет — задайте start',
    en: 'inc: there is no field {path} — set start',
  },
  'sql-write.inc_not_number': {
    code: 'invalid_data',
    ru: 'inc: в поле {path} не число',
    en: 'inc: field {path} is not a number',
  },
} satisfies Section<'sql-write'>;
