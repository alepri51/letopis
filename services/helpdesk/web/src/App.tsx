import { useEffect, useState } from 'react';
import { LoginScreen } from '@/pages/Login';
import { Mailbox } from '@/pages/Mailbox';
import { InvitePage } from '@/pages/Invite';
import { Desk } from '@/pages/Desk';
import { api, type Me } from '@/lib/api';

export default function App() {
  // демо-почта и страница приглашения открываются без входа: в почту приходят письма почтальона, ссылка из письма
  // ведёт на /invite/<токен>
  const invite = /^\/invite\/([0-9a-f]+)$/.exec(location.pathname)?.[1];
  if (invite) return <InvitePage token={invite} />;
  return location.pathname === '/mail' ? <Mailbox /> : <Main />;
}

function Main() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api<Me | null>('/api/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return null;
  if (!me) return <LoginScreen onLogin={setMe} />;
  return <Desk me={me} onMe={setMe} />;
}
