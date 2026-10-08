# F-DELETE — Удаление и каскад (letopis 1.0, этап 4)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `await db.Member(m).delete().rows()` (превью) → `await db.Member(m).delete({ confirm: true }).rows()`; сырой `delete from entity where id in (…)`. Стирание истории (`purge`) — этап 6.

## Превью (без изменений)
1. [N] `lib/src/write.ts:deleteOp` — цели `targetIds` (путь и модификаторы до глагола).
2. [P] `lib/sql/60-write.sql:delete_preview` — функция владельца (индекс `ends` без RLS), только строки арендатора сессии: уровни каскада по правилу `ref_action()` (cascade > restrict > unset), затем кто останется ссылаться — `unset` или `restrict`.
3. [N] строки по id под RLS: `$action` (`delete` | `unset` | `restrict`), `$depth` — уровень каскада (0 — цель).

## Удаление
4. [N] `lib/src/write.ts:deleteOp` — метка `max(seq)` журнала этой транзакции (`log.tx = pg_current_xact_id()`), затем `delete from entity where id = any(…) returning …`; меньше строк, чем целей, — `explainMissing`.
5. [P] `lib/sql/60-write.sql:trg_entity_bd` — только `read committed` (`isolation_level`).
6. [P] `lib/sql/60-write.sql:trg_entity_ad` — после оператора по переходной таблице `gone`: `recreated_in_statement`; строки Class с потомками или строками — отказ; надгробия `gone` одной вставкой; уровни каскада: ссылающиеся строки (`ends && уровень`) → `ref_action()`; cascade — `delete … returning` в порядке id (блокировки) и надгробия уровня одной вставкой; unset — `sys_update` снимает конец; `restrict` — один запрос по итогу (`delete_restricted`, видимые строки и число остальных); `signal()` по классам.
7. [N] результат — надгробия этой транзакции после метки (индекс `log (tx, seq)`, `xid8eq` leakproof — работает под RLS) плюс строки классов без журнала из `returning`; `$deleted: true`.

Сбои: `delete_restricted`, `isolation_level`, `recreated_in_statement`, `target_not_found`, `acl_denied` (этап 5).
Состояние: строки замыкания удалены из `entity`, надгробия и версии снятых концов — в `log`.
