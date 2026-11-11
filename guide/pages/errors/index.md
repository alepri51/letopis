# Ошибки

Ошибка letopis — `LetopisError` с полем `code`: по коду программа решает, что делать. Ошибки проверки данных — `ValidationError`, нарушения перечислены в её поле `issues`. Те же коды получает и сырой SQL, выполненный под сессией letopis; ошибку драйвера превращает в `LetopisError` функция `fromDbError`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Строгий режим, MCP, чужая квартира

<Example id="errors/03-strict-mcp-errors" />

## Частые причины `invalid_data`

Текст `invalid_data` называет первое нарушение — «…класса Product: price — нарушено правило minimum (всего нарушений: N, все — err.issues)»; полный список — в `err.issues` (путь `path`, правило `keyword`, сообщение `message`).

- **Конец передан полем данных.** `me.Item(item).Loan().create({ issuedAt, Member: id })` — `Member` не поле, а конец класса: отказ до записи с ключом `write.link_in_data`, текст называет конец и как его задать; в `issues` — правило `additionalProperties` с пустым путём. Конец задают путём цепочки или шагом конца после глагола: `create({ issuedAt }).Member.set(id)` — [пример](../write/#ex-write-02-ends-and-slots).
- **Значение не подходит под правило поля** (`enum`, `minLength`, `pattern` и другие) — путь к полю в `issues[].path`, правило в `issues[].keyword`; у `enum` сообщение перечисляет допустимые значения, у `minLength` и `maxLength` — называет границу: «длина строки меньше 3», «длина строки больше 80».

## Все коды и ключи

Таблица всех кодов ошибок и отказы, которые приложение различает по ключу `err.key`, — на странице [«Ошибки: все коды и ключи»](../errors/codes).
