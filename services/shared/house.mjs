/**
 * Дом сервисов-примеров: пропуск, квартиры и засев демо-жильцов.
 *
 * - Сервис знает только пропуск консьержа — LETOPIS_PASS: в одной строке дом и ключ консьержа. connect(pass,
 *   { postman }) даёт консьержа (House): он открывает дверь жильцам (open, resume, accept), заводит квартиры и работает
 *   в них (in, as); письма со ссылками и кодами отдаёт почтальону (services/shared/postman.mjs — заглушка).
 * - Пропуск печатает подготовка дома — src/setup.mjs сервиса: setup() мастер-ключом (ADMIN_DSN — строка подключения
 *   администратора PostgreSQL). Это шаг инициализации: run-local.sh и compose делают его до запуска сервиса, а сам
 *   сервис мастер-ключа не знает.
 * - Жилец появляется только по приглашению: консьерж или жилец с правом выдать роль зовёт (me.invite), почтальон
 *   доставляет ссылку, человек открывает её и принимает приглашение (house.accept). Демо-жильцов с известными
 *   паролями один раз засевает подготовка дома (seedResident, когда квартира только что заведена) — это засев
 *   демо-данных, а не регистрация: при старте сервис никого не зовёт, жильцы входят своими ключами.
 *
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/*.mjs — '../../shared/house.mjs'), пакеты
 * (letopis, postgres) сюда приходят аргументами.
 */
import { writeFileSync } from 'node:fs';

/** Мастер-ключ подготовки дома: ADMIN_DSN, по умолчанию — администратор базы стенда services/compose.yaml. */
export const adminDsn = () => process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis';

/** Пропуск из окружения (LETOPIS_PASS); нет — понятный отказ: как его получить. */
export function passFromEnv(service) {
  const pass = process.env.LETOPIS_PASS?.trim();
  if (pass) return pass;
  throw new Error(`${service}: нет пропуска — задайте LETOPIS_PASS. Пропуск печатает подготовка дома мастер-ключом:\n`
    + `  ADMIN_DSN=postgres://… node src/setup.mjs     (или run-local.sh — он делает этот шаг сам)`);
}

/**
 * Строка подключения роли консьержа из пропуска — без параметров letopis (дом и ключ). Нужна только слушателю канала
 * «под капотом» (services/shared/trace.mjs): LISTEN и метка-отсечка. Строк таблиц эта роль без сессии не видит — RLS.
 */
export function passDsn(pass) {
  const u = new URL(pass);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('letopis_')) u.searchParams.delete(k);
  return u.toString();
}

/** Квартира по имени: createTenant; повтор — отказ exists, квартира уже есть. true — заведена сейчас. */
export async function ensureTenant(house, name) {
  try {
    await house.createTenant(name);
    return true;
  } catch (e) {
    if (e?.code !== 'exists') throw e;
    return false;
  }
}

/**
 * Засев демо-жильца — только для src/setup.mjs, один раз, когда квартира только что заведена. Консьерж в квартире
 * зовёт человека с ролями (me.invite), ссылка приходит почтальону-заглушке box, и подготовка тут же принимает её за
 * демо-жильца (house.accept): так в демо появляется человек с известным паролем. Без password жилец входит кодом из
 * письма. В настоящем сервисе ссылку открывает сам человек. Ответ — id аккаунта.
 */
export async function seedResident(house, box, tenant, { email, password, name, roles }) {
  const me = await box.inviteAndAccept(house, await house.in(tenant), { email }, roles, { ...(password ? { password } : {}), name });
  const account = me.account;
  await me.close();
  return account;
}

/** Пропуск после подготовки: в файл (шаг инициализации compose) или строкой LETOPIS_PASS=… в stdout. */
export function printPass(pass, file) {
  if (file) writeFileSync(file, `${pass}\n`, { mode: 0o600 });
  else console.log(`LETOPIS_PASS=${pass}`);
}

/** Модуль запущен как программа (node src/…), а не импортирован сценарием. */
export const isMain = (url) => url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`;
