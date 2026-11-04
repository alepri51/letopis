/**
 * Раздел api: index.ts, chain.ts, typed.ts, errors.ts, internal.ts — подключение, фасад, цепочки, батч, ошибки.
 */
import type { Section } from './types.js';

export const api = {
  // errors.ts, ValidationError: данные не проходят проверку на TypeScript (из базы — sql-write.invalid_data)
  'api.validation_failed': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
  },
  // chain.ts: шаг цепочки — не класс, не алиас и не роль реестра сессии; похожие имена — params.similar
  'api.unknown_step': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
    hint: 'классы арендатора видны только в его сессии: арендаторы пользователя — db.auth.tenants(), переход — db.auth.switch(tenant) или db.as(аккаунт, { tenant }); имя — как в модели (классы записывает syncModels)',
  },
  // chain.ts: шаг не найден, а в реестре сессии нет ни одного класса, кроме классов System — сессия, похоже, в
  // личном арендаторе (вход без switch); похожие имена — params.similar
  // index.ts: connect({ token }) — токен не даёт сессии (погашен, истёк, неверен); chain.ts: шаг корня без сессии
  // (сессия погасла после connect) — отказ терминала, а не синхронный
  'api.token_not_active': {
    code: 'no_session',
    ru: 'нет действующей сессии: токен погашен, истёк или неверен',
    hint: 'войти заново и подключиться с новым токеном; веб-сервису — одно подключение сервиса и svc.as(account, { tenant }) на запрос, а не connect({ token }) на каждый вход',
  },
  'api.unknown_step_no_classes': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены: в реестре сессии нет ни одного класса арендатора — сессия, похоже, в личном арендаторе',
    hint: 'после входа сессия работает в личном арендаторе пользователя: найти нужного — db.auth.tenants(), перейти — db.auth.switch(tenant) или db.as(аккаунт, { tenant }); классы в арендатор записывает syncModels',
  },
  // chain.ts (3.0.1): шаг не найден, в реестре сессии только классы System, а арендатор сессии не личный — в нём просто
  // нет классов; похожие имена — params.similar
  'api.unknown_step_empty_tenant': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены: в этом арендаторе нет классов — вызовите syncModels в нём',
    hint: 'классы в арендатор записывает syncModels — в сессии этого арендатора (подключение арендатора или db.as(аккаунт, { tenant })); имя — как в модели',
  },
  // chain.ts: у цепочки спросили свойство массива (length, map, filter, 0 …) или перебрали её — она не массив строк
  'api.chain_not_rows': {
    code: 'invalid_query',
    ru: 'цепочка — не массив: {name} есть у строк ответа, а не у цепочки',
    hint: 'получить строки терминалом с await: const rows = await db.Класс(…).rows(), одну строку — await ….first()',
  },
  // chain.ts, A13: шаг вызван с аргументом undefined — фильтра нет, шаг находит все строки класса (как без аргумента);
  // предупреждение (lwarn), один раз на имя шага
  'api.step_undefined_filter': {
    code: 'invalid_query',
    ru: '{name}(undefined) — фильтра нет: шаг находит все строки, как {name}(). Проверьте переменную с id',
  },
  // chain.ts, A13: шаг после sort() — сортировка относится к последнему шагу цепочки, а не к тому, после которого
  // стоит; предупреждение (lwarn), один раз на пару
  'api.sort_not_last': {
    code: 'invalid_query',
    ru: "sort('{field}') перед шагом {step} сортирует строки последнего шага ({step}), а не прежнего: ставьте sort() в конец цепочки",
  },
  // chain.ts, A9: withDeleted() не у последнего шага, а у последнего — нет; предупреждение (lwarn), один раз на пару:
  // с 2.1 withDeleted() — модификатор своего шага
  'api.with_deleted_step': {
    code: 'invalid_query',
    ru: 'withDeleted() у шага {step} относится к нему, а не к последнему шагу {last}: удалённые {last} — .{last}().withDeleted()',
  },
  // errors.ts, fromDbError: подстраховка — значение не того типа (SQLSTATE 22P02), которое не поймала проверка до
  // запроса; text — текст сервера
  'api.db_bad_value': {
    code: 'invalid_query',
    ru: 'база не приняла значение: оно не того типа, что поле или параметр запроса (ответ PostgreSQL: {text})',
    hint: 'передавайте id строкой uuid, числа — числами, даты — строками ISO 8601; проверьте значения фильтра, курсора, опций и параметров db.sql и повторите запрос',
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
  // index.ts: connect({ schema })
  'api.connect_schema': {
    code: 'invalid_data',
    ru: 'connect: схема {schema} — нужно v<N>.<имя>',
    hint: 'имя схемы — v<N>.<имя>, как у up({ schema }): например, v2.salon',
  },
  // errors.ts, checkOptions: неизвестная опция connect(), up(), load(), watch(), createMcpServer() — в 1.5
  // было предупреждение, с 2.0 — ошибка (план 2.0, этап 4, п. 2; 7.10 №4)
  'api.unknown_option': {
    code: 'invalid_data',
    ru: 'неизвестная опция {where}({ {name} })',
    hint: 'проверить имя опции: похожие названы в тексте, все опции — в README, «Справочник API»',
  },
  // errors.ts, fromDbError: новые значения строки не проходят условие ACL (политика RLS WITH CHECK)
  'api.row_check_denied': {
    code: 'acl_denied',
    ru: 'новые значения строки запрещают правила доступа',
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
    ru: '{name}() после {verb}() ни на что не действует: глагол проходит по всем целям шага, а ответ — его строки. Цели сужают limit(), offset() и sort() до глагола: db.Класс(…).limit(n).{verb}(…)',
  },
  // chain.ts, afterNotPaged: after() перед count() или агрегатом чтения (sum, avg, min, max, countBy) — с 2.0 отказ, в 1.x
  // курсор там молча не учитывался (план 2.0, этап 4, п. 2; 7.10 №7); fn — имя терминала
  'api.after_not_paged': {
    code: 'invalid_query',
    ru: '{fn}() не листается: after() сдвигает начало страницы rows(), ids(), versions() и paths(), а {fn}() считает по всем объектам шага',
    hint: 'убрать after() перед счётом и агрегатом; сузить то, что считается, — фильтром шага',
  },
  // chain.ts, lockedRead: forUpdate() вне db.begin()
  'api.for_update_outside_tx': {
    code: 'tx_required',
    ru: 'forUpdate() — только внутри db.begin(): вне явной транзакции блокировка снялась бы сразу',
  },
  // chain.ts, lockedRead: forUpdate() с другим терминалом, агрегатом, срезом, глаголом
  // chain.ts, lockedRead: what — что мешает блокировке (терминал, asOf(), withDeleted(), deep(), глагол)
  'api.for_update_unsupported': {
    code: 'lock_unsupported',
    ru: 'forUpdate() нельзя с {what}: блокировка — только у чтения rows(), first(), ids()',
    hint: 'forUpdate() — в db.begin(), перед rows(), first() или ids(); без asOf(), versions(), withDeleted(), deep(), count(), paths(), агрегатов и глаголов. Правка — отдельной цепочкой после чтения: await tr.X(id).forUpdate().first(); await tr.X(id).update(…).rows()',
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
    ru: 'шаг роли .{name}.{op}() — после create(), update() или upsert(): db.Класс(…).update(…).{name}.{op}(…)',
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
    ru: '{verb}() — нужен шаг класса: db.Класс(…).{verb}(…)',
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
    ru: '{method}() — метод шага роли после глагола: db.Класс(…).update(…).Роль.{method}(…)',
  },
  // chain.ts: cache({ ttl })
  'api.cache_ttl': {
    code: 'invalid_query',
    ru: 'cache({ ttl }): срок — положительное число секунд',
  },

  // index.ts, noTx: lock(), commit(), rollback() вне db.begin(); what — вызов
  'api.tx_only': {
    code: 'tx_required',
    ru: '{what} — только внутри db.begin()',
  },
  // index.ts: db.idOf() без арендатора сессии
  'api.id_of_no_tenant': {
    code: 'no_session',
    ru: 'idOf: нет арендатора сессии',
  },
  // index.ts: db.as() внутри db.begin()
  'api.as_in_tx': {
    code: 'invalid_query',
    ru: 'db.as() — от корня подключения, а не внутри db.begin()',
  },
  // index.ts: db.as() — сессии нет (первое чтение контекста и повторное, если контекст ушёл из арендатора)
  'api.as_no_session': {
    code: 'no_session',
    ru: 'db.as(): нет действующей сессии',
  },
  // index.ts: db.as() — контекст сессии трижды ушёл из арендатора, пока грузился реестр
  'api.as_context_changing': {
    code: 'no_session',
    ru: 'db.as(): контекст сессии меняется — реестр арендатора не загружен',
    hint: 'повторить вызов: между запросами db.as() сессия сменила арендатора или кончилась',
  },
  // index.ts: db.begin() внутри db.begin()
  // index.ts: db.begin(аргумент) — не объект опций (функция, строка, число); функцию begin() не вызывает; type — typeof
  // аргумента (array — массив)
  'api.begin_arg': {
    code: 'invalid_query',
    ru: 'db.begin() принимает только объект опций с полем reason или ничего; передано значение типа {type}. Функцию begin() не вызывает: транзакцию открывает begin(), закрывают commit() и rollback()',
    hint: 'откройте транзакцию без функции и закройте её сами: const tr = await db.begin(); try { …запросы через tr…; await tr.commit() } catch (e) { await tr.rollback(); throw e }',
  },
  // index.ts: вызов цепочки или метода подключения после db.close() корня (и у db.as(), db.begin() этого подключения)
  'api.closed': {
    code: 'invalid_query',
    ru: 'подключение закрыто (db.close()) — откройте новое connect()',
    hint: 'db.close() — в конце работы процесса; цепочки, db.as() и db.begin() закрытого подключения не работают — для новой работы const db = await connect({ … })',
  },
  'api.nested_begin': {
    code: 'invalid_query',
    ru: 'вложенных транзакций нет: db.begin() внутри db.begin()',
  },
  // index.ts: db.load() внутри db.begin()
  'api.load_in_tx': {
    code: 'invalid_query',
    ru: 'load() — своей транзакцией, не внутри db.begin()',
  },
  // index.ts: connect() без dsn и sql
  'api.connect_no_dsn': {
    code: 'invalid_data',
    ru: 'connect: нужен dsn или sql',
    hint: 'передать dsn — строку подключения — или sql — готовый пул postgres.js',
  },
  // index.ts: connect({ apiKey | service | token }) передан, но пуст (null, '', не строка) — опция есть, а значения нет
  'api.connect_empty_credential': {
    code: 'invalid_data',
    ru: 'connect: {name} передан, но пуст ({value}) — подключение без сессии не открывается',
    hint: 'передать ключ сервиса или токен строкой (process.env.SERVICE_KEY не задана?) — либо убрать опцию, если сессия не нужна; ключ сервиса up() выдаёт один раз — храните его сами',
  },
  // index.ts: connect({ admin }) — не строка и не пул
  'api.connect_admin_type': {
    code: 'invalid_data',
    ru: 'connect: admin — строка подключения администратора или пул postgres.js',
    hint: 'передать в admin строку подключения администратора или пул postgres.js либо убрать опцию',
  },
  // index.ts, adminReady: роль строки admin не может стать владельцем схемы; owner — роль-владелец
  'api.connect_admin_role': {
    code: 'admin_required',
    ru: 'connect({ admin }): роль администраторской строки подключения не может стать владельцем схемы — нужен суперпользователь или роль с SET на {owner}',
    hint: 'для admin взять строку подключения суперпользователя или роли с правом SET на роль-владельца',
  },
  // index.ts: роли владельца (опция owner) в базе нет
  'api.connect_no_owner': {
    code: 'invalid_data',
    ru: 'connect: роли владельца {owner} в базе нет — проверьте опцию owner (по умолчанию letopis_owner)',
    hint: 'указать в owner роль-владельца, с которой up() ставил схему (по умолчанию letopis_owner)',
  },
  // index.ts: роль подключения обходит RLS, а allowBypassRls нет
  'api.connect_bypass_rls': {
    code: 'bypass_rls',
    ru: 'роль подключения обходит RLS (суперпользователь, BYPASSRLS или член роли-владельца); администраторское подключение — только с опцией allowBypassRls',
  },
  // index.ts: подключение с allowBypassRls — предупреждение (lwarn)
  'api.admin_connection': {
    code: 'bypass_rls',
    ru: 'администраторское подключение — RLS не действует, данные всех арендаторов видны',
  },
  // index.ts: схемы нет
  'api.connect_no_schema': {
    code: 'invalid_data',
    ru: 'connect: схемы {schema} нет — установите её: up({ schema })',
    hint: 'установить схему up({ schema }) или исправить имя в connect({ schema })',
  },
  // index.ts: ревизия движка схемы 2.x старше библиотеки — предупреждение (lwarn); want — DDL_REVISION. Схема 1.x — отказ
  // boot.schema_1x (refuse1x в up.ts)
  'api.schema_older': {
    code: 'invalid_data',
    ru: "движок схемы {schema} ревизии {rev}, библиотека ждёт {want} — обновите: up({ schema: '{schema}', upgrade: true })",
  },
  // index.ts: ревизия движка схемы новее библиотеки — предупреждение (lwarn); known — DDL_REVISION
  'api.schema_newer': {
    code: 'invalid_data',
    ru: 'движок схемы {schema} ревизии {rev} новее библиотеки (она знает {known}) — обновите пакет letopis',
  },
  // up.ts, createTenant(): первый аргумент — не пул postgres() (строка DSN, подключение connect(), объект без begin и
  // unsafe); type — typeof значения или null
  'api.create_tenant_admin': {
    code: 'invalid_query',
    ru: 'createTenant(admin, …): admin — пул postgres() с правами администратора, а не {type}',
    hint: "const admin = postgres(dsnАдминистратора); await createTenant(admin, 'salon', { name }); await admin.end(). DSN-строку и подключение connect() letopis createTenant не принимает",
  },
  // chain.ts, versions(): у результата versions() вызвали метод цепочки (rows, first, sort…); method — его имя
  'api.versions_terminal': {
    code: 'invalid_query',
    ru: 'versions() — терминал: отдаёт строки версий, у результата нет .{method}()',
    hint: "const v = await db.Класс(id).versions(); модификаторы — до versions(): db.Класс(id).sort('at', 'desc').limit(10).versions()",
  },
} satisfies Section<'api'>;
