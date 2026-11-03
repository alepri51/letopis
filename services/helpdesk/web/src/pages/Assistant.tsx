import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';

/**
 * Помощник — детерминированный ИИ-агент без языковой модели: команду разбирает по образцам и выполняет через MCP.
 * Клиент MCP — прямо в браузере: JSON-RPC по HTTP на адрес /mcp сервиса (тот же адрес подходит настоящему агенту).
 * Чтение выполняется сразу, запись — только после подтверждения человеком. Настоящему агенту — ключ API или короткая
 * сессия (auth.sessionFor): сессия истекает сама, «Погасить» гасит её сразу.
 */
type Call = { id: number; method: string; params: unknown; result?: unknown; error?: string };
type Line = { who: 'вы' | 'помощник'; text: string };
type Pending = { title: string; args: Record<string, unknown>; resolve: (ok: boolean) => void };
type Row = { id: string; rev: number; owner: string; data: Record<string, unknown> };
type AgentSession = { id: string; company: string; until: string; methods: string[] };

const EXAMPLES = ['открытые заявки', 'срочные заявки', 'заявка HD-1', 'история HD-1', 'ответь на HD-1: Проверили и исправили — проверьте, пожалуйста', 'реши HD-1'];
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU');

/** Ответ JSON-RPC: сервер отвечает JSON или потоком SSE (text/event-stream) — тогда ответ в строке data: с тем же id. */
function answerOf(r: Response, text: string, id: number) {
  return (r.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === id) ?? { error: { message: 'нет ответа' } }
    : (() => { try { return JSON.parse(text); } catch { return { error: { message: `HTTP ${r.status}` } }; } })();
}

export function Assistant({ onChanged }: { onChanged: () => void }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [chat, setChat] = useState<Line[]>([{ who: 'помощник', text: 'Я читаю и правлю заявки с вашими правами через MCP. Попробуйте команду ниже.' }]);
  const [cmd, setCmd] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [agentKey, setAgentKey] = useState<{ key: string; url: string } | null>(null);
  const [issued, setIssued] = useState<(AgentSession & { token: string; url: string }) | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [probe, setProbe] = useState('');
  const seq = useRef(1);
  const ready = useRef<Promise<unknown> | null>(null);

  /** Один вызов JSON-RPC 2.0 на /mcp (Streamable HTTP, ответ — JSON). Каждый вызов виден в журнале справа. */
  const rpc = async (method: string, params: unknown = {}) => {
    const id = seq.current++;
    setCalls((c) => [{ id, method, params }, ...c].slice(0, 30));
    const r = await fetch('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const msg = answerOf(r, await r.text(), id);
    const error = msg.error?.message ?? (msg.result?.isError ? msg.result.content?.[0]?.text : undefined);
    setCalls((c) => c.map((x) => (x.id === id ? { ...x, result: msg.result, error } : x)));
    if (error) throw new Error(error);
    return msg.result;
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = (await rpc('tools/call', { name, arguments: args })) as { structuredContent?: { data?: unknown } };
    return res.structuredContent?.data as Record<string, unknown>;
  };
  const loadSessions = () => api<AgentSession[]>('/api/assistant/sessions').then(setSessions, (e) => toast.error(e.message));
  useEffect(() => {
    ready.current = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'helpdesk-помощник', version: '1.0.0' } })
      .then(() => rpc('tools/list'));
    loadSessions();
  }, []);

  const issueSession = async () => {
    try { setIssued(await api('/api/assistant/session', {})); setProbe(''); loadSessions(); onChanged(); } catch (e) { toast.error((e as Error).message); }
  };
  const dropSession = async (id: string) => {
    try { await api(`/api/assistant/sessions/${id}/revoke`, {}); toast.success('Сессия агента погашена'); } catch (e) { toast.error((e as Error).message); }
    loadSessions(); onChanged();
  };
  /** Вызов /mcp так, как его сделает агент: только токен сессии в заголовке, без cookie вкладки (credentials: 'omit'). */
  const probeAgent = async (token: string) => {
    const r = await fetch('/mcp', {
      method: 'POST', credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'letopis_query', arguments: { class: 'Ticket', filter: { status: { $in: ['new', 'open', 'pending'] } }, terminal: 'count' } } }),
    });
    if (r.status === 401) setProbe('401: сессия погашена или истекла — агент больше ничего не может');
    else {
      const msg = answerOf(r, await r.text(), 1);
      const count = msg.result?.structuredContent?.data?.count;
      setProbe(count === undefined ? `не вышло: ${msg.error?.message ?? msg.result?.content?.[0]?.text ?? `HTTP ${r.status}`}` : `агент видит открытых заявок: ${count}`);
    }
    onChanged();
  };

  const confirmWrite = (title: string, args: Record<string, unknown>) => new Promise<boolean>((resolve) => setPending({ title, args, resolve }));
  const say = (text: string) => setChat((c) => [...c, { who: 'помощник', text }]);
  const ticketBy = async (number: string) => {
    const data = await tool('letopis_query', { class: 'Ticket', filter: { number } });
    const row = (data?.rows as Row[] | undefined)?.[0];
    if (!row) throw new Error(`заявки ${number} не вижу — её нет или она вам недоступна`);
    return row;
  };
  const when = (iso: unknown) => new Date(String(iso)).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const list = (rows: Row[]) => rows.map((r) => `${r.data.number} · ${r.data.subject} · ${r.data.status} · срок ${when(r.data.due)}`).join('\n') || 'ничего не нашлось';

  async function handle(text: string) {
    setChat((c) => [...c, { who: 'вы', text }]);
    await ready.current;
    let m: RegExpExecArray | null;
    try {
      if (/открыт|очеред/i.test(text)) {
        // открытые — как у счётчика и очереди: новая, в работе, ждёт клиента
        const data = await tool('letopis_query', { class: 'Ticket', filter: { status: { $in: ['new', 'open', 'pending'] } }, sort: { field: 'data.due' } });
        say(list(data.rows as Row[]));
      } else if (/срочн/i.test(text)) {
        const data = await tool('letopis_query', { class: 'Ticket', filter: { priority: 'urgent', status: { $ne: 'solved' } } });
        say(list(data.rows as Row[]));
      } else if ((m = /истори\S*\s+(HD-\d+)/i.exec(text))) {
        const t = await ticketBy(m[1].toUpperCase());
        const data = await tool('letopis_history', { class: 'Ticket', id: t.id, kind: 'versions' });
        say((data.versions as { rev: number; op: string; reason?: string }[]).map((v) => `rev ${v.rev}: ${v.op}${v.reason ? ` — ${v.reason}` : ''}`).join('\n'));
      } else if ((m = /ответь\s+на\s+(HD-\d+)\s*:\s*(.+)/i.exec(text))) {
        const t = await ticketBy(m[1].toUpperCase());
        // client — владелец заявки: по этому полю правило покажет ответ клиенту
        const args = { op: 'create', class: 'Reply', data: { text: m[2], authorName: 'ИИ-помощник', client: t.owner }, links: { Ticket: t.id } };
        if (!(await confirmWrite(`Ответить клиенту в заявке ${t.data.number}`, args))) return say('Хорошо, не отправляю.');
        await tool('letopis_write', args);
        say(`Ответ в ${t.data.number} отправлен.`); onChanged();
      } else if ((m = /(реши|закрой)\s+(HD-\d+)/i.exec(text))) {
        const t = await ticketBy(m[2].toUpperCase());
        const args = { op: 'update', class: 'Ticket', id: t.id, data: { status: 'solved' }, rev: t.rev };
        if (!(await confirmWrite(`Отметить ${t.data.number} решённой`, args))) return say('Хорошо, оставляю как есть.');
        await tool('letopis_write', args);
        say(`${t.data.number} — решена.`); onChanged();
      } else if ((m = /заявк\S*\s+(HD-\d+)/i.exec(text))) {
        const t = await ticketBy(m[1].toUpperCase());
        say(`${t.data.number} · ${t.data.subject}\nстатус ${t.data.status}, приоритет ${t.data.priority}, версия ${t.rev}\n${t.data.body}`);
      } else say('Не понял команду. Примеры — под полем ввода.');
    } catch (e) { say(`Не вышло: ${(e as Error).message}`); }
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Помощник (MCP)</CardTitle>
          <CardDescription>
            Инструменты <code>letopis_query</code>, <code>letopis_history</code>, <code>letopis_write</code> отдаёт сервер MCP letopis
            (<code>createMcpServer</code>) от вашего имени: помощник видит и меняет ровно то, что разрешено вам. Правку он
            предлагает с версией <code>rev</code> и выполняет только после вашего подтверждения.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid max-h-[360px] gap-2 overflow-y-auto rounded-md border p-3" data-chat>
            {chat.map((l, i) => (
              <div key={i} className={`whitespace-pre-wrap text-sm ${l.who === 'вы' ? 'text-right' : ''}`}>
                <span className={`inline-block rounded-lg px-3 py-2 ${l.who === 'вы' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{l.text}</span>
              </div>))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = cmd.trim(); if (t) { setCmd(''); handle(t); } }}>
            <Input placeholder="Команда помощнику" aria-label="Команда помощнику" value={cmd} onChange={(e) => setCmd(e.target.value)} />
            <Button type="submit">Выполнить</Button>
          </form>
          <div className="flex flex-wrap gap-1">{EXAMPLES.map((x) => <Button key={x} size="sm" variant="outline" onClick={() => handle(x)}>{x}</Button>)}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Настоящий ИИ-агент</CardTitle>
          <CardDescription>Тот же адрес <code>/mcp</code> принимает ключ API или короткую сессию: агент работает с вашими правами.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            {!agentKey && <Button variant="outline" onClick={async () => setAgentKey(await api('/api/assistant/key', {}))}>Выдать ключ для агента</Button>}
            <Button variant="outline" onClick={issueSession}>Сессия агента на 15 минут</Button>
          </div>
          {agentKey && <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs" data-agent-key={agentKey.key}>{`claude mcp add --transport http helpdesk "${location.origin}${agentKey.url}" \\\n  --header "Authorization: Bearer ${agentKey.key}"`}</pre>}
          {issued && (
            <div className="grid gap-2 rounded-md border p-3" data-agent-session={issued.id}>
              <p className="text-sm">Сессия до {clock(issued.until)} · вход {issued.methods.join(', ')} · «{issued.company}». Токен показан один раз:</p>
              <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs" data-agent-token={issued.token}>{`claude mcp add --transport http helpdesk "${location.origin}${issued.url}" \\\n  --header "Authorization: Bearer ${issued.token}"`}</pre>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => probeAgent(issued.token)}>Проверить доступ агента</Button>
                {probe && <span className="text-sm" data-agent-probe>{probe}</span>}
              </div>
            </div>
          )}
          {sessions.length > 0 && (
            <Table>
              <TableHeader><TableRow><TableHead>сессия агента</TableHead><TableHead>истекает</TableHead><TableHead>вход</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{sessions.map((x) => (
                <TableRow key={x.id} data-agent-row={x.id}>
                  <TableCell>«{x.company}»</TableCell><TableCell>{clock(x.until)}</TableCell><TableCell>{x.methods.join(', ')}</TableCell>
                  <TableCell><Button size="sm" variant="outline" onClick={() => dropSession(x.id)}>Погасить</Button></TableCell>
                </TableRow>))}</TableBody>
            </Table>
          )}
          <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
            <li>Ключ (<code>auth.issueApiKey</code>) — кред: он есть в <code>auth.credentials()</code> и действует, пока его не отзовут.</li>
            <li>
              Сессия (<code>{'auth.sessionFor(вы, { ttl: 900 })'}</code>, затем <code>{'connect({ token })'}</code> и <code>auth.switch</code>) — не
              кред: в <code>credentials()</code> её нет, список ведёт сервис. Истекает сама через 15 минут — работа агента срок не
              продлевает; «Погасить» (<code>auth.revoke()</code>), выход и «Выйти на всех устройствах» гасят её сразу.
              Компанию сессия помнит сама, поэтому адрес — без <code>?tenant</code>.
            </li>
            <li>
              В журнале правки агента по сессии — ваши: автор вы, исполнителя (<code>agent</code>) нет. «Работать от имени»
              (<code>svc.as</code>) пишет иначе: автор — тот, от чьего имени, исполнитель — сервис.
            </li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Вызовы MCP</CardTitle><CardDescription>JSON-RPC между помощником и сервером: метод, аргументы, ответ.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {calls.map((c) => (
            <details key={c.id} className="rounded-md border p-2 text-xs" data-call={c.method}>
              <summary className="cursor-pointer">
                <b>{c.method}</b>{c.method === 'tools/call' && ` · ${(c.params as { name: string }).name}`}{' '}
                {c.error ? <Badge variant="destructive">ошибка</Badge> : c.result === undefined ? <Badge variant="outline">ждём</Badge> : <Badge variant="outline">ок</Badge>}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(c.params, null, 1)}</pre>
              {c.error && <p className="text-destructive">{c.error}</p>}
              {c.result !== undefined && <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{JSON.stringify(c.result, null, 1).slice(0, 2000)}</pre>}
            </details>))}
        </CardContent>
      </Card>
      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && pending) { pending.resolve(false); setPending(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Помощник просит разрешения</DialogTitle>
            <DialogDescription>{pending?.title}. Вызов инструмента <code>letopis_write</code>:</DialogDescription></DialogHeader>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{JSON.stringify(pending?.args, null, 1)}</pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => { pending?.resolve(false); setPending(null); }}>Отклонить</Button>
            <Button onClick={() => { pending?.resolve(true); setPending(null); toast.success('Разрешено'); }}>Разрешить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
