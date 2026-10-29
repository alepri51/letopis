import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, rub, when } from '@/lib/api';

type Deleted = { id: string; class: string; number: string; title: string; amount: number; at: string; who: string };

/** Корзина: удалённые документы (withDeleted) — восстановить (restore) или стереть историю навсегда (purge). */
export function Trash({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Deleted[]>([]);
  const load = () => api<Deleted[]>('/api/trash').then(setRows, (e) => toast.error(e.message));
  useEffect(() => { load(); }, [tick]);
  const act = async (path: string, ok: string) => {
    try { await api(path, {}); toast.success(ok); } catch (e) { toast.error((e as Error).message); }
    load(); onChanged();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Корзина</CardTitle>
        <CardDescription>
          Удалённый документ — надгробие в журнале: <code>withDeleted()</code> его находит, <code>restore()</code> возвращает
          с прежним id. <code>purge()</code> стирает историю удалённого целиком — вернуть уже нельзя.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">Корзина пуста.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>№</TableHead><TableHead>документ</TableHead><TableHead className="text-right">сумма</TableHead><TableHead>удалил</TableHead><TableHead>когда</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{rows.map((r) => (
              <TableRow key={r.id} data-deleted={r.number}>
                <TableCell className="font-medium">{r.number}</TableCell><TableCell>{r.title}</TableCell><TableCell className="text-right">{rub(r.amount)}</TableCell>
                <TableCell>{r.who}</TableCell><TableCell>{when(r.at)}</TableCell>
                <TableCell className="flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => act(`/api/trash/${r.id}/restore`, `${r.number} восстановлен`)}>Восстановить</Button>
                  <Button size="sm" variant="destructive" onClick={() => act(`/api/trash/${r.id}/purge`, `История ${r.number} стёрта`)}>Стереть навсегда</Button>
                </TableCell>
              </TableRow>))}</TableBody>
          </Table>)}
      </CardContent>
    </Card>
  );
}
