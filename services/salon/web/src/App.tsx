import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// блоки shadcnblocks: вход, навигация, показатели
import { Login1, LOGO } from '@/components/login1';
import { Navbar1 } from '@/components/navbar1';
import { Stats8 } from '@/components/stats8';
// панель «Под капотом» — общая для четырёх сервисов-примеров (services/shared/web)
import { UnderHood, type Trace } from '@shared/UnderHood';
import { api, clock, today, type Booking, type Me, type Schedule, type Staff, type Version } from '@/lib/api';
// экраны «Прайс» и «Отчёт дня»
import { Price } from '@/pages/Price';
import { Report } from '@/pages/Report';

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api<Me | null>('/api/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return null;
  return me ? <Salon me={me} onLogout={() => setMe(null)} /> : <Login onLogin={setMe} />;
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [error, setError] = useState('');
  return (
    <Login1
      heading="Салон записи"
      hint="Демо: admin@lokony.ru / Lokony-2026! · admin@lastochka.ru / Lastochka-2026!"
      error={error}
      onSubmit={async (login, password) => {
        try { onLogin(await api('/api/login', { login, password })); } catch (err) { setError((err as Error).message); }
      }}
    />
  );
}

function Salon({ me }: { me: Me; onLogout?: () => void }) {
  const [day] = useState(today());
  // экраны — по адресу после #: расписание (#/), прайс (#/price), отчёт дня (#/report)
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  const [data, setData] = useState<Schedule | null>(null);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [slot, setSlot] = useState<{ staff: Staff; hour: number } | null>(null);
  const [moving, setMoving] = useState<Booking | null>(null);
  const [history, setHistory] = useState<Version[] | null>(null);

  const loadTrace = useCallback(async () => { setTrace(await api<Trace[]>('/api/trace')); }, []);
  const reload = useCallback(async () => {
    setData(await api<Schedule>(`/api/schedule?day=${day}`));
    await loadTrace();
  }, [day, loadTrace]);

  useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || '/');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    reload();
    // живое обновление: подписка letopis на сервере → SSE → перечитать расписание (и отчёт дня — tick)
    const es = new EventSource('/api/events');
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('changed', () => { reload(); setTick((t) => t + 1); });
    // поток закрылся — сервер закрывает его вместе с веб-сессией (выход, в том числе в другой вкладке): вошёл другой или
    // никто — страница заново, иначе данные новой сессии того же браузера оказались бы под прежней шапкой
    es.onerror = () => {
      setLive(false);
      api<Me | null>('/api/me').then((m) => { if (m?.salon !== me.salon || m?.name !== me.name) location.reload(); }, () => {});
    };
    // уход со страницы (переход на /logout) — поток закрыть сразу: иначе сервер, закрывая его вместе с сессией, будил бы
    // onerror, и перезагрузка перебивала бы начатый переход
    const leave = () => es.close();
    addEventListener('beforeunload', leave);
    return () => {
      removeEventListener('beforeunload', leave);
      es.close();
    };
  }, [reload]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.success(ok); } catch (e) { toast.error((e as Error).message); }
    await reload();
  };
  const showHistory = async (id: string) => { setHistory(await api<Version[]>(`/api/bookings/${id}/history`)); await loadTrace(); };

  if (!data) return null;
  const at = (staff: string, hour: number) => data.bookings.find((b) => b.staff === staff && b.hour === hour);

  const schedule = (
    <Card>
      <CardHeader>
        <CardTitle>Расписание на {data.day}</CardTitle>
        <CardDescription>Броней за день: <b id="total">{data.total}</b>. Свободный слот — «Записать», бронь можно перенести на свободный.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="schedule">
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Время</TableHead>
              {data.staff.map((m) => <TableHead key={m.id}>{m.name} <span className="text-xs text-muted-foreground">{m.specialization}</span></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.hours.map((h) => (
              <TableRow key={h}>
                <TableCell className="font-medium">{h}:00</TableCell>
                {data.staff.map((m) => {
                  const b = at(m.id, h);
                  return b ? (
                    <TableCell key={m.id} className="busy bg-emerald-50 dark:bg-emerald-950">
                      <div className="font-medium">{b.customer}</div>
                      <div className="text-xs text-muted-foreground">{b.service}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/bookings/${b.id}/cancel`, {}), 'Бронь отменена')}>Отменить</Button>
                        <Button size="sm" variant="outline" data-slot-move={`${m.name} ${h}`} onClick={() => setMoving(b)}>Перенести</Button>
                        <Button size="sm" variant="ghost" onClick={() => showHistory(b.id)}>История</Button>
                      </div>
                    </TableCell>
                  ) : (
                    <TableCell key={m.id}><Button size="sm" variant="outline" data-slot-book={`${m.name} ${h}`} onClick={() => setSlot({ staff: m, hour: h })}>Записать</Button></TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data.cancelled.length > 0 && (
          <>
            <Separator className="my-4" />
            <h3 className="mb-2 font-medium">Отменённые в этот день</h3>
            <ul className="grid gap-2">
              {data.cancelled.map((b) => (
                <li key={b.id} className="flex items-center gap-2 text-sm">
                  {b.hour}:00 — {b.customer}
                  <Button size="sm" variant="outline" onClick={() => run(() => api(`/api/bookings/${b.id}/restore`, {}), 'Бронь возвращена')}>Вернуть</Button>
                  <Button size="sm" variant="ghost" onClick={() => showHistory(b.id)}>История</Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
  const page = route.startsWith('/price') ? <Price onChanged={loadTrace} />
    : route.startsWith('/report') ? <Report tick={tick} onChanged={loadTrace} />
    : schedule;

  return (
    <div className="min-h-screen bg-muted/40 p-6">
      <Navbar1
        className="mb-4 rounded-xl border bg-background px-4 py-3"
        logo={{ url: '#/', src: LOGO, alt: 'letopis', title: `Салон «${me.salon}» · ${me.name}` }}
        menu={[
          { title: 'Расписание', url: '#/' },
          { title: 'Прайс', url: '#/price' },
          { title: 'Отчёт дня', url: '#/report' },
          { title: live ? 'Живое обновление включено' : 'Подключается…', url: '#/' },
        ]}
        auth={{ login: { title: 'Документация', url: 'http://127.0.0.1:8080/services/salon' }, signup: { title: 'Выйти', url: '/logout' } }}
      />
      <Stats8
        className="mb-6 py-6"
        heading={`Сегодня в салоне «${me.salon}»`}
        description="Цифры считает letopis по броням дня; меняются сами, когда кто-то записывает, переносит или отменяет."
        link={{ text: 'Как устроен сервис', url: 'http://127.0.0.1:8080/services/salon' }}
        stats={[
          { id: 'total', value: String(data.total), label: 'броней за день' },
          { id: 'cancelled', value: String(data.cancelled.length), label: 'отменено' },
          { id: 'staff', value: String(data.staff.length), label: 'мастеров' },
          { id: 'services', value: String(data.services.length), label: 'услуг в каталоге' },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1.3fr)]">
        <div className="min-w-0">{page}</div>
        <UnderHood trace={trace} height="h-[560px]" empty="Пока пусто — запишите клиента."
          description="Что сделала библиотека для ваших действий: цепочки, запросы к базе, записанные версии и сигналы классов, которые записало действие." />
      </div>
      <BookDialog slot={slot} day={data.day} services={data.services} onClose={() => setSlot(null)} onDone={(msg, ok) => { setSlot(null); ok ? toast.success(msg) : toast.error(msg); reload(); }} />
      <MoveDialog key={moving?.id ?? ''} booking={moving} data={data} onClose={() => setMoving(null)} onDone={(msg, ok) => { setMoving(null); ok ? toast.success(msg) : toast.error(msg); reload(); }} />
      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>История брони</DialogTitle>
            <DialogDescription>Все версии из журнала letopis: что, когда и почему. Перенос меняет id брони — история идёт через смену id (<code>versions({'{'} follow: true {'}'})</code>).</DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader><TableRow><TableHead>id</TableHead><TableHead>rev</TableHead><TableHead>действие</TableHead><TableHead>мастер, начало</TableHead><TableHead>причина</TableHead><TableHead>когда</TableHead></TableRow></TableHeader>
            <TableBody>{(history ?? []).map((v) => (
              <TableRow key={`${v.id}-${v.rev}`} data-version={v.op}>
                <TableCell className="font-mono text-xs" title={v.id}>{v.id.slice(0, 8)}</TableCell>
                <TableCell>{v.rev}</TableCell>
                <TableCell><Badge variant="outline">{v.op}</Badge></TableCell>
                <TableCell>{v.staff} {v.start}</TableCell>
                <TableCell>{v.reason}</TableCell>
                <TableCell>{clock(v.at)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BookDialog({ slot, day, services, onClose, onDone }: {
  slot: { staff: Staff; hour: number } | null; day: string; services: { id: string; name: string }[];
  onClose: () => void; onDone: (msg: string, ok: boolean) => void;
}) {
  const [service, setService] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  useEffect(() => { if (slot) { setService(services[0]?.id ?? ''); setName(''); setPhone(''); } }, [slot, services]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slot) return;
    try {
      await api('/api/book', { day, hour: slot.hour, staff: slot.staff.id, service, name, phone });
      onDone(`${name} записан(а) на ${slot.hour}:00`, true);
    } catch (err) { onDone((err as Error).message, false); }
  };
  return (
    <Dialog open={slot !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Запись к мастеру {slot?.staff.name} на {slot?.hour}:00</DialogTitle>
          <DialogDescription>Бронь пишется одной транзакцией под блокировкой мастера — двойной записи не будет.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="book-service">Услуга</Label>
            <Select value={service} onValueChange={(v) => setService(v ?? "")} items={services.map((s) => ({ value: s.id, label: s.name }))}>
              <SelectTrigger id="book-service" aria-label="Услуга"><SelectValue placeholder="Услуга" /></SelectTrigger>
              <SelectContent>{services.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="grid gap-2"><Label htmlFor="client-name">Имя клиента</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="grid gap-2"><Label htmlFor="client-phone">Телефон</Label>
            <Input id="client-phone" type="tel" placeholder="+7 900 000-00-00" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit">Записать</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Перенос брони: мастер и свободный час того же дня. id брони — из ключа (мастер, время начала), поэтому сервер
 * переносит её rekey — новый id, история идёт через смену id. Слот заняли раньше — 409.
 * Диалог создаётся заново на каждую бронь (key): выбор — тот же мастер и его первый свободный час; перечитанное
 * расписание выбор не сбрасывает.
 */
function MoveDialog({ booking, data, onClose, onDone }: {
  booking: Booking | null; data: Schedule; onClose: () => void; onDone: (msg: string, ok: boolean) => void;
}) {
  // свободные часы мастера: без его броней (и самой переносимой)
  const freeOf = (id: string) => data.hours.filter((h) => !data.bookings.some((b) => b.staff === id && b.hour === h));
  const [staff, setStaff] = useState(booking?.staff ?? '');
  const [hour, setHour] = useState(() => String(freeOf(booking?.staff ?? '')[0] ?? ''));
  const pickStaff = (id: string) => {
    setStaff(id);
    if (!freeOf(id).includes(Number(hour))) setHour(String(freeOf(id)[0] ?? ''));
  };
  const free = freeOf(staff);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!booking || !hour) return;
    try {
      await api(`/api/bookings/${booking.id}/move`, { day: data.day, hour: Number(hour), staff });
      onDone(`${booking.customer}: бронь перенесена на ${hour}:00`, true);
    } catch (err) { onDone((err as Error).message, false); }
  };
  return (
    <Dialog open={booking !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Перенос брони: {booking?.customer}, {booking?.hour}:00</DialogTitle>
          <DialogDescription>Время начала — в ключе брони: перенос даёт ей новый id (<code>rekey</code>), история идёт через смену id. Под блокировкой мастера, как запись.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="move-staff">Мастер</Label>
            <Select value={staff} onValueChange={(v) => pickStaff(v ?? '')} items={data.staff.map((m) => ({ value: m.id, label: m.name }))}>
              <SelectTrigger id="move-staff" aria-label="Мастер"><SelectValue placeholder="Мастер" /></SelectTrigger>
              <SelectContent>{data.staff.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="grid gap-2"><Label htmlFor="move-hour">Время</Label>
            <Select value={hour} onValueChange={(v) => setHour(v ?? '')} items={free.map((h) => ({ value: String(h), label: `${h}:00` }))}>
              <SelectTrigger id="move-hour" aria-label="Время"><SelectValue placeholder="Свободных часов нет" /></SelectTrigger>
              <SelectContent>{free.map((h) => <SelectItem key={h} value={String(h)}>{h}:00</SelectItem>)}</SelectContent>
            </Select></div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" disabled={!hour}>Перенести</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
