/**
 * Подготовка дома helpdesk — мастер-ключом, один раз; повтор безопасен и отдаёт тот же пропуск:
 *
 *   ADMIN_DSN=postgres://… node src/setup.mjs [файл]
 *
 * - setup() строит дом (схема v2.helpdesk) с режимом сигналов tenant — подписчики и кэш одной компании не просыпаются от
 *   правок другой, — заводит консьержа и пишет модель (src/models.mjs) в общие классы дома: их пишет консьерж, при
 *   повторе — только то, что изменилось.
 * - Засев демо: консьерж заводит две компании (createTenant). Компания заведена сейчас — он зовёт её людей с ролями
 *   (руководитель — owner, агент, клиенты), ссылки приходят почтальону-заглушке, и подготовка принимает их за
 *   демо-людей (seedResident): руководителю и агенту — с известными паролями, клиенты — без пароля, они входят кодом
 *   из письма. Профиль каждого — в справочнике компании (Profile). Компания уже была — её людей подготовка не трогает.
 *   Матрицу, счётчик и демо-заявки пишет сам сервис при запуске.
 *
 * FRESH=1 — демо с нуля: дом сносится (demolish) и строится заново, данные и прежний пропуск пропадают. Пропуск
 * печатается строкой LETOPIS_PASS=… или пишется в файл (шаг инициализации compose). HOUSE — другое имя дома.
 */
import { setup, demolish, connect } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { helpdeskModels } from './models.mjs';
import { COMPANIES, ROLE_OF, helpdeskPostman } from './server.mjs';
import { adminDsn, ensureTenant, seedResident, printPass, isMain } from '../../shared/house.mjs';

/** Имя дома helpdesk по умолчанию. */
export const HOUSE = 'helpdesk';

/** Дом helpdesk: setup() с моделью и режимом сигналов tenant, демо-компании и их люди; fresh — снести прежний. */
export async function prepare(dsn = adminDsn(), house = process.env.HOUSE ?? HOUSE, { fresh = process.env.FRESH === '1' } = {}) {
  if (fresh) await demolish(dsn, house, { quiet: true });
  const r = await setup(dsn, house, { models: helpdeskModels(model, z), signals: 'tenant', quiet: true });
  const box = helpdeskPostman({ log: false });
  const db = await connect(r.pass, { postman: box.postman, listen: false, cache: false });
  try {
    for (const c of COMPANIES) {
      if (!(await ensureTenant(db, c.name))) continue;
      const desk = await db.in(c.name);
      for (const p of [{ ...c.boss, role: 'manager' }, ...c.people]) {
        // засев демо: приглашение консьержа и его принятие за демо-человека; клиентам пароль не задаётся
        const account = await seedResident(db, box, c.name, { email: p.login, password: p.password, name: p.name, roles: [ROLE_OF[p.role] ?? p.role] });
        await desk.Profile().owner(account).upsert({ account, name: p.name, login: p.login }).rows();
      }
    }
  } finally {
    await db.close();
  }
  return r;
}

if (isMain(import.meta.url)) printPass((await prepare()).pass, process.argv[2]);
