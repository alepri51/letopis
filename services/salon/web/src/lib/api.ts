/** JSON API салона: GET без тела, POST с телом; ошибка — Error с кодом ответа. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? r.statusText), { status: r.status });
  return data as T;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
/** Время версии (at библиотеки — ISO в UTC) — местное, как в «Под капотом»; часы работы салона — в UTC (domain.mjs). */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU');

export type Me = { salon: string; name: string };
export type Staff = { id: string; name: string; specialization: string };
export type Booking = { id: string; staff: string; hour: number; customer: string; service: string };
export type Schedule = { day: string; hours: number[]; staff: Staff[]; services: { id: string; name: string }[]; bookings: Booking[]; cancelled: Booking[]; total: number };
/** Версия брони из истории: id этой брони, мастер и время — из самой версии. */
export type Version = { id: string; rev: number; op: string; staff: string; start: string; reason: string; at: string };
/** Отчёт дня: брони по мастерам (все мастера салона, у кого броней нет — 0). */
export type Report = { day: string; total: number; staff: (Staff & { count: number })[] };
/** Строка прайса: услуга и её цена в рублях (null — цены нет), rev — версия цены. */
export type PriceRow = { id: string; name: string; duration: number | null; price: number | null; rev: number | null };
/** Отчёт загрузки прайса списком (db.load). */
export type LoadReport = { rows: number; loaded: number; updated: number; skipped: number; ms: number };
