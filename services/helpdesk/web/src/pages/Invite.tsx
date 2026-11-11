import { useEffect, useState } from 'react';
import { Login1 } from '@/components/login1';
import { api, type Me } from '@/lib/api';

type Invitation = {
  company: string; role: string; from: string | null; to: string; until: string;
  status: 'active' | 'expired' | 'revoked' | 'used'; hasAccount: boolean;
};

const STATUS: Record<Invitation['status'], string> = {
  active: 'действует', expired: 'истекло', revoked: 'отменено или заменено новым', used: 'уже принято',
};

/**
 * Страница приглашения — сюда ведёт ссылка из письма (/invite/<токен>). Сначала сервис показывает приглашение, ничего не
 * меняя (db.invitation): компания, роль, кто зовёт, срок. «Принять» — db.accept(токен, { name, password? }): новый
 * аккаунт или прежний (тот же email), пароль по желанию — без него вход кодом из письма.
 */
export function InvitePage({ token }: { token: string }) {
  const [inv, setInv] = useState<Invitation | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => { api<Invitation>(`/api/invitation/${token}`).then(setInv, (e) => { setInv(null); setError((e as Error).message); }); }, [token]);
  if (inv === undefined) return null;
  const home = <a className="text-sm text-muted-foreground hover:underline" href="/">Ко входу</a>;
  if (!inv || inv.status !== 'active') {
    return <Login1 heading="Приглашение" error={error || `Приглашение ${inv ? STATUS[inv.status] : 'не найдено'} — попросите новое`}
      fields={[]} buttonText="Ко входу" below={home} onSubmit={() => { location.href = '/'; }} />;
  }
  return <Login1 heading={`Приглашение в «${inv.company}»`} error={error} buttonText="Принять и войти" below={home}
    hint={<>{inv.from ?? 'Helpdesk'} зовёт вас в компанию «{inv.company}» — роль: <b>{inv.role}</b>. Приглашение для {inv.to},
      действует до {new Date(inv.until).toLocaleString('ru-RU')}. {inv.hasAccount
        ? 'У этого email уже есть аккаунт: входить заранее не нужно — пароль для этой компании свой (можно не задавать).'
        : 'Пароль можно не задавать — тогда входите кодом из письма.'}</>}
    initial={{ name: '' }}
    fields={[
      { name: 'name', placeholder: 'Ваше имя', autoComplete: 'name' },
      { name: 'password', type: 'password', placeholder: 'Пароль (необязательно, от 8 знаков)', autoComplete: 'new-password', optional: true },
    ]}
    onSubmit={async (v) => {
      try {
        setError('');
        await api<Me>('/api/accept', { token, name: v.name, password: v.password || undefined });
        location.href = '/';
      } catch (e) { setError((e as Error).message); }
    }} />;
}
