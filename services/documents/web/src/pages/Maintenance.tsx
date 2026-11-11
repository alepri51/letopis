import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type Me } from '@/lib/api';

type Archive = { loaded: number; versions: number; since: string; till: string; agent: string } | null;

/**
 * Архив и обслуживание. Архив старых договоров залит при подготовке дома — первой заливкой с историей мастер-ключом
 * (letopis load --initial --with-history). Загрузка и обслуживание (maintain) — инструменты мастер-ключа: страница
 * показывает команды, у сервиса с пропуском их нет.
 */
export function Maintenance(_: { me: Me; onChanged: () => void }) {
  const [archive, setArchive] = useState<Archive>(null);
  const [house, setHouse] = useState('documents');
  useEffect(() => { api<{ archive: Archive; house: string }>('/api/admin/info').then((r) => { setArchive(r.archive); setHouse(r.house); }, () => {}); }, []);
  const date = (s: string) => new Date(s.replace(' ', 'T').replace(/\+00$/, 'Z')).toLocaleDateString('ru-RU');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Архив</CardTitle>
          <CardDescription>
            Старые договоры попали в дом при его подготовке — первой заливкой мастер-ключом
            (<code>letopis load --initial --with-history</code>): в пустую квартиру, одной транзакцией, с историей — у каждого
            договора четыре версии из прежней системы со своими датами. Исполнитель версий в журнале — «перенос архива».
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {archive
            ? <p className="text-sm" data-archive>Залито объектов: {archive.loaded}, версий: {archive.versions}, даты версий — с {date(archive.since)} по {date(archive.till)} (исполнитель «{archive.agent}»).</p>
            : <p className="text-sm text-muted-foreground">Архива в квартире нет.</p>}
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{`npx letopis load архив.ndjson --dsn "$ADMIN_DSN" --schema ${house} --tenant "Право и Дело" \\\n  --initial --with-history --agent "перенос архива"`}</pre>
          <p className="text-xs text-muted-foreground">Демо с нуля — подготовка дома заново: <code>FRESH=1 node src/setup.mjs</code> (мастер-ключом), затем перезапуск сервиса с новым пропуском.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Обслуживание — мастер-ключом</CardTitle>
          <CardDescription>
            Сервис знает только пропуск консьержа: обслуживать дом и загружать данные списком ему нечем. Это делает тот, у кого
            мастер-ключ — строка подключения администратора PostgreSQL.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p><code>maintain</code> удаляет истёкшие сессии, коды, приглашения и строки-замки удалённых классов. Журнал он не трогает: история хранится целиком.</p>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-maintain>{`npx letopis maintain --dsn "$ADMIN_DSN" --schema ${house}`}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
