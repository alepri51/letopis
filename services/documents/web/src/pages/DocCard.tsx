import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
// блок shadcnblocks: лента версий
import { Changelog1 } from '@/components/changelog1';
import { api, rub, when, type Doc, type Me, type Version } from '@/lib/api';

type Detail = { doc: Doc; versions: Version[] };
type Change = { field: string; before: unknown; after: unknown };
type Blame = { field: string; who: string; at: string; op: string; rev: number };
type Preview = { id: string; class: string; action: string; depth: number }[];

const OP: Record<string, string> = { create: 'создан', update: 'изменён', delete: 'удалён', restore: 'восстановлен', reclass: 'стал договором', rekey: 'новый номер', anonymize: 'обезличен', trim: 'история обрезана' };
const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Карточка документа: данные и правка с причиной, лента версий (versions({ follow }) — через смену номера и
 * класса), сравнение двух версий (diff), «кто менял» (blame), машина времени (asOf), подписание (reclass),
 * смена номера (rekey), обрезка истории (trimHistory), удаление с превью.
 */
export function DocCard({ id, me, tick, onOpen, onClose, onChanged }: {
  id: string | null; me: Me; tick: number; onOpen: (id: string) => void; onClose: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [edit, setEdit] = useState({ title: '', amount: '', body: '', reason: '' });
  const [cmp, setCmp] = useState<{ from: number; to: number; changes: Change[] | null }>({ from: 0, to: 0, changes: null });
  const [blame, setBlame] = useState<Blame[] | null>(null);
  const [moment, setMoment] = useState<{ idx: number; doc: Doc | null } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [number, setNumber] = useState('');
  // Подписание и смена номера меняют id документа: прежний id — надгробие, его чтение — 404 «Документ не найден».
  // Сигнал изменения (tick) приходит по SSE и может опередить ответ действия — тогда перечитывание по прежнему id
  // закрыло бы карточку. Поэтому пока идёт действие карточки (busy), tick её не перечитывает — перечитает само
  // действие (after); ответ чтения, пока карточка уже показывает другой id (cur), отбрасывается.
  const cur = useRef(id);
  useLayoutEffect(() => { cur.current = id; }); // сразу после отрисовки, до ответов, которые придут позже
  const busy = useRef(false);
  const load = async () => {
    if (!id) return setD(null);
    const asked = id;
    try {
      const r = await api<Detail>(`/api/docs/${asked}`);
      if (cur.current !== asked) return;
      setD(r);
      setEdit({ title: r.doc.title, amount: String(r.doc.amount), body: r.doc.body, reason: '' });
      setCmp({ from: Math.max(0, r.versions.length - 2), to: r.versions.length - 1, changes: null });
      setNumber(r.doc.number);
    } catch (e) {
      if (cur.current !== asked) return;
      toast.error((e as Error).message);
      onClose();
    }
  };
  useEffect(() => { setBlame(null); setMoment(null); setPreview(null); load(); }, [id]);
  useEffect(() => { if (id && !busy.current) load(); }, [tick]);
  if (!id || !d) return null;
  const doc = d.doc;
  // after — ответ действия (или null при ошибке) до onChanged: новый id открывается раньше, чем реестр перечитывается
  const run = async <T,>(path: string, body: unknown, ok: string, after?: (r: T | null) => void) => {
    busy.current = true;
    try { const r = await api<T>(path, body); toast.success(ok); after?.(r); onChanged(); return r; } catch (e) { toast.error((e as Error).message); after?.(null); return null; } finally { busy.current = false; }
  };
  const moved = (r: { doc?: Doc } | null) => { if (r?.doc && r.doc.id !== doc.id) onOpen(r.doc.id); else load(); };
  const v = d.versions;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{doc.number} · {doc.title}</DialogTitle>
          <DialogDescription>
            {doc.class === 'Contract' ? `договор, подписал ${doc.signedBy}` : doc.status === 'review' ? 'черновик на согласовании' : 'черновик'} ·
            {' '}{doc.partyName} · {rub(doc.amount)} · версия {doc.rev}{doc.archived ? ' · из архива' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {doc.class === 'Draft' && doc.status === 'draft' && <Button size="sm" variant="secondary" onClick={async () => await run<{ doc: Doc }>(`/api/docs/${doc.id}/review`, { rev: doc.rev }, 'Отправлен на согласование', moved)}>На согласование</Button>}
          {doc.class === 'Draft' && <Button size="sm" onClick={async () => await run<{ doc: Doc }>(`/api/docs/${doc.id}/sign`, {}, `Подписан: ${me.name}`, moved)}>Подписать</Button>}
          <form className="flex gap-1" onSubmit={async (e) => { e.preventDefault(); await run<{ doc: Doc }>(`/api/docs/${doc.id}/renumber`, { number }, `Новый номер: ${number}`, moved); }}>
            <Input id="new-number" aria-label="Новый номер" className="h-8 w-36" value={number} onChange={(e) => setNumber(e.target.value)} />
            <Button size="sm" variant="outline" type="submit">Сменить номер</Button>
          </form>
          <Button size="sm" variant="destructive" onClick={async () => { const r = await api<{ preview: Preview }>(`/api/docs/${doc.id}/delete`, {}).catch((e) => { toast.error(e.message); return null; }); if (r) setPreview(r.preview); }}>Удалить…</Button>
        </div>
        <Tabs defaultValue="data">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="data">Данные</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
            <TabsTrigger value="diff">Сравнить</TabsTrigger>
            <TabsTrigger value="blame" onClick={async () => setBlame((await api<{ fields: Blame[] }>(`/api/docs/${doc.id}/blame`)).fields)}>Кто менял</TabsTrigger>
            <TabsTrigger value="time">Машина времени</TabsTrigger>
          </TabsList>
          <TabsContent value="data">
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              await run<{ doc: Doc }>(`/api/docs/${doc.id}/update`, { title: edit.title, amount: Number(edit.amount), body: edit.body, rev: doc.rev, reason: edit.reason }, 'Сохранено — новая версия', moved);
            }}>
              <div className="grid gap-2"><Label htmlFor="e-title">Название</Label><Input id="e-title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-amount">Сумма, ₽</Label><Input id="e-amount" inputMode="numeric" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-body">Текст</Label><Textarea id="e-body" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-reason">Причина правки (попадёт в журнал)</Label><Input id="e-reason" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} required /></div>
              <p className="text-xs text-muted-foreground">Правка идёт с версией {doc.rev}: если документ уже изменил кто-то другой, база ответит конфликтом.</p>
              <Button type="submit" className="w-fit">Сохранить</Button>
            </form>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-sm">Контрагент {doc.partyName}</span>
              <Button size="sm" variant="outline" onClick={async () => { await run(`/api/parties/${doc.party}/anonymize`, {}, 'Персональные данные контрагента обезличены'); load(); }}>Обезличить контрагента</Button>
              <Button size="sm" variant="outline" onClick={async () => { const r = await run<{ trimmed: number }>(`/api/docs/${doc.id}/trim`, {}, 'История обрезана'); if (r) { toast.message(`Убрано версий: ${r.trimmed}`); load(); } }}>Обрезать историю до сегодня</Button>
            </div>
          </TabsContent>
          <TabsContent value="history">
            <Changelog1 description={`Версий: ${v.length}. Лента идёт через смену номера и превращение черновика в договор — versions({ follow: true }).`}
              entries={[...v].reverse().map((x) => ({
                version: `${x.class === 'Contract' ? 'договор' : 'черновик'} · v${x.rev}`, date: when(x.at),
                title: `${OP[x.op] ?? x.op} — ${x.who}`, description: x.reason || undefined,
                items: [`№ ${show(x.data.number)}`, `сумма ${show(x.data.amount)}`],
              }))} />
          </TabsContent>
          <TabsContent value="diff">
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Сравнить версию</span>
                <select id="cmp-from" aria-label="Версия до" className="rounded border px-2 py-1" value={cmp.from} onChange={(e) => setCmp({ ...cmp, from: Number(e.target.value), changes: null })}>
                  {v.map((x, i) => <option key={i} value={i}>{`${i + 1}. ${OP[x.op] ?? x.op} · ${when(x.at)}`}</option>)}
                </select>
                <span>с</span>
                <select id="cmp-to" aria-label="Версия после" className="rounded border px-2 py-1" value={cmp.to} onChange={(e) => setCmp({ ...cmp, to: Number(e.target.value), changes: null })}>
                  {v.map((x, i) => <option key={i} value={i}>{`${i + 1}. ${OP[x.op] ?? x.op} · ${when(x.at)}`}</option>)}
                </select>
                <Button size="sm" onClick={async () => {
                  const r = await api<{ changes: Change[] }>(`/api/docs/${doc.id}/diff?from=${encodeURIComponent(v[cmp.from].at)}&to=${encodeURIComponent(v[cmp.to].at)}`);
                  setCmp({ ...cmp, changes: r.changes });
                }}>Сравнить</Button>
              </div>
              {cmp.changes && (cmp.changes.length === 0 ? <p className="text-sm text-muted-foreground">Различий нет.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>поле</TableHead><TableHead>было</TableHead><TableHead>стало</TableHead></TableRow></TableHeader>
                  <TableBody>{cmp.changes.map((c, i) => <TableRow key={i} data-change={c.field}><TableCell className="font-medium">{c.field}</TableCell><TableCell className="text-destructive">{show(c.before)}</TableCell><TableCell className="text-emerald-700">{show(c.after)}</TableCell></TableRow>)}</TableBody>
                </Table>))}
            </div>
          </TabsContent>
          <TabsContent value="blame">
            {blame && (
              <Table>
                <TableHeader><TableRow><TableHead>поле</TableHead><TableHead>последним менял</TableHead><TableHead>когда</TableHead><TableHead>как</TableHead></TableRow></TableHeader>
                <TableBody>{blame.map((b, i) => <TableRow key={i} data-blame={b.field}><TableCell className="font-medium">{b.field}</TableCell><TableCell>{b.who}</TableCell><TableCell>{when(b.at)}</TableCell><TableCell>{OP[b.op] ?? b.op}</TableCell></TableRow>)}</TableBody>
              </Table>
            )}
          </TabsContent>
          <TabsContent value="time">
            <div className="grid gap-4 py-2">
              <p className="text-sm text-muted-foreground">Передвиньте ползунок: документ на выбранный момент — <code>asOf(момент)</code>.</p>
              <Slider min={0} max={Math.max(0, v.length - 1)} step={1} value={[moment?.idx ?? v.length - 1]} aria-label="Момент истории"
                onValueChange={async (val) => {
                  const idx = Array.isArray(val) ? Number(val[0]) : Number(val);
                  const r = await api<{ doc: Doc | null }>(`/api/docs/${v[idx].id}/asof?at=${encodeURIComponent(v[idx].at)}`);
                  setMoment({ idx, doc: r.doc });
                }} />
              {moment && (
                <div className="rounded-md border p-3 text-sm" data-asof={moment.idx}>
                  <div className="mb-1 text-xs text-muted-foreground">на {when(v[moment.idx].at)} ({OP[v[moment.idx].op] ?? v[moment.idx].op})</div>
                  {moment.doc ? <>
                    <div><b>{moment.doc.number}</b> · {moment.doc.title} · {rub(moment.doc.amount)} · {moment.doc.class === 'Contract' ? 'договор' : 'черновик'}</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{moment.doc.body}</div>
                  </> : <div className="text-muted-foreground">в этот момент документа под этим номером не было</div>}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
        <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Удалить {doc.number}?</DialogTitle>
              <DialogDescription><code>delete()</code> без подтверждения ничего не удаляет — показывает, что удалится. Удалённое можно восстановить из корзины.</DialogDescription></DialogHeader>
            <ul className="text-sm">{(preview ?? []).map((p) => <li key={p.id}>{'— '.repeat(p.depth)}{p.class}: {p.action}</li>)}</ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreview(null)}>Отмена</Button>
              <Button variant="destructive" onClick={async () => { setPreview(null); const r = await run(`/api/docs/${doc.id}/delete`, { confirm: true }, 'Удалён — документ в корзине'); if (r) onClose(); }}>Удалить</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
