/**
 * Панель «Под капотом» сервисов-примеров: что сделало каждое действие пользователя — цепочки letopis, запросы к базе,
 * записанные версии с изменёнными полями и сигналы классов, которые записало действие (журнал GET /api/trace, сервер —
 * services/shared/trace.mjs). Общий файл четырёх приложений: импортирует только React и UI приложения
 * (@/components/ui/...); подключён алиасом @shared (vite.config.ts, tsconfig.app.json).
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Версия, которую записало действие: fields — изменённые поля data, ends — концы (связи); против прошлой версии id. */
export type TraceVersion = { class: string; id: string; label: string; rev: number; op: string; reason: string; fields: string[]; ends: string[] };
/**
 * Запись журнала: действие, его цепочки (lines), запросы к базе (onQuery; slow — дольше slowMs), записанные версии
 * (первые из versionsTotal) и сигналы классов, которые записало действие (только имя класса).
 */
export type Trace = {
  at: string; title: string; lines: string[];
  queries: { mode: string; classes: string; rows: number; ms: number; slow: boolean }[];
  versions: TraceVersion[]; versionsTotal: number; signals: string[];
  error: string | null;
};

const head = 'h-7 px-1.5';
const cell = 'p-1.5 align-top';

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
              <Table className="text-xs" data-queries={t.queries.length}>
                <TableHeader><TableRow><TableHead className={head}>запрос</TableHead><TableHead className={head}>классы</TableHead><TableHead className={head}>строк</TableHead><TableHead className={head}>мс</TableHead></TableRow></TableHeader>
                <TableBody>{t.queries.map((q, j) => (
                  <TableRow key={j} className={q.slow ? 'font-semibold text-amber-700' : ''}>
                    <TableCell className={cell}>{q.mode}</TableCell>
                    <TableCell className={`${cell} whitespace-normal`}>{q.classes || '—'}</TableCell>
                    <TableCell className={cell}>{q.rows}</TableCell>
                    <TableCell className={cell}>{q.ms}{q.slow && <Badge variant="outline" className="ml-1 text-amber-700">медленный</Badge>}</TableCell>
                  </TableRow>))}
                </TableBody>
              </Table>
            )}
            {t.versions.length > 0 && (
              <Table className="mt-2 text-xs" data-versions={t.versionsTotal}>
                <TableHeader><TableRow><TableHead className={head}>версия</TableHead><TableHead className={head}>rev</TableHead><TableHead className={head}>действие</TableHead><TableHead className={head}>изменено</TableHead></TableRow></TableHeader>
                <TableBody>{t.versions.map((v, k) => (
                  <TableRow key={k}>
                    <TableCell className={`${cell} whitespace-normal`} title={v.id}>
                      <span className="font-medium">{v.class}</span> {v.label}
                      {v.reason && <div className="text-muted-foreground">{v.reason}</div>}
                    </TableCell>
                    <TableCell className={cell}>{v.rev}</TableCell>
                    <TableCell className={cell}><Badge variant="outline">{v.op}</Badge></TableCell>
                    {/* концы — со стрелкой (неразрывный пробел): «Org →» — сменилась ссылка на Org */}
                    <TableCell className={`${cell} whitespace-normal`}>{[...v.fields, ...v.ends.map((e) => `${e}\u00a0→`)].join(', ') || '—'}</TableCell>
                  </TableRow>))}
                </TableBody>
              </Table>
            )}
            {t.versionsTotal > t.versions.length && <p className="text-xs text-muted-foreground">…и ещё версий: {t.versionsTotal - t.versions.length}</p>}
            {t.signals.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-signals={t.signals.length}>сигналы:
                {t.signals.map((s) => <Badge key={s} variant="secondary">{s}</Badge>)}
              </div>
            )}
            {t.error && <p className="text-xs text-destructive">{t.error}</p>}
          </div>))}
      </ScrollArea></CardContent>
    </Card>
  );
}
