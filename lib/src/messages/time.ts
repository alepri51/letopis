/**
 * Раздел time: watch.ts, admin.ts, cache.ts, signals.ts — подписка, verify, maintain, reset, кэш, сигналы, подписи
 * describeText.
 */
import type { Section } from './types.js';

export const time = {
  // admin.ts, maintain(): внутри db.begin()
  'time.maintain_in_tx': {
    code: 'invalid_query',
    ru: 'maintain() — пачками в своих транзакциях, не внутри db.begin()',
  },
  // admin.ts, queueWarning: очередь сигналов PostgreSQL заполнена больше чем наполовину — предупреждение maintain();
  // pct — проценты целым числом; код записи не печатается
  'time.signal_queue': {
    code: 'invalid_query',
    ru: 'очередь сигналов PostgreSQL заполнена на {pct} % — проверьте зависших слушателей',
  },
  // admin.ts, parseInterval: интервал connect({ maintain }); value — как передан (строка — в кавычках)
  'time.bad_interval': {
    code: 'invalid_data',
    ru: "интервал {value}: число мс или строка '30s', '15m', '1h', '1d' — от 1 мс до 2³¹−1 мс (около 24 суток)",
    hint: "задать интервал числом миллисекунд или строкой вида '30s', '15m', '1h', '1d'",
  },
  // admin.ts, scheduleMaintain: запуск maintain() по расписанию упал — предупреждение (lwarn); message — текст его ошибки
  'time.maintain_failed': {
    code: 'invalid_query',
    ru: 'maintain по расписанию: {message}',
  },
  // admin.ts, reset() уровня tenant внутри db.begin()
  'time.reset_in_tx': {
    code: 'invalid_query',
    ru: "reset({ level: 'tenant' }) — пачками в своих транзакциях, не внутри db.begin()",
  },
  // admin.ts, rebuildAggregates(): имя класса — не строка или пустое
  'time.rebuild_class': {
    code: 'invalid_data',
    ru: 'rebuildAggregates(класс): имя класса',
    hint: 'передать имя класса строкой: db.rebuildAggregates(класс)',
  },
  // watch.ts, decode: курсор watch({ from }) не разбирается; cursor — как передан
  'time.watch_cursor': {
    code: 'invalid_query',
    ru: 'watch: курсор {cursor} — ожидается курсор события',
  },
  // admin.ts, describeText(): заголовок и подписи текста модели — не ошибки, код записи не печатается; разметка Markdown,
  // имена классов, полей и концов, звёздочка обязательного и стрелка конца — в коде
  'time.describe_title': {
    code: 'invalid_query',
    ru: 'модель схемы {schema}',
  },
  'time.describe_chain': {
    code: 'invalid_query',
    ru: 'Цепочка: db.Класс(фильтр).Связь().Класс().rows(); запись — create, update, upsert, delete; история — versions(), asOf(), withDeleted().',
  },
  'time.describe_examples': {
    code: 'invalid_query',
    ru: "Примеры у классов — рабочие цепочки: '<id Класс>' — подставьте id объекта этого класса или его потомка.",
  },
  'time.describe_kind': {
    code: 'invalid_query',
    ru: 'вид',
  },
  'time.describe_hub': {
    code: 'invalid_query',
    ru: 'хаб (объект)',
  },
  'time.describe_link': {
    code: 'invalid_query',
    ru: 'связь',
  },
  'time.describe_abstract': {
    code: 'invalid_query',
    ru: 'абстрактный',
  },
  'time.describe_parent': {
    code: 'invalid_query',
    ru: 'предок {parent}',
  },
  'time.describe_system': {
    code: 'invalid_query',
    ru: 'системный',
  },
  'time.describe_key': {
    code: 'invalid_query',
    ru: 'ключ',
  },
  'time.describe_no_key': {
    code: 'invalid_query',
    ru: 'нет (id выдаёт база)',
  },
  'time.describe_fields': {
    code: 'invalid_query',
    ru: 'поля',
  },
  'time.describe_any_of': {
    code: 'invalid_query',
    ru: 'условия anyOf (хотя бы одно)',
  },
  'time.describe_one_of': {
    code: 'invalid_query',
    ru: 'условия oneOf (ровно одно)',
  },
  'time.describe_ends': {
    code: 'invalid_query',
    ru: 'концы',
  },
  'time.describe_derived': {
    code: 'invalid_query',
    ru: 'производный: строки пишет проектор {projector}, приложение только читает',
  },
  // агрегат: сумма поля или число строк источника; where — пусто или подпись time.describe_where
  'time.describe_aggregate_sum': {
    code: 'invalid_query',
    ru: 'агрегат {field} = сумма {sum} строк {of} по концу {via}{where}; поле считает база, приложение его не пишет',
  },
  'time.describe_aggregate_count': {
    code: 'invalid_query',
    ru: 'агрегат {field} = число строк {of} по концу {via}{where}; поле считает база, приложение его не пишет',
  },
  // where — условие агрегата JSON
  'time.describe_where': {
    code: 'invalid_query',
    ru: ', условие {where}',
  },
  'time.describe_create': {
    code: 'invalid_query',
    ru: 'создать',
  },
  'time.describe_find': {
    code: 'invalid_query',
    ru: 'найти',
  },
  'time.describe_neighbors': {
    code: 'invalid_query',
    ru: 'соседи',
  },
} satisfies Section<'time'>;
