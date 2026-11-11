/**
 * Связь плееров примеров со схемами процессов на странице: плеер сообщает текущий шаг (с 0), схема процесса
 * подсвечивает его стадии и может попросить плеер перейти к шагу.
 */
import { reactive } from 'vue';

/** Якорь плеера примера на странице (`#ex-…`): id корня плеера в Example.vue и ссылки на пример со схем. */
export const exAnchor = (id: string): string => `ex-${id.replace(/[^a-z0-9]+/gi, '-')}`;

export const players =reactive<Record<string, { step: number; want: number | null }>>({});

/** Плеер `id` показывает шаг `step`. */
export function report(id: string, step: number): void {
  if (!players[id]) players[id] = { step, want: null };
  else players[id].step = step;
}

/** Попросить плеер `id` перейти к шагу `step`. */
export function want(id: string, step: number): void {
  if (!players[id]) players[id] = { step: 0, want: step };
  else players[id].want = step;
}
