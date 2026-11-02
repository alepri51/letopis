/**
 * Раздел api: index.ts, chain.ts, typed.ts, errors.ts, internal.ts — подключение, фасад, цепочки, батч, ошибки.
 */
import type { Section } from './types.js';

export const api = {
  // errors.ts, ValidationError: данные не проходят проверку на TypeScript (из базы — sql-write.invalid_data)
  'api.validation_failed': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
    en: 'the data does not match the description of class {cls}',
  },
  // chain.ts: шаг цепочки — не класс, не алиас и не роль реестра сессии; похожие имена — params.similar
  'api.unknown_step': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
    en: 'class or role {name} not found',
  },
  // index.ts: connect({ schema })
  'api.connect_schema': {
    code: 'invalid_data',
    ru: 'connect: схема {schema} — нужно v<N>.<имя>',
    en: 'connect: schema {schema} — expected v<N>.<name>',
    hint: {
      ru: 'имя схемы — v<N>.<имя>, как у up({ schema }): например, v2.salon',
      en: 'the schema name is v<N>.<name>, as in up({ schema }): for example, v2.salon',
    },
  },
  // errors.ts: опция lang у connect(), createMcpServer() и CLI (--lang)
  'api.bad_lang': {
    code: 'invalid_data',
    ru: "{where}: lang — 'ru' или 'en', а не {lang}",
    en: "{where}: lang is 'ru' or 'en', not {lang}",
    hint: {
      ru: "передать lang: 'ru' (по умолчанию) или 'en'",
      en: "pass lang: 'ru' (the default) or 'en'",
    },
  },
  // errors.ts, checkOptions: неизвестная опция connect(), up(), load(), проектора, watch(), createMcpServer() — в 1.5
  // предупреждение (lwarn), в 2.0 — ошибка
  'api.unknown_option': {
    code: 'invalid_data',
    ru: 'неизвестная опция {where}({ {name} })',
    en: 'unknown option {where}({ {name} })',
    hint: {
      ru: 'проверить имя опции: похожие названы в тексте, все опции — в README, «Справочник API»',
      en: 'check the option name: similar ones are named in the text, all options are in README, "API reference"',
    },
  },
  // errors.ts, fromDbError: новые значения строки не проходят условие ACL (политика RLS WITH CHECK)
  'api.row_check_denied': {
    code: 'acl_denied',
    ru: 'новые значения строки запрещают правила доступа',
    en: 'the access rules forbid the new values of the row',
  },
  // errors.ts, охранник снятого API: метод или свойство — мужской род; name — имя снятого API, как в вызове охранника (не
  // переводится: по нему контракт API сверяет охранники), version — REMOVED_IN, replacement — замена на языке вокруг:
  // текст записи-замены (ниже) или имя API без перевода, например paths()
  'api.removed': {
    code: 'removed',
    ru: '{name} снят в {version} — {replacement}',
    en: '{name} was removed in {version} — {replacement}',
  },
  // errors.ts, охранник снятой опции connect() (замена — запись api.replacement_option_*): женский род; name — без слова
  // «опция»
  'api.removed_option': {
    code: 'removed',
    ru: 'опция {name} снята в {version} — {replacement}',
    en: 'option {name} was removed in {version} — {replacement}',
  },
  // errors.ts, охранник снятого API: несколько имён через «и» — множественное число
  'api.removed_many': {
    code: 'removed',
    ru: '{name} сняты в {version} — {replacement}',
    en: '{name} were removed in {version} — {replacement}',
  },
  // замены охранников снятого API index.ts и chain.ts (второй аргумент removed): текст после «— » в api.removed* на языке
  // вокруг; контракт API берёт русский шаблон (lib/scripts/contract.mjs). Имена API в замене не переводятся
  'api.replacement_uuidv7': {
    code: 'removed',
    ru: 'uuidv5() и idOf(): id объекта вычисляется из ключа',
    en: 'uuidv5() and idOf(): the object id is computed from the key',
  },
  'api.replacement_letopis_ns': {
    code: 'removed',
    ru: 'пространство имён v5 — id арендатора: idOf(класс, ключ, { tenant })',
    en: 'the v5 namespace is the tenant id: idOf(class, key, { tenant })',
  },
  'api.replacement_watch': {
    code: 'removed',
    ru: 'watch({ from }) — подписка по курсору',
    en: 'watch({ from }) — a subscription by cursor',
  },
  'api.replacement_reload_schema': {
    code: 'removed',
    ru: 'реестр обновляется сам по сигналу; принудительно — db.refresh()',
    en: 'the registry refreshes itself on a signal; to force it — db.refresh()',
  },
  'api.replacement_facades': {
    code: 'removed',
    ru: 'системные классы Account, Resource, rule, member и db.auth (accounts.purge — db.auth.purgeAccount)',
    en: 'the system classes Account, Resource, rule, member and db.auth (accounts.purge — db.auth.purgeAccount)',
  },
  'api.replacement_compact': {
    code: 'removed',
    ru: 'db.trimHistory(цель, момент), политика хранения history и history: false',
    en: 'db.trimHistory(target, moment), the history retention policy and history: false',
  },
  'api.replacement_account_step': {
    code: 'removed',
    ru: 'арендатор сессии и auth.switch() (этап 5)',
    en: 'the session tenant and auth.switch() (stage 5)',
  },
  // замены снятых опций connect() — значения REMOVED_OPTIONS в index.ts: по префиксу ключа api.replacement_option_
  // охранник выбирает запись api.removed_option
  'api.replacement_option_partition': {
    code: 'removed',
    ru: 'отдельные схемы установки (v2.<имя>)',
    en: 'separate installation schemas (v2.<name>)',
  },
  'api.replacement_option_enforce_account': {
    code: 'removed',
    ru: 'изоляция арендаторов включена всегда (RLS)',
    en: 'tenant isolation is always on (RLS)',
  },
  'api.replacement_option_enforce_acl': {
    code: 'removed',
    ru: 'права включены всегда (этап 5)',
    en: 'permissions are always on (stage 5)',
  },
  'api.replacement_option_docker': {
    code: 'removed',
    ru: 'Docker в up() не нужен',
    en: 'up() does not need Docker',
  },
  'api.replacement_option_redis': {
    code: 'removed',
    ru: 'Redis не нужен: сессии в базе',
    en: 'Redis is not needed: sessions are in the database',
  },
  'api.replacement_option_version': {
    code: 'removed',
    ru: 'версия схемы — константа движка',
    en: 'the schema version is an engine constant',
  },

  // chain.ts, warnNoHistory: versions(), asOf(), diff(), blame() у класса без журнала — предупреждение (lwarn), один раз
  // на класс и метод; код записи не печатается
  'api.no_history': {
    code: 'invalid_query',
    ru: '.{method}() у класса {cls} без журнала (history: false) — истории нет',
    en: '.{method}() on class {cls} without a log (history: false) — there is no history',
  },
  // chain.ts, report: медленный запрос без хука onQuery — предупреждение (lwarn); ms — целое, classes — классы шагов через →
  'api.slow_query': {
    code: 'invalid_query',
    ru: 'медленный запрос {ms} мс — {mode} {classes}',
    en: 'slow query {ms} ms — {mode} {classes}',
  },
  // chain.ts: терминал у цепочки батча с глаголами
  'api.batch_queued': {
    code: 'invalid_query',
    ru: 'план стоит в очереди батча — его исполнит batch.run()',
    en: 'the plan is queued in the batch — batch.run() will execute it',
  },
  // chain.ts, afterVerbError: модификатор выборки сразу после глагола перед rows, first, ids, count, paths (и в batch.run())
  'api.mod_after_verb': {
    code: 'invalid_query',
    ru: '{name}() после {verb}() ни на что не действует: глагол проходит по всем целям шага, а ответ — его строки. Цели сужают limit(), offset() и sort() до глагола: db.Класс(…).limit(n).{verb}(…)',
    en: '{name}() after {verb}() has no effect: the verb goes over all targets of the step, and the result is its rows. Narrow the targets with limit(), offset() and sort() before the verb: db.ClassName(…).limit(n).{verb}(…)',
  },
  // chain.ts, lockedRead: forUpdate() вне db.begin()
  'api.for_update_outside_tx': {
    code: 'tx_required',
    ru: 'forUpdate() — только внутри db.begin(): вне явной транзакции блокировка снялась бы сразу',
    en: 'forUpdate() works only inside db.begin(): outside an explicit transaction the lock would be released at once',
  },
  // chain.ts, lockedRead: forUpdate() с другим терминалом, агрегатом, срезом, глаголом
  'api.for_update_unsupported': {
    code: 'lock_unsupported',
    ru: 'forUpdate() — с терминалами rows, first, ids, без агрегатов, asOf, versions, withDeleted, deep и глаголов',
    en: 'forUpdate() works with the terminals rows, first, ids, without aggregates, asOf, versions, withDeleted, deep and verbs',
  },
  // chain.ts, lockedRead: строки видны, но политика правки не даёт их заблокировать; ids — через запятую (detail.ids — списком)
  'api.lock_denied': {
    code: 'acl_denied',
    ru: 'строки видны, но заблокировать их нельзя: {ids}',
    en: 'the rows are visible, but they cannot be locked: {ids}',
  },
  // chain.ts, versionRef: diff({ from }), diff({ to }) — номер версии или момент; what — опция
  'api.version_or_moment': {
    code: 'invalid_query',
    ru: '{what}: номер версии (целое ≥ 1) или момент (ISO-строка, Date)',
    en: '{what}: a version number (an integer ≥ 1) or a moment (an ISO string, Date)',
  },
  // chain.ts, versionRef: blame({ limit }) — только номер
  'api.version_number': {
    code: 'invalid_query',
    ru: '{what}: номер версии (целое ≥ 1)',
    en: '{what}: a version number (an integer ≥ 1)',
  },
  // chain.ts, momentOf: blame({ at })
  'api.moment': {
    code: 'invalid_query',
    ru: '{what}: момент — ISO-строка или Date',
    en: '{what}: a moment is an ISO string or a Date',
  },
  // chain.ts, slotValue: значение .Роль.set(…), .add(…), .remove(…)
  'api.slot_value': {
    code: 'invalid_query',
    ru: 'значение слота — id, список id, строка ответа или цепочка',
    en: 'a slot value is an id, a list of ids, a result row or a chain',
  },
  // chain.ts: слот не сразу после create(), update() или upsert(); name — роль, как вызвана, op — set, unset, add, remove
  'api.slot_without_write': {
    code: 'invalid_query',
    ru: 'слот .{name}.{op}() — после create(), update() или upsert(): db.Класс(…).update(…).{name}.{op}(…)',
    en: 'slot .{name}.{op}() goes after create(), update() or upsert(): db.ClassName(…).update(…).{name}.{op}(…)',
  },
  // chain.ts: add() или remove() у одиночного конца
  'api.slot_single': {
    code: 'invalid_query',
    ru: 'слот .{name}.{op}(): конец {role} одиночный — set() или unset()',
    en: 'slot .{name}.{op}(): end {role} is single — set() or unset()',
  },
  // chain.ts: unset() у обязательного конца
  'api.slot_required': {
    code: 'invalid_query',
    ru: 'слот .{name}.unset(): конец {role} обязателен',
    en: 'slot .{name}.unset(): end {role} is required',
  },
  // chain.ts: set() или unset() одного конца дважды в одной записи
  'api.slot_twice': {
    code: 'invalid_query',
    ru: 'слот {role} задан дважды в одной записи',
    en: 'slot {role} is set twice in one write',
  },
  // chain.ts, withLast: deep(), exact(), alias(), tags(), owner() сразу после глагола; verb — глагол
  'api.step_mod_after_verb': {
    code: 'invalid_query',
    ru: 'модификатор шага после {verb}() — сначала шаг класса',
    en: 'a step modifier after {verb}() — first a class step',
  },
  // chain.ts, withOp: глагол без шага класса
  'api.verb_without_step': {
    code: 'invalid_query',
    ru: '{verb}() — нужен шаг класса: db.Класс(…).{verb}(…)',
    en: '{verb}() needs a class step: db.ClassName(…).{verb}(…)',
  },
  // chain.ts, entity(): цепочка с глаголами
  'api.entity_with_verbs': {
    code: 'invalid_query',
    ru: 'entity() принимает читающий паттерн — цепочку с глаголами вклеить нельзя',
    en: 'entity() takes a reading pattern — a chain with verbs cannot be inserted',
  },
  // chain.ts, entity(): не цепочка и не строка ответа
  'api.entity_arg': {
    code: 'invalid_query',
    ru: 'entity() принимает ленивую цепочку или строку ответа',
    en: 'entity() takes a lazy chain or a result row',
  },
  // chain.ts: set, unset, add, remove у цепочки, а не у слота роли; method — имя метода
  'api.slot_method': {
    code: 'invalid_query',
    ru: '{method}() — метод слота: db.Класс(…).update(…).Роль.{method}(…)',
    en: '{method}() is a slot method: db.ClassName(…).update(…).RoleName.{method}(…)',
  },
  // chain.ts: cache({ ttl })
  'api.cache_ttl': {
    code: 'invalid_query',
    ru: 'cache({ ttl }): срок — положительное число секунд',
    en: 'cache({ ttl }): ttl is a positive number of seconds',
  },

  // index.ts, noTx: lock(), commit(), rollback() вне db.begin(); what — вызов
  'api.tx_only': {
    code: 'tx_required',
    ru: '{what} — только внутри db.begin()',
    en: '{what} works only inside db.begin()',
  },
  // index.ts: db.idOf() без арендатора сессии
  'api.id_of_no_tenant': {
    code: 'no_session',
    ru: 'idOf: нет арендатора сессии',
    en: 'idOf: the session has no tenant',
  },
  // index.ts: db.as() внутри db.begin()
  'api.as_in_tx': {
    code: 'invalid_query',
    ru: 'db.as() — от корня подключения, а не внутри db.begin()',
    en: 'db.as() works from the connection root, not inside db.begin()',
  },
  // index.ts: db.as() — сессии нет (первое чтение контекста и повторное, если контекст ушёл из арендатора)
  'api.as_no_session': {
    code: 'no_session',
    ru: 'db.as(): нет действующей сессии',
    en: 'db.as(): there is no valid session',
  },
  // index.ts: db.as() — контекст сессии трижды ушёл из арендатора, пока грузился реестр
  'api.as_context_changing': {
    code: 'no_session',
    ru: 'db.as(): контекст сессии меняется — реестр арендатора не загружен',
    en: 'db.as(): the session context keeps changing — the tenant registry is not loaded',
    hint: {
      ru: 'повторить вызов: между запросами db.as() сессия сменила арендатора или кончилась',
      en: 'retry the call: between the queries of db.as() the session switched its tenant or ended',
    },
  },
  // index.ts: db.begin() внутри db.begin()
  'api.nested_begin': {
    code: 'invalid_query',
    ru: 'вложенных транзакций нет: db.begin() внутри db.begin()',
    en: 'there are no nested transactions: db.begin() inside db.begin()',
  },
  // index.ts: db.load() внутри db.begin()
  'api.load_in_tx': {
    code: 'invalid_query',
    ru: 'load() — своей транзакцией, не внутри db.begin()',
    en: 'load() runs in its own transaction, not inside db.begin()',
  },
  // index.ts: db.projector() внутри db.begin()
  'api.projector_in_tx': {
    code: 'invalid_query',
    ru: 'projector() — от корня подключения, а не внутри db.begin()',
    en: 'projector() works from the connection root, not inside db.begin()',
  },
  // index.ts: db.projector() без администраторского подключения
  'api.projector_admin': {
    code: 'admin_required',
    ru: 'проектору нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы, или connect({ admin }))',
    en: 'a projector needs an admin connection (connect({ allowBypassRls: true }) of a role that can become the schema owner, or connect({ admin }))',
  },
  // index.ts: db.rebuildAggregates() внутри db.begin()
  'api.rebuild_in_tx': {
    code: 'invalid_query',
    ru: 'rebuildAggregates() — своей транзакцией, не внутри db.begin()',
    en: 'rebuildAggregates() runs in its own transaction, not inside db.begin()',
  },
  // index.ts: db.rebuildAggregates() без администраторского подключения
  'api.rebuild_admin': {
    code: 'admin_required',
    ru: 'ремонту агрегатов нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы, или connect({ admin }))',
    en: 'repairing aggregates needs an admin connection (connect({ allowBypassRls: true }) of a role that can become the schema owner, or connect({ admin }))',
  },
  // index.ts: connect() без dsn и sql
  'api.connect_no_dsn': {
    code: 'invalid_data',
    ru: 'connect: нужен dsn или sql',
    en: 'connect: dsn or sql is required',
    hint: {
      ru: 'передать dsn — строку подключения — или sql — готовый пул postgres.js',
      en: 'pass dsn, a connection string, or sql, a ready postgres.js pool',
    },
  },
  // index.ts: connect({ admin }) — не строка и не пул
  'api.connect_admin_type': {
    code: 'invalid_data',
    ru: 'connect: admin — строка подключения администратора или пул postgres.js',
    en: 'connect: admin is an admin connection string or a postgres.js pool',
    hint: {
      ru: 'передать в admin строку подключения администратора или пул postgres.js либо убрать опцию',
      en: 'pass an admin connection string or a postgres.js pool in admin, or remove the option',
    },
  },
  // index.ts, adminReady: роль строки admin не может стать владельцем схемы; owner — роль-владелец
  'api.connect_admin_role': {
    code: 'admin_required',
    ru: 'connect({ admin }): роль администраторской строки подключения не может стать владельцем схемы — нужен суперпользователь или роль с SET на {owner}',
    en: 'connect({ admin }): the role of the admin connection string cannot become the schema owner — a superuser or a role with SET on {owner} is required',
    hint: {
      ru: 'для admin взять строку подключения суперпользователя или роли с правом SET на роль-владельца',
      en: 'for admin use a connection string of a superuser or of a role with the SET option on the owner role',
    },
  },
  // index.ts: роли владельца (опция owner) в базе нет
  'api.connect_no_owner': {
    code: 'invalid_data',
    ru: 'connect: роли владельца {owner} в базе нет — проверьте опцию owner (по умолчанию letopis_owner)',
    en: 'connect: there is no owner role {owner} in the database — check the owner option (letopis_owner by default)',
    hint: {
      ru: 'указать в owner роль-владельца, с которой up() ставил схему (по умолчанию letopis_owner)',
      en: 'set owner to the owner role that up() installed the schema with (letopis_owner by default)',
    },
  },
  // index.ts: роль подключения обходит RLS, а allowBypassRls нет
  'api.connect_bypass_rls': {
    code: 'bypass_rls',
    ru: 'роль подключения обходит RLS (суперпользователь, BYPASSRLS или член роли-владельца); администраторское подключение — только с опцией allowBypassRls',
    en: 'the connection role bypasses RLS (a superuser, BYPASSRLS or a member of the owner role); an admin connection is allowed only with the allowBypassRls option',
  },
  // index.ts: подключение с allowBypassRls — предупреждение (lwarn)
  'api.admin_connection': {
    code: 'bypass_rls',
    ru: 'администраторское подключение — RLS не действует, данные всех арендаторов видны',
    en: 'admin connection — RLS does not apply, the data of all tenants is visible',
  },
  // index.ts: схемы нет
  'api.connect_no_schema': {
    code: 'invalid_data',
    ru: 'connect: схемы {schema} нет — установите её: up({ schema })',
    en: 'connect: there is no schema {schema} — install it: up({ schema })',
    hint: {
      ru: 'установить схему up({ schema }) или исправить имя в connect({ schema })',
      en: 'install the schema with up({ schema }) or fix the name in connect({ schema })',
    },
  },
  // index.ts: ревизия движка схемы старше библиотеки — предупреждение (lwarn); want — DDL_REVISION
  'api.schema_older': {
    code: 'invalid_data',
    ru: "движок схемы {schema} ревизии {rev}, библиотека ждёт {want} — обновите: up({ schema: '{schema}', upgrade: true })",
    en: "the engine of schema {schema} is revision {rev}, the library expects {want} — upgrade it: up({ schema: '{schema}', upgrade: true })",
  },
  // index.ts: ревизия движка схемы новее библиотеки — предупреждение (lwarn); known — DDL_REVISION
  'api.schema_newer': {
    code: 'invalid_data',
    ru: 'движок схемы {schema} ревизии {rev} новее библиотеки (она знает {known}) — обновите пакет letopis',
    en: 'the engine of schema {schema} is revision {rev}, newer than the library (it knows {known}) — update the letopis package',
  },
} satisfies Section<'api'>;
