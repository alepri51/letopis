import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

type Mail = { id: number; at: string; to: string; subject: string; text: string; link: string | null };

/**
 * Демо-почта: письма почтальона-заглушки — ссылки-приглашения и коды входа. Настоящий сервис отдал бы их почтовому
 * шлюзу или СМС.
 */
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
            Письма почтальона helpdesk: ссылки-приглашения (<code>me.invite</code>) и коды входа (<code>db.requestCode</code>).
            Токен ссылки и код выпускает и проверяет letopis, а доставляет их почтальон — функция сервиса из
            <code> connect(pass, {'{ postman }'})</code>. Здесь почтальон — заглушка, «доставка» — этот ящик. <a className="underline" href="/">Ко входу</a>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {mail.length === 0 && <p className="text-sm text-muted-foreground">Писем пока нет.</p>}
          {mail.map((m) => (
            <div key={m.id} className="rounded-md border p-3" data-mail-to={m.to}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">{new Date(m.at).toLocaleTimeString('ru-RU')}</Badge><b>{m.to}</b> — {m.subject}</div>
              <pre className="whitespace-pre-wrap text-sm">{m.text}</pre>
              {m.link && <a className="text-sm font-medium text-primary underline" href={m.link}>Открыть приглашение</a>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
