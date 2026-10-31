import { useEffect, useState } from 'react';
import { LoginScreen } from '@/pages/Login';
import { Mailbox } from '@/pages/Mailbox';
import { Desk } from '@/pages/Desk';
import { api, type Me } from '@/lib/api';

export default function App() {
  // демо-почта открывается без входа: туда приходят коды и приглашения
  return location.pathname === '/mail' ? <Mailbox /> : <Main />;
}

function Main() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { api<Me | null>('/api/me').then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return null;
  if (!me) return <LoginScreen onLogin={setMe} />;
  return <Desk me={me} onMe={setMe} />;
}
