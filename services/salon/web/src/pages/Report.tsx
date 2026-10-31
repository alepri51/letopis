import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, today, type Report as DayReport } from '@/lib/api';

/**
 * Отчёт дня (GET /api/report → report() в src/domain.mjs): брони выбранного дня по мастерам. Перечитывается сам,
 * когда кто-то записывает, переносит или отменяет (tick — событие подписки).
 */
export function Report({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [day, setDay] = useState(today());
  const [report, setReport] = useState<DayReport | null>(null);
  useEffect(() => {
    if (!day) return;
    // поле дня меняется по цифре («2», затем «29») — запросы идут один за другим, а ответы приходят в любом порядке:
    // ответ на прежний день не должен перекрыть ответ на нынешний
    let current = true;
    api<DayReport>(`/api/report?day=${day}`)
      .then((r) => { if (current) setReport(r); }, (e) => { if (current) toast.error((e as Error).message); })
      .finally(onChanged);
    return () => { current = false; };
  }, [day, tick, onChanged]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Отчёт дня</CardTitle>
        <CardDescription>Сколько броней у каждого мастера в выбранный день — по броням из letopis, отменённые не считаются.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid max-w-48 gap-2"><Label htmlFor="report-day">День</Label>
          <Input id="report-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></div>
        {report && (
          <Table className="report">
            <TableHeader><TableRow><TableHead>Мастер</TableHead><TableHead className="w-32 text-right">Броней</TableHead></TableRow></TableHeader>
            <TableBody>
              {report.staff.map((m) => (
                <TableRow key={m.id} data-report-staff={m.name}>
                  <TableCell>{m.name} <span className="text-xs text-muted-foreground">{m.specialization}</span></TableCell>
                  <TableCell className="text-right">{m.count}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium"><TableCell>Всего за {report.day}</TableCell><TableCell className="text-right" id="report-total">{report.total}</TableCell></TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
