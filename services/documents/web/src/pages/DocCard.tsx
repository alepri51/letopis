import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
// блок shadcnblocks: лента версий
import { Changelog1 } from '@/components/changelog1';
import { api, rub, when, type Doc, type Me, type Version } from '@/lib/api';

type Detail = { doc: Doc; versions: Version[] };
type Preview = { id: string; rev: number; class: string; action: string; depth: number }[];

const OP: Record<string, string> = { create: 'создан', update: 'изменён', delete: 'удалён', restore: 'восстановлен' };
const KIND: Record<string, string> = { Contract: 'договор', Draft: 'черновик' };
const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * Карточка документа: данные и правка с причиной, лента версий, машина времени (asOf), подписание, удаление с превью.
 * Подписание — новый объект Contract (класс входит в id) и удаление черновика одной транзакцией; лента договора
 * собирает версии обоих id.
 */
export function DocCard({ id, me, tick, onOpen, onClose, onChanged }: {
  id: string | null; me: Me; tick: number; onOpen: (id: string) => void; onClose: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [edit, setEdit] = useState({ title: '', amount: '', body: '', reason: '' });
  const [moment, setMoment] = useState<{ idx: number; doc: Doc | null } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Подписание меняет id документа: договор — новый объект, а id черновика — надгробие, его чтение — 404 «Документ не
  // найден». Сигнал изменения (tick) приходит по SSE и может опередить ответ действия — тогда перечитывание по прежнему
  // id закрыло бы карточку. Поэтому пока идёт действие карточки (busy), tick её не перечитывает — перечитает само
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
    } catch (e) {
      if (cur.current !== asked) return;
      toast.error((e as Error).message);
      onClose();
    }
  };
  useEffect(() => { setMoment(null); setPreview(null); load(); }, [id]);
  useEffect(() => { if (id && !busy.current) load(); }, [tick]);
  if (!id || !d) return null;
  const doc = d.doc;
  // after — ответ действия (или null при ошибке) до onChanged: новый id открывается раньше, чем реестр перечитывается
  const run = async <T,>(path: string, body: unknown, ok: string, after?: (r: T | null) => void) => {
    busy.current = true;
    try { const r = await api<T>(path, body); toast.success(ok); after?.(r); onChanged(); return r; } catch (e) { toast.error((e as Error).message); after?.(null); return null; } finally { busy.current = false; }
  };
  // ответ с документом под другим id (подписание) — открыть его, иначе перечитать этот
  const reopen = (r: { doc?: Doc } | null) => { if (r?.doc && r.doc.id !== doc.id) onOpen(r.doc.id); else load(); };
  const v = d.versions;
  const signed = doc.class === 'Contract' && v.some((x) => x.class === 'Draft');
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
          {doc.class === 'Draft' && doc.status === 'draft' && <Button size="sm" variant="secondary" onClick={async () => await run<{ doc: Doc }>(`/api/docs/${doc.id}/review`, { rev: doc.rev }, 'Отправлен на согласование', reopen)}>На согласование</Button>}
          {doc.class === 'Draft' && <Button size="sm" onClick={async () => await run<{ doc: Doc }>(`/api/docs/${doc.id}/sign`, {}, `Подписан: ${me.name}`, reopen)}>Подписать</Button>}
          <Button size="sm" variant="destructive" onClick={async () => { const r = await api<{ preview: Preview }>(`/api/docs/${doc.id}/delete`, {}).catch((e) => { toast.error(e.message); return null; }); if (r) setPreview(r.preview); }}>Удалить…</Button>
        </div>
        <Tabs defaultValue="data">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="data">Данные</TabsTrigger>
            <TabsTrigger value="history">История</TabsTrigger>
            <TabsTrigger value="time">Машина времени</TabsTrigger>
          </TabsList>
          <TabsContent value="data">
            <form className="grid gap-3" onSubmit={async (e) => {
              e.preventDefault();
              await run<{ doc: Doc }>(`/api/docs/${doc.id}/update`, { title: edit.title, amount: Number(edit.amount), body: edit.body, rev: doc.rev, reason: edit.reason }, 'Сохранено — новая версия', reopen);
            }}>
              <div className="grid gap-2"><Label htmlFor="e-title">Название</Label><Input id="e-title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-amount">Сумма, ₽</Label><Input id="e-amount" inputMode="numeric" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-body">Текст</Label><Textarea id="e-body" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
              <div className="grid gap-2"><Label htmlFor="e-reason">Причина правки (попадёт в журнал)</Label><Input id="e-reason" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} required /></div>
              <p className="text-xs text-muted-foreground">Правка идёт с версией {doc.rev}: если документ уже изменил кто-то другой, база ответит конфликтом.</p>
              <Button type="submit" className="w-fit">Сохранить</Button>
            </form>
          </TabsContent>
          <TabsContent value="history">
            <Changelog1 description={signed
              ? `Версий: ${v.length}. Договор — новый объект: подписание создало его и удалило черновик одной транзакцией. Лента собирает версии обоих id — черновика (db.idOf('Draft', { number })) и договора.`
              : `Версий: ${v.length}. Журнал хранит каждую версию целиком.`}
              entries={[...v].reverse().map((x) => ({
                version: `${KIND[x.class] ?? x.class} · v${x.rev}`, date: when(x.at),
                title: `${OP[x.op] ?? x.op} — ${x.who}`, description: x.reason || (x.agent ? `агент: ${x.agent}` : undefined),
                items: [`№ ${show(x.data.number)}`, `сумма ${show(x.data.amount)}`],
              }))} />
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
                  <div className="mb-1 text-xs text-muted-foreground">на {when(v[moment.idx].at)} ({KIND[v[moment.idx].class] ?? v[moment.idx].class} {OP[v[moment.idx].op] ?? v[moment.idx].op})</div>
                  {moment.doc ? <>
                    <div><b>{moment.doc.number}</b> · {moment.doc.title} · {rub(moment.doc.amount)} · {KIND[moment.doc.class] ?? moment.doc.class}</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{moment.doc.body}</div>
                  </> : <div className="text-muted-foreground">в этот момент {KIND[v[moment.idx].class] ?? 'документ'} уже удалён</div>}
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
              <Button variant="destructive" onClick={async () => { const shown = preview; setPreview(null); const r = await run(`/api/docs/${doc.id}/delete`, { confirm: true, expect: shown }, 'Удалён — документ в корзине'); if (r) onClose(); }}>Удалить</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
