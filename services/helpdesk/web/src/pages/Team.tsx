import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ROLE, type Me, type Role } from '@/lib/api';

type Member = { account: string; name: string; login: string; role: Role; totp: boolean; self: boolean };
const ROLES = Object.entries(ROLE).map(([value, label]) => ({ value, label }));

/**
 * Команда компании (только руководитель): приглашение в арендатора с ролью, работа от имени, завершение чужих
 * сеансов (auth.revokeAll), удаление из компании (членство), закрытие компании (auth.purgeAccount).
 */
export function Team({ me, tick, onChanged }: { me: Me; tick: number; onChanged: () => void }) {
  const [team, setTeam] = useState<Member[]>([]);
  const [inv, setInv] = useState({ name: '', login: '', role: 'client' });
  const [remove, setRemove] = useState<Member | null>(null);
  const [closing, setClosing] = useState(false);
  const load = () => api<Member[]>('/api/team').then(setTeam, (e) => toast.error(e.message));
  useEffect(() => { load(); }, [tick]);
  const act = async (path: string, ok: string) => {
    try { await api(path, {}); toast.success(ok); } catch (e) { toast.error((e as Error).message); }
    load(); onChanged();
  };
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Команда «{me.company}»</CardTitle>
          <CardDescription>Роль — поле <code>roles</code> членства (класс <code>member</code>); что можно каждой роли, решают правила доступа в базе.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>имя</TableHead><TableHead>логин</TableHead><TableHead>роль</TableHead><TableHead>TOTP</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{team.map((m) => (
              <TableRow key={m.account} data-member={m.login}>
                <TableCell className="font-medium">{m.name}{m.self && <span className="text-muted-foreground"> (вы)</span>}</TableCell>
                <TableCell>{m.login}</TableCell>
                <TableCell><Badge variant="outline">{ROLE[m.role]}</Badge></TableCell>
                <TableCell>{m.totp ? 'да' : '—'}</TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  {!m.self && <>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      try { await api(`/api/team/${m.account}/act`, {}); location.hash = '/tickets'; location.reload(); } catch (e) { toast.error((e as Error).message); }
                    }}>Работать от имени</Button>
                    <Button size="sm" variant="outline" onClick={() => act(`/api/team/${m.account}/revoke`, `Сеансы ${m.name} завершены`)}>Завершить сеансы</Button>
                    {m.role !== 'manager' && <Button size="sm" variant="destructive" onClick={() => setRemove(m)}>Удалить из компании</Button>}
                  </>}
                </TableCell>
              </TableRow>))}</TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Пригласить</CardTitle>
          <CardDescription>Новый пользователь заводится в этой же компании (<code>createTenant</code> с её именем) и получает роль. Приглашение уходит в демо-почту: войти можно по коду на почту.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-2 md:grid-cols-[1fr_1fr_180px_auto]" onSubmit={async (e) => {
            e.preventDefault();
            try { await api('/api/team/invite', inv); toast.success(`${inv.name} приглашён(а)`); setInv({ name: '', login: '', role: 'client' }); load(); onChanged(); }
            catch (err) { toast.error((err as Error).message); }
          }}>
            <Input placeholder="Имя" aria-label="Имя" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} required />
            <Input type="email" placeholder="Email" aria-label="Email" value={inv.login} onChange={(e) => setInv({ ...inv, login: e.target.value })} required />
            <Select items={ROLES} value={inv.role} onValueChange={(v) => setInv({ ...inv, role: String(v) })}>
              <SelectTrigger aria-label="Роль"><SelectValue /></SelectTrigger>
              <SelectContent>{ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="submit">Пригласить</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Закрыть компанию</CardTitle>
          <CardDescription>
            <code>auth.purgeAccount(компания)</code> стирает данные арендатора целиком: заявки, ответы, профили, правила,
            членства и их историю. Демо-компании закрыть нельзя — зарегистрируйте свою и попробуйте на ней.
          </CardDescription>
        </CardHeader>
        <CardContent><Button variant="destructive" onClick={() => setClosing(true)}>Закрыть «{me.company}» навсегда</Button></CardContent>
      </Card>
      <Dialog open={remove !== null} onOpenChange={(o) => !o && setRemove(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Удалить {remove?.name} из компании?</DialogTitle>
            <DialogDescription>
              Членство удаляется — доступ закрывается сразу: следующий запрос этого человека получит отказ базы.
              Заявки остаются в компании, запись в справочнике (имя и email) — тоже: по ней видно, кто их вёл.
            </DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemove(null)}>Отмена</Button>
            <Button variant="destructive" onClick={() => { const m = remove!; setRemove(null); act(`/api/team/${m.account}/remove`, `${m.name} больше не в компании`); }}>Удалить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent>
          <DialogHeader><DialogTitle>Закрыть «{me.company}»?</DialogTitle>
            <DialogDescription>Все данные компании будут стёрты без возможности восстановления. Ваша учётная запись останется.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(false)}>Отмена</Button>
            <Button variant="destructive" onClick={async () => {
              setClosing(false);
              try {
                const r = await api<{ rows: number; versions: number }>('/api/company/close', {});
                toast.success(`Компания закрыта: стёрто строк ${r.rows}, версий ${r.versions}`);
                setTimeout(() => location.assign('/'), 1500);
              } catch (e) { toast.error((e as Error).message); }
            }}>Закрыть навсегда</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
