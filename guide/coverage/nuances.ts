/**
 * Нюансы и ловушки letopis — каждый должен получить пример (поле `covers` с `nuance.<id>`).
 * Источники: карточки атласа (раздел «Инварианты и грабли»), раздел «Ограничения» README, CHANGELOG.
 * Список пополняется по главам; к концу работы (этап 5) покрытие проверяется строго.
 */
export interface Nuance {
  id: string;
  /** Суть простыми словами. */
  text: string;
  /** Откуда взят: файл и раздел. */
  source: string;
}

const nuances: Nuance[] = [
  {
    id: 'delete-preview',
    text: 'delete() без { confirm: true } ничего не удаляет — возвращает превью: что удалится и с каким действием ($action).',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'class-is-entity',
    text: 'Описание класса — тоже объект: строка класса Class в entity со своей историей в log.',
    source: 'lib/README.md, раздел 2',
  },
  {
    id: 'session-in-secret',
    text: 'Сессия — строка SESSION в таблице secret; сам токен там не хранится, только его хэш.',
    source: 'lib/sql/10-core.sql, таблица secret',
  },
  {
    id: 'up-idempotent',
    text: 'Повторный up() безопасен: накатывает ту же ревизию, данные не трогает, ключ сервиса снова не выдаёт.',
    source: 'lib/README.md, раздел 1; docs/atlas/F-BOOT.md',
  },
  {
    id: 'service-key-once',
    text: 'Ключ сервиса up() выдаёт только при первой установке или когда не осталось ни одного действующего ключа API.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'signals-mode-sticky',
    text: 'Режим сигналов хранится в схеме: up() без опции signals его не меняет; после смены — перезапуск процессов.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'fresh-drops-data',
    text: 'up({ fresh: true }) удаляет схему и ставит заново — данные теряются, ключ сервиса новый.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'pglite-no-rls',
    text: 'Подключение к PGlite — суперпользователь (allowBypassRls), одно соединение, без LISTEN: права, изоляцию и гонки на нём не проверить.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'engine-stamp',
    text: 'up() пишет штамп движка в комментарий схемы; connect() предупреждает, если штамп не совпал с пакетом (схему не накатили или накатила новее).',
    source: 'lib/README.md, раздел 3; lib/src/up.ts:stampDrift',
  },
];

export default nuances;
