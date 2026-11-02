import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, PRIORITY, STATUS, type Me } from '@/lib/api';

export type Ticket = {
  id: string; number: string; subject: string; body: string; status: string; priority: string; due: string; overdue: boolean;
  client: string; assignee: string; channel: string; rev: number;
};
type Post = { id: string; text: string; author: string; at: string; internal: boolean };
type Detail = { ticket: Ticket; posts: Post[] };
type Version = { rev: number; op: string; who: string; agent: string; reason: string; at: string; status: string; assignee: string };

const priorityItems = Object.entries(PRIORITY).map(([value, label]) => ({ value, label }));
const statusItems = Object.entries(STATUS).map(([value, label]) => ({ value, label }));
const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tone = (p: string) => (p === 'urgent' ? 'destructive' : p === 'high' ? 'default' : 'outline') as 'destructive' | 'default' | 'outline';

/** Заявки: агенту и руководителю — очередь компании по сроку ответа (страницы по курсору), клиенту — свои обращения. */
export function Tickets({ me, tick, onChanged }: { me: Me; tick: number; onChanged: () => void }) {
  const staff = me.role !== 'client';
  const [rows, setRows] = useState<Ticket[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // сколько строк показано: обновление по событию перечитывает столько же (limit), а не сворачивает список до первой
  // страницы; в другой компании — снова первая страница
  const shown = useRef({ tenant: me.tenant, n: 0 });
  const load = async () => {
    if (shown.current.tenant !== me.tenant) shown.current = { tenant: me.tenant, n: 0 };
    const r = await api<{ rows: Ticket[]; next: string | null }>(`/api/tickets${shown.current.n ? `?limit=${shown.current.n}` : ''}`);
    setRows(r.rows); setNext(r.next);
  };
  useEffect(() => { load().catch((e) => toast.error(e.message)); }, [tick, me.tenant]);
  const more = async () => {
    const r = await api<{ rows: Ticket[]; next: string | null }>(`/api/tickets?after=${encodeURIComponent(next!)}`);
    setRows((x) => {
      const all = [...x, ...r.rows];
      shown.current.n = all.length;
      return all;
    });
    setNext(r.next); onChanged();
  };
  return (
    <div className="grid gap-6">
      {!staff && <NewTicket onDone={() => { load(); onChanged(); }} />}
      <Card>
        <CardHeader>
          <CardTitle>{staff ? 'Очередь заявок' : 'Мои обращения'}</CardTitle>
          <CardDescription>
            {staff
              ? 'Открытые заявки компании по сроку ответа: сверху те, что сгорят раньше. Страницы — по курсору (after), без сдвига при новых заявках.'
              : 'Вы видите только свои обращения: чужие заявки компании отсекает база по правилу доступа.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Table>
            <TableHeader><TableRow><TableHead>№</TableHead><TableHead>тема</TableHead>{staff && <TableHead>клиент</TableHead>}<TableHead>статус</TableHead><TableHead>приоритет</TableHead><TableHead>срок</TableHead>{staff && <TableHead>агент</TableHead>}</TableRow></TableHeader>
            <TableBody>{rows.map((t) => (
              // строка в фокусе (tabIndex): карточка открывается и с клавиатуры, а после закрытия фокус возвращается на строку
              <TableRow key={t.id} className="cursor-pointer outline-none focus-visible:bg-muted" data-ticket={t.number} tabIndex={0}
                onClick={() => setOpen(t.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(t.id); } }}>
                <TableCell className="font-medium">{t.number}</TableCell>
                <TableCell>{t.subject}{t.channel !== 'web' && <Badge variant="outline" className="ml-2">{t.channel}</Badge>}</TableCell>
                {staff && <TableCell>{t.client}</TableCell>}
                <TableCell>{STATUS[t.status]}</TableCell>
                <TableCell><Badge variant={tone(t.priority)}>{PRIORITY[t.priority]}</Badge></TableCell>
                <TableCell className={t.overdue ? 'font-semibold text-destructive' : ''}>{when(t.due)}{t.overdue && ' · просрочена'}</TableCell>
                {staff && <TableCell>{t.assignee || '—'}</TableCell>}
              </TableRow>))}</TableBody>
          </Table>
          {rows.length === 0 && <p className="text-sm text-muted-foreground">Заявок нет.</p>}
          {next && <Button variant="outline" className="w-fit" onClick={() => more().catch((e) => toast.error(e.message))}>Показать ещё</Button>}
        </CardContent>
      </Card>
      <TicketDialog id={open} me={me} tick={tick} onClose={() => setOpen(null)} onChanged={() => { load(); onChanged(); }} />
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState({ subject: '', body: '', priority: 'normal' });
  return (
    <Card>
      <CardHeader><CardTitle>Новое обращение</CardTitle><CardDescription>Номер выдаёт счётчик компании (<code>inc</code>): два одновременных обращения не получат один номер.</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={async (e) => {
          e.preventDefault();
          try { const t = await api<Ticket>('/api/tickets', v); toast.success(`Обращение ${t.number} создано`); setV({ subject: '', body: '', priority: 'normal' }); onDone(); }
          catch (err) { toast.error((err as Error).message); }
        }}>
          <div className="grid gap-2"><Label htmlFor="subject">Тема</Label><Input id="subject" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} required /></div>
          <div className="grid gap-2"><Label htmlFor="body">Что случилось</Label><Textarea id="body" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} required /></div>
          <div className="flex items-end gap-2">
            <div className="grid gap-2"><Label htmlFor="priority">Приоритет</Label>
              <Select items={priorityItems} value={v.priority} onValueChange={(p) => setV({ ...v, priority: String(p) })}>
                <SelectTrigger id="priority" className="w-44" aria-label="Приоритет"><SelectValue /></SelectTrigger>
                <SelectContent>{priorityItems.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select></div>
            <Button type="submit">Отправить</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TicketDialog({ id, me, tick, onClose, onChanged }: { id: string | null; me: Me; tick: number; onClose: () => void; onChanged: () => void }) {
  const staff = me.role !== 'client';
  const [d, setD] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [history, setHistory] = useState<Version[] | null>(null);
  const load = () => id ? api<Detail>(`/api/tickets/${id}`).then(setD, (e) => { toast.error(e.message); onClose(); }) : setD(null);
  useEffect(() => { setHistory(null); setText(''); setInternal(false); load(); }, [id]);
  useEffect(() => { if (id) load(); }, [tick]);
  if (!id || !d) return null;
  const t = d.ticket;
  const run = async (path: string, body: unknown, ok: string) => {
    let done = false;
    try { await api(path, body); toast.success(ok); done = true; } catch (e) { toast.error((e as Error).message); }
    if (path.endsWith('/delete') && done) { onChanged(); return true; }
    await load(); onChanged();
    return done;
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.number} · {t.subject}</DialogTitle>
          <DialogDescription>
            {STATUS[t.status]} · приоритет {PRIORITY[t.priority]} · срок {when(t.due)} · клиент {t.client} · агент {t.assignee || '—'} · версия {t.rev}
          </DialogDescription>
        </DialogHeader>
        <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{t.body}</p>
        {staff && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => run(`/api/tickets/${t.id}/assign`, {}, 'Заявка назначена на вас')}>Взять себе</Button>
            <Select items={statusItems} value={t.status} onValueChange={(s) => run(`/api/tickets/${t.id}/status`, { status: s, rev: t.rev }, `Статус: ${STATUS[String(s)]}`)}>
              <SelectTrigger size="sm" className="w-44" aria-label="Статус"><SelectValue /></SelectTrigger>
              <SelectContent>{statusItems.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={async () => setHistory(await api<Version[]>(`/api/tickets/${t.id}/history`))}>История</Button>
            <Button size="sm" variant="destructive" onClick={() => run(`/api/tickets/${t.id}/delete`, {}, 'Заявка удалена').then((ok) => { if (ok) onClose(); })}>Удалить</Button>
          </div>
        )}
        {history && (
          <Table>
            <TableHeader><TableRow><TableHead>rev</TableHead><TableHead>что</TableHead><TableHead>статус</TableHead><TableHead>кто</TableHead><TableHead>причина</TableHead><TableHead>когда</TableHead></TableRow></TableHeader>
            <TableBody>{history.map((v) => (
              <TableRow key={v.rev}><TableCell>{v.rev}</TableCell><TableCell>{v.op}</TableCell><TableCell>{STATUS[v.status] ?? v.status}</TableCell>
                <TableCell>{v.who}{v.agent && <span className="text-muted-foreground"> (исполнитель {v.agent})</span>}</TableCell><TableCell>{v.reason}</TableCell><TableCell>{when(v.at)}</TableCell></TableRow>))}</TableBody>
          </Table>
        )}
        <div className="grid gap-2">
          {d.posts.map((p) => (
            <div key={p.id} className={`rounded-md border p-2 text-sm ${p.internal ? 'border-amber-300 bg-amber-50' : ''}`} data-post={p.internal ? 'note' : 'reply'}>
              <div className="mb-1 text-xs text-muted-foreground">{when(p.at)} · {p.author}{p.internal && ' · внутренняя заметка (клиент её не видит)'}</div>
              <div className="whitespace-pre-wrap">{p.text}</div>
            </div>))}
          {d.posts.length === 0 && <p className="text-sm text-muted-foreground">Ответов пока нет.</p>}
        </div>
        <form className="grid gap-2" onSubmit={async (e) => {
          e.preventDefault();
          await run(`/api/tickets/${t.id}/reply`, { text, internal }, internal ? 'Заметка добавлена' : 'Ответ отправлен');
          setText(''); setInternal(false);
        }}>
          <Textarea placeholder={staff ? 'Ответ клиенту или внутренняя заметка' : 'Ваш ответ'} aria-label="Текст ответа" id="reply-text" name="text" value={text} onChange={(e) => setText(e.target.value)} required />
          <div className="flex items-center gap-3">
            {staff && <label className="flex items-center gap-2 text-sm"><input type="checkbox" id="reply-internal" name="internal" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> внутренняя заметка</label>}
            <Button type="submit" size="sm">Отправить</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
