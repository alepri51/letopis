import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Qr } from '@/components/qr';
import { api, type Me } from '@/lib/api';

/**
 * Безопасность: второй фактор TOTP (QR-код, первый верный код включает фактор; отключение — с действующим кодом) и
 * выход на всех устройствах.
 */
export function Security({ me, onMe, onChanged }: { me: Me; onMe: (me: Me | null) => void; onChanged: () => void }) {
  const [enroll, setEnroll] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [offCode, setOffCode] = useState('');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Второй фактор (TOTP) {me.totp ? <Badge>включён</Badge> : <Badge variant="outline">выключен</Badge>}</CardTitle>
          <CardDescription>
            Второй фактор — ключ TOTP этой компании: после пароля или кода из письма понадобится шестизначный код из
            приложения-аутентификатора. letopis хранит секрет в таблице <code>secret</code>, сверяет код и не даёт использовать
            один код дважды. Подключить и отключить фактор можно в первые 10 минут после входа; отключить — только с действующим
            кодом: <code>me.keys.revoke</code> отзывает ключ TOTP и гасит другие ваши сессии в компании.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!me.totp && !enroll && (
            <Button className="w-fit" onClick={async () => { setEnroll(await api('/api/security/totp/enroll', {})); onChanged(); }}>Подключить приложение-аутентификатор</Button>
          )}
          {me.totp && (
            <form className="grid content-start gap-3" onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api('/api/security/totp/disable', { code: offCode });
                // отзыв ключа TOTP гасит другие сессии жильца в компании, текущая остаётся (keys.revoke, keepCurrent)
                toast.success('Второй фактор отключён. Другие ваши сессии в компании закрыты, эта осталась');
                setOffCode(''); onMe({ ...me, totp: false }); onChanged();
              } catch (err) { toast.error((err as Error).message); onChanged(); }
            }}>
              <Label htmlFor="totp-off">Код из приложения — чтобы отключить второй фактор</Label>
              <Input id="totp-off" inputMode="numeric" autoComplete="one-time-code" value={offCode} onChange={(e) => setOffCode(e.target.value)} required className="w-40" />
              <Button type="submit" variant="outline" className="w-fit">Отключить второй фактор</Button>
            </form>
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
            «Выйти на всех устройствах» гасит все ваши сессии в этой компании (<code>me.closeAll()</code>) и временные ключи
            ИИ-агента: другие вкладки и браузеры при следующем запросе попросят войти заново. В других компаниях у вас свои
            ключи — их сессии не трогаются.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={async () => { await api('/api/security/revoke-all', {}); toast.success('Все сеансы завершены'); onMe(null); }}>Выйти на всех устройствах</Button>
        </CardContent>
      </Card>
    </div>
  );
}
