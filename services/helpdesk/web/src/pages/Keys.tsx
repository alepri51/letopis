import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';

type Key = { id: string; name: string; created: string; revoked: boolean };

/** Интеграции: ключи API. Ключ показывается один раз — в базе хранится только его хэш. */
export function Keys({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ key: string; name: string } | null>(null);
  const load = () => api<Key[]>('/api/keys').then(setKeys, (e) => toast.error(e.message));
  useEffect(() => { load(); }, [tick]);
  const curl = issued && `curl -X POST ${location.origin}/api/integration/tickets \\\n  -H "Authorization: Bearer ${issued.key}" \\\n  -H "content-type: application/json" \\\n  -d '{"subject":"Не приходит счёт","body":"Письмо из формы на сайте","from":"client@sever.ru"}'`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Интеграции: ключи API</CardTitle>
        <CardDescription>
          Ключ даёт программе (форма на сайте, почтовый шлюз) вход без пароля. У каждого ключа — свой аккаунт с ролью
          <code> integration</code>: руководитель зовёт его (<code>me.invite</code>) на служебный адрес, сервис сам забирает ссылку,
          принимает приглашение за программу и выпускает ей ключ (<code>keys.issueApiKey</code>). «Отозвать» выписывает этот аккаунт — ключ и его сессии гаснут.
          Тот же ключ подходит для адреса <code>/mcp</code> — только чтение.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form className="flex gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try { const r = await api<{ key: string }>('/api/keys', { name }); setIssued({ key: r.key, name }); setName(''); load(); onChanged(); }
          catch (err) { toast.error((err as Error).message); }
        }}>
          <Input placeholder="Назначение ключа, например «форма на сайте»" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button type="submit">Выдать ключ</Button>
        </form>
        <Table>
          <TableHeader><TableRow><TableHead>назначение</TableHead><TableHead>выдан</TableHead><TableHead>состояние</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>{keys.map((k) => (
            <TableRow key={k.id} data-key={k.name}>
              <TableCell>{k.name}</TableCell><TableCell>{new Date(k.created).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</TableCell>
              <TableCell>{k.revoked ? <Badge variant="outline">отозван</Badge> : <Badge>действует</Badge>}</TableCell>
              <TableCell>{!k.revoked && <Button size="sm" variant="outline" onClick={async () => { await api(`/api/keys/${k.id}/revoke`, {}); toast.success('Ключ отозван'); load(); onChanged(); }}>Отозвать</Button>}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      </CardContent>
      <Dialog open={issued !== null} onOpenChange={(o) => !o && setIssued(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Ключ «{issued?.name}»</DialogTitle>
            <DialogDescription>Скопируйте ключ сейчас: больше его не покажет никто — в базе только хэш.</DialogDescription></DialogHeader>
          <code className="break-all rounded bg-muted p-2 text-sm" data-issued-key={issued?.key}>{issued?.key}</code>
          <p className="text-sm">Заявка от интеграции:</p>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{curl}</pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
