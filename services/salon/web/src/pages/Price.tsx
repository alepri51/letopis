import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, rub, type LoadReport, type PriceRow } from '@/lib/api';

/** Что сделал upsert ($upsert строки). */
const UPSERT: Record<string, string> = { created: 'цена создана', updated: 'цена заменена', unchanged: 'цена та же — новой версии нет' };

/**
 * Прайс салона — класс price сида (ключ [Item, note]): цена услуги — upsert (POST /api/price/:услуга), прайс списком —
 * db.load() администраторским подключением от имени вошедшего (POST /api/price/load). onChanged — перечитать панель
 * «Под капотом».
 */
export function Price({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [list, setList] = useState('');
  const [report, setReport] = useState<LoadReport | null>(null);
  const load = useCallback(async () => {
    const r = await api<PriceRow[]>('/api/price');
    setRows(r);
    setEdit(Object.fromEntries(r.map((x) => [x.id, x.price === null ? '' : String(x.price)])));
    return r;
  }, []);
  // список для загрузки — по умолчанию нынешний прайс
  useEffect(() => {
    load().then((r) => setList(r.map((x) => `${x.name}; ${x.price ?? ''}`).join('\n')), (e) => toast.error((e as Error).message));
  }, [load]);

  const save = async (x: PriceRow) => {
    try {
      const r = await api<{ upsert: string; rev: number }>(`/api/price/${x.id}`, { amount: Number(edit[x.id]) });
      toast.success(`${x.name}: ${UPSERT[r.upsert] ?? r.upsert}`);
    } catch (e) { toast.error((e as Error).message); }
    await load();
    onChanged();
  };
  const upload = async () => {
    try {
      const r = await api<LoadReport>('/api/price/load', { text: list });
      setReport(r);
      toast.success(`Прайс загружен: новых ${r.loaded}, обновлено ${r.updated}, без изменений ${r.skipped}`);
    } catch (e) { toast.error((e as Error).message); }
    await load();
    onChanged();
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Прайс салона</CardTitle>
          <CardDescription>
            Цена — строка класса <code>price</code> с ключом <code>[Item, note]</code>. «Сохранить» — <code>upsert</code>: цены нет —
            создаётся, есть — заменяется целиком; те же данные — без новой версии.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows && (
            <Table className="price">
              <TableHeader>
                <TableRow><TableHead>Услуга</TableHead><TableHead>Длительность</TableHead><TableHead>Цена</TableHead><TableHead className="w-64">Новая цена, ₽</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((x) => (
                  <TableRow key={x.id} data-price={x.name}>
                    <TableCell className="font-medium">{x.name}</TableCell>
                    <TableCell>{x.duration ? `${x.duration} мин` : '—'}</TableCell>
                    <TableCell>{x.price === null ? <span className="text-muted-foreground">нет цены</span> : <>{rub(x.price)} <Badge variant="outline">v{x.rev}</Badge></>}</TableCell>
                    <TableCell>
                      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save(x); }}>
                        <Input type="number" min={0} step={1} required aria-label={`Цена: ${x.name}`} value={edit[x.id] ?? ''}
                          onChange={(e) => setEdit({ ...edit, [x.id]: e.target.value })} />
                        <Button type="submit" size="sm">Сохранить</Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Прайс списком</CardTitle>
          <CardDescription>
            Строка — «услуга; цена», не больше 1000 строк по 200 знаков. Список пишет <code>db.load()</code> администраторским подключением: <code>COPY</code> мимо RLS одной
            транзакцией, от вашего имени и в ваш салон (<code>as</code>, <code>tenant</code>) — права и услуги проверяет загрузчик.
            <code> existing: 'update'</code>: цена есть — новая версия, та же — пропуск.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Label htmlFor="price-list">Список</Label>
          <Textarea id="price-list" rows={5} className="font-mono" value={list} onChange={(e) => setList(e.target.value)} />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={upload}>Загрузить списком</Button>
            {report && (
              <span className="text-sm text-muted-foreground" id="load-report">
                строк {report.rows}: новых {report.loaded}, обновлено {report.updated}, без изменений {report.skipped} · {report.ms} мс
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
