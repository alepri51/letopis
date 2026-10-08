---
paths:
  - 'lib/sql/95-seed.system.sql'
  - 'lib/sql/seed.*.sql'
  - 'lib/src/demo/*.ts'
  - 'lib/scripts/gen-seed-booking.mjs'
synced: 2e5bcbd
---
# M-SEEDS — системный сид и демо-домен booking (этапы 1, 2, 5)

**Инварианты и грабли**
- `95-seed.system.sql` — файл ядра: `install()` накатывает его в общем порядке (`engineFiles`, после `90-time`) от роли владельца; триггеры для владельца не срабатывают, поэтому `sys_create` сам пишет `entity` и `log` (rev 1, `op create`, автор и владелец = System), для `Class` прогоняет `class_prepare`, для `rule`/`Resource`/`member`/`Account`/`Class` зовёт `acl_bump()`. Строка с таким id уже есть — возврат без записи, поэтому сид повторяем.
- System — постоянный id `@SYSTEM@` = `SYSTEM_ID` из `up.ts`. Id системных строк — v5 в пространстве арендатора: класс — `v5_id(System, 'Class', [имя])`, ресурс — `[alias]`, правило — `[группа, объект]`.
- `seed_system()` — секрет `KEY` (ключ подписи пропуска прав, `meta.v` — счётчик прав), аккаунт System, системные классы `Class`, `Account`, `member`, `Resource`, `rule`, 11 ресурсов и 7 правил: запрет `any:API` по умолчанию (403), `auth.*` — сервису и `admin`, `letopis.*` и `all:READ|WRITE|DELETE` — только `admin` (роль членства в System). Его же вызывает `reset({ all })` (`90-time.sql`) после `truncate`. Ресурсы API продукта сюда не кладутся.
- `sys_grant_all(арендатор)` — правило «аутентифицированным можно всё» в самом арендаторе (действует только на его строки); им пользуются `_engine.ts:tenant` (кроме `bare`), бенчи и полигоны. `sys_resource`/`sys_rule` — запись ресурса и правила от владельца для обвязки и тестов.
- `bootstrap_service(ключ)` — находит или создаёт аккаунт с категорией `Service` в System и добавляет ему `APIKEY` (`ident` — первые 12 знаков, `material` — sha256). Когда звать, решает `install()` (свой `serviceKey` — если его хэша ещё нет; иначе новый `lts_…`, только если живых `APIKEY` нет) и `reset({ all })`.
- Функции сида — владельцу, `revoke ... from public`: из сессии приложения не вызываются.
- Демо-домен: `demo/booking.ts` — 18 моделей Zod (`hub`/`link` из `letopis/model`) в порядке «предок раньше потомка»; корни 0.21 `Entity` и `link` опущены. Полиморфные концы: `Item: one(Element)`, `Part: one(Service, Product)`, самоссылка `Folder.Parent`; `booking` наследует `slot`, `Customer` при удалении — `unset`.
- `seed.booking.sql` генерируется (`bookingSeedSql`: строки `Class` System через `sys_create`, JSON — `m.describe()`), руками не править. Подключается только явно: `up({ seeds: ['booking'] })` → `sql/seed.<имя>.sql`; в `engineFiles` не входит (нет номера).

**Что ещё менять вместе**
- Изменил модель в `demo/booking.ts` — `cd lib && npm run seed:booking`, иначе падает сверка в `demo.test.ts`; при смене состава классов — `BOOKING.length` там же и фикстура `lib/test/_salon.ts:seedSalon` (сырые insert под сессией), сценарии и бенчи на салоне (`bench/salon-data.mjs`).
- Изменил набор ресурсов/правил `seed_system` — ожидания в `system-classes.test.ts` (список alias, `rule().count()`), трасса `docs/atlas/F-BOOT.md`; влияние на права — карточка M-ACCESS.
- Изменил функции `95-seed.system.sql` — их зовут `up.ts` (`bootstrap_service`), `90-time.sql` (`reset`), `test/_engine.ts`, `test/_access.ts`, бенчи; та же функция описана в карточке M-BOOTSTRAP.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/demo.test.ts test/system-classes.test.ts`; шире — `test/scenario-salon.test.ts`, `test/chain-types.test.ts`.
- `cd lib && npm run check:docs`.

**Точки входа**
- `lib/sql/95-seed.system.sql:seed_system` — системный сид (установка и `reset({ all })`)
- `lib/sql/95-seed.system.sql:sys_create` — первая версия строки от владельца
- `lib/sql/95-seed.system.sql:sys_grant_all` — правило «можно всё» в арендаторе
- `lib/sql/95-seed.system.sql:bootstrap_service` — сервисный аккаунт и ключ
- `lib/src/demo/booking.ts:BOOKING` — модели демо-домена
- `lib/src/demo/booking.ts:bookingSeedSql` — текст `seed.booking.sql`
- `lib/scripts/gen-seed-booking.mjs` — `npm run seed:booking`
- `lib/src/up.ts:install` — накат ядра и сидов `opts.seeds`
