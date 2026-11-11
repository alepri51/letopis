/**
 * Раздел api: core.ts, house.ts, chain.ts, typed.ts, errors.ts, internal.ts — подключение, консьерж и корень квартиры,
 * фасад, цепочки, батч, ошибки.
 */
import type { Section } from './types.js';

export const api = {
  // errors.ts, ValidationError: данные не проходят проверку на TypeScript (из базы — sql-write.invalid_data)
  'api.validation_failed': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // chain.ts: шаг цепочки — не класс, не алиас и не роль реестра сессии; похожие имена — params.similar: классы и роли
  // как есть, методы и свойства корня — me.invite(), me.keys (у первого шага), методы цепочки — .rows() (дальше)
  'api.unknown_step': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
    hint: 'классы видны в корне квартиры: жильцу — db.open(ключ), консьержу — db.in(квартира); имя — как в модели (общие классы дома записывает setup({ models }) или letopis sync, классы квартиры — syncModels в её корне); если это не класс, а метод — опечатка в его имени: методы корня — me.invite(), me.changeName(), me.acl, методы цепочки — .rows(), .first(), .create() (похожие названы в тексте)',
  },
  // core.ts: ключ консьержа из пропуска не даёт сессии (пропуск заменил setup({ rotate: true }), ключ отозван или
  // неверен)
  'api.token_not_active': {
    code: 'no_session',
    ru: 'нет действующей сессии: токен погашен, истёк или неверен',
    hint: 'пропуск устарел — взять новый из ответа setup() (после setup({ rotate: true }) старый не действует); жильцу — войти заново: db.open(ключ)',
  },
  // chain.ts, unknownName(): в реестре одни системные классы движка — в доме нет ни моделей, ни классов квартиры
  'api.unknown_step_no_classes': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены: в доме ещё нет ни одного класса',
    hint: 'записать модели дома — setup(ADMIN_DSN, имя, { models }) или letopis sync; классы только этой квартиры — syncModels в её корне; если вы вызывали не класс, а метод корня квартиры (me.invite(), me.changeName(), me.acl) — опечатка в его имени: похожие названы в тексте',
  },
  // chain.ts: у цепочки спросили свойство массива (length, map, filter, 0 …) или перебрали её — она не массив строк
  'api.chain_not_rows': {
    code: 'invalid_query',
    ru: 'цепочка — не массив: {name} есть у строк ответа, а не у цепочки',
    hint: 'получить строки терминалом с await: const rows = await me.Класс(…).rows(), одну строку — await ….first()',
  },
  // chain.ts: у цепочки с глаголом записи спросили свойство массива (length, map, toJSON — например, res.json(цепочка))
  // — глагол только поставлен в план и не выполнен; verb — глагол, name — свойство
  'api.verb_not_run': {
    code: 'invalid_query',
    ru: '{verb}() ещё не выполнен: глагол записи только ставит операцию в план, её выполняет терминал — .rows(), .first(), .ids() или .count() ({name} есть у строк ответа, а не у цепочки)',
    hint: 'завершить цепочку терминалом с await: const rows = await me.Класс(id).update({ … }).rows() — без терминала в базу ничего не уходит, и await самой цепочки ничего не делает',
  },
  // chain.ts: шаг вызван с аргументом undefined — фильтра нет, шаг находит все строки класса (как без аргумента);
  // предупреждение (lwarn), один раз на имя шага
  'api.step_undefined_filter': {
    code: 'invalid_query',
    ru: '{name}(undefined) — фильтра нет: шаг находит все строки, как {name}(). Проверьте переменную с id',
  },
  // chain.ts: шаг после sort() — сортировка относится к последнему шагу цепочки, а не к тому, после которого
  // стоит; предупреждение (lwarn), один раз на пару
  'api.sort_not_last': {
    code: 'invalid_query',
    ru: "sort('{field}') перед шагом {step} сортирует строки последнего шага ({step}), а не прежнего: ставьте sort() в конец цепочки",
  },
  // chain.ts: withDeleted() не у последнего шага, а у последнего — нет; предупреждение (lwarn), один раз на пару:
  // withDeleted() — модификатор своего шага
  'api.with_deleted_step': {
    code: 'invalid_query',
    ru: 'withDeleted() у шага {step} относится к нему, а не к последнему шагу {last}: удалённые {last} — .{last}().withDeleted()',
  },
  // errors.ts, fromDbError: подстраховка — значение не того типа (SQLSTATE 22P02), которое не поймала проверка до
  // запроса; text — текст сервера
  'api.db_bad_value': {
    code: 'invalid_query',
    ru: 'база не приняла значение: оно не того типа, что поле или параметр запроса (ответ PostgreSQL: {text})',
    hint: 'передавайте id строкой uuid, числа — числами, даты — строками ISO 8601; проверьте значения фильтра, курсора, опций и параметров me.sql и повторите запрос',
  },
  // errors.ts, ValidationError: первое нарушение в тексте ошибки — путь и сообщение; текст не для ошибки (lmsg)
  'api.validation_issue': {
    code: 'invalid_data',
    ru: '{path} — {issue}',
  },
  // errors.ts, ValidationError: путь нарушения на верхнем уровне данных (пустой путь); текст не для ошибки (lmsg)
  'api.validation_root': {
    code: 'invalid_data',
    ru: 'данные',
  },
  // errors.ts, ValidationError: число нарушений, если их больше одного; текст не для ошибки (lmsg)
  'api.validation_more': {
    code: 'invalid_data',
    ru: ' (всего нарушений: {n}, все — err.issues)',
  },
  // core.ts: схема дома из пропуска (у CLI — --schema) не вида v<N>.<имя>
  'api.connect_schema': {
    code: 'invalid_data',
    ru: 'connect: схема {schema} — нужно v<N>.<имя>',
    hint: 'дом — схема v2.<имя>, как его назвал setup(ADMIN_DSN, имя): например, v2.salon; пропуск передавать целиком, как его вернул setup()',
  },
  // errors.ts, checkOptions: неизвестная опция setup(), demolish(), connect(), load(), watch(), begin(), createMcpServer(),
  // invite(), accept(), requestCode() и глаголов записи create(), update(), upsert(), delete(), restore()
  'api.unknown_option': {
    code: 'invalid_data',
    ru: 'неизвестная опция {where}({ {name} })',
    hint: 'проверить имя опции: похожие названы в тексте, все опции — в README, «Справочник API»; у глаголов записи: create и upsert — reason; update — rev, all, reason; delete — confirm, expect, all, reason; restore — expect, partial, all, reason (владелец новой строки — шаг .owner(аккаунт) перед create())',
  },
  // errors.ts, fromDbError: новые значения строки не проходят условие ACL (политика RLS WITH CHECK) — запись сырым SQL
  // (me.sql, me.transaction); у цепочек — write.row_check_denied с классом и глаголом
  'api.row_check_denied': {
    code: 'acl_denied',
    ru: 'новые значения строки запрещают правила доступа',
    hint: "нет правила на запись класса этой строки для ваших ролей — me.acl.grant({ role, write: 'Класс' }) — или у правила условие, которому новая строка не подходит; проверить заранее — me.acl.checkData('Класс', 'WRITE')",
  },
  // chain.ts, warnNoHistory: versions(), asOf() у класса без журнала — предупреждение (lwarn), один раз
  // на класс и метод; код записи не печатается
  'api.no_history': {
    code: 'invalid_query',
    ru: '.{method}() у класса {cls} без журнала (history: false) — истории нет',
  },
  // chain.ts, report: медленный запрос без хука onQuery — предупреждение (lwarn); ms — целое, classes — классы шагов через →
  'api.slow_query': {
    code: 'invalid_query',
    ru: 'медленный запрос {ms} мс — {mode} {classes}',
  },
  // chain.ts: терминал у цепочки батча с глаголами
  'api.batch_queued': {
    code: 'invalid_query',
    ru: 'план стоит в очереди батча — его исполнит batch.run()',
  },
  // chain.ts, afterVerbError: модификатор выборки сразу после глагола перед rows, first, ids, count, paths (и в batch.run())
  'api.mod_after_verb': {
    code: 'invalid_query',
    ru: '{name}() после {verb}() ни на что не действует: глагол проходит по всем целям шага, а ответ — его строки. Цели сужают limit(), offset() и sort() до глагола: me.Класс(…).limit(n).{verb}(…)',
  },
  // chain.ts, afterNotPaged: after() перед count() или агрегатом чтения (sum, avg, min, max, countBy) — отказ: курсор
  // там не учитывается; fn — имя терминала
  'api.after_not_paged': {
    code: 'invalid_query',
    ru: '{fn}() не листается: after() сдвигает начало страницы rows(), ids(), versions() и paths(), а {fn}() считает по всем объектам шага',
    hint: 'убрать after() перед счётом и агрегатом; сузить то, что считается, — фильтром шага',
  },
  // chain.ts, lockedRead: forUpdate() вне me.begin()
  'api.for_update_outside_tx': {
    code: 'tx_required',
    ru: 'forUpdate() — только внутри me.begin(): вне явной транзакции блокировка снялась бы сразу',
  },
  // chain.ts, lockedRead: forUpdate() с другим терминалом, агрегатом, срезом, глаголом
  // chain.ts, lockedRead: what — что мешает блокировке (терминал, asOf(), withDeleted(), deep(), глагол)
  'api.for_update_unsupported': {
    code: 'lock_unsupported',
    ru: 'forUpdate() нельзя с {what}: блокировка — только у чтения rows(), first(), ids()',
    hint: 'forUpdate() — в me.begin(), перед rows(), first() или ids(); без asOf(), versions(), withDeleted(), deep(), count(), paths(), агрегатов и глаголов. Правка — отдельной цепочкой после чтения: await tr.X(id).forUpdate().first(); await tr.X(id).update(…).rows()',
  },
  // chain.ts, lockedRead: строки видны, но политика правки не даёт их заблокировать; ids — через запятую (detail.ids — списком)
  'api.lock_denied': {
    code: 'acl_denied',
    ru: 'строки видны, но заблокировать их нельзя: {ids}',
  },
  // chain.ts, slotValue: значение .Роль.set(…), .add(…), .remove(…)
  'api.slot_value': {
    code: 'invalid_query',
    ru: 'значение шага роли (.Роль.set(), .add(), .remove()) — id, список id, строка ответа или цепочка',
  },
  // chain.ts: слот не сразу после create(), update() или upsert(); name — роль, как вызвана, op — set, unset, add, remove
  'api.slot_without_write': {
    code: 'invalid_query',
    ru: 'шаг роли .{name}.{op}() — после create(), update() или upsert(): me.Класс(…).update(…).{name}.{op}(…)',
  },
  // chain.ts: add() или remove() у одиночного конца
  'api.slot_single': {
    code: 'invalid_query',
    ru: 'шаг роли .{name}.{op}(): конец {role} одиночный — set() или unset()',
  },
  // chain.ts: unset() у обязательного конца
  'api.slot_required': {
    code: 'invalid_query',
    ru: 'шаг роли .{name}.unset(): конец {role} обязателен',
  },
  // chain.ts: set() или unset() одного конца дважды в одной записи
  'api.slot_twice': {
    code: 'invalid_query',
    ru: 'конец {role} задан дважды в одной записи',
  },
  // chain.ts, withLast: deep(), exact(), alias(), tags(), owner() сразу после глагола; verb — глагол
  'api.step_mod_after_verb': {
    code: 'invalid_query',
    ru: 'модификатор шага после {verb}() — сначала шаг класса',
  },
  // chain.ts, withOp: глагол без шага класса
  'api.verb_without_step': {
    code: 'invalid_query',
    ru: '{verb}() — нужен шаг класса: me.Класс(…).{verb}(…)',
  },
  // chain.ts, entity(): цепочка с глаголами
  'api.entity_with_verbs': {
    code: 'invalid_query',
    ru: 'entity() принимает читающий паттерн — цепочку с глаголами вклеить нельзя',
  },
  // chain.ts, entity(): не цепочка и не строка ответа
  'api.entity_arg': {
    code: 'invalid_query',
    ru: 'entity() принимает ленивую цепочку или строку ответа',
  },
  // chain.ts: set, unset, add, remove у цепочки, а не у слота роли; method — имя метода
  'api.slot_method': {
    code: 'invalid_query',
    ru: '{method}() — метод шага роли после глагола: me.Класс(…).update(…).Роль.{method}(…)',
  },
  // chain.ts: cache({ ttl })
  'api.cache_ttl': {
    code: 'invalid_query',
    ru: 'cache({ ttl }): срок — положительное число секунд',
  },
  // chain.ts, sortArgs: после поля sort() стоит не направление ('DESC', -1, null) или лишний аргумент (второе поле);
  // call — вызов с аргументами, как их печатает shown()
  'api.sort_args': {
    code: 'invalid_query',
    ru: "{call}: после поля — только направление 'asc' или 'desc' (true — по убыванию)",
    hint: "поле сортировки одно: sort('data.поле') — по возрастанию, sort('data.поле', 'desc') — по убыванию; повторный sort() заменяет прежний",
  },
  // errors.ts, noExtraArgs: лишний аргумент метода цепочки или корня квартиры — отказ, а не молчаливый пропуск; call —
  // форма вызова, как её пишут (limit(n), withDeleted(), me.deleteAccount()), value — лишний аргумент, как его печатает
  // shown()
  'api.extra_arg': {
    code: 'invalid_query',
    ru: '{call}: лишний аргумент {value}',
  },
  // errors.ts, badArg: аргумент метода цепочки или корня квартиры не того типа (limit(null), asOf(5), alias(5),
  // cache(5), create(данные, 'причина'), me.lock(), me.commit('x')); call — форма вызова, value — аргумент, как его
  // печатает shown(), expect — текст записи api.arg_expect_* (lmsg)
  'api.bad_arg': {
    code: 'invalid_query',
    ru: '{call}: аргумент {value} не подходит — ожидалось: {expect}',
  },
  // что ожидалось на месте аргумента — параметр expect записи api.bad_arg; тексты не для ошибки (lmsg)
  // limit(n), offset(n)
  'api.arg_expect_int0': {
    code: 'invalid_query',
    ru: 'целое число от 0',
  },
  // deep(max)
  'api.arg_expect_int1': {
    code: 'invalid_query',
    ru: 'целое число от 1',
  },
  // asOf(t)
  'api.arg_expect_moment': {
    code: 'invalid_query',
    ru: 'Date или строка ISO 8601 вида 2026-10-07 или 2026-10-07T10:00:00Z',
  },
  // alias(name), me.batch(name)
  'api.arg_expect_name': {
    code: 'invalid_query',
    ru: 'непустая строка',
  },
  // опции вызова: count({ paths }), cache({ ttl }), глаголы записи, me.batch(), me.watch(), me.invite(),
  // me.refreshSession()
  'api.arg_expect_options': {
    code: 'invalid_query',
    ru: 'объект опций',
  },
  // опция-флаг: count({ paths }), delete({ confirm }), update и delete({ all }), restore({ partial, all })
  'api.arg_expect_boolean': {
    code: 'invalid_query',
    ru: 'true или false',
  },
  // me.lock(...keys)
  'api.arg_expect_lock_keys': {
    code: 'invalid_query',
    ru: 'ключи блокировки — строки или числа, хотя бы один',
  },
  // me.commit(tr), me.rollback(tr)
  'api.arg_expect_tx': {
    code: 'invalid_query',
    ru: 'транзакция из me.begin()',
  },
  // me.transaction(fn)
  'api.arg_expect_function': {
    code: 'invalid_query',
    ru: 'функция',
  },
  // me.sql вызван не шаблоном: me.sql('select …')
  'api.arg_expect_template': {
    code: 'invalid_query',
    ru: 'шаблон с параметрами: me.sql`select … where id = ${значение}`',
  },
  // me.watch({ classes })
  'api.arg_expect_classes': {
    code: 'invalid_query',
    ru: 'список имён классов',
  },

  // core.ts, noTx: lock(), commit(), rollback() вне me.begin(); what — вызов
  'api.tx_only': {
    code: 'tx_required',
    ru: '{what} — только внутри me.begin()',
  },
  // core.ts: idOf() у подключения без квартиры
  'api.id_of_no_tenant': {
    code: 'no_session',
    ru: 'idOf: у подключения нет квартиры',
  },
  // core.ts: me.begin(аргумент) — не объект опций (функция, строка, число); функцию begin() не вызывает; type — typeof
  // аргумента (array — массив)
  'api.begin_arg': {
    code: 'invalid_query',
    ru: 'me.begin() принимает только объект опций с полем reason или ничего; передано значение типа {type}. Функцию begin() не вызывает: транзакцию открывает begin(), закрывают commit() и rollback()',
    hint: 'откройте транзакцию без функции и закройте её сами: const tr = await me.begin(); try { …запросы через tr…; await tr.commit() } catch (e) { await tr.rollback(); throw e }',
  },
  // core.ts: вызов цепочки или метода после close() консьержа или служебного подключения CLI — и у корней квартир,
  // их begin() и цепочек на этом пуле
  'api.closed': {
    code: 'invalid_query',
    ru: 'подключение закрыто (close()) — откройте новое: connect(пропуск)',
    hint: 'close() консьержа — в конце работы процесса: после него корни квартир (open, resume, in, as), их цепочки и begin() не работают — для новой работы const db = await connect(пропуск)',
  },
  // core.ts: me.begin() внутри me.begin()
  'api.nested_begin': {
    code: 'invalid_query',
    ru: 'вложенных транзакций нет: me.begin() внутри me.begin()',
  },
  // core.ts: load() внутри me.begin()
  'api.load_in_tx': {
    code: 'invalid_query',
    ru: 'load() — своей транзакцией, не внутри me.begin()',
  },
  // core.ts, openDb: нет строки подключения (dsn) и готового пула (sql)
  'api.connect_no_dsn': {
    code: 'invalid_data',
    ru: 'connect: нет строки подключения',
    hint: 'передать пропуск целиком, как его вернул setup(); в CLI — --dsn <мастер-ключ>',
  },
  // core.ts, openDb: ключ консьержа из пропуска пуст (пробелы); name — опция ключа, value — как передан
  'api.connect_empty_credential': {
    code: 'invalid_data',
    ru: 'connect: ключ консьержа ({name}) пуст ({value}) — подключение без сессии не открывается',
    hint: 'передать пропуск целиком, как его вернул setup() (в нём непустой letopis_key); новый пропуск — setup(ADMIN_DSN, имя, { rotate: true })',
  },
  // core.ts, openDb: роли владельца в базе нет — дом в этой базе не строили
  'api.connect_no_owner': {
    code: 'invalid_data',
    ru: 'connect: роли владельца {owner} в базе нет — дом здесь не построен',
    hint: 'построить дом setup(ADMIN_DSN, имя) и подключаться пропуском из его ответа',
  },
  // core.ts, openDb: роль подключения обходит RLS, а обход не разрешён (пропуск консьержа, кроме PGlite)
  'api.connect_bypass_rls': {
    code: 'bypass_rls',
    ru: 'роль подключения обходит RLS (суперпользователь, BYPASSRLS или входит в роль-владельца) — консьерж так не подключается',
    hint: 'подключаться пропуском из ответа setup() без правки: в нём роль консьержа letopis_c_<имя>, она RLS не обходит',
  },
  // core.ts, openDb: подключение в обход RLS (служебное подключение CLI мастер-ключом, пропуск PGlite) — предупреждение
  // (lwarn)
  'api.admin_connection': {
    code: 'bypass_rls',
    ru: 'подключение в обход RLS — права не проверяются, видны данные всех квартир',
  },
  // core.ts, openDb: схемы дома нет
  'api.connect_no_schema': {
    code: 'invalid_data',
    ru: 'connect: дома {schema} нет — постройте его: setup(ADMIN_DSN, имя)',
    hint: 'построить дом setup(ADMIN_DSN, имя) и подключаться пропуском из его ответа; дом, снесённый demolish(), пропуск не открывает',
  },
  // core.ts, openDb: ревизия движка схемы новее библиотеки — предупреждение (lwarn); known — DDL_REVISION
  'api.schema_newer': {
    code: 'invalid_data',
    ru: 'движок схемы {schema} ревизии {rev} новее библиотеки (она знает {known}) — обновите пакет letopis',
  },
  // chain.ts, versions(): у результата versions() вызвали метод цепочки (rows, first, sort…); method — его имя
  'api.versions_terminal': {
    code: 'invalid_query',
    ru: 'versions() — терминал: отдаёт строки версий, у результата нет .{method}()',
    hint: "const v = await me.Класс(id).versions(); модификаторы — до versions(): me.Класс(id).sort('at', 'desc').limit(10).versions()",
  },
  // house.ts, open(): ключ не подошёл (в том числе пароль открывает не ту квартиру, что названа в tenant) — причина не
  // раскрывается
  'api.auth_failed': {
    code: 'auth_failed',
    ru: 'ключ не подошёл',
  },
  // house.ts, resume(): токен сессии не действует — сессия погашена (выход, выписка, смена пароля), истекла или токен
  // неверен
  'api.session_closed': {
    code: 'auth_failed',
    ru: 'сессия закрыта или истекла',
    hint: 'войти заново: db.open(ключ) — и сохранить новый токен me.token',
  },
  // house.ts, invitation(), accept(): токена приглашения нет в базе
  'api.invite_unknown': {
    code: 'auth_failed',
    ru: 'приглашение не найдено: ссылка неверна или давно истекла',
    hint: 'попросить новое приглашение: me.invite(контакт, роли)',
  },
  // house.ts, accept(): приглашение найдено, но не действует; status — expired, revoked или used
  'api.invite_inactive': {
    code: 'auth_failed',
    ru: 'приглашение не действует: {status}',
    hint: 'expired — истёк срок, revoked — отменено или заменено новым, used — уже принято; попросить новое приглашение',
  },
  // house.ts, accept(): звавший больше не прописан или матрица больше не разрешает ему роли приглашения — оно погашено
  'api.invite_lost': {
    code: 'acl_denied',
    ru: 'приглашение погашено: звавший больше не вправе выдать его роли',
    hint: 'попросить новое приглашение у того, кто вправе выдать эти роли',
  },
  // house.ts, accept(): пятая неудачная попытка принять приглашение (пароль повторял пароль другой квартиры)
  'api.invite_attempts': {
    code: 'auth_failed',
    ru: 'приглашение погашено: пять неудачных попыток принять его',
    hint: 'попросить новое приглашение',
  },
  // house.ts, accept(), keys.setPassword(): такой пароль уже открывает другую квартиру этого аккаунта (с паролями
  // других аккаунтов новый пароль не сверяется)
  'api.password_reused': {
    code: 'invalid_data',
    ru: 'такой пароль уже открывает другую квартиру: у каждой квартиры свой пароль',
    hint: 'задать для этой квартиры другой пароль; в accept пароль можно не задавать вовсе и входить кодом (db.requestCode)',
  },
  // house.ts, tenantsOf(), open({ контакт, code }), changeContact(контакт + code): код из письма не подошёл или истёк
  // (у open — и когда аккаунт не прописан в названной квартире)
  'api.code_failed': {
    code: 'auth_failed',
    ru: 'код не подошёл или истёк',
    hint: 'запросить новый код: db.requestCode(контакт) или me.changeContact(контакт); пять неверных вводов гасят код',
  },
  // house.ts, open({ контакт, code }): код верен, у аккаунта несколько квартир, а tenant не задан; detail.tenants —
  // [{ id, name }]
  'api.tenant_required': {
    code: 'tenant_required',
    ru: 'у аккаунта несколько квартир: укажите, в какую войти',
    hint: 'повторить db.open({ …контакт, code, tenant }) с квартирой из err.detail.tenants (или из db.tenantsOf)',
  },
  // house.ts, Room: метод только жильца (keys, changeContact, leave, deleteAccount, closeAll); changeName — у жильца и
  // у корня db.as, отказ только у db.in
  'api.resident_only': {
    code: 'invalid_query',
    ru: '{method}() — только у жильца, вошедшего ключом (db.open, db.resume): у консьержа в квартире его нет',
    hint: 'войти ключом жильца: const me = await db.open(ключ) — или db.resume(токен); сменить имя от лица человека может и приложение — корень db.as(аккаунт, квартира)',
  },
  // house.ts, in(), as(), open({ tenant }); cli.ts, load --tenant: квартира не найдена
  'api.tenant_unknown': {
    code: 'target_not_found',
    ru: 'квартиры «{tenant}» нет',
    hint: 'список квартир — db.tenants(); завести — db.createTenant(имя)',
  },
  // house.ts, open(), accept(), keys.setPassword(), keys.link(): форма ключа не распознана
  'api.key_form': {
    code: 'invalid_data',
    ru: 'ключ: { email | phone | telegram, password, tenant? }, { email | phone | telegram, code, tenant? }, { apiKey }, { key, secret } или { external: { kind, identifier } }',
    hint: "пароль и код идут вместе с контактом аккаунта: db.open({ phone: '+7…', password: '…' }); у keys.setPassword — { password }, у keys.link — { kind, identifier }",
  },
  // house.ts, invite(), requestCode(), tenantsOf(), changeContact(): контакт не распознан
  'api.contact_form': {
    code: 'invalid_data',
    ru: 'контакт: { email }, { phone }, { telegram } или { kind, address }',
    hint: "передать ровно одну форму контакта: me.invite({ email: 'a@b.ru' }, ['staff'])",
  },
  // house.ts, invite(), requestCode(), changeContact(): почтальон не задан — письмо некому доставить
  'api.no_postman': {
    code: 'no_postman',
    ru: 'письма доставляет почтальон: задайте его при подключении — connect(pass, { postman })',
    hint: 'connect(pass, { postman: async ({ to, message }) => { /* отправить на to.address: message.token или message.code */ } })',
  },
  // house.ts, invite(), requestCode(), changeContact(): почтальон бросил ошибку — запись отменена; kind — вид письма
  'api.postman_failed': {
    code: 'postman_failed',
    ru: 'почтальон не доставил письмо ({kind}): ничего не записано, исходная ошибка — в cause',
    hint: 'исправить причину по err.cause и повторить вызов',
  },
  // house.ts, deleteAccount(account), contactOf(account): аккаунт — не id (uuid); method — имя метода
  'api.account_form': {
    code: 'invalid_data',
    ru: '{method}(аккаунт): аккаунт — id аккаунта жильца (uuid), например me.account',
  },
  // core.ts, makeDb: свойство корня квартиры (invite, keys, leave…) у begin() или служебного подключения
  'api.room_only': {
    code: 'invalid_query',
    ru: '{name} — свойство корня квартиры (db.open, db.in), а не транзакции begin(): вызовите его у корня',
  },
  // house.ts, open(): ключ верен, у жильца в квартире включён TOTP, а код не передан
  'api.totp_required': {
    code: 'auth_failed',
    ru: 'нужен второй фактор: код из приложения-аутентификатора',
    hint: 'повторить db.open с тем же ключом и { totp: код из приложения }',
  },
} satisfies Section<'api'>;
