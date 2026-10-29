import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Qr } from '@/components/qr';
import { api, type Me } from '@/lib/api';

/** Безопасность: второй фактор TOTP (QR-код, первый верный код включает фактор) и выход на всех устройствах. */
export function Security({ me, onMe, onChanged }: { me: Me; onMe: (me: Me | null) => void; onChanged: () => void }) {
  const [enroll, setEnroll] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Второй фактор (TOTP) {me.totp ? <Badge>включён</Badge> : <Badge variant="outline">выключен</Badge>}</CardTitle>
          <CardDescription>
            После пароля или кода из письма сервис попросит шестизначный код из приложения-аутентификатора.
            letopis хранит секрет в таблице <code>secret</code>, сверяет код и не даёт использовать один код дважды.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!me.totp && !enroll && (
            <Button className="w-fit" onClick={async () => { setEnroll(await api('/api/security/totp/enroll', {})); onChanged(); }}>Подключить приложение-аутентификатор</Button>
          )}
          {enroll && (
            <div className="grid gap-4 md:grid-cols-[auto_1fr]">
              <Qr text={enroll.url} />
              <form className="grid content-start gap-3" onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api('/api/security/totp/verify', { code });
                  toast.success('Второй фактор включён: при следующем входе понадобится код');
                  setEnroll(null); setCode(''); onMe({ ...me, totp: true }); onChanged();
                } catch (err) { toast.error((err as Error).message); onChanged(); }
              }}>
                <p className="text-sm">Отсканируйте QR-код или введите секрет вручную:</p>
                <code className="w-fit rounded bg-muted px-2 py-1 text-sm" data-totp-secret={enroll.secret}>{enroll.secret}</code>
                <Label htmlFor="totp-code">Код из приложения</Label>
                <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required className="w-40" />
                <Button type="submit" className="w-fit">Включить</Button>
              </form>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Сеансы</CardTitle>
          <CardDescription>
            «Выйти на всех устройствах» гасит все сессии вашей учётной записи (<code>auth.revokeAll</code>): другие вкладки
            и браузеры при следующем запросе попросят войти заново.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={async () => { await api('/api/security/revoke-all', {}); toast.success('Все сеансы завершены'); onMe(null); }}>Выйти на всех устройствах</Button>
        </CardContent>
      </Card>
    </div>
  );
}
