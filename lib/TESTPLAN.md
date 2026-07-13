# Тест-план «Салон» — сквозная проверка ВСЕХ API letopis

**Цель.** Один реалистичный сценарий работы салона красоты, в котором задействована
каждая публичная точка API библиотеки letopis (145 точек — см. матрицу в конце).
План исполняемый: `lib/test/salon.test.ts`, 21 акт, схема `v1.salon` (booking-домен,
изолирована). Каждый акт помечает покрываемые точки `[#N]`.

**Окружение.**
- PostgreSQL/TimescaleDB (dev-контейнер `letopis-timescale`, порт 15432) + Redis (16379).
- `before`: `DROP SCHEMA v1.salon` → `apply.mjs --schema=salon --version=1` → `connect` → Redis.
- Прогон: `cd lib && npx tsx --test --test-force-exit test/salon.test.ts` (или `npm test` — весь набор).
- Все данные детерминированы: смены дня 10:00–18:00 (окно = интервал доступности);
  id связок считает Schema (`attributes.id`: окно/запись/навык/состав/содержимое/адрес/
  Услуга/Товар/Комплекс — uuid v5 из концов и полей, остальные — v7) — формула открыта,
  id известны до создания; запись НАСЛЕДУЕТ v5-правило окна (двойная бронь мертва самим id);
  ввод паролей/ключей/кодов реальный (scrypt/sha256/TOTP/OTP на живых БД+Redis).

**Домен салона (Schema.links v2, модель 0.17 — позитивная доступность).**
```
Организация ─< Мастер/Клиент[Org] (← Контрагент) · Локация[Org] · Расписание[Org]
              · Услуга/Товар/Комплекс[Org] (← Элемент, id=v5(Org,name)) · Папка[Org,Папка?]
LINK: адрес[Мастер, Локация]   окно[Мастер, Локация, Расписание] {start,end}  id=v5(Мастер,start)
      запись[Мастер, Локация, Расписание, Услуга|Товар|Комплекс, Клиент?] ← НАСЛЕДНИК окна
      содержимое[Папка, Услуга|Товар|Комплекс]   состав[Комплекс, Услуга|Товар]   навык[Мастер, Услуга]
```

---

## Сценарий (21 акт)

| # | Акт | Действие | Ожидание | API |
|---|-----|----------|----------|-----|
| 1 | Открытие салона | `connect`; создать Организацию; двух мастеров батчем | System-fallback account; `batch.run/size/discard`; реестр классов | connect, ConnectOpts, db.Класс, create, registry, sql, batch |
| 2 | Вторая точка входа | `up()` на уже живой БД | docker пропущен, та же схема `v1.salon` | up, UpOpts |
| 3 | Каталог | папки-дерево (self-hop), услуги/товар, комплекс + состав, содержимое папок | `deep()` возвращает ветку; состав (союз Услуга\|Товар) и содержимое читаются цепочками | rows, deep, слот .set, союз, навигация |
| 4 | Навыки мастеров | навык слотом; pivot-проверка умения; умение комплекса по составу | pivot-фильтр «умеет ли Ирина бороду» → 0/1; покрытие состава фильтром-массивом id | слот, pivot, count, ids |
| 5 | Расписание | месяц {name,year,month}; смены мастеров батчем; выходной час = нет окна | окна = позитивная доступность; id окна = v5(мастер, старт); between по дате | create, sort, limit, слот, batch, between |
| 6 | Бронь №1 | Аня→Ольга 10:00 в транзакции с advisory-lock | id записи = v5(мастер, старт) известен ДО создания — `first()` проверяет «занято?»; запись одной строкой со слотами концов | begin, tr.commit, tr.lock, first, слоты |
| 7 | Гонка брони | Боря и Вера одновременно на Ольгу 11:00 | ровно один успех (lock + пре-чек по вычисленному id) | begin, tr.rollback, lock |
| 8 | «4 руки» | параллель: стрижка у Ольги + борода у Ирины, две записи одной клиентки | обе записи Ани в 12:00; оба мастера заняты (запись→Мастер) | create, слоты, count |
| 9 | Операции дня | союз-замена предмета (Услуга→Комплекс→Товар); снятие Клиента (ручная бронь); перенос = пересоздание | `Service` снят при замене; required-конец не снять; id жёстко держит (мастер, старт) — перенос через delete+create в tx | слот .set/.unset, update, versions, delete |
| 10 | Отмена записи | превью delete, затем tombstone | без confirm — кандидаты, БД цела; confirm — время свободно (нет записи = свободен) | delete (превью/confirm) |
| 11 | `entity()` | узел-переменная в пути; старт от готового Row | та же переменная = тот же узел (pivot) | db.entity, entity, pivot |
| 12 | Отчёты | операторы фильтра на каталоге (скаляры/строки + цена-число) | точные `count()` каждого оператора; has/hasAny/hasAll — на tags в api-full (массивов в data нет) | ne…or |
| 13 | Аналитика | агрегации; keyset-пагинация; alias; tags-значение | `sum/avg/min/max/countBy`; курсор без пересечений страниц | sum, avg, min, max, countBy, sort, offset, after, cursorOf, alias, tags, ids, run |
| 14 | История | подорожание услуги → машина времени | `asOf` видит старую цену; `versions` — обе | asOf, versions |
| 15 | Realtime | `watch` всех классов и одного | событие на новую версию Клиента | watch (обе формы) |
| 16 | Приватность | `anonymize` клиента (GDPR) | поля `[erased]` + тег; первая версия хранит имя | anonymize |
| 17 | Вход | пароль, api-key, key-secret, TOTP, OTP, внешний identity | verify каждого способа; api-key в БД только sha256; OTP одноразов | db.auth (14 методов), accounts, credentials |
| 18 | Сессии | Redis: start/check/revoke/revokeAll | токен не в Redis (sha256); две сессии гаснут разом | sessions (start/check/revoke/revokeAll) |
| 19 | Доступ (ACL) | ресурс-субъект + ресурс-объект + правило | `check(эндпоинт)` и `checkData(класс, op)` → allow | resources, rules, acl (check/checkData/reload) |
| 20 | Аренда + метрики | `enforceAccount`; `onQuery`/`slowMs`; tags/owner в create | чужое невидимо; событие на запрос; slowMs=0 → всё slow | enforceAccount, onQuery, slowMs, create-контекст |
| 21 | Гарды | валидация; снесённые `set()`/`.link`/слот-`.delete()`; `execute→run`; пути; слот-гарды | `ValidationError`; синхронные ошибки пути; create с фильтром; слот без операции/владельца | ValidationError, no-path, LINK→LINK, create-гард, слот-гарды, set/link/execute removed |

---

## Матрица покрытия API (145 точек)

Модуль: `connect`[А1] `up`[А2] `cursorOf`[А13] `totpCode`[А17] `ValidationError`[А21] `Registry`.add/find/resolve/has/all[А1].
DbCore: `begin`[А6] `commit`[А21] `rollback`[А7] `tr.commit`[А6] `tr.rollback`[А7] `tr.lock`[А6] `batch`[А1] `watch`×2[А15] `close`[всюду] `registry`/`sql`[А1] `accounts`[А17] `credentials`[А17] `resources`/`rules`[А19] `auth`[А17] `acl`[А19] `entity`[А11] `db.Класс`[А1].
Чтение: `run`[А13] `rows`[А3] `first`[А6] `ids`[А13] `count`[А8] `versions`[А9/14] `limit`/`offset`[А13] `sort`[А5] `asOf`[А14] `after`[А13] `deep`[А3] `sum`/`avg`/`min`/`max`/`countBy`[А13] `alias`/`tags`[А13] `account`/`owner`[А20] `entity`-pivot[А4/9/11].
Запись: `create`[А1] `update`[А9/14] `delete`[А10] `anonymize`[А16] слот`.set`[А3/4/9] слот`.unset`[А9]; id-генерация Schema v5/v7[А3/5/6]; навигация/pivot[А4/9] слот-гард[А21].
Операторы (18): `ne`…`or`[А12].
Batch: `run`/`discard`/`size`/`batch.Класс`[А1/5].
accounts: `find`/`get`/`set`/`delete`[А17]. credentials: `find`/`set`/`delete`[А17].
resources: `find`/`get`/`set`/`delete`[А19]. rules: `find`/`set`/`delete`[А19].
auth: `setPassword`/`verifyPassword`/`issueApiKey`/`verifyApiKey`/`issueKeySecret`/`verifyKeySecret`/`enrollTotp`/`verifyTotp`/`totpEnabled`/`issueOtp`/`verifyOtp`/`link`/`lookup`/`sessions`[А17].
sessions: `start`/`check`/`revoke`/`revokeAll`[А18]. acl: `check`/`checkData`/`reload`[А19].
ConnectOpts[А1/20] · UpOpts[А2] · create-контекст tags/account/owner[А13/20] · гарды set/link/execute[А21].

**Покрыто прицельно в других файлах** (для полноты): `enforceAcl`-цепочки — `acl.test.ts`;
`accounts.delete`/`credentials.set` прямые — `tables.test.ts`; docker-ветки `up()` — миграция
контейнера; генерация id (v4/v5/v7, наследование правила окно→запись, схема-гарды) —
`idgen.test.ts`; операторы has/hasAny/hasAll (на tags) — `api-full.test.ts`.

---

## Критерии приёмки

1. `npx tsx --test --test-force-exit test/salon.test.ts` — **21/21 pass**.
2. `npm test` (весь набор) — **167/167 pass**.
3. Каждая из 145 точек API затронута хотя бы одним актом (см. матрицу).
4. Прогон идемпотентен: схема пересоздаётся в `before`, повторный запуск зелёный.
