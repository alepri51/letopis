/**
 * Подготовка дома документов — мастер-ключом, один раз; повтор безопасен и отдаёт тот же пропуск:
 *
 *   ADMIN_DSN=postgres://… node src/setup.mjs [файл]
 *
 * - setup() строит дом (схема v2.documents), заводит консьержа и пишет модель (src/models.mjs) в общие классы дома: их
 *   пишет консьерж, при повторе — только то, что изменилось.
 * - Консьерж по пропуску заводит квартиру фирмы (createTenant; повтор — exists). Квартира заведена сейчас — засев демо:
 *   консьерж зовёт руководителя (роль owner) и юриста (роль staff), ссылки приходят почтальону-заглушке, подготовка
 *   принимает их за демо-сотрудников с известными паролями (seedResident).
 * - Архив старых договоров (src/archive.mjs) — загрузка мастер-ключом, командой letopis load: в пустую квартиру, с
 *   историей (--with-history: у договора четыре версии из прежней системы) и исполнителем «перенос архива» (--agent).
 *   Дом только что построен — первая заливка (--initial: одна транзакция, индексы и триггеры — после загрузки). В
 *   квартире уже есть документы — архив не трогается.
 *
 * FRESH=1 — демо с нуля: дом сносится (demolish) и строится заново, данные и прежний пропуск пропадают. Пропуск
 * печатается строкой LETOPIS_PASS=… или пишется в файл (шаг инициализации compose). HOUSE — другое имя дома.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, demolish, connect } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { documentModels } from './models.mjs';
import { archiveRows, ARCHIVE_AGENT } from './archive.mjs';
import { FIRM, USERS } from './server.mjs';
import { adminDsn, ensureTenant, seedResident, printPass, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';

/** Имя дома документов по умолчанию. */
export const HOUSE = 'documents';

/** Дом документов: setup() с моделью Party и Doc (Draft, Contract), квартира фирмы и архив; fresh — снести прежний. */
export async function prepare(dsn = adminDsn(), house = process.env.HOUSE ?? HOUSE, { fresh = process.env.FRESH === '1' } = {}) {
  if (fresh) await demolish(dsn, house, { quiet: true });
  const r = await setup(dsn, house, { models: documentModels(model, z), quiet: true });
  const box = createPostman({ service: 'documents setup', log: false });
  const db = await connect(r.pass, { postman: box.postman, listen: false, cache: false });
  try {
    if (await ensureTenant(db, FIRM)) {
      // засев демо: сотрудники фирмы по приглашению консьержа
      for (const u of Object.values(USERS)) {
        await seedResident(db, box, FIRM, { email: u.login, password: u.password, name: u.name, roles: u.roles });
      }
    }
    const firm = await db.in(FIRM);
    if (!(await firm.Doc().withDeleted().count())) loadArchive(dsn, r.schema, { initial: r.created });
  } finally {
    await db.close();
  }
  return r;
}

/**
 * Архив — командой letopis load мастер-ключом (у консьержа и жильцов загрузчика нет). Команда пакета — dist/cli.js
 * рядом с его входом; строки — во временном файле NDJSON. Ответ — отчёт загрузки.
 */
function loadArchive(dsn, schema, { initial }) {
  const dir = mkdtempSync(join(tmpdir(), 'documents-archive-'));
  try {
    const file = join(dir, 'archive.ndjson');
    writeFileSync(file, `${archiveRows().map((row) => JSON.stringify(row)).join('\n')}\n`);
    const cli = fileURLToPath(import.meta.resolve('letopis').replace(/\/index\.(\w+)$/, '/cli.$1'));
    const args = [...process.execArgv, cli, 'load', file, '--dsn', dsn, '--schema', schema, '--tenant', FIRM,
      '--with-history', '--agent', ARCHIVE_AGENT, ...(initial ? ['--initial'] : [])];
    const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`letopis load: ${(out.stderr || out.stdout || '').trim()}`);
    return JSON.parse(out.stdout.trim().split('\n').at(-1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) printPass((await prepare()).pass, process.argv[2]);
