import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type Me } from '@/lib/api';

type Archive = { loaded: number; versions: number; ms: number; initial: boolean; at: string } | null;
type Report = { sessions: number; codes: number; queue: unknown; skipped: boolean };

/** Обслуживание (администраторское подключение): отчёт первой заливки архива (load({ initial })) и maintain(). */
export function Maintenance({ onChanged }: { me: Me; onChanged: () => void }) {
  const [archive, setArchive] = useState<Archive>(null);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => { api<{ archive: Archive }>('/api/admin/info').then((r) => setArchive(r.archive), () => {}); }, []);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Архив</CardTitle>
          <CardDescription>
            Старые договоры попали в базу первой заливкой <code>db.load(…, {'{'} initial: true, withHistory: true {'}'})</code> — в пустую
            схему, пачками, с историей: у каждого договора четыре версии из прежней системы.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {archive
            ? <p className="text-sm" data-archive>Залито документов: {archive.loaded}, версий: {archive.versions}, за {archive.ms} мс{archive.initial ? ' (первая заливка)' : ''}.</p>
            : <p className="text-sm text-muted-foreground">Архив залит при первом запуске сервиса на пустой схеме — отчёт показывает тот запуск.</p>}
          <p className="text-xs text-muted-foreground">Демо с нуля — перезапуск сервиса с <code>FRESH=1</code>.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Обслуживание</CardTitle>
          <CardDescription>
            <code>maintain()</code> администраторского подключения удаляет истёкшие и погашенные сессии и одноразовые коды, строки-замки
            удалённых классов и проверяет очередь сигналов. Журнал оно не трогает: история хранится целиком.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button className="w-fit" variant="secondary" onClick={async () => {
            try { setReport(await api<Report>('/api/admin/maintain', {})); toast.success('Обслуживание выполнено'); onChanged(); }
            catch (e) { toast.error((e as Error).message); }
          }}>maintain()</Button>
          {report && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-maintain>{JSON.stringify(report, null, 1)}</pre>}
        </CardContent>
      </Card>
    </div>
  );
}
