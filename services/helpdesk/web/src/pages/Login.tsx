import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
// блоки shadcnblocks: вход и регистрация
import { Login1, LOGO } from '@/components/login1';
import { Signup1 } from '@/components/signup1';
import { api, type Me } from '@/lib/api';

type Mode = 'password' | 'otp' | 'otp-code' | 'totp' | 'register';
type LoginReply = Me | { needTotp: true; pending?: string };

/**
 * Вход в helpdesk: пароль или одноразовый код из письма; если у пользователя включён TOTP — второй шаг с кодом
 * из приложения-аутентификатора. Регистрация компании заводит нового арендатора (createTenant).
 */
export function LoginScreen({ onLogin }: { onLogin: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [error, setError] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState('');
  const go = (m: Mode) => { setError(''); setMode(m); };
  const done = (r: LoginReply) => {
    // после пароля сервер просит код TOTP: пароль и код уйдут вместе; после кода из письма — по номеру входа
    if ('needTotp' in r) { setPending(r.pending ?? ''); go('totp'); } else onLogin(r);
  };
  const attempt = async (fn: () => Promise<void>) => { try { setError(''); await fn(); } catch (e) { setError((e as Error).message); } };

  if (mode === 'register') {
    return <Signup1 logo={{ src: LOGO, alt: 'letopis' }} error={error} onLogin={() => go('password')}
      onSubmit={(v) => attempt(async () => onLogin(await api<Me>('/api/register', v)))} />;
  }
  const tabs = (mode === 'password' || mode === 'otp') && (
    <Tabs value={mode} onValueChange={(v) => go(v as Mode)} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="password">Пароль</TabsTrigger>
        <TabsTrigger value="otp">Код на почту</TabsTrigger>
      </TabsList>
    </Tabs>
  );
  const below = (
    <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
      {mode === 'totp' || mode === 'otp-code'
        ? <button type="button" className="hover:underline" onClick={() => go('password')}>Другой способ входа</button>
        : <p>Нет компании? <button type="button" className="font-medium text-primary hover:underline" onClick={() => go('register')}>Зарегистрировать</button></p>}
      <a className="hover:underline" href="/mail" target="_blank" rel="noreferrer">Демо-почта (коды и приглашения)</a>
    </div>
  );
  const hint = (
    <>Демо: руководитель <b>boss@sever.ru</b> / Sever-2026!, агент <b>agent@sever.ru</b> / Agent-2026!,
      клиент <b>client@sever.ru</b> — вход по коду на почту.</>
  );
  if (mode === 'password') {
    return <Login1 key="password" heading="Helpdesk" hint={hint} error={error} above={tabs} below={below}
      fields={[
        { name: 'login', type: 'email', placeholder: 'Логин (email)', autoComplete: 'username' },
        { name: 'password', type: 'password', placeholder: 'Пароль', autoComplete: 'current-password' },
      ]}
      onSubmit={(v) => attempt(async () => { setLogin(v.login); setPassword(v.password); done(await api<LoginReply>('/api/login', v)); })} />;
  }
  if (mode === 'otp') {
    return <Login1 key="otp" heading="Helpdesk" hint={hint} error={error} above={tabs} below={below} buttonText="Прислать код"
      fields={[{ name: 'login', type: 'email', placeholder: 'Email', autoComplete: 'username' }]}
      onSubmit={(v) => attempt(async () => { await api('/api/otp/send', v); setLogin(v.login); go('otp-code'); })} />;
  }
  if (mode === 'otp-code') {
    return <Login1 key="otp-code" heading="Код из письма" hint={<>Код отправлен на <b>{login}</b> — откройте демо-почту.</>} error={error}
      below={below} fields={[{ name: 'code', placeholder: 'Код из письма', inputMode: 'numeric', autoComplete: 'one-time-code' }]}
      onSubmit={(v) => attempt(async () => done(await api<LoginReply>('/api/otp/verify', { login, code: v.code })))} />;
  }
  return <Login1 key="totp" heading="Второй фактор" hint="Введите шестизначный код из приложения-аутентификатора." error={error}
    below={below} buttonText="Подтвердить" fields={[{ name: 'code', placeholder: 'Код TOTP', inputMode: 'numeric', autoComplete: 'one-time-code' }]}
    onSubmit={(v) => attempt(async () => done(pending
      ? await api<LoginReply>('/api/login/totp', { pending, code: v.code })
      : await api<LoginReply>('/api/login', { login, password, code: v.code })))} />;
}
