/**
 * Раздел boot: up.ts, pglite.ts, import.ts — установщик, PGlite, импорт из 0.21.
 */
import type { Section } from './types.js';

/** Подсказка отказов up({ login }): что передать. */
const LOGIN = 'передать login: { user, password } — имя обычной роли входа (непустое, до 63 байт, не pg_…) и её пароль (непустая строка)';
/** Подсказка отказов user.roles в createTenant() и up({ tenant }). */
const ROLES = "передать user.roles — список разных имён ролей членства, например ['staff'], или не передавать: по умолчанию ['owner']";
/** Подсказка отказов createTenant() об удалённой строке. */
const GONE = 'вернуть удалённое restore() (текст называет, кто это может) или выбрать другое имя или логин: id вычисляется из них';
/** Подсказка отказов импорта до первой записи. */
const STOPPED = 'импорт ничего не записал: строки 0.21, которые его остановили, — в detail.rows (класс, id, код, сообщение); исправить их в источнике или импортировать класс без ключа (--keyless <класс>)';

export const boot = {
  // up.ts, substitute(): в тексте SQL (ядро, миграция, свой сид) маркер, которого установщик не знает
  'boot.unknown_marker': {
    code: 'invalid_data',
    ru: 'up: неизвестный маркер {marker} в SQL',
    hint: 'в своём сиде — только маркеры установщика (@SCHEMA@, @OWNER@, @APP@, @SYSTEM@ и другие — таблица в sql/README.md пакета)',
  },
  // up.ts, install(): имя схемы не вида v<N>.<имя>
  'boot.install_schema_name': {
    code: 'invalid_data',
    ru: 'up: bad schema name "{schema}" (нужно v<N>.<имя>)',
    hint: 'полное имя схемы — v<N>.<имя>: имя из строчных латинских букв, цифр и «_», не с цифры, например v2.salon',
  },
  // up.ts, install(): имя роли владельца или приложения (опции owner, app) не по правилу
  'boot.role_name': {
    code: 'invalid_data',
    ru: 'up: bad role name "{role}"',
    hint: 'имя роли (owner, app) — строчные латинские буквы, цифры и «_», не с цифры, до 63 знаков; по умолчанию letopis_owner и letopis_app',
  },
  // up.ts, install(): режим сигналов не из списка; modes — допустимые через запятую
  'boot.signals_mode': {
    code: 'invalid_data',
    ru: 'up: signals — {modes}, а не {signals}',
    hint: "передать signals: 'class' (по умолчанию у новой схемы), 'tenant', 'opaque' или 'none' — или не передавать: up() оставит режим схемы",
  },
  // up.ts, install(): роль владельца создал кто-то другой, а у установщика нет на неё ADMIN OPTION (план 2.0, 7.5 №3)
  'boot.owner_no_admin': {
    code: 'admin_required',
    ru: 'up: роль {owner} уже есть, а у установщика нет на неё ADMIN OPTION — установку ведёт роль, создавшая {owner}, или роль с этим правом (grant {owner} to <установщик> with admin option)',
    hint: 'запустить up() ролью, создавшей роль владельца, или суперпользователем — либо выдать установщику grant <владелец> to <установщик> with admin option',
  },
  // up.ts, install(): имя сида пакета (не путь к .sql) не по правилу
  'boot.seed_name': {
    code: 'invalid_data',
    ru: 'up: bad seed name "{seed}"',
    hint: "сид пакета — имя из строчных латинских букв, цифр и «-» (например, 'booking'), свой сид — путь к файлу .sql",
  },
  // up.ts, install(): свой ключ сервиса (serviceKey) не по формату
  'boot.service_key_format': {
    code: 'invalid_data',
    ru: 'up: serviceKey — lts_ и не меньше 32 шестнадцатеричных знаков',
    hint: 'передать serviceKey вида lts_ и 32–128 шестнадцатеричных знаков в нижнем регистре — или не передавать: up() выпустит ключ сам',
  },
  // up.ts, up(): имя схемы ни <имя>, ни v<N>.<имя>
  'boot.up_schema_name': {
    code: 'invalid_data',
    ru: 'up: bad schema name "{schema}" (нужно <имя> или v<N>.<имя>)',
    hint: 'имя схемы — <имя> (версия структуры подставится сама) или v<N>.<имя>; имя — строчные латинские буквы, цифры и «_», не с цифры: например, salon или v2.salon',
  },
  // up.ts, up(): нет ни dsn, ни sql, ни pglite
  'boot.no_connection': {
    code: 'invalid_data',
    ru: 'up: нужен dsn или sql',
    hint: 'передать dsn — строку подключения администратора, sql — готовый пул postgres.js или pglite: true для разработки без своего сервера',
  },
  // up.ts, up({ login }): login — не объект
  'boot.login_not_object': {
    code: 'invalid_data',
    ru: 'up({ login }): нужен объект { user, password }',
    hint: LOGIN,
  },
  // up.ts, up({ login }): имя роли пустое, длиннее 63 байт, с pg_ или нулевым байтом; user — значение в JSON
  'boot.login_user': {
    code: 'invalid_data',
    ru: 'up({ login }): user {user} — имя роли: непустое, до 63 байт, не pg_…',
    hint: LOGIN,
  },
  // up.ts, up({ login }): пароль — не строка, пустой или с нулевым байтом
  'boot.login_password': {
    code: 'invalid_data',
    ru: 'up({ login }): password — непустая строка',
    hint: LOGIN,
  },
  // up.ts, up({ login }): роль привилегированная, роль-владелец или сама роль приложения — её пароль не меняется
  'boot.login_privileged': {
    code: 'invalid_data',
    ru: 'up({ login }): роль {user} — привилегированная (суперпользователь, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS, роль-владелец или её член) или сама роль приложения: роль приложения — обычная роль входа, привилегированную up() не трогает',
    hint: 'выбрать для login другое имя — роль без этих атрибутов и без членства в роли владельца',
  },
  // up.ts, createTenant() и up({ tenant }): нет имени арендатора
  'boot.tenant_name_required': {
    code: 'invalid_data',
    ru: 'createTenant: имя арендатора обязательно',
    hint: 'передать name — имя арендатора: из него вычисляется id, поэтому одно имя — всегда один и тот же арендатор',
  },
  // up.ts, createTenant() и up({ tenant }): вид пароля user.kind не по правилу функций кредов; kind — значение в JSON,
  // kinds — служебные виды через запятую
  'boot.tenant_kind': {
    code: 'invalid_data',
    ru: 'createTenant: user.kind {kind} — вид пароля: заглавная латинская буква, затем заглавные буквы, цифры или «_», всего от 2 до 32 знаков; служебные виды {kinds} заняты (по умолчанию — PASSWORD)',
    hint: "не передавать user.kind (вход по паролю — вид PASSWORD) или передать вид по правилу auth.setPassword, например 'PIN'",
  },
  // up.ts, createTenant() и up({ tenant }): user.roles — не список или пустой
  'boot.tenant_roles_empty': {
    code: 'invalid_data',
    ru: "createTenant: user.roles — непустой список ролей, например ['staff']",
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роль в user.roles — не строка; type — null или typeof значения
  'boot.tenant_role_type': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роль — строка, а не {type}',
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роль — маска группы, пустая или с пробелами по краям; role — значение в JSON
  'boot.tenant_role_mask': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роль {role}: нужно имя роли, а не маска группы — не пустое, без пробелов по краям, запятых, фигурных скобок и «!» в начале',
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роли в user.roles повторяются
  'boot.tenant_roles_repeat': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роли повторяются',
    hint: ROLES,
  },
  // up.ts, createTenant(): строки арендатора нет, а его история в журнале есть
  'boot.tenant_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: арендатор «{name}» ({id}) удалён, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.Account(id).restore() от имени системного администратора или выберите другое имя',
    hint: GONE,
  },
  // up.ts, createTenant(): строки аккаунта пользователя нет, а его история в журнале есть
  'boot.tenant_user_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: аккаунт пользователя {login} ({id}) удалён, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.Account(id).restore() от имени системного администратора или выберите другой логин',
    hint: GONE,
  },
  // up.ts, createTenant(): строки членства нет, а его история в журнале есть
  'boot.tenant_member_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: членство {login} в арендаторе «{name}» ({id}) удалено, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.member(id).restore() в этом арендаторе или выберите другой логин',
    hint: GONE,
  },

  // up.ts и pglite.ts: обычный Error с префиксом letopis.up (подходящего кода нет) — текст по записи (lmsg), код записи при
  // броске не берётся
  // up.ts, install(): сервер ниже PostgreSQL 18; version — server_version_num
  'boot.install_pg_version': {
    code: 'invalid_query',
    ru: 'нужен PostgreSQL 18 или новее, а сервер — {version}',
  },
  // up.ts, checkServer(): сервер ниже PostgreSQL 18; major — основная версия, num — server_version_num
  'boot.pg_version': {
    code: 'invalid_query',
    ru: 'нужен PostgreSQL 18 или новее, а сервер — {major} ({num})',
  },
  // up.ts, checkServer(): база не в UTF8
  'boot.encoding': {
    code: 'invalid_query',
    ru: 'база в кодировке {encoding}, нужна UTF8 (casefold и коллация pg_unicode_fast)',
  },
  // up.ts, up(): база не ответила за waitTimeoutMs; host — хост строки подключения, seconds — срок в секундах
  'boot.wait_timeout': {
    code: 'invalid_query',
    ru: 'база {host} не готова за {seconds} с',
  },
  // up.ts, up(): ревизия схемы новее пакета; rev — ревизия схемы, known — DDL_REVISION
  'boot.schema_newer': {
    code: 'invalid_data',
    ru: 'схема {schema} ревизии {rev}, а библиотека знает только {known} — обновите пакет',
  },
  // up.ts, up(): ревизия схемы старше пакета, а upgrade нет; want — DDL_REVISION
  'boot.schema_older': {
    code: 'invalid_data',
    ru: "схема {schema} ревизии {rev}, библиотека — {want}: обновите её up({ schema: '{schema}', upgrade: true })",
  },
  // pglite.ts, startPglite(): нет пакета PGlite; name — имя пакета
  'boot.pglite_package': {
    code: 'invalid_query',
    ru: 'для pglite нужен пакет {name} — npm i -D @electric-sql/pglite @electric-sql/pglite-socket',
  },
  // up.ts, checkServer(): предупреждение (UpResult.warnings, lmsg) — сервер ниже 18.2; version — вида 18.1
  'boot.pg_clog': {
    code: 'invalid_query',
    ru: 'PostgreSQL {version}: до 18.2 сервер мог усечь CLOG, который ещё нужен непрочитанным сигналам NOTIFY; обновите сервер до 18.2 или новее',
  },
  // up.ts, up(): предупреждение (UpResult.warnings) — после ANALYZE от роли владельца у таблиц всё ещё нет статистики;
  // tables — схема.таблица через запятую
  'boot.analyze_skipped': {
    code: 'invalid_query',
    ru: 'таблицы без статистики после ANALYZE от роли владельца {owner}: {tables} — проверьте, что они принадлежат ей; иначе статистику соберёт автоочистка или ANALYZE их владельца',
  },
  // up.ts, up(): предупреждение (UpResult.warnings) — в схеме есть хабы с именами из RESERVED_CLASS_NAMES, заведённые до
  // 2.0 (план 2.0, этап 4, п. 2; 7.10 №3): up() их оставляет; hubs — «имя (арендатор)» через запятую
  'boot.reserved_hubs': {
    code: 'invalid_class',
    ru: 'хабы с зарезервированными именами: {hubs} — имя занято методом цепочки или корня db, шаг с ним до класса может не дойти; с 2.0 такой хаб не создаётся, а его описание не меняется: переименуйте класс (новый класс и reclass() строк)',
  },
  // up.ts, stampDrift(): предупреждение connect() (его печатает index.ts) — схему той же ревизии обновила более новая
  // версия; was — версия из штампа схемы, version — версия пакета
  'boot.stamp_newer': {
    code: 'invalid_data',
    ru: 'схему {schema} обновила letopis {was}, библиотека старее ({version}) — обновите пакет: up() этой версией вернул бы прежние функции',
  },
  // up.ts, stampDrift(): функции схемы той же ревизии поставила другая версия — по записи на того, кто поставил: версия
  // до 1.4.0 (штампа нет), другая сборка той же версии, другая версия
  'boot.stamp_before_140': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила версия до 1.4.0, библиотека — {version}: обновите схему — вызовите up({ schema: '{schema}' })",
  },
  'boot.stamp_other_build': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила другая сборка letopis {was}, библиотека — {version}: обновите схему — вызовите up({ schema: '{schema}' })",
  },
  'boot.stamp_other_version': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила letopis {was}, библиотека — {version}: обновите схему — вызовите up({ schema: '{schema}' })",
  },
  // up.ts: ход установки в консоли (lmsg, префикс letopis.up добавляет up()) — тексты не для ошибки, код не печатается.
  // ensureDatabase(): база создана
  'boot.log_database_created': {
    code: 'invalid_query',
    ru: 'база {name} создана',
  },
  // up({ fresh })
  'boot.log_fresh': {
    code: 'invalid_query',
    ru: 'схема {schema} удалена и поставлена заново (fresh)',
  },
  // итог наката — по записи на исход; revision — ревизия после наката, from — до (у обновления)
  'boot.log_installed': {
    code: 'invalid_query',
    ru: 'схема поставлена: {schema}, ревизия {revision}',
  },
  'boot.log_upgraded': {
    code: 'invalid_query',
    ru: 'схема обновлена с ревизии {from}: {schema}, ревизия {revision}',
  },
  'boot.log_reapplied': {
    code: 'invalid_query',
    ru: 'повторный накат: {schema}, ревизия {revision}',
  },
  // up({ login }): роль приложения заведена или получила новый пароль
  'boot.log_login_created': {
    code: 'invalid_query',
    ru: 'роль приложения {user}: заведена',
  },
  'boot.log_login_updated': {
    code: 'invalid_query',
    ru: 'роль приложения {user}: пароль обновлён',
  },

  // import.ts, buildClasses(): класса из --keyless нет в таблице Schema 0.21
  'boot.import_keyless_unknown': {
    code: 'invalid_data',
    ru: 'import: --keyless {cls} — такого класса в 0.21 нет',
    hint: 'назвать в --keyless классы 0.21 по их id в таблице Schema источника',
  },
  // import.ts, import021(): --initial вместе с --update или --commit-every
  'boot.import_initial_conflict': {
    code: 'invalid_data',
    ru: 'import --initial несовместим с --update и --commit-every: первая заливка — одна транзакция в пустую схему',
    hint: 'первую заливку запускать без --update и --commit-every; дописывать и обновлять — следующими импортами без --initial',
  },
  // import.ts, import021(): в схеме 0.21 нет строк Schema этой партиции
  'boot.import_no_classes': {
    code: 'invalid_data',
    ru: 'import: в {schema} нет классов партиции {partition}',
    hint: 'проверить --from-schema (схема 0.21 вида v1.<имя>) и --partition (по умолчанию entity)',
  },
  // import.ts, import021(): данные лежат у аккаунта System 0.21, а --tenant не задан
  'boot.import_tenant_required': {
    code: 'invalid_data',
    ru: 'import: данные лежат у аккаунта System — укажите арендатора для них (--tenant <имя>)',
    hint: 'передать --tenant <имя> (опция tenant): данные аккаунта System лягут в арендатора с этим именем',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — класс объекта 0.21 не найден или опущен
  'boot.import_class_missing': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден или опущен',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — id из ключа не вычислить
  'boot.import_key_unresolved': {
    code: 'target_not_found',
    ru: 'ключ объекта ссылается на отсутствующий объект или значение ключа — не строка',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — два объекта 0.21 получают один id 1.0; cls и old —
  // класс и id первого, keyless — класс для --keyless
  'boot.import_same_id': {
    code: 'duplicate',
    ru: 'тот же id 1.0 ({id}), что у {cls} {old}: данные 0.21 нарушают ключ класса — импортируйте класс без ключа (--keyless {keyless})',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — значение ключа менялось между версиями объекта
  'boot.import_key_changed': {
    code: 'invalid_data',
    ru: 'значение ключа менялось между версиями — в 1.0 ключ неизменен (--keyless)',
  },
  // import.ts, import021(): проверки до записи остановили импорт — по записи на код первой строки, без и с «и ещё»;
  // cls, id, message — первая строка, more — сколько ещё
  'boot.import_stopped_invalid_class': {
    code: 'invalid_class',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_class_more': {
    code: 'invalid_class',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    hint: STOPPED,
  },
  'boot.import_stopped_target_not_found': {
    code: 'target_not_found',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_target_not_found_more': {
    code: 'target_not_found',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    hint: STOPPED,
  },
  'boot.import_stopped_duplicate': {
    code: 'duplicate',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_duplicate_more': {
    code: 'duplicate',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_data': {
    code: 'invalid_data',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_data_more': {
    code: 'invalid_data',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    hint: STOPPED,
  },
  // import.ts, import021(): загрузчик отменил загрузку данных арендатора, строки detail.rows переведены в объекты 0.21 —
  // по записи на каждый код нарушения загрузчика (код ошибки — её код); message — текст ошибки загрузчика
  'boot.import_load_acl_denied': {
    code: 'acl_denied',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_class_not_loadable': {
    code: 'class_not_loadable',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_deleted': {
    code: 'deleted',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_derived_class': {
    code: 'derived_class',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_duplicate': {
    code: 'duplicate',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_exists': {
    code: 'exists',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_invalid_class': {
    code: 'invalid_class',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_invalid_data': {
    code: 'invalid_data',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_target_not_found': {
    code: 'target_not_found',
    ru: 'import: арендатор {tenant}: {message}',
  },
  'boot.import_load_tenant_denied': {
    code: 'tenant_denied',
    ru: 'import: арендатор {tenant}: {message}',
  },
  // import.ts, import021(): ошибка базы при записи класса — префикс к её тексту (текст базы остаётся); message — он
  'boot.import_class_failed': {
    code: 'invalid_class',
    ru: 'import: класс {cls}: {message}',
  },

  // import.ts: заметки отчёта notes[].note (lmsg) — правило 0.21, перенесённое не один к одному; тексты не для ошибки.
  // conv(): правило не разобрано; rule — правило в JSON
  'boot.import_note_rule_unparsed': {
    code: 'invalid_class',
    ru: 'правило {rule} не разобрано — поле без проверки',
  },
  // conv(): ключ правила не переносится; rule — тип и ключ: string.trim, number.equal, uuid.version
  'boot.import_note_not_carried': {
    code: 'invalid_class',
    ru: '{rule} не переносится',
  },
  // conv(): тип url
  'boot.import_note_url': {
    code: 'invalid_class',
    ru: 'url → строка без проверки формата',
  },
  // conv(): директива $$… вложенного объекта (кроме $$strict); name — директива
  'boot.import_note_directive': {
    code: 'invalid_class',
    ru: 'директива {name} не переносится',
  },
  // conv(): тип не поддерживается
  'boot.import_note_type_unsupported': {
    code: 'invalid_class',
    ru: 'тип {type} не поддерживается — поле без проверки',
  },
  // conv(): часть пути поля в заметках (notes[].field) у правила record — ключ и значение
  'boot.import_path_key': {
    code: 'invalid_class',
    ru: '<ключ>',
  },
  'boot.import_path_value': {
    code: 'invalid_class',
    ru: '<значение>',
  },
  // buildClasses(): поле на $
  'boot.import_note_dollar_field': {
    code: 'invalid_class',
    ru: 'поле на $ не переносится (метасхема 1.0), значения в данных отброшены',
  },
  // buildClasses(): нормализатор отклонил описание поля; message — текст его ошибки
  'boot.import_note_schema_error': {
    code: 'invalid_class',
    ru: '{message} — поле без проверки',
  },
  // buildClasses(): конец не разобран; end — конец в JSON
  'boot.import_note_end_unparsed': {
    code: 'invalid_class',
    ru: 'конец {end} не разобран',
  },
  // buildClasses(): полиморфный конец на опущенный корень; classes — классы через |
  'boot.import_note_polymorphic_root': {
    code: 'invalid_class',
    ru: 'полиморфный конец на корень {classes} не переносится',
  },
  // buildClasses(): два конца с одной ролью
  'boot.import_note_two_ends': {
    code: 'invalid_class',
    ru: 'два конца с ролью {role}',
  },
  // buildClasses(): ссылка в данных на класс, не объявленный концом; cls — класс цели 0.21
  'boot.import_note_undeclared_link': {
    code: 'invalid_class',
    ru: 'ссылка на {cls} в данных не объявлена концом — добавлен необязательный конец',
  },
  // buildClasses(): поле ключа — не строка
  'boot.import_note_key_not_string': {
    code: 'invalid_class',
    ru: 'поле ключа — не строка: класс импортирован без ключа',
  },
  // import.ts, import021(): ход импорта в консоли (lmsg, префикс letopis.import добавляет log) — тексты не для ошибки.
  // прочитано из 0.21
  'boot.import_log_source': {
    code: 'invalid_query',
    ru: '0.21: классов {classes}, объектов {objects}, аккаунтов {accounts}',
  },
  // шаг классов
  'boot.import_log_classes': {
    code: 'invalid_query',
    ru: 'классы: создано {created}, уже были {existing}, опущено {omitted}',
  },
  // данные арендатора
  'boot.import_log_tenant': {
    code: 'invalid_query',
    ru: 'арендатор {tenant}: объектов {objects}, версий {versions}',
  },
  // итог — verify чист или с находками; seconds — с одной цифрой после точки, issues — число находок
  'boot.import_log_done_clean': {
    code: 'invalid_query',
    ru: 'готово за {seconds} с: verify чист',
  },
  'boot.import_log_done_issues': {
    code: 'invalid_query',
    ru: 'готово за {seconds} с: verify находок {issues}',
  },
} satisfies Section<'boot'>;
