import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
// блоки shadcnblocks: вход и регистрация
import { Login1, LOGO } from '@/components/login1';
import { Signup1 } from '@/components/signup1';
import { api, type Me } from '@/lib/api';

type Mode = 'password' | 'otp' | 'otp-code' | 'otp-tenant' | 'totp' | 'register' | 'sent';
type Company = { id: string; name: string };
type LoginReply = Me | { needTotp: true; pending?: string } | { chooseTenant: true; tenants: Company[] };

/**
 * Вход в helpdesk: пароль или одноразовый код из письма (db.requestCode — код выпускает библиотека, письмо доставляет
 * почтальон сервиса). Код доказывает email: компаний несколько — после кода их список (db.tenantsOf), вход — в
 * выбранную. Если включён второй фактор, сервис отвечает needTotp (letopis: api.totp_required) — второй шаг с кодом из
 * приложения-аутентификатора. Попасть в компанию можно только по приглашению: ссылка из письма ведёт на страницу
 * приглашения (/invite/<токен>). Регистрация компании — тоже приглашение: компанию заводит сервис, ссылка приходит на
 * почту.
 */
export function LoginScreen({ onLogin }: { onLogin: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>('password');
  const [error, setError] = useState('');
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState('');
  const [code, setCode] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const go = (m: Mode) => { setError(''); setMode(m); };
  const done = (r: LoginReply) => {
    // ключ верен, нужен код из приложения: после пароля — пароль и код уйдут вместе, после кода из письма — по номеру входа
    if ('needTotp' in r) { setPending(r.pending ?? ''); go('totp'); } else if ('chooseTenant' in r) { setCompanies(r.tenants); go('otp-tenant'); } else onLogin(r);
  };
  const attempt = async (fn: () => Promise<void>) => { try { setError(''); await fn(); } catch (e) { setError((e as Error).message); } };

  if (mode === 'register') {
    return <Signup1 logo={{ src: LOGO, alt: 'letopis' }} error={error} onLogin={() => go('password')}
      onSubmit={(v) => attempt(async () => { await api('/api/register', v); setLogin(v.login); setName(v.name); go('sent'); })} />;
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
      {mode === 'totp' || mode === 'otp-code' || mode === 'otp-tenant' || mode === 'sent'
        ? <button type="button" className="hover:underline" onClick={() => go('password')}>Ко входу</button>
        : <>
          <p>Приглашение приходит письмом — откройте ссылку из него.</p>
          <p>Нет компании? <button type="button" className="font-medium text-primary hover:underline" onClick={() => go('register')}>Зарегистрировать</button></p>
        </>}
      <a className="hover:underline" href="/mail" target="_blank" rel="noreferrer">Демо-почта (письма почтальона-заглушки)</a>
    </div>
  );
  const hint = (
    <>Демо: руководитель <b>boss@sever.ru</b> / Sever-2026!, агент <b>agent@sever.ru</b> / Agent-2026! (в «Байкале» —
      Agent-Baikal-2026!), клиент <b>client@sever.ru</b> — вход по коду на почту.</>
  );
  if (mode === 'password') {
    return <Login1 key="password" heading="Helpdesk" hint={hint} error={error} above={tabs} below={below}
      fields={[
        { name: 'login', type: 'email', placeholder: 'Email', autoComplete: 'username' },
        { name: 'password', type: 'password', placeholder: 'Пароль', autoComplete: 'current-password' },
      ]}
      onSubmit={(v) => attempt(async () => { setLogin(v.login); setPassword(v.password); setPending(''); done(await api<LoginReply>('/api/login', v)); })} />;
  }
  if (mode === 'otp') {
    return <Login1 key="otp" heading="Helpdesk" hint={hint} error={error} above={tabs} below={below} buttonText="Прислать код"
      fields={[{ name: 'login', type: 'email', placeholder: 'Email', autoComplete: 'username' }]}
      onSubmit={(v) => attempt(async () => { await api('/api/otp/send', v); setLogin(v.login); go('otp-code'); })} />;
  }
  if (mode === 'otp-code') {
    return <Login1 key="otp-code" heading="Код из письма" hint={<>Код отправлен на <b>{login}</b> — откройте демо-почту. Код один для всех ваших компаний: если их несколько, выберете после кода.</>}
      error={error} below={below} fields={[{ name: 'code', placeholder: 'Код из письма', inputMode: 'numeric', autoComplete: 'one-time-code' }]}
      onSubmit={(v) => attempt(async () => { setCode(v.code); done(await api<LoginReply>('/api/otp/verify', { login, code: v.code })); })} />;
  }
  if (mode === 'otp-tenant') {
    return <Login1 key="otp-tenant" heading="Выберите компанию" error={error} below={below} buttonText="Войти"
      hint={<>Код подошёл. У <b>{login}</b> несколько компаний — выберите ту, в которую войти.</>}
      initial={{ company: companies[0]?.id ?? '' }}
      fields={[{ name: 'company', placeholder: 'Компания', options: companies.map((c) => ({ value: c.id, label: c.name })) }]}
      onSubmit={(v) => attempt(async () => {
        const t = companies.find((c) => c.id === v.company);
        if (!t) throw new Error('Такой компании нет в списке');
        done(await api<LoginReply>('/api/otp/verify', { login, code, tenant: t.id }));
      })} />;
  }
  if (mode === 'sent') {
    return <Login1 key="sent" heading="Проверьте почту" error={error} below={below} buttonText="Открыть демо-почту" fields={[]}
      hint={<>{name}, компания заведена. Письмо со ссылкой-приглашением ушло на <b>{login}</b>: откройте ссылку, задайте пароль — и вы руководитель.</>}
      onSubmit={() => { window.open('/mail', '_blank'); }} />;
  }
  return <Login1 key="totp" heading="Второй фактор" hint="Введите шестизначный код из приложения-аутентификатора." error={error}
    below={below} buttonText="Подтвердить" fields={[{ name: 'code', placeholder: 'Код TOTP', inputMode: 'numeric', autoComplete: 'one-time-code' }]}
    onSubmit={(v) => attempt(async () => done(pending
      ? await api<LoginReply>('/api/login/totp', { pending, code: v.code })
      : await api<LoginReply>('/api/login', { login, password, code: v.code })))} />;
}
