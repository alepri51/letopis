/**
 * db.auth: вход по кредам (пароль / api-key / key-secret / внешние identity)
 * + сессии на живом Redis (тот же dev-контейнер, порт 16379).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { connect } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const REDIS = process.env.ENTITY_REDIS ?? 'redis://localhost:16379';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

let db: EntityDb;
let redis: Redis;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'booking' });
  redis = new Redis(REDIS);
});
after(async () => {
  redis.disconnect();
  await db.close();
});

const newAccount = (name: string) => db.accounts.set({ categories: ['User'], data: { name } });

test('пароль: set → verify; неверный/чужой → null; ротация; в БД только scrypt-хэш', async () => {
  const acc = await newAccount('ПарольщикА');
  const email = uniq('user') + '@x.io';

  const cred = await db.auth.setPassword({ account: acc, identifier: email, password: 'секрет-123' });
  assert.equal(cred.category, 'PASSWORD');
  assert.match(cred.meta.password as string, /^scrypt\$32768\$8\$1\$/); // не открытый текст

  const ok = await db.auth.verifyPassword({ identifier: email, password: 'секрет-123' });
  assert.equal(ok?.account.id, acc.id);
  assert.equal(ok?.credential.id, cred.id);

  assert.equal(await db.auth.verifyPassword({ identifier: email, password: 'не тот' }), null);
  assert.equal(await db.auth.verifyPassword({ identifier: 'нет@такого.io', password: 'x' }), null);

  // ротация: upsert той же тройки — старый пароль умирает, новый работает, id креда прежний
  const rotated = await db.auth.setPassword({ account: acc, identifier: email, password: 'новый-456' });
  assert.equal(rotated.id, cred.id);
  assert.equal(await db.auth.verifyPassword({ identifier: email, password: 'секрет-123' }), null);
  assert.ok(await db.auth.verifyPassword({ identifier: email, password: 'новый-456' }));
});

test('ворота verify: unconfirmed, disabled-аккаунт, удалённый кред → null', async () => {
  const acc = await newAccount('Воротний');
  const email = uniq('gate') + '@x.io';
  await db.auth.setPassword({ account: acc, identifier: email, password: 'p', confirmed: false });

  // не подтверждён — не пускаем; requireConfirmed:false — пускаем
  assert.equal(await db.auth.verifyPassword({ identifier: email, password: 'p' }), null);
  const soft = await db.auth.verifyPassword({ identifier: email, password: 'p', requireConfirmed: false });
  assert.equal(soft?.account.id, acc.id);

  // выключенный аккаунт — не пускаем даже с верным паролем
  await db.accounts.set({ id: acc.id, enabled: false });
  assert.equal(await db.auth.verifyPassword({ identifier: email, password: 'p', requireConfirmed: false }), null);
  await db.accounts.set({ id: acc.id, enabled: true });

  // мягко удалённый кред — вход закрыт
  const [cred] = await db.credentials.find({ account: acc.id, category: 'PASSWORD' });
  await db.credentials.delete(cred.id);
  assert.equal(await db.auth.verifyPassword({ identifier: email, password: 'p', requireConfirmed: false }), null);
});

test('api-ключ: выдача один раз, в БД sha256; verify; revoke', async () => {
  const acc = await newAccount('Ключник');
  const { key, credential } = await db.auth.issueApiKey({ account: acc, name: 'CI-ключ' });

  assert.match(key, /^lts_[0-9a-f]{48}$/);
  assert.equal(credential.identifier, sha256(key)); // открытого ключа в БД нет
  assert.equal(credential.meta.prefix, key.slice(0, 12));

  const ok = await db.auth.verifyApiKey(key);
  assert.equal(ok?.account.id, acc.id);
  assert.equal(await db.auth.verifyApiKey('lts_' + '0'.repeat(48)), null);

  await db.credentials.delete(credential.id);
  assert.equal(await db.auth.verifyApiKey(key), null);
});

test('key-secret: пара выдаётся один раз, secret в БД — sha256', async () => {
  const acc = await newAccount('Парник');
  const { key, secret, credential } = await db.auth.issueKeySecret({ account: acc, name: 'интеграция' });

  assert.match(key, /^[0-9a-f]{16}$/);
  assert.match(secret, /^[0-9a-f]{48}$/);
  assert.equal(credential.identifier, key);
  assert.equal(credential.meta.secret, sha256(secret));

  const ok = await db.auth.verifyKeySecret(key, secret);
  assert.equal(ok?.account.id, acc.id);
  assert.equal(await db.auth.verifyKeySecret(key, 'f'.repeat(48)), null);
  assert.equal(await db.auth.verifyKeySecret('0'.repeat(16), secret), null);
});

test('внешняя identity: link → lookup (TELEGRAM-стиль)', async () => {
  const acc = await newAccount('Телеграмщик');
  const tgId = String(1_000_000 + Math.floor(Math.random() * 1_000_000));

  await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: tgId, meta: { username: 'roboteza' } });
  const ok = await db.auth.lookup({ category: 'TELEGRAM', identifier: tgId });
  assert.equal(ok?.account.id, acc.id);
  assert.equal(ok?.credential.meta.username, 'roboteza');

  assert.equal(await db.auth.lookup({ category: 'TELEGRAM', identifier: '0' }), null);
});

test('глобальная идентичность: один живой identifier на категорию во всей схеме', async () => {
  const a1 = await newAccount('Первый');
  const a2 = await newAccount('Второй');
  const email = uniq('shared') + '@x.io';

  await db.auth.setPassword({ account: a1, identifier: email, password: 'p1' });
  await assert.rejects(
    db.auth.setPassword({ account: a2, identifier: email, password: 'p2' }),
    /credential_identity_udx|duplicate key/,
  );

  // после мягкого удаления identifier освобождается (частичный индекс WHERE deleted IS NULL)
  const [cred] = await db.credentials.find({ account: a1.id, identifier: email });
  await db.credentials.delete(cred.id);
  const took = await db.auth.setPassword({ account: a2, identifier: email, password: 'p2' });
  assert.equal(took.account, a2.id);
});

test('сессии в Redis: start/check/expire/revoke/revokeAll; токен в Redis не хранится', async () => {
  const acc = await newAccount('Сессионный');
  const s = db.auth.sessions(redis);

  const token = await s.start(acc, { meta: { device: 'test' } });
  assert.match(token, /^[0-9a-f]{64}$/);

  const sess = await s.check(token);
  assert.equal(sess?.account, acc.id);
  assert.equal(sess?.meta.device, 'test');
  assert.equal(await s.check('a'.repeat(64)), null);

  // в Redis — только sha256(token)
  assert.equal(await redis.exists(`sess:${token}`), 0);
  assert.equal(await redis.exists(`sess:${sha256(token)}`), 1);

  // реальное истечение
  const shortLived = await s.start(acc, { ttlSec: 1 });
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await s.check(shortLived), null);

  // revoke: одна гаснет, повторный revoke — false
  assert.equal(await s.revoke(token), true);
  assert.equal(await s.check(token), null);
  assert.equal(await s.revoke(token), false);

  // revokeAll: обе живые сессии гаснут разом
  const t1 = await s.start(acc);
  const t2 = await s.start(acc);
  const n = await s.revokeAll(acc);
  assert.ok(n >= 2);
  assert.equal(await s.check(t1), null);
  assert.equal(await s.check(t2), null);
});
