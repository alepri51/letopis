---
paths:
  - 'lib/sql/95-seed.system.sql'
  - 'lib/sql/seed.*.sql'
  - 'lib/src/demo/*.ts'
  - 'lib/scripts/gen-seed-booking.mjs'
synced: 447fae7
---
# M-SEEDS — системный сид и демо-домен booking (этапы 1, 2, 5)

**Инварианты и грабли**
- `lib/sql/95-seed.system.sql` — файл ядра: `install()` накатывает его в общем порядке (`engineFiles`, после `90-time`) от роли владельца при каждом `up()`; триггеры записи для владельца не срабатывают, поэтому `sys_create` сам пишет `log` и `entity` (rev 1, `op create`, автор — System, владелец — арендатор строки), для `Class` прогоняет `class_prepare` (не `class_admit`: строк-замков семейства не заводит), для `rule`/`Resource`/`member`/`Account`/`Class` зовёт `acl_bump()`. Строка с таким id уже есть — возврат без записи: сид повторяем, но правку строки сида повторный `up()` в существующую схему не вносит — она попадает только в свежую установку.
- System — постоянный id `@SYSTEM@` = `lib/src/up.ts:SYSTEM_ID`. Id системных строк — v5 в пространстве арендатора: класс — `v5_id(System, 'Class', [имя])`, ресурс — `[alias]`, правило — `[группа, объект]`.
- Описание `Resource`: `pattern` — объект, его маски `categories`, `roles`, `endpoint`, `class` — `{"type": "string"}`; маску не строкой (массив, число, `null`) отклоняет `invalid_data` при записи библиотекой, сырым SQL и загрузчиком. Такую маску, записанную в обход проверки, разбирает сопоставление прав (`acl_set_ok`, `acl_class_ok`) — M-ACCESS.
- `seed_system()` — аккаунт System (первым: служебные строки `secret` — `KEY`, `LOCK` — принадлежат ему, а внешний ключ `secret.account` требует его строку в `entity`), секрет `KEY` (ключ подписи пропуска прав, `meta.v` — счётчик прав, `meta.signals` — режим сигналов из константы `@SIGNALS@`: у существующей строки обновляется `on conflict do update`), системные классы `Class`, `Account`, `member`, `Resource`, `rule`, 12 ресурсов и 8 правил: запрет `any:API` по умолчанию (403), `auth.*` — сервису и `admin`, `letopis.signals` (`signals:API`, ключ сигналов) — сервису, `letopis.*` и `all:READ|WRITE|DELETE` — только `admin` (роль членства в System). Ресурсы API продукта сюда не кладутся. В конце — строки-замки (`secret` вида `LOCK`) семейств всех строк `Class` (`lib/sql/60-write.sql:family_rows`) и обслуживания (`<схема>:maintain`), чтобы первое обращение под нагрузкой их не вставляло: так их получают системные классы, а классы из `lib/sql/seed.*.sql` (`sys_create` строк-замков не заводит) — при следующем `up()` или первой записью в семейство.
- `sys_grant_all(арендатор)` — правило «аутентифицированным можно всё» в самом арендаторе (действует только на его строки); им пользуются `lib/src/up.ts:createTenant` (кроме `grantAll: false`), `lib/test/_engine.ts:tenant` (кроме `bare`), бенчи и полигоны. `sys_resource`/`sys_rule` — запись ресурса и правила от владельца для обвязки и тестов.
- `bootstrap_service(ключ)` — находит или создаёт аккаунт с категорией `Service` в System и добавляет ему `APIKEY` (`ident` — первые 12 знаков, `material` — sha256). Когда звать, решает `install()`: свой `serviceKey` — если живого ключа с его хэшем нет; иначе новый `lts_…`, только если живых `APIKEY` нет.
- Функции сида — владельцу, `revoke ... from public`: из сессии приложения не вызываются.
- Демо-домен: `lib/src/demo/booking.ts` — 18 моделей Zod (`hub`/`link` из `letopis/model`) в порядке «предок раньше потомка». Полиморфные концы: `Item: one(Element)`, `Part: one(Service, Product)`, самоссылка `Folder.Parent`; `booking` наследует `slot`, `Customer` при удалении — `unset`.
- `lib/sql/seed.booking.sql` генерируется (`bookingSeedSql`: строки `Class` System через `sys_create`, JSON — `m.describe()`), руками не править. Подключается только явно: `up({ seeds: ['booking'] })` → `lib/sql/seed.<имя>.sql`; в `engineFiles` не входит (нет номера).

**Что ещё менять вместе**
- Изменил модель в `lib/src/demo/booking.ts` — `cd lib && npm run seed:booking`, иначе падает сверка в `lib/test/demo.test.ts`; при смене состава классов — `BOOKING.length` там же и фикстура `lib/test/_salon.ts:seedSalon` (сырые insert под сессией), сценарии и бенчи на салоне (`lib/bench/salon-data.mjs`).
- Изменил набор ресурсов/правил `seed_system` — ожидания в `lib/test/system-classes.test.ts` (список alias, `rule().count()`), трасса `docs/atlas/F-BOOT.md`; влияние на права — карточка M-ACCESS.
- Изменил функции `lib/sql/95-seed.system.sql` — их зовут `lib/src/up.ts` (`install`, `createTenant`), `lib/test/_engine.ts`, `lib/test/_access.ts`, тесты и бенчи (grep имени по `lib/`).
- Новый побочный эффект записи строки `Class` или прав в триггерах (`lib/sql/60-write.sql:trg_entity_ai`, `class_admit`) — повторить в `sys_create`, если он нужен и строкам сида (как `acl_bump`): владелец триггеры записи не вызывает.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/demo.test.ts test/system-classes.test.ts`; шире — `lib/test/scenario-salon.test.ts`, `lib/test/chain-types.test.ts`.
- `cd lib && npm run check:docs`.

**Точки входа**
- `lib/sql/95-seed.system.sql:seed_system` — системный сид установки
- `lib/sql/95-seed.system.sql:sys_create` — первая версия строки от владельца
- `lib/sql/95-seed.system.sql:bootstrap_service` — сервисный аккаунт и ключ
- `lib/src/demo/booking.ts:BOOKING` — модели демо-домена
- `lib/src/demo/booking.ts:bookingSeedSql` — текст `lib/sql/seed.booking.sql`
- `lib/src/up.ts:install` — накат ядра и сидов `opts.seeds`
