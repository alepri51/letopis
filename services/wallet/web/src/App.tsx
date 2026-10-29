import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// блоки shadcnblocks: вход, навигация, показатели
import { Login1, LOGO } from '@/components/login1';
import { Navbar1 } from '@/components/navbar1';
import { Stats8 } from '@/components/stats8';

type W = { id: string; number: string; owner: string; balance: number };
type M = { id: string; wallet: string; opId: string; kind: string; amount: number; card4: string; at: string };
type S = { wallet: string; month: string; topup: number; debit: number; count: number };
type Data = { wallets: W[]; movements: M[]; statements: S[] };
type Trace = { at: string; title: string; lines: string[]; queries: { mode: string; classes: string; rows: number; ms: number }[]; error: string | null };
type Version = { rev: number; op: string; balance: number; reason: string; at: string };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? r.statusText), { status: r.status });
  return data as T;
}
const rub = (k: number) => `${(k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽`;
const newOp = () => `op-${Date.now().toString(36)}`;

export default function App() {
  const [me, setMe] = useState<{ name: string } | null | undefined>(undefined);
  useEffect(() => { api<{ name: string } | null>('/api/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return null;
  if (!me) {
    return <LoginScreen onLogin={setMe} />;
  }
  return <Billing me={me} />;
}

function LoginScreen({ onLogin }: { onLogin: (me: { name: string }) => void }) {
  const [error, setError] = useState('');
  return (
    <Login1 heading="Кошелёк «Копейка»" hint="Демо: admin@kopeika.ru / Kopeika-2026!" error={error}
      onSubmit={async (login, password) => { try { onLogin(await api('/api/login', { login, password })); } catch (e) { setError((e as Error).message); } }} />
  );
}

function Billing({ me }: { me: { name: string } }) {
  const [data, setData] = useState<Data | null>(null);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [live, setLive] = useState(false);
  const [dlg, setDlg] = useState<{ kind: 'topup' | 'debit' | 'transfer'; wallet: W } | null>(null);
  const [history, setHistory] = useState<Version[] | null>(null);
  const reload = useCallback(async () => { setData(await api<Data>('/api/wallets')); setTrace(await api<Trace[]>('/api/trace')); }, []);
  useEffect(() => {
    reload();
    const es = new EventSource('/api/events');
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('changed', () => { reload(); });
    return () => es.close();
  }, [reload]);
  if (!data) return null;
  const total = data.wallets.reduce((s, w) => s + w.balance, 0);
  return (
    <div className="min-h-screen bg-muted/40 p-6">
      <Navbar1 className="mb-4 rounded-xl border bg-background px-4 py-3"
        logo={{ url: '/', src: LOGO, alt: 'letopis', title: `Кошелёк «Копейка» · ${me.name}` }}
        menu={[{ title: 'Счета', url: '/' }, { title: live ? 'Живое обновление включено' : 'Подключается…', url: '/' }]}
        auth={{ login: { title: 'Документация', url: 'http://127.0.0.1:8080/services/wallet' }, signup: { title: 'Выйти', url: '/logout' } }} />
      <Stats8 className="mb-6 py-6" heading="Деньги без двойного списания"
        description="Баланс — сумма операций, её держит сама база. Повтор операции с тем же opId ничего не спишет второй раз."
        link={{ text: 'Как устроен сервис', url: 'http://127.0.0.1:8080/services/wallet' }}
        stats={[
          { id: 'total', value: rub(total), label: 'на всех счетах' },
          { id: 'wallets', value: String(data.wallets.length), label: 'счетов' },
          { id: 'ops', value: String(data.movements.length), label: 'последних операций' },
          { id: 'months', value: String(new Set(data.statements.map((s) => s.month)).size), label: 'месяцев в выписке' },
        ]} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1.3fr)]">
        <div className="grid gap-6">
          <Card>
            <CardHeader><CardTitle>Счета</CardTitle><CardDescription>Пополнение тестовой картой, списание, перевод, история баланса.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Счёт</TableHead><TableHead>Владелец</TableHead><TableHead className="text-right">Баланс</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{data.wallets.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.number}</TableCell><TableCell>{w.owner}</TableCell>
                    <TableCell className="text-right tabular-nums" data-balance={w.number}>{rub(w.balance)}</TableCell>
                    <TableCell className="flex flex-wrap gap-1">
                      <Button size="sm" data-act={`topup ${w.number}`} onClick={() => setDlg({ kind: 'topup', wallet: w })}>Пополнить</Button>
                      <Button size="sm" variant="secondary" data-act={`debit ${w.number}`} onClick={() => setDlg({ kind: 'debit', wallet: w })}>Списать</Button>
                      <Button size="sm" variant="outline" data-act={`transfer ${w.number}`} onClick={() => setDlg({ kind: 'transfer', wallet: w })}>Перевести</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { setHistory(await api(`/api/wallets/${w.id}/history`)); reload(); }}>История</Button>
                    </TableCell>
                  </TableRow>))}</TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Последние операции</CardTitle></CardHeader>
            <CardContent><Table>
              <TableHeader><TableRow><TableHead>когда</TableHead><TableHead>счёт</TableHead><TableHead>opId</TableHead><TableHead>вид</TableHead><TableHead className="text-right">сумма</TableHead></TableRow></TableHeader>
              <TableBody>{data.movements.map((m) => <TableRow key={m.id}><TableCell>{m.at}</TableCell><TableCell>{m.wallet}</TableCell><TableCell className="font-mono text-xs">{m.opId}</TableCell>
                <TableCell><Badge variant="outline">{m.kind}{m.card4 ? ` ·${m.card4}` : ''}</Badge></TableCell><TableCell className="text-right tabular-nums">{rub(m.amount)}</TableCell></TableRow>)}</TableBody>
            </Table></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Выписка по месяцам</CardTitle><CardDescription>Пишет проектор statement из журнала операций — с небольшим отставанием.</CardDescription></CardHeader>
            <CardContent><Table>
              <TableHeader><TableRow><TableHead>месяц</TableHead><TableHead>счёт</TableHead><TableHead className="text-right">пополнено</TableHead><TableHead className="text-right">списано</TableHead><TableHead className="text-right">операций</TableHead></TableRow></TableHeader>
              <TableBody>{data.statements.map((s, i) => <TableRow key={i}><TableCell>{s.month}</TableCell><TableCell>{s.wallet}</TableCell><TableCell className="text-right">{rub(s.topup)}</TableCell><TableCell className="text-right">{rub(s.debit)}</TableCell><TableCell className="text-right">{s.count}</TableCell></TableRow>)}</TableBody>
            </Table></CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle>Под капотом</CardTitle><CardDescription>Цепочки и запросы к базе для ваших действий.</CardDescription></CardHeader>
          <CardContent><ScrollArea className="h-[640px] pr-3">
            {trace.length === 0 && <p className="text-sm text-muted-foreground">Пока пусто — проведите операцию.</p>}
            {trace.map((t, i) => (
              <div key={i} className="mb-4">
                <div className="mb-1 flex items-center gap-2 text-sm font-medium">{t.at} — {t.title}{t.error && <Badge variant="destructive">ошибка</Badge>}</div>
                {t.lines.length > 0 && <pre className="mb-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{t.lines.join('\n')}</pre>}
                {t.error && <p className="text-xs text-destructive">{t.error}</p>}
              </div>))}
          </ScrollArea></CardContent>
        </Card>
      </div>
      <OpDialog dlg={dlg} wallets={data.wallets} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />
      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent><DialogHeader><DialogTitle>История баланса</DialogTitle><DialogDescription>Каждое изменение баланса — версия кошелька с причиной операции.</DialogDescription></DialogHeader>
          <Table><TableHeader><TableRow><TableHead>rev</TableHead><TableHead>баланс</TableHead><TableHead>причина</TableHead><TableHead>когда</TableHead></TableRow></TableHeader>
            <TableBody>{(history ?? []).map((v) => <TableRow key={v.rev}><TableCell>{v.rev}</TableCell><TableCell>{rub(v.balance)}</TableCell><TableCell>{v.reason}</TableCell><TableCell>{v.at}</TableCell></TableRow>)}</TableBody></Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OpDialog({ dlg, wallets, onClose, onDone }: { dlg: { kind: 'topup' | 'debit' | 'transfer'; wallet: W } | null; wallets: W[]; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [lose, setLose] = useState(false);
  const [opId, setOpId] = useState(newOp());
  useEffect(() => { if (dlg) { setAmount(''); setCard(''); setExp(''); setCvc(''); setLose(false); setOpId(newOp()); } }, [dlg]);
  if (!dlg) return null;
  const other = wallets.find((w) => w.id !== dlg.wallet.id);
  const title = { topup: 'Пополнение картой', debit: 'Списание', transfer: `Перевод на ${other?.number ?? ''}` }[dlg.kind];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const kopecks = Math.round(Number(amount.replace(',', '.')) * 100);
    try {
      const body = dlg.kind === 'transfer' ? { from: dlg.wallet.id, to: other!.id, amount: kopecks, opId }
        : { wallet: dlg.wallet.id, amount: kopecks, opId, card, lose };
      const r = await api<{ result: string }>(`/api/${dlg.kind}`, body);
      toast.success(r.result === 'уже было' ? `Операция ${opId} уже была проведена — повтор ничего не списал` : `Готово: ${opId}`);
      onDone();
    } catch (err) {
      const e2 = err as Error & { status?: number };
      if (e2.status === 504) { toast.warning(`${e2.message}. Нажмите «Провести» ещё раз — тот же opId.`); setLose(false); return; }
      toast.error(e2.message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title} · {dlg.wallet.number}</DialogTitle>
          <DialogDescription>Ключ операции <code>{opId}</code>: повтор с тем же ключом не проведёт её второй раз.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="amount">Сумма, ₽</Label><Input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
          {dlg.kind === 'topup' && (<>
            <div className="grid gap-2"><Label htmlFor="card">Номер карты (тестовая: 4242 4242 4242 4242)</Label>
              <Input id="card" inputMode="numeric" autoComplete="cc-number" value={card} onChange={(e) => setCard(e.target.value)} required /></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-2"><Label htmlFor="exp">Срок</Label><Input id="exp" placeholder="ММ/ГГ" autoComplete="cc-exp" value={exp} onChange={(e) => setExp(e.target.value)} required /></div>
              <div className="grid gap-2"><Label htmlFor="cvc">CVC</Label><Input id="cvc" type="password" autoComplete="cc-csc" value={cvc} onChange={(e) => setCvc(e.target.value)} required /></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input id="lose" type="checkbox" checked={lose} onChange={(e) => setLose(e.target.checked)} /> потерять ответ (имитация сбоя сети)</label>
          </>)}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit">Провести</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
