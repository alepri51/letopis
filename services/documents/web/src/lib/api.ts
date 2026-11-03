/** JSON API сервиса: GET без тела, POST с телом; ошибка — Error с кодом ответа и кодом letopis. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') location.reload();
  if (!r.ok) throw Object.assign(new Error(data?.error ?? r.statusText), { status: r.status, code: data?.code as string | undefined });
  return data as T;
}

export const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

export type Me = { name: string; role: string; firm: string };
export type Party = { id: string; name: string; passport: string; phone: string };
export type Doc = {
  id: string; class: 'Draft' | 'Contract'; number: string; title: string; amount: number; body: string;
  status: string; signedBy: string; party: string; partyName: string; rev: number; at: string; archived: boolean;
};
export type Version = { id: string; rev: number; op: string; class: string; at: string; who: string; reason: string; agent: string; data: Record<string, unknown> };
