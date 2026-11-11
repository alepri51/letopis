/**
 * Подготовка дома салона — мастер-ключом, один раз; повтор безопасен и отдаёт тот же пропуск:
 *
 *   ADMIN_DSN=postgres://… node src/setup.mjs [файл]
 *
 * - setup() строит дом (схема v2.salon) с сидом booking — моделью салона в общих классах дома — и заводит консьержа.
 * - Консьерж по пропуску заводит квартиры салонов (createTenant). Квартира заведена сейчас — засев демо: консьерж
 *   зовёт управляющую с ролью owner, ссылка приходит почтальону-заглушке, и подготовка принимает её за демо-управляющую
 *   с известным паролем (seedResident). Квартира уже была — её жильцов подготовка не трогает.
 *
 * Пропуск печатается строкой LETOPIS_PASS=… или пишется в файл (шаг инициализации compose). HOUSE — другое имя дома.
 */
import { setup, connect } from 'letopis';
import { SALONS } from './server.mjs';
import { adminDsn, ensureTenant, seedResident, printPass, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';

/** Имя дома салона по умолчанию. */
export const HOUSE = 'salon';

/** Дом салона: setup() с сидом booking, квартиры салонов и демо-управляющие. Ответ — SetupResult (pass — пропуск консьержа). */
export async function prepare(dsn = adminDsn(), house = process.env.HOUSE ?? HOUSE) {
  const r = await setup(dsn, house, { seeds: ['booking'], quiet: true });
  const box = createPostman({ service: 'salon setup', log: false });
  const db = await connect(r.pass, { postman: box.postman, listen: false, cache: false });
  try {
    for (const s of SALONS) {
      if (!(await ensureTenant(db, s.name))) continue;
      // засев демо: управляющая — роль owner, правило хозяина квартиры (его заводит createTenant) даёт ей всё
      await seedResident(db, box, s.name, { email: s.user.login, password: s.user.password, name: s.user.name, roles: ['owner'] });
    }
  } finally {
    await db.close();
  }
  return r;
}

if (isMain(import.meta.url)) printPass((await prepare()).pass, process.argv[2]);
