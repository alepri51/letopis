# Эталоны 0.21

Копии функций letopis 0.21 (тег `v0.21.0`) для дифференциальных тестов 1.0 (§7.12 плана).
В пакет не попадают. Менять их нельзя: они фиксируют поведение 0.21.

| Файл | Откуда в 0.21 | С чем сравнивается в 1.0 |
|---|---|---|
| `merge.ts` | `deepMerge`, `lib/src/write.ts:73-85` | SQL-функция `merge` |
| `acl.ts` | `matchCategories`, `matchMask`, `decide`, `lib/src/acl.ts:29-161` | план прав `acl_plan()` и маски в SQL |
| `inherit.ts` | наследование атрибутов из `buildDef`, `lib/src/schema.ts:168` | поле `resolved` строки `Class` |
