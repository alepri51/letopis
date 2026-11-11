/**
 * Раздел time: watch.ts, admin.ts, cache.ts, signals.ts — подписка, maintain, кэш, сигналы.
 */
import type { Section } from './types.js';

export const time = {
  // admin.ts, maintain(): внутри me.begin()
  'time.maintain_in_tx': {
    code: 'invalid_query',
    ru: 'maintain() идёт своей транзакцией, не внутри me.begin()',
  },
  // admin.ts, queueWarning: очередь сигналов PostgreSQL заполнена больше чем наполовину — предупреждение maintain();
  // pct — проценты целым числом; код записи не печатается
  'time.signal_queue': {
    code: 'invalid_query',
    ru: 'очередь сигналов PostgreSQL заполнена на {pct} % — проверьте зависших слушателей',
  },
  // watch.ts, decode: курсор watch({ from }) не разбирается; cursor — как передан
  'time.watch_cursor': {
    code: 'invalid_query',
    ru: 'watch: курсор {cursor} — ожидается курсор события',
  },
} satisfies Section<'time'>;
