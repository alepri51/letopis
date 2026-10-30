import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// блоки shadcnblocks: вход, навигация, показатели
import { Login1, LOGO } from '@/components/login1';
import { Navbar1 } from '@/components/navbar1';
import { Stats8 } from '@/components/stats8';
// панель «Под капотом» — общая для четырёх сервисов-примеров (services/shared/web)
import { UnderHood, type Trace } from '@shared/UnderHood';

type W = { id: string; number: string; owner: string; balance: number; rev: number };
type M = { id: string; wallet: string; opId: string; kind: string; amount: number; card4: string; at: string };
type S = { wallet: string; month: string; topup: number; debit: number; count: number };
type Data = { wallets: W[]; movements: M[]; statements: S[] };
type Version = { rev: number; op: string; balance: number; reason: string; at: string };
/** Состояние проектора выписки (status()) и его опции; failed — арендатор сессии выбыл. */
type Status = { state: string; version: number | null; cursor: string | null; at: string | null; lag: number;
  failed: { code: string; message: string } | null; options: { lockTimeout: number; lockRetries: number } };
type Verify = { ok: boolean; checked: number; anchor: string; issues: { id: string; rev: number | null; class: string; problem: string; label: string }[] };
type ApiError = Error & { status?: number; code?: string };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? r.statusText), { status: r.status, code: data.code });
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
  // счёт в диалоге владельца — снимок на момент открытия: его rev и есть «прочитанная версия»
  const [owner, setOwner] = useState<W | null>(null);
  const [drop, setDrop] = useState<W | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const reload = useCallback(async () => { setData(await api<Data>('/api/wallets')); setTrace(await api<Trace[]>('/api/trace')); }, []);
  useEffect(() => {
    reload();
    const es = new EventSource('/api/events');
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('changed', () => { reload(); });
    return () => es.close();
  }, [reload]);
  // состояние проектора — раз в 2 с; курсор сдвинулся — проектор записал пачку, выписку перечитать (у Statement нет
  // журнала, подписка о нём не сообщает)
  const cursor = useRef<string | null>(null);
  useEffect(() => {
    const poll = () => api<Status>('/api/statement').then((st) => {
      setStatus(st);
      if (cursor.current !== null && cursor.current !== st.cursor) reload();
      cursor.current = st.cursor;
    }, () => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [reload]);
  if (!data) return null;
  const total = data.wallets.reduce((s, w) => s + w.balance, 0);
  const rebuild = async () => {
    try { const r = await api<{ changes: number; created: number }>('/api/statement/rebuild', {}); toast.success(`Выписка перестроена: операций ${r.changes}, строк выписки ${r.created}`); }
    catch (e) { toast.error((e as Error).message); }
    reload();
  };
  const check = async () => {
    try { setVerify(await api<Verify>('/api/admin/verify')); } catch (e) { toast.error((e as Error).message); }
    reload();
  };
  const remove = async (w: W) => {
    setDrop(null);
    try { await api(`/api/wallets/${w.id}/delete`, {}); toast.success(`Счёт ${w.number} удалён`); }
    catch (e) { toast.error((e as Error).message); }
    reload();
  };
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
            <CardHeader><CardTitle>Счета</CardTitle><CardDescription>Пополнение тестовой картой, списание, перевод, история баланса, смена владельца по прочитанной версии, удаление.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Счёт</TableHead><TableHead>Владелец</TableHead><TableHead className="text-right">Баланс</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{data.wallets.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.number}</TableCell><TableCell data-owner={w.number}>{w.owner}</TableCell>
                    <TableCell className="text-right tabular-nums" data-balance={w.number}>{rub(w.balance)}</TableCell>
                    <TableCell className="flex flex-wrap gap-1">
                      <Button size="sm" data-act={`topup ${w.number}`} onClick={() => setDlg({ kind: 'topup', wallet: w })}>Пополнить</Button>
                      <Button size="sm" variant="secondary" data-act={`debit ${w.number}`} onClick={() => setDlg({ kind: 'debit', wallet: w })}>Списать</Button>
                      <Button size="sm" variant="outline" data-act={`transfer ${w.number}`} onClick={() => setDlg({ kind: 'transfer', wallet: w })}>Перевести</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { setHistory(await api(`/api/wallets/${w.id}/history`)); reload(); }}>История</Button>
                      <Button size="sm" variant="ghost" data-act={`owner ${w.number}`} onClick={() => setOwner(w)}>Владелец</Button>
                      <Button size="sm" variant="destructive" data-act={`delete ${w.number}`} onClick={() => setDrop(w)}>Удалить</Button>
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
            <CardHeader><CardTitle>Выписка по месяцам</CardTitle><CardDescription>Пишет проектор statement из журнала операций — с небольшим отставанием. Чужую блокировку строки выписки пачка ждёт не дольше lockTimeout; после lockRetries таких проходов подряд арендатор выбывает до перестройки.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              {status && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-status={status.state}>
                  <Badge variant="outline">status(): {status.state}</Badge>
                  <span>версия {status.version ?? '—'}</span>
                  <span data-lag={status.lag}>отставание {status.lag} мс</span>
                  <span>проход {status.at ? status.at.slice(11, 19) : '—'}</span>
                  <span>lockTimeout {status.options.lockTimeout} мс · lockRetries {status.options.lockRetries}</span>
                </div>)}
              {status?.failed && (
                <Alert variant="destructive" data-failed={status.failed.code}>
                  <AlertTitle>Выписка остановлена: {status.failed.code}</AlertTitle>
                  <AlertDescription>{status.failed.message}. Изменения пропускаются до перестройки — «Перестроить выписку» (rebuild({'{'} tenant {'}'})).</AlertDescription>
                </Alert>)}
              <Table>
                <TableHeader><TableRow><TableHead>месяц</TableHead><TableHead>счёт</TableHead><TableHead className="text-right">пополнено</TableHead><TableHead className="text-right">списано</TableHead><TableHead className="text-right">операций</TableHead></TableRow></TableHeader>
                <TableBody>{data.statements.map((s, i) => <TableRow key={i}><TableCell>{s.month}</TableCell><TableCell>{s.wallet}</TableCell><TableCell className="text-right" data-topup={s.wallet}>{rub(s.topup)}</TableCell><TableCell className="text-right">{rub(s.debit)}</TableCell><TableCell className="text-right">{s.count}</TableCell></TableRow>)}</TableBody>
              </Table>
              <div><Button size="sm" variant="outline" data-act="rebuild" onClick={rebuild}>Перестроить выписку</Button></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Целостность</CardTitle><CardDescription>verify({'{'} data: true {'}'}) администраторским подключением: цепочки хэшей журнала, данные против описаний классов, баланс каждого счёта против суммы его операций.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <div><Button size="sm" data-act="verify" onClick={check}>Проверить целостность</Button></div>
              {verify && (verify.ok
                ? <Alert data-verify="ok"><AlertTitle>Нарушений нет</AlertTitle><AlertDescription>Проверено версий: {verify.checked}. Цепочки хэшей сходятся, балансы равны сумме операций. Якорь {verify.anchor.slice(0, 16)}… — хэш голов цепочек: храните его вне базы.</AlertDescription></Alert>
                : <Alert variant="destructive" data-verify="issues"><AlertTitle>Найдены нарушения: {verify.issues.length}</AlertTitle>
                    <AlertDescription><ul>{verify.issues.map((i, k) => <li key={k}>{i.class} {i.label} v{i.rev ?? '—'}: {i.problem}</li>)}</ul></AlertDescription></Alert>)}
            </CardContent>
          </Card>
        </div>
        <UnderHood trace={trace} height="h-[640px]" empty="Пока пусто — проведите операцию."
          description="Цепочки, запросы к базе, записанные версии и сигналы классов, которые записало действие." />
      </div>
      <OpDialog dlg={dlg} wallets={data.wallets} onClose={() => setDlg(null)} onDone={() => { setDlg(null); reload(); }} />
      <OwnerDialog wallet={owner} onClose={() => setOwner(null)} onDone={() => { setOwner(null); reload(); }} />
      <Dialog open={drop !== null} onOpenChange={(o) => !o && setDrop(null)}>
        <DialogContent><DialogHeader><DialogTitle>Удалить счёт {drop?.number}?</DialogTitle>
          <DialogDescription>Конец Wallet у операций (Movement) — restrict, правило по умолчанию: счёт, на который ссылаются операции, база не удалит (delete_restricted). Удалить можно только счёт без операций.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setDrop(null)}>Отмена</Button><Button variant="destructive" data-act="confirm-delete" onClick={() => drop && remove(drop)}>Удалить</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent><DialogHeader><DialogTitle>История баланса</DialogTitle><DialogDescription>Каждое изменение баланса — версия кошелька с причиной операции.</DialogDescription></DialogHeader>
          <Table><TableHeader><TableRow><TableHead>rev</TableHead><TableHead>баланс</TableHead><TableHead>причина</TableHead><TableHead>когда</TableHead></TableRow></TableHeader>
            <TableBody>{(history ?? []).map((v) => <TableRow key={v.rev}><TableCell>{v.rev}</TableCell><TableCell>{rub(v.balance)}</TableCell><TableCell>{v.reason}</TableCell><TableCell>{v.at}</TableCell></TableRow>)}</TableBody></Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Обрыв связи с базой на COMMIT (пополнение): связь рвёт TCP-прокси сервиса. */
const CUTS = [['', 'нет'], ['before', 'до COMMIT — база его не получит'], ['after', 'после COMMIT — база зафиксирует, ответ не дойдёт']] as const;

function OpDialog({ dlg, wallets, onClose, onDone }: { dlg: { kind: 'topup' | 'debit' | 'transfer'; wallet: W } | null; wallets: W[]; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [lose, setLose] = useState(false);
  const [cut, setCut] = useState<'' | 'before' | 'after'>('');
  const [unordered, setUnordered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opId, setOpId] = useState(newOp());
  useEffect(() => { if (dlg) { setAmount(''); setCard(''); setExp(''); setCvc(''); setLose(false); setCut(''); setUnordered(false); setOpId(newOp()); } }, [dlg]);
  if (!dlg) return null;
  const other = wallets.find((w) => w.id !== dlg.wallet.id);
  const title = { topup: 'Пополнение картой', debit: 'Списание', transfer: `Перевод на ${other?.number ?? ''}` }[dlg.kind];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const kopecks = Math.round(Number(amount.replace(',', '.')) * 100);
    setBusy(true);
    try {
      const body = dlg.kind === 'transfer' ? { from: dlg.wallet.id, to: other!.id, amount: kopecks, opId, unordered }
        : { wallet: dlg.wallet.id, amount: kopecks, opId, card, lose, cut };
      const r = await api<{ result: string; unknown?: 'before' | 'after' | null; retries?: number }>(`/api/${dlg.kind}`, body);
      if (r.unknown) {
        toast.warning(r.unknown === 'before'
          ? `Связь с базой оборвалась до COMMIT — commit_unknown. Повтор с тем же opId провёл операцию: в первый раз она не записалась`
          : `Связь с базой оборвалась после COMMIT — commit_unknown. Повтор с тем же opId — «уже было»: операция записалась с первого раза, второй раз не проведена`);
      } else if (r.retries) {
        toast.success(`Готово: ${opId} — взаимная блокировка 40P01, блок db.begin() повторён: ${r.retries}`);
      } else {
        toast.success(r.result === 'уже было' ? `Операция ${opId} уже была проведена — повтор ничего не списал` : `Готово: ${opId}`);
      }
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.status === 504) { toast.warning(`${e2.message}. Нажмите «Провести» ещё раз — тот же opId.`); setLose(false); return; }
      toast.error(e2.message);
    } finally {
      setBusy(false);
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
            <fieldset className="grid gap-1 text-sm">
              <legend className="mb-1 font-medium">Обрыв связи с базой на COMMIT (commit_unknown)</legend>
              {CUTS.map(([v, text]) => (
                <label key={v || 'none'} className="flex items-center gap-2"><input type="radio" name="cut" id={`cut-${v || 'none'}`} checked={cut === v} onChange={() => setCut(v)} /> {text}</label>))}
            </fieldset>
          </>)}
          {dlg.kind === 'transfer' && (
            <label className="flex items-center gap-2 text-sm"><input id="unordered" type="checkbox" checked={unordered} onChange={(e) => setUnordered(e.target.checked)} />
              без порядка блокировок: сначала свой счёт, между замками 2 с — встречный перевод из второй вкладки поймает 40P01</label>)}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" data-act="submit" disabled={busy}>{busy ? 'Проводим…' : 'Провести'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Смена владельца по прочитанной версии: rev — из снимка счёта на момент открытия диалога. */
function OwnerDialog({ wallet, onClose, onDone }: { wallet: W | null; onClose: () => void; onDone: () => void }) {
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (wallet) setOwner(wallet.owner); }, [wallet]);
  if (!wallet) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ rev: number }>(`/api/wallets/${wallet.id}/owner`, { owner, rev: wallet.rev });
      toast.success(`Владелец ${wallet.number} — ${owner}: версия ${r.rev}`);
      onDone();
    } catch (err) {
      const e2 = err as ApiError;
      toast.error(e2.message);
      // устаревшая версия: диалог закрыт, счета перечитаны — откройте снова со свежей версией
      if (e2.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Владелец · {wallet.number}</DialogTitle>
          <DialogDescription>Правка по прочитанной версии: rev {wallet.rev}. Если счёт за это время изменился — другая вкладка, любая операция (баланс тоже поле счёта), — база ответит conflict и ничего не запишет.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="owner">Владелец</Label><Input id="owner" maxLength={60} value={owner} onChange={(e) => setOwner(e.target.value)} required /></div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" data-act="save-owner" disabled={busy}>Сохранить</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
