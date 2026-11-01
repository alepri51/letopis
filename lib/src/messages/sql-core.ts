/**
 * Раздел sql-core: lib/sql/10-core.sql, 15-errors.sql, 20-context.sql, 30-validate.sql, 40-class.sql — таблицы,
 * контекст и сессии, проверка данных, классы. Русский текст собирает база из этих же записей: установщик кладёт разделы
 * sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlCore = {
  // 20-context.sql, ctx(): рабочий арендатор чужой, а членства в нём нет (или арендатор выключен)
  'sql-core.no_membership': {
    code: 'tenant_denied',
    ru: 'нет членства в арендаторе',
    en: 'no membership in the tenant',
  },
  // 20-context.sql, ctx(): настройка letopis.account — не uuid включённого аккаунта
  'sql-core.account_not_id': {
    code: 'acl_denied',
    ru: 'letopis.account — не id аккаунта',
    en: 'letopis.account is not an account id',
  },
  // 20-context.sql, ctx(): имперсонация без права auth.impersonate
  'sql-core.no_impersonate_right': {
    code: 'acl_denied',
    ru: 'нет права auth.impersonate',
    en: 'no auth.impersonate right',
  },
  // 20-context.sql, ctx(): имперсонация System, сервиса или системного администратора не системным администратором
  'sql-core.impersonation_denied': {
    code: 'acl_denied',
    ru: 'действовать от имени этого аккаунта нельзя',
    en: 'acting on behalf of this account is not allowed',
  },
  // 20-context.sql, ctx(): настройка letopis.tenant — не uuid
  'sql-core.tenant_not_id': {
    code: 'tenant_denied',
    ru: 'letopis.tenant — не id арендатора',
    en: 'letopis.tenant is not a tenant id',
  },
  // 20-context.sql, login_apikey(): ключа нет, он отозван, истёк или аккаунт выключен
  'sql-core.bad_api_key': {
    code: 'no_session',
    ru: 'неверный ключ',
    en: 'invalid key',
  },

  // 30-validate.sql, jp_pattern(): pattern JSON Schema не переводится в регулярное выражение PostgreSQL
  'sql-core.pattern_trailing_backslash': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратная косая черта в конце шаблона)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions (a backslash at the end of the pattern)',
  },
  // 30-validate.sql, jp_pattern(): \D, \W, \S внутри [ ]; escape — сама последовательность
  'sql-core.pattern_escape_in_set': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} внутри набора [ ] не переводится)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions ({escape} inside a [ ] set cannot be translated)',
  },
  // 30-validate.sql, jp_pattern(): \b, \B; escape — сама последовательность
  'sql-core.pattern_word_boundary': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} в PostgreSQL значит другое)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions ({escape} means something else in PostgreSQL)',
  },
  // 30-validate.sql, jp_pattern(): \p, \P
  'sql-core.pattern_unicode_property': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (\\p{…} не поддерживается)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions (\\p{…} is not supported)',
  },
  // 30-validate.sql, jp_pattern(): \k и \1–\9
  'sql-core.pattern_backreference': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратные ссылки не поддерживаются)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions (backreferences are not supported)',
  },
  // 30-validate.sql, jp_pattern(): (?<имя>…)
  'sql-core.pattern_named_group': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (именованные группы не поддерживаются)',
    en: 'pattern {pattern} is incompatible with PostgreSQL regular expressions (named groups are not supported)',
  },
  // 30-validate.sql, jp_compile(): node — путь узла описания массивом JSON
  'sql-core.schema_node_not_object': {
    code: 'invalid_class',
    ru: 'описание узла {node} — не объект',
    en: 'the description of node {node} is not an object',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.keyword_unsupported': {
    code: 'invalid_class',
    ru: 'ключевое слово {keyword} не поддерживается (узел {node})',
    en: 'keyword {keyword} is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.unknown_type': {
    code: 'invalid_class',
    ru: 'неизвестный тип в узле {node}',
    en: 'unknown type in node {node}',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.enum_objects_in_any_of': {
    code: 'invalid_class',
    ru: 'перечисление объектов внутри anyOf не поддерживается (узел {node})',
    en: 'an enum of objects inside anyOf is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.format_unsupported': {
    code: 'invalid_class',
    ru: 'format {format} не поддерживается (узел {node})',
    en: 'format {format} is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.format_in_any_of': {
    code: 'invalid_class',
    ru: 'format {format} внутри anyOf не поддерживается (узел {node})',
    en: 'format {format} inside anyOf is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.string_length_in_any_of': {
    code: 'invalid_class',
    ru: 'длина строки внутри anyOf не поддерживается (узел {node})',
    en: 'string length inside anyOf is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.unique_items_in_any_of': {
    code: 'invalid_class',
    ru: 'uniqueItems внутри anyOf не поддерживается (узел {node})',
    en: 'uniqueItems inside anyOf is not supported (node {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.min_properties_in_any_of': {
    code: 'invalid_class',
    ru: 'minProperties внутри anyOf не поддерживается (узел {node})',
    en: 'minProperties inside anyOf is not supported (node {node})',
  },
  // 30-validate.sql, validate_data(): сообщения нарушений issues[].message — тексты не для ошибки (lt_text)
  'sql-core.issue_string_length': {
    code: 'invalid_data',
    ru: 'длина строки вне границ',
    en: 'string length is out of bounds',
  },
  'sql-core.issue_unique_items': {
    code: 'invalid_data',
    ru: 'элементы повторяются',
    en: 'items repeat',
  },
  'sql-core.issue_date': {
    code: 'invalid_data',
    ru: 'такой даты не бывает',
    en: 'no such date exists',
  },
  'sql-core.issue_property_count': {
    code: 'invalid_data',
    ru: 'число ключей вне границ',
    en: 'the number of keys is out of bounds',
  },
  'sql-core.issue_enum': {
    code: 'invalid_data',
    ru: 'значение не из перечисления',
    en: 'the value is not in the enum',
  },
  'sql-core.issue_rule': {
    code: 'invalid_data',
    ru: 'нарушено правило {keyword}',
    en: 'rule {keyword} is violated',
  },
  'sql-core.issue_schema': {
    code: 'invalid_data',
    ru: 'данные не проходят описание',
    en: 'the data does not match the description',
  },

  // 40-class.sql, class_resolve(): предка из parent нет ни у арендатора, ни в System
  'sql-core.parent_not_found': {
    code: 'invalid_class',
    ru: 'предок {parent} не найден',
    en: 'parent {parent} not found',
  },
  // 40-class.sql, class_resolve(): cls — класс, на котором замкнулась цепочка предков
  'sql-core.inheritance_cycle': {
    code: 'invalid_class',
    ru: 'цикл в наследовании через {cls}',
    en: 'inheritance cycle through {cls}',
  },
  // 40-class.sql, class_resolve(): inherited — derivedBy предка
  'sql-core.derived_by_mismatch': {
    code: 'invalid_class',
    ru: 'derivedBy класса {cls} ({derivedBy}) не совпадает с предком ({inherited})',
    en: 'derivedBy of class {cls} ({derivedBy}) does not match the parent ({inherited})',
  },
  // 40-class.sql, class_prepare(): detail.issues — нарушения метасхемы
  'sql-core.class_metaschema': {
    code: 'invalid_data',
    ru: 'описание класса не проходит метасхему',
    en: 'the class description does not match the metaschema',
  },
  // 40-class.sql, class_prepare()
  'sql-core.meta_too_large': {
    code: 'invalid_class',
    ru: 'meta класса больше 64 КБ',
    en: 'class meta is larger than 64 KB',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_field_type': {
    code: 'invalid_class',
    ru: 'поле ключа {field} должно быть обязательной строкой',
    en: 'key field {field} must be a required string',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_end_type': {
    code: 'invalid_class',
    ru: 'конец ключа {end} должен быть обязательным и одиночным',
    en: 'key end {end} must be required and single',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_unknown_name': {
    code: 'invalid_class',
    ru: 'ключ ссылается на неизвестное поле или конец {name}',
    en: 'the key refers to an unknown field or end {name}',
  },
  // 40-class.sql, class_prepare()
  'sql-core.unset_required_end': {
    code: 'invalid_class',
    ru: 'onDelete unset недопустим для обязательного конца {end}',
    en: 'onDelete unset is not allowed for required end {end}',
  },
  // 40-class.sql, class_prepare(): history-объект у класса System
  'sql-core.system_history_policy': {
    code: 'invalid_class',
    ru: 'системным классам политика хранения не задаётся',
    en: 'system classes take no retention policy',
  },
  // 40-class.sql, class_prepare()
  'sql-core.system_history_off': {
    code: 'invalid_class',
    ru: 'history: false для системных классов запрещён',
    en: 'history: false is forbidden for system classes',
  },
  // 40-class.sql, class_prepare(): tier — ярус политики хранения
  'sql-core.history_forever_not_last': {
    code: 'invalid_class',
    ru: 'history: forever допустим только у последнего яруса, а стоит у {tier}',
    en: 'history: forever is allowed only on the last tier, but it is set on {tier}',
  },
  // 40-class.sql, class_prepare(): value — срок яруса, как его задали
  'sql-core.history_tier_unparsable': {
    code: 'invalid_class',
    ru: 'history: срок яруса {tier} не разбирается: {value}',
    en: 'history: the period of tier {tier} cannot be parsed: {value}',
  },
  // 40-class.sql, class_prepare()
  'sql-core.history_tiers_order': {
    code: 'invalid_class',
    ru: 'history: сроки ярусов должны возрастать ({tier})',
    en: 'history: tier periods must increase ({tier})',
  },
  // 40-class.sql, class_prepare()
  'sql-core.history_all_min_day': {
    code: 'invalid_class',
    ru: 'history: ярус all не меньше суток',
    en: 'history: tier all is at least one day',
  },
  // 40-class.sql, class_prepare()
  'sql-core.history_unknown_tz': {
    code: 'invalid_class',
    ru: 'history: неизвестный часовой пояс {tz}',
    en: 'history: unknown time zone {tz}',
  },
  // 40-class.sql, class_prepare(): derivedBy у класса System
  'sql-core.system_derived': {
    code: 'invalid_class',
    ru: 'системный класс не бывает производным',
    en: 'a system class cannot be derived',
  },
  // 40-class.sql, class_prepare()
  'sql-core.derived_end_on_delete': {
    code: 'invalid_class',
    ru: 'конец {end} производного класса — onDelete cascade или unset: производная строка не мешает удалять цель',
    en: 'end {end} of a derived class must be onDelete cascade or unset: a derived row does not block deleting the target',
  },
} satisfies Section<'sql-core'>;
