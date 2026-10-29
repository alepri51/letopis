import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, rub, when, type Doc, type Me, type Party } from '@/lib/api';
import { DocCard } from '@/pages/DocCard';

/** Реестр: черновики и договоры, новый черновик, карточка документа. */
export function Registry({ me, tick, onChanged }: { me: Me; tick: number; onChanged: () => void }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<{ docs: Doc[]; parties: Party[] }>('/api/docs').then((r) => { setDocs(r.docs); setParties(r.parties); }, (e) => toast.error(e.message));
  useEffect(() => { load(); }, [tick]);
  return (
    <div className="grid gap-6">
      <NewDraft parties={parties} onDone={(id) => { load(); onChanged(); setOpen(id); }} />
      <Card>
        <CardHeader>
          <CardTitle>Реестр документов</CardTitle>
          <CardDescription>Черновик подписывают — он становится договором (<code>reclass</code>); номер можно сменить (<code>rekey</code>). История проходит через обе смены.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>№</TableHead><TableHead>документ</TableHead><TableHead>вид</TableHead><TableHead>контрагент</TableHead><TableHead className="text-right">сумма</TableHead><TableHead>версия</TableHead><TableHead>изменён</TableHead></TableRow></TableHeader>
            <TableBody>{docs.map((d) => (
              <TableRow key={d.id} className="cursor-pointer" data-doc={d.number} onClick={() => setOpen(d.id)}>
                <TableCell className="font-medium">{d.number}</TableCell>
                <TableCell>{d.title}{d.archived && <Badge variant="outline" className="ml-2">архив</Badge>}</TableCell>
                <TableCell>{d.class === 'Contract' ? <Badge>договор</Badge> : <Badge variant="secondary">{d.status === 'review' ? 'на согласовании' : 'черновик'}</Badge>}</TableCell>
                <TableCell>{d.partyName}</TableCell>
                <TableCell className="text-right tabular-nums">{rub(d.amount)}</TableCell>
                <TableCell>{d.rev}</TableCell>
                <TableCell>{when(d.at)}</TableCell>
              </TableRow>))}</TableBody>
          </Table>
        </CardContent>
      </Card>
      <DocCard id={open} me={me} tick={tick} onOpen={setOpen} onClose={() => setOpen(null)} onChanged={() => { load(); onChanged(); }} />
    </div>
  );
}

function NewDraft({ parties, onDone }: { parties: Party[]; onDone: (id: string) => void }) {
  const [v, setV] = useState({ number: '', title: '', amount: '', body: '', party: '' });
  const items = parties.map((p) => ({ value: p.id, label: p.name }));
  return (
    <Card>
      <CardHeader><CardTitle>Новый черновик</CardTitle><CardDescription>Номер — ключ документа: id выводится из него (v5), второй документ с тем же номером база не создаст.</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const d = await api<Doc>('/api/docs', { ...v, amount: Number(v.amount) });
            toast.success(`Черновик ${d.number} создан`);
            setV({ number: '', title: '', amount: '', body: '', party: '' });
            onDone(d.id);
          } catch (err) { toast.error((err as Error).message); }
        }}>
          <div className="grid gap-2"><Label htmlFor="num">Номер</Label><Input id="num" placeholder="Д-2026-10" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} required /></div>
          <div className="grid gap-2"><Label htmlFor="title">Название</Label><Input id="title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required /></div>
          <div className="grid gap-2"><Label htmlFor="amount">Сумма, ₽</Label><Input id="amount" inputMode="numeric" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} required /></div>
          <div className="grid gap-2"><Label>Контрагент</Label>
            <Select items={items} value={v.party} onValueChange={(p) => setV({ ...v, party: String(p) })}>
              <SelectTrigger aria-label="Контрагент"><SelectValue placeholder="выберите" /></SelectTrigger>
              <SelectContent>{items.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="grid gap-2 md:col-span-2"><Label htmlFor="body">Текст</Label><Textarea id="body" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} required /></div>
          <Button type="submit" className="w-fit">Создать черновик</Button>
        </form>
      </CardContent>
    </Card>
  );
}
