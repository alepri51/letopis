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
];

export default nuances;
