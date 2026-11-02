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
    en: 'maintain() runs in batches in its own transactions, not inside db.begin()',
  },
  // admin.ts, queueWarning: очередь сигналов PostgreSQL заполнена больше чем наполовину — предупреждение maintain();
  // pct — проценты целым числом; код записи не печатается
  'time.signal_queue': {
    code: 'invalid_query',
    ru: 'очередь сигналов PostgreSQL заполнена на {pct} % — проверьте зависших слушателей',
    en: 'the PostgreSQL signal queue is {pct} % full — check for stuck listeners',
  },
  // admin.ts, parseInterval: интервал connect({ maintain }); value — как передан (строка — в кавычках)
  'time.bad_interval': {
    code: 'invalid_data',
    ru: "интервал {value}: число мс или строка '30s', '15m', '1h', '1d' — от 1 мс до 2³¹−1 мс (около 24 суток)",
    en: "interval {value}: a number of ms or a string '30s', '15m', '1h', '1d' — from 1 ms to 2³¹−1 ms (about 24 days)",
    hint: {
      ru: "задать интервал числом миллисекунд или строкой вида '30s', '15m', '1h', '1d'",
      en: "set the interval as a number of milliseconds or a string like '30s', '15m', '1h', '1d'",
    },
  },
  // admin.ts, scheduleMaintain: запуск maintain() по расписанию упал — предупреждение (lwarn); message — текст его ошибки
  'time.maintain_failed': {
    code: 'invalid_query',
    ru: 'maintain по расписанию: {message}',
    en: 'scheduled maintain: {message}',
  },
  // admin.ts, reset() уровня tenant внутри db.begin()
  'time.reset_in_tx': {
    code: 'invalid_query',
    ru: "reset({ level: 'tenant' }) — пачками в своих транзакциях, не внутри db.begin()",
    en: "reset({ level: 'tenant' }) runs in batches in its own transactions, not inside db.begin()",
  },
  // admin.ts, rebuildAggregates(): имя класса — не строка или пустое
  'time.rebuild_class': {
    code: 'invalid_data',
    ru: 'rebuildAggregates(класс): имя класса',
    en: 'rebuildAggregates(className): a class name is required',
    hint: {
      ru: 'передать имя класса строкой: db.rebuildAggregates(класс)',
      en: 'pass the class name as a string: db.rebuildAggregates(className)',
    },
  },
  // watch.ts, decode: курсор watch({ from }) не разбирается; cursor — как передан
  'time.watch_cursor': {
    code: 'invalid_query',
    ru: 'watch: курсор {cursor} — ожидается курсор события',
    en: 'watch: cursor {cursor} — an event cursor is expected',
  },
  // admin.ts, describeText(): заголовок и подписи текста модели — не ошибки, код записи не печатается; разметка Markdown,
  // имена классов, полей и концов, звёздочка обязательного и стрелка конца — в коде
  'time.describe_title': {
    code: 'invalid_query',
    ru: 'модель схемы {schema}',
    en: 'model of schema {schema}',
  },
  'time.describe_chain': {
    code: 'invalid_query',
    ru: 'Цепочка: db.Класс(фильтр).Связь().Класс().rows(); запись — create, update, upsert, delete; история — versions(), asOf(), withDeleted().',
    en: 'Chain: db.Class(filter).Link().Class().rows(); writes — create, update, upsert, delete; history — versions(), asOf(), withDeleted().',
  },
  'time.describe_examples': {
    code: 'invalid_query',
    ru: "Примеры у классов — рабочие цепочки: '<id Класс>' — подставьте id объекта этого класса или его потомка.",
    en: "The class examples are working chains: '<id Class>' — substitute the id of an object of this class or of its descendant.",
  },
  'time.describe_kind': {
    code: 'invalid_query',
    ru: 'вид',
    en: 'kind',
  },
  'time.describe_hub': {
    code: 'invalid_query',
    ru: 'хаб (объект)',
    en: 'hub (object)',
  },
  'time.describe_link': {
    code: 'invalid_query',
    ru: 'связь',
    en: 'link',
  },
  'time.describe_abstract': {
    code: 'invalid_query',
    ru: 'абстрактный',
    en: 'abstract',
  },
  'time.describe_parent': {
    code: 'invalid_query',
    ru: 'предок {parent}',
    en: 'parent {parent}',
  },
  'time.describe_system': {
    code: 'invalid_query',
    ru: 'системный',
    en: 'system',
  },
  'time.describe_key': {
    code: 'invalid_query',
    ru: 'ключ',
    en: 'key',
  },
  'time.describe_no_key': {
    code: 'invalid_query',
    ru: 'нет (id выдаёт база)',
    en: 'none (the database assigns the id)',
  },
  'time.describe_fields': {
    code: 'invalid_query',
    ru: 'поля',
    en: 'fields',
  },
  'time.describe_any_of': {
    code: 'invalid_query',
    ru: 'условия anyOf (хотя бы одно)',
    en: 'anyOf conditions (at least one)',
  },
  'time.describe_one_of': {
    code: 'invalid_query',
    ru: 'условия oneOf (ровно одно)',
    en: 'oneOf conditions (exactly one)',
  },
  'time.describe_ends': {
    code: 'invalid_query',
    ru: 'концы',
    en: 'ends',
  },
  'time.describe_derived': {
    code: 'invalid_query',
    ru: 'производный: строки пишет проектор {projector}, приложение только читает',
    en: 'derived: the rows are written by projector {projector}, the application only reads them',
  },
  // агрегат: сумма поля или число строк источника; where — пусто или подпись time.describe_where
  'time.describe_aggregate_sum': {
    code: 'invalid_query',
    ru: 'агрегат {field} = сумма {sum} строк {of} по концу {via}{where}; поле считает база, приложение его не пишет',
    en: 'aggregate {field} = sum of {sum} over the rows of {of} by end {via}{where}; the database computes the field, the application does not write it',
  },
  'time.describe_aggregate_count': {
    code: 'invalid_query',
    ru: 'агрегат {field} = число строк {of} по концу {via}{where}; поле считает база, приложение его не пишет',
    en: 'aggregate {field} = count of the rows of {of} by end {via}{where}; the database computes the field, the application does not write it',
  },
  // where — условие агрегата JSON
  'time.describe_where': {
    code: 'invalid_query',
    ru: ', условие {where}',
    en: ', condition {where}',
  },
  'time.describe_create': {
    code: 'invalid_query',
    ru: 'создать',
    en: 'create',
  },
  'time.describe_find': {
    code: 'invalid_query',
    ru: 'найти',
    en: 'find',
  },
  'time.describe_neighbors': {
    code: 'invalid_query',
    ru: 'соседи',
    en: 'neighbors',
  },
} satisfies Section<'time'>;
