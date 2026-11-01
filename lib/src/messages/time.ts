/**
 * Раздел time: watch.ts, admin.ts, cache.ts, signals.ts — подписка, verify, maintain, reset, кэш, сигналы.
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
} satisfies Section<'time'>;
