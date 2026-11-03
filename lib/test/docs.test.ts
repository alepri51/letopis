/**
 * docs — примеры документации исполняются. Блок ```ts, перед которым стоит `<!-- run -->` или `<!-- run: имя -->`,
 * входит в сценарий с этим именем (без имени — `main`); блоки сценария склеиваются по порядку и выполняются
 * против PostgreSQL 18: lib/README.md, lib/AGENT-CHEATSHEET.md и корневой README.md. Каждый сценарий — в своей свежей
 * схеме v2.t_docs_<документ>[_<сценарий>]: строки `const ADMIN = …` и `const APP = …`
 * заменяются подключениями обвязки, имя схемы примеров — схемой теста, импорты 'letopis', 'letopis/model' и 'letopis/mcp' —
 * исходниками пакета, `import type` убирается. Блоки без пометки (командная строка, PGlite)
 * не исполняются: их покрывают свои тесты.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADMIN_DSN, appDsn, adminSql, ensureAppRole, ensureDatabase, ident, type Sql } from './_harness.js';
import { up } from '../src/index.js';

const LIB = fileURLToPath(new URL('..', import.meta.url));

interface Doc {
  file: string;
  /** Имя схемы теста (без v2.); у сценария с именем — с суффиксом _<имя>. */
  schema: string;
  /** Имя схемы в примерах документа: '<token>', 'v2.<token>' и "v2.<token>" заменяются схемой теста. */
  token: string;
  /** Меньше помеченных блоков — документ потерял пометки, тест не должен молча пройти. */
  minBlocks: number;
  /**
   * Проверки после сценария: результаты, обещанные комментариями примеров (`// { allow: false }` и т. п.).
   * Код дописывается в конец модуля и видит переменные сценария; `assert` и `__connect` (connect пакета) —
   * в его импортах.
   */
  expect?: Record<string, string>;
}

const README_EXPECT: Record<string, string> = {
  quickstart: `
assert.equal(expensive.length, 1)                 // чайник подешевел до 2000 и остался дороже 1000
assert.equal(history.length, 2)                   // создание и правка
`,
  guide: `
assert.equal(lutik.created, true)
assert.equal(plan.applied, false)
assert.equal(applied.applied, true)
assert.deepEqual([...applied.created].sort(), ['Category', 'Customer', 'Movement', 'Order', 'Product', 'Shop', 'Vip', 'Wallet', 'line'])
assert.equal(kept.$upsert, 'unchanged')
assert.equal(moved.$upsert, 'updated')
assert.notEqual(mug2.id, mug.id)                  // rekey: новый id
assert.equal(vip.id, olga.id)                     // reclass класса без ключа: id прежний
assert.equal(vip.class, 'Vip')
assert.equal(l1.class, 'line')                    // терминал плана — строки последнего шага
assert.equal(products.length, 3)                  // чайник, сенча, кружка после rekey
assert.equal(shopOf!.id, shop.id)
assert.equal(inOrder.length, 2)
assert.equal(parent!.id, tea.id)
assert.equal(allCustomers.length, 1)              // Ольга — теперь Vip, шаг Customer её находит
assert.equal(onlyCustomer.length, 0)              // exact(): без потомков
assert.equal(cheap.length, 2)
assert.equal(twoIds.length, 2)
assert.equal(active.length, 1)
assert.equal(ofShop.length, 3)
assert.equal(roots.length, 1)
assert.deepEqual(page1.map((x) => x.data.price), [1900, 900])
assert.deepEqual(page2.map((x) => x.data.price), [400])
assert.equal(subtree.length, 1)
assert.equal(subtree[0].$depth, 1)
assert.equal(total, 2900)
assert.deepEqual(byStatus, { new: 1 })
assert.equal(orderPaths.length, 2)
assert.equal(preview.length, 3)                   // заказ и две его строки
assert.ok(preview.every((x) => x.$action === 'delete'))
assert.equal(blockers.length, 3)                  // товары не дают удалить магазин
assert.equal(before[0].$versions, 2)              // создание и удаление
assert.deepEqual(results.map((x) => x.length), [1, 1])
assert.equal(rep.loaded, 4)
assert.deepEqual(rep.byClass, { Shop: 1, Product: 2, Customer: 1 })
assert.equal(again.skipped, 1)
assert.equal(changed.updated, 1)
assert.ok(viaKey)
assert.equal(failed, null)
assert.ok(byCode)
assert.equal(totpOk, true)
assert.ok(viaTelegram)
assert.ok(mine.length >= 2)
assert.equal(canDelete.allow, false)
assert.equal(canRead.allow, true)
assert.equal(canReport.allow, true)
assert.equal(canReport.rule?.weight, 50)
assert.equal(atCreation!.data.price, 2500)
assert.notEqual(cursor, '')
assert.equal(report.skipped, false)
{
  const chk = await __connect({ dsn: APP, schema: r.schema, token: r.tenant!.token!, listen: false })
  try {
    assert.equal(await chk.Order(order).line().count(), 2)                  // restore вернул и строки заказа
    assert.equal((await chk.Wallet(wallet).first())!.data.balance, 5000)   // 10 000 − 3 000, затем adjust до 5 000
    assert.equal(await chk.Wallet(wallet).Movement().count(), 3)           // повтор op-1 не записал вторую операцию
    assert.equal((await chk.Wallet(wallet2).first())!.data.balance, 6000)
    assert.equal(n, await chk.Product().count())
  } finally {
    await chk.close()
  }
}
`,
  // обработчик HTTP из README (createMcpHandler SDK): клиент SDK ходит в него через fetch приложения
  mcp: `
{
  const { Client, StreamableHTTPClientTransport } = await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/client'))})
  const authInfo = { token: 'app-token', clientId: 'app', scopes: [], extra: { account: r.tenant!.user } }
  const client = new Client({ name: 'docs', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),
    { fetch: (url: string | URL, init?: RequestInit) => mcp.fetch(new Request(url, init), { authInfo }) }))
  try {
    const tools = (await client.listTools()).tools.map((x: { name: string }) => x.name).sort()
    assert.deepEqual(tools, ['letopis_history', 'letopis_model', 'letopis_query'])   // без write — только чтение
    const model = await client.callTool({ name: 'letopis_model', arguments: {} })
    assert.equal(model.isError, undefined)
    assert.equal(model.structuredContent.data.tenant, r.tenant!.tenant)                     // от имени Анны в магазине
  } finally {
    await client.close()
    await mcp.close()
    await svc.close()
  }
}
`,
};

const CHEAT_EXPECT: Record<string, string> = {
  main: `
assert.match(r.serviceKey ?? '', /^lts_/)
assert.ok(login)
assert.equal(db.tenant, SALON)
assert.deepEqual([...synced.created].sort(), ['Note', 'Payment', 'Shop', 'Wallet'])
assert.equal(up1.$upsert, 'updated')
assert.notEqual(w200.id, w2.id)                   // rekey: новый id
assert.deepEqual(batchRows.map((x) => x.length), [1, 1])
assert.equal(paid, 500)
assert.equal(page.length, 2)
assert.equal(next.length, 0)
assert.ok(preview.some((x) => x.class === 'Wallet' && x.$action === 'restrict'))
assert.equal(rep.loaded, 2)
assert.equal(canReport.allow, true)
assert.equal(canDelete.allow, false)
assert.notEqual(cursor, '')
assert.ok(history.length >= 5)
{
  const chk = await __connect({ dsn: APP, schema: r.schema, token: login!.token, listen: false })
  try {
    assert.equal((await chk.Wallet(w).first())!.data.balance, 1)   // 500 − 300, затем 0 под { rev }, затем +1
  } finally {
    await chk.close()
  }
}
`,
};

const ROOT_EXPECT: Record<string, string> = {
  main: `
assert.equal(vasya.class, 'Staff')
assert.equal(vasya.links.Org, org.id)             // конец Org — из пути
assert.equal(services.length, 0)                  // навыков ещё нет
assert.equal(typeof earlier, 'number')
`,
};

const DOCS: Doc[] = [
  { file: '../README.md', schema: 't_docs_root', token: 'salon', minBlocks: 1, expect: ROOT_EXPECT },
  { file: 'README.md', schema: 't_docs_readme', token: 'shop', minBlocks: 30, expect: README_EXPECT },
  { file: 'AGENT-CHEATSHEET.md', schema: 't_docs_cheat', token: 'myapp', minBlocks: 10, expect: CHEAT_EXPECT },
];

const BLOCK = /<!--\s*run(?::\s*([\w-]+))?\s*-->[ \t]*\r?\n```ts\r?\n([\s\S]*?)\r?\n```/g;
const IMPORT = /^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+'([^']+)'\s*;?\s*$/;

/** Bare-спецификатор → URL: 'letopis', 'letopis/model' и 'letopis/mcp' — исходники, остальное — из node_modules пакета. */
function resolveSpec(spec: string): string {
  if (spec === 'letopis') return pathToFileURL(join(LIB, 'src', 'index.ts')).href;
  if (spec === 'letopis/model') return pathToFileURL(join(LIB, 'src', 'model.ts')).href;
  if (spec === 'letopis/mcp') return pathToFileURL(join(LIB, 'src', 'mcp.ts')).href;
  if (spec.startsWith('node:')) return spec;
  return import.meta.resolve(spec);
}

/** Помеченные блоки документа по сценариям: имя → тексты блоков по порядку. */
function stories(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of md.matchAll(BLOCK)) {
    const name = m[1] ?? 'main';
    if (!out.has(name)) out.set(name, []);
    out.get(name)!.push(m[2]);
  }
  return out;
}

/** Блоки сценария → текст модуля: импорты собраны наверх и объединены, подключения и схема подставлены. */
function story(blocks: string[], doc: Doc, schema: string, where: string, expect?: string): string {
  const named = new Map<string, Set<string>>();
  const defaults = new Map<string, string>();
  const body: string[] = [];
  blocks.forEach((block, i) => {
    body.push(`// --- блок ${i + 1}`);
    for (const line of block.split(/\r?\n/)) {
      if (/^import\s+type\s/.test(line)) continue;
      const im = line.match(IMPORT);
      if (!im) {
        body.push(line);
        continue;
      }
      const [, def, names, from] = im;
      if (def) defaults.set(from, def);
      for (const n of (names ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!named.has(from)) named.set(from, new Set());
        named.get(from)!.add(n);
      }
    }
  });
  const head: string[] = [];
  for (const from of new Set([...defaults.keys(), ...named.keys()])) {
    const parts = [defaults.get(from), named.has(from) ? `{ ${[...named.get(from)!].join(', ')} }` : undefined].filter(Boolean);
    head.push(`import ${parts.join(', ')} from ${JSON.stringify(resolveSpec(from))};`);
  }
  let code = body.join('\n');
  const admin = /^const ADMIN = .*$/m;
  const app = /^const APP = .*$/m;
  assert.match(code, admin, `${where}: в сценарии нет строки «const ADMIN = …»`);
  assert.match(code, app, `${where}: в сценарии нет строки «const APP = …»`);
  code = code
    .replace(admin, `const ADMIN = ${JSON.stringify(ADMIN_DSN)}`)
    .replace(app, `const APP = ${JSON.stringify(appDsn())}`)
    .replaceAll(`"v2.${doc.token}"`, `"v2.${schema}"`)
    .replaceAll(`'v2.${doc.token}'`, `'v2.${schema}'`)
    .replaceAll(`'${doc.token}'`, `'${schema}'`);
  if (expect) {
    head.push(`import assert from 'node:assert/strict';`, `import { connect as __connect } from ${JSON.stringify(resolveSpec('letopis'))};`);
    code += `\n// --- проверки обещанных результатов\n${expect}`;
  }
  return `${head.join('\n')}\n${code}\n`;
}

let sql: Sql;
let dir: string;
const used: string[] = [];

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  // роль приложения обвязки должна состоять в letopis_app до первого connect() сценария, а роль letopis_app
  // создаёт установщик: ставим и сразу убираем служебную схему
  await up({ dsn: ADMIN_DSN, schema: 't_docs_roles', quiet: true });
  await sql.unsafe(`drop schema if exists ${ident('v2.t_docs_roles')} cascade`);
  await ensureAppRole(sql);
  dir = await mkdtemp(join(tmpdir(), 'letopis-docs-'));
});

after(async () => {
  for (const s of used) await sql?.unsafe(`drop schema if exists ${ident(`v2.${s}`)} cascade`).catch(() => {});
  await sql?.end({ timeout: 5 });
  if (dir) await rm(dir, { recursive: true, force: true });
});

for (const doc of DOCS) {
  const path = join(LIB, doc.file);
  if (!existsSync(path)) {
    test(`${doc.file}: документ есть`, () => assert.fail(`нет файла lib/${doc.file}`));
    continue;
  }
  const all = stories(readFileSync(path, 'utf8'));
  const total = [...all.values()].reduce((n, b) => n + b.length, 0);
  test(`${doc.file}: помеченных примеров не меньше ${doc.minBlocks}`, () => {
    assert.ok(total >= doc.minBlocks, `${doc.file}: помеченных блоков ${total}, ожидалось не меньше ${doc.minBlocks}`);
  });
  for (const [name, blocks] of all) {
    const schema = name === 'main' ? doc.schema : `${doc.schema}_${name}`;
    test(`${doc.file}: сценарий «${name}» (${blocks.length} блоков) исполняется`, async () => {
      used.push(schema);
      const code = story(blocks, doc, schema, `${doc.file}, сценарий «${name}»`, doc.expect?.[name]);
      await sql.unsafe(`drop schema if exists ${ident(`v2.${schema}`)} cascade`);
      // .mts — модуль ES независимо от package.json вокруг временного каталога
      const file = join(dir, `${schema}.mts`);
      await writeFile(file, code);
      await import(pathToFileURL(file).href);
    });
  }
}
