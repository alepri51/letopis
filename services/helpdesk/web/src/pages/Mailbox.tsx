import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

type Mail = { id: number; at: string; to: string; subject: string; text: string };

/** Демо-почта: письма, которые сервис «отправил» (коды входа, приглашения). Настоящий сервис отдал бы их почтовому шлюзу. */
export function Mailbox() {
  const [mail, setMail] = useState<Mail[]>([]);
  useEffect(() => {
    const load = () => api<Mail[]>('/api/mailbox').then(setMail, () => {});
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>Демо-почта</CardTitle>
          <CardDescription>
            Письма, которые отправил helpdesk: коды входа и приглашения. letopis только выдаёт код (<code>auth.issueOtp</code>) —
            доставить его письмом или СМС должен сам сервис. Здесь «доставка» — этот ящик. <a className="underline" href="/">Ко входу</a>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {mail.length === 0 && <p className="text-sm text-muted-foreground">Писем пока нет.</p>}
          {mail.map((m) => (
            <div key={m.id} className="rounded-md border p-3" data-mail-to={m.to}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">{new Date(m.at).toLocaleTimeString('ru-RU')}</Badge><b>{m.to}</b> — {m.subject}</div>
              <pre className="whitespace-pre-wrap text-sm">{m.text}</pre>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
