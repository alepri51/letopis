/**
 * Генератор МНОГОАРЕНДАТОРНОГО полигона (v1.tenants) — под замер цены изоляции арендатора.
 * Отвечает на вопрос «сколько стоит enforceAccount», на который единый полигон
 * v1.salondemo ответить не может: там System-аккаунт владеет 100% класса, то есть предикат
 * account никого не отсекает — вырожденный худший случай.
 *
 *   node bench/tenants-seed.mjs              # пересоздать v1.tenants и засеять
 *   node bench/tenants-seed.mjs --keep       # не пересоздавать схему (досев)
 *   node bench/tenants-seed.mjs --entities=200000
 *
 * 10 аккаунтов с перекошенным распределением (как в жизни: доминант + хвост мелких),
 * по 2 версии на сущность. Итог по умолчанию — 1 млн строк класса Customer.
 *
 * Bulk-INSERT идёт при session_replication_role = replica: append-only-триггеры выключены,
 * потому что здесь исследуются ФОРМА запроса и план, а не бизнес-инварианты (их проверяют
 * test/parity.test.ts и остальной набор). ANALYZE в конце обязателен — см. README §14.1.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.tenants';
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const ENTITIES = Number(args.find((a) => a.startsWith('--entities='))?.split('=')[1] ?? 500_000);

/** Доли класса на арендатора: доминант, середина, длинный хвост мелких. */
export const SHARES = [0.50, 0.20, 0.10, 0.08, 0.05, 0.03, 0.02, 0.01, 0.007, 0.003];
/** id арендаторов детерминированы — бенч берёт их по номеру, без чтения Account. */
export const tenantId = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const TENANTS = SHARES.map((share, i) => ({
  id: tenantId(i + 1),
  share,
  name: `Арендатор ${i + 1} (${(share * 100).toFixed(1)}%)`,
}));

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) await main();

async function main() {
  if (!KEEP) {
    const admin = postgres(DSN, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
    await admin.end();
    const apply = fileURLToPath(new URL('../../db/apply.mjs', import.meta.url));
    execFileSync('node', [apply, `--dsn=${DSN}`, '--schema=tenants', '--version=1'], { stdio: 'ignore' });
    console.log(`схема ${S} создана`);
  }

  const sql = postgres(DSN, { max: 1, onnotice: () => {} });
  const t0 = Date.now();

  for (const t of TENANTS) {
    await sql.unsafe(
      `INSERT INTO "${S}"."Account" (id, categories, data) VALUES ($1::uuid, '{User}', jsonb_build_object('name', $2::text))
       ON CONFLICT (id) DO NOTHING`, [t.id, t.name]);
  }

  await sql.unsafe('BEGIN');
  await sql.unsafe('SET LOCAL session_replication_role = replica');
  await sql.unsafe(`DELETE FROM "${S}"."Entity" WHERE class = 'Customer'`);

  let offset = 0;
  for (const t of TENANTS) {
    const n = Math.round(ENTITIES * t.share);
    // data.city — поле под GIN-фильтр (каждый 10-й «Москва»), 2 версии на сущность
    await sql.unsafe(`
      INSERT INTO "${S}"."Entity" (partition, class, id, data, links, tags, account, owner, updated)
      SELECT 'entity', 'Customer',
             ('00000000-0000-4000-8000-' || lpad((${offset} + g)::text, 12, '0'))::uuid,
             jsonb_build_object('name', 'Клиент ' || (${offset} + g),
                                'phone', '+7900' || lpad(((${offset} + g) % 10000000)::text, 7, '0'),
                                'city', CASE WHEN g % 10 = 0 THEN 'Москва' ELSE 'Тверь' END),
             '{}'::jsonb, '{}'::text[], '${t.id}'::uuid, '${t.id}'::uuid,
             now() - ((${offset} + g) || ' seconds')::interval + (v || ' hours')::interval
      FROM generate_series(1, ${n}) g, generate_series(1, 2) v`);
    offset += n;
  }
  await sql.unsafe('COMMIT');
  console.log(`вставка: ${((Date.now() - t0) / 1000).toFixed(1)} с`);

  // без статистики планировщик берёт дефолт «200 уникальных id» и цифры мерят не то (§14.1)
  process.stdout.write('ANALYZE… ');
  await sql.unsafe(`ANALYZE "${S}"."Entity"`);
  console.log('готово');

  const dist = await sql.unsafe(`
    SELECT a.data->>'name' AS имя, count(DISTINCT e.id)::int AS сущностей, count(*)::int AS версий
    FROM "${S}"."Entity" e JOIN "${S}"."Account" a ON a.id = e.account
    WHERE e.class = 'Customer' GROUP BY 1 ORDER BY 2 DESC`);
  const [{ total }] = await sql.unsafe(`SELECT count(*)::int AS total FROM "${S}"."Entity" WHERE class = 'Customer'`);
  console.log(`всего версий Customer: ${total}`);
  for (const r of dist) console.log(`  ${r.имя.padEnd(26)} сущностей ${String(r.сущностей).padStart(7)}  версий ${String(r.версий).padStart(7)}`);
  await sql.end();
}
