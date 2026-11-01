# letopis 1.4 — agent cheatsheet

One page instead of [README.en.md](README.en.md), for an AI agent that writes code on top of the package. It ships in
the package next to the README; in Russian: [Русская версия](AGENT-CHEATSHEET.md). Migration from 0.21:
[MIGRATION.md](MIGRATION.md) (in Russian); the machine-readable catalog of the API and errors is `docs/api-contract.json`
in the repository. The examples below go in order and form one program; the `docs` test runs it against PostgreSQL 18,
so the code is checked against the package.

## The model in a minute

- PostgreSQL 18+, Node 22+. Three tables in the installation schema `v2.<name>`: `entity` (the current version of each
  entity), `log` (the journal of all versions), `secret` (credentials and sessions). Classes, accounts and access rules
  are `entity` rows too.
- Checks are done by **the database**: triggers (data against JSON Schema, references, keys, the journal) and RLS
  policies (tenant and access rules). Raw SQL from the application role behaves the same way as the library.
- A hub (`hub`) is an entity; a link (`link`) is an entity with ends. Ends are in `row.links`, fields are in `row.data`.
- id: for a class with a key it is a UUID v5 of (class, key values) within the tenant, and it can be computed in
  advance (`db.idOf`); for a class without a key the database assigns the id. Only the key gives uniqueness.
- Tenant = account. Rows belong to the **session** tenant; rows of other tenants are not visible. Access rules are
  always on and **deny** by default.

## Working cycle

### 1. Installation: `up()` and the application role

<!-- run -->
```ts
import { up, connect, syncModels, inc, gt, or, cursorOf } from 'letopis'

const ADMIN = 'postgres://postgres:pass@localhost:5432/app'      // superuser or a role with CREATEROLE
const r = await up({ dsn: ADMIN, schema: 'myapp',                  // schema 'v2.myapp'
  tenant: { name: 'Salon', user: { name: 'Olga', login: 'olga@salon.ru', password: 'Lilac-2026!' } } })
// r: { schema, created, upgraded, revision, serviceKey, migrations, analyzed, tenant, … }
// r.serviceKey ('lts_…') is the service key; it is issued at the first installation (again only if the installation has
// no API keys left except revoked ones). Save it.
// r.tenant: { tenant, user, token, created } — the tenant "Salon" and its first user Olga
```
- `up()` waits for the database, creates it, checks for PostgreSQL 18+ and UTF8, and installs the roles `letopis_owner`
  and `letopis_app`. Options: `fresh` (recreate the schema), `upgrade` (apply migrations), `seeds` (the name of a
  package seed, for example `'booking'` for the demo domain, or a path to your own `.sql`), `history` (retention
  policy), `allowReset`, `serviceKey`, `quiet`, `pglite: true` (a database for development without PostgreSQL; then
  `connect({ dsn: r.pglite.dsn, listen: false, max: 1, allowBypassRls: true, … })` — a superuser connection, RLS
  does not apply on it).
- `signals` — what `NOTIFY` signals show to any role that can connect to the database. The channel is the full
  schema name (`LISTEN "v2.myapp"`); the write signal payload: `'class'` (default) — `Class`; `'tenant'` —
  `Class@tenant token` (the cache is cleared only in the tenant of the write); `'opaque'` — `class token@tenant
  token`; `'none'` — no signals (the cache works only with `ttlOnly`, subscriptions poll the log). Service signals:
  `session:<16 hex>` is a revoked session, `session:*` and `*` are resets (`reset`). The mode is stored in the
  schema: `up()` without the option keeps it; after a change, restart the processes. The signal key (precise cache
  clearing) goes to services — the `letopis.signals` permission. The `up()` result also has `signals` and `warnings`
  (PostgreSQL below 18.2 — upgrade).
- After a package update, call `up()`: only it re-applies the schema functions. `connect()` warns if the engine stamp
  in the schema comment (package version and a hash of its SQL) does not match the package: an older schema — `up()`,
  a newer one — update the package.
- `tenant` — the first tenant and user without a seed of your own: the tenant gets the rule "authenticated users may
  do everything" (`grantAll`, on by default, weight 10); the user gets a membership with the roles `user.roles`
  (`['owner']` by default), a password for signing in with the login `login`, and a session in the tenant. Repeating
  the call with the same name and login duplicates nothing and does not change the roles of an existing membership (the
  ids are v5 of `tenant:<name>` and `user:<login>`). Another tenant: `createTenant(postgres(ADMIN), 'v2.myapp', { name,
  user })` (needs an admin connection).
- The application connects with an **application LOGIN role** that is a member of `letopis_app` only:
  `create role myapp login password '…'; grant letopis_app to myapp;`. Connecting as a superuser is the error
  `bypass_rls` (RLS would not apply); an admin connection is possible only with an explicit `allowBypassRls: true`.
- Accounts live in the System tenant; the system administrator (a member of System with the `admin` role; your own
  installation seed or the loader on an admin connection appoints one) creates them with the chain `admin.Account().create({ name, categories })`. Your own seed (`seeds: ['./my.sql']`, the owner functions
  `sys_create`, `sys_grant_all`, the markers `@SCHEMA@`, `@SYSTEM@`) remains for special cases.

### 2. Sign-in: service, password, session

<!-- run -->
```ts
const APP = 'postgres://myapp:…@localhost:5432/app'
const svc = await connect({ dsn: APP, schema: 'v2.myapp', apiKey: r.serviceKey! })   // service: key → session
const SALON = r.tenant!.tenant, OLGA = r.tenant!.user!
await svc.auth.setPassword({ account: SALON, identifier: 'salon@example.com', password: 'Lilac-2026!', confirmed: true })
const login = await svc.auth.verifyPassword({ identifier: 'salon@example.com', password: 'Lilac-2026!' })
// login: { account, token } | null (a wrong password or an unconfirmed credential gives null, not an error)
const db = await connect({ dsn: APP, schema: 'v2.myapp', token: login!.token })
db.tenant          // the session tenant: by default the account's own tenant (here SALON)
```
- `connect({ dsn | sql, schema: 'v2.<name>', token | apiKey, max, listen, cache, onQuery, slowMs, maintain,
  allowBypassRls, models })`. `schema` is the **full** name with `v2.`.
- `db.auth`: `setPassword`, `verifyPassword`, `issueApiKey`, `verifyApiKey`, `issueKeySecret`, `verifyKeySecret`,
  `enrollTotp`, `verifyTotp`, `totpEnabled`, `issueOtp`, `verifyOtp`, `link`, `lookup`, `credentials`, `revokeCredential`,
  `setFlags`, `sessionFor(account, { ttl })`, `session(token)`, `refresh`, `revoke`, `revokeAll`, `switch(tenant)`,
  `tenants()`, `purgeAccount`. Password, OTP and TOTP checks, issuing sessions, session details by token and
  confirming credentials are called by the **service** (the `auth.*` permissions); a regular user gets `acl_denied`.
  Signatures: `issueApiKey({ account, name?, ttl? })` → `{ key, id }`; `verifyApiKey(key)` → `{ token, account } | null`;
  `sessionFor(account, { ttl })` → a token string; then `connect({ dsn, schema, token })`, and to work in another
  tenant through a membership, `db.auth.switch(tenant)` (without it, the session is in the account's own tenant). The
  token for the CLI (`--token`) is the same `token` from `verifyPassword`/`verifyApiKey`/`sessionFor`. An admin
  connection (`allowBypassRls`) prints the warning "RLS не действует" (RLS is not in effect); this is expected.
- Second factor: `verifyPassword({ identifier, password, totp })` and `lookup({ kind, identifier, totp })` check the
  TOTP code after the first check (the `auth.totp` permission; the failure counter and lockout are shared with
  `verifyTotp`) → a session with the methods `[kind, 'TOTP']`, with which a user with TOTP changes their own
  credentials. A wrong or repeated code and a code for an account without TOTP give `null`; without `totp`, the code
  is not checked.
- Service keys: with a session of its own key, the service issues and revokes its own keys itself (`issueApiKey`,
  `issueKeySecret` with `account` set to the service id; `revokeCredential(id)`). Revoking a key revokes only the
  sessions of that key, so rotation has no downtime: new key → processes onto it → revoke the old one. The last active
  key of a service cannot be revoked (`acl_denied`); to disable a service, set `enabled: false` on its account.
- Session by token: `svc.auth.session(token)` → `{ account, tenant, member, expiresAt, loginAt, methods } | null`.
  The service (the `auth.session` permission) learns whose session it is, which tenant it works in and whether the
  membership there is intact, without connecting with the token and without extending the session. A wrong, revoked
  or expired token and a disabled account give `null`. This is how a web service checks the session from a cookie at
  the start of every request: reading under a revoked session gives no error, the answers are simply empty.
- Working in another tenant through a membership: `await user.auth.tenants()` → `[{ tenant, roles }]`, then
  `await user.auth.switch(tenant)` (only from the connection root). Impersonation by a service:
  `const u = await svc.as(account, { tenant, owner })` — the database checks it; in the journal, `author` is the user
  and `agent` is the service. `db.as()` is **asynchronous**.

### 3. Models in Zod and `letopis sync`

<!-- run -->
```ts
// models.ts
import { z } from 'zod'
import { hub, link, one, many } from 'letopis/model'
export const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] })
export const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) },
  { key: ['number'], ends: { Shop } })                       // a bare model in ends = one(Shop), a required end
export const Payment = link('Payment', { opId: z.string(), amount: z.number().int() },
  { key: ['Wallet', 'opId'], ends: { Wallet } })             // key from an end and a field: idempotency by opId
export const Note = hub('Note', { text: z.string() }, {})   // no key: the database assigns the id
```
- Full form: `hub(name, { alias, extends, abstract, ends, fields: z.object(…) | { fields }, key, onDelete, history,
  ownerDefault: 'tenant' | 'actor', cache: { ttl }, meta, derivedBy, aggregate })`; `link` works the same way.
  `derivedBy` and `aggregate` are in sections 12 and 13 below. `extends` also works in the short form, but TypeScript
  infers the data types of a descendant only in the full form.
- Ends: `one(A)` (required), `one(A, B)` (union), `one('Name')` (target by name, for a class that refers to itself),
  `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')` (default `restrict`; `unset` only for an optional
  end), `many(A, { min, max, onDelete })`.
- A key is made of fields (required strings) and single required ends. The key is inherited from `extends`.

Models into the database (classes are written to the session tenant; a tightening that existing rows block gives `tightening_conflict`):
<!-- run -->
```ts
const synced = await syncModels(db, [Shop, Wallet, Payment, Note], { apply: true })
// synced: { applied, created, updated, unchanged, skipped, lost } (lost: refine and anything else JSON Schema cannot express)
```
```sh
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN"            # dry run (.ts needs Node 22.18+)
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN" --apply    # apply
npx letopis types --dsn "$APP" --schema v2.myapp --token "$TOKEN" --out types.ts       # class types from the database
```
Chain types: `connect({ …, models: [Shop, Wallet, Payment, Note] })` — the models are used only for types.

### 4. Writing with chains

A verb is part of a plan; the plan is executed by the **terminal** (`rows`, `first`, `ids`, `count` …). The whole plan is one transaction.
<!-- run -->
```ts
const [shop] = await db.Shop().create({ name: 'Center', city: 'Kazan' }).rows()
const [w] = await db.Shop(shop).Wallet().create({ number: 'W-1' }).rows()      // the Shop end comes from the path
const [n] = await db.Note().create({ text: 'hello' }).rows()
await db.Note(n.id).update({ text: 'bye' }).rows()                            // patch merge, new version
const [up1] = await db.Shop().upsert({ name: 'Center', city: 'Ufa' }).rows()  // full replacement; up1.$upsert:
                                                                             // 'created' | 'updated' | 'unchanged'
// money: an increment in the database, without a read; Payment with the key [Wallet, opId]: a repeat gives exists
await db.Wallet(w).Payment().create({ opId: 'op-1', amount: 500 }).Wallet().update({ balance: inc(500) }).rows()
await db.Wallet(w).update({ balance: inc(-300) }).first()                      // balance 200; a result below minimum (0) is invalid_data
const cur = (await db.Wallet(w).first())!
await db.Wallet(w).update({ balance: 0 }, { rev: cur.rev }).first()           // strict mode: someone else's edit gives conflict
// end slots after create / update / upsert: .Role.set(x) .unset(), and for many also .add(x) .remove(x)
const [west] = await db.Shop().create({ name: 'West' }).rows()
await db.Wallet(w).update({}).Shop.set(west).rows()
const [w2] = await db.Shop(shop).Wallet().create({ number: 'W-2' }).rows()
const [w200] = await db.Wallet(w2).rekey({ number: 'W-200' }).rows()          // new key → new id, references are moved
await db.Note(n.id).anonymize(['text']).rows()
const b = db.batch('init'); b.Shop().create({ name: 'A' }); b.Shop().create({ name: 'B' })
const batchRows = await b.run()                                              // Row[][] in one transaction; b.size(), b.discard()
```
- `inc(n, { start })` — only in `update`; a missing field is an error (or `start` is used). The marker cannot come
  from JSON.
- `{ rev }` — only when the step has one target (`rev_ambiguous`). If fewer rows are affected than the step found, the
  plan is rolled back with `target_not_found` (not visible), `conflict` (`rev` differs) or `acl_denied`.

### 5. Reading with a chain

<!-- run -->
```ts
await db.Shop({ city: 'Ufa' }).Wallet().rows()                 // Row[]: { id, class, rev, tenant, owner, links, data, tags, at, author, op, … }
const rich = await db.Wallet({ balance: gt(100) }).count()     // the number of ENTITIES; for paths, count({ paths: true })
const paid = await db.Wallet(w).Payment().sum('data.amount')   // sum | avg | min | max (null when empty), countBy
await db.Shop(west).Wallet().Payment().paths()                 // [{ Shop: Row, Wallet: Row, Payment: Row }]
await db.Wallet(w).first()                                     // Row | null
const page = await db.Wallet().sort('data.number', 'desc').limit(20).rows()
const next = await db.Wallet().sort('data.number', 'desc').after(cursorOf(page.at(-1)!, 'data.number')).limit(20).rows()   // keyset
await db.Note().withDeleted().rows()                           // including deleted ones ($deleted: true)
await db.Wallet(or({ number: 'W-1' }, { number: 'W-200' })).ids()
```
- Step filter: an id, a list of ids, a result row, an object of fields nested to any depth, `or(…)`, the operators
  `ne gt gte lt lte between inList like ilike starts ends has hasAny hasAll exists isNull not`, end roles
  `{ Shop: id }`, `{ Shop: null }`. Fields are in `row.data`, not at the root of the row.
- A step is a class name, an alias or an end role; a step by a parent class also returns descendants (`.exact()` —
  only its own class); `.deep(max)` — a tree (`$depth`); `.tags()`, `.owner()`, `.alias(name)`, `db.entity(row)`.
- `after(cursorOf(row, field))` requires `sort()` by the same field; it pages `rows()`, `versions()` and `paths()` (the
  cursor of a path is `cursorOf(path, field)`, the keys of a path follow the order of the steps). `count()`,
  aggregates, `diff()`, `blame()` ignore the cursor.

### 6. Deletion with a preview

<!-- run -->
```ts
const preview = await db.Shop(shop).delete().rows()     // deletes nothing: the whole cascade closure,
// each row has $action: 'delete' | 'unset' | 'restrict' and $depth (0 is the target; unset and restrict do not have it). Wallet refers to Shop
// with the default onDelete 'restrict': in the preview it has $action 'restrict', and delete({ confirm: true }) would give delete_restricted
await db.Note(n.id).delete({ confirm: true }).rows()   // tombstones (row.$deleted); the cascade follows the onDelete of the ends
await db.Note(n.id).restore().rows()                   // bring back a deleted entity (same id); a live one gives not_deleted
await db.Note(n.id).delete({ confirm: true }).rows()
await db.Note(n.id).purge({ confirm: true }).rows()    // erase the history of a deleted entity; without confirm, a preview
```

### 7. Loader

Only an **admin** connection (`allowBypassRls` and the right to become the owner), otherwise `admin_required`:
<!-- run -->
```ts
const adm = await connect({ dsn: ADMIN, schema: 'v2.myapp', token: login!.token, allowBypassRls: true })
const rep = await adm.load({
  Shop: [{ name: 'North' }],
  Wallet: [{ number: 'W-9', Shop: { $key: ['North'] } }],     // reference: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })   // duplicates 'error'|'first'|'last', existing 'error'|'skip'|'update', commitEvery, withHistory, verify, tenant, as
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
Initial load: `adm.load(rows, { initial: true })`, `letopis load --initial`, `letopis import --initial` — only into an
empty schema (otherwise `not_empty`), in one transaction; about 2.2 times faster than a regular load on a million
objects; no `commitEvery`, `existing` or `{ as }`.

NDJSON files (one object per line; all files form one load):
```sh
npx letopis load shops.ndjson wallets.ndjson --dsn "$ADMIN" --schema v2.myapp --token "$TOKEN" [--class Wallet] \
  [--duplicates first] [--existing skip] [--commit-every 100000] [--verify] [--initial]
# {"$class":"Shop","name":"South"}
# {"$class":"Wallet","number":"W-10","Shop":{"$key":["South"]}}
# {"$class":"Note","text":"x","$ext":"n1"}         ← $ext is the row's external key for references { "$ext": "n1" }
```
An error carries the code of the first problem; `err.detail.rows` is the first 100 violations (line number, code,
details), `err.detail.total` is how many there are in all, `err.detail.truncated` means the list is cut. A polymorphic
reference needs `$class`. `$tags` are the row's tags, `$owner` is its owner.

### 8. Access rules: granting a permission

A rule = a group (a `Resource` of category `ACCOUNT`) → an object (`API` — an endpoint, `READ`/`WRITE`/`DELETE` — rows
of a class with a condition) with `allow`/`deny` and a weight. One rule decides: the highest weight; on a tie, deny.
A tenant rule weight above 999 is cut down to 999. `db.acl.grant` and `db.acl.deny` write such rows themselves (weight
50 by default); they can be written by whoever has `WRITE` on them (here, the tenant itself, through the "may do
everything" rule).
<!-- run -->
```ts
// Olga's membership in the salon was created by up({ tenant }) with the role owner; we make her an employee with the role staff
await db.acl.roles(OLGA, ['staff'])
await db.acl.grant({ role: 'staff', api: 'shop.reports.*' })
await db.acl.deny({ role: 'staff', delete: 'Wallet' })      // weight 50 — stronger than "may do everything" (10)
// check on behalf of Olga (the service acts on her behalf in the salon)
const olga = await svc.as(OLGA, { tenant: SALON })
const canReport = await olga.acl.check('shop.reports.view')       // { allow: true, rule: { weight: 50, … }, code?, message? }
const canDelete = await olga.acl.checkData('Wallet', 'DELETE')    // { allow: false } | { allow: true, filter? }
```
- `grant`/`deny({ role, read | write | delete, api, weight })`: a target is a class (with descendants), `'*'` — all
  classes, a class with a condition `{ class: 'Wallet', owner: '$actor' }` or `{ class: 'Wallet', data: { … } }`;
  `api` is an endpoint mask; a list means several. A repeated call changes nothing, `grant` after `deny` for the same
  role and target replaces the denial; inside `db.begin()` it runs in that transaction; a wrong call gives
  `invalid_data` before writing.
- `db.acl.revoke({ role, … })` removes (the answer is the number removed). `db.acl.roles(account)` gives the roles in
  the current tenant (`null` — not a member), `db.acl.roles(account, ['staff'])` replaces them (the membership is a
  `member` row with the key `[User, Tenant]`, created if missing), `null` removes the membership. `db.acl.list()`
  gives the tenant's rules, its own and "may do everything".
- Directly with `Resource` and `rule` rows: group `{ categories: '{Staff}' }` (account categories) or
  `{ roles: '{staff}' }` (membership roles). A mask
  (`categories`, `roles`, `endpoint`, `class`) is **a string only**: the database rejects an array (`['staff']`), a
  number or `null` with `invalid_data`.
  Object condition: `{ class: 'Wallet', owner: '$actor' }`, `{ class: 'Wallet', data: { … } }`; a class mask includes
  descendants, `'{rule,Resource,member}'` means several classes. `deny` with `{ code, message }` is a custom endpoint
  refusal.
- The database recomputes access rights by itself.

### 9. Subscription and cache

<!-- run -->
```ts
const sub = db.watch({ from: 'start', classes: ['Wallet'] })  // from: 'now' (default) | 'start' | a cursor; pollMs; leaving classes — op 'delete'
const lagMs = await sub.lag()                                  // lag, ms
await db.Wallet(w).update({ balance: inc(1) }).rows()
let cursor = ''
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                                          // to resume: db.watch({ from: cursor })
  if (ev.id === w.id && ev.row.data.balance === 1) break      // break or sub.close() stops it
}
const shops = await db.Shop().cache({ ttl: 300 }).rows()      // result cache; reset by your own writes and by signals
db.cache.stats(); db.cache.clear()
```
Events arrive without losses or duplicates, under RLS; a cursor older than the `all` tier of the retention policy gives
`cursor_expired`. With `from: 'now'` the subscription sees only what was committed after it started.

### 10. As-of snapshot and history

<!-- run -->
```ts
const was = await db.Wallet(w).asOf('2026-10-01T00:00:00Z').first()   // as it was at that moment (an ISO string or a Date)
await db.Shop(shop).Wallet().asOf(new Date('2026-10-01')).rows()
const history = await db.Wallet(w).versions()                         // all versions; the deletion version has $deleted
await db.Wallet(w200).versions({ follow: true })                      // also across id changes (reclass, rekey)
await db.Wallet(w).diff()                                             // what changed: previous version → latest
await db.Wallet(w).blame()                                            // who, when and why (verb option reason) changed fields
```
`diff()` is an array of `DiffResult`: `{ id, class, from, to, changes }`; `from` and `to` are `{ rev, at, id? }`, `to`
also has `deleted?` (then `changes` is empty), `from: null` means the object did not exist then. A change, `DiffChange`,
is `{ path, kind: 'added' | 'removed' | 'changed', before?, after? }`. `blame()` is an array of `BlameResult`:
`{ id, class, rev, complete, fields }`; `fields` are the `BlameField` leaves in path order:
`{ path, rev, at, author, op, exact, agent?, reason?, id? }`. `path` is an array of segments: `['data', 'price']`;
empty `agent`, `reason`, `before`, `after` are omitted. The types come from `letopis`.
A class with `history: false` does not provide `versions`, `asOf`, `restore` or subscription events.

### 11. Import from 0.21

The 1.0 schema is installed in advance (`up()` without the demo seed); the connections are admin connections. The
source is the 0.21 tables (`Schema`, `Entity`, `Account`, `Credential`, `Resource`, `Rule`) in a `v1.<name>` schema of
any database. The repository has the fixture `lib/test/fixtures/v021.sql`, a dump of these tables with the marker
`<SCHEMA>`: replace the marker and run the file.
```ts
import postgres from 'postgres'; import { readFile } from 'node:fs/promises'
const sql = postgres(ADMIN)
await sql.unsafe((await readFile('lib/test/fixtures/v021.sql', 'utf8')).replaceAll('<SCHEMA>', 'v1.fixture'))
await up({ dsn: ADMIN, schema: 'imported' })                  // v2.imported
```
```sh
npx letopis import --from "$ADMIN" --from-schema v1.fixture --dsn "$ADMIN" --schema v2.imported \
  --tenant Import --keyless Service
```
- `--tenant <name>` — the tenant for the System data of 0.21; `--keyless <Class>` — a class whose data violates the
  key (without it, importing the fixture stops: two 0.21 objects give one 1.0 id); `--rename Old=New` — names taken by
  1.0 methods; `--update` — append new versions; `--commit-every N` — commit in portions; `--partition <name>` — the
  0.21 source partition (default `entity`).
- The report is JSON at the end of the output (before it come the progress lines `letopis.import: …`): `classes`,
  `notes`, `source`/`target` (objects, versions and live ones by class in 0.21 and 1.0), `tenants`, `accounts`,
  `credentials`, `resources`, `rules`, `objects`, `uuidFields`, `droppedFields`, `ownerLost`, `verify`, `ms`; the exit
  code is 1 if `verify` failed. Repeating the import adds what is missing, without duplicates.

### 12. Projectors

A projector builds rows of derived classes from the journal: summaries, cards, anything that may be computed with a
lag. A derived class is marked with `derivedBy: 'projector-name'`, and only this projector writes its rows. The
derived class itself (own or inherited) and its ancestors are created, edited and deleted only by an administrator:
`syncModels` on an admin connection holding a tenant session (`connect({ dsn: ADMIN, schema, token, allowBypassRls: true })`) or an
account with the System permission `letopis.projector`; for an application session it is `acl_denied`. Everyone whom
the rules give `READ` on a derived class sees its totals, even without permissions on the source rows.
```ts
const p = adm.projector('daily', { from: ['Payment'], into: ['DayTotal'], version: 1, withBefore: true,
  handle(changes, out) { /* out.inc, out.upsert, out.delete, await out.get: into classes, { tenant: c.tenant } */ } })
await p.run({ once: true })   // catch up with the journal; run() follows it until stop(); rebuild(), status(), close()
p.run().catch(report)         // run() without once needs a catch: after a projector error it stops
```
Only an admin connection (otherwise `admin_required`). A batch is one transaction, every change is applied exactly
once, there is one writer (`rebuild()` while another process writes a batch gives `projector_busy`). The first
start rebuilds the projection from the current state, in batches. `purge`, `trim` and `reset` come as changes with `rev` 1, so check `op` first.
Another `version` gives `rebuild_required`; a cursor older than the `all` tier gives `cursor_expired`
(`onExpired: 'rebuild'` rebuilds by itself, in batches); the tier is per tenant: if it has expired for some participants, only
they drop out. A tenant with a source with `history: false` drops out (`invalid_class`). `c.before` (with
`withBefore`) is the previous version of the same id or `null`: `null` for a creation, for the first version of a new
id after `reclass` and `rekey` (the tombstone of the former id subtracts the former data), during a rebuild and when
the previous version is a deletion (after `restore`) or lies outside the `from` family; `purge`, `trim` and `reset`
have no such field (`undefined`), so subtract `before` only after checking that it is truthy: `if (c.before)`. A class change that keeps the id (a class
without a key) and takes the row out of the `from` family comes as a deletion (`op` `delete`, `row` is the last
version in the family with `$deleted`). `handle` gets the changes of one tenant. An error of its data (the
database rejected its results, or `out` rejected its row or delta) rolls back only this tenant: it drops out
(`status().failed`: `{ id: { cursor, code, message } }`) until `rebuild({ tenant: id })` (`{ tenant, chunked: true }` — in batches while the tail goes on for all, an interrupted one is continued by any `run()`;
`status().rebuildingTenants`), and the others go on; with `onExpired: 'rebuild'` a tenant dropped by the tier rebuilds
itself in batches, in any process;
`tenants: [id, …]` is an explicit list of participants.
`status().state`: `'new'` means there is no projection yet, `'running'` means the projection is
built and kept up (not "a process is running now"), `'rebuilding'` means a batch rebuild is in progress or was
interrupted.
A daily total is a fold: subtract the previous version (`c.before`), add the new one (`c.row` unless it is `$deleted`)
with `out.inc('DayTotal', { day }, { total: ±amount }, { tenant: c.tenant })`; `DayTotal` has the key `['day']`,
`derivedBy: 'daily'` and `history: false`. Take the day from the data of the row, not from `at`: every edit changes the
version time. `out` itself folds the increments of one row by key into one edit per batch (as long as there is no
`upsert`, `delete` or `get` between them) and checks the class rule on their total. The full recipe is in
[the README, "Recipe: daily revenue"](README.en.md#recipe-daily-revenue).

### 13. Aggregates in the database

The database itself keeps a sum or a count of source rows — for totals that must match even for raw SQL:
```ts
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0) }, {
  key: ['number'], aggregate: { balance: { sum: 'amount', of: 'Payment', via: 'Wallet' } } })   // or count: true; where is a JSON Schema
await db.Wallet(w).Payment().create({ opId: 'op-9', amount: 500 }).rows()   // the balance grew by itself, no inc
```
A trigger recalculates the field after every statement (the library, raw SQL, a cascade, `restore`, `reclass`,
`rekey`, the loader); going below `minimum` is `invalid_data`, every change is a version of the target. Live rows of
the same tenant are counted (a System row is not). Repair: `adm.rebuildAggregates('Wallet')` on an admin connection;
discrepancies: `verify({ data: true })`. Only someone who reads all rows of the source and its descendants without
conditions can describe or change an aggregate, otherwise `acl_denied`. The source is described before the aggregate:
an aggregate over a class that does not exist yet is refused (`invalid_class`), and the `of` class is not deleted while an
aggregate names it; `syncModels` puts sources before targets itself. A hot counter (more than ~150 writes per
second per object) is a projector that folds a batch, not an aggregate.

### 14. Agents and MCP

MCP tools for an agent, under a user session (needs `npm i @modelcontextprotocol/server`):
```ts
import { createMcpServer } from 'letopis/mcp'
const server = await createMcpServer(await svc.as(userId))   // letopis_model, letopis_query, letopis_history; { write: true } adds letopis_write
// stdio: letopis mcp --dsn … --schema v2.x --token <user token> [--write]; HTTP: createMcpHandler(() => createMcpServer(…)) from the SDK
```
Only a user session or `svc.as(user)`: a connection that bypasses RLS gets `bypass_rls`, the service root without
`as()` and a session in the System tenant (without `allowSystemAdmin`) get `user_session_required`; `letopis_write`
does not write the permission classes without `allowAclWrite` (`acl_denied`); the command line does not accept
`--api-key` but also takes `--dsn`,
`--schema` and `--token` from `LETOPIS_DSN`, `LETOPIS_SCHEMA`, `LETOPIS_TOKEN`. Reading is a JSON chain
(`class`, `filter` with `$gt`, `$in`, `$or` and so on, `steps`, `sort: { field, dir: 'asc' | 'desc' }`, `cursor`),
with no SQL; an answer holds up to `maxRows` rows (100) and `maxBytes` bytes (50,000) from the `createMcpServer`
options, then comes a `cursor`. `structuredContent` is `{ notice, data }` (`notice` is a constant note that this is
data, not instructions); `data` by terminal: `rows` — `{ rows, count, more, cursor? }`, `ids` —
`{ ids, count, more, cursor? }` (`count` is the rows on the page), `first` — `{ row }`, `count` — `{ count }`,
`countBy` — `{ counts, truncated? }`, `sum`, `avg`, `min`, `max` —
`{ value }`. A refusal is `isError: true` with a `structuredContent` of the form `{ notice, error }` (`error` is
`{ code, message, detail?, sqlstate?, similar? }`). Writing only
with `write: true` (without it `letopis_write` is not in the list, and a call is an SDK protocol error): `update` with
`rev`; `delete` without `confirm` is a preview, with `confirm` a human confirms it (elicitation), and without that it
is `confirmation_required`. Data from the database in an answer sits inside `<untrusted-data-…>`.

### Operations

`db.verify({ data: true })` and `letopis verify` — hash chains, the anchor; `db.maintain()` and
`connect({ maintain: '1h' })` — sessions, codes, journal thinning; `db.trimHistory(target, moment)`;
`db.reset({ level, confirm, tenant })` — with `up({ allowReset: true })`; `db.describe()` /
`letopis describe --format text`. Close each connection once; connections from `svc.as()` share the pool with `svc`:
<!-- run -->
```ts
await adm.close(); await db.close(); await svc.close()
```

## Pitfalls in 1.0

1. **`create` with a taken key is the error `exists`** (`err.detail.id`), not an overwrite. To replace the whole
   object, use `upsert`, and only for a class with a key (otherwise `no_key`). For a partial edit, use `update`.
2. **`update` never creates.** If the step found nothing, the result is empty with no error, so check its length;
   without a filter and without `data.id`, all rows of the step are edited. `target_not_found` comes with `{ rev }` or
   if the row was deleted between the lookup and the edit.
3. **Verbs return a chain.** Without a terminal (`.rows()`, `.first()` …) nothing runs. `delete()` without
   `{ confirm: true }` is only a preview; `purge` works only on deleted entities (`not_deleted`) and once a projector
   of the class has read the deletion (`projector_pending`); `trimHistory`, once the projector has read the versions.
4. **Money and counters**: `update({ balance: inc(n) })` — the database adds inside the statement, without a read and
   without lost updates; the `minimum` check in the schema catches a drop below zero. For a total computed from what
   you read, use `{ rev }` (re-read and retry on `conflict`) or `forUpdate()` in `db.begin()`. Idempotency comes from
   an operation key (`[Wallet, opId]`): a repeat gives `exists`.
5. **`db.begin()` is `read committed`.** Two reads in one transaction can see different data. To lock what you read:
   `await tr.Wallet(w).forUpdate().first()` (only in `db.begin()`, otherwise `tx_required`; only with `rows`, `first`,
   `ids`, otherwise `lock_unsupported`). `tr.lock(...keys)` takes an advisory lock until the end of the transaction.
6. **An error breaks an explicit transaction.** After any error (including `exists` and `conflict`), every call and
   `commit()` throw the original error, and `commit()` rolls back in that case; `rollback()` succeeds. Pattern:
   `const tr = await db.begin(); try { …; await tr.commit() } catch (e) { await tr.rollback(); throw e }`.
   `db.begin()` has no retries: on `40P01`, repeat the whole block. Operations from the pool retry `40001`/`40P01`
   by themselves.
7. **`commit_unknown`** — the connection dropped during `COMMIT`: the transaction may have been committed. Do not
   retry blindly; repeat the same operation with the same key (`exists` means "already written").
8. **The loader, a projector and `rebuildAggregates` need an admin connection** (`allowBypassRls: true`, the owner
   role), otherwise `admin_required`; inside `db.begin()` they give `invalid_query`. A regular application uses the
   application role, without bypassing RLS.
9. **Data is under RLS.** Without a session (`token`/`apiKey`) a write gives `no_session`; a row of another tenant or
   an invisible row cannot be told apart from a missing one: the step does not find it, and a reference to it gives
   `target_not_found`; without a permission you get an empty result or `acl_denied`. `` db.sql`…` `` and raw SQL also run under the session and RLS.
10. **The key is immutable.** Editing a key field, the id, the tenant or the owner gives `immutable_key`; a new key is
    `rekey(patch)` (or `db.rekeyClass(class, key)`), and that is a new id. Changing the class is
    `reclass(class, data)`, not `update` (`use_reclass`). Deletion, `reclass` and `rekey` run only in
    `read committed` (`isolation_level`).
11. **Classes live in the session tenant.** `letopis sync` with a tenant's token writes the classes to that tenant;
    other tenants do not see them. Classes shared by all tenants live in System (the installation seed or an import).
12. **Do not pass the id of a class with a key**: it is computed (`db.idOf('Shop', { name: 'Center' })`); a different
    id gives `id_mismatch`, and an id for a class without a key gives `id_from_db`.
13. **Method names are reserved**: a class named `count`, `sort`, `set`, `run`, `account`, `sql`, `auth` … cannot be
    reached as a step (the list is `RESERVED_CLASS_NAMES`). The removed 0.21 API (`run()`, `account()`, `watch(cb)`,
    `reloadSchema()`, the facades `db.accounts` …) throws `removed` with the replacement — see
    [MIGRATION.md](MIGRATION.md) (in Russian).
14. **Access rules deny by default.** A new tenant without rules sees nothing; `up({ tenant })` and `createTenant`
    (`grantAll`) are the quick start. The `auth.*` permissions (passwords, sessions, impersonation) belong to the
    service and the system administrator.
15. **Errors:** `err.code` is a lowercase code (`exists`, `conflict`, `invalid_data` …), the text is
    `letopis: <code>: …`; data errors (`ValidationError`) have `err.issues: [{ path, keyword, message }]`.
16. **A subscription with `'now'` starts when the database answers.** `db.watch()` returns immediately, and the
    subscription takes the "now" moment with its first query to the database. A write made right after `db.watch()`
    can be committed earlier and miss the stream. If you need a guarantee — `await sub.ready()` before the write, a
    saved cursor or `'start'`. Parallel `next()` calls go in turn and get different events.
17. **The terminal returns the rows of the last step.** `…Payment().create(…).Wallet().update(…).rows()` returns the
    `Wallet` rows, not the created payment; if you need the payment, end the chain on it.
18. **A batch queue belongs to its facade.** `db.batch('x')` on the root, on each `await db.as(…)` and on each
    `db.begin()` are different queues; a plan runs on behalf of whoever queued it. Collect plans through one facade
    object.
19. **Only its projector writes the rows of a derived class.** The application, raw SQL and the loader get
    `derived_class`; ends may not refer to such rows either. To recompute them, use the projector's `rebuild()`.
20. **Only the database writes an aggregate field.** A value in `create`, `update`, `upsert`, `rekey`, `reclass` and raw
    SQL is `aggregate_field`; do not pass it. A raw upsert of a target: `set data = excluded.data - array['balance']`.
