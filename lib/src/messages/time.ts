/**
 * Раздел time: watch.ts, admin.ts, cache.ts, signals.ts — подписка, maintain, кэш, сигналы.
 */
import type { Section } from './types.js';

export const time = {
  // admin.ts, maintain(): внутри db.begin()
  'time.maintain_in_tx': {
    code: 'invalid_query',
    ru: 'maintain() идёт своей транзакцией, не внутри db.begin()',
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
  // watch.ts, decode: курсор watch({ from }) не разбирается; cursor — как передан
  'time.watch_cursor': {
    code: 'invalid_query',
    ru: 'watch: курсор {cursor} — ожидается курсор события',
  },
} satisfies Section<'time'>;
