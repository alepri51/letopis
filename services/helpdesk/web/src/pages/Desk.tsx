import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
// блоки shadcnblocks: навигация и показатели
import { LOGO } from '@/components/login1';
import { Navbar1 } from '@/components/navbar1';
import { Stats8 } from '@/components/stats8';
// панель «Под капотом» — общая для четырёх сервисов-примеров (services/shared/web)
import { UnderHood, type Trace } from '@shared/UnderHood';
import { api, ROLE, type Me } from '@/lib/api';
import { Tickets } from '@/pages/Tickets';
import { Team } from '@/pages/Team';
import { Keys } from '@/pages/Keys';
import { Security } from '@/pages/Security';
import { Assistant } from '@/pages/Assistant';

type Stats = { open: number; urgent: number; mine: number; overdue: number };
const DOCS = 'http://127.0.0.1:8080/services/helpdesk';

/** Рабочее место: навигация по разделам (адрес после #), показатели, раздел и панель «Под капотом». */
export function Desk({ me, onMe }: { me: Me; onMe: (me: Me | null) => void }) {
  const [route, setRoute] = useState(location.hash.slice(1) || '/tickets');
  const [trace, setTrace] = useState<Trace[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const refresh = useCallback(async () => {
    setTrace(await api<Trace[]>('/api/trace').catch(() => []));
    setStats(await api<Stats>('/api/stats').catch(() => null));
  }, []);
  useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || '/tickets');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  // живая очередь: сервер подписан на изменения заявок (db.watch) и шлёт событие — раздел перечитывает данные
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('changed', () => setTick((t) => t + 1));
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [me.tenant]);
  useEffect(() => { refresh(); }, [refresh, route, tick]);
  // смена компании: auth.switch() — та же учётная запись, другой арендатор
  useEffect(() => {
    const m = /^\/switch\/(.+)$/.exec(route);
    if (!m) return;
    api<Me>('/api/switch', { tenant: m[1] }).then((next) => { onMe(next); toast.success(`Компания: ${next.company}`); }, (e) => toast.error(e.message))
      .finally(() => { location.hash = '/tickets'; });
  }, [route, onMe]);
  const staff = me.role !== 'client';
  const menu = [
    { title: staff ? 'Очередь' : 'Мои заявки', url: '#/tickets' },
    ...(me.role === 'manager' ? [{ title: 'Команда', url: '#/team' }, { title: 'Интеграции', url: '#/keys' }] : []),
    ...(staff ? [{ title: 'Помощник', url: '#/assistant' }] : []),
    { title: 'Безопасность', url: '#/security' },
    ...(me.companies.length > 1 ? [{
      title: `Компания: ${me.company}`, url: '#/tickets',
      items: me.companies.map((c) => ({ title: c.name, url: `#/switch/${c.tenant}`, description: c.tenant === me.tenant ? 'сейчас' : 'перейти — auth.switch()' })),
    }] : []),
  ];
  const page = route.startsWith('/team') ? <Team me={me} tick={tick} onChanged={refresh} />
    : route.startsWith('/keys') ? <Keys tick={tick} onChanged={refresh} />
    : route.startsWith('/security') ? <Security me={me} onMe={onMe} onChanged={refresh} />
    : route.startsWith('/assistant') ? <Assistant onChanged={refresh} />
    : <Tickets me={me} tick={tick} onChanged={refresh} />;
  return (
    <div className="min-h-screen bg-muted/40 p-6">
      {me.actingAs && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm">
          <span>Вы работаете от имени <b>{me.name}</b> ({ROLE[me.role]}). В журнал правок исполнителем записан {me.actingAs}.</span>
          <Button size="sm" variant="outline" onClick={async () => { onMe(await api<Me>('/api/act/stop', {})); location.hash = '/team'; }}>Вернуться к себе</Button>
        </div>
      )}
      <Navbar1 className="mb-4 rounded-xl border bg-background px-4 py-3"
        logo={{ url: '#/tickets', src: LOGO, alt: 'letopis', title: `${me.company} · ${me.name} (${ROLE[me.role]})` }}
        menu={menu}
        auth={{ login: { title: 'Документация', url: DOCS }, signup: { title: 'Выйти', url: '/logout' } }} />
      {stats && (
        <Stats8 className="mb-6 py-6" heading={staff ? 'Очередь поддержки' : 'Ваши обращения'}
          description={live ? 'Очередь обновляется сама: сервер подписан на изменения заявок (db.watch → SSE).' : 'Подключаем живое обновление…'}
          link={{ text: 'Как устроен сервис', url: DOCS }}
          stats={[
            { id: 'open', value: String(stats.open), label: staff ? 'открытых заявок' : 'открытых обращений' },
            { id: 'urgent', value: String(stats.urgent), label: 'срочных' },
            { id: 'mine', value: String(stats.mine), label: staff ? 'назначено мне' : 'ждут вашего ответа' },
            { id: 'overdue', value: String(stats.overdue), label: 'с истёкшим сроком' },
          ]} />
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1.3fr)]">
        <div className="min-w-0">{page}</div>
        <UnderHood trace={trace} height="h-[680px]" empty="Пока пусто — сделайте что-нибудь."
          description="Что сделал сервис на ваше действие: вызовы letopis, запросы к базе (onQuery; медленные — отмечены, slowMs), записанные версии и сигналы в канал схемы." />
      </div>
    </div>
  );
}
