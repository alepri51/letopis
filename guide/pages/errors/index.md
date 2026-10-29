# Ошибки

Ошибка letopis — `LetopisError` с полем `code`: по коду решают, что делать (ошибки проверки данных — `ValidationError` с перечнем `issues`). Коды базы приходят и цепочкам, и сырому SQL под сессией — драйверную ошибку в `LetopisError` переводит `fromDbError`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Производные данные, проекторы, MCP, смена класса

<Example id="errors/03-derived-mcp-errors" />

## Все коды

Страница собирается скриптом `guide/scripts/gen-errors.ts`: коды — из каталога базы (`LT_NAMES`) и из кода библиотеки, ссылки — главы, где код вызывает исполняемый пример.

| Код | Где показан | Примечание |
|---|---|---|
| `acl_denied` | [Права](../access/) |  |
| `admin_required` | [Загрузка](../load/) |  |
| `aggregate_field` | [Агрегаты](../derived/) |  |
| `bypass_rls` | [Установка](../install/) |  |
| `class_not_loadable` | [Загрузка](../load/) |  |
| `commit_unknown` | — | обрыв связи во время COMMIT — исход неизвестен; воспроизводится только обрывом сети (тесты `balance` с прокси); что делать — перечитать и сверить по ключу операции |
| `confirm_mismatch` | [Эксплуатация](../ops/) |  |
| `confirmation_required` | [Ошибки](../errors/) |  |
| `conflict` | [Запись](../write/) |  |
| `cursor_expired` | [История](../history/) |  |
| `delete_restricted` | [Удаление](../delete/) |  |
| `derived_class` | [Ошибки](../errors/) |  |
| `duplicate` | [Загрузка](../load/) |  |
| `exists` | [Модели](../models/) |  |
| `id_from_db` | [Ошибки](../errors/) |  |
| `id_mismatch` | [Ошибки](../errors/) |  |
| `immutable_key` | [Модели](../models/) |  |
| `invalid_class` | [Права](../access/) |  |
| `invalid_data` | [Модели](../models/) |  |
| `invalid_query` | [Чтение](../read/) |  |
| `isolation_level` | [Ошибки](../errors/) |  |
| `lock_unsupported` | [Ошибки](../errors/) |  |
| `no_key` | [Запись](../write/) |  |
| `no_path` | [Ошибки](../errors/) |  |
| `no_session` | [Ошибки](../errors/) |  |
| `not_deleted` | [Удаление](../delete/) |  |
| `not_empty` | [Загрузка](../load/) |  |
| `not_implemented` | — | в 1.4 не бросается: объявлен, но нигде не вызывается |
| `projector_busy` | — | другой процесс сейчас перестраивает проекцию этого проектора; что делать — дождаться и повторить |
| `projector_pending` | [Ошибки](../errors/) |  |
| `rebuild_required` | [Ошибки](../errors/) |  |
| `reclass_denied` | [Ошибки](../errors/) |  |
| `recreated_in_statement` | [Ошибки](../errors/) |  |
| `removed` | [Переход с 0.21](../migrate/) |  |
| `reset_disabled` | [Эксплуатация](../ops/) |  |
| `rev_ambiguous` | [Запись](../write/) |  |
| `target_not_found` | [Ошибки](../errors/) |  |
| `tenant_denied` | [Эксплуатация](../ops/) |  |
| `tightening_conflict` | [Модели](../models/) |  |
| `tx_required` | [Деньги](../money/) |  |
| `tx_rolled_back` | [Ошибки](../errors/) |  |
| `undeclared_end` | [Ошибки](../errors/) |  |
| `use_reclass` | [Ошибки](../errors/) |  |
| `user_session_required` | [Ошибки](../errors/) |  |
