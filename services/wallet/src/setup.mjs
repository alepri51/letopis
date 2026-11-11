/**
 * Подготовка дома кошелька — мастер-ключом, один раз; повтор безопасен и отдаёт тот же пропуск:
 *
 *   ADMIN_DSN=postgres://… node src/setup.mjs [файл]
 *
 * - setup() строит дом (схема v2.wallet), заводит консьержа и пишет модель (src/models.mjs) в общие классы дома: их
 *   пишет консьерж, при повторе — только то, что изменилось.
 * - Консьерж по пропуску заводит квартиру «Копейка». Квартира заведена сейчас — засев демо: консьерж зовёт оператора с
 *   ролью owner, ссылка приходит почтальону-заглушке, подготовка принимает её за демо-оператора с известным паролем
 *   (seedResident). Квартира уже была — её жильцов подготовка не трогает.
 *
 * Пропуск печатается строкой LETOPIS_PASS=… или пишется в файл (шаг инициализации compose). HOUSE — другое имя дома.
 */
import { setup, connect } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { walletModels } from './models.mjs';
import { COMPANY, OPERATOR } from './server.mjs';
import { adminDsn, ensureTenant, seedResident, printPass, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';

/** Имя дома кошелька по умолчанию. */
export const HOUSE = 'wallet';

/** Дом кошелька: setup() с моделью Wallet и Movement, квартира и демо-оператор. Ответ — SetupResult (pass — пропуск). */
export async function prepare(dsn = adminDsn(), house = process.env.HOUSE ?? HOUSE) {
  const { Wallet, Movement } = walletModels(model, z);
  const r = await setup(dsn, house, { models: [Wallet, Movement], quiet: true });
  const box = createPostman({ service: 'wallet setup', log: false });
  const db = await connect(r.pass, { postman: box.postman, listen: false, cache: false });
  try {
    // засев демо: оператор — роль owner, правило хозяина квартиры (его заводит createTenant) даёт ей всё
    if (await ensureTenant(db, COMPANY)) {
      await seedResident(db, box, COMPANY, { email: OPERATOR.login, password: OPERATOR.password, name: OPERATOR.name, roles: ['owner'] });
    }
  } finally {
    await db.close();
  }
  return r;
}

if (isMain(import.meta.url)) printPass((await prepare()).pass, process.argv[2]);
