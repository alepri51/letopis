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

type Member = { account: string; name: string; login: string; role: Role; self: boolean };
type Invited = { id: string; login: string; role: Role; until: string };
const ROLES = Object.entries(ROLE).map(([value, label]) => ({ value, label }));

/**
 * Команда компании (только руководитель): приглашение с ролью (me.invite — человек примет его сам по ссылке), работа от
 * имени (db.as), удаление из компании — выписка (ключи и сессии гаснут), закрытие компании (me.deleteTenant).
 */
export function Team({ me, tick, onChanged }: { me: Me; tick: number; onChanged: () => void }) {
  const [team, setTeam] = useState<Member[]>([]);
  const [invited, setInvited] = useState<Invited[]>([]);
  const [inv, setInv] = useState({ name: '', login: '', role: 'client' });
  const [remove, setRemove] = useState<Member | null>(null);
  const [closing, setClosing] = useState(false);
  const load = () => api<{ team: Member[]; invited: Invited[] }>('/api/team').then((r) => { setTeam(r.team); setInvited(r.invited); }, (e) => toast.error(e.message));
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
          <CardDescription>Роль — метка прописки (поле <code>roles</code> строки <code>member</code>); что можно каждой метке, решает матрица квартиры в базе.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>имя</TableHead><TableHead>email</TableHead><TableHead>роль</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{team.map((m) => (
              <TableRow key={m.account} data-member={m.login}>
                <TableCell className="font-medium">{m.name}{m.self && <span className="text-muted-foreground"> (вы)</span>}</TableCell>
                <TableCell>{m.login}</TableCell>
                <TableCell><Badge variant="outline">{ROLE[m.role]}</Badge></TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  {!m.self && <>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      try { await api(`/api/team/${m.account}/act`, {}); location.hash = '/tickets'; location.reload(); } catch (e) { toast.error((e as Error).message); }
                    }}>Работать от имени</Button>
                    {m.role !== 'manager' && <Button size="sm" variant="destructive" onClick={() => setRemove(m)}>Удалить из компании</Button>}
                  </>}
                </TableCell>
              </TableRow>))}</TableBody>
          </Table>
          {invited.length > 0 && (
            <Table className="mt-4">
              <TableHeader><TableRow><TableHead>приглашён</TableHead><TableHead>роль</TableHead><TableHead>ссылка действует до</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{invited.map((i) => (
                <TableRow key={i.id} data-invited={i.login}>
                  <TableCell>{i.login}</TableCell><TableCell><Badge variant="outline">{ROLE[i.role]}</Badge></TableCell>
                  <TableCell>{new Date(i.until).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</TableCell>
                  <TableCell><Button size="sm" variant="outline" onClick={() => act(`/api/team/invites/${i.id}/revoke`, `Приглашение ${i.login} отменено`)}>Отменить</Button></TableCell>
                </TableRow>))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Пригласить</CardTitle>
          <CardDescription>
            Звать может тот, кому матрица разрешает выдать роль: руководителю (owner) — любую (<code>me.invite</code>). Письмо со
            ссылкой уходит в демо-почту; человек открывает ссылку, принимает приглашение и, по желанию, задаёт пароль — тогда
            появляется прописка с ролью. Человек из другой компании входит тем же email — пароль у этой компании свой.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-2 md:grid-cols-[1fr_1fr_180px_auto]" onSubmit={async (e) => {
            e.preventDefault();
            try { await api('/api/team/invite', inv); toast.success(`${inv.name}: приглашение отправлено`); setInv({ name: '', login: '', role: 'client' }); load(); onChanged(); }
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
            <code>me.deleteTenant()</code> стирает квартиру компании целиком: заявки, ответы, профили, правила, прописки и их
            историю; ключи и сессии в ней гаснут. Демо-компании закрыть нельзя — зарегистрируйте свою и попробуйте на ней.
          </CardDescription>
        </CardHeader>
        <CardContent><Button variant="destructive" onClick={() => setClosing(true)}>Закрыть «{me.company}» навсегда</Button></CardContent>
      </Card>
      <Dialog open={remove !== null} onOpenChange={(o) => !o && setRemove(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Удалить {remove?.name} из компании?</DialogTitle>
            <DialogDescription>
              Прописка удаляется — ключи и сессии этого человека в компании гаснут сразу: следующий его запрос — вход заново,
              а войти сюда ему больше нечем. Заявки остаются в компании, запись в справочнике (имя и email) — тоже.
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
            <DialogDescription>Все данные компании будут стёрты без возможности восстановления. Ваш аккаунт и ключи других компаний останутся.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(false)}>Отмена</Button>
            <Button variant="destructive" onClick={async () => {
              setClosing(false);
              try {
                const r = await api<{ rows: number }>('/api/company/close', {});
                toast.success(`Компания закрыта: стёрто строк ${r.rows}`);
                setTimeout(() => location.assign('/'), 1500);
              } catch (e) { toast.error((e as Error).message); }
            }}>Закрыть навсегда</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
