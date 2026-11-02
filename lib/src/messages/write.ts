/**
 * Раздел write: write.ts, tx.ts, load.ts — планы записи, транзакции, батч, загрузчик.
 */
import type { Section } from './types.js';

export const write = {
  // write.ts — write.ts:checkReason: причина изменения (reason у глаголов, db.begin(), батча)
  'write.bad_reason': {
    code: 'invalid_query',
    ru: '{where}: reason — строка до 1000 символов',
    en: '{where}: reason must be a string of up to 1000 characters',
  },
  // данные create(), upsert(), rekey(): inc() внутри массива
  'write.inc_in_array': {
    code: 'invalid_data',
    ru: 'inc() внутри массива ({path}) не поддерживается',
    en: 'inc() inside an array ({path}) is not supported',
  },
  // данные: оператор фильтра внутри вложенного значения
  'write.op_in_data': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных ({path}) — данные записываются значениями',
    en: 'a filter operator in the data ({path}) — data is written as values',
  },
  // патч update(): величина inc(by)
  'write.inc_by_not_finite': {
    code: 'invalid_data',
    ru: 'inc({by}) по пути {path}: величина — конечное число',
    en: 'inc({by}) at path {path}: the amount must be a finite number',
  },
  // патч update(): inc(by, { start })
  'write.inc_start_not_finite': {
    code: 'invalid_data',
    ru: 'inc: start по пути {path} — конечное число',
    en: 'inc: start at path {path} must be a finite number',
  },
  // патч update(): оператор фильтра вместо значения
  'write.op_in_patch': {
    code: 'invalid_data',
    ru: 'оператор фильтра в патче ({path}) — update записывает значения',
    en: 'a filter operator in the patch ({path}) — update writes values',
  },
  // данные create(), upsert(), rekey() — не объект
  'write.data_not_object': {
    code: 'invalid_data',
    ru: '{verb}(): данные — объект',
    en: '{verb}(): the data must be an object',
  },
  // inc() в данных глагола, кроме update()
  'write.inc_outside_update': {
    code: 'invalid_data',
    ru: 'inc() работает только в update(): {verb}() по пути {path}',
    en: 'inc() works only in update(): {verb}() at path {path}',
  },
  // оператор фильтра на верхнем уровне данных глагола
  'write.op_in_verb_data': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных {verb}() ({path}) — данные записываются значениями',
    en: 'a filter operator in the {verb}() data ({path}) — data is written as values',
  },
  // агрегатные поля в данных create() и upsert(); fields — список через запятую
  'write.aggregate_given': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — их не передают',
    en: 'fields {fields} of class {cls} are computed by the database (aggregate) — do not pass them',
  },
  // агрегатные поля в патче update()
  'write.aggregate_patched': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — update их не меняет',
    en: 'fields {fields} of class {cls} are computed by the database (aggregate) — update does not change them',
  },
  // глагол после asOf()
  'write.as_of_write': {
    code: 'invalid_query',
    ru: '{verb}(): asOf описывает прошлое — записывать в него нельзя',
    en: '{verb}(): asOf describes the past — you cannot write to it',
  },
  // глагол после withDeleted(), кроме restore() и purge()
  'write.with_deleted_write': {
    code: 'invalid_query',
    ru: '{verb}(): withDeleted описывает удалённые — записывать в них нельзя',
    en: '{verb}(): withDeleted describes deleted entities — you cannot write to them',
  },
  // create() или upsert() сразу после другого глагола; prev — прежний глагол
  'write.verb_after_verb': {
    code: 'invalid_query',
    ru: '{verb}() сразу после {prev}() — между глаголами нужен шаг',
    en: '{verb}() right after {prev}() — a step is needed between verbs',
  },
  // create() или upsert() на возврате к узлу пути
  'write.create_on_pivot': {
    code: 'invalid_query',
    ru: '{verb}() на возврате к узлу — он ведёт к существующей сущности, используйте update()',
    en: '{verb}() on a return to a node — it leads to an existing entity, use update()',
  },
  // create() или upsert() после шага с фильтром, а не с id
  'write.create_with_filter': {
    code: 'invalid_query',
    ru: '{verb}() не ищет: {step}(id).{verb}(…) задаёт id, поиск — это update()',
    en: '{verb}() does not search: {step}(id).{verb}(…) sets the id, searching is update()',
  },
  // upsert() у класса без ключа
  'write.upsert_no_key': {
    code: 'no_key',
    ru: 'upsert(): у класса {cls} нет ключа — сравнивать не с чем, используйте create()',
    en: 'upsert(): class {cls} has no key — there is nothing to compare with, use create()',
  },
  // .tags() перед create() или upsert() — не строка и не список
  'write.bad_tags': {
    code: 'invalid_query',
    ru: '.tags() перед {verb}() — строка или список',
    en: '.tags() before {verb}() must be a string or a list',
  },
  // патч update() — не объект
  'write.patch_not_object': {
    code: 'invalid_data',
    ru: 'update(): патч — объект',
    en: 'update(): the patch must be an object',
  },
  // update(patch, { rev }) — rev не номер версии
  'write.bad_rev': {
    code: 'invalid_query',
    ru: 'update(patch, { rev }): rev — номер версии строки',
    en: 'update(patch, { rev }): rev must be the row version number',
  },
  // anonymize() без полей
  'write.anonymize_no_fields': {
    code: 'invalid_query',
    ru: 'anonymize(поля): нужен список полей',
    en: 'anonymize(fields): a list of fields is required',
  },
  // anonymize(): поля нет в классе (план 2.0, 7.5 №3)
  'write.anonymize_unknown_field': {
    code: 'invalid_query',
    ru: 'anonymize(): поля {field} нет в классе {cls}',
    en: 'anonymize(): class {cls} has no field {field}',
  },
  // anonymize(): поле не строковое; type — тип листа
  'write.anonymize_not_text': {
    code: 'invalid_query',
    ru: 'anonymize() затирает только строковые поля; {field} — {type}',
    en: 'anonymize() erases only string fields; {field} is {type}',
  },
  // rekey() у класса без ключа
  'write.rekey_no_key': {
    code: 'no_key',
    ru: 'rekey(): у класса {cls} нет ключа — id выдаёт база, менять нечего',
    en: 'rekey(): class {cls} has no key — the database assigns the id, there is nothing to change',
  },
  // слот после глагола, который слотов не принимает
  'write.slot_bad_verb': {
    code: 'invalid_query',
    ru: 'слот .{role} после {verb}() — слоты у create(), update() и upsert()',
    en: 'slot .{role} after {verb}() — slots belong to create(), update() and upsert()',
  },
  // write.ts:slotRole: имя слота — не роль записываемого класса и не класс реестра
  'write.slot_unknown': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
    en: 'class or role {name} not found',
  },
  // write.ts:slotRole: класс слота не принимает ни одна роль; ends — концы через запятую или «—»
  'write.slot_not_end': {
    code: 'invalid_query',
    ru: '{name} — не конец класса {cls} (концы: {ends})',
    en: '{name} is not an end of class {cls} (ends: {ends})',
  },
  // write.ts:slotRole: класс слота принимают несколько ролей
  'write.slot_ambiguous': {
    code: 'invalid_query',
    ru: 'слот {name} у класса {cls} неоднозначен: роли {roles} — назовите роль',
    en: 'slot {name} of class {cls} is ambiguous: roles {roles} — name the role',
  },
  // конец из пути: шаг подходит нескольким ролям
  'write.end_ambiguous': {
    code: 'invalid_query',
    ru: 'конец класса {cls} для шага {step} неоднозначен: роли {roles} — назовите шаг ролью или задайте слот',
    en: 'the end of class {cls} for step {step} is ambiguous: roles {roles} — name the step by a role or set a slot',
  },
  // конец из пути: шаг дал не одну сущность; count — сколько найдено
  'write.end_not_single': {
    code: 'invalid_query',
    ru: 'шаг {step} должен дать ровно одну сущность для конца {cls} (найдено {count})',
    en: 'step {step} must yield exactly one entity for the end {cls} (found {count})',
  },
  // слот .роль.set() одиночного конца — значение дало несколько сущностей
  'write.slot_single_many': {
    code: 'invalid_query',
    ru: 'слот .{role}.set(): конец одиночный, а значение дало {count} сущностей',
    en: 'slot .{role}.set(): the end is single, but the value yielded {count} entities',
  },
  // write.ts:existsError: create() — объект уже есть, id не вычислить
  'write.exists': {
    code: 'exists',
    ru: 'объект класса {cls} уже существует',
    en: 'an object of class {cls} already exists',
  },
  // write.ts:existsError: create() — объект уже есть, id известен
  'write.exists_id': {
    code: 'exists',
    ru: 'объект класса {cls} уже существует (id {id})',
    en: 'an object of class {cls} already exists (id {id})',
  },
  // write.ts:explainMissing: одна цель не видна
  'write.target_missing': {
    code: 'target_not_found',
    ru: 'цель {id} не найдена',
    en: 'target {id} not found',
  },
  // write.ts:explainMissing: несколько целей не видны; ids — через запятую
  'write.targets_missing': {
    code: 'target_not_found',
    ru: 'цели не найдены: {ids}',
    en: 'targets not found: {ids}',
  },
  // write.ts:explainMissing: update(patch, { rev }) — строку успели изменить
  'write.rev_conflict': {
    code: 'conflict',
    ru: 'строку {id} успели изменить: версия {rev}, а не {expected} — перечитайте и повторите',
    en: 'row {id} has been changed: version {rev}, not {expected} — re-read and retry',
  },
  // write.ts:explainMissing: строки видны, но RLS не дала их изменить; ids — через запятую
  'write.rows_denied': {
    code: 'acl_denied',
    ru: 'строки видны, но изменить их нельзя: {ids}',
    en: 'the rows are visible, but you may not change them: {ids}',
  },
  // update(patch, { rev }): у шага больше одной цели; count — сколько
  'write.rev_many_targets': {
    code: 'rev_ambiguous',
    ru: 'update(patch, { rev }): у шага {step} {count} целей — проверить версию { rev } можно только у одной цели',
    en: 'update(patch, { rev }): step {step} has {count} targets — the { rev } version check works only for a single target',
  },
  // update(patch, { rev }): у шага нет цели
  'write.rev_no_target': {
    code: 'target_not_found',
    ru: 'update(patch, { rev }): у шага {step} нет цели',
    en: 'update(patch, { rev }): step {step} has no target',
  },
  // restore() живого объекта
  'write.not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: {verb}() — только для удалённых',
    en: 'the object is not deleted: {verb}() is only for deleted objects',
  },
  // purge() живого объекта
  'write.not_deleted_purge': {
    code: 'not_deleted',
    ru: 'объект не удалён: purge() — только для удалённых, сначала delete()',
    en: 'the object is not deleted: purge() is only for deleted objects, call delete() first',
  },
  // rekey(): объект с новым ключом уже есть
  'write.rekey_exists': {
    code: 'exists',
    ru: 'rekey(): объект класса {cls} с таким ключом уже существует',
    en: 'rekey(): an object of class {cls} with this key already exists',
  },
  // tx.ts — tx.ts:commitUnknown: связь оборвалась во время commit
  'write.commit_unknown': {
    code: 'commit_unknown',
    ru: 'связь оборвалась во время commit: транзакция могла зафиксироваться — проверьте исход повтором той же операции с тем же ключом',
    en: 'the connection dropped during commit: the transaction may have been committed — check the outcome by repeating the same operation with the same key',
  },
  // tx.ts: запрос в завершённой транзакции db.begin()
  'write.tx_done': {
    code: 'tx_required',
    ru: 'транзакция db.begin() уже завершена',
    en: 'the db.begin() transaction has already finished',
    hint: {
      ru: 'транзакция уже зафиксирована или откатана — откройте новую: `const tr = await db.begin()`',
      en: 'the transaction has already been committed or rolled back — open a new one: `const tr = await db.begin()`',
    },
  },
  // tx.ts: lock() в завершённой транзакции db.begin()
  'write.lock_tx_done': {
    code: 'tx_required',
    ru: 'lock(): транзакция db.begin() уже завершена',
    en: 'lock(): the db.begin() transaction has already finished',
    hint: {
      ru: 'транзакция уже зафиксирована или откатана — откройте новую: `const tr = await db.begin()`',
      en: 'the transaction has already been committed or rolled back — open a new one: `const tr = await db.begin()`',
    },
  },
  // tx.ts: commit() транзакции, в которой была ошибка, — PostgreSQL её откатил
  'write.tx_rolled_back': {
    code: 'tx_rolled_back',
    ru: 'commit: PostgreSQL откатил транзакцию (в ней была ошибка)',
    en: 'commit: PostgreSQL rolled back the transaction (it contained an error)',
  },
  // load.ts — загрузчик db.load()
  // Issues.fail(): загрузка отменена, первое нарушение (message — его текст); код ошибки — код этого нарушения
  // (detail.rows[0].code), а не записи: место строит LetopisError с ключом, как fromDbError
  'write.load_cancelled': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message}',
    en: 'load cancelled: row {line} — {message}',
  },
  // Issues.fail(): … и ещё rest нарушений, проверены все строки
  'write.load_cancelled_more': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (и ещё {rest})',
    en: 'load cancelled: row {line} — {message} (and {rest} more)',
  },
  // Issues.fail(): … проверены не все строки (why — причины через точку с запятой), нарушений не меньше rest + 1
  'write.load_cancelled_at_least': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (и ещё не меньше {rest}: {why})',
    en: 'load cancelled: row {line} — {message} (at least {rest} more: {why})',
  },
  // Issues.fail(): … нарушение одно, но проверены не все строки
  'write.load_cancelled_maybe_more': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (возможно, не единственная: {why})',
    en: 'load cancelled: row {line} — {message} (possibly not the only one: {why})',
  },
  // причина в why текста отмены (laterUnchecked): порция commitEvery не последняя
  'write.load_later_portions': {
    code: 'invalid_data',
    ru: 'следующие порции не проверялись',
    en: 'the following portions were not checked',
  },
  // причина в why (prepareBatch, { as }): условия ACL проверили пачку, а следующие пачки — нет
  'write.load_later_batches': {
    code: 'invalid_data',
    ru: 'условия ACL следующих пачек не проверялись',
    en: 'the ACL conditions of the following batches were not checked',
  },
  // причина в why (prepareBatch, pipeline, historyWrite): нарушение нашлось раньше, чем база проверила pattern
  // (его валидатор на TypeScript оставляет базе) у строк, уже прошедших проверку в коде
  'write.load_db_rules_unchecked': {
    code: 'invalid_data',
    ru: 'шаблоны pattern (их проверяет база) проверены не у всех строк',
    en: 'the pattern rules (checked by the database) were not checked for all rows',
  },
  // причина в why (verifyIds, verify: true; checkInDb): проверка базы называет не больше limit строк
  'write.load_db_check_limit': {
    code: 'invalid_data',
    ru: 'проверка базы называет не больше {limit} строк',
    en: 'the database check names at most {limit} rows',
  },
  // toList: вход db.load() — не объект «класс → строки», не массив и не поток
  'write.load_bad_input': {
    code: 'invalid_data',
    ru: 'load(): вход — объект «класс → строки», массив или поток строк с $class',
    en: 'load(): the input must be an object "class → rows", an array or a stream of rows with $class',
    hint: {
      ru: 'передать объект { Класс: [строки] }, массив строк с $class или их поток (Iterable, AsyncIterable); класс строк без $class — опция class',
      en: 'pass an object { Class: [rows] }, an array of rows with $class or a stream of them (Iterable, AsyncIterable); the class of rows without $class is the class option',
    },
  },
  // refOf — значение конца (текст — error нарушений write.load_end_ref и write.load_key_part_ref): строка, но не uuid
  'write.load_end_not_uuid': {
    code: 'invalid_data',
    ru: 'значение конца не uuid',
    en: 'the end value is not a uuid',
  },
  // refOf: не строка и не объект с $key или $ext
  'write.load_end_value': {
    code: 'invalid_data',
    ru: 'значение конца — id, { $key } или { $ext }',
    en: 'the end value must be an id, { $key } or { $ext }',
  },
  // refOf: у полиморфного конца нет $class цели
  'write.load_end_polymorphic': {
    code: 'invalid_data',
    ru: 'полиморфный конец: укажите $class цели',
    en: 'polymorphic end: specify the $class of the target',
  },
  // refOf: класса цели нет в реестре или он абстрактный
  'write.load_target_class': {
    code: 'invalid_data',
    ru: 'класс цели {name} не найден или абстрактный',
    en: 'target class {name} not found or abstract',
  },
  // refOf: $key цели — не список строк по частям ключа (key — части через запятую)
  'write.load_target_key': {
    code: 'invalid_data',
    ru: '$key цели {cls} — список строк ключа [{key}]',
    en: '$key of target {cls} must be a list of strings for the key [{key}]',
  },
  // refOf: $ext у цели класса с ключом
  'write.load_ext_keyed': {
    code: 'invalid_data',
    ru: '$ext — для класса без ключа, а у {cls} ключ [{key}]',
    en: '$ext is for a class without a key, but {cls} has the key [{key}]',
  },
  // refOf, idOfRow: $ext не строка
  'write.load_ext_string': {
    code: 'invalid_data',
    ru: '$ext — строка',
    en: '$ext must be a string',
  },
  // shape — нарушение строки: значение конца со многими целями не массив
  'write.load_end_list': {
    code: 'invalid_data',
    ru: 'конец {role} — список целей',
    en: 'end {role} must be a list of targets',
  },
  // shape: значение конца не годится (error — текст refOf)
  'write.load_end_ref': {
    code: 'invalid_data',
    ru: 'конец {role}: {error}',
    en: 'end {role}: {error}',
  },
  // shape: цель повторяется в списке конца
  'write.load_end_repeat': {
    code: 'invalid_data',
    ru: 'конец {role}: цель повторяется',
    en: 'end {role}: a target is repeated',
  },
  // shape: inc() в данных строки (path — путь к значению)
  'write.load_inc': {
    code: 'invalid_data',
    ru: 'inc() — только в update() ({path})',
    en: 'inc() is only for update() ({path})',
  },
  // shape: оператор фильтра в данных строки (path — путь к значению)
  'write.load_filter_op': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных ({path})',
    en: 'a filter operator in the data ({path})',
  },
  // shape: данные не проходят валидатор класса на TypeScript; нарушения — issues строки отчёта
  'write.load_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
    en: 'the data does not match the description of class {cls}',
  },
  // shape: у конца со многими целями меньше min
  'write.load_end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {role} слишком мало целей',
    en: 'end {role} has too few targets',
  },
  // shape: обязательный конец не задан
  'write.load_end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {role} не задан',
    en: 'required end {role} is not set',
  },
  // shape: у конца со многими целями больше max
  'write.load_end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {role} слишком много целей',
    en: 'end {role} has too many targets',
  },
  // idOfRow — нарушение строки: часть ключа — конец, а его значение не годится (error — текст refOf)
  'write.load_key_part_ref': {
    code: 'invalid_data',
    ru: 'часть ключа {part}: {error}',
    en: 'key part {part}: {error}',
  },
  // idOfRow: часть ключа — поле, а значение не строка
  'write.load_key_part_string': {
    code: 'invalid_data',
    ru: 'часть ключа {part} — строка',
    en: 'key part {part} must be a string',
  },
  // verifyIds (verify: true) — нарушение: строка не проходит проверку базы; нарушения — issues строки отчёта
  'write.load_db_invalid': {
    code: 'invalid_data',
    ru: 'проверка базы: строка {id} не проходит описание класса {cls}',
    en: 'database check: row {id} does not match the description of class {cls}',
  },
  // verifyIds: конец ведёт на строку производного класса
  'write.load_db_derived': {
    code: 'derived_class',
    ru: 'проверка базы: конец {role} ведёт на строку производного класса',
    en: 'database check: end {role} leads to a row of a derived class',
  },
  // verifyIds: цели конца нет
  'write.load_db_target': {
    code: 'target_not_found',
    ru: 'проверка базы: цель конца {role} не найдена',
    en: 'database check: the target of end {role} is not found',
  },
  // load(), initialSession(): подключение не может стать владельцем схемы
  'write.load_admin_required': {
    code: 'admin_required',
    ru: 'загрузчику нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)',
    en: 'the loader needs an admin connection (connect({ allowBypassRls: true }) of a role that can become the schema owner)',
  },
  // load({ as }): не uuid
  'write.load_as_not_uuid': {
    code: 'invalid_data',
    ru: 'load({ as }): id аккаунта',
    en: 'load({ as }): an account id is expected',
    hint: {
      ru: 'передать в as id (uuid) аккаунта, от имени которого идёт загрузка',
      en: 'pass in as the id (uuid) of the account on whose behalf the load runs',
    },
  },
  // load({ as, withHistory })
  'write.load_as_history': {
    code: 'invalid_data',
    ru: 'load({ as }) и режим истории несовместимы: историю импортирует администратор',
    en: 'load({ as }) and history mode are incompatible: history is imported by an administrator',
    hint: {
      ru: 'историю (withHistory) загружать без as; от имени пользователя — загрузка без истории',
      en: 'load history (withHistory) without as; on behalf of a user, load without history',
    },
  },
  // load({ withHistory, existing: 'update' })
  'write.load_history_update': {
    code: 'invalid_data',
    ru: "режим истории: existing — 'error' или 'skip' (новую версию существующего объекта пишет загрузка без истории)",
    en: "history mode: existing must be 'error' or 'skip' (a new version of an existing object is written by a load without history)",
    hint: {
      ru: "новые версии существующих объектов — отдельной загрузкой без withHistory с existing: 'update'",
      en: "write new versions of existing objects with a separate load without withHistory and with existing: 'update'",
    },
  },
  // load({ initial, commitEvery })
  'write.load_initial_commit_every': {
    code: 'invalid_data',
    ru: 'первая заливка (initial) несовместима с commitEvery: снятые индексы и TRUNCATE требуют одной транзакции',
    en: 'the initial load (initial) is incompatible with commitEvery: the dropped indexes and TRUNCATE require one transaction',
    hint: {
      ru: 'убрать commitEvery: первая заливка — всегда одна транзакция; порциями пишет загрузка без initial',
      en: 'remove commitEvery: the initial load is always one transaction; a load without initial writes in portions',
    },
  },
  // load({ initial, existing }): existing не 'error'
  'write.load_initial_existing': {
    code: 'invalid_data',
    ru: "первая заливка (initial): existing — только 'error', в пустой схеме пропускать и обновлять нечего",
    en: "the initial load (initial): existing can only be 'error', in an empty schema there is nothing to skip or update",
    hint: {
      ru: 'убрать existing; пропустить или обновить существующие объекты — загрузкой без initial',
      en: 'remove existing; to skip or update existing objects, use a load without initial',
    },
  },
  // load({ initial, as })
  'write.load_initial_as': {
    code: 'invalid_data',
    ru: 'первая заливка (initial) — от администратора, без { as }',
    en: 'the initial load (initial) runs as an administrator, without { as }',
    hint: {
      ru: 'убрать as; от имени пользователя — загрузка без initial',
      en: 'remove as; a load on behalf of a user goes without initial',
    },
  },
  // load(): нет ни { tenant }, ни { as }, ни арендатора сессии
  'write.load_no_tenant': {
    code: 'invalid_data',
    ru: 'load(): нет арендатора — сессия без арендатора и не задан { tenant }',
    en: 'load(): no tenant — the session has no tenant and { tenant } is not given',
    hint: {
      ru: 'передать load(…, { tenant }) или загружать в сессии с арендатором',
      en: 'pass load(…, { tenant }) or load in a session that has a tenant',
    },
  },
  // проход 1 — нарушение строки: класса $class нет в реестре
  'write.load_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {name} не найден',
    en: 'class {name} not found',
  },
  // проход 1: у строки нет $class (и нет опции class)
  'write.load_no_class': {
    code: 'invalid_class',
    ru: 'нет $class',
    en: 'no $class',
  },
  // проход 1: строка класса Class
  'write.load_class_rows': {
    code: 'class_not_loadable',
    ru: 'строки Class задают letopis sync и create — там база компилирует проверку',
    en: 'Class rows are set by letopis sync and create — that is where the database compiles the check',
  },
  // проход 1: класс абстрактный
  'write.load_class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
    en: 'class {cls} is abstract',
  },
  // проход 1: класс производный — его строки пишет только проектор
  'write.load_class_derived': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
    en: 'class {cls} is derived: its rows are written by projector {projector}',
  },
  // проход 1, первая заливка: id занят строкой системного класса или прошлой загрузкой сессии
  'write.load_taken': {
    code: 'exists',
    ru: 'объект уже есть в схеме: строка системного класса или запись этой же первой заливки',
    en: 'the object is already in the schema: a row of a system class or a record of this same initial load',
  },
  // проход 1: повтор id при duplicates: 'error' (prev — строка, где id был раньше)
  'write.load_duplicate': {
    code: 'duplicate',
    ru: 'id {id} уже был в строке {prev}',
    en: 'id {id} was already in row {prev}',
  },
  // loadPortion ({ as }) — нарушение: у пользователя нет права WRITE на класс
  'write.load_no_write': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
    en: 'no WRITE permission on class {cls}',
  },
  // check, loadPortion, initialSession — нарушение: цели конца нет, она чужая, не того класса или не видна ({ as })
  'write.load_target_not_found': {
    code: 'target_not_found',
    ru: 'цель конца {role} не найдена',
    en: 'the target of end {role} is not found',
  },
  // loadPortion, initialSession: цель вне загрузки — строка производного класса
  'write.load_target_derived': {
    code: 'derived_class',
    ru: 'цель конца {role} — строка производного класса {cls}',
    en: 'the target of end {role} is a row of derived class {cls}',
  },
  // loadPortion, initialSession: владелец ($owner) — не аккаунт
  'write.load_owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец {id} не найден',
    en: 'owner {id} not found',
  },
  // loadPortion, initialSession: арендатора нет или он отключён
  'write.load_tenant_denied': {
    code: 'tenant_denied',
    ru: 'арендатор {tenant} не найден или отключён',
    en: 'tenant {tenant} not found or disabled',
  },
  // explainTaken (existing: 'error') — нарушение: id занят живым объектом
  'write.load_exists': {
    code: 'exists',
    ru: 'объект уже есть в базе',
    en: 'the object is already in the database',
  },
  // explainTaken: id занят удалённым объектом
  'write.load_deleted': {
    code: 'deleted',
    ru: 'объект с этим id жил раньше и удалён (existing: update воскресит)',
    en: 'an object with this id existed before and was deleted (existing: update resurrects it)',
  },
  // explainTaken: первичный ключ отказал, а занятых id запрос не нашёл
  'write.load_objects_exist': {
    code: 'exists',
    ru: 'загрузка отменена: часть объектов уже есть в базе',
    en: 'load cancelled: some of the objects are already in the database',
  },
  // check — нарушение строки: Account не в арендаторе System
  'write.load_account_tenant': {
    code: 'tenant_denied',
    ru: 'аккаунты лежат в арендаторе System',
    en: 'accounts are kept in the System tenant',
  },
  // check: конец Tenant строки member — не арендатор строки
  'write.load_member_tenant': {
    code: 'invalid_data',
    ru: 'конец Tenant членства — арендатор строки',
    en: 'the Tenant end of a membership must be the tenant of the row',
  },
  // check: $tags — не список строк
  'write.load_tags': {
    code: 'invalid_data',
    ru: '$tags — список строк',
    en: '$tags must be a list of strings',
  },
  // check: $owner при { as }
  'write.load_as_owner': {
    code: 'invalid_data',
    ru: 'load({ as }): $owner не задаётся — владелец по ownerDefault класса',
    en: 'load({ as }): $owner cannot be set — the owner follows the ownerDefault of the class',
  },
  // check: $owner не uuid
  'write.load_owner_id': {
    code: 'invalid_data',
    ru: '$owner — id аккаунта',
    en: '$owner must be an account id',
  },
  // prepareBatch (existing: 'update') — нарушение: id занят объектом другого класса (was)
  'write.load_other_class': {
    code: 'exists',
    ru: 'объект с этим id уже есть в классе {was}: строка класса {cls} его не правит',
    en: 'an object with this id already exists in class {was}: a row of class {cls} does not update it',
  },
  // flushBatch ({ as }) — нарушение: условие ACL запрещает строку
  'write.load_acl_row': {
    code: 'acl_denied',
    ru: 'строку запрещает условие ACL',
    en: 'an ACL condition forbids the row',
  },
  // flushBatch ({ as }, existing: 'update'): условие ACL запрещает правку — прежние или новые значения
  'write.load_acl_update': {
    code: 'acl_denied',
    ru: 'правку строки запрещает условие ACL',
    en: 'an ACL condition forbids updating the row',
  },
  // historyWrite — нарушение: $rev версий объекта не подряд от 1 или $at не строка
  'write.load_history_versions': {
    code: 'invalid_data',
    ru: 'режим истории: версии с $rev подряд от 1 и $at — время версии',
    en: 'history mode: versions need $rev consecutive from 1 and $at, the time of the version',
  },
  // initialSession: в схеме есть строки, кроме системных классов и записей reset
  'write.load_not_empty': {
    code: 'not_empty',
    ru: 'первая заливка — только в пустую схему: в entity и log, кроме строк системных классов (Class, Account, member, Resource, rule) и записей reset, ничего быть не должно',
    en: 'the initial load goes only into an empty schema: entity and log must hold nothing except rows of system classes (Class, Account, member, Resource, rule) and reset records',
  },
} satisfies Section<'write'>;
