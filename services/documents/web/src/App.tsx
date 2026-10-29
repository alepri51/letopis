import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
// блоки shadcnblocks: вход, навигация, показатели
import { Login1, LOGO } from '@/components/login1';
import { Navbar1 } from '@/components/navbar1';
import { Stats8 } from '@/components/stats8';
import { api, type Me, type Trace } from '@/lib/api';
import { Registry } from '@/pages/Registry';
import { Trash } from '@/pages/Trash';
import { Maintenance } from '@/pages/Maintenance';

const DOCS = 'http://127.0.0.1:8080/services/documents';
type Stats = { drafts: number; contracts: number; deleted: number; versions: number };

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { api<Me | null>('/api/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return null;
  if (!me) {
    return <Login1 heading="Документы с аудитом" hint="Демо: юрист lawyer@pravo.ru / Pravo-2026!, руководитель head@pravo.ru / Head-2026!" error={error}
      onSubmit={async (login, password) => { try { setMe(await api<Me>('/api/login', { login, password })); } catch (e) { setError((e as Error).message); } }} />;
  }
  return <Office me={me} />;
}

function Office({ me }: { me: Me }) {
  const [route, setRoute] = useState(location.hash.slice(1) || '/docs');
  const [trace, setTrace] = useState<Trace[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(async () => {
    setTrace(await api<Trace[]>('/api/trace').catch(() => []));
    setStats(await api<Stats>('/api/stats').catch(() => null));
  }, []);
  useEffect(() => {
    const onHash = () => setRoute(location.hash.slice(1) || '/docs');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('changed', () => setTick((t) => t + 1));
    es.onerror = () => toast.error('Живое обновление прервалось — обновите страницу');
    return () => es.close();
  }, []);
  useEffect(() => { refresh(); }, [refresh, route, tick]);
  const page = route.startsWith('/trash') ? <Trash tick={tick} onChanged={refresh} />
    : route.startsWith('/admin') ? <Maintenance me={me} onChanged={refresh} />
    : <Registry me={me} tick={tick} onChanged={refresh} />;
  return (
    <div className="min-h-screen bg-muted/40 p-6">
      <Navbar1 className="mb-4 rounded-xl border bg-background px-4 py-3"
        logo={{ url: '#/docs', src: LOGO, alt: 'letopis', title: `${me.firm} · ${me.name} (${me.role})` }}
        menu={[{ title: 'Реестр', url: '#/docs' }, { title: 'Корзина', url: '#/trash' }, { title: 'Обслуживание', url: '#/admin' }]}
        auth={{ login: { title: 'Документация', url: DOCS }, signup: { title: 'Выйти', url: '/logout' } }} />
      {stats && (
        <Stats8 className="mb-6 py-6" heading="Документы с полной историей"
          description="Каждая правка — новая версия в журнале: кто, когда и почему. Любое прошлое состояние можно открыть, сравнить и проверить."
          link={{ text: 'Как устроен сервис', url: DOCS }}
          stats={[
            { id: 'drafts', value: String(stats.drafts), label: 'черновиков' },
            { id: 'contracts', value: String(stats.contracts), label: 'договоров' },
            { id: 'deleted', value: String(stats.deleted), label: 'в корзине' },
            { id: 'versions', value: String(stats.versions), label: 'версий в журнале' },
          ]} />
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(320px,1.3fr)]">
        <div className="min-w-0">{page}</div>
        <Card>
          <CardHeader><CardTitle>Под капотом</CardTitle><CardDescription>Вызовы letopis и запросы к базе для ваших действий.</CardDescription></CardHeader>
          <CardContent><ScrollArea className="h-[680px] pr-3">
            {trace.length === 0 && <p className="text-sm text-muted-foreground">Пока пусто — сделайте что-нибудь.</p>}
            {trace.map((t, i) => (
              <div key={i} className="mb-4" data-trace={t.title}>
                <div className="mb-1 flex items-center gap-2 text-sm font-medium">{t.at} — {t.title}{t.error && <Badge variant="destructive">ошибка</Badge>}</div>
                {t.lines.length > 0 && <pre className="mb-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{t.lines.join('\n')}</pre>}
                {t.queries.length > 0 && <div className="text-xs text-muted-foreground">запросов: {t.queries.length} · {t.queries.map((q) => `${q.mode} ${q.classes || '—'} ${q.ms} мс`).join(' · ')}</div>}
                {t.error && <p className="text-xs text-destructive">{t.error}</p>}
              </div>))}
          </ScrollArea></CardContent>
        </Card>
      </div>
    </div>
  );
}
