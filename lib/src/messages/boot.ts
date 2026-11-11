/**
 * Раздел boot: up.ts, pglite.ts, house.ts — установщик (setup, demolish), PGlite и пропуск консьержа.
 */
import type { Section } from './types.js';

export const boot = {
  // up.ts, substitute(): в тексте SQL (ядро, свой сид) маркер, которого установщик не знает
  'boot.unknown_marker': {
    code: 'invalid_data',
    ru: 'setup: неизвестный маркер {marker} в SQL',
    hint: 'в своём сиде — только маркеры установщика (@SCHEMA@, @OWNER@, @APP@, @SYSTEM@ и другие — таблица в sql/README.md пакета)',
  },
  // up.ts, install(): имя схемы не вида v<N>.<имя>
  'boot.install_schema_name': {
    code: 'invalid_data',
    ru: 'setup: bad schema name "{schema}" (нужно v<N>.<имя>)',
    hint: 'полное имя схемы — v<N>.<имя>: имя из строчных латинских букв, цифр и «_», не с цифры, например v2.salon',
  },
  // up.ts, install(): имя роли владельца или приложения (опции owner, app) не по правилу
  'boot.role_name': {
    code: 'invalid_data',
    ru: 'setup: bad role name "{role}"',
    hint: 'имя роли (owner, app) — строчные латинские буквы, цифры и «_», не с цифры, до 63 знаков; владелец по умолчанию — letopis_owner, служебная роль дома — letopis_a_<имя дома>',
  },
  // up.ts, install(): режим сигналов не из списка; modes — допустимые через запятую
  'boot.signals_mode': {
    code: 'invalid_data',
    ru: 'setup: signals — {modes}, а не {signals}',
    hint: "передать signals: 'class' (по умолчанию у нового дома), 'tenant', 'opaque' или 'none' — или не передавать: setup() оставит режим дома",
  },
  // up.ts, install(): роль владельца создал кто-то другой, а у установщика нет на неё ADMIN OPTION
  'boot.owner_no_admin': {
    code: 'admin_required',
    ru: 'setup: роль {owner} уже есть, а у установщика нет на неё ADMIN OPTION — установку ведёт роль, создавшая {owner}, или роль с этим правом (grant {owner} to <установщик> with admin option)',
    hint: 'запустить setup() ролью, создавшей роль владельца, или суперпользователем — либо выдать установщику grant <владелец> to <установщик> with admin option',
  },
  // up.ts, install(): имя сида пакета (не путь к .sql) не по правилу
  'boot.seed_name': {
    code: 'invalid_data',
    ru: 'setup: bad seed name "{seed}"',
    hint: "сид пакета — имя из строчных латинских букв, цифр и «-» (например, 'booking'), свой сид — путь к файлу .sql",
  },
  // up.ts, setup(): нет мастер-ключа и нет pglite
  'boot.no_connection': {
    code: 'invalid_data',
    ru: 'setup: нужен мастер-ключ — строка подключения администратора PostgreSQL',
    hint: "передать первым аргументом строку подключения администратора, например setup('postgres://postgres:пароль@localhost:5432/app', 'shop'), или pglite: true для разработки без своего сервера",
  },
  // up.ts, ensureLogin(): роль консьержа уже есть и она привилегированная, роль-владелец или служебная роль дома
  // (letopis_a_<имя>) — её пароль setup() не меняет
  'boot.login_privileged': {
    code: 'invalid_data',
    ru: 'setup: роль консьержа {user} уже есть и она привилегированная (суперпользователь, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS, роль-владелец или входит в неё) или это служебная роль дома — такую роль setup() не трогает',
    hint: 'снять с роли консьержа (имя — в тексте ошибки) эти атрибуты и отозвать у неё роль владельца — или удалить её (drop role): setup() заведёт её заново',
  },
  // up.ts, ensureLogin(): установщик не может выдать служебную роль дома (letopis_a_<имя>) роли консьержа (PostgreSQL 16+: нужен
  // ADMIN OPTION, SQLSTATE 42501 «permission denied to grant role»); app — служебная роль, installer — роль установщика
  // (current_user)
  'boot.login_grant_denied': {
    code: 'invalid_data',
    ru: 'setup: роль {installer} не может выдать роль {app} роли консьержа {user} — нужен ADMIN OPTION на роль {app} (grant {app} to {installer} with admin option) или суперпользователь',
    hint: 'выполнить от суперпользователя grant <служебная роль> to <установщик> with admin option (имена — в тексте ошибки) и повторить setup() — или строить дом от суперпользователя',
  },
  // up.ts, refuseOld(): ревизия из комментария схемы ниже FIRST_REVISION или штампа ревизии нет (rev 0); отказ setup() —
  // до любых изменений, connect() — до входа по ключу; want — FIRST_REVISION
  'boot.schema_old': {
    code: 'invalid_data',
    ru: 'дом {schema} ревизии {rev}, а пакет работает с ревизией {want}: такой дом не обновляется — снесите его demolish() и постройте заново setup(), данные не переносятся',
    hint: "снести дом demolish(ADMIN_DSN, 'имя') и построить заново setup(ADMIN_DSN, 'имя'): данные старого дома не переносятся",
  },

  // up.ts и pglite.ts: обычный Error с префиксом letopis.setup (у install() и checkServer() — letopis.up), подходящего
  // кода нет — текст по записи (lmsg), код записи при броске не берётся
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
  // up.ts, build(): база не ответила за waitTimeoutMs; host — хост строки подключения, seconds — срок в секундах
  'boot.wait_timeout': {
    code: 'invalid_query',
    ru: 'база {host} не готова за {seconds} с',
  },
  // up.ts, build(): ревизия схемы новее пакета; rev — ревизия схемы, known — DDL_REVISION
  'boot.schema_newer': {
    code: 'invalid_data',
    ru: 'дом {schema} ревизии {rev}, а библиотека знает только {known} — обновите пакет',
  },
  // pglite.ts, startPglite(): нет пакета PGlite; name — имя пакета
  'boot.pglite_package': {
    code: 'invalid_query',
    ru: 'для pglite нужен пакет {name} — npm i -D @electric-sql/pglite @electric-sql/pglite-socket',
  },
  // up.ts, checkServer(): предупреждение (SetupResult.warnings, lmsg) — сервер ниже 18.2; version — вида 18.1
  'boot.pg_clog': {
    code: 'invalid_query',
    ru: 'PostgreSQL {version}: до 18.2 сервер мог усечь CLOG, который ещё нужен непрочитанным сигналам NOTIFY; обновите сервер до 18.2 или новее',
  },
  // up.ts, build(): предупреждение (SetupResult.warnings) — после ANALYZE от роли владельца у таблиц всё ещё нет статистики;
  // tables — схема.таблица через запятую
  'boot.analyze_skipped': {
    code: 'invalid_query',
    ru: 'таблицы без статистики после ANALYZE от роли владельца {owner}: {tables} — проверьте, что они принадлежат ей; иначе статистику соберёт автоочистка или ANALYZE их владельца',
  },
  // up.ts, build(): предупреждение (SetupResult.warnings) — в схеме есть хабы с именами из RESERVED_CLASS_NAMES, заведённые
  // мимо проверки базы: setup() их оставляет; hubs — «имя (квартира)» через запятую
  'boot.reserved_hubs': {
    code: 'invalid_class',
    ru: 'хабы с зарезервированными именами: {hubs} — имя занято методом цепочки или корня db, шаг с ним до класса может не дойти; такой хаб не создаётся, а его описание не меняется: переименуйте класс — заведите класс с другим именем и создайте в нём объекты заново',
  },
  // up.ts, stampDrift(): предупреждение connect() (его печатает core.ts) — схему той же ревизии обновила более новая
  // версия; was — версия из штампа схемы, version — версия пакета
  'boot.stamp_newer': {
    code: 'invalid_data',
    ru: 'схему {schema} обновила letopis {was}, библиотека старее ({version}) — обновите пакет: setup() этой версией вернул бы функции старой версии',
  },
  // up.ts, stampDrift(): функции схемы той же ревизии поставила другая версия — по записи на того, кто поставил:
  // неизвестная версия (в штампе нет engine=: комментарий правили руками), другая сборка той же версии, другая версия
  'boot.stamp_unknown': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила неизвестная версия letopis (в штампе нет версии движка), библиотека — {version}: обновите дом — вызовите setup() с его именем",
  },
  'boot.stamp_other_build': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила другая сборка letopis {was}, библиотека — {version}: обновите дом — вызовите setup() с его именем",
  },
  'boot.stamp_other_version': {
    code: 'invalid_data',
    ru: "функции схемы {schema} поставила letopis {was}, библиотека — {version}: обновите дом — вызовите setup() с его именем",
  },
  // up.ts: ход установки в консоли (lmsg, префикс letopis.setup добавляет setup()) — тексты не для ошибки, код не печатается.
  // ensureDatabase(): база создана
  'boot.log_database_created': {
    code: 'invalid_query',
    ru: 'база {name} создана',
  },
  // итог наката — по записи на исход; revision — ревизия после наката
  'boot.log_installed': {
    code: 'invalid_query',
    ru: 'дом построен: {schema}, ревизия {revision}',
  },
  'boot.log_reapplied': {
    code: 'invalid_query',
    ru: 'повторный накат: {schema}, ревизия {revision}',
  },
  // up.ts, setup(), demolish(): name — переданное имя дома
  'boot.setup_name': {
    code: 'invalid_data',
    ru: 'имя дома {name}: латинские строчные буквы, цифры и подчёркивание, с буквы или подчёркивания, до 41 знака',
  },
  // up.ts, setup(): дома в этой базе нет, а его роли уже держат права в другой базе сервера — там живёт дом с тем же
  // именем; name — имя дома, database — та база
  'boot.house_elsewhere': {
    code: 'exists',
    ru: 'дом «{name}» уже есть в базе {database} этого сервера: роли дома (letopis_c_{name}, letopis_a_{name}) общие на весь сервер PostgreSQL — второй дом с этим именем сломал бы пропуск первого',
    hint: "дать дому в этой базе другое имя — setup(ADMIN_DSN, 'другое_имя'): имя дома должно быть одно на сервер, а не на базу",
  },
  // up.ts, setup(): value — переданное значение
  'boot.setup_default_rule': {
    code: 'invalid_data',
    ru: 'defaultRule {value}: нужно deny или allow',
  },
  // up.ts, setup({ pglite })
  'boot.pglite_no_rls': {
    code: 'invalid_query',
    ru: 'PGlite: подключение суперпользователем — права и изоляция квартир здесь не проверяются; для проверки прав нужен PostgreSQL 18',
  },
  // up.ts, conciergePass(): дома нет или у него нет пропуска (CLI letopis sync)
  'boot.no_pass': {
    code: 'invalid_data',
    ru: 'дом {schema}: нет пропуска консьержа — дом не построен или построен не setup()',
    hint: "построить дом setup(ADMIN_DSN, 'имя') — он заведёт консьержа и его пропуск",
  },
  // house.ts, connect(): строка — не пропуск setup()
  'boot.pass_invalid': {
    code: 'invalid_data',
    ru: 'это не пропуск консьержа: нужна строка, которую вернул setup() (в ней letopis_schema и letopis_key)',
  },
  // house.ts, connect(): роль консьержа не пустила (28P01, 28000) — пароль сменён setup({ rotate }) или дом снесён
  'boot.pass_stale': {
    code: 'auth_failed',
    ru: 'пропуск не подошёл: пароль консьержа сменён (setup({ rotate })) или дом снесён — нужен нынешний пропуск',
    hint: "повторный setup(ADMIN_DSN, 'имя') отдаёт нынешний пропуск дома",
  },
} satisfies Section<'boot'>;
