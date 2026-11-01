# letopis 1.4.2: проверки выпуска

## Проверка перед выпуском

Команда `cd lib && npm run prerelease` (план 2.0, этап 0): шаги по очереди, первый красный останавливает прогон.

<!-- prerelease:start -->
Прогон 2026-11-01 10:03 UTC, версия 1.4.2-alpha.0, коммит 89a7bb0, с незакоммиченными правками: всё зелёное за 13:49.

| Шаг | Итог | Время | Подробности |
|---|---|---|---|
| typecheck | ok | 00:04 |  |
| check:docs | ok | 00:04 | 1.4.1 → 1.4.2-alpha.0 — шаг «патч», изменения требуют не меньше чем «без изменений API» |
| npm test | ok | 09:42 | 609 из 609 |
| guide typecheck | ok | 00:03 |  |
| examples | ok | 01:55 | все примеры прошли: 56 |
| er | ok | 00:06 |  |
| coverage | ok | 00:06 | 373 из 373 |
| site build | ok | 00:34 |  |
| sandbox | ok | 00:03 | снимок basics/01 совпал, без Origin — 403 |
| lib build | ok | 00:03 |  |
| scenario salon | ok | 00:04 | проверок 24 |
| scenario wallet | ok | 00:16 | проверок 26 |
| scenario helpdesk | ok | 00:35 | проверок 64 |
| scenario documents | ok | 00:04 | проверок 23 |
| check:package | ok | 00:11 | 56 экспортов |
<!-- prerelease:end -->
