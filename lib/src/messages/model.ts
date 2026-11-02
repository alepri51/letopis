/**
 * Раздел model: model.ts, registry.ts, sync.ts, cli.ts, check.ts, validate.ts, jsonschema.ts, uuid.ts — модели, реестр,
 * CLI, проверки до запуска, валидатор и JSON Schema на TypeScript.
 */
import type { Section } from './types.js';

export const model = {
  // model.ts, End: конец без классов цели — one() или many() без целей
  'model.end_no_targets': {
    code: 'invalid_class',
    ru: 'у конца должен быть хотя бы один класс цели',
    en: 'an end must have at least one target class',
  },
  // model.ts, makeModel: имя класса — не буквы, цифры и _ (до 63 знаков, не с цифры)
  'model.class_name_invalid': {
    code: 'invalid_class',
    ru: 'имя класса {name} недопустимо',
    en: 'class name {name} is invalid',
  },
  // model.ts, makeModel: имя хаба — из RESERVED_CLASS_NAMES (план 2.0, этап 4, п. 2; 7.10 №3)
  'model.hub_name_reserved': {
    code: 'invalid_class',
    ru: 'hub(): имя {name} занято методом цепочки или корня db — шаг с таким именем до класса не дойдёт',
    en: 'hub(): the name {name} is taken by a method of the chain or of the db root — a step with this name never reaches the class',
    hint: {
      ru: 'дать классу другое имя: зарезервированные имена — в README, «Справочник API → Зарезервированные имена»',
      en: 'give the class another name: the reserved names are in README, "API reference → Reserved names"',
    },
  },
  // model.ts, makeModel: поле модели начинается с $
  'model.field_name_dollar': {
    code: 'invalid_class',
    ru: '{cls}: имя поля {field} начинается с $ — так загрузчик помечает служебные ключи',
    en: '{cls}: field name {field} starts with $ — the loader marks service keys this way',
  },
  // model.ts, makeModel: роль конца — не буквы, цифры и _
  'model.end_name_invalid': {
    code: 'invalid_class',
    ru: '{cls}: имя конца {role} недопустимо',
    en: '{cls}: end name {role} is invalid',
  },
  // model.ts, makeModel: поле ключа — не строка или необязательное
  'model.key_field_type': {
    code: 'invalid_class',
    ru: '{cls}: поле ключа {field} должно быть обязательной строкой',
    en: '{cls}: key field {field} must be a required string',
  },
  // model.ts, makeModel: конец ключа множественный или необязательный
  'model.key_end_type': {
    code: 'invalid_class',
    ru: '{cls}: конец ключа {end} должен быть обязательным и одиночным',
    en: '{cls}: key end {end} must be required and single',
  },
  // model.ts, makeModel: в key — имя, которого нет ни среди полей, ни среди концов (с предками)
  'model.key_unknown_name': {
    code: 'invalid_class',
    ru: '{cls}: ключ ссылается на неизвестное поле или конец {name}',
    en: '{cls}: the key refers to an unknown field or end {name}',
  },
  // model.ts, makeModel: onDelete unset у обязательного конца (или у конца с min больше нуля)
  'model.unset_required_end': {
    code: 'invalid_class',
    ru: '{cls}: onDelete unset недопустим для обязательного конца {end}',
    en: '{cls}: onDelete unset is not allowed for required end {end}',
  },
  // model.ts, makeModel: aggregate называет поле, которого нет среди полей модели
  'model.aggregate_field_missing': {
    code: 'invalid_class',
    ru: '{cls}: агрегатного поля {field} нет среди полей класса',
    en: '{cls}: aggregate field {field} is not among the fields of the class',
  },
  // model.ts, makeModel: у агрегата и sum, и count — или ни того ни другого
  'model.aggregate_kind': {
    code: 'invalid_class',
    ru: '{cls}: агрегат {field} — ровно одно из sum и count: true',
    en: '{cls}: aggregate {field} takes exactly one of sum and count: true',
  },

  // jsonschema.ts, normalizeSchema: имя в начале текста ошибок, когда where не задан (часть текста, не ошибка)
  'model.schema_default_where': {
    code: 'invalid_class',
    ru: 'модель',
    en: 'model',
  },
  // jsonschema.ts, normalizeSchema: $ref не на определение из $defs (definitions)
  'model.schema_ref_unsupported': {
    code: 'invalid_class',
    ru: '{where}: ссылка {ref} не поддерживается (только #/$defs/…)',
    en: '{where}: reference {ref} is not supported (only #/$defs/…)',
  },
  // jsonschema.ts, normalizeSchema: $ref по кругу; cycle — имена определений через стрелку
  'model.schema_recursive': {
    code: 'invalid_class',
    ru: '{where}: рекурсивная модель через {cycle}',
    en: '{where}: recursive model via {cycle}',
  },
  // jsonschema.ts, normalizeSchema: $ref на определение, которого нет
  'model.schema_def_not_found': {
    code: 'invalid_class',
    ru: '{where}: определение {name} не найдено',
    en: '{where}: definition {name} not found',
  },
  // jsonschema.ts, normalizeSchema: узел описания — не объект и не true; node — путь вида $.a.b
  'model.schema_node_not_object': {
    code: 'invalid_class',
    ru: '{where}: описание узла {node} — не объект',
    en: '{where}: the description of node {node} is not an object',
  },
  // jsonschema.ts, normalizeSchema: ключевое слово JSON Schema вне подмножества базы
  'model.schema_keyword_unsupported': {
    code: 'invalid_class',
    ru: '{where}: ключевое слово {keyword} не поддерживается (узел {node})',
    en: '{where}: keyword {keyword} is not supported (node {node})',
  },
  // jsonschema.ts, normalizeSchema: format не из uuid, date, date-time, email
  'model.schema_format_unsupported': {
    code: 'invalid_class',
    ru: '{where}: format {format} не поддерживается (узел {node})',
    en: '{where}: format {format} is not supported (node {node})',
  },
  // jsonschema.ts, normalizeSchema с topLevel: поле верхнего уровня начинается с $
  'model.schema_field_dollar': {
    code: 'invalid_class',
    ru: '{where}: имя поля {field} начинается с $ — так загрузчик помечает служебные ключи',
    en: '{where}: field name {field} starts with $ — the loader marks service keys this way',
  },
  // jsonschema.ts, translatePattern: обратная косая черта последним знаком шаблона
  'model.pattern_trailing_backslash': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратная косая черта в конце шаблона)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions (a backslash at the end of the pattern)',
  },
  // jsonschema.ts, translatePattern: \D, \W, \S внутри [ ]; escape — сама последовательность
  'model.pattern_escape_in_set': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} внутри набора [ ] не переводится)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions ({escape} inside a [ ] set cannot be translated)',
  },
  // jsonschema.ts, translatePattern: \b, \B; escape — сама последовательность
  'model.pattern_word_boundary': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL ({escape} в PostgreSQL значит другое)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions ({escape} means something else in PostgreSQL)',
  },
  // jsonschema.ts, translatePattern: \p и \P
  'model.pattern_unicode_property': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (\\p{…} не поддерживается)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions (\\p{…} is not supported)',
  },
  // jsonschema.ts, translatePattern: \k и \1–\9
  'model.pattern_backreference': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (обратные ссылки не поддерживаются)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions (backreferences are not supported)',
  },
  // jsonschema.ts, translatePattern: именованная группа (?<имя>…)
  'model.pattern_named_group': {
    code: 'invalid_class',
    ru: '{where}: шаблон {pattern} несовместим с регулярными выражениями PostgreSQL (именованные группы не поддерживаются)',
    en: '{where}: pattern {pattern} is incompatible with PostgreSQL regular expressions (named groups are not supported)',
  },

  // validate.ts, compileValidator: узел описания — не объект и не true; node — путь узла массивом JSON
  'model.validator_node_not_object': {
    code: 'invalid_class',
    ru: 'описание узла {node} — не объект (узел {node})',
    en: 'the description of node {node} is not an object (node {node})',
  },
  // validate.ts, compileValidator: ключевое слово вне подмножества (не x-…)
  'model.validator_keyword_unsupported': {
    code: 'invalid_class',
    ru: 'ключевое слово {keyword} не поддерживается (узел {node})',
    en: 'keyword {keyword} is not supported (node {node})',
  },
  // validate.ts, compileValidator: type не из integer, number, string, boolean, object, array, null
  'model.validator_unknown_type': {
    code: 'invalid_class',
    ru: 'неизвестный тип в узле {node} (узел {node})',
    en: 'unknown type in node {node} (node {node})',
  },
  // validate.ts, compileValidator: enum или const с объектами внутри ветки anyOf или oneOf
  'model.validator_enum_objects_in_any_of': {
    code: 'invalid_class',
    ru: 'перечисление объектов внутри anyOf не поддерживается (узел {node})',
    en: 'an enum of objects inside anyOf is not supported (node {node})',
  },
  // validate.ts, compileValidator: pattern неверен уже для JavaScript; pattern — шаблон в JSON
  'model.validator_bad_pattern': {
    code: 'invalid_class',
    ru: 'pattern {pattern} — неверное регулярное выражение (узел {node})',
    en: 'pattern {pattern} is not a valid regular expression (node {node})',
  },
  // validate.ts, compileValidator: format не из uuid, date, date-time, email
  'model.validator_format_unsupported': {
    code: 'invalid_class',
    ru: 'format {format} не поддерживается (узел {node})',
    en: 'format {format} is not supported (node {node})',
  },
  // validate.ts, compileValidator: format date или date-time внутри ветки anyOf или oneOf
  'model.validator_format_in_any_of': {
    code: 'invalid_class',
    ru: 'format {format} внутри anyOf не поддерживается (узел {node})',
    en: 'format {format} inside anyOf is not supported (node {node})',
  },
  // validate.ts, compileValidator: minLength или maxLength внутри ветки anyOf или oneOf
  'model.validator_string_length_in_any_of': {
    code: 'invalid_class',
    ru: 'длина строки внутри anyOf не поддерживается (узел {node})',
    en: 'string length inside anyOf is not supported (node {node})',
  },
  // validate.ts, compileValidator: uniqueItems внутри ветки anyOf или oneOf
  'model.validator_unique_items_in_any_of': {
    code: 'invalid_class',
    ru: 'uniqueItems внутри anyOf не поддерживается (узел {node})',
    en: 'uniqueItems inside anyOf is not supported (node {node})',
  },
  // validate.ts, compileValidator: minProperties или maxProperties внутри ветки anyOf или oneOf
  'model.validator_min_properties_in_any_of': {
    code: 'invalid_class',
    ru: 'minProperties внутри anyOf не поддерживается (узел {node})',
    en: 'minProperties inside anyOf is not supported (node {node})',
  },
  // validate.ts, compileValidator: сообщения нарушений issues[].message — тексты не для ошибки (lmsg), те же, что у базы
  'model.issue_enum': {
    code: 'invalid_data',
    ru: 'значение не из перечисления',
    en: 'the value is not in the enum',
  },
  'model.issue_date': {
    code: 'invalid_data',
    ru: 'такой даты не бывает',
    en: 'no such date exists',
  },
  'model.issue_string_length': {
    code: 'invalid_data',
    ru: 'длина строки вне границ',
    en: 'string length is out of bounds',
  },
  'model.issue_unique_items': {
    code: 'invalid_data',
    ru: 'элементы повторяются',
    en: 'items repeat',
  },
  'model.issue_property_count': {
    code: 'invalid_data',
    ru: 'число ключей вне границ',
    en: 'the number of keys is out of bounds',
  },
  'model.issue_rule': {
    code: 'invalid_data',
    ru: 'нарушено правило {keyword}',
    en: 'rule {keyword} is violated',
  },

  // registry.ts, Registry.resolve: класса нет в реестре сессии ни по имени, ни по алиасу
  'model.class_not_found': {
    code: 'invalid_class',
    ru: 'класс {name} не найден',
    en: 'class {name} not found',
  },

  // sync.ts, syncModels: модель хаба с именем из RESERVED_CLASS_NAMES, собранная мимо hub() (план 2.0, этап 4, п. 2;
  // 7.10 №3) — отказ до записи
  'model.sync_hub_name_reserved': {
    code: 'invalid_class',
    ru: 'syncModels: имя хаба {name} занято методом цепочки или корня db — шаг с таким именем до класса не дойдёт',
    en: 'syncModels: the hub name {name} is taken by a method of the chain or of the db root — a step with this name never reaches the class',
    hint: {
      ru: 'дать классу другое имя: зарезервированные имена — в README, «Справочник API → Зарезервированные имена»',
      en: 'give the class another name: the reserved names are in README, "API reference → Reserved names"',
    },
  },
  // sync.ts, syncModels: родители и источники агрегатов замыкают круг; cycle — имена моделей через стрелку
  'model.models_cycle': {
    code: 'invalid_class',
    ru: 'syncModels: модели зависят друг от друга по кругу: {cycle} — родителя и источник агрегата база ждёт раньше класса',
    en: 'syncModels: the models depend on each other in a cycle: {cycle} — the database expects the parent and the aggregate source before the class',
  },
  // sync.ts, generateTypes: имя класса (например, созданного данными) — не идентификатор TypeScript
  'model.types_class_name': {
    code: 'invalid_class',
    ru: 'types: имя класса {name} не годится для идентификатора TypeScript',
    en: 'types: class name {name} is not a valid TypeScript identifier',
  },

  // uuid.ts, uuidv5: пространство имён (арендатор) — не uuid
  'model.v5_namespace_not_uuid': {
    code: 'invalid_data',
    ru: 'пространство имён v5 — не uuid: {ns}',
    en: 'the v5 namespace is not a uuid: {ns}',
    hint: {
      ru: 'пространство имён v5 — id арендатора (uuid): idOf(класс, ключ, { tenant })',
      en: 'the v5 namespace is a tenant id (a uuid): idOf(class, key, { tenant })',
    },
  },
  // uuid.ts, idOf: у класса нет ключа
  'model.class_no_key': {
    code: 'no_key',
    ru: 'у класса {cls} нет ключа: id выдаёт база при создании',
    en: 'class {cls} has no key: the database assigns the id on creation',
  },
  // uuid.ts, idOf: часть ключа не задана или не строка; detail.key — части ключа класса
  'model.key_part_not_string': {
    code: 'invalid_data',
    ru: 'idOf({cls}): часть ключа {part} должна быть строкой',
    en: 'idOf({cls}): key part {part} must be a string',
    hint: {
      ru: 'передать каждую часть ключа строкой (части — в detail.key): у поля — его значение, у конца — id цели',
      en: 'pass every key part as a string (the parts are in detail.key): the value for a field, the target id for an end',
    },
  },
  // uuid.ts, idOf: значение конца в ключе — не uuid
  'model.key_end_not_uuid': {
    code: 'invalid_data',
    ru: 'idOf({cls}): конец {end} — не uuid',
    en: 'idOf({cls}): end {end} is not a uuid',
    hint: {
      ru: 'значение конца в ключе — id цели (uuid)',
      en: 'the value of an end in the key is the id of the target (a uuid)',
    },
  },

  // cli.ts, main: letopis load --trust — режима доверия нет с 1.0.0
  'model.cli_trust_removed': {
    code: 'removed',
    ru: '--trust снят в 1.0.0 — запрос по целям вне загрузки стоит 0,1–1,3 % её времени',
    en: '--trust was removed in 1.0.0 — the query for targets outside the load costs 0.1–1.3% of its time',
    hint: {
      ru: 'запускать letopis load без --trust: режима доверия больше нет, цели вне загрузки загрузчик проверяет сам',
      en: 'run letopis load without --trust: there is no trust mode anymore, the loader checks the targets outside the load itself',
    },
  },
  // cli.ts, mcp: letopis mcp с ключом сервиса (--api-key)
  'model.mcp_api_key_refused': {
    code: 'user_session_required',
    ru: 'letopis mcp принимает только токен сессии пользователя (--token или LETOPIS_TOKEN): ключ сервиса даёт все права auth.* и не должен лежать на машине агента',
    en: 'letopis mcp accepts only a user session token (--token or LETOPIS_TOKEN): a service key grants all auth.* rights and must not be stored on the agent machine',
    hint: {
      ru: 'убрать --api-key и передать токен сессии пользователя: --token или LETOPIS_TOKEN',
      en: 'drop --api-key and pass a user session token: --token or LETOPIS_TOKEN',
    },
  },
  // cli.ts, mcp: letopis mcp без токена — ни --token, ни LETOPIS_TOKEN
  'model.mcp_token_required': {
    code: 'user_session_required',
    ru: 'letopis mcp — нужен токен сессии пользователя: --token или LETOPIS_TOKEN',
    en: 'letopis mcp needs a user session token: --token or LETOPIS_TOKEN',
    hint: {
      ru: 'передать токен сессии пользователя: --token или LETOPIS_TOKEN',
      en: 'pass a user session token: --token or LETOPIS_TOKEN',
    },
  },
  // cli.ts, main: отчёт letopis sync (lmsg, на языке --lang) — тексты не для ошибки, код не печатается. Итог: сухой
  // прогон и с --apply; числа классов по группам
  'model.cli_sync_dry_run': {
    code: 'invalid_query',
    ru: 'сухой прогон: создать {created}, изменить {updated}, без изменений {unchanged}, системных {skipped}',
    en: 'dry run: create {created}, update {updated}, unchanged {unchanged}, system {skipped}',
  },
  'model.cli_sync_applied': {
    code: 'invalid_query',
    ru: 'применено: создать {created}, изменить {updated}, без изменений {unchanged}, системных {skipped}',
    en: 'applied: create {created}, update {updated}, unchanged {unchanged}, system {skipped}',
  },
  // строки групп; names — классы через запятую
  'model.cli_sync_list_create': {
    code: 'invalid_query',
    ru: 'создать: {names}',
    en: 'create: {names}',
  },
  'model.cli_sync_list_update': {
    code: 'invalid_query',
    ru: 'изменить: {names}',
    en: 'update: {names}',
  },
  'model.cli_sync_list_system': {
    code: 'invalid_query',
    ru: 'системные (меняет установка): {names}',
    en: 'system (changed by the installation): {names}',
  },
  // правило Zod (refine, transform), которого нет в базе; kind — вид правила, path — где оно
  'model.cli_sync_lost': {
    code: 'invalid_query',
    ru: 'правило {kind} в {path} проверяется только в библиотеке — в базе его нет',
    en: 'rule {kind} at {path} is checked only in the library — the database does not have it',
  },
  // sync.ts, generateTypes: пометка в первой строке файла типов (после «// ») — текст не для ошибки
  'model.types_header': {
    code: 'invalid_query',
    ru: 'Сгенерировано letopis types — не править руками.',
    en: 'Generated by letopis types — do not edit by hand.',
  },

  // check.ts, loadTypescript: нет пакета typescript (или в нём нет Compiler API) — обычный Error с префиксом
  // letopis check, без кода (код записи при броске не берётся)
  'model.check_typescript_missing': {
    code: 'invalid_query',
    ru: 'для letopis check нужен пакет typescript (Compiler API) — npm i -D typescript',
    en: 'letopis check needs the typescript package (Compiler API) — npm i -D typescript',
  },
  // check.ts, правило reserved-name: имя класса, алиас или роль в hub() и link() — из RESERVED_CLASS_NAMES; fn — hub
  // или link
  'model.check_reserved_name': {
    code: 'invalid_class',
    ru: '{fn}(): имя {name} занято методом цепочки или корня db — шаг с таким именем до класса или роли не дойдёт',
    en: '{fn}(): the name {name} is taken by a method of the chain or of the db root — a step with this name never reaches the class or role',
  },
  // check.ts, правило no-filter: update() или delete({ confirm: true }), а ни у одного шага нет фильтра, id, limit(),
  // tags(), owner() и entity(); call — сам вызов
  'model.check_no_filter': {
    code: 'invalid_query',
    ru: '{call} без фильтра: ни у одного шага нет фильтра, id или limit() — правка пройдёт по всем строкам',
    en: '{call} without a filter: no step has a filter, an id or limit() — the change goes over all rows',
  },
  // check.ts, правило delete-preview: delete() без { confirm: true } последним глаголом, результат цепочки не используется
  'model.check_delete_preview': {
    code: 'invalid_query',
    ru: 'delete() без { confirm: true } — только предпросмотр: ничего не удаляется, а его результат не используется',
    en: 'delete() without { confirm: true } is only a preview: nothing is deleted, and its result is not used',
  },
  // check.ts, правило upsert-no-key: upsert() у класса без ключа (по моделям --models и системным классам)
  'model.check_upsert_no_key': {
    code: 'no_key',
    ru: 'upsert(): у класса {cls} нет ключа — сравнивать не с чем, используйте create()',
    en: 'upsert(): class {cls} has no key — there is nothing to compare with, use create()',
  },
  // check.ts, правило mod-after-verb: модификатор выборки после глагола перед rows, first, ids, count, paths или в конце
  // цепочки батча
  'model.check_mod_after_verb': {
    code: 'invalid_query',
    ru: '{name}() после {verb}() ни на что не действует: глагол проходит по всем целям шага, а ответ — его строки. Цели сужают limit(), offset() и sort() до глагола: db.Класс(…).limit(n).{verb}(…)',
    en: '{name}() after {verb}() has no effect: the verb goes over all targets of the step, and the result is its rows. Narrow the targets with limit(), offset() and sort() before the verb: db.ClassName(…).limit(n).{verb}(…)',
  },
  // check.ts, правило mod-after-verb: модификатор шага (deep, exact, alias, tags, owner) сразу после глагола
  'model.check_step_mod_after_verb': {
    code: 'invalid_query',
    ru: '{name}() после {verb}(): модификатор шага — сначала шаг класса',
    en: '{name}() after {verb}(): a step modifier — first a class step',
  },
  // check.ts, правило for-update-outside-tx: forUpdate() в цепочке от подключения, а не от db.begin()
  'model.check_for_update_outside_tx': {
    code: 'tx_required',
    ru: 'forUpdate() — только внутри db.begin(): вне явной транзакции блокировка снялась бы сразу',
    en: 'forUpdate() works only inside db.begin(): outside an explicit transaction the lock would be released at once',
  },
  // check.ts, правило unknown-name: шаг или слот не из классов, алиасов и ролей моделей --models и системных классов;
  // похожие — params.similar
  'model.check_unknown_name': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены в моделях',
    en: 'class or role {name} not found in the models',
  },
  // check.ts, formatReport: без --models два правила не проверялись (часть текста отчёта, не ошибка)
  'model.check_no_models': {
    code: 'invalid_query',
    ru: 'без --models не проверялись неизвестные классы и роли и upsert() у класса без ключа',
    en: 'without --models, unknown classes and roles and upsert() on a class without a key were not checked',
  },
  // check.ts, formatReport: итог текстового отчёта (часть текста, не ошибка)
  'model.check_summary': {
    code: 'invalid_query',
    ru: 'letopis check: файлов {files}, ошибок {errors}',
    en: 'letopis check: files {files}, errors {errors}',
  },
} satisfies Section<'model'>;
