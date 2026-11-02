/**
 * Раздел model: model.ts, registry.ts, sync.ts, cli.ts, validate.ts, jsonschema.ts, uuid.ts — модели, реестр, CLI,
 * валидатор и JSON Schema на TypeScript.
 */
import type { Section } from './types.js';

export const model = {
  // model.ts, End: конец без классов цели — one() или many() без целей
  'model.end_no_targets': {
    code: 'invalid_class',
    ru: 'у конца должен быть хотя бы один класс цели',
  },
  // model.ts, makeModel: имя класса — не буквы, цифры и _ (до 63 знаков, не с цифры)
  'model.class_name_invalid': {
    code: 'invalid_class',
    ru: 'имя класса {name} недопустимо',
  },
  // model.ts, makeModel: имя хаба — из RESERVED_CLASS_NAMES (план 2.0, этап 4, п. 2; 7.10 №3)
  'model.hub_name_reserved': {
    code: 'invalid_class',
    ru: 'hub(): имя {name} занято методом цепочки или корня db — шаг с таким именем до класса не дойдёт',
    hint: 'дать классу другое имя: зарезервированные имена — в README, «Справочник API → Зарезервированные имена»',
  },
  // model.ts, makeModel: поле модели начинается с $
  'model.field_name_dollar': {
    code: 'invalid_class',
    ru: '{cls}: имя поля {field} начинается с $ — так загрузчик помечает служебные ключи',
  },
  // model.ts, makeModel: роль конца — не буквы, цифры и _
  'model.end_name_invalid': {
    code: 'invalid_class',
    ru: '{cls}: имя конца {role} недопустимо',
  },
  // model.ts, makeModel: поле ключа — не строка или необязательное
  'model.key_field_type': {
    code: 'invalid_class',
    ru: '{cls}: поле ключа {field} должно быть обязательной строкой',
  },
  // model.ts, makeModel: конец ключа множественный или необязательный
  'model.key_end_type': {
    code: 'invalid_class',
    ru: '{cls}: конец ключа {end} должен быть обязательным и одиночным',
  },
  // model.ts, makeModel: в key — имя, которого нет ни среди полей, ни среди концов (с предками)
  'model.key_unknown_name': {
    code: 'invalid_class',
    ru: '{cls}: ключ ссылается на неизвестное поле или конец {name}',
  },
  // model.ts, makeModel: onDelete unset у обязательного конца (или у конца с min больше нуля)
  'model.unset_required_end': {
    code: 'invalid_class',
    ru: '{cls}: onDelete unset недопустим для обязательного конца {end}',
  },
  // model.ts, makeModel: aggregate называет поле, которого нет среди полей модели
  'model.aggregate_field_missing': {
    code: 'invalid_class',
    ru: '{cls}: агрегатного поля {field} нет среди полей класса',
  },
  // model.ts, makeModel: у агрегата и sum, и count — или ни того ни другого
  'model.aggregate_kind': {
    code: 'invalid_class',
    ru: '{cls}: агрегат {field} — ровно одно из sum и count: true',
  },

  // jsonschema.ts, normalizeSchema: имя в начале текста ошибок, когда where не задан (часть текста, не ошибка)
  'model.schema_default_where': {
    code: 'invalid_class',
    ru: 'модель',
  },
  // jsonschema.ts, normalizeSchema: $ref не на определение из $defs (definitions)
  'model.schema_ref_unsupported': {
    code: 'invalid_class',
    ru: '{where}: ссылка {ref} не поддерживается (только #/$defs/…)',
  },
  // jsonschema.ts, normalizeSchema: $ref по кругу; cycle — имена определений через стрелку
  'model.schema_recursive': {
    code: 'invalid_class',
    ru: '{where}: рекурсивная модель через {cycle}',
  },
  // jsonschema.ts, normalizeSchema: $ref на определение, которого нет
  'model.schema_def_not_found': {
    code: 'invalid_class',
    ru: '{where}: определение {name} не найдено',
  },
  // jsonschema.ts, normalizeSchema: узел описания — не объект и не true; node — путь вида $.a.b
  'model.schema_node_not_object': {
    code: 'invalid_class',
    ru: '{where}: описание узла {node} — не объект',
  },
  // jsonschema.ts, normalizeSchema: ключевое слово JSON Schema вне подмножества базы
  'model.schema_keyword_unsupported': {
    code: 'invalid_class',
    ru: '{where}: ключевое слово {keyword} не поддерживается (узел {node})',
  },
  // jsonschema.ts, normalizeSchema: format не из uuid, date, date-time, email
  'model.schema_format_unsupported': {
    code: 'invalid_class',
    ru: '{where}: format {format} не поддерживается (узел {node})',
  },
  // jsonschema.ts, normalizeSchema с topLevel: поле верхнего уровня начинается с $
  'model.schema_field_dollar': {
    code: 'invalid_class',
    ru: '{where}: имя поля {field} начинается с $ — так загрузчик помечает служебные ключи',
  },
  // jsonschema.ts, translatePattern: обратная косая черта последним знаком шаблона
  'model.pattern_trailing_backslash': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратная косая черта в конце шаблона)',
  },
  // jsonschema.ts, translatePattern: \D, \W, \S внутри [ ]; escape — сама последовательность
  'model.pattern_escape_in_set': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} внутри набора [ ] не переводится)',
  },
  // jsonschema.ts, translatePattern: \b, \B; escape — сама последовательность
  'model.pattern_word_boundary': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} в PostgreSQL значит другое)',
  },
  // jsonschema.ts, translatePattern: \p и \P
  'model.pattern_unicode_property': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (\\p{…} не поддерживается)',
  },
  // jsonschema.ts, translatePattern: \k и \1–\9
  'model.pattern_backreference': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратные ссылки не поддерживаются)',
  },
  // jsonschema.ts, translatePattern: именованная группа (?<имя>…)
  'model.pattern_named_group': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (именованные группы не поддерживаются)',
  },

  // validate.ts, compileValidator: узел описания — не объект и не true; node — путь узла массивом JSON
  'model.validator_node_not_object': {
    code: 'invalid_class',
    ru: 'описание узла {node} — не объект (узел {node})',
  },
  // validate.ts, compileValidator: ключевое слово вне подмножества (не x-…)
  'model.validator_keyword_unsupported': {
    code: 'invalid_class',
    ru: 'ключевое слово {keyword} не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: type не из integer, number, string, boolean, object, array, null
  'model.validator_unknown_type': {
    code: 'invalid_class',
    ru: 'неизвестный тип в узле {node} (узел {node})',
  },
  // validate.ts, compileValidator: enum или const с объектами внутри ветки anyOf или oneOf
  'model.validator_enum_objects_in_any_of': {
    code: 'invalid_class',
    ru: 'перечисление объектов внутри anyOf не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: pattern неверен уже для JavaScript; pattern — шаблон в JSON
  'model.validator_bad_pattern': {
    code: 'invalid_class',
    ru: 'pattern {pattern} — неверное регулярное выражение (узел {node})',
  },
  // validate.ts, compileValidator: format не из uuid, date, date-time, email
  'model.validator_format_unsupported': {
    code: 'invalid_class',
    ru: 'format {format} не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: format date или date-time внутри ветки anyOf или oneOf
  'model.validator_format_in_any_of': {
    code: 'invalid_class',
    ru: 'format {format} внутри anyOf не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: minLength или maxLength внутри ветки anyOf или oneOf
  'model.validator_string_length_in_any_of': {
    code: 'invalid_class',
    ru: 'длина строки внутри anyOf не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: uniqueItems внутри ветки anyOf или oneOf
  'model.validator_unique_items_in_any_of': {
    code: 'invalid_class',
    ru: 'uniqueItems внутри anyOf не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: minProperties или maxProperties внутри ветки anyOf или oneOf
  'model.validator_min_properties_in_any_of': {
    code: 'invalid_class',
    ru: 'minProperties внутри anyOf не поддерживается (узел {node})',
  },
  // validate.ts, compileValidator: сообщения нарушений issues[].message — тексты не для ошибки (lmsg), те же, что у базы
  'model.issue_enum': {
    code: 'invalid_data',
    ru: 'значение не из перечисления',
  },
  'model.issue_date': {
    code: 'invalid_data',
    ru: 'такой даты не бывает',
  },
  'model.issue_string_length': {
    code: 'invalid_data',
    ru: 'длина строки вне границ',
  },
  'model.issue_unique_items': {
    code: 'invalid_data',
    ru: 'элементы повторяются',
  },
  'model.issue_property_count': {
    code: 'invalid_data',
    ru: 'число ключей вне границ',
  },
  'model.issue_rule': {
    code: 'invalid_data',
    ru: 'нарушено правило {keyword}',
  },

  // registry.ts, Registry.resolve: класса нет в реестре сессии ни по имени, ни по алиасу
  'model.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {name} не найден',
  },

  // sync.ts, syncModels: модель хаба с именем из RESERVED_CLASS_NAMES, собранная мимо hub() (план 2.0, этап 4, п. 2;
  // 7.10 №3) — отказ до записи
  'model.sync_hub_name_reserved': {
    code: 'invalid_class',
    ru: 'syncModels: имя хаба {name} занято методом цепочки или корня db — шаг с таким именем до класса не дойдёт',
    hint: 'дать классу другое имя: зарезервированные имена — в README, «Справочник API → Зарезервированные имена»',
  },
  // sync.ts, syncModels: родители и источники агрегатов замыкают круг; cycle — имена моделей через стрелку
  'model.models_cycle': {
    code: 'invalid_class',
    ru: 'syncModels: модели зависят друг от друга по кругу: {cycle} — родителя и источник агрегата база ждёт раньше класса',
  },
  // sync.ts, generateTypes: имя класса (например, созданного данными) — не идентификатор TypeScript
  'model.types_class_name': {
    code: 'invalid_class',
    ru: 'types: имя класса {name} не годится для идентификатора TypeScript',
  },

  // uuid.ts, uuidv5: пространство имён (арендатор) — не uuid
  'model.v5_namespace_not_uuid': {
    code: 'invalid_data',
    ru: 'пространство имён v5 — не uuid: {ns}',
    hint: 'пространство имён v5 — id арендатора (uuid): idOf(класс, ключ, { tenant })',
  },
  // uuid.ts, idOf: у класса нет ключа
  'model.class_no_key': {
    code: 'no_key',
    ru: 'у класса {cls} нет ключа: id выдаёт база при создании',
  },
  // uuid.ts, idOf: часть ключа не задана или не строка; detail.key — части ключа класса
  'model.key_part_not_string': {
    code: 'invalid_data',
    ru: 'idOf({cls}): часть ключа {part} должна быть строкой',
    hint: 'передать каждую часть ключа строкой (части — в detail.key): у поля — его значение, у конца — id цели',
  },
  // uuid.ts, idOf: значение конца в ключе — не uuid
  'model.key_end_not_uuid': {
    code: 'invalid_data',
    ru: 'idOf({cls}): конец {end} — не uuid',
    hint: 'значение конца в ключе — id цели (uuid)',
  },

  // cli.ts, mcp: letopis mcp с ключом сервиса (--api-key)
  'model.mcp_api_key_refused': {
    code: 'user_session_required',
    ru: 'letopis mcp принимает только токен сессии пользователя (--token или LETOPIS_TOKEN): ключ сервиса даёт все права auth.* и не должен лежать на машине агента',
    hint: 'убрать --api-key и передать токен сессии пользователя: --token или LETOPIS_TOKEN',
  },
  // cli.ts, mcp: letopis mcp без токена — ни --token, ни LETOPIS_TOKEN
  'model.mcp_token_required': {
    code: 'user_session_required',
    ru: 'letopis mcp — нужен токен сессии пользователя: --token или LETOPIS_TOKEN',
    hint: 'передать токен сессии пользователя: --token или LETOPIS_TOKEN',
  },
  // cli.ts, main: отчёт letopis sync (lmsg) — тексты не для ошибки, код не печатается. Итог: сухой прогон и с --apply;
  // числа классов по группам
  'model.cli_sync_dry_run': {
    code: 'invalid_query',
    ru: 'сухой прогон: создать {created}, изменить {updated}, без изменений {unchanged}, системных {skipped}',
  },
  'model.cli_sync_applied': {
    code: 'invalid_query',
    ru: 'применено: создать {created}, изменить {updated}, без изменений {unchanged}, системных {skipped}',
  },
  // строки групп; names — классы через запятую
  'model.cli_sync_list_create': {
    code: 'invalid_query',
    ru: 'создать: {names}',
  },
  'model.cli_sync_list_update': {
    code: 'invalid_query',
    ru: 'изменить: {names}',
  },
  'model.cli_sync_list_system': {
    code: 'invalid_query',
    ru: 'системные (меняет установка): {names}',
  },
  // правило Zod (refine, transform), которого нет в базе; kind — вид правила, path — где оно
  'model.cli_sync_lost': {
    code: 'invalid_query',
    ru: 'правило {kind} в {path} проверяется только в библиотеке — в базе его нет',
  },
  // sync.ts, generateTypes: пометка в первой строке файла типов (после «// ») — текст не для ошибки
  'model.types_header': {
    code: 'invalid_query',
    ru: 'Сгенерировано letopis types — не править руками.',
  },
} satisfies Section<'model'>;
