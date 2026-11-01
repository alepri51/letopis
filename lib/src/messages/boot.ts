/**
 * Раздел boot: up.ts, pglite.ts, import.ts — установщик, PGlite, импорт из 0.21.
 */
import type { Section, Text } from './types.js';

/** Подсказка отказов up({ login }): что передать. */
const LOGIN: Text = {
  ru: 'передать login: { user, password } — имя обычной роли входа (непустое, до 63 байт, не pg_…) и её пароль (непустая строка)',
  en: 'pass login: { user, password } — the name of a plain login role (non-empty, up to 63 bytes, not pg_…) and its password (a non-empty string)',
};
/** Подсказка отказов user.roles в createTenant() и up({ tenant }). */
const ROLES: Text = {
  ru: "передать user.roles — список разных имён ролей членства, например ['staff'], или не передавать: по умолчанию ['owner']",
  en: "pass user.roles — a list of distinct membership role names, for example ['staff'], or omit it: the default is ['owner']",
};
/** Подсказка отказов createTenant() об удалённой строке. */
const GONE: Text = {
  ru: 'вернуть удалённое restore() (текст называет, кто это может) или выбрать другое имя или логин: id вычисляется из них',
  en: 'bring the deleted row back with restore() (the text names who can do it) or choose another name or login: the id is computed from them',
};
/** Подсказка отказов импорта до первой записи. */
const STOPPED: Text = {
  ru: 'импорт ничего не записал: строки 0.21, которые его остановили, — в detail.rows (класс, id, код, сообщение); исправить их в источнике или импортировать класс без ключа (--keyless <класс>)',
  en: 'the import wrote nothing: the 0.21 rows that stopped it are in detail.rows (class, id, code, message); fix them in the source or import the class without a key (--keyless <class>)',
};

export const boot = {
  // up.ts, substitute(): в тексте SQL (ядро, миграция, свой сид) маркер, которого установщик не знает
  'boot.unknown_marker': {
    code: 'invalid_data',
    ru: 'up: неизвестный маркер {marker} в SQL',
    en: 'up: unknown marker {marker} in SQL',
    hint: {
      ru: 'в своём сиде — только маркеры установщика (@SCHEMA@, @OWNER@, @APP@, @SYSTEM@ и другие — таблица в sql/README.md пакета)',
      en: 'use only installer markers in your own seed (@SCHEMA@, @OWNER@, @APP@, @SYSTEM@ and others — the table in sql/README.md of the package)',
    },
  },
  // up.ts, install(): имя схемы не вида v<N>.<имя>
  'boot.install_schema_name': {
    code: 'invalid_data',
    ru: 'up: bad schema name "{schema}" (нужно v<N>.<имя>)',
    en: 'up: bad schema name "{schema}" (expected v<N>.<name>)',
    hint: {
      ru: 'полное имя схемы — v<N>.<имя>: имя из строчных латинских букв, цифр и «_», не с цифры, например v2.salon',
      en: 'the full schema name is v<N>.<name>: a name of lowercase Latin letters, digits and "_", not starting with a digit, for example v2.salon',
    },
  },
  // up.ts, install(): имя роли владельца или приложения (опции owner, app) не по правилу
  'boot.role_name': {
    code: 'invalid_data',
    ru: 'up: bad role name "{role}"',
    en: 'up: bad role name "{role}"',
    hint: {
      ru: 'имя роли (owner, app) — строчные латинские буквы, цифры и «_», не с цифры, до 63 знаков; по умолчанию letopis_owner и letopis_app',
      en: 'a role name (owner, app) is lowercase Latin letters, digits and "_", not starting with a digit, up to 63 characters; the defaults are letopis_owner and letopis_app',
    },
  },
  // up.ts, install(): режим сигналов не из списка; modes — допустимые через запятую
  'boot.signals_mode': {
    code: 'invalid_data',
    ru: 'up: signals — {modes}, а не {signals}',
    en: 'up: signals is one of {modes}, not {signals}',
    hint: {
      ru: "передать signals: 'class' (по умолчанию у новой схемы), 'tenant', 'opaque' или 'none' — или не передавать: up() оставит режим схемы",
      en: "pass signals: 'class' (the default for a new schema), 'tenant', 'opaque' or 'none' — or omit it: up() keeps the mode of the schema",
    },
  },
  // up.ts, install(): роль владельца создал кто-то другой, а у установщика нет на неё ADMIN OPTION (план 2.0, 7.5 №3)
  'boot.owner_no_admin': {
    code: 'admin_required',
    ru: 'up: роль {owner} уже есть, а у установщика нет на неё ADMIN OPTION — установку ведёт роль, создавшая {owner}, или роль с этим правом (grant {owner} to <установщик> with admin option)',
    en: 'up: role {owner} already exists, and the installer has no ADMIN OPTION on it — the installation is run by the role that created {owner} or by a role with this right (grant {owner} to <installer> with admin option)',
    hint: {
      ru: 'запустить up() ролью, создавшей роль владельца, или суперпользователем — либо выдать установщику grant <владелец> to <установщик> with admin option',
      en: 'run up() as the role that created the owner role or as a superuser — or give the installer grant <owner> to <installer> with admin option',
    },
  },
  // up.ts, install(): имя сида пакета (не путь к .sql) не по правилу
  'boot.seed_name': {
    code: 'invalid_data',
    ru: 'up: bad seed name "{seed}"',
    en: 'up: bad seed name "{seed}"',
    hint: {
      ru: "сид пакета — имя из строчных латинских букв, цифр и «-» (например, 'booking'), свой сид — путь к файлу .sql",
      en: "a package seed is a name of lowercase Latin letters, digits and \"-\" (for example, 'booking'); your own seed is a path to an .sql file",
    },
  },
  // up.ts, install(): свой ключ сервиса (serviceKey) не по формату
  'boot.service_key_format': {
    code: 'invalid_data',
    ru: 'up: serviceKey — lts_ и не меньше 32 шестнадцатеричных знаков',
    en: 'up: serviceKey is lts_ followed by at least 32 hexadecimal digits',
    hint: {
      ru: 'передать serviceKey вида lts_ и 32–128 шестнадцатеричных знаков в нижнем регистре — или не передавать: up() выпустит ключ сам',
      en: 'pass serviceKey as lts_ followed by 32–128 lowercase hexadecimal digits — or omit it: up() issues a key itself',
    },
  },
  // up.ts, up(): имя схемы ни <имя>, ни v<N>.<имя>
  'boot.up_schema_name': {
    code: 'invalid_data',
    ru: 'up: bad schema name "{schema}" (нужно <имя> или v<N>.<имя>)',
    en: 'up: bad schema name "{schema}" (expected <name> or v<N>.<name>)',
    hint: {
      ru: 'имя схемы — <имя> (версия структуры подставится сама) или v<N>.<имя>; имя — строчные латинские буквы, цифры и «_», не с цифры: например, salon или v2.salon',
      en: 'the schema name is <name> (the structure version is added by itself) or v<N>.<name>; the name is lowercase Latin letters, digits and "_", not starting with a digit: for example, salon or v2.salon',
    },
  },
  // up.ts, up(): нет ни dsn, ни sql, ни pglite
  'boot.no_connection': {
    code: 'invalid_data',
    ru: 'up: нужен dsn или sql',
    en: 'up: dsn or sql is required',
    hint: {
      ru: 'передать dsn — строку подключения администратора, sql — готовый пул postgres.js или pglite: true для разработки без своего сервера',
      en: 'pass dsn — an admin connection string, sql — a ready postgres.js pool, or pglite: true for development without your own server',
    },
  },
  // up.ts, up({ login }): login — не объект
  'boot.login_not_object': {
    code: 'invalid_data',
    ru: 'up({ login }): нужен объект { user, password }',
    en: 'up({ login }): an object { user, password } is required',
    hint: LOGIN,
  },
  // up.ts, up({ login }): имя роли пустое, длиннее 63 байт, с pg_ или нулевым байтом; user — значение в JSON
  'boot.login_user': {
    code: 'invalid_data',
    ru: 'up({ login }): user {user} — имя роли: непустое, до 63 байт, не pg_…',
    en: 'up({ login }): user {user} — a role name: non-empty, up to 63 bytes, not pg_…',
    hint: LOGIN,
  },
  // up.ts, up({ login }): пароль — не строка, пустой или с нулевым байтом
  'boot.login_password': {
    code: 'invalid_data',
    ru: 'up({ login }): password — непустая строка',
    en: 'up({ login }): password is a non-empty string',
    hint: LOGIN,
  },
  // up.ts, up({ login }): роль привилегированная, роль-владелец или сама роль приложения — её пароль не меняется
  'boot.login_privileged': {
    code: 'invalid_data',
    ru: 'up({ login }): роль {user} — привилегированная (суперпользователь, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS, роль-владелец или её член) или сама роль приложения: роль приложения — обычная роль входа, привилегированную up() не трогает',
    en: 'up({ login }): role {user} is privileged (a superuser, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS, the owner role or its member) or is the application role itself: the application role is a plain login role, and up() leaves a privileged one alone',
    hint: {
      ru: 'выбрать для login другое имя — роль без этих атрибутов и без членства в роли владельца',
      en: 'choose another name for login — a role without these attributes and without membership in the owner role',
    },
  },
  // up.ts, createTenant() и up({ tenant }): нет имени арендатора
  'boot.tenant_name_required': {
    code: 'invalid_data',
    ru: 'createTenant: имя арендатора обязательно',
    en: 'createTenant: the tenant name is required',
    hint: {
      ru: 'передать name — имя арендатора: из него вычисляется id, поэтому одно имя — всегда один и тот же арендатор',
      en: 'pass name — the tenant name: the id is computed from it, so one name is always the same tenant',
    },
  },
  // up.ts, createTenant() и up({ tenant }): вид пароля user.kind не по правилу функций кредов; kind — значение в JSON,
  // kinds — служебные виды через запятую
  'boot.tenant_kind': {
    code: 'invalid_data',
    ru: 'createTenant: user.kind {kind} — вид пароля: заглавная латинская буква, затем заглавные буквы, цифры или «_», всего от 2 до 32 знаков; служебные виды {kinds} заняты (по умолчанию — PASSWORD)',
    en: 'createTenant: user.kind {kind} — a password kind: an uppercase Latin letter, then uppercase letters, digits or "_", from 2 to 32 characters in total; the service kinds {kinds} are taken (the default is PASSWORD)',
    hint: {
      ru: "не передавать user.kind (вход по паролю — вид PASSWORD) или передать вид по правилу auth.setPassword, например 'PIN'",
      en: "omit user.kind (a password login is the PASSWORD kind) or pass a kind by the auth.setPassword rule, for example 'PIN'",
    },
  },
  // up.ts, createTenant() и up({ tenant }): user.roles — не список или пустой
  'boot.tenant_roles_empty': {
    code: 'invalid_data',
    ru: "createTenant: user.roles — непустой список ролей, например ['staff']",
    en: "createTenant: user.roles is a non-empty list of roles, for example ['staff']",
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роль в user.roles — не строка; type — null или typeof значения
  'boot.tenant_role_type': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роль — строка, а не {type}',
    en: 'createTenant: user.roles — a role is a string, not {type}',
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роль — маска группы, пустая или с пробелами по краям; role — значение в JSON
  'boot.tenant_role_mask': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роль {role}: нужно имя роли, а не маска группы — не пустое, без пробелов по краям, запятых, фигурных скобок и «!» в начале',
    en: 'createTenant: user.roles — role {role}: a role name is needed, not a group mask — non-empty, without spaces at the edges, commas, curly braces and "!" at the start',
    hint: ROLES,
  },
  // up.ts, createTenant() и up({ tenant }): роли в user.roles повторяются
  'boot.tenant_roles_repeat': {
    code: 'invalid_data',
    ru: 'createTenant: user.roles — роли повторяются',
    en: 'createTenant: user.roles — the roles repeat',
    hint: ROLES,
  },
  // up.ts, createTenant(): строки арендатора нет, а его история в журнале есть
  'boot.tenant_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: арендатор «{name}» ({id}) удалён, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.Account(id).restore() от имени системного администратора или выберите другое имя',
    en: 'createTenant: tenant "{name}" ({id}) is deleted, and its history remains in the log — a repeat does not bring the deleted back: restore it with db.Account(id).restore() as a system administrator or choose another name',
    hint: GONE,
  },
  // up.ts, createTenant(): строки аккаунта пользователя нет, а его история в журнале есть
  'boot.tenant_user_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: аккаунт пользователя {login} ({id}) удалён, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.Account(id).restore() от имени системного администратора или выберите другой логин',
    en: 'createTenant: user account {login} ({id}) is deleted, and its history remains in the log — a repeat does not bring the deleted back: restore it with db.Account(id).restore() as a system administrator or choose another login',
    hint: GONE,
  },
  // up.ts, createTenant(): строки членства нет, а его история в журнале есть
  'boot.tenant_member_deleted': {
    code: 'invalid_data',
    ru: 'createTenant: членство {login} в арендаторе «{name}» ({id}) удалено, а его история осталась в журнале — повтор удалённое не воскрешает: верните его db.member(id).restore() в этом арендаторе или выберите другой логин',
    en: 'createTenant: the membership of {login} in tenant "{name}" ({id}) is deleted, and its history remains in the log — a repeat does not bring the deleted back: restore it with db.member(id).restore() in this tenant or choose another login',
    hint: GONE,
  },

  // import.ts, buildClasses(): класса из --keyless нет в таблице Schema 0.21
  'boot.import_keyless_unknown': {
    code: 'invalid_data',
    ru: 'import: --keyless {cls} — такого класса в 0.21 нет',
    en: 'import: --keyless {cls} — there is no such class in 0.21',
    hint: {
      ru: 'назвать в --keyless классы 0.21 по их id в таблице Schema источника',
      en: 'name 0.21 classes in --keyless by their ids in the Schema table of the source',
    },
  },
  // import.ts, import021(): --initial вместе с --update или --commit-every
  'boot.import_initial_conflict': {
    code: 'invalid_data',
    ru: 'import --initial несовместим с --update и --commit-every: первая заливка — одна транзакция в пустую схему',
    en: 'import --initial is incompatible with --update and --commit-every: the initial load is one transaction into an empty schema',
    hint: {
      ru: 'первую заливку запускать без --update и --commit-every; дописывать и обновлять — следующими импортами без --initial',
      en: 'run the initial load without --update and --commit-every; append and update with later imports without --initial',
    },
  },
  // import.ts, import021(): в схеме 0.21 нет строк Schema этой партиции
  'boot.import_no_classes': {
    code: 'invalid_data',
    ru: 'import: в {schema} нет классов партиции {partition}',
    en: 'import: {schema} has no classes of partition {partition}',
    hint: {
      ru: 'проверить --from-schema (схема 0.21 вида v1.<имя>) и --partition (по умолчанию entity)',
      en: 'check --from-schema (a 0.21 schema like v1.<name>) and --partition (entity by default)',
    },
  },
  // import.ts, import021(): данные лежат у аккаунта System 0.21, а --tenant не задан
  'boot.import_tenant_required': {
    code: 'invalid_data',
    ru: 'import: данные лежат у аккаунта System — укажите арендатора для них (--tenant <имя>)',
    en: 'import: the data belongs to the System account — specify a tenant for it (--tenant <name>)',
    hint: {
      ru: 'передать --tenant <имя> (опция tenant): данные аккаунта System лягут в арендатора с этим именем',
      en: 'pass --tenant <name> (the tenant option): the data of the System account goes to the tenant with this name',
    },
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — класс объекта 0.21 не найден или опущен
  'boot.import_class_missing': {
    code: 'invalid_class',
    ru: 'класс {cls} не найден или опущен',
    en: 'class {cls} is not found or omitted',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — id из ключа не вычислить
  'boot.import_key_unresolved': {
    code: 'target_not_found',
    ru: 'ключ объекта ссылается на отсутствующий объект или значение ключа — не строка',
    en: 'the object key references a missing object or a key value is not a string',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — два объекта 0.21 получают один id 1.0; cls и old —
  // класс и id первого, keyless — класс для --keyless
  'boot.import_same_id': {
    code: 'duplicate',
    ru: 'тот же id 1.0 ({id}), что у {cls} {old}: данные 0.21 нарушают ключ класса — импортируйте класс без ключа (--keyless {keyless})',
    en: 'the same 1.0 id ({id}) as {cls} {old}: the 0.21 data violates the class key — import the class without a key (--keyless {keyless})',
  },
  // import.ts, import021(): сообщение строки detail.rows (lmsg) — значение ключа менялось между версиями объекта
  'boot.import_key_changed': {
    code: 'invalid_data',
    ru: 'значение ключа менялось между версиями — в 1.0 ключ неизменен (--keyless)',
    en: 'the key value changed between versions — a key is immutable in 1.0 (--keyless)',
  },
  // import.ts, import021(): проверки до записи остановили импорт — по записи на код первой строки, без и с «и ещё»;
  // cls, id, message — первая строка, more — сколько ещё
  'boot.import_stopped_invalid_class': {
    code: 'invalid_class',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    en: 'import: stopped before writing — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_class_more': {
    code: 'invalid_class',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    en: 'import: stopped before writing — {cls} {id}: {message} (and {more} more)',
    hint: STOPPED,
  },
  'boot.import_stopped_target_not_found': {
    code: 'target_not_found',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    en: 'import: stopped before writing — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_target_not_found_more': {
    code: 'target_not_found',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    en: 'import: stopped before writing — {cls} {id}: {message} (and {more} more)',
    hint: STOPPED,
  },
  'boot.import_stopped_duplicate': {
    code: 'duplicate',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    en: 'import: stopped before writing — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_duplicate_more': {
    code: 'duplicate',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    en: 'import: stopped before writing — {cls} {id}: {message} (and {more} more)',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_data': {
    code: 'invalid_data',
    ru: 'import: остановлен до записи — {cls} {id}: {message}',
    en: 'import: stopped before writing — {cls} {id}: {message}',
    hint: STOPPED,
  },
  'boot.import_stopped_invalid_data_more': {
    code: 'invalid_data',
    ru: 'import: остановлен до записи — {cls} {id}: {message} (и ещё {more})',
    en: 'import: stopped before writing — {cls} {id}: {message} (and {more} more)',
    hint: STOPPED,
  },
  // import.ts, import021(): загрузчик отменил загрузку данных арендатора, строки detail.rows переведены в объекты 0.21 —
  // по записи на каждый код нарушения загрузчика (код ошибки — её код); message — текст ошибки загрузчика
  'boot.import_load_acl_denied': {
    code: 'acl_denied',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_class_not_loadable': {
    code: 'class_not_loadable',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_deleted': {
    code: 'deleted',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_derived_class': {
    code: 'derived_class',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_duplicate': {
    code: 'duplicate',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_exists': {
    code: 'exists',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_invalid_class': {
    code: 'invalid_class',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_invalid_data': {
    code: 'invalid_data',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_target_not_found': {
    code: 'target_not_found',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
  'boot.import_load_tenant_denied': {
    code: 'tenant_denied',
    ru: 'import: арендатор {tenant}: {message}',
    en: 'import: tenant {tenant}: {message}',
  },
} satisfies Section<'boot'>;
