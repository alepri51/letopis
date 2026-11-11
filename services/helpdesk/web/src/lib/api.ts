/** JSON API сервиса: GET без тела, POST с телом; ошибка — Error с кодом ответа, кодом letopis и телом ответа (data). */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  // сеанс погашен (выход везде, выписка из компании) — на экран входа
  if (r.status === 401 && data.code === 'session_ended' && path !== '/api/me') location.reload();
  if (!r.ok) throw Object.assign(new Error(data.error ?? r.statusText), { status: r.status, code: data.code as string | undefined, data });
  return data as T;
}

export type Role = 'manager' | 'agent' | 'client';
export const ROLE: Record<Role, string> = { manager: 'руководитель', agent: 'агент', client: 'клиент' };
export const STATUS: Record<string, string> = { new: 'новая', open: 'в работе', pending: 'ждёт клиента', solved: 'решена' };
export const PRIORITY: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };

export type Me = {
  name: string; login: string; role: Role; company: string; tenant: string;
  companies: { tenant: string; name: string }[]; totp: boolean; actingAs?: string;
};
