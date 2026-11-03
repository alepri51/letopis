/**
 * Раздел boot: up.ts, pglite.ts — установщик и PGlite.
 */
import type { Section } from './types.js';

/** Подсказка отказов up({ login }): что передать. */
const LOGIN = 'передать login: { user, password } — имя обычной роли входа (непустое, до 63 байт, не pg_…) и её пароль (непустая строка)';
/** Подсказка отказов user.roles в createTenant() и up({ tenant }). */
const ROLES = "передать user.roles — список разных имён ролей членства, например ['staff'], или не передавать: по умолчанию ['owner']";
/** Подсказка отказов createTenant() об удалённой строке. */
const GONE = 'вернуть удалённое restore() (текст называет, кто это может) или выбрать другое имя или логин: id вычисляется из них';

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
  // up.ts, refuse1x(): схема letopis 1.x — ревизия из комментария схемы ниже первой ревизии 2.0 (FIRST_REVISION) или
  // штампа ревизии нет (rev 0); отказ up() — до любых изменений, connect() — до входа по ключу (план 2.0, 7.10 №5).
  // first — FIRST_REVISION
  'boot.schema_1x': {
    code: 'invalid_data',
    ru: "схема {schema} ревизии {rev}, а 2.0 — с ревизии {first}: это схема letopis 1.x (или схема без штампа ревизии), 2.0 ставится только заново — up({ schema: '{schema}', fresh: true }) пересоздаст схему, данные 1.x не переносятся",
    hint: 'схема letopis 1.x: 2.0 ставится только заново — up({ fresh: true }) пересоздаст схему, данные 1.x не переносятся',
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
  // up.ts, up(): ревизия схемы 2.x старше пакета, а upgrade нет; want — DDL_REVISION
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
    ru: 'хабы с зарезервированными именами: {hubs} — имя занято методом цепочки или корня db, шаг с ним до класса может не дойти; с 2.0 такой хаб не создаётся, а его описание не меняется: переименуйте класс — заведите класс с другим именем и создайте в нём объекты заново',
  },
  // up.ts, stampDrift(): предупреждение connect() (его печатает index.ts) — схему той же ревизии обновила более новая
  // версия; was — версия из штампа схемы, version — версия пакета
  'boot.stamp_newer': {
    code: 'invalid_data',
    ru: 'схему {schema} обновила letopis {was}, библиотека старее ({version}) — обновите пакет: up() этой версией вернул бы прежние функции',
  },
  // up.ts, stampDrift(): функции схемы той же ревизии поставила другая версия — по записи на того, кто поставил:
  // неизвестная версия (в штампе нет engine=: комментарий правили руками), другая сборка той же версии, другая версия
  'boot.stamp_unknown': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила неизвестная версия letopis (в штампе нет версии движка), библиотека — {version}: обновите схему — вызовите up({ schema: '{schema}' })",
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
} satisfies Section<'boot'>;
