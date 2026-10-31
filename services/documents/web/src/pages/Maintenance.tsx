import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Me } from '@/lib/api';

type Verify = { ok: boolean; checked: number; issues: { id: string; rev: number | null; problem: string; number: string }[] };
type Archive = { loaded: number; versions: number; ms: number; initial: boolean; at: string } | null;
type Policy = { tier: string; keep: string }[];

/**
 * Обслуживание (администраторское подключение): проверка цепочки хэшей журнала (verify) и «порча» записи,
 * прореживание истории по политике хранения (maintain({ now })), отчёт первой заливки архива (load({ initial })).
 */
export function Maintenance({ onChanged }: { me: Me; onChanged: () => void }) {
  const [verify, setVerify] = useState<Verify | null>(null);
  const [archive, setArchive] = useState<Archive>(null);
  const [policy, setPolicy] = useState<Policy>([]);
  const [days, setDays] = useState('40');
  const [thin, setThin] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { api<{ archive: Archive; policy: Policy }>('/api/admin/info').then((r) => { setArchive(r.archive); setPolicy(r.policy); }, () => {}); }, []);
  const check = async () => { setVerify(await api<Verify>('/api/admin/verify')); onChanged(); };
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Целостность журнала</CardTitle>
          <CardDescription>
            Каждая версия хранит хэш своих данных и хэш предыдущей версии — цепочка. <code>verify({'{'} data: true {'}'})</code> пересчитывает
            её: правку журнала в обход библиотеки (например, руками в SQL) видно сразу.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => check().catch((e) => toast.error(e.message))}>Проверить целостность</Button>
            <Button variant="destructive" onClick={async () => {
              try { const r = await api<{ number: string; rev: number }>('/api/admin/corrupt', {}); toast.warning(`Запись журнала ${r.number} v${r.rev} испорчена прямым UPDATE`); await check(); }
              catch (e) { toast.error((e as Error).message); }
            }}>Испортить запись журнала</Button>
            <Button variant="outline" onClick={async () => {
              try { await api('/api/admin/repair', {}); toast.success('Запись возвращена байт в байт'); await check(); }
              catch (e) { toast.error((e as Error).message); }
            }}>Вернуть как было</Button>
          </div>
          {verify && (verify.ok
            ? <Alert><AlertTitle>Журнал цел</AlertTitle><AlertDescription>Проверено версий: {verify.checked}. Цепочка хэшей сходится.</AlertDescription></Alert>
            : <Alert variant="destructive"><AlertTitle>Найдены нарушения: {verify.issues.length}</AlertTitle>
                <AlertDescription><ul>{verify.issues.map((i, k) => <li key={k} data-issue={i.number}>{i.number} v{i.rev ?? '—'}: {i.problem}</li>)}</ul></AlertDescription></Alert>)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Хранение истории</CardTitle>
          <CardDescription>
            Политика класса <code>Doc</code> — ярусы: свежие версии хранятся все, старые прореживаются до одной на день, неделю,
            месяц, год. <code>maintain({'{'} now {'}'})</code> применяет её «как будто сейчас — через N дней».
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Table>
            <TableHeader><TableRow><TableHead>ярус</TableHead><TableHead>что хранится</TableHead></TableRow></TableHeader>
            <TableBody>{policy.map((p) => <TableRow key={p.tier}><TableCell className="font-medium">{p.tier}</TableCell><TableCell>{p.keep}</TableCell></TableRow>)}</TableBody>
          </Table>
          <form className="flex items-center gap-2" onSubmit={async (e) => {
            e.preventDefault();
            try { setThin(await api<Record<string, unknown>>('/api/admin/maintain', { days: Number(days) })); toast.success('Обслуживание выполнено'); onChanged(); }
            catch (err) { toast.error((err as Error).message); }
          }}>
            <span className="text-sm">Перемотать на</span>
            <Input aria-label="Дней вперёд" className="w-20" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            <span className="text-sm">дней и проредить</span>
            <Button type="submit" variant="secondary">maintain</Button>
          </form>
          {thin && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-maintain>{JSON.stringify(thin, null, 1)}</pre>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Архив</CardTitle>
          <CardDescription>
            Старые договоры попали в базу первой заливкой <code>db.load(…, {'{'} initial: true {'}'})</code> — пачками, без построчных
            проверок, с историей. Сброс стенда (<code>reset</code>) показан в главе «Эксплуатация».
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {archive && <p className="text-sm" data-archive>Залито документов: {archive.loaded}, версий: {archive.versions}, за {archive.ms} мс{archive.initial ? ' (первая заливка)' : ''}.</p>}
          <p className="text-xs text-muted-foreground">Демо с нуля — перезапуск сервиса с <code>FRESH=1</code>.</p>
        </CardContent>
      </Card>
    </div>
  );
}
