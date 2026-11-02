/**
 * Раздел write: write.ts, tx.ts, load.ts — планы записи, транзакции, батч, загрузчик.
 */
import type { Section } from './types.js';

export const write = {
  // write.ts — write.ts:checkReason: причина изменения (reason у глаголов, db.begin(), батча)
  'write.bad_reason': {
    code: 'invalid_query',
    ru: '{where}: reason — строка до 1000 символов',
  },
  // данные create(), upsert(), rekey(): inc() внутри массива
  'write.inc_in_array': {
    code: 'invalid_data',
    ru: 'inc() внутри массива ({path}) не поддерживается',
  },
  // данные: оператор фильтра внутри вложенного значения
  'write.op_in_data': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных ({path}) — данные записываются значениями',
  },
  // патч update(): величина inc(by)
  'write.inc_by_not_finite': {
    code: 'invalid_data',
    ru: 'inc({by}) по пути {path}: величина — конечное число',
  },
  // патч update(): inc(by, { start })
  'write.inc_start_not_finite': {
    code: 'invalid_data',
    ru: 'inc: start по пути {path} — конечное число',
  },
  // патч update(): оператор фильтра вместо значения
  'write.op_in_patch': {
    code: 'invalid_data',
    ru: 'оператор фильтра в патче ({path}) — update записывает значения',
  },
  // данные create(), upsert(), rekey() — не объект
  'write.data_not_object': {
    code: 'invalid_data',
    ru: '{verb}(): данные — объект',
  },
  // inc() в данных глагола, кроме update()
  'write.inc_outside_update': {
    code: 'invalid_data',
    ru: 'inc() работает только в update(): {verb}() по пути {path}',
  },
  // оператор фильтра на верхнем уровне данных глагола
  'write.op_in_verb_data': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных {verb}() ({path}) — данные записываются значениями',
  },
  // агрегатные поля в данных create() и upsert(); fields — список через запятую
  'write.aggregate_given': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — их не передают',
  },
  // агрегатные поля в патче update()
  'write.aggregate_patched': {
    code: 'aggregate_field',
    ru: 'поля {fields} класса {cls} считает база (aggregate) — update их не меняет',
  },
  // глагол после asOf()
  'write.as_of_write': {
    code: 'invalid_query',
    ru: '{verb}(): asOf описывает прошлое — записывать в него нельзя',
  },
  // глагол после withDeleted(), кроме restore() и purge()
  'write.with_deleted_write': {
    code: 'invalid_query',
    ru: '{verb}(): withDeleted описывает удалённые — записывать в них нельзя',
  },
  // create() или upsert() сразу после другого глагола; prev — прежний глагол
  'write.verb_after_verb': {
    code: 'invalid_query',
    ru: '{verb}() сразу после {prev}() — между глаголами нужен шаг',
  },
  // create() или upsert() на возврате к узлу пути
  'write.create_on_pivot': {
    code: 'invalid_query',
    ru: '{verb}() на возврате к узлу — он ведёт к существующей сущности, используйте update()',
  },
  // create() или upsert() после шага с фильтром, а не с id
  'write.create_with_filter': {
    code: 'invalid_query',
    ru: '{verb}() не ищет: {step}(id).{verb}(…) задаёт id, поиск — это update()',
  },
  // upsert() у класса без ключа
  'write.upsert_no_key': {
    code: 'no_key',
    ru: 'upsert(): у класса {cls} нет ключа — сравнивать не с чем, используйте create()',
  },
  // .tags() перед create() или upsert() — не строка и не список
  'write.bad_tags': {
    code: 'invalid_query',
    ru: '.tags() перед {verb}() — строка или список',
  },
  // патч update() — не объект
  'write.patch_not_object': {
    code: 'invalid_data',
    ru: 'update(): патч — объект',
  },
  // update(patch, { rev }) — rev не номер версии
  'write.bad_rev': {
    code: 'invalid_query',
    ru: 'update(patch, { rev }): rev — номер версии строки',
  },
  // write.ts:precheckPlan — update() или delete({ confirm: true }), а ни у одного шага до глагола нет фильтра, id,
  // tags(), owner() или limit() (план 2.0, этап 4, п. 2; 7.10 №2); call — сам вызов, cls — класс шага глагола
  'write.no_filter': {
    code: 'invalid_query',
    ru: '{call} без фильтра ({cls}): ни у одного шага нет фильтра, id или limit() — правка прошла бы по всем строкам',
    hint: 'сузить цели фильтром, id или limit(); правка всех строк — опция глагола { all: true }',
  },
  // anonymize() без полей
  'write.anonymize_no_fields': {
    code: 'invalid_query',
    ru: 'anonymize(поля): нужен список полей',
  },
  // anonymize(): поля нет в классе (план 2.0, 7.5 №3)
  'write.anonymize_unknown_field': {
    code: 'invalid_query',
    ru: 'anonymize(): поля {field} нет в классе {cls}',
  },
  // anonymize(): поле не строковое; type — тип листа
  'write.anonymize_not_text': {
    code: 'invalid_query',
    ru: 'anonymize() затирает только строковые поля; {field} — {type}',
  },
  // rekey() у класса без ключа
  'write.rekey_no_key': {
    code: 'no_key',
    ru: 'rekey(): у класса {cls} нет ключа — id выдаёт база, менять нечего',
  },
  // слот после глагола, который слотов не принимает
  'write.slot_bad_verb': {
    code: 'invalid_query',
    ru: 'слот .{role} после {verb}() — слоты у create(), update() и upsert()',
  },
  // write.ts:slotRole: имя слота — не роль записываемого класса и не класс реестра
  'write.slot_unknown': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
  },
  // write.ts:slotRole: класс слота не принимает ни одна роль; ends — концы через запятую или «—»
  'write.slot_not_end': {
    code: 'invalid_query',
    ru: '{name} — не конец класса {cls} (концы: {ends})',
  },
  // write.ts:slotRole: класс слота принимают несколько ролей
  'write.slot_ambiguous': {
    code: 'invalid_query',
    ru: 'слот {name} у класса {cls} неоднозначен: роли {roles} — назовите роль',
  },
  // конец из пути: шаг подходит нескольким ролям
  'write.end_ambiguous': {
    code: 'invalid_query',
    ru: 'конец класса {cls} для шага {step} неоднозначен: роли {roles} — назовите шаг ролью или задайте слот',
  },
  // конец из пути: шаг дал не одну сущность; count — сколько найдено
  'write.end_not_single': {
    code: 'invalid_query',
    ru: 'шаг {step} должен дать ровно одну сущность для конца {cls} (найдено {count})',
  },
  // слот .роль.set() одиночного конца — значение дало несколько сущностей
  'write.slot_single_many': {
    code: 'invalid_query',
    ru: 'слот .{role}.set(): конец одиночный, а значение дало {count} сущностей',
  },
  // write.ts:existsError: create() — объект уже есть, id не вычислить
  'write.exists': {
    code: 'exists',
    ru: 'объект класса {cls} уже существует',
  },
  // write.ts:existsError: create() — объект уже есть, id известен
  'write.exists_id': {
    code: 'exists',
    ru: 'объект класса {cls} уже существует (id {id})',
  },
  // write.ts:explainMissing: одна цель не видна
  'write.target_missing': {
    code: 'target_not_found',
    ru: 'цель {id} не найдена',
  },
  // write.ts:explainMissing: несколько целей не видны; ids — через запятую
  'write.targets_missing': {
    code: 'target_not_found',
    ru: 'цели не найдены: {ids}',
  },
  // write.ts:explainMissing: update(patch, { rev }) — строку успели изменить
  'write.rev_conflict': {
    code: 'conflict',
    ru: 'строку {id} успели изменить: версия {rev}, а не {expected} — перечитайте и повторите',
  },
  // write.ts:explainMissing: строки видны, но RLS не дала их изменить; ids — через запятую
  'write.rows_denied': {
    code: 'acl_denied',
    ru: 'строки видны, но изменить их нельзя: {ids}',
  },
  // update(patch, { rev }): у шага больше одной цели; count — сколько
  'write.rev_many_targets': {
    code: 'rev_ambiguous',
    ru: 'update(patch, { rev }): у шага {step} {count} целей — проверить версию { rev } можно только у одной цели',
  },
  // update(patch, { rev }): у шага нет цели
  'write.rev_no_target': {
    code: 'target_not_found',
    ru: 'update(patch, { rev }): у шага {step} нет цели',
  },
  // restore() живого объекта
  'write.not_deleted': {
    code: 'not_deleted',
    ru: 'объект не удалён: {verb}() — только для удалённых',
  },
  // purge() живого объекта
  'write.not_deleted_purge': {
    code: 'not_deleted',
    ru: 'объект не удалён: purge() — только для удалённых, сначала delete()',
  },
  // rekey(): объект с новым ключом уже есть
  'write.rekey_exists': {
    code: 'exists',
    ru: 'rekey(): объект класса {cls} с таким ключом уже существует',
  },
  // tx.ts — tx.ts:commitUnknown: связь оборвалась во время commit
  'write.commit_unknown': {
    code: 'commit_unknown',
    ru: 'связь оборвалась во время commit: транзакция могла зафиксироваться — проверьте исход повтором той же операции с тем же ключом',
  },
  // tx.ts: запрос в завершённой транзакции db.begin()
  'write.tx_done': {
    code: 'tx_required',
    ru: 'транзакция db.begin() уже завершена',
    hint: 'транзакция уже зафиксирована или откатана — откройте новую: `const tr = await db.begin()`',
  },
  // tx.ts: lock() в завершённой транзакции db.begin()
  'write.lock_tx_done': {
    code: 'tx_required',
    ru: 'lock(): транзакция db.begin() уже завершена',
    hint: 'транзакция уже зафиксирована или откатана — откройте новую: `const tr = await db.begin()`',
  },
  // tx.ts: commit() транзакции, в которой была ошибка, — PostgreSQL её откатил
  'write.tx_rolled_back': {
    code: 'tx_rolled_back',
    ru: 'commit: PostgreSQL откатил транзакцию (в ней была ошибка)',
  },
  // load.ts — загрузчик db.load()
  // Issues.fail(): загрузка отменена, первое нарушение (message — его текст); код ошибки — код этого нарушения
  // (detail.rows[0].code), а не записи: место строит LetopisError с ключом, как fromDbError
  'write.load_cancelled': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message}',
  },
  // Issues.fail(): … и ещё rest нарушений, проверены все строки
  'write.load_cancelled_more': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (и ещё {rest})',
  },
  // Issues.fail(): … проверены не все строки (why — причины через точку с запятой), нарушений не меньше rest + 1
  'write.load_cancelled_at_least': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (и ещё не меньше {rest}: {why})',
  },
  // Issues.fail(): … нарушение одно, но проверены не все строки
  'write.load_cancelled_maybe_more': {
    code: 'invalid_data',
    ru: 'загрузка отменена: строка {line} — {message} (возможно, не единственная: {why})',
  },
  // причина в why текста отмены (laterUnchecked): порция commitEvery не последняя
  'write.load_later_portions': {
    code: 'invalid_data',
    ru: 'следующие порции не проверялись',
  },
  // причина в why (prepareBatch, { as }): условия ACL проверили пачку, а следующие пачки — нет
  'write.load_later_batches': {
    code: 'invalid_data',
    ru: 'условия ACL следующих пачек не проверялись',
  },
  // причина в why (prepareBatch, pipeline, historyWrite): нарушение нашлось раньше, чем база проверила pattern
  // (его валидатор на TypeScript оставляет базе) у строк, уже прошедших проверку в коде
  'write.load_db_rules_unchecked': {
    code: 'invalid_data',
    ru: 'шаблоны pattern (их проверяет база) проверены не у всех строк',
  },
  // причина в why (verifyIds, verify: true; checkInDb): проверка базы называет не больше limit строк
  'write.load_db_check_limit': {
    code: 'invalid_data',
    ru: 'проверка базы называет не больше {limit} строк',
  },
  // toList: вход db.load() — не объект «класс → строки», не массив и не поток
  'write.load_bad_input': {
    code: 'invalid_data',
    ru: 'load(): вход — объект «класс → строки», массив или поток строк с $class',
    hint: 'передать объект { Класс: [строки] }, массив строк с $class или их поток (Iterable, AsyncIterable); класс строк без $class — опция class',
  },
  // refOf — значение конца (текст — error нарушений write.load_end_ref и write.load_key_part_ref): строка, но не uuid
  'write.load_end_not_uuid': {
    code: 'invalid_data',
    ru: 'значение конца не uuid',
  },
  // refOf: не строка и не объект с $key или $ext
  'write.load_end_value': {
    code: 'invalid_data',
    ru: 'значение конца — id, { $key } или { $ext }',
  },
  // refOf: у полиморфного конца нет $class цели
  'write.load_end_polymorphic': {
    code: 'invalid_data',
    ru: 'полиморфный конец: укажите $class цели',
  },
  // refOf: класса цели нет в реестре или он абстрактный
  'write.load_target_class': {
    code: 'invalid_data',
    ru: 'класс цели {name} не найден или абстрактный',
  },
  // refOf: $key цели — не список строк по частям ключа (key — части через запятую)
  'write.load_target_key': {
    code: 'invalid_data',
    ru: '$key цели {cls} — список строк ключа [{key}]',
  },
  // refOf: $ext у цели класса с ключом
  'write.load_ext_keyed': {
    code: 'invalid_data',
    ru: '$ext — для класса без ключа, а у {cls} ключ [{key}]',
  },
  // refOf, idOfRow: $ext не строка
  'write.load_ext_string': {
    code: 'invalid_data',
    ru: '$ext — строка',
  },
  // shape — нарушение строки: значение конца со многими целями не массив
  'write.load_end_list': {
    code: 'invalid_data',
    ru: 'конец {role} — список целей',
  },
  // shape: значение конца не годится (error — текст refOf)
  'write.load_end_ref': {
    code: 'invalid_data',
    ru: 'конец {role}: {error}',
  },
  // shape: цель повторяется в списке конца
  'write.load_end_repeat': {
    code: 'invalid_data',
    ru: 'конец {role}: цель повторяется',
  },
  // shape: inc() в данных строки (path — путь к значению)
  'write.load_inc': {
    code: 'invalid_data',
    ru: 'inc() — только в update() ({path})',
  },
  // shape: оператор фильтра в данных строки (path — путь к значению)
  'write.load_filter_op': {
    code: 'invalid_data',
    ru: 'оператор фильтра в данных ({path})',
  },
  // shape: данные не проходят валидатор класса на TypeScript; нарушения — issues строки отчёта
  'write.load_invalid_data': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // shape: у конца со многими целями меньше min
  'write.load_end_too_few': {
    code: 'invalid_data',
    ru: 'у конца {role} слишком мало целей',
  },
  // shape: обязательный конец не задан
  'write.load_end_required': {
    code: 'invalid_data',
    ru: 'обязательный конец {role} не задан',
  },
  // shape: у конца со многими целями больше max
  'write.load_end_too_many': {
    code: 'invalid_data',
    ru: 'у конца {role} слишком много целей',
  },
  // idOfRow — нарушение строки: часть ключа — конец, а его значение не годится (error — текст refOf)
  'write.load_key_part_ref': {
    code: 'invalid_data',
    ru: 'часть ключа {part}: {error}',
  },
  // idOfRow: часть ключа — поле, а значение не строка
  'write.load_key_part_string': {
    code: 'invalid_data',
    ru: 'часть ключа {part} — строка',
  },
  // verifyIds (verify: true) — нарушение: строка не проходит проверку базы; нарушения — issues строки отчёта
  'write.load_db_invalid': {
    code: 'invalid_data',
    ru: 'проверка базы: строка {id} не проходит описание класса {cls}',
  },
  // verifyIds: конец ведёт на строку производного класса
  'write.load_db_derived': {
    code: 'derived_class',
    ru: 'проверка базы: конец {role} ведёт на строку производного класса',
  },
  // verifyIds: цели конца нет
  'write.load_db_target': {
    code: 'target_not_found',
    ru: 'проверка базы: цель конца {role} не найдена',
  },
  // load(), initialSession(): подключение не может стать владельцем схемы
  'write.load_admin_required': {
    code: 'admin_required',
    ru: 'загрузчику нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)',
  },
  // load({ as }): не uuid
  'write.load_as_not_uuid': {
    code: 'invalid_data',
    ru: 'load({ as }): id аккаунта',
    hint: 'передать в as id (uuid) аккаунта, от имени которого идёт загрузка',
  },
  // load({ as, withHistory })
  'write.load_as_history': {
    code: 'invalid_data',
    ru: 'load({ as }) и режим истории несовместимы: историю импортирует администратор',
    hint: 'историю (withHistory) загружать без as; от имени пользователя — загрузка без истории',
  },
  // load({ withHistory, existing: 'update' })
  'write.load_history_update': {
    code: 'invalid_data',
    ru: "режим истории: existing — 'error' или 'skip' (новую версию существующего объекта пишет загрузка без истории)",
    hint: "новые версии существующих объектов — отдельной загрузкой без withHistory с existing: 'update'",
  },
  // load({ initial, commitEvery })
  'write.load_initial_commit_every': {
    code: 'invalid_data',
    ru: 'первая заливка (initial) несовместима с commitEvery: снятые индексы и TRUNCATE требуют одной транзакции',
    hint: 'убрать commitEvery: первая заливка — всегда одна транзакция; порциями пишет загрузка без initial',
  },
  // load({ initial, existing }): existing не 'error'
  'write.load_initial_existing': {
    code: 'invalid_data',
    ru: "первая заливка (initial): existing — только 'error', в пустой схеме пропускать и обновлять нечего",
    hint: 'убрать existing; пропустить или обновить существующие объекты — загрузкой без initial',
  },
  // load({ initial, as })
  'write.load_initial_as': {
    code: 'invalid_data',
    ru: 'первая заливка (initial) — от администратора, без { as }',
    hint: 'убрать as; от имени пользователя — загрузка без initial',
  },
  // load(): нет ни { tenant }, ни { as }, ни арендатора сессии
  'write.load_no_tenant': {
    code: 'invalid_data',
    ru: 'load(): нет арендатора — сессия без арендатора и не задан { tenant }',
    hint: 'передать load(…, { tenant }) или загружать в сессии с арендатором',
  },
  // проход 1 — нарушение строки: класса $class нет в реестре
  'write.load_class_not_found': {
    code: 'invalid_class',
    ru: 'класс {name} не найден',
  },
  // проход 1: у строки нет $class (и нет опции class)
  'write.load_no_class': {
    code: 'invalid_class',
    ru: 'нет $class',
  },
  // проход 1: строка класса Class
  'write.load_class_rows': {
    code: 'class_not_loadable',
    ru: 'строки Class задают letopis sync и create — там база компилирует проверку',
  },
  // проход 1: класс абстрактный
  'write.load_class_abstract': {
    code: 'invalid_class',
    ru: 'класс {cls} абстрактный',
  },
  // проход 1: класс производный — его строки пишет только проектор
  'write.load_class_derived': {
    code: 'derived_class',
    ru: 'класс {cls} производный: его строки пишет проектор {projector}',
  },
  // проход 1, первая заливка: id занят строкой системного класса или прошлой загрузкой сессии
  'write.load_taken': {
    code: 'exists',
    ru: 'объект уже есть в схеме: строка системного класса или запись этой же первой заливки',
  },
  // проход 1: повтор id при duplicates: 'error' (prev — строка, где id был раньше)
  'write.load_duplicate': {
    code: 'duplicate',
    ru: 'id {id} уже был в строке {prev}',
  },
  // loadPortion ({ as }) — нарушение: у пользователя нет права WRITE на класс
  'write.load_no_write': {
    code: 'acl_denied',
    ru: 'нет права WRITE на класс {cls}',
  },
  // check, loadPortion, initialSession — нарушение: цели конца нет, она чужая, не того класса или не видна ({ as })
  'write.load_target_not_found': {
    code: 'target_not_found',
    ru: 'цель конца {role} не найдена',
  },
  // loadPortion, initialSession: цель вне загрузки — строка производного класса
  'write.load_target_derived': {
    code: 'derived_class',
    ru: 'цель конца {role} — строка производного класса {cls}',
  },
  // loadPortion, initialSession: владелец ($owner) — не аккаунт
  'write.load_owner_not_found': {
    code: 'target_not_found',
    ru: 'владелец {id} не найден',
  },
  // loadPortion, initialSession: арендатора нет или он отключён
  'write.load_tenant_denied': {
    code: 'tenant_denied',
    ru: 'арендатор {tenant} не найден или отключён',
  },
  // explainTaken (existing: 'error') — нарушение: id занят живым объектом
  'write.load_exists': {
    code: 'exists',
    ru: 'объект уже есть в базе',
  },
  // explainTaken: id занят удалённым объектом
  'write.load_deleted': {
    code: 'deleted',
    ru: 'объект с этим id жил раньше и удалён (existing: update воскресит)',
  },
  // explainTaken: первичный ключ отказал, а занятых id запрос не нашёл
  'write.load_objects_exist': {
    code: 'exists',
    ru: 'загрузка отменена: часть объектов уже есть в базе',
  },
  // check — нарушение строки: Account не в арендаторе System
  'write.load_account_tenant': {
    code: 'tenant_denied',
    ru: 'аккаунты лежат в арендаторе System',
  },
  // check: конец Tenant строки member — не арендатор строки
  'write.load_member_tenant': {
    code: 'invalid_data',
    ru: 'конец Tenant членства — арендатор строки',
  },
  // check: $tags — не список строк
  'write.load_tags': {
    code: 'invalid_data',
    ru: '$tags — список строк',
  },
  // check: $owner при { as }
  'write.load_as_owner': {
    code: 'invalid_data',
    ru: 'load({ as }): $owner не задаётся — владелец по ownerDefault класса',
  },
  // check: $owner не uuid
  'write.load_owner_id': {
    code: 'invalid_data',
    ru: '$owner — id аккаунта',
  },
  // prepareBatch (existing: 'update') — нарушение: id занят объектом другого класса (was)
  'write.load_other_class': {
    code: 'exists',
    ru: 'объект с этим id уже есть в классе {was}: строка класса {cls} его не правит',
  },
  // flushBatch ({ as }) — нарушение: условие ACL запрещает строку
  'write.load_acl_row': {
    code: 'acl_denied',
    ru: 'строку запрещает условие ACL',
  },
  // flushBatch ({ as }, existing: 'update'): условие ACL запрещает правку — прежние или новые значения
  'write.load_acl_update': {
    code: 'acl_denied',
    ru: 'правку строки запрещает условие ACL',
  },
  // historyWrite — нарушение: $rev версий объекта не подряд от 1 или $at не строка
  'write.load_history_versions': {
    code: 'invalid_data',
    ru: 'режим истории: версии с $rev подряд от 1 и $at — время версии',
  },
  // initialSession: в схеме есть строки, кроме системных классов и записей reset
  'write.load_not_empty': {
    code: 'not_empty',
    ru: 'первая заливка — только в пустую схему: в entity и log, кроме строк системных классов (Class, Account, member, Resource, rule) и записей reset, ничего быть не должно',
  },
  // load.ts: замена охранника load({ trust }) — removed(имя, ключ) рендерит её; контракт API берёт шаблон записи
  // (lib/scripts/contract.mjs)
  'write.replacement_load_trust': {
    code: 'removed',
    ru: 'запрос по целям вне загрузки стоит 0,1–1,3 % её времени — режим доверия убран (решение 2 точки А)',
  },
  // tx.ts, hintTxRetry: хвост к тексту взаимной блокировки или ошибки сериализации в явной транзакции (lmsg) — с
  // пробелом и тире в начале; называет db.begin(), поэтому второй раз не дописывается
  'write.tx_retry_hint': {
    code: 'invalid_query',
    ru: ' — откатите транзакцию и повторите весь блок db.begin()',
  },
} satisfies Section<'write'>;
