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
  },
  // 20-context.sql, ctx(): настройка letopis.account — не uuid включённого аккаунта
  'sql-core.account_not_id': {
    code: 'acl_denied',
    ru: 'letopis.account — не id аккаунта',
  },
  // 20-context.sql, ctx(): имперсонация без права auth.impersonate
  'sql-core.no_impersonate_right': {
    code: 'acl_denied',
    ru: 'нет права auth.impersonate',
  },
  // 20-context.sql, ctx(): имперсонация System, сервиса или системного администратора не системным администратором
  'sql-core.impersonation_denied': {
    code: 'acl_denied',
    ru: 'действовать от имени этого аккаунта нельзя',
  },
  // 20-context.sql, ctx(): настройка letopis.tenant — не uuid
  'sql-core.tenant_not_id': {
    code: 'tenant_denied',
    ru: 'letopis.tenant — не id арендатора',
  },
  // 20-context.sql, login_apikey(): ключа нет, он отозван, истёк или аккаунт выключен
  'sql-core.bad_api_key': {
    code: 'no_session',
    ru: 'неверный ключ',
  },

  // 30-validate.sql, jp_pattern(): pattern JSON Schema не переводится в регулярное выражение PostgreSQL
  'sql-core.pattern_trailing_backslash': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратная косая черта в конце шаблона)',
  },
  // 30-validate.sql, jp_pattern(): \D, \W, \S внутри [ ]; escape — сама последовательность
  'sql-core.pattern_escape_in_set': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} внутри набора [ ] не переводится)',
  },
  // 30-validate.sql, jp_pattern(): \b, \B; escape — сама последовательность
  'sql-core.pattern_word_boundary': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} в PostgreSQL значит другое)',
  },
  // 30-validate.sql, jp_pattern(): \p, \P
  'sql-core.pattern_unicode_property': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (\\p{…} не поддерживается)',
  },
  // 30-validate.sql, jp_pattern(): \k и \1–\9
  'sql-core.pattern_backreference': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратные ссылки не поддерживаются)',
  },
  // 30-validate.sql, jp_pattern(): (?<имя>…)
  'sql-core.pattern_named_group': {
    code: 'invalid_class',
    ru: 'шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (именованные группы не поддерживаются)',
  },
  // 30-validate.sql, jp_compile(): node — путь узла описания массивом JSON
  'sql-core.schema_node_not_object': {
    code: 'invalid_class',
    ru: 'описание узла {node} — не объект',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.keyword_unsupported': {
    code: 'invalid_class',
    ru: 'ключевое слово {keyword} не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.unknown_type': {
    code: 'invalid_class',
    ru: 'неизвестный тип в узле {node}',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.enum_objects_in_any_of': {
    code: 'invalid_class',
    ru: 'перечисление объектов внутри anyOf не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.format_unsupported': {
    code: 'invalid_class',
    ru: 'format {format} не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.format_in_any_of': {
    code: 'invalid_class',
    ru: 'format {format} внутри anyOf не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.string_length_in_any_of': {
    code: 'invalid_class',
    ru: 'длина строки внутри anyOf не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.unique_items_in_any_of': {
    code: 'invalid_class',
    ru: 'uniqueItems внутри anyOf не поддерживается (узел {node})',
  },
  // 30-validate.sql, jp_compile()
  'sql-core.min_properties_in_any_of': {
    code: 'invalid_class',
    ru: 'minProperties внутри anyOf не поддерживается (узел {node})',
  },
  // 30-validate.sql, validate_data(): сообщения нарушений issues[].message — тексты не для ошибки (lt_text)
  'sql-core.issue_string_length': {
    code: 'invalid_data',
    ru: 'длина строки вне границ',
  },
  'sql-core.issue_unique_items': {
    code: 'invalid_data',
    ru: 'элементы повторяются',
  },
  'sql-core.issue_date': {
    code: 'invalid_data',
    ru: 'такой даты не бывает',
  },
  'sql-core.issue_property_count': {
    code: 'invalid_data',
    ru: 'число ключей вне границ',
  },
  'sql-core.issue_enum': {
    code: 'invalid_data',
    ru: 'значение не из перечисления',
  },
  'sql-core.issue_rule': {
    code: 'invalid_data',
    ru: 'нарушено правило {keyword}',
  },
  'sql-core.issue_schema': {
    code: 'invalid_data',
    ru: 'данные не проходят описание',
  },

  // 40-class.sql, class_resolve(): предка из parent нет ни у арендатора, ни в System
  'sql-core.parent_not_found': {
    code: 'invalid_class',
    ru: 'предок {parent} не найден',
  },
  // 40-class.sql, class_resolve(): cls — класс, на котором замкнулась цепочка предков
  'sql-core.inheritance_cycle': {
    code: 'invalid_class',
    ru: 'цикл в наследовании через {cls}',
  },
  // 40-class.sql, class_prepare(): detail.issues — нарушения метасхемы
  'sql-core.class_metaschema': {
    code: 'invalid_data',
    ru: 'описание класса не проходит метасхему',
  },
  // 40-class.sql, class_prepare()
  'sql-core.meta_too_large': {
    code: 'invalid_class',
    ru: 'meta класса больше 64 КБ',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_field_type': {
    code: 'invalid_class',
    ru: 'поле ключа {field} должно быть обязательной строкой',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_end_type': {
    code: 'invalid_class',
    ru: 'конец ключа {end} должен быть обязательным и одиночным',
  },
  // 40-class.sql, class_prepare()
  'sql-core.key_unknown_name': {
    code: 'invalid_class',
    ru: 'ключ ссылается на неизвестное поле или конец {name}',
  },
  // 40-class.sql, class_prepare()
  'sql-core.unset_required_end': {
    code: 'invalid_class',
    ru: 'onDelete unset недопустим для обязательного конца {end}',
  },
  // 40-class.sql, class_prepare()
  'sql-core.system_history_off': {
    code: 'invalid_class',
    ru: 'history: false для системных классов запрещён',
  },
} satisfies Section<'sql-core'>;
