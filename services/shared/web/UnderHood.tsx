/**
 * Панель «Под капотом» сервисов-примеров: что сделало каждое действие пользователя — цепочки letopis и запросы к базе
 * (журнал GET /api/trace, сервер — services/shared/trace.mjs). Общий файл четырёх приложений: импортирует только React
 * и UI приложения (@/components/ui/...); подключён алиасом @shared (vite.config.ts, tsconfig.app.json).
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

/** Запись журнала: действие, его цепочки (lines) и запросы к базе (onQuery; slow — дольше slowMs). */
export type Trace = {
  at: string; title: string; lines: string[];
  queries: { mode: string; classes: string; rows: number; ms: number; slow: boolean }[];
  error: string | null;
};

/** description — подпись под заголовком, empty — текст пустого журнала, height — класс высоты ленты (h-[680px]). */
export function UnderHood({ trace, description, empty, height }: { trace: Trace[]; description: string; empty: string; height: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>Под капотом</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent><ScrollArea className={`${height} pr-3`}>
        {trace.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
        {trace.map((t, i) => (
          <div key={i} className="mb-4" data-trace={t.title}>
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">{t.at} — {t.title}{t.error && <Badge variant="destructive">ошибка</Badge>}</div>
            {t.lines.length > 0 && <pre className="mb-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{t.lines.join('\n')}</pre>}
            {t.queries.length > 0 && (
              <div className="text-xs text-muted-foreground">запросов: {t.queries.length} ·{' '}
                {t.queries.map((q, j) => <span key={j} className={q.slow ? 'font-semibold text-amber-700' : ''}>{q.mode} {q.classes || '—'} {q.ms} мс{q.slow ? ' (медленный)' : ''}{j < t.queries.length - 1 ? ' · ' : ''}</span>)}
              </div>
            )}
            {t.error && <p className="text-xs text-destructive">{t.error}</p>}
          </div>))}
      </ScrollArea></CardContent>
    </Card>
  );
}
