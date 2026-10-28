# letopis 1.3

**letopis** is a Node.js library: a store of versioned entities on PostgreSQL 18. Every change is saved as a version
in a journal. So every object has a history, a state as of any date and a change subscription. The database itself
checks data integrity, tenant isolation and permissions, with triggers and RLS policies. The rules work the same for
the library and for raw SQL. Data is read and written with chains:
`db.Shop(shop).Product({ price: lt(1000) }).rows()`.

[Русская версия](README.md) · [Cheatsheet for AI agents](AGENT-CHEATSHEET.en.md) · [Migration from 0.21 (in Russian)](MIGRATION.md) · [Changelog (in Russian)](CHANGELOG.md) · [llms.txt](llms.txt)

What letopis can do:

- **Zod models** are stored in the database as classes: hubs (objects) and links (relations with their own data) — [section 4](#4-data-model).
- **Writing with chains**: `create`, `update` with merge, `upsert`, deletion with preview and cascade, the `inc` increment
  for money and counters — [sections 5](#5-writing), [7](#7-deleting-and-restoring) and [8](#8-transactions-batches-and-money).
- **Reading with chains**: hops along links, filters, trees, aggregates, pagination — [section 6](#6-reading).
- **History**: versions, point-in-time reads, what changed and who changed it (`diff`, `blame`), restoring deleted
  data, retention policy, hash chain verification — [section 11](#11-history-and-point-in-time-reads).
- **Tenants, sign-in and permissions** in the database itself: passwords, API keys, one-time codes, TOTP, sessions,
  impersonation, access rules — [section 10](#10-users-sign-in-and-permissions).
- **Change subscription** by cursor without losses, and a **result cache** — [section 12](#12-change-subscription-and-cache).
- **Derived data**: aggregates in the database, sums and counts that the database itself maintains, and projectors
  that build summaries from the journal — [sections 4](#aggregates-in-the-database) and [12](#projectors).
- **Agents and MCP**: an MCP server gives an AI agent the model, reads, history and, if allowed, writes, with the
  rights of one user — [section 13](#agents-and-mcp).
- **Bulk loading** of millions of rows and **import from 0.21** — [sections 9](#9-bulk-loading) and [14](#14-migrating-from-021).

Requirements:

- PostgreSQL 18 or newer with the pgcrypto extension (it is part of the standard distribution), and a database in UTF8
  encoding.
- Node.js 22 or newer; the package is an ES module.
- One runtime dependency: `postgres`. Zod 4 is an optional peer dependency: only the `letopis/model` subpath needs it,
  and `import { connect } from 'letopis'` works without it. For development without PostgreSQL there are the optional
  `@electric-sql/pglite` and `@electric-sql/pglite-socket`. The MCP server (`letopis/mcp` and `letopis mcp`) needs
  the optional `@modelcontextprotocol/server`, version 2.4 or newer in the 2.x line.

## Contents

1. [Quick start](#1-quick-start)
2. [How letopis works](#2-how-letopis-works)
3. [Installation and connection](#3-installation-and-connection)
4. [Data model](#4-data-model)
5. [Writing](#5-writing)
6. [Reading](#6-reading)
7. [Deleting and restoring](#7-deleting-and-restoring)
8. [Transactions, batches and money](#8-transactions-batches-and-money)
9. [Bulk loading](#9-bulk-loading)
10. [Users, sign-in and permissions](#10-users-sign-in-and-permissions)
11. [History and point-in-time reads](#11-history-and-point-in-time-reads)
12. [Change subscription and cache](#12-change-subscription-and-cache)
13. [Operations](#13-operations)
14. [Migrating from 0.21](#14-migrating-from-021)
15. [API reference](#15-api-reference)
16. [Errors](#16-errors)
17. [Performance](#17-performance)
18. [Limitations](#18-limitations)
19. [Tests](#19-tests)

Sections 3–13 are built on one example, a shop: installation, model, writing, reading and so on. The code blocks of
these sections go in order and together form one program. The `docs` test runs this program, like the quick start
example, against a real database, so the examples do not drift away from the code.

## 1. Quick start

You need PostgreSQL 18 and an admin role: a superuser or a role with the `CREATEROLE` privilege. Install the package:

```sh
npm install letopis zod postgres    # postgres: for createTenant and your own SQL queries
```

The application connects to the database with a separate role that is a member of `letopis_app`. The installation
creates `letopis_app`. So after the first installation, create the application role once:

```sql
create role shop_app login password 'app-secret';
grant letopis_app to shop_app;
```

The example installs the schema, creates a shop with its first user, describes two classes and works with them:

<!-- run: quickstart -->
```ts
import { up, connect, syncModels, inc, gte } from 'letopis'
import { hub } from 'letopis/model'
import { z } from 'zod'

const ADMIN = 'postgres://postgres:secret@localhost:5432/shop'    // admin: installs the schema
const APP = 'postgres://shop_app:app-secret@localhost:5432/shop'  // application: a member of letopis_app

// 1. Install the v2.shop schema. tenant is the first tenant (the shop) and its user Anna.
const r = await up({ dsn: ADMIN, schema: 'shop',
  tenant: { name: 'Chamomile', user: { name: 'Anna', login: 'anna@shop.ru', password: 'Chamomile-2026!' } } })
// r.serviceKey is the application's service key: it is issued on the first installation, so save it

// 2. The application service signs in with the key, checks Anna's password and works on her behalf in the shop.
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: r.serviceKey! })
const login = await svc.auth.verifyPassword({ identifier: 'anna@shop.ru', password: 'Chamomile-2026!' })
const db = await svc.as(login!.account, { tenant: r.tenant!.tenant })

// 3. Model: a shop and a product. syncModels writes the class descriptions to the database.
const Shop = hub('Shop', { name: z.string() }, { key: ['name'] })
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int().min(0) },
  { ends: { Shop }, key: ['Shop', 'sku'] })
await syncModels(db, [Shop, Product], { apply: true })

// 4. Writing and reading with chains.
const [shop] = await db.Shop().create({ name: 'Chamomile' }).rows()
const [kettle] = await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Tea kettle', price: 2500 }).rows()
await db.Product(kettle).update({ price: inc(-500) }).rows()      // discount: the database subtracts inside the statement
const expensive = await db.Shop(shop).Product({ price: gte(1000) }).rows()
const history = await db.Product(kettle).versions()               // two versions: creation and edit

await svc.close()
```

What happened here:

- `up()` installed the `v2.shop` schema in the database: three tables, triggers, RLS policies, functions and the
  system seed. The `tenant` option created the tenant "Chamomile" with the rule "authenticated users may do
  everything", and the user Anna with the `owner` role in it.
- `connect({ apiKey })` exchanged the service key for a session. `verifyPassword` returned `{ account, token }` (or
  `null` if the password is wrong). `svc.as(account, { tenant })` is the same connection pool, but acting as Anna in
  the shop; the database checks that the service has the right to do this.
- `hub('Product', fields, options)` described an object class. `ends: { Shop }` is a required reference to the shop.
  `key: ['Shop', 'sku']` is the key: the product id is computed from the shop and the SKU, and the database does not
  accept a second product with the same key.
- `db.Shop(shop).Product().create(…)` created a product and took the reference to the shop from the chain path.
  `inc(-500)` lowered the price inside the `UPDATE` statement, without reading it first. `versions()` read the history
  from the journal.

Calling `up()` again is safe: it re-applies the same revision and does not touch the data, and it does not issue the
service key again while the installation still has a valid API key. Next, section 2 explains the design, and sections
3–13 go through the tasks in order.

## 2. How letopis works

### Core concepts

| Concept | What it is |
|---|---|
| installation | a PostgreSQL schema `v2.<name>` with the letopis tables and functions; one database can hold several |
| class | a data type: name, fields (JSON Schema), ends and key. A class description is also a row in the database (class `Class`) |
| hub | an object class: a shop, a product, a customer |
| link | a relation class between objects, with its own data: an order line, a specialist's skill |
| end (role) | a reference from one row to another row. An end has a name, the role: `Shop`, `Parent`. Ends are in `row.links`, fields are in `row.data` |
| key | the fields and ends that identify an object within a class and a tenant. The id is computed from them, so uniqueness is the key |
| id | a version 5 UUID: a hash of the tenant, the class and the key values; for a class without a key, a hash of a random part |
| account | a user, a service or an organization: a row of class `Account` |
| tenant | the account whose data is being worked with. Data of different tenants is isolated |
| membership | a `member` link "user — tenant" with roles; it allows work in another tenant |
| session | a token by which the database identifies the account and the tenant. A service gets it with an API key, a user by signing in |
| version, journal | each change of a row is a version in the `log` journal, with author, time and hash |
| tombstone | a "deleted" version with the last snapshot of the object |
| chain | a query like `db.Shop(shop).Product().rows()`: steps, modifiers, write verbs and a terminal |
| terminal | a method that executes the chain: `rows`, `first`, `ids`, `count`, `paths`, aggregates |

### What is stored in the database

There are three tables. `entity` is the current state: one row per live entity, including the rows of system classes
(`Class`, `Account`, `Resource`, `member`, `rule`). `log` is the journal: a full snapshot of every version with author,
time, kind of operation and hash. `secret` holds credentials, sessions and projector checkpoints: the application sees
none of its rows; only the sign-in and projector functions work with it.

Classes are entities too. A class description is stored in a `Class` row; the database also keeps the expanded
description (with ancestors applied) and the compiled data check there. The version hash is a generated column: sha256 of the
previous version's hash and the row snapshot. So the next version exposes a tampered version, and for the last version
an anchor outside the database does this ([section 11](#11-history-and-point-in-time-reads)).

### Who checks the data

There are two roles. `letopis_owner` owns the schema, tables and functions. `letopis_app` is the application role: the
application's LOGIN role is a member of this role only. Everything the application runs, both the library and raw SQL,
goes through triggers and RLS.

- **Triggers.** On insert, a trigger computes the id, fills in defaults and checks the data against the class JSON
  Schema (the schema is compiled to jsonpath). It checks the ends and their targets, fills in the service columns and
  writes a version to the journal. An update merges the patch inside the statement (`merge`, `inc`). After a delete,
  the trigger applies the `restrict`, `cascade` and `unset` rules and writes tombstones.
- **RLS and permissions.** Policies isolate tenants and apply access rules. At the start of a query, the database
  builds the actor's permission plan once (`acl_plan()`); each row then needs only the cheap `acl_ok` check.
- **Query context** is the transaction settings: `letopis.token` (the session), `letopis.tenant` and `letopis.account`
  (the tenant and impersonation), `letopis.reason` (the reason for the change) and `letopis.acl` (the permission pass,
  see [section 10](#10-users-sign-in-and-permissions)). The database finds the session by the sha256 of the token, so
  without a real token the settings give nothing.
- **Bypassing the checks** is possible only for code that runs as the owner: owner functions (`security definer` with
  a fixed `search_path`) and the loader on an admin connection. `connect()` refuses a role that bypasses RLS (a
  superuser, `BYPASSRLS`, a member of `letopis_owner`) unless `allowBypassRls: true` is set.

### How reads work

Under RLS, the indexes on `data` and on back references are not directly available to the policy. So the ids for chain
steps are found by the owner functions `find_ids()`, `find_hop()` and `find_deep()`. They apply the same tenant and
permission conditions as the policy. The rows themselves are then read by primary key under RLS. A point-in-time read
is built from the journal.

### Signals

A write reports changes through `NOTIFY`. The channel is the full name of the installation schema, version included,
for example `v2.shop`; because of the dot, SQL takes the name in double quotes: `LISTEN "v2.shop"`. A raw SQL write on
its own connection sends the signal from a trigger, and PostgreSQL delivers it on commit. Library transactions,
`db.sql` and `db.transaction()` included, defer their signals: the process notifier sends them every 100 ms
(`notifyIntervalMs`) and retries the ones that failed to send. What a write signal carries (its payload) is set by the
installation mode `up({ signals })`:

| Mode | Write signal payload | What any role that can connect to the database sees |
|---|---|---|
| `class` (default) | the class name: `Booking` | class names and write times |
| `tenant` | `Class@tenant token`: `Booking@3f9c…` | also tenant pseudonyms |
| `opaque` | `class token@tenant token`: `9a1e…@3f9c…` | only write times and frequency per pseudonym |
| `none` | no signals | nothing |

A token is 24 hexadecimal characters of a keyed HMAC: only a process with the signal key can match a pseudonym to a
name, and the key is given to services (the `letopis.signals` permission). Besides write signals, there are service
ones: a revoked session sends `session:<16 hex>` (the first 16 hexadecimal characters of the sha256 of its token), a
session reset sends `session:*`, and a reset of a tenant or of the whole installation sends `*` (a reset of the whole
installation also sends `session:*`). In the `none` mode there are none of them either. Signals carry no ids and no
data. On signals, the class registry is re-read, the result cache is cleared and subscriptions wake up; what the mode
changes for the cache and subscriptions is in [section 12](#12-change-subscription-and-cache).

## 3. Installation and connection

### Installation: `up()`

`up()` waits for the database and creates it if it does not exist. It checks for PostgreSQL 18 and UTF8 encoding,
installs the roles `letopis_owner` and `letopis_app`, the pgcrypto extension and the `v2.<name>` schema with all
functions and the system seed. On the first installation, it issues a service key. Call it from an admin role.

| Option | What it does |
|---|---|
| `dsn` or `sql` | an admin connection string or a ready postgres.js pool |
| `schema` | the installation name: `'shop'` gives the schema `v2.shop`; you can also pass `'v2.shop'` directly |
| `tenant` | the first tenant and its user (see below) |
| `seeds` | seeds after the core: `'booking'` is the salon demo domain; or paths to your own `.sql` files |
| `history` | the history retention policy for classes without their own ([section 11](#11-history-and-point-in-time-reads)) |
| `serviceKey` | your own service key instead of a random one: `lts_` and 32–128 hexadecimal characters |
| `allowReset` | allow `db.reset()` ([section 13](#13-operations)); off by default |
| `signals` | the signal mode: `'class'` (default), `'tenant'`, `'opaque'` or `'none'` (["Signals"](#signals)); the mode is stored in the schema — `up()` without the option keeps it |
| `fresh` | drop the schema and install it again — **the schema data is lost** |
| `upgrade` | upgrade a schema of an older revision: migrations and a re-apply |
| `pglite` | a database for development without PostgreSQL (see below) |
| `quiet`, `waitTimeoutMs` | no console messages; how long to wait for the database (60,000 ms by default) |
| `owner`, `app` | the names of the owner and application roles (`letopis_owner`, `letopis_app` by default) |

Result: `schema` (the full name), `serviceKey` (on the first installation, and on a re-run when the installation has no
valid API key left; otherwise `null`), `created`, `upgraded`, `revision`, `migrations`, `analyzed`, `owner`, `app`,
`signals` (the signal mode of the installation), `warnings` (without `quiet` they are printed), and also `tenant` and
`pglite` if they were requested. On PostgreSQL below 18.2, `up()` warns: such a server could truncate CLOG that unread
signals still need — upgrade it.

To hide class names from signals, use the `opaque` mode (or `tenant` if the names are not secret but you want the
cache to be precise per tenant); after changing the mode, restart the application processes — they read the mode on
connect:

```ts
await up({ dsn: ADMIN, schema: 'shop', signals: 'opaque' })   // later up({ dsn, schema }) keeps the mode
```

<!-- run: guide -->
```ts
import { up, connect } from 'letopis'

const ADMIN = 'postgres://postgres:secret@localhost:5432/shop'
const APP = 'postgres://shop_app:app-secret@localhost:5432/shop'

const r = await up({ dsn: ADMIN, schema: 'shop',
  tenant: { name: 'Chamomile', user: { name: 'Anna', login: 'anna@shop.ru', password: 'Chamomile-2026!' } } })
const SHOP = r.tenant!.tenant      // the tenant: the Chamomile shop
const ANNA = r.tenant!.user!       // its first user
```

### Application role

The application works as a LOGIN role that is a member of `letopis_app` only:
`create role shop_app login password '…'; grant letopis_app to shop_app;`. Then RLS and triggers apply to it, as to
any raw SQL from this role. `connect()` rejects a role that bypasses RLS with the error `bypass_rls`. The admin
connection (`allowBypassRls: true`) is needed only for the loader, projectors, aggregate repair (`rebuildAggregates`),
verification and maintenance; keep it in a separate process, not in the web application.

### First tenant and user

Permissions in letopis are always on and deny everything by default. So a new tenant needs rules. The
`up({ tenant })` option and the `createTenant(sql, schema, opts)` function do this in one transaction:

- the tenant: an account in System with an id from the name (`tenant:<name>`);
- the rule "authenticated users may do everything" in this tenant (`grantAll`, on by default, weight 10);
- a user (id from the login) with a membership in the tenant with the roles `user.roles` (`['owner']` by default), a
  password and a session in the tenant.

A repeat with the same name and login duplicates nothing and does not change the password; it only issues a new
session. The login goes into the id as is: `Anna@shop.ru` and `anna@shop.ru` would give two accounts, and the second one
would have no password, so write logins in one case. The `created` field in the result tells whether this call created
the tenant: for an existing tenant with a new user it is `false`. The roles are set by `user.roles`, a non-empty list
of names (not masks), otherwise `invalid_data`. A repeat does not change the roles of an existing membership: they are
changed by editing the membership ([Granting a permission](#granting-a-permission)). A repeat does not bring back
what was deleted: if the tenant, the user account or the membership is deleted (the row is gone but its history is in
the journal), `createTenant` answers `invalid_data` and writes nothing. The error text names what was deleted and
advises bringing it back with `restore()`: an account with `db.Account(id).restore()` on behalf of the system
administrator, a membership with `db.member(id).restore()` in that tenant; the other way out is a different name or
login. The session from `createTenant` has no sign-in method, so the user cannot change their own password with it:
for that the user signs in with the password. `createTenant` needs an admin postgres.js pool:

<!-- run: guide -->
```ts
import postgres from 'postgres'
import { createTenant } from 'letopis'

const pg = postgres(ADMIN)
const lutik = await createTenant(pg, r.schema, {
  name: 'Buttercup', user: { name: 'Boris', login: 'boris@lutik.ru', password: 'Buttercup-2026!' } })
await pg.end()
const BORIS = lutik.user!          // lutik: { tenant, user, token, created: true }
```

### Connecting: `connect()`

A connection gets a session in one of two ways: with an API key (`apiKey`) or with a token (`token`). An application
service usually keeps one connection by key and acts on behalf of users through `as()`:

<!-- run: guide -->
```ts
// service: the API key is exchanged for a service session
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: r.serviceKey! })
// sign-in: the service checks the password and acts on behalf of the user in the tenant
const login = await svc.auth.verifyPassword({ identifier: 'anna@shop.ru', password: 'Chamomile-2026!' })
const db = await svc.as(login!.account, { tenant: SHOP })
// a separate connection by session token, for example in another process
const anna = await connect({ dsn: APP, schema: r.schema, token: r.tenant!.token! })
```

| `connect()` option | What it does |
|---|---|
| `dsn` or `sql` | a connection string or a ready postgres.js pool |
| `schema` | the full installation name: `'v2.shop'` (it is handy to take `r.schema`) |
| `token`, `apiKey` | a session token or an API key (`service` is a synonym of `apiKey`) |
| `models` | `letopis/model` models, only for chain types ([section 4](#4-data-model)) |
| `max` | pool size (10 by default) |
| `listen` | listen to database signals (yes by default; `false` for PgBouncer in transaction mode) |
| `cache` | result cache: `{ ttl, max, ttlOnly }` or `false` ([section 12](#12-change-subscription-and-cache)) |
| `maintain` | run `maintain()` on a schedule: `'1h'`, `'15m'` or milliseconds |
| `onQuery`, `slowMs` | a hook on every chain query and the slow query threshold |
| `refreshSession` | extend the session once per minute of activity (yes by default) |
| `notifyIntervalMs` | the interval for sending deferred signals (100 ms) |
| `allowBypassRls`, `owner` | allow a role that bypasses RLS (admin connection); the name of the owner role |

A connection has `db.schema`, `db.token`, `db.tenant` (the session tenant) and `db.close()`. Connections obtained
through `as()` share the pool with the original one: close the original one.

### Admin connection

The loader, projectors and `rebuildAggregates` need a connection of a role that can become the owner, with
`allowBypassRls: true`. `verify()` and
`maintain()` work on it too, and also for a system administrator on a regular connection. The admin connection prints
the warning "RLS не действует" ("RLS does not apply"); this is expected. The session sets the tenant it works with. A
separate loading process is better off with a service key:
`connect({ dsn: ADMIN, schema, apiKey, allowBypassRls: true })`, and the tenant of the rows is set by the
`load(…, { tenant })` option. The example uses the session from `up()`:

<!-- run: guide -->
```ts
const adm = await connect({ dsn: ADMIN, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true })
```

### Upgrading the package and schema

The schema has an engine revision (currently 6). If a new package version brings a new revision, `connect()` only warns
and names the command. It is `up()` that refuses: a lagging schema without `upgrade: true`, and a schema newer than the
package. So a startup script that calls `up()` on every start will stop after a package update until it gets
`upgrade: true`. `up({ dsn, schema, upgrade: true })` applies the migrations from `sql/migrate/` and re-applies the
functions; the data is kept.

The revision does not change with every version: 1.1–1.4 share one, while their functions differ. So `up()` also writes
an engine stamp into the schema comment: the package version and a hash of its SQL files. If the stamp does not match
the package files, `connect()` warns. When the schema was applied by an older version (or by a version before 1.4,
which has no stamp), it suggests `up({ schema })`. When a newer version has already upgraded the schema, it suggests
updating the package: `up()` from the older version would bring the old functions back. A new package version without
SQL changes keeps the stamp, and there is no warning.

The first `up()` after moving to 1.2 builds the journal index `log_class_tenant_at (class, tenant, at)` instead of
`log_class_at`: an `asOf` and `withDeleted` slice by class no longer reads the journal of other tenants with the same
class name. While the index is being built, writes to the journal wait. On a large installation, build it in advance
without stopping writes: `create index concurrently log_class_tenant_at on "v2.<schema>".log (class, tenant, at)` as
the owner role — then `up()` only drops the old one.

The `upgrade` test checks upgrading 1.1.0 and 1.0.1 schemas. The old package installs the schema and the old engine
writes the data, then the current version's `up()` runs. After it, the versions and hashes written by the old engine
are in place, `verify({ data: true })` is clean, and the schema catalog matches a clean installation. A 1.1.0 schema is
upgraded with a plain `up()`, since its revision is the same. A 1.0.1 schema is upgraded with `up({ upgrade: true })`.

### Development without PostgreSQL: PGlite

`up({ pglite: true })` starts PGlite (PostgreSQL 18 on WebAssembly) with pgcrypto and a socket on a free port. It needs
the `@electric-sql/pglite` and `@electric-sql/pglite-socket` packages. There is only one connection, so:

```ts
const dev = await up({ schema: 'dev', pglite: true })
const local = await connect({ dsn: dev.pglite!.dsn, schema: dev.schema, apiKey: dev.serviceKey!,
  listen: false, max: 1, allowBypassRls: true })
// … work …
await local.close()
await dev.pglite!.close()
```

The connection to PGlite is a superuser, so it needs `allowBypassRls: true`, and RLS does not apply on it: tenant
isolation and permissions cannot be checked on PGlite. It is not fit for race tests and CI either: there is one
connection and no `LISTEN`.

## 4. Data model

Classes are described with Zod models from the `letopis/model` subpath and written to the database. The database
stores a normalized JSON Schema and checks the data itself on every write.

### Hubs and links

`hub()` describes an object, `link()` describes a link with its own data. Both have two forms:

- short: `hub(name, fields, options)`: fields as an object of Zod types, options as the third argument;
- full: `hub(name, { fields, ends, key, extends, … })`: it is needed, for example, for inheritance (`extends`), so
  that TypeScript infers the data types of the descendant.

The shop model that the following examples are built on:

<!-- run: guide -->
```ts
import { z } from 'zod'
import { hub, link, one, many } from 'letopis/model'
import { syncModels } from 'letopis'

const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] })
const Category = hub('Category', { name: z.string() }, {
  key: ['name'],
  ends: { Parent: one('Category').optional().onDelete('unset') },   // tree: a reference to the parent
})
const Product = hub('Product', {
  sku: z.string(), title: z.string(), price: z.number().int().min(0), views: z.number().int().optional(),
}, {
  ends: { Shop, Category: many(Category, { max: 5, onDelete: 'unset' }) },
  key: ['Shop', 'sku'],
  meta: { title: 'Product', icon: 'mdi:package-variant' },
})
const Customer = hub('Customer', { name: z.string(), email: z.string() }, {})   // no key: the database assigns the id
const Vip = hub('Vip', { extends: Customer, fields: { discount: z.number().int().min(0).max(50) } })
const Order = hub('Order', {
  number: z.string(), status: z.enum(['new', 'paid', 'cancelled']).default('new'),
}, { ends: { Customer, Shop }, key: ['Shop', 'number'] })
const line = link('line', { qty: z.number().int().min(1), price: z.number().int().min(0) }, {
  ends: { Order: one(Order).onDelete('cascade'), Product },
  key: ['Order', 'Product'],
})
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) },
  { ends: { Customer }, key: ['number'] })
const Movement = link('Movement', {
  opId: z.string(), kind: z.enum(['topup', 'debit', 'adjust']), amount: z.number().int(), target: z.number().int().optional(),
}, { ends: { Wallet }, key: ['Wallet', 'opId'] })

const models = [Shop, Category, Product, Customer, Vip, Order, line, Wallet, Movement]
const plan = await syncModels(db, models)                     // dry run: what will be created and changed
const applied = await syncModels(db, models, { apply: true }) // { applied: true, created: ['Shop', …], … }
```

### Fields

Fields are Zod types: strings, numbers (`int`, `min`, `max`), booleans, enums (`z.enum`), dates and times
(`z.iso.date()`, `z.iso.datetime()`), nested objects of any depth, arrays and `z.record`. `.optional()` makes a field
optional. `.default(…)` sets a default that the database fills in on insert. The database stores the `.meta()`
annotations of a field (`title`, `description`, your own keys), but they do not affect data checks.

The `refine`, `superRefine` and `transform` rules cannot be expressed in JSON Schema, and the database does not run
them. `syncModels` returns them in `lost`: check such rules in the application. A description with a JSON Schema
keyword that the database does not know is rejected, so no rule is lost silently. `pattern` regexes are a limited
subset of regular expressions shared by Zod, the validator and the database.

### Ends

- `ends: { Shop }` is the same as `one(Shop)`: a single required end with the role `Shop`.
- `one(A, B)` is a union: the end accepts rows of several classes. `one('Category')` is a target by name: this is how
  a class refers to itself.
- `.optional()` makes the end optional.
- `many(X, { min, max, onDelete })` is a multiple end: a list of targets in one end.
- `.onDelete(…)` sets what happens when a target is deleted: `restrict` (the default: deleting the target is
  forbidden), `cascade` (delete this row too), `unset` (remove the reference; only for an optional single end and for a
  multiple end without `min`).

The database checks the targets: the target exists, belongs to the same tenant or to System, and is of the declared
class or its descendant. A role name points to one class across the whole schema. So the roles `User` and `Tenant`
(pointing to `Account`), `Group` and `Object` (pointing to `Resource`) are taken by system classes: your own end with
such a name is possible only with the same target. In a result row, a single end is the target id (`row.links.Shop`),
and a multiple end is a list of ids.

### Key and id

A key is made of required string fields and required single ends. Numbers, booleans, objects, optional fields and
multiple ends cannot be part of a key. The id of a class with a key is a version 5 UUID of the tenant, the class and
the key values. The values are taken as they are, without normalization: an email in a different case gives a
different id. Set the required format of a key field in the model, and the database will check it.

- You do not pass the id: the database computes it. A different id gives `id_mismatch`; an id for a class without a
  key gives `id_from_db`.
- `db.idOf(class, key)` computes the id in advance, for example `db.idOf('Shop', { name: 'Chamomile' })`.
- A class without a key (`Customer` above) gets an id from a random part; you can learn it from the write result.
- A key field cannot be changed by a regular update (`immutable_key`): a new key means a new id, and that is `rekey`
  ([section 5](#5-writing)).

If something other than the key must be unique, make it a separate class. For example, the email is the key of an
`Email` hub, and the link from a person to it has the key `['Email']`. It is better not to make personal data the key
of the person itself: an id from an email can be found by brute force, and it stays in references and in the journal.

### Inheritance and aliases

`extends`: the descendant gets the fields, ends and key of the ancestor. Its own field with the same name replaces the
ancestor's field entirely. `abstract: true`: the class never has its own rows. A chain step by class also returns the
rows of descendants: `db.Customer()` also finds `Vip`, and `.exact()` keeps only the class itself. `alias` is a second
name of the class for a chain step, for example a name in another language.

### Class settings

- `history: false`: no journal is kept for the class: no versions, no point-in-time reads, no restore and no
  subscription events. A retention policy is `history: { all: '1 day', daily: '3 months', … }`
  ([section 11](#11-history-and-point-in-time-reads)). Only someone with the `READ` and `DELETE` permissions without
  conditions on all rows of the class and its descendants may change `history` of an existing class: `maintain()` thins
  the journal by the policy, and `false` turns it off.
- `ownerDefault: 'actor'`: the owner of new rows is the user, not the tenant (the default is `'tenant'`). This is
  useful for the rule "everyone sees their own records".
- `cache: { ttl }`: reads of this class alone are cached without `.cache()` ([section 12](#12-change-subscription-and-cache)).
- `meta`: free-form metadata for the application: a title, an icon, a color, an order in a menu. Up to 64 KB,
  inherited key by key (`null` removes an inherited value), visible to anyone who has a session. For an end, use
  `.meta()`.
- `derivedBy: 'projector-name'`: a derived class: only this projector writes its rows ([Projectors](#projectors)).
  The name is lowercase Latin letters, digits and `_.:-` (the first character is a letter or a digit), up to 64
  characters. The option is inherited, and a descendant does not change it. The ends of a derived class are only
  `onDelete: 'cascade'` or `'unset'`: a derived row does not prevent deleting its target. Nothing refers to the rows
  of a derived class. The application, raw SQL and the loader do not write to such a class: writing, editing and
  deleting its rows gives `derived_class`. The derived class itself (own or inherited) is created, edited and deleted
  only by an administrator — an admin connection or an account with the System permission `letopis.projector`; for an
  application session it is `acl_denied` ([Projectors](#projectors)).
- `aggregate: { field: { sum | count, of, via, where } }`: an aggregate in the database: the database itself keeps
  the sum or count of source rows ([Aggregates in the database](#aggregates-in-the-database)).

### Aggregates in the database

An aggregate is a field that the database itself maintains: the sum of a field or the number of live rows of a
source class whose end leads to the row. It is needed where the total must match the source even for raw SQL: a
wallet balance, the number of order lines.

```ts
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0), deposits: z.number().int().optional() }, {
  key: ['number'],
  aggregate: {
    balance: { sum: 'amount', of: 'Movement', via: 'Wallet' },                                        // sum of movements
    deposits: { count: true, of: 'Movement', via: 'Wallet', where: { properties: { amount: { minimum: 1 } } } },  // number of top-ups
  },
})
const Movement = link('Movement', { amount: z.number().int() }, { ends: { Wallet } })
```

- `sum: 'field'` is the sum of a numeric field of the source, `count: true` is the number of rows. `of` is the source
  class (a name or a model) together with its descendants, `via` is its single end that leads to the target row.
  `where` is a JSON Schema over the source data: rows that do not pass it are not counted.
- Only live rows of the same tenant as the target are counted. A reference to a System row is not counted: a shared
  directory does not count the data of all tenants. An aggregate of a tenant class, including one inherited from a
  System class, counts only classes of its own tenant: a System class named `of` is not counted, while the tenant's
  own descendant of a System class is. An aggregate of a System class counts System classes and the classes of the
  target row's tenant.
- A trigger recalculates the field after every statement: writes by the library, raw SQL, a delete cascade,
  `restore`, `reclass`, `rekey`, the loader, account deletion. The operations of one statement add up to one increment
  of the target, and the class rule (`min(0)`) is checked on the total: an operation that would take the balance below
  zero is rejected with `invalid_data`. Every change of the target is its new version with the author and reason of
  the operation.
- Only the database writes the field. A value in `create`, `update`, `upsert`, `rekey`, `reclass` or raw SQL is an
  `aggregate_field` error. A new row gets the total of already existing sources, usually 0. Replacing the data as a
  whole without the field keeps the previous value. The loader does not write a passed value. No permission to write
  the target is needed: the permission to write the source is enough.
- The database checks the description (`invalid_class`): the field is in the schema, it is numeric and not part of the
  key; the `via` end is single and accepts the target class; the `sum` field is a number; aggregates do not form a
  cycle; the target and the source are not system or derived classes. A source class is described before the
  aggregate: an aggregate over a class that does not exist yet is refused. For a tenant class, the source is looked up
  among the tenant's classes. `syncModels` describes sources before targets itself. The `of` class is not deleted while
  an aggregate of a class of the same tenant names it: first the aggregate is removed from the target's description.
- Rows get into an aggregate only with the knowledge of someone who reads them all: the field also counts rows that
  the author cannot see. Only someone who reads all rows of the source and its descendants without conditions can
  describe or change an aggregate. Only someone who reads all rows of a class and its descendants without conditions,
  both before the change and after it, can make the class a source (a new descendant of a source, a `parent` change).
  Otherwise `acl_denied`.
- A new source is also checked against whoever described the aggregate: they too must read all rows of the class
  without conditions. The describer is the author of the version of the target's `Class` row from which the aggregate
  description became the current one. If they cannot read those rows, the class does not become a source
  (`acl_denied`) until someone who can read them describes the aggregate again. For an aggregate of a System class, the
  describer is checked against System classes, as at description time. A tenant class under a System aggregate is
  checked only for whoever creates it.
- The option is inherited, and a descendant replaces it as a whole. Adding or changing an aggregate is a tightening:
  writes to the target and to the sources wait while the field is recalculated for all rows.
- `db.rebuildAggregates(class)` recalculates the field from the current rows, for repair. A version is written only
  where the value has changed. `db.verify({ data: true })` shows discrepancies. It needs an admin connection.
- A raw `INSERT … ON CONFLICT DO UPDATE SET data = excluded.data` for a target is rejected: the insert trigger has
  already set the field in `excluded.data`. Write `excluded.data - array['balance']`, and the field stays as it was;
  the library's `upsert` does this itself.

### Writing the model to the database

`syncModels(db, models)` without `apply` is a dry run; with `{ apply: true }` it applies the changes. The result is
`{ applied, created, updated, unchanged, skipped, lost }`; `skipped` lists System classes, which only the installation
changes. `syncModels` touches only the classes passed to it and deletes nothing. Safe changes (a new optional field or
end, metadata, an alias) are applied at once. Anything else, including any change to the `anyOf` and `oneOf` conditions, is a
tightening: it checks all rows of the family; if some rows conflict with it, you get
`tightening_conflict` with a list. Classes are written to the session tenant, and other tenants do not see them.
Classes shared by everyone are in System: the installation seed or the import puts them there.

The same from the command line:

```sh
npx letopis sync ./models.js --dsn "$APP" --schema v2.shop --token "$TOKEN"            # dry run
npx letopis sync ./models.js --dsn "$APP" --schema v2.shop --token "$TOKEN" --apply    # apply
npx letopis types --dsn "$APP" --schema v2.shop --token "$TOKEN" --out types.ts       # class types from the database
```

### Chain types

`connect({ …, models })` gives types of steps, rows and filters from the models. The library still takes the class
descriptions from the database; only TypeScript needs the models. The row data type is `Infer<typeof Product>`, the
ends type is `InferLinks<typeof Product>`. Your own `meta` shape is typed by extending the `ClassMeta` interface.

### Class names

A chain step is named after a class, its alias or a role name. The Proxy parses the names of chain and root methods
(`count`, `sort`, `set`, `sql`, `auth` and others) before classes. So a class with such a name cannot be reached as a
step, and the database does not accept a link with such a name. The full list is in the
["Reserved names"](#reserved-names) section.

## 5. Writing

The write verbs — `create`, `update`, `upsert`, `delete`, `anonymize`, `reclass`, `rekey`, `restore`, `purge` — are
parts of a plan. A verb does nothing by itself: a terminal (`rows`, `first`, `ids`, `count`) executes the plan, and the
whole plan is one transaction.

### Create: `create`

<!-- run: guide -->
```ts
import { LetopisError } from 'letopis'

const [shop] = await db.Shop().create({ name: 'Chamomile', city: 'Kazan' }).rows()
const [tea] = await db.Category().create({ name: 'Tea' }).rows()
const [green] = await db.Category().create({ name: 'Green tea' }).Parent.set(tea).rows()
const [kettle] = await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Tea kettle', price: 2500 }).rows()
const [sencha] = await db.Shop(shop).Product()
  .create({ sku: 'T-7', title: 'Sencha', price: 900 }).Category.add(green).rows()
const [olga] = await db.Customer().create({ name: 'Olga', email: 'olga@mail.ru' }).rows()

try {
  await db.Shop().create({ name: 'Chamomile' }).rows()
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'exists') throw e   // e.detail.id === shop.id: this shop already exists
}
```

- `create` only creates. A taken key gives the error `exists` with `detail.id`: the library computes the id itself. So
  for a class with a key, a retry after a network failure shows at once that the first attempt went through. A class
  without a key has no such protection: a retry creates a second object.
- The tags of a new row are set by `.tags([…])` before the verb, the owner by `.owner(id)`; an explicit owner must be
  allowed by the permissions.
- A deleted object can be created again with the same key: its history continues.
- The result is the rows of the created objects with all columns ([section 15](#15-api-reference), "Result row").

### Update: `update`

<!-- run: guide -->
```ts
import { gte } from 'letopis'

await db.Product(kettle).update({ title: 'Glass tea kettle' }).rows()
await db.Shop(shop).Product({ price: gte(2000) }).update({ title: 'Glass tea kettle, 1 L' }).rows()
```

`update` edits every target of the step and never creates. The patch is merged with the data inside the statement:
nested objects are merged recursively, while arrays, scalars and `null` are replaced. So concurrent edits of different
fields are not lost. If the step has no filter of its own, the target is taken from `data.id` of the patch, and without
`data.id` all entities of the step are edited: `db.Product().update(…)` edits all products of the tenant. If the step
found nothing, the result is empty and there is no error, so check the length of the result. If `update` affected fewer
rows than the step found, the whole plan is rolled back: a row deleted in the meantime gives `target_not_found`, and a
row that is visible but may not be edited gives `acl_denied`. The `.tags(…)` modifier before `update` both selects the
rows and replaces their tags entirely.

### Create or replace: `upsert`

<!-- run: guide -->
```ts
const [kept] = await db.Shop().upsert({ name: 'Chamomile', city: 'Kazan' }).rows()    // kept.$upsert: 'unchanged'
const [moved] = await db.Shop().upsert({ name: 'Chamomile', city: 'Ufa' }).rows()     // moved.$upsert: 'updated'
```

`upsert` creates an object, and if an object with this key already exists, it replaces its data, ends and tags
entirely. This is one `INSERT … ON CONFLICT` statement, so the race "checked that it does not exist, then created it"
cannot happen. Rules:

- only for a class with a key, otherwise `no_key` without a call to the database;
- the object is passed whole: fields that are not in the passed object disappear;
- the result carries `$upsert`: `created`, `updated` or `unchanged`;
- `upsert` cannot increment and overwrites concurrent increments, so it is not suitable for money;
- to sync large reference tables, the loader with `existing: 'update'` is cheaper ([section 9](#9-bulk-loading)).

### Ends: from the path and slots

The ends of a created row are taken from the chain path: `db.Shop(shop).Product().create(…)` references `shop`. If
several roles fit, the role whose slot is free is chosen, then the role named after the step class; otherwise you get
`invalid_query`. A slot after the verb sets an end explicitly: `.RoleName.set(value)` and `.RoleName.unset()`, and for
a multiple end also `.add()` and `.remove()`. The value is an id, a list of ids, a result row or a nested chain. Slots
change `links` atomically, without reading the list:

<!-- run: guide -->
```ts
await db.Product(sencha).update({}).Category.add(tea).rows()      // one more category
await db.Product(sencha).update({}).Category.remove(tea).rows()
await db.Category(green).update({}).Parent.unset().rows()         // the category is now a root
await db.Category(green).update({}).Parent.set(tea).rows()        // and inside "Tea" again
```

### Numbers and counters: `inc`

<!-- run: guide -->
```ts
import { inc } from 'letopis'

await db.Product(kettle).update({ price: inc(-500) }).rows()               // the price went down by 500
await db.Product(kettle).update({ views: inc(1, { start: 0 }) }).rows()    // the field does not exist yet: start from 0
```

`inc(n)` adds the amount inside the `UPDATE` statement, over the fresh locked row. So concurrent increments are not
lost, and a class rule like `min(0)` is checked against the result: going below zero is rejected with `invalid_data`,
without reads or locks in the application. Rules:

- only in `update`; a marker in `create`, `upsert`, the loader or inside an array gives `invalid_data` before sending;
- the field must already be a number; if it is missing, you get `invalid_data`, or `start` is used. `null` and a
  non-number are an error even with `start`;
- the path goes only through existing objects;
- an `inc` marker cannot come from JSON: `{ "$inc": 5 }` that came from the network stays data;
- store money as an integer number of minor units (cents), no greater than 2^53 − 1.

A counter that must match the source even for raw SQL is easier to keep as an aggregate
([Aggregates in the database](#aggregates-in-the-database)): the database recalculates it itself, and you cannot forget
an `inc`. An aggregate and `inc` cost the same: operations on one object go one after another under the lock of its
row, and each writes its version. On the benchmark machine, one object took 150–190 operations per second this way, no
matter how many writers were waiting for it ([section 17](#17-performance)). For hotter counters, use a projector that
folds a batch ([Projectors](#projectors)): the total lags behind the source, but writers do not wait for each other.

### Protection against concurrent edits: `{ rev }`

<!-- run: guide -->
```ts
const cur = await db.Product(kettle).first()
await db.Product(kettle).update({ price: 1900 }, { rev: cur!.rev }).rows()       // the version matched: written
try {
  await db.Product(kettle).update({ price: 1800 }, { rev: cur!.rev }).rows()     // the version is already different
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e          // re-read and decide again
}
```

The strict mode is needed when the new value is computed from what was read: if the row was changed in the meantime,
you get `conflict`, and nothing is written. The mode works when the step has one target (otherwise `rev_ambiguous`).
The library does not retry `conflict` by itself: the application decides what to do with the changed data. Another way
is a read with a `forUpdate()` lock ([section 8](#8-transactions-batches-and-money)).

### Changing the key or class

<!-- run: guide -->
```ts
const [mug] = await db.Shop(shop).Product().create({ sku: 'M-1', title: 'Mug', price: 400 }).rows()
const [mug2] = await db.Product(mug).rekey({ sku: 'M-100' }).rows()     // new key, new id; references moved
const [vip] = await db.Customer(olga).reclass('Vip', { name: 'Olga', email: 'olga@mail.ru', discount: 10 }).rows()
```

- `rekey(patch)` sets a new key value: a row with a new id, all references moved, the old row deleted. If a referencing
  row includes this end in its own key, its id changes too, and the move goes on. The journal links the old and the new
  id (`moved`).
- `db.rekeyClass(class, key)` sets a new key for all rows of the family, in one transaction. For a derived class and
  for a class with a derived descendant — `derived_class`: only its projector writes the rows of a derived class.
- `reclass(class, data)` changes the class; the data is optional, and if given, it is given whole. The row leaves its
  previous class, so it needs the `DELETE` permission on it, and `WRITE` on the new class and on every row whose
  references the move rewrites, at any depth. If the new class has no key, the id is kept (as for `vip` above); if
  it has one, the id is computed anew and the references are moved.
  The roles of referencing rows must accept the new class, otherwise `reclass_denied`. A raw `UPDATE … SET class`
  passes only if neither the old nor the new class has a key (otherwise `use_reclass`).
- Deleting, changing the class and changing the key work only in `read committed`: library transactions always open at
  this level.

### Anonymize: `anonymize`

<!-- run: guide -->
```ts
await db.Customer(olga).anonymize(['email']).rows()     // email → '[erased]', tag anonymized
```

`anonymize(fields)` overwrites string fields with a new version and marks the row with the `anonymized` tag. The
earlier versions stay in the journal. For complete erasure, the next steps are history trimming
([section 11](#11-history-and-point-in-time-reads)), then deletion and `purge` ([section 7](#7-deleting-and-restoring)).

### How a plan runs

One plan can create several related objects. The chain after a verb continues from the verb's result: after `create`
and `upsert`, from the created row; after other verbs, from all rows.

<!-- run: guide -->
```ts
const [l1] = await db.Customer(olga).Order()
  .create({ number: 'A-1' }).Shop.set(shop)          // order: Customer from the path, Shop via a slot
  .line().create({ qty: 2, price: 2000 }).Product.set(kettle)   // order line: Order from the path
  .rows()                                            // rows of the last step: the order line
const order = l1.links.Order as string
await db.Order(order).line().create({ qty: 1, price: 900 }).Product.set(sencha).rows()
```

- The whole plan is one `read committed` transaction. On a deadlock (`40P01`), a serialization failure (`40001`) and a
  journal conflict, the library retries the whole plan, up to three times.
- An error in any part rolls back the whole plan. `exists` and `conflict` are not retried: they are answers for the
  application.
- Modifiers before a verb (`limit`, `sort`) narrow its targets.
- A verb right after a verb writes to the same entities.

## 6. Reading

### Steps and hops

A chain starts with a class: `db.Shop()` is all shops, `db.Shop(shop)` is one shop. The next step is a class, an alias
or an end role. A hop goes along ends: a role step goes along its own end; other steps go along the ends of all classes
of both families. From an object to the rows that reference it, the hop goes backward; to the target of a reference,
forward; to the same class, to the children.

<!-- run: guide -->
```ts
const products = await db.Shop(shop).Product().rows()          // products of the shop: backward along the Shop end
const shopOf = await db.Product(kettle).Shop().first()         // the shop of the product: forward
const inOrder = await db.Order(order).line().Product().rows()  // products of the order: hub → link → hub
const parent = await db.Category(green).Parent().first()       // role step: the parent category
const allCustomers = await db.Customer().rows()                // together with descendants (Vip)
const onlyCustomer = await db.Customer().exact().rows()        // only the class itself
```

### Filters

A step filter is an id, a list of ids, a result row, an object of fields or `or(…)`. An object of fields can have any
depth. A plain value means equality through containment in `data`, without type casting: `{ price: 900 }` will not find
a record with the price `"900"`. A list as a field value means "the array contains all the elements". Operators cast
their value to the field type from the JSON Schema. An end role in a filter takes a target id or `null`.

<!-- run: guide -->
```ts
import { lt, ilike, between, or, not } from 'letopis'

const cheap = await db.Product({ price: lt(1000) }).rows()
const teaCount = await db.Product({ title: ilike('%tea%'), price: between(500, 3000) }).count()
const twoIds = await db.Product(or({ sku: 'K-1' }, { sku: 'T-7' })).ids()
const active = await db.Order({ status: not('cancelled') }).rows()
const ofShop = await db.Product({ Shop: shop.id }).rows()
const roots = await db.Category({ Parent: null }).rows()       // root categories
```

| Operator | Condition |
|---|---|
| `ne(v)`, `gt(v)`, `gte(v)`, `lt(v)`, `lte(v)` | ≠ (taking `null` into account), >, ≥, <, ≤ |
| `between(a, b)`, `inList([…])` | a ≤ x ≤ b; a value from the list |
| `like(s)`, `ilike(s)`, `starts(s)`, `ends(s)` | a pattern with `%` and `_`; case-insensitive; starts with; ends with |
| `has(v)`, `hasAny([…])`, `hasAll([…])` | an array field contains the value; at least one; all |
| `exists(true \| false)`, `isNull()` | the field is present or not; the field is `null` or missing |
| `not(v)` | negation of an operator; for a scalar, "not equal" |
| `or(f1, f2, …)` | any of the step filters |

Tags and the row owner are filtered with the `.tags(…)` and `.owner(…)` modifiers.

### Terminals and the result row

| Terminal | What it returns |
|---|---|
| `rows()` | the rows of the entities of the last step, without duplicates |
| `first()` | the first row or `null` |
| `ids()` | the ids of the entities of the last step |
| `count()` | the number of entities of the last step; `count({ paths: true })` is the number of paths |
| `paths()` | paths: `[{ Step: Row, … }]`, a node for each step |
| `versions()` | all versions of the entities of the last step ([section 11](#11-history-and-point-in-time-reads)) |
| `sum`, `avg`, `min`, `max`, `countBy` | aggregates over the field `'data.<path>'`; on an empty set, `null`, and `{}` for `countBy` |

Result row: `id`, `class`, `rev` (version number), `tenant`, `owner`, `links` (ends), `data` (fields), `tags`, `at`
(version time), `author`, `op` (kind of operation) and, if present, `agent`, `reason`, `moved`. Service fields start
with `$`: `$deleted`, `$depth`, `$upsert`, `$action`, `$versions`, `$purged`.

### Sorting and pagination

<!-- run: guide -->
```ts
import { cursorOf } from 'letopis'

const page1 = await db.Product().sort('data.price', 'desc').limit(2).rows()
const page2 = await db.Product().sort('data.price', 'desc')
  .after(cursorOf(page1.at(-1)!, 'data.price')).limit(2).rows()   // strictly after the last row of the page
```

`sort(field, 'asc' | 'desc')` sorts by `'at'`, `'rev'`, `'id'` or `'data.<path>'`. `after(cursorOf(row, field))` is
pagination "after this row"; it requires `sort()`. Such pagination withstands inserts and deletes between pages, but a
row whose sort field has changed may drop out or repeat. A cursor is an object `{ v, id }` (the field value and the row
id): it survives JSON, so you can hand it to a client. The field in `cursorOf` must match the `sort` field. The cursor
value is checked against the type of the `sort` field before the query, and a wrong one is `invalid_query`: a numeric
field needs a finite number, `rev` an integer, a boolean field `true` or `false`, a text field a string, uuid fields
and `id` a uuid, time fields and `at` an ISO string with a time zone, a date field `YYYY-MM-DD`, a field without a
description a string, a number or `true`/`false`. `null` fits only data fields, and the cursor's `id` is always a uuid.
The check cannot tell apart a cursor of the same type taken from another field. `limit` and `offset` are available
too.

A data field may be `null` or missing. `sort` places such rows the way `order by` in PostgreSQL does: last when
ascending, first when descending, and `after()` treats `null` as a value after all others (ascending) or before them
(descending). So pages go through such rows without gaps or repeats, and a cursor with the value `null` gives the next
page.

### Trees: `deep`

<!-- run: guide -->
```ts
const subtree = await db.Category(tea).Category().deep().rows()   // subcategories of any depth; $depth is the level
```

`deep(max)` repeats the hop to the same class up to the depth `max` (32 levels by default). The filter, tags and owner
of the step select nodes at any level but do not cut the traversal. Only a node invisible by permissions cuts it: such a
node also hides its subtree.

### Aggregates

<!-- run: guide -->
```ts
const total = await db.Order(order).line().sum('data.price')       // sum of the order lines
const avgPrice = await db.Shop(shop).Product().avg('data.price')
const byStatus = await db.Order().countBy('data.status')          // { new: 1 }
```

The database computes aggregates over the entities of the last step. `limit(n)` and `offset(n)` before `countBy()`
apply to the groups: `db.Order().limit(3).countBy('data.status')` gives the three most frequent values.

### Paths

<!-- run: guide -->
```ts
const orderPaths = await db.Order(order).line().Product().paths()   // [{ Order: Row, line: Row, Product: Row }, …]
```

`paths()` returns the nodes of every variant of the path; the key of a node is the step name or the name from
`.alias(name)`. Repeating a link in the chain returns to its node: this way you can go from one link in several
directions. `db.entity(row | chain)` inserts a ready node into the path.

## 7. Deleting and restoring

### Preview and deletion

<!-- run: guide -->
```ts
const preview = await db.Order(order).delete().rows()     // deletes nothing: the order and its lines, $action of each
await db.Order(order).delete({ confirm: true }).rows()    // deleted: tombstones with $deleted: true

const blockers = (await db.Shop(shop).delete().rows()).filter((x) => x.$action === 'restrict')
try {
  await db.Shop(shop).delete({ confirm: true }).rows()   // products block the shop: the Shop end is restrict
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'delete_restricted') throw e
}
```

`delete()` without `{ confirm: true }` is only a preview: the whole cascade closure. Every preview row has `$action`
(`delete`, `unset` or `restrict`) and `$depth`, the cascade level (0 is the target itself; `unset` and `restrict` rows
do not have it). With the confirmation, all targets of the step are deleted in one statement, and the cascade applies
the rules of the ends. The preview does not take permissions into account: a row with `$action: 'delete'` may fail to
be deleted for a user without the permission (`acl_denied`), so a user interface should ask
`acl.checkData(class, 'DELETE')`. The rules of the ends:

- `restrict`: deletion is forbidden while the target is referenced (`delete_restricted` with a list of the visible rows
  and the number of the others);
- `cascade`: the referencing rows are deleted together with the target (the order lines above);
- `unset`: the reference is removed.

The cascade requires delete permission on every deleted row, and removing a reference requires write permission. A raw
`DELETE … WHERE id IN (…)` of any set of related rows works the same way.

### Restore: `restore`

<!-- run: guide -->
```ts
await db.Order(order).restore().rows()                       // the order, from its last snapshot, with the same id
await db.Order(order).line().withDeleted().restore().rows()  // and its lines deleted by the cascade
```

`restore()` brings back the last snapshot of a deleted object as a new version and checks it again against the current
class description. Only the targets of the step are restored, not the whole cascade. A live object gives `not_deleted`.

### Erase history: `purge`

<!-- run: guide -->
```ts
const [temp] = await db.Customer().create({ name: 'Test', email: 'test@example.com' }).rows()
await db.Customer(temp).delete({ confirm: true }).rows()
const before = await db.Customer(temp).purge().rows()          // preview: $versions is how many versions the journal has
await db.Customer(temp).purge({ confirm: true }).rows()        // history erased; the journal has a purge record
```

`purge` works only for deleted objects (a live one gives `not_deleted`) and erases their whole history; in place of
version 1, a `purge` record stays with the number of erased versions. The history of system classes is not erased.
While a projector whose `from` sources include the class of the object ([“Projectors”](#projectors)) has not read
the deletion, `purge` refuses (`projector_pending`): the projector would never see an erased tombstone, and the
object's contribution would stay in the totals. So a deletion and a `purge` in one transaction do not go through in
such a class. Likewise, `db.trimHistory` refuses while the projector has not read the first remaining version: it
would no longer find the previous version for `before`. To delete an account, use `db.auth.purgeAccount` ([section 10](#10-users-sign-in-and-permissions)).

## 8. Transactions, batches and money

### Every operation is a transaction

Every chain terminal is its own `read committed` transaction, whatever the default level in the database is. At this
level, increments and the cascade see fresh rows. The library retries deadlocks, serialization failures and journal
conflicts by itself. If the connection drops during `COMMIT`, it does not retry and throws `commit_unknown`: the
transaction may have committed. A repeat of the same operation with the same key finds out the outcome: `exists` means
"already written".

### Explicit transaction: `db.begin()`

<!-- run: guide -->
```ts
const tr = await db.begin()
try {
  const [o2] = await tr.Customer(olga).Order().create({ number: 'A-2' }).Shop.set(shop).rows()
  await tr.Order(o2).line().create({ qty: 1, price: 2000 }).Product.set(kettle).rows()
  await tr.commit()
} catch (e) {
  await tr.rollback()
  throw e
}
```

- Inside, you have the same chains, `db.sql`, `forUpdate()`, `lock()`, `commit()` and `rollback()`.
- An error in any query breaks the transaction: every next call and `commit()` throw the original error, and `commit()`
  rolls back. `rollback()` goes through. If the error was caught inside `tr.transaction(fn)` and the library does not
  know about it, PostgreSQL silently answers `ROLLBACK` to `COMMIT`, and the library turns this into the
  `tx_rolled_back` error.
- There are no retries inside `db.begin()`: on `40P01`, repeat the whole block.
- `lock(...keys)` is an advisory lock until the end of the transaction. It protects only if everyone who edits this data
  takes it.

### Batch

<!-- run: guide -->
```ts
const b = db.batch('storefront')
b.Shop(shop).Product().create({ sku: 'C-1', title: 'Cup', price: 300 })
b.Shop(shop).Product().create({ sku: 'C-2', title: 'Saucer', price: 200 })
const results = await b.run()       // Row[][]: an array of rows for each plan, in one transaction
```

A batch collects plans, and `run()` executes them in one transaction. Consecutive simple `create` and `upsert` calls of
a class with a key are merged into one multi-row statement. `b.size()` is the number of queued plans, `b.discard()`
clears the queue. A terminal on a queued plan gives `invalid_query`: only `run()` executes. The name is the key of a
queue of the facade: the root connection, each `db.as()` and each `db.begin()` have their own queues. A plan runs on
behalf of the facade that queued it (actor, tenant, owner, transaction), and `run()` never executes plans of other
facades. Collect plans through one and the same facade object.

### Recipe: wallet

The balance is the `balance` field of the `Wallet` hub (integer cents, `min(0)`); operations are the `Movement` link
with the key `[Wallet, opId]` ([section 4](#4-data-model)). An operation is never edited or deleted; it is cancelled by
a reverse operation with a new `opId`. The key makes an operation idempotent: a repeat after a lost response gets
`exists`, and the recipe checks whether it is the same request.

<!-- run: guide -->
```ts
import { inc, type Db } from 'letopis'

type Kind = 'topup' | 'debit' | 'adjust'

/** Operation: write a Movement and increment the balance — one plan, one transaction. */
async function operate(db: Db, wallet: string, opId: string, kind: 'topup' | 'debit', amount: number) {
  try {
    await db.Wallet(wallet).Movement().create({ opId, kind, amount })
      .Wallet().update({ balance: inc(kind === 'topup' ? amount : -amount) }).rows()
    return 'done'
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'exists') return same(db, wallet, opId, kind, amount)   // repeat
    throw e                                        // invalid_data: not enough funds (min(0))
  }
}

/** Repeat fingerprint: is the request already written under this opId the same request? */
async function same(db: Db, wallet: string, opId: string, kind: Kind, value: number) {
  const m = await db.Movement(db.idOf('Movement', { Wallet: wallet, opId })).first()
  if (!m || m.data.kind !== kind || (kind === 'adjust' ? m.data.target : m.data.amount) !== value)
    throw new Error(`operation key ${opId} is already used by another request`)
  return 'repeat'
}

/** Adjustment "balance = target": an adjust operation for the difference, the total under { rev }. */
async function adjust(db: Db, wallet: string, opId: string, target: number) {
  for (;;) {
    if (await db.Movement(db.idOf('Movement', { Wallet: wallet, opId })).first()) return same(db, wallet, opId, 'adjust', target)
    const cur = (await db.Wallet(wallet).first())!
    try {
      await db.Wallet(wallet).Movement().create({ opId, kind: 'adjust', amount: target - (cur.data.balance as number), target })
        .Wallet().update({ balance: target }, { rev: cur.rev }).rows()
      return 'done'
    } catch (e) {
      if (e instanceof LetopisError && e.code === 'conflict') continue     // the wallet changed: re-read
      if (e instanceof LetopisError && e.code === 'exists') return same(db, wallet, opId, 'adjust', target)
      throw e
    }
  }
}

const [wallet] = await db.Customer(olga).Wallet().create({ number: 'W-1' }).rows()
await operate(db, wallet.id, 'op-1', 'topup', 10_000)    // 'done': balance 10,000
await operate(db, wallet.id, 'op-1', 'topup', 10_000)    // 'repeat': a repeat after a lost response, the balance is the same
await operate(db, wallet.id, 'op-2', 'debit', 3_000)     // balance 7,000
await adjust(db, wallet.id, 'op-3', 5_000)               // adjustment: adjust by −2,000, balance 5,000
```

The same result can be written under a locking read, without retries on `conflict`:

<!-- run: guide -->
```ts
const [wallet2] = await db.Customer(olga).Wallet().create({ number: 'W-2' }).rows()
const tx = await db.begin()
try {
  const w = (await tx.Wallet(wallet2).forUpdate().first())!     // the wallet row is locked until commit
  await tx.Wallet(wallet2).Movement()
    .create({ opId: 'op-1', kind: 'adjust', amount: 6_000 - (w.data.balance as number), target: 6_000 })
    .Wallet().update({ balance: 6_000 }).rows()
  await tx.commit()
} catch (e) {
  await tx.rollback()
  throw e
}
```

- `inc` adds inside the statement, over the locked row: concurrent debits are not lost, and `min(0)` rejects a debit
  beyond the balance.
- A plain `update({ balance: 700 })` writes the value; it does not add. A total computed from what was read, without
  `{ rev }` or `forUpdate()`, loses concurrent debits. An advisory `lock()` does not help if not all writers take it.
  `upsert` overwrites increments.
- `forUpdate()` works only inside `db.begin()` (otherwise `tx_required`) and only with `rows`, `first`, `ids`
  (otherwise `lock_unsupported`). Rows are locked in id order; a row that no longer matches the conditions of the step
  is not included in the result.
- Choose one path for one wallet: under `{ rev }` and under `forUpdate()`, the wallet and the operation key are locked
  in a different order, and mixing the two in concurrent requests gives `40P01`. Inside a block with `forUpdate()`, do
  not wait for external calls: all writers wait for the wallet (`lock_timeout` and
  `idle_in_transaction_session_timeout` help here).
- A transfer is two operations in one `db.begin()`, with the wallets edited in id order: then there are no deadlocks.
- Insufficient funds are told apart from other data errors by `e.issues`: the field `balance`, the rule `minimum`.

### Recipe: balance as an aggregate

The same wallet, but the database itself keeps the balance: `balance` is an aggregate, the sum of `amount` over the
live operations ([Aggregates in the database](#aggregates-in-the-database)). An operation is one `Movement` record;
there is no `inc` increment in the code, so it cannot be forgotten. The balance stays correct even when raw SQL or the
loader writes the operations and a cascade deletes them.

```ts
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0) }, {
  ends: { Customer }, key: ['number'],
  aggregate: { balance: { sum: 'amount', of: 'Movement', via: 'Wallet' } },   // the balance is the sum of live operations
})
const Movement = link('Movement', { opId: z.string(), amount: z.number().int() },
  { ends: { Wallet }, key: ['Wallet', 'opId'] })                             // the operation key gives idempotency

/** Operation: an amount above zero tops up, below zero debits; the database recalculates the balance in the same transaction. */
async function operate(db: Db, wallet: string, opId: string, amount: number) {
  try {
    await db.Wallet(wallet).Movement().create({ opId, amount }).rows()
    return 'done'
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'exists') return 'repeat'   // a repeat after a lost response
    throw e                                        // invalid_data: the balance would go below zero (min(0))
  }
}

/** Adjustment "balance = target": an operation for the difference, with the wallet locked until commit. */
async function adjust(db: Db, wallet: string, opId: string, target: number) {
  const tx = await db.begin()
  try {
    const w = (await tx.Wallet(wallet).forUpdate().first())!
    await tx.Wallet(wallet).Movement().create({ opId, amount: target - (w.data.balance as number) }).rows()
    await tx.commit()
    return 'done'
  } catch (e) {
    await tx.rollback()
    if (e instanceof LetopisError && e.code === 'exists') return 'repeat'   // an adjustment with this opId is already written
    throw e
  }
}

const [wallet] = await db.Customer(olga).Wallet().create({ number: 'W-1' }).rows()   // balance is 0: the database sets it
await operate(db, wallet.id, 'op-1', 10_000)    // balance 10,000
await operate(db, wallet.id, 'op-2', -3_000)    // balance 7,000
await adjust(db, wallet.id, 'op-3', 5_000)      // an operation of −2,000, balance 5,000
```

- The model here is its own, and the block is not part of the example program: there the balance grows through `inc`,
  and an aggregate field does not change that way.
- `balance` is passed neither to `create` nor to `update` (`aggregate_field`), so an adjustment is an operation too,
  not an `update` under `{ rev }`. Writing an operation needs no permission to write the wallet: the permission to
  write `Movement` is enough.
- Insufficient funds are `invalid_data`, as with `inc`: `e.issues` holds the field `balance` and the rule `minimum`.
  Check a repeat as `same()` in the recipe above does: `exists` only says that an operation with this `opId` already
  exists.
- Editing and deleting an operation change the balance too: the database subtracts the previous value. It is still
  better to cancel an operation with a reverse one, so that the history of the wallet stays complete.
- Every operation locks the wallet row and writes its version, so the operations of one wallet go one after another,
  as with `inc`: about 150 per second on the benchmark machine ([section 17](#17-performance)). If one object gets
  more, compute the total with a projector instead ([Recipe: daily revenue](#recipe-daily-revenue)).

## 9. Bulk loading

### When you need the loader

The loader is the path for import, seeding and syncing large reference tables. It checks rows in the library code
with the same validator as the database, and writes them with the `COPY` command as the owner role, without triggers
and RLS. In the benchmark, this is about 6,400 rows per second against 130 for row-by-row `create`
([section 17](#17-performance)). It works only on an admin connection (`allowBypassRls` and the right to become the
owner), otherwise you get `admin_required`.

### `db.load()`

<!-- run: guide -->
```ts
const rep = await adm.load({
  Shop: [{ name: 'Cornflower', city: 'Perm' }],
  Product: [
    { sku: 'V-1', title: 'Mug', price: 450, Shop: { $key: ['Cornflower'] } },
    { sku: 'V-2', title: 'Spoon', price: 150, Shop: { $key: ['Cornflower'] }, $tags: ['new'] },
  ],
  Customer: [{ name: 'Petr', email: 'petr@mail.ru', $ext: 'crm:1001' }],
})
// rep: { rows: 4, loaded: 4, updated: 0, skipped: 0, duplicates: 0, byClass: { Shop: 1, Product: 2, Customer: 1 }, … }
```

- The input is an object "class → rows", an array, or a stream of rows with a `$class` field.
- A row has its fields and end roles at the top level. Service keys: `$class` is the class of the row, `$ext` is an
  external key of a class without a key (loading the same file again gives the same ids), `$tags` are the tags,
  `$owner` is the owner.
- A reference is a target id, a key `{ $key: [...] }` or an external key `{ $ext: '…' }`; for a polymorphic end, add
  the `$class` of the target. The order of rows and classes does not matter, and circular references are allowed.
- Keys that start with `$` inside the data are ordinary data.
- Rows go to the session tenant (or to `tenant`). A load is one transaction: an error in any row cancels everything.
  Subscriptions see the rows after the commit.

### Repeats and existing objects

<!-- run: guide -->
```ts
const again = await adm.load({ Shop: [{ name: 'Cornflower', city: 'Perm' }] }, { existing: 'skip' })       // skipped: 1
const changed = await adm.load({ Shop: [{ name: 'Cornflower', city: 'Samara' }] }, { existing: 'update' }) // updated: 1
```

| Option | Values |
|---|---|
| `duplicates`: a repeated id within the load | `'error'` (default): cancel; `'first'` or `'last'`: keep the first or the last row |
| `existing`: the object already exists in the database | `'error'` (default): cancel; `'skip'`: skip, do not resurrect deleted objects; `'update'`: a new version if the content differs (unchanged objects are counted in `skipped`), deleted objects are created again |

### Portions, history and verification

- `commitEvery: N` commits in portions of about N rows. Portions go by class in dependency order; the classes of one
  cycle go in one portion. An error cancels only the current portion, and a repeat with `existing: 'skip'` writes the
  rest.
- `withHistory: true`: the rows are versions with `$rev`, `$at` and `$op`; this is how the import carries history over.
- `verify: true`: at the end, check the loaded rows again with the database check.
- `batch` (rows per `COPY` batch, 10,000), `class` (the class of rows without `$class`), `tenant`, `agent` (the agent of
  the versions).

### Loading on behalf of a user

<!-- run: guide -->
```ts
await adm.load({ Category: [{ name: 'Tableware' }] }, { as: ANNA, tenant: SHOP })
```

With `as`, the user becomes the author of the versions, and the loader checks the same things as the database does on a
regular write: the tenant is available to the user, write permission on each class, the permission conditions on rows,
the visibility of reference targets, the owner per `ownerDefault`. Without `tenant`, the rows go to the user's own
tenant. This is how a loading process can accept files sent by users.

### Initial load

```ts
const r = await adm.load(rows, { initial: true })   // empty schema: one transaction, indexes and triggers at the end
```

`db.load(rows, { initial: true })` (`letopis load --initial`) loads data into an empty schema faster than the regular
loader — about 2.2 times on a million objects: everything goes in one transaction, the tables are closed for reading and
writing during the load, indexes, constraints and triggers are dropped and rebuilt at the end, and rows are written with
`COPY … FREEZE`. Empty means that the schema has nothing besides the rows of system classes (class descriptions,
accounts, memberships, resources, rules) and `reset` records; otherwise you get `not_empty` before any change. The mode
is incompatible with `commitEvery`, `existing` (other than `'error'`) and `{ as }`; an error in any row rolls
everything back, indexes and triggers included. `letopis import --initial` runs the whole import this way: in one
transaction, without `--update` and `--commit-every`. WAL is written here too (it is skipped only with
`wal_level = minimal`), but the indexes are built once, so there is almost three times less of it; after `FREEZE`, the
first read and the first vacuum do not rewrite the table.

### Command line

```sh
npx letopis load shops.ndjson products.ndjson --dsn "$ADMIN" --schema v2.shop --token "$TOKEN" \
  [--class Product] [--duplicates first] [--existing skip] [--commit-every 100000] [--verify]
# shops.ndjson:    {"$class":"Shop","name":"South"}
# products.ndjson: {"$class":"Product","sku":"Y-1","title":"Vase","price":800,"Shop":{"$key":["South"]}}
```

NDJSON files have one object per line; all files form one load.

### Report and errors

Report: `rows`, `loaded`, `updated`, `skipped`, `duplicates`, `byClass`, `external` (how many targets outside the load
were checked by a query at the end), `portions`, `ms`. An error is a `LetopisError` with the code of the first
problem. Its `detail`: `rows` is the first 100 violations with the row number, code and details (`line`, `code`,
`message`, `id`, `class`, `issues`), `total` is how many violations were found, `truncated` means the list is cut,
`limit` is the list limit (100), `complete` means the checks that found violations went through all rows. Row codes:
the codes of the database checks, and also `duplicate` (a repeated id), `exists` (the object already exists), `deleted`
(an object with this id existed before) and `class_not_loadable` (the loader does not accept `Class` rows: classes are
set by `syncModels`). The loader rejects rows of derived classes and references to them with the code
`derived_class`: only a projector writes such rows.

Violations are searched for in stages: parsing the rows (classes, ids, repeats), permissions on classes
(`load({ as })`), data and ends in batches, and at the end of a portion the targets outside the load, owners and the
tenant. The load is cancelled after the first stage that found violations, and `total` counts the violations of that
stage. A target outside the load is one violation per target (the row is the first one that references it).
"(и ещё N)" ("and N more") in the error text is the exact number of the remaining violations. If not all rows were
checked, `complete` is `false`, and the text says "(и ещё не меньше N: причины)" ("at least N more: reasons") or, if
one violation was found, "(возможно, не единственная: причины)" ("possibly not the only one: reasons"). The reasons:
the following `commitEvery` portions were not checked; the ACL conditions of the following batches were not checked
(`load({ as })`); the database check (`verify: true`) names at most 100 rows.

## 10. Users, sign-in and permissions

### Accounts, tenants and memberships

An account is a row of class `Account` in System: a name, categories (`User`, `Service` and your own) and an `enabled`
flag. Every account is its own tenant. A `member` membership allows work in another tenant: it is a link from a user
(`User`) to a tenant (`Tenant`) with roles in its data. Accounts and their categories are edited by the system
administrator, a member of System with the `admin` role. There is no separate method to appoint one: a membership in
System with the `admin` role is put in place by your own installation seed or by the loader on an admin connection (a
`member` row with `tenant: <System id>`). New users of a tenant are easy to create with `createTenant`
([section 3](#3-installation-and-connection)).

### Service and API keys

A service is an account of category `Service` with an API key. `up()` issues the installation key. The service checks
passwords and codes, issues sessions and acts on behalf of users. It issues and revokes the keys of regular users
itself (the `auth.credential` permission), as for Boris below. The service also issues and revokes its own API keys
and "key + secret" pairs itself, with a session opened by its own key (`connect({ apiKey })`, `verifyApiKey`,
`verifyKeySecret`). Its other credentials and the keys of other services, of System and of system administrators are
issued and revoked only by a system administrator; a new service key is also registered by `up({ serviceKey })`.

There can be several keys. A session opened by a key remembers it, and revoking a key revokes only its sessions:
connections by other keys keep working. So rotation goes without downtime: the service issues itself a new key
(`issueApiKey({ account: <service id> })`), moves its processes to it and revokes the old one (`revokeCredential(id)`).
The revocation keeps the current session; `keepCurrent: false` revokes it too. The last active key of a service
cannot be revoked: `acl_denied` "последний действующий ключ сервиса не отзывается: сначала выпустите новый" ("the
last active key of a service is not revoked: issue a new one first"). To disable a service, set `enabled: false` on
its account.

<!-- run: guide -->
```ts
const { key, id: keyId } = await svc.auth.issueApiKey({ account: BORIS, name: 'integration' })   // the key is returned only once
const viaKey = await svc.auth.verifyApiKey(key)                    // { account, token } | null
await svc.auth.revokeCredential(keyId)
```

A "key + secret" pair: `issueKeySecret({ account, name })` and `verifyKeySecret(key, secret)`.

### Passwords

<!-- run: guide -->
```ts
await svc.auth.setPassword({ account: BORIS, identifier: 'boris@lutik.ru', password: 'New-password-2026', confirmed: true })
const failed = await svc.auth.verifyPassword({ identifier: 'boris@lutik.ru', password: 'Buttercup-2026!' })   // null: the password was changed
```

- A password is stored as a scrypt hash; the service checks it, and the response time for a nonexistent login is
  equalized.
- The identifier is compared case-insensitively: `Anna@Shop.ru` and `anna@shop.ru` are one login.
- A password change revokes the other sessions of the account (`keepCurrent` keeps the current one).
- By default, sign-in works only by a confirmed credential, otherwise `null`; `requireConfirmed: false` also lets in by
  an unconfirmed one. The service confirms a credential: `confirmed: true` in `setPassword` or `setFlags`.
- The second factor is the `totp` option: `verifyPassword({ identifier, password, totp })` checks the account's TOTP
  code after a correct password and issues a session with the methods `[kind, 'TOTP']`, `['PASSWORD', 'TOTP']` by
  default (see below). Without `totp`, sign-in does not check the code: the service decides whether to require the
  second factor.

### One-time codes and TOTP

<!-- run: guide -->
```ts
import { totpCode } from 'letopis'

const { code } = await svc.auth.issueOtp({ account: BORIS, identifier: 'boris@lutik.ru', ttl: 300 })   // the service sends the code by email
const byCode = await svc.auth.verifyOtp({ identifier: 'boris@lutik.ru', code })                        // { account, token } | null
const { secret, uri } = await svc.auth.enrollTotp({ account: BORIS, issuer: 'Buttercup' })          // uri is for a QR code
const totpOk = await svc.auth.verifyTotp({ account: BORIS, code: totpCode(secret) })                // the first check enables the factor
```

A code is single-use: a successful check and brute force (5 attempts by default) burn it. The attempt counters are
rolled back together with the caller's transaction, so the service limits the rate of attempts. A repeat of the same
TOTP step is rejected. `totpCode(secret)` is a helper for tests and services.

Sign-in with the second factor is `verifyPassword({ …, totp })` and `lookup({ …, totp })`. The code is checked only
after a correct password or a found identity, by the same check as `verifyTotp`: the `auth.totp` permission is needed,
the window is one step each way, and the failure counter is shared (five in a row close the check for 5 minutes). A
correct code gives a session with the methods `[kind, 'TOTP']` and enables a not yet confirmed factor; a wrong or
repeated code, like a code for an account without TOTP, gives `null`. With such a session, a user with TOTP changes
their own credentials for 10 minutes.

### External identities

`link({ account, kind, identifier, confirmed })` links an external identity (Telegram, Google, SSO): the service checks
its token, and the database stores the binding. `lookup({ kind, identifier })` signs in with it (with the `totp`
option, also by a TOTP code, like `verifyPassword`):

<!-- run: guide -->
```ts
await svc.auth.link({ account: BORIS, kind: 'TELEGRAM', identifier: '100500', confirmed: true })
const viaTelegram = await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '100500' })   // { account, token } | null
```

A user can link their own credentials only after a recent sign-in (10 minutes; an API key, a "key + secret" pair and a
session from a service do not count), and cannot confirm them. With TOTP enabled, the database requires a session that
has passed TOTP: `verifyPassword` and `lookup` with the `totp` option issue one. If the identifier is taken, linking
answers with the same `acl_denied` as without a recent sign-in. But a user with a recent sign-in can tell from such a
denial that the identifier is taken ([section 18](#18-limitations)).

### Sessions

<!-- run: guide -->
```ts
const shortToken = await svc.auth.sessionFor(BORIS, { ttl: 600 })   // a session for 10 minutes of idle time for another process
const boris = await connect({ dsn: APP, schema: r.schema, token: shortToken })
await boris.auth.revoke()                                            // sign-out: the session is revoked
await boris.close()
```

A token is 256 random bits; the database stores only its sha256. The default lifetime is 7 days. `refresh()` extends
the current session: the new lifetime is counted from the current moment, but it is not longer than the lifetime issued
at sign-in; it returns the new expiration time. `connect()` extends the session itself once per minute of work
(`refreshSession`), so a session in use does not expire: the lifetime is the idle time. `revoke()` signs out,
`revokeAll()` signs out everywhere. Sessions are revoked when the account is disabled, the password is changed, a credential is deleted or the
account is deleted. Deleting a credential revokes the other sessions of the account, while revoking an API key or a
"key + secret" pair revokes only the sessions opened by that key (and old sessions of the same sign-in method without
a key mark); the current session stays unless you pass `keepCurrent: false`.

### Working in another tenant

A service acts on behalf of a user through `svc.as(account, { tenant, owner })`. The database checks the service's
`auth.impersonate` permission (by System rules), that the user exists and is enabled, and that the tenant is available
to the user, either their own or through membership. You cannot act on behalf of System, services, system
administrators or disabled accounts. The user's visibility under the access rules is not checked. In the journal,
`author` is the user and `agent` is the service. A user's connection by their own token switches between tenants like
this:

<!-- run: guide -->
```ts
const mine = await anna.auth.tenants()     // [{ tenant, roles }]: her own tenant and the shop via membership
await anna.auth.switch(SHOP)               // the session tenant is now the shop
```

### Permissions

Permissions are always on and deny by default. A rule connects a group with an object:

- **group**: a `Resource` row of category `ACCOUNT`: accounts by category (`{ categories: '{User}' }`) or members by
  membership role (`{ roles: '{staff}' }`);
- **object**: a `Resource` row of category `API` (an endpoint by mask, `{ endpoint: 'shop.reports.*' }`), or of
  category `READ`, `WRITE`, `DELETE` (the rows of a class by mask, with descendants, `{ class: 'Product' }`, and a
  condition on the columns `id`, `owner`, `tenant`, `tags`, `data`, `links` with the values `$actor` and `$tenant`);
- **rule**: a `rule` link group → object: `permission` (`allow` or `deny`) and `weight`.

Exactly one rule decides: the highest weight; at equal weight, deny beats allow. A tenant rule weight above 999 is
cut down to 999, so System rules with a weight of 1000 or more are an administrative layer that a tenant cannot
outweigh. Tenant rules apply to the tenant's rows, System rules apply everywhere. Permissions apply to raw SQL too: rows
without permission are invisible, and an edit changes nothing or fails with `acl_denied`.

A class mask in a `READ`, `WRITE` or `DELETE` object matches the descendants of the class too, by the names of the
ancestors and their aliases. So an edit of a class that changes `parent`, `alias` or `derivedBy` needs the `READ`,
`WRITE` and `DELETE` permissions without conditions on all rows of the class and of each of its descendants,
otherwise `acl_denied`: the `WRITE` permission on `Class` alone is not enough to put the rows of a class under other
rules. An alias does not match the name of another class (including `Class` and the system ones) or another class's
alias in the tenant and System, and the name of a new class does not match another class's alias: otherwise a rule
written for one class would act on the rows of another too. A violation gives `invalid_class`.

By the same names, the rules also find the old versions of rows in the journal. So a class is deleted only when it has
no rows, no descendants and no history of rows: `purge()` erases the history of deleted rows first. For a System class,
the rows, descendants and history of a tenant that has its own class with the same name do not count: they belong to
that tenant's class. A class deleted with history before is created again only with the same `parent`, `alias`,
`derivedBy` and `history` — otherwise `invalid_class`: the old versions of its rows would fall under other rules or a
different thinning. The rules also find old versions by the aliases of ancestors. So while deleted descendants of a
class keep row history, the class does not change its alias (`invalid_class`), and once deleted it is created again
only with the same description. If the journal holds rows of a class with this name but not its tombstone (for
example, rows of a System class deleted in 1.1), a class with this name is not created until `purge()` erases the
history.

A derived class (`derivedBy`) is created, edited and deleted only by an administrator: an admin connection or an
account with the System permission `letopis.projector` (the system administrator has it through the `letopis.*`
mask). The projector writes totals over all source rows of the tenant into such a class, without read permissions,
so a user who created it on their own would read totals over rows they may not read. A class that has derived
descendants is also edited only by an administrator: editing an ancestor changes the description of the descendant
(fields, key, `history`). The database itself sets the `aggregatedBy` mark (the class became an aggregate source) on a
derived class too: it does not change its fields or key.

### Granting a permission

Example: Oleg is a shop employee with the `staff` role, and employees may not delete products.

<!-- run: guide -->
```ts
const pg2 = postgres(ADMIN)
const OLEG = (await createTenant(pg2, r.schema, {          // the same shop: only the user is created
  name: 'Chamomile', user: { name: 'Oleg', login: 'oleg@shop.ru', password: 'Oleg-2026!' } })).user!
await pg2.end()
await db.member(db.idOf('member', { User: OLEG, Tenant: SHOP })).update({ roles: ['staff'] }).rows()

const [staff] = await db.Resource().create({ alias: 'staff:ACCOUNT', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows()
const [delProduct] = await db.Resource().create({ alias: 'product:DELETE', category: 'DELETE', pattern: { class: 'Product' } }).rows()
await db.rule().create({ permission: 'deny', weight: 50 }).Group.set(staff).Object.set(delProduct).rows()   // stronger than "may do everything" (10)
const [reports] = await db.Resource().create({ alias: 'reports:API', category: 'API', pattern: { endpoint: 'shop.reports.*' } }).rows()
await db.rule().create({ permission: 'allow', weight: 50 }).Group.set(staff).Object.set(reports).rows()

const asOleg = await svc.as(OLEG, { tenant: SHOP })
const canDelete = await asOleg.acl.checkData('Product', 'DELETE')   // { allow: false }
const canRead = await asOleg.acl.checkData('Product', 'READ')       // { allow: true }
const canReport = await asOleg.acl.check('shop.reports.daily')      // { allow: true, rule: { weight: 50, … } }
```

- `acl.check(endpoint)` → `{ allow, rule, code, message }`: the `code` and `message` fields of the denying rule set the
  endpoint's own denial.
- `acl.checkData(class, 'READ' | 'WRITE' | 'DELETE')` → `{ allow, filter }`: `filter` is the condition on rows.
- The database recomputes permissions by itself. To remove a permission, delete the rule:
  `db.rule(id).delete({ confirm: true })`.
- The library takes the actor's signed permission plan — the permission pass — from the database once and passes it
  in every transaction, so a permission check costs tens of microseconds. Raw SQL without the pass pays 0.3–1.3 ms per
  query.
- The question "who had access at a given date" is answered by an `asOf` read over the classes `rule`, `member` and
  `Resource`.

Fields of the system permission classes:

- `member`: the ends `User` and `Tenant`, the field `roles` (a list of roles);
- `Resource`: `alias` (the unique name of the resource and its key; this is not a class alias), `category` (`ACCOUNT`,
  `API`, `READ`, `WRITE`, `DELETE`) and `pattern`, the mask. A group's mask is `categories` or `roles`, and only a
  string: `'{staff}'`, `'{a,b}'`, negation `'!{a}'`. An object's mask is `endpoint` or `class` (also strings only) plus
  conditions on the columns. **The database rejects a non-string mask (for example, the array `['staff']`, a number or
  `null`)** with `invalid_data`, whether written by the library, raw SQL or the loader. Old rows with such a mask
  (written before this check or around it) grant no permissions, while a denial by them applies to everyone: by a
  group, to all accounts, by a `class` mask, to all classes (a non-string `endpoint` mask, as before, matches no
  endpoint). The write check comes with the description of the `Resource` class: it arrives with a fresh installation
  and after `reset({ all })`; in an existing schema, the corrected matching works after `up()` is run again;
- `rule`: the ends `Group` and `Object` (`Resource` rows), the fields `permission` (`allow` or `deny`), `weight`, and,
  for the endpoint's own denial, `code` and `message`.

### Deleting an account

`db.auth.purgeAccount(account)` deletes an account and the data of its tenant. The system administrator or the owner of
its tenant can call it; you cannot delete yourself or the last owner of a tenant. Ownership of rows in other tenants
passes to those tenants, sessions are revoked, credentials are deleted.

## 11. History and point-in-time reads

### Versions

<!-- run: guide -->
```ts
const versions = await db.Product(kettle).versions()              // all versions: op, rev, author, at, data
const followed = await db.Product(mug2).versions({ follow: true }) // also across id changes (rekey, reclass)
```

Every version has an author, an agent, a time, a number, a kind of operation (`create`, `update`, `delete`, `reclass`,
`rekey`, `restore`, `purge`, `trim`, `reset`) and a reason (`reason`). The reason comes from the `reason` option of a verb
(`update(patch, { reason })`, `create(data, { reason })`, `delete({ confirm, reason })` and others); for every
operation of a block, from `db.begin({ reason })` and `db.batch(name, { reason })`; in raw SQL, from the
`letopis.reason` setting of the transaction. A deletion version has `$deleted`.

Without `sort()`, versions go by id and version number (with `follow`, by time). `sort()` sets the order of versions
too, and `limit()` limits them in the query itself: `db.Product(kettle).sort('at', 'desc').limit(5).versions()` gives
the five latest versions, newest first.

### Point-in-time read

<!-- run: guide -->
```ts
const createdAt = versions[0].at
const atCreation = await db.Product(kettle).asOf(createdAt).first()  // the price at creation time: 2500
const assortment = await db.Shop(shop).Product().asOf(createdAt).rows()
```

`asOf(moment)` is the state "as it was", from the journal; the moment is an ISO string or a `Date`. A point-in-time
read works at any step of a chain, including with `deep()`. Only the current state is cheap: a point-in-time read is
rebuilt from the journal. The version time `at` stores microseconds, while a `Date` holds only milliseconds: pass the
`at` string to `asOf` as is, otherwise a read at the moment of a version may miss it.

### Deleted rows

<!-- run: guide -->
```ts
const withGone = await db.Customer().withDeleted().rows()   // live and deleted; deleted rows have $deleted: true
```

### Retention policy

Without a policy, the journal keeps every version. A policy sets how long to keep old versions and with what
granularity:

```ts
history: { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever', tz: 'Europe/Moscow' }
```

This means: all versions for the last day; for the last week, one per day; for the last month, one per week; for the
last year, one per month; older, one per year, forever. Each period keeps its last version. A week starts on Monday;
period boundaries are in the `tz` time zone (UTC by default).

- A policy is set on a class (descendants inherit it) or for all classes without their own policy: `up({ history })`.
- If the last tier has a term instead of `'forever'`, the history older than the term is deleted: `{ all: '30 days' }`.
- While the object's history is alive, the current version, version 1 and versions of special kinds (`create`,
  `delete`, `reclass`, `rekey`, `restore`, `purge`, `reset`, `trim`) are not deleted. If the tombstone of a deleted
  object is older than the last tier with a term, its history is erased entirely. The history of system classes is not
  thinned.
- `maintain()` does the thinning in batches of 10,000 versions ([section 13](#13-operations)).
- In the thinned part, a point-in-time read shows the last kept version before the moment, so its precision equals the
  period of the tier. A subscriber that lags behind by more than the `all` tier gets `cursor_expired`.

### What changed and who: `diff` and `blame`

```ts
const [d] = await db.Order(id).diff()                       // previous version → latest
await db.Order(id).diff({ from: 3, to: 7 })                 // by version numbers
await db.Order(id).diff({ from: '2026-10-01' })             // state at a moment → latest
await db.Order(id).diff({ follow: true })                   // across id changes (reclass, rekey)
const [b] = await db.Order(id).blame()                      // every field of the latest version
await db.Order(id).blame({ at: '2026-10-01', limit: 200 })  // the version at a moment; scan 200 versions
```

Both terminals return an array, one item per object of the step. This is what the answers look like for a kettle
whose price was lowered with a reason:

```ts
import type { BlameResult, DiffResult } from 'letopis'

// db.Product(kettle).blame(): version 2 changed the price, the other leaves date from the creation (version 1)
const blamed: BlameResult = {
  id: '6f1c…', class: 'Product', rev: 2, complete: true,
  fields: [                                     // in path order
    { path: ['class'], rev: 1, at: '2026-10-27T09:15:02.118204+00:00', author: '<Anna id>', agent: '<service id>',
      op: 'create', exact: true },
    { path: ['data', 'price'], rev: 2, at: '2026-10-27T09:20:41.502617+00:00', author: '<Anna id>', agent: '<service id>',
      op: 'update', reason: 'promotion discount', exact: true },
    // ['data', 'sku'], ['data', 'title'], ['links', 'Shop'], ['owner'] — also version 1, like ['class']
  ],
}
// db.Product(kettle).diff(): previous version → latest
const diffed: DiffResult = {
  id: '6f1c…', class: 'Product',
  from: { rev: 1, at: '2026-10-27T09:15:02.118204+00:00' },
  to: { rev: 2, at: '2026-10-27T09:20:41.502617+00:00' },
  changes: [{ path: ['data', 'price'], kind: 'changed', before: 2500, after: 2000 }],
}
```

`agent` here is the service that writes on behalf of Anna (`db = await svc.as(…)`); a write without impersonation has
none.

- `diff()` returns an array of `DiffResult`: `{ id, class, from, to, changes }`. `from` and `to` are the compared
  versions `{ rev, at }`. They have `id` if the version belongs to another id (`follow: true` across `reclass` or
  `rekey`), and `to` has `deleted: true` if the object was deleted at that moment; then `changes` is empty. `from` is
  `null` if the object did not exist yet: every path is `added`. If there is no version at all, `class` and `to` are
  `null` too.
- A change, `DiffChange`, is `{ path, kind, before, after }`. `path` is an array of segments, not a dotted string;
  the first segment is the section of the row: `data`, `links`, `tags`, `owner`, `class`. `kind` is `added` (there
  was no value), `removed` (the value is gone) or `changed`. A missing value is omitted: `added` has no `before`,
  `removed` has no `after`. Data objects are compared by keys, arrays as a whole. A multi-valued end and tags are
  sets: one change per id or tag, the path is `['links', role]` or `['tags']`, and the id or tag itself is in
  `before` or `after`.
- `blame()` returns an array of `BlameResult`: `{ id, class, rev, complete, fields }`, plus `deleted: true` if that
  version is a tombstone. An object with no versions at that moment gives no item. `fields` is an array of
  `BlameField`, one item per leaf of the version, ordered by path: `{ path, rev, at, author, op, exact }` and, when
  present, `agent`, `reason`, `id`. A leaf is a scalar or an array in the data, an empty object, the role of a
  single-valued end, every id of a multi-valued end (`['links', role, id]`), every tag (`['tags', tag]`), `owner` and
  `class`. `rev`, `at`, `author`, `agent`, `op` and `reason` come from the version that changed the leaf last. Empty
  `agent` and `reason` are omitted; `id` is present only if it is a version of the former id (the history went
  through `reclass` or `rekey`).
- `exact: false` means there are gaps between the current version and the found one (the history is thinned,
  trimmed or partly invisible): a missing version may have changed the leaf too. `complete: true` means the whole
  history was scanned without gaps; by default at most the 1000 latest versions are scanned.
- The database computes both with the caller's rights: raw SQL gets the same, `select "v2.shop".blame('<id>')`,
  `select "v2.shop".diff_versions('<id>')`.
- The journal column `changed` (the paths changed by a version, which make `blame` fast) is not granted to the
  application: the paths describe the difference from the previous version, and the reader may not see that one.
  So `select * from log` does not work for the application — list the columns; `blame` gets the paths through a
  database function only when both versions are visible.

### Trimming history

<!-- run: guide -->
```ts
const trimmed = await db.trimHistory(kettle, new Date())     // erase the versions of the kettle before this moment
```

`db.trimHistory(target, moment)` erases the history before the moment right away. The target is a class with its
descendants (by name), an id, a list of ids or rows. This is the middle step of the "right to be forgotten":
`anonymize` → history trimming → deletion and `purge`. In place of version 1, a `trim` record stays with its time, so a
point-in-time read knows when the object appeared.

### Integrity check

<!-- run: guide -->
```ts
const audit = await adm.verify({ data: true })     // { ok, issues, anchor }
```

`verify()` recomputes the hash chains of all versions and returns an anchor: a hash of all chain heads. Keep the anchor
outside the database: a mismatch with it exposes tampering with the latest versions. `{ data: true }` also checks again
the data, ends, tenants, owners and ids of all rows. The system administrator or an admin connection can call it; from
the command line, use `letopis verify [--data]` (exit code 1 if something is found). Legitimate gaps (`trim` and
`purge` records, thinning and `reset`) are not counted as errors.

## 12. Change subscription and cache

### Subscription

<!-- run: guide -->
```ts
const sub = db.watch({ from: 'start', classes: ['Product'] })   // the whole journal of the class, then new events
await db.Product(kettle).update({ price: 2100 }).rows()
let cursor = ''
for await (const ev of sub) {             // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                      // save the cursor: watch({ from: cursor }) continues after it
  if (ev.id === kettle.id && ev.row.data.price === 2100) break   // break (or sub.close()) stops the subscription
}
```

- `from` is `'now'` (the default: only changes after subscribing), `'start'` (the whole journal) or a saved cursor.
  `db.watch()` returns at once, and the subscription takes the "now" moment with its first query to the database: a
  write made right after `db.watch()` may commit earlier and miss the stream. `await sub.ready()` waits for that
  moment: a write after it comes to the stream. The example above reads from `'start'`.
- Calls of `sub.next()` go in turn: parallel calls get different events. A call abandoned by a timeout
  (`Promise.race`) still gets its event — keep its promise and wait for it again.
- `classes`: only these classes with their descendants; `pollMs`: fallback polling (1000 ms). A row that left these
  classes through a class change without an id change arrives as a deletion event in the previous class (`op:
  'delete'`, `row` is the previous version with `$deleted`), even if the subscriber cannot see the new class. The
  event comes if the subscriber could see the previous version.
- Events come without losses or repeats, under the reader's permissions, in the order of transaction numbers, and
  within a transaction in the order of writing. This is not the commit order: compare versions of one object by `rev`.
- A long write transaction in any database of the cluster delays the stream: `await sub.lag()` shows the lag in ms.
- A cursor older than the `all` tier of the retention policy gives `cursor_expired`: read the current state again and
  subscribe with `'now'`.
- Without `LISTEN` (`connect({ listen: false })`), the subscription polls the journal.
- A subscription without losses is a saved cursor: store `ev.cursor` of the last processed event and resume from it
  after a restart.

### Projectors

A projector builds rows of derived classes from the journal: summaries, denormalized cards and anything else that may
be computed with a lag behind the writes. The application writes the source classes (`from`), and only the projector
writes the rows of the `into` classes. Each `into` class is marked with the option `derivedBy` holding the projector
name ([Class settings](#class-settings)). Only an administrator creates derived classes: sync them with an admin
connection holding a tenant session — `adm` from section 3 (`connect({ dsn: ADMIN, schema, token, allowBypassRls:
true })`) or `as()` of a service on such a connection; in the CLI, `letopis sync` with the `--dsn` of the admin role.
For an application session it is `acl_denied`. In the example below, the projector counts product sales from the
order lines `line`.

```ts
const ProductSales = hub('ProductSales', { qty: z.number().int(), revenue: z.number().int() }, {
  ends: { Product: one(Product).onDelete('cascade') }, key: ['Product'], derivedBy: 'product-sales', history: false,
})                                               // the derived class is in the model; syncModels — on an admin connection

const sales = adm.projector('product-sales', {   // adm is an admin connection
  from: ['line'],                                // source classes with descendants; they must keep a journal
  into: ['ProductSales'],                        // the derived classes of this projector
  version: 1,                                    // the handle logic changed: a new version and a rebuild
  withBefore: true,                              // c.before is the previous version of the object or null
  handle(changes, out) {
    for (const c of changes) {
      if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue   // service changes, not versions
      const was = c.before                       // the previous version of the order line: subtract it
      const now = c.row.$deleted ? null : c.row  // the new version: add it; a deletion has none
      if (was) out.inc('ProductSales', { Product: was.links.Product },
        { qty: -Number(was.data.qty), revenue: -Number(was.data.qty) * Number(was.data.price) }, { tenant: c.tenant })
      if (now) out.inc('ProductSales', { Product: now.links.Product },
        { qty: Number(now.data.qty), revenue: Number(now.data.qty) * Number(now.data.price) }, { tenant: c.tenant })
    }
  },
})
const report = await sales.run({ once: true })  // catch up with the journal: { batches, changes, created, updated, … }
const state = await sales.status()               // { name, state, version, cursor, at, lag, failed, rebuildingTenants }
await sales.rebuild()                            // rebuild from the current state; { chunked: true } works in batches
await sales.rebuild({ tenant: tenantId })        // rebuild one tenant, for example a dropped one (failed)
await sales.rebuild({ tenant: tenantId, chunked: true })   // the same in batches: meanwhile the journal tail goes on for all
sales.run().catch((err) => console.error('the projector stopped', err))   // follow the journal until stop()
sales.close()                                    // stop() after the current batch and unsubscribe from signals
```

- A projector needs an admin connection: `connect({ allowBypassRls: true })` with a role that may become the owner of
  the schema. Otherwise you get `admin_required`, and inside `db.begin()` you get `invalid_query`. The projector reads
  the journal of all tenants.
- The first `run()` rebuilds the projection from the current state: the journal is thinned by the retention policy
  and cut by `purge`, so the projection cannot be assembled from the start of the journal.
- Each batch is one transaction: the journal changes, `handle`, the written results and the cursor move are committed
  together. A break in the middle of a batch rolls the whole batch back, and the retry starts from the same cursor, so
  every change is applied exactly once. A projector has one writer: a second process of the same projector skips the
  batch (the `skipped` counter of the report), and `rebuild()` started while another process writes a batch gives
  `projector_busy`.
- A batch is split by tenant: `handle` gets the changes of one tenant, and its results are written under a savepoint
  of its own. If the database rejects writing the results of a tenant (the data do not pass the description of its
  derived class, the target of an end is not found and so on) or `out` rejects a row or a delta built from its data
  (a delta that is not a number), only its changes are rolled back: the tenant drops out, and the others are written
  in the same batch. A dropped tenant gets into `status().failed` — `{ [tenant id]: { cursor, code, message } }`, and
  `message` names the tenant and the row id — and its changes are skipped until it is rebuilt. The derived rows of a
  dropped tenant no longer change: a tenant dropped in `run()` keeps them as they were before the failed batch, and a
  tenant dropped in the middle of a rebuild is left without them — the partly built rows are deleted. An exception
  from `handle`, a breach of the `out` limits and a failure of the environment (a deadlock, a cancelled query, a
  broken connection) roll the whole batch back, and `run()` is rejected. So catch `run()` without `once`: after an
  error it stops.
- A change (`ProjectorChange`) is `cursor`, `id`, `class`, `tenant`, `op`, `rev`, `at`, `author`, `agent`, `reason`,
  `moved` and `row`, the version from the journal (for a deletion, a tombstone with `$deleted`). During a rebuild, the
  changes are rows of the current state: `rebuild: true`, `op` is `create`, `cursor` is empty.
- A class change that keeps the id (classes without a key: a raw `UPDATE … SET class` and `reclass()`) is written to
  the journal as a version of the new class. If it takes the row out of the `from` family, the projector gets a
  deletion: `op` is `delete`, `row` is the last version of the row in the family with `$deleted`, and `rev`, `at` and
  the author are those of the class change. A row that enters the family this way comes as a `reclass` change with
  `before` = `null`.
- With `withBefore`, a change has `before`, the previous version of the same id. `before` is `null` if there is no
  previous version (a creation and the first version of a new id after `reclass` and `rekey`), if the previous
  version is a deletion (this happens after `restore`) or lies outside the `from` family, and for every change of a
  rebuild. With `reclass` and `rekey`, the former data are subtracted through the tombstone of the former id: it comes
  as a change with `$deleted`, its `before` is the last version of the former id, and `moved` of both changes points
  to the other id. So the fold of the example gives the same sum after `rekey`. The service changes `purge`, `trim`
  and `reset` have no `before` field at all. So subtract `before` only after checking it for `null`, as in the example
  above.
- The service journal records `purge`, `trim` and `reset` also come as changes, and their `rev` is 1. So check `op`
  first, and only then compare `rev`.
- `out.upsert(class, row, { tenant })` creates a row or replaces it entirely by the class key.
  `out.inc(class, row, deltas, { tenant })` creates a row or completes it and adds the numbers without reading the row
  (missing fields count from 0). `out.delete(class, key or id, { tenant })` deletes a row and does nothing if there is
  none. `await out.get(class, key or id, { tenant })` reads the current row together with the writes of the batch.
  `out` writes only to the `into` classes and only to the tenant of the changes passed to `handle`; otherwise you get
  `derived_class` or `tenant_denied`, and the batch is rolled back.
- `out` adds up the increments of a row given by key fields only (or by `$id` alone) before sending them to the
  database, as long as there is no `upsert`, `delete` or `get` between them: one edit of a row per batch, and the class
  rule is checked on the total of its increments. `inc` does not fold a row with other fields (data, `$tags`,
  `$owner`): its fields edit the row, and the order of such edits is kept.
- A row for `out` is in the loader format: fields and end roles at the top level, the service keys `$tags`, `$owner`
  and `$id` (`$id` is needed only by a class without a key). The value of a role is the id of the target. An edit that
  changes nothing gives no version. Versions of derived rows are written by System with the agent
  `letopis projector <name>`; the journal is kept according to the `history` of the class, and the change signal is
  always sent.
- `rebuild()` rebuilds the projection atomically, in one transaction: until it commits, readers see the previous rows,
  but the subscription horizon stands still. `rebuild({ chunked: true })` works in batches: the derived rows are
  deleted at once, the data stays incomplete until the rebuild ends, and `status().state` is `'rebuilding'`. The next
  start continues an interrupted batch rebuild. `run()` itself, on the first start of a new projection and with
  `onExpired: 'rebuild'`, rebuilds in batches: the subscription horizon of the cluster stands still no longer than a
  batch. Meanwhile a second process of the same projector waits or continues the same rebuild instead of starting it
  anew. A rebuild deletes the rows of the participants only, and only of the classes of their `into` families, and
  starts all participants anew: the marks of dropped tenants are removed, and a tenant whose data fail again drops
  out again.
- `rebuild({ tenant: id })` rebuilds one tenant in one transaction: it deletes its derived rows, builds them from its
  current source rows and removes its mark in `status().failed`; the projector does not apply again the changes the
  rebuild has already counted. Fix the data or the class description of the tenant, then rebuild it. If the database
  rejects the write again, the rebuild is rolled back with this error, and the tenant stays dropped. No projection yet
  or a batch rebuild in progress gives `rebuild_required`; a tenant that is not a participant gives `tenant_denied`.
  With `chunked: true` — in batches, each in a transaction of its own with its own snapshot, while the journal tail goes
  on for all: the tail skips the tenant's changes above the last batch (a batch will read them) and, in a passed batch,
  those whose transaction is visible in its snapshot. The tenant's derived rows are deleted at once and are incomplete
  until the end of the rebuild (`status().rebuildingTenants`); the rebuild waits out a lock held by `run()` of another
  process. An interrupted rebuild (the process stopped) is continued by `run()` of any process, with or without
  `onExpired`.
- `status().state` describes the projection in the database, not a process: `'new'` means there is no projection yet,
  and the first `run()` or `rebuild()` builds it; `'running'` means the projection is built and kept up with the
  journal (it does not mean that some process is executing `run()` right now); `'rebuilding'` means a batch rebuild
  is in progress or was interrupted.
- `version` is the version of the `handle` logic. If the projection was built by another version, `run()` throws
  `rebuild_required`, and a rebuild with `rebuild()` is needed.
- If the cursor is older than the `all` tier of the retention policy of the sources and there are changes after it,
  some changes may have been thinned out. Each tenant has a tier of its own: it is the description of its classes. If
  the cursor is older than the tier of every participant, `run()` throws `cursor_expired`, and with
  `onExpired: 'rebuild'` the projector rebuilds entirely, in batches. If it is older than the tier of only some of
  them, they drop out (`status().failed`, code `cursor_expired`) and the others go on, and with
  `onExpired: 'rebuild'` the dropped tenants rebuild themselves, in batches: the rebuild state lies in the checkpoint,
  and `run()` of any process continues it; a lock held by another process is only a retry on the next pass, and a data
  error drops the tenant with its code, without retries. The tier of a rebuilt tenant counts from the start of its
  rebuild until the cursor catches up with it: a lagging projector does not drop it again. A projector without new
  changes does not expire. `status().lag` is the age of the oldest unprocessed change in ms.
- A projector works with the tenants in which every `into` class is marked with its `derivedBy`; it skips the changes
  of other tenants, so a class with the same name and no mark in another tenant does not get in its way. No such tenant
  at all — `derived_class`. Only an administrator may mark the classes of a tenant, so it is the administrator who
  chooses the participants: a tenant user cannot join a projector on their own. The option `tenants: [id, …]`
  is an explicit list of participants: the projector works only with these tenants (their `into` classes must be
  marked too) and ignores the marks of the others. The sources are the `from` families of these tenants; a class
  cannot be a source and a result at the same time. A projector does not see the changes of a class with
  `history: false`: it has no journal. So a tenant with such a class among the sources drops out with the code
  `invalid_class`, and the projector does not build its derived rows. Turn the journal of the class on and rebuild the
  tenant with `rebuild({ tenant })`.
- `batch` is how many changes go into a batch (500), `pollMs` is fallback polling (1000 ms): source signals wake the
  projector earlier.
- `lockTimeout` is how long a projector transaction waits for another transaction's row lock (5000 ms; 0 — no limit).
  Otherwise a transaction of any tenant holding a total row or an end target would hold the batch of all tenants.
  Longer than that, the batch rolls back, the cursor stays, and `run()` does not reject but skips the pass
  (`skipped`) and repeats it. The report names the tenant whose row stopped the batch (`locked`).
  `rebuild({ tenant, chunked: true })` waits such a lock out.
- `lockRetries` is how many passes in a row the writes of one tenant may run into `lockTimeout` before it drops out
  (0 by default — it never drops out). The dropped tenant gets the code `55P03`, and the batch goes on for the others;
  its changes are skipped until `rebuild({ tenant })`. The process keeps the count, and a successful write of the
  tenant resets it. Note: a long exclusive lock on the family of a System class (a tightening of its description) will
  hit every tenant in turn.
- Every edit that `out` sends to the database is a separate edit of a row, and the speed of a projector is set by the
  number of edits, not by the number of changes. The folding of `inc` brings the edits of a row down to one per batch,
  so the handle from the example above (`out.inc` for every change) caught up with 6 thousand changes per second with
  `batch` 500 and 33 thousand with `batch` 2000 on the benchmark machine ([section 17](#17-performance)): the larger
  the batch, the more increments of one row fold into one edit.

### Recipe: daily revenue

An aggregate in the database and a projector solve similar tasks in different ways:

| | Aggregate in the database | Projector |
|---|---|---|
| when it is computed | in the same transaction as the write of the source | after the commit, with a lag (`status().lag`) |
| what it computes | the sum of a field or the number of source rows for one target row | anything: summaries by day and by group, denormalized cards |
| matches the source | always, raw SQL included | when the projector has caught up with the journal |
| cost of a write | every operation locks the target row and writes its version, so the writers of one target queue up | writers do not wait for each other: the projector applies changes in batches after the commit |
| rule over the total | `min(0)` rejects an operation that would take the total beyond the rule | the total does not block writes: a data error drops the tenant out of the projection |
| what to run | nothing: the database keeps the field | a process on an admin connection |

A wallet balance that must not go below zero is an aggregate
([Recipe: balance as an aggregate](#recipe-balance-as-an-aggregate)). The revenue of a shop by day is a total over many
sales that may lag a little, which is a job for a projector:

```ts
const Sale = hub('Sale', { day: z.iso.date(), amount: z.number().int().min(0) }, { ends: { Shop } })   // a sale: day and amount
const DayRevenue = hub('DayRevenue', { day: z.iso.date(), revenue: z.number().int(), sales: z.number().int() }, {
  ends: { Shop: one(Shop).onDelete('cascade') }, key: ['Shop', 'day'], derivedBy: 'day-revenue', history: false,
})
await syncModels(db, [Sale], { apply: true })
await syncModels(adm, [DayRevenue], { apply: true })   // the derived class is created by an administrator: adm holds a tenant session

const revenue = adm.projector('day-revenue', {
  from: ['Sale'], into: ['DayRevenue'], version: 1, withBefore: true,
  handle(changes, out) {
    for (const c of changes) {
      if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue   // service changes
      const was = c.before                          // the previous version of the sale: subtract it from its day
      const now = c.row.$deleted ? null : c.row     // the new one: add it to its day; a deletion has none
      if (was) out.inc('DayRevenue', { Shop: was.links.Shop, day: was.data.day },
        { revenue: -Number(was.data.amount), sales: -1 }, { tenant: c.tenant })
      if (now) out.inc('DayRevenue', { Shop: now.links.Shop, day: now.data.day },
        { revenue: Number(now.data.amount), sales: 1 }, { tenant: c.tenant })
    }
  },
})
revenue.run().catch((err) => console.error('the revenue projector stopped', err))   // follows the journal until stop()
const week = await db.Shop(shop).DayRevenue().sort('data.day', 'desc').limit(7).rows()   // the last seven days
```

- The day is a field of the sale, not the version time `at`: with the version time, an edit, `restore` or `rekey`
  would move the amount of the sale to its own day.
- `out.inc` adds without reading the row, so the total does not depend on the order of changes: the journal gives
  transactions in the order of their first write, not of their commit. Editing a sale subtracts the previous amount
  from the previous day and adds the new one to the new day; a deletion only subtracts. A day with no sales left stays
  as a row of zeros. `out` folds the increments of one day in a batch into one edit.
- `DayRevenue` has `history: false`: the derived rows do not double the journal, and a rebuild assembles them without
  history anyway. `Sale` needs a journal: a projector does not see the changes of a class with `history: false`.
- The application reads `DayRevenue` rows like any class, and only the projector writes them: `create` or `update` of
  such a row gives `derived_class`. The total lags behind the sales until the next batch: write signals wake the
  projector, and without them it polls every `pollMs`.

### Result cache

<!-- run: guide -->
```ts
const cached = await db.Product().cache({ ttl: 30 }).rows()   // the result is kept in process memory for 30 s
const stats = db.cache.stats()                                 // { size, hits, misses, stores, raced, … }
```

The cache is enabled only explicitly: `.cache()` in a chain or `cache: { ttl }` on a class in the model. This is how it
stays correct:

- the result key includes the query, the parameters, the session, the actor and the tenant, so one user never gets the
  result of another user;
- your own writes clear the results of the changed classes right after commit (including the cascade classes); other
  writers' changes clear them on a database signal. In the `tenant` and `opaque` modes, a process with the signal key
  clears a class only in the tenant of the write (System rows — in all tenants); a process without the key clears it
  in all tenants, and in the `opaque` mode any signal clears its whole cache;
- changes of permissions and classes, writes through `db.sql`, a revoked session and a listener reconnect clear the
  whole cache or the results of the session;
- the default term is 60 seconds; the cache does not work inside `db.begin()`;
- without `LISTEN` and in the `none` mode the cache is off, and `connect({ cache: { ttlOnly: true } })` enables it by
  term only.

A process re-reads the class registry right away on a class change signal (one re-read at a time), and the registry
and the signal key on `*`, on an unknown token and on a payload of another mode (and without the key in the `opaque`
mode — on any signal) not more often than once in 5 seconds: a stream of signals, fake ones included, does not turn
into a stream of queries. In the `none` mode, the registry checks the class
fingerprint every 5 seconds, and subscriptions poll the log. A subscription wakes up only for its own classes and its
own tenant, and without the key — for any signal; it always reads the events from the log, so nothing is lost.

Between processes, the cache goes stale for the signal sending interval (`notifyIntervalMs`, 100 ms) plus delivery;
`db.flushSignals()` sends the accumulated signals at once. `db.cache.clear()` clears the cache.

## 13. Operations

### Maintenance: `maintain()`

<!-- run: guide -->
```ts
const report = await adm.maintain()     // { sessions, codes, thinned, batches, more, queue, skipped }
```

`maintain()` deletes expired sessions and one-time codes, thins the journal by the retention policy and checks the
PostgreSQL signal queue: if it is more than half full, you get a warning. The system administrator, a role with the
`letopis.maintain` permission or an admin connection can call it. An external scheduler runs it (`letopis maintain`),
or the library itself does: `connect({ maintain: '1h' })`. Of several processes, only one works: each batch is its own
transaction, and the first thing it does is take the maintenance lock — a row of the `secret` table that neither the
application role nor any other database role can take; the lock is released when the batch commits. If another
process holds the lock, the call answers `skipped: true` before the first batch, and between batches it stops (that
process continues) and reports what it has done with `more: true`. There is no session-level lock, so `maintain()`
works behind any pool, including PgBouncer in transaction mode.

### Reset: `reset()`

```ts
await adm.reset({ level: 'tenant', confirm: 'v2.shop', tenant: SHOP })   // sessions | tenant | all
```

Reset is meant for tests and test environments. It works only if the installation was set up with
`up({ allowReset: true })` (otherwise `reset_disabled`, even for System), the caller has the `letopis.reset`
permission, and `confirm` matches the schema name (`confirm_mismatch`). Levels: `sessions` resets all sessions
except the current one; `tenant` the tenant's data; `all` everything, with the system seed laid down again and a new
service key. The first journal record after a reset is `reset`.

### Model description for people and AI

<!-- run: guide -->
```ts
import { describeText } from 'letopis'

const model = db.describe()           // { schema, tenant, classes: [...], methods }
const modelText = describeText(model) // the same as text: for the application's llms.txt or a prompt for an AI agent
```

`db.describe()` returns a description of the classes available to the session: fields, ends, keys, policies and
metadata, plus the multi-field conditions `anyOf` and `oneOf` with inheritance applied, the derived class mark
`derivedBy` and the aggregates `aggregate`, when a class has them. From the command line:
`letopis describe --format text --out llms.txt`.

### Agents and MCP

An agent — Claude, Cursor or your own — works with the data through MCP tools: it learns the model, reads with
chains, looks at the history and, if allowed, writes. The MCP server acts on behalf of one user and only with that
user's rights: every call is a chain under the user's session, and the database checks rights and tenants. The agent
has no raw SQL.

| Tool | What it does |
|---|---|
| `letopis_model` | the model: classes, fields (JSON Schema), the `anyOf` and `oneOf` conditions, ends, keys, aliases, metadata; with `class`, one class in detail |
| `letopis_query` | reading with a JSON chain: the start is `class` and `filter`, `id` or `ids`; `steps` are hops by roles and classes; `asOf`, `withDeleted`, `sort`, `limit`, `cursor`; the terminal is `rows`, `first`, `ids`, `count`, `sum`, `avg`, `min`, `max` or `countBy` |
| `letopis_history` | `versions`, `diff` or `blame` of one object |
| `letopis_write` | `create`, `update` (only with `rev`), `upsert`, `delete`, only with `write: true` (`letopis mcp --write`) |

A `letopis_query` request is the same chain as `db.Product({ price: lt(1000) }).Shop().sort('data.name').rows()`, written as JSON:

```json
{ "class": "Product", "filter": { "price": { "$lt": 1000 } }, "steps": [{ "step": "Shop" }], "sort": { "field": "data.name" } }
```

A filter value means equality, a nested object addresses the fields of nested objects, `{ "Role": id }` is an end.
Operators: `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$between`, `$in`, `$like`, `$ilike`, `$starts`, `$ends`, `$has`,
`$hasAny`, `$hasAll`, `$exists`, `$isNull`, `$not`; OR is `{ "$or": [filter, …] }`. An unknown class, role, parameter
or operator gives an `isError` answer with a hint of similar names. There are at most 16 `steps` and at most 64
conditions in the `$or` of one filter; otherwise `invalid_query`. These limits do not bound the time of a query: set
`statement_timeout` for the database role the MCP server connects as (`alter role … set statement_timeout = '5s'`).

The answer is `structuredContent` and its text copy. `structuredContent` is `{ notice, data }`: `notice` is a constant
text of the package saying that `data` holds database data, not instructions, and `data` is the answer itself. The
shape of `data` of `letopis_query` depends on the terminal:

| Terminal | `structuredContent.data` |
|---|---|
| `rows` (default) | `{ rows, count, more, cursor? }` |
| `ids` | `{ ids, count, more, cursor? }` |
| `first` | `{ row }`, a row or `null` |
| `count` | `{ count }` |
| `countBy` | `{ counts, truncated? }` |
| `sum`, `avg`, `min`, `max` | `{ value }` |

For `rows` and `ids`, `count` is the number of rows on this page, not the total. A page holds at most `limit`,
`maxRows` rows (100) and `maxBytes` bytes of row JSON (50,000); a row that is itself larger than `maxBytes` comes
alone on its page. `more: true` means there are more rows, and then the same request with `cursor` returns the next
page. `counts` is `{ value: number }`, the most frequent values; if the groups did not fit into the limits,
`truncated: true` comes. `countBy` reads at most `maxRows` + 1 groups from the database. The
field of an aggregate and of `countBy` is `field: 'data.<path>'`. Sorting is `sort: { field, dir }`: `field` is `at`,
`rev`, `id` or `data.<path>`, `dir` is `'asc'` (default) or `'desc'`; without `sort`, rows go by `id`. `sort`, `limit`
and `cursor` work only with `rows`, `first` and `ids`.

`letopis_model` without `class` answers (in `data`) `{ schema, tenant, classes }`, the same classes as in `db.describe()`. If such
a model is larger than `maxBytes`, a brief one comes: `brief: true`, and the classes have only the names of their
fields and ends; `letopis_model` with `class` returns each class in detail. `letopis_history` takes `class`, `id` and
`kind`. `versions` answers `{ versions, more }`, the latest versions within the answer limits, from the oldest to the
newest; `diff` with `from` and `to` (a version number or a moment) answers `{ diff }`; `blame` with `at` and `limit`
answers `{ blame }`. If the changes or the leaves did not fit, the answer is cut, and it has `truncated: true` and
`total`. `follow` works with `versions` and `diff`.

A tool refusal is `isError: true` with a `structuredContent` of the form `{ notice, error }`, where `error` is `{ code, message }`, plus `similar` (similar names),
`detail` (details) and `sqlstate` (the PostgreSQL code of an error not from letopis) when present. A parameter that
does not match the tool input schema (a wrong type, a value outside the list, a missing required one) is rejected by
the SDK before letopis: then it is `isError: true` with text only, without `structuredContent`.

In the text of the answer, everything that came from the database (rows, names and descriptions of classes, error
texts, hints) sits inside `<untrusted-data-…>` with a random suffix and a note that this is data, not instructions.
Tool descriptions and the server's `instructions` are fixed text of the package: tenants write the `meta` of classes,
so it only appears in results.

Writing. Without `write`, the `letopis_write` tool is not in the tool list, and a call to it is an SDK protocol error
(`Tool letopis_write not found`), not a tool answer with `isError`. The ends of a write are set by
`links: { Role: id | [id] | null }`, and `create`, `update` and `upsert` answer `{ rows }`. `update` takes only the
`rev` of the version that was read: someone else's version gives `conflict`, and no update is lost. `delete` without
`confirm` returns a preview of the cascade and the operation code: `{ preview, operation }`. With `confirm: true`, a
human confirms the deletion in the client through elicitation (in protocol revision 2025 as a request to the client,
in 2026-07-28 as an `input_required` answer), the confirmation is bound to the hash of the operation, and the answer
is `{ deleted, operation }`. In revision 2026-07-28, the `requestState` signature with which the client repeats the
call is also bound to the user of the server and is valid for 10 minutes: a signature of another user's server and an
expired one give the refusal `confirmation_required`. The confirmation window shows the canonical class name and the ids of the targets (the
first 10, then «и ещё K», that is "and K more"); a tenant writes the alias and the `meta` of a class, so they do not
get into the window. An operation code sent by the agent is not a confirmation; a client without elicitation gets the
refusal `confirmation_required`. Every write gets the reason `mcp: letopis_write`, and `blame()` shows it. By default,
`letopis_write` does not create, edit or delete the permission classes, `rule`, `Resource`, `member`, `Account`,
`Class` and their descendants (rules, memberships, class descriptions): the refusal is `acl_denied`. An agent under an
injection in the data would grant a stranger a membership or a rule without a human confirmation. Only the option
`allowAclWrite: true` allows it.

**stdio.** `letopis mcp` is a stdio server for MCP clients. It needs the SDK package: `npm i @modelcontextprotocol/server`
(an optional peer dependency). The client passes the connection string, the schema and the token as flags or as the
variables `LETOPIS_DSN`, `LETOPIS_SCHEMA`, `LETOPIS_TOKEN`; `--write` turns writing on. Only a user session token is
accepted, and the application issues it: `svc.auth.sessionFor(user, { ttl })`, while `auth.switch(tenant)` sets the
working tenant of the session. The command rejects the service key (`--api-key`): it grants all `auth.*` rights and
would lie on the agent's machine. Without a token and with `--api-key`, the command exits with code 2 and writes the
reason to stderr. The command also rejects the token of a session in the System tenant (this is how a system
administrator works): it has no `allowSystemAdmin` and `allowAclWrite` options. Client configuration (Claude Desktop,
Claude Code, Cursor):

```json
{
  "mcpServers": {
    "letopis": {
      "command": "npx",
      "args": ["letopis", "mcp"],
      "env": {
        "LETOPIS_DSN": "postgres://shop_app:app-secret@localhost:5432/shop",
        "LETOPIS_SCHEMA": "v2.shop",
        "LETOPIS_TOKEN": "<user session token>"
      }
    }
  }
}
```

**HTTP.** There is no built-in HTTP server. `createMcpServer(db, { write, maxRows, maxBytes })` from `letopis/mcp`
returns an MCP server, and the application plugs it into its own `createMcpHandler` handler from the SDK with its own
OAuth 2.1 authorization: the application checks the request token and finds the letopis user by it. The connection
is a user session (`connect({ token })`) or the facade `svc.as(user)`: the service key stays in the application
process. A connection that bypasses RLS is refused with `bypass_rls`; the service root without `as()` and a connection
without a session, with `user_session_required`; the facade of an explicit transaction `db.begin()`, with
`invalid_query`. The server also refuses a session in the System tenant with `user_session_required` unless the option
`allowSystemAdmin: true` is passed: this is how a system administrator works, and their `admin` role grants rights to
the accounts, memberships and rules of the installation.

<!-- run: mcp -->
```ts
import { up, connect } from 'letopis'
import { createMcpServer } from 'letopis/mcp'
import { createMcpHandler } from '@modelcontextprotocol/server'

const ADMIN = 'postgres://postgres:secret@localhost:5432/shop'
const APP = 'postgres://shop_app:app-secret@localhost:5432/shop'
const r = await up({ dsn: ADMIN, schema: 'shop', quiet: true,
  tenant: { name: 'Chamomile', user: { name: 'Anna', login: 'anna@shop.ru', password: 'Chamomile-2026!' } } })
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: r.serviceKey! })

// authInfo is the result of the application's check of the request token; it puts the letopis account id into extra
const mcp = createMcpHandler(async ({ authInfo }) =>
  createMcpServer(await svc.as(String(authInfo?.extra?.account), { tenant: r.tenant!.tenant })))
// in the application's HTTP handler, after checking the token: return mcp.fetch(request, { authInfo })
```

The handler calls the factory on every HTTP request, so `createMcpServer` checks the connection every time (one query
to the database).

The handler can be checked without a network: the SDK client from the `@modelcontextprotocol/client` package reaches
it through the application's `fetch`: `new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch:
(url, init) => mcp.fetch(new Request(url, init), { authInfo }) })`. This is how the `docs` test checks the example
above (the `mcp` scenario in `lib/test/docs.test.ts` of the repository): without `write` the client sees three tools,
and `letopis_model` answers on behalf of Anna in the shop.

### Raw SQL

<!-- run: guide -->
```ts
const [{ n }] = await db.sql`select count(*)::int as n from "v2.shop".entity where class = 'Product'`
```

`` db.sql`…` `` runs a query in one transaction under the session of the connection and under RLS: it sees the same
rows as chains do. `db.transaction(fn)` gives a postgres.js connection for the whole transaction. On a deadlock or a
serialization failure, the query and `fn` are retried up to three times, so `fn` must withstand a retry. You can also
write with raw SQL: the same triggers check the data, and the database functions `merge` and `inc` are available to the
application.

### Command line

```sh
letopis sync <module> --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--apply]
letopis types --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--out <file>]
letopis load <files…> --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--class <Class>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify] [--initial]
letopis verify --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--data]
letopis maintain --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--batches <N>]
letopis describe --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--format json|text] [--out <file>]
letopis import --from <0.21 dsn> --from-schema <v1.name> --dsn <dsn> --schema <v2.name> [--tenant <name>] [--keyless <Class>]…
  [--rename <Old>=<New>]… [--update] [--commit-every <N>] [--partition <name>] [--initial]
letopis mcp --dsn <dsn> --schema <v2.name> --token <user token> [--write]
  (or LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; the service key --api-key is not accepted)
```

### Monitoring

- `connect({ onQuery, slowMs })`: for every chain query, the hook gets the mode, the classes, the duration, the row
  count and a slow query flag; without a hook, a slow query prints a warning.
- `sub.lag()` is the lag of a subscription; the `maintain()` report shows how full the signal queue is.
- Hot reference targets (an organization that almost everything references) accumulate `for key share` locks and
  MultiXact, as with regular foreign keys. This is worth monitoring.

### Connection pools and PgBouncer

With PgBouncer in transaction mode, `LISTEN` is not available: use `connect({ listen: false })`. Then the registry is
re-read with `db.refresh()`, the subscription polls the journal, and the result cache is off or works by term only.
Prepared statements work with PgBouncer 1.21 and newer; with older versions, pass your own postgres.js pool with
`prepare: false` in `connect({ sql })`. `maintain()` takes a transaction-level lock in each batch and works behind
such a pool.

<!-- run: guide -->
```ts
await adm.close()
await anna.close()
await svc.close()      // and the connections obtained through svc.as()
```

## 14. Migrating from 0.21

1.0 is a new implementation, not a continuation of 0.21: a 0.21 schema is not upgraded in place. 1.0 is installed into
a new schema, the `letopis import` command moves the data, and the code is ported with the replacement table in
[MIGRATION.md](MIGRATION.md) (in Russian). The main differences in behavior: `create` does not overwrite (a taken key
gives `exists`), `count()` counts entities, paths are `paths()`, permissions and tenant isolation are always on.

```sh
npx letopis import --from postgres://…/old --from-schema v1.salon --dsn postgres://…/new --schema v2.salon \
  --tenant salon [--keyless booking] [--rename link=link_] [--update] [--commit-every 100000]
```

- The 1.0 schema is installed in advance (`up()`); both connections are admin connections. The source is the 0.21
  tables (`Schema`, `Entity`, `Account`, `Credential`, `Resource`, `Rule`) in any database: PostgreSQL 17 with
  TimescaleDB or a dump of plain tables. The loader (history mode, `existing: 'skip'`, agent `letopis import`) and the
  owner functions do the writing.
- Classes become `Class` rows in System. fastest-validator rules are translated to JSON Schema (`optional` lets `null`
  through, `$$strict` → `additionalProperties: false`, `record` → `propertyNames`). Ends become roles named after the
  target class; a union of all descendants of a class becomes a polymorphic end. The `Entity` and `link` roots are
  dropped; `description`, `appearance` and `order` move to `meta`. For names taken by 1.0 methods, use `--rename` (by
  default, the name with `_`).
- Ids: for a class with a key (the v5 rule from 0.21), v5 of the key; for a class without a key, v5 of the old id.
  System data moves to the `--tenant` tenant, accounts to `Account` rows, credentials to `secret` as they are (scrypt,
  keys); one-time codes are not carried over. Resources and rules go to System.
- The import stops before the first write if two 0.21 objects give one 1.0 id (the data violates the key; use
  `--keyless <Class>`), if a key changed between versions, or if it references a missing object. A dangling reference
  in a live row gives `target_not_found` with the 0.21 object.
- If the loader rejects the data, the error starts with `import: арендатор …`, and its `detail` is the loader's
  ([Report and errors](#report-and-errors)), except that rows are named by 0.21 objects: `rows` are the violations
  with the `class`, `id` and `rev` of the 0.21 object, `code` and `message`; `total`, `truncated`, `limit` and
  `complete` are as in the loader's report; `notes` are the untranslated rules.
- A repeat adds what is missing without duplicates; `--update` also adds new versions of changed objects. The report is
  JSON at the end of the output: objects and versions by class in 0.21 and in 1.0, `verify()`, untranslated rules,
  classes without a key, and uuids in `data` that match old ids (the import does not rewrite them). The exit code is 1
  if `verify()` found discrepancies.

## 15. API reference

The full machine-readable list of exports, methods and error texts is `docs/api-contract.json` in the repository.

### Package exports

| Entry point | What it exports |
|---|---|
| `letopis` | `connect`, `up`, `createTenant`; operators `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `inList`, `like`, `ilike`, `starts`, `ends`, `has`, `hasAny`, `hasAll`, `exists`, `isNull`, `not`, `or`, `isOp`; `inc`, `isInc`, `cursorOf`; `idOf`, `uuidv5`, `v5Name`, `v5Id`; `LetopisError`, `ValidationError`, `fromDbError`; `syncModels`, `generateTypes`, `schemaToTs`; `compileValidator`, `applyDefaults`, `Registry`; `totpCode`, `hashPassword`, `verifyHash`; `describeText`; constants `DDL_REVISION`, `RESERVED_CLASS_NAMES`, `CHAIN_METHODS`, `DB_METHODS`; types `Db`, `DbTx`, `TypedDb`, `Chain`, `Row`, `Filter`, `Cursor`, `ConnectOptions`, `UpOptions`, `LoadOptions`, `LoadReport`, `WatchOptions`, `WatchEvent`, `AuthApi`, `AclApi`, `DiffResult`, `DiffChange`, `BlameResult`, `BlameField`, `Projector`, `ProjectorOptions`, `ProjectorChange`, `ProjectorOut`, `ProjectorRow`, `ProjectorReport`, `ProjectorStatus`, `ProjectorFailure` ([Projector](#projector)), `AggregateInfo` and others |
| `letopis/model` | `hub`, `link`, `one`, `many`, `End`, types `Infer`, `InferLinks`, `Model`, `ClassDef`, `ClassMeta`, `HistoryPolicy`, `AggregateDef`; `normalizeSchema`, `translatePattern`, type `JsonSchema` |
| `letopis/mcp` | `createMcpServer(db, options)`: an MCP SDK server with the letopis tools; the type `McpOptions`: `write` adds the `letopis_write` tool (absent by default), `maxRows` is the rows in an answer (100, from 1 to 10,000), `maxBytes` is the bytes in an answer (50,000, from 1,000 to 50,000,000); `allowAclWrite` lets `letopis_write` write the permission classes too (by default `acl_denied`); `allowSystemAdmin` accepts a session in the System tenant (by default `user_session_required`); a value out of range gives `invalid_data`. Needs the `@modelcontextprotocol/server` package ([section 13](#agents-and-mcp)) |
| CLI `letopis` | `sync`, `types`, `load`, `verify`, `maintain`, `describe`, `import`, `mcp` ([section 13](#13-operations)); `mcp` takes `--dsn`, `--schema`, `--token` (or `LETOPIS_DSN`, `LETOPIS_SCHEMA`, `LETOPIS_TOKEN`) and `--write` |

Removed 0.21 names (`uuidv7`, `LETOPIS_NS` and the methods listed below) throw `removed` with the replacement.

### The `db` root

| Member | What it does |
|---|---|
| `db.ClassName(filter)` | the start of a chain |
| `schema`, `token`, `tenant`, `registry` | the installation name, the token, the session tenant, the class registry (`resolve`, `find`, `has`, `all`, `family`) |
| `auth`, `acl` | sign-in, credentials and sessions; permission decisions ([section 10](#10-users-sign-in-and-permissions)) |
| `as(account, { tenant, owner })` | the same pool on behalf of an account (async) |
| `begin()`, `commit(tr)`, `rollback(tr)`, `lock(…keys)` | an explicit transaction ([section 8](#8-transactions-batches-and-money)) |
| `batch(name)` | a queue of plans: `run()`, `discard()`, `size()` |
| `load(input, options)` | the loader ([section 9](#9-bulk-loading)) |
| `projector(name, options)` | a projector from the journal: `run()`, `rebuild({ chunked, tenant })`, `status()`, `stop()`, `close()` ([Projectors](#projectors)) |
| `rebuildAggregates(class)` | repair of the aggregates of a class and its descendants in all tenants: the field anew from live sources, a version only for corrected rows; → their number ([Aggregates in the database](#aggregates-in-the-database)) |
| `watch(options)`, `cache` | subscription; result cache (`clear()`, `stats()`) |
| `` sql`…` ``, `transaction(fn)` | raw SQL under the session and RLS |
| `idOf(class, key)` | the id of an object of a class with a key, in the session tenant |
| `entity(row \| chain)` | start a path from a ready node |
| `describe()` | a machine-readable description of the model |
| `verify(options)`, `maintain(options)`, `reset(options)` | verification, maintenance, reset ([sections 11](#11-history-and-point-in-time-reads) and [13](#13-operations)) |
| `trimHistory(target, moment)`, `rekeyClass(class, key)` | history trimming; a new class key |
| `refresh()`, `flushSignals()`, `close()` | re-read the classes; send the signals now; close |

### Chain

| Group | Methods |
|---|---|
| steps | `.ClassName(filter)`, `.AliasName(filter)`, `.RoleName(filter)` |
| modifiers | `limit(n)`, `offset(n)`, `sort(field, 'asc' \| 'desc')`, `after(cursor)`, `asOf(moment)`, `withDeleted()`, `deep(max)`, `exact()`, `alias(name)`, `tags(…)`, `owner(…)`, `entity(…)`, `forUpdate()`, `cache({ ttl })` |
| verbs | `create(data)`, `update(patch, { rev })`, `upsert(data)`, `delete({ confirm })`, `anonymize(fields)`, `reclass(class, data)`, `rekey(patch)`, `restore()`, `purge({ confirm })` |
| slots | after a verb: `.RoleName.set(value)`, `.RoleName.unset()`, `.RoleName.add(value)`, `.RoleName.remove(value)` |
| terminals | `rows()`, `first()`, `ids()`, `count({ paths })`, `paths()`, `versions({ follow })`, `diff({ from, to, follow })`, `blame({ at, limit })`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`, `countBy(field)` |

### `db.auth`

| Method | Parameters → result |
|---|---|
| `setPassword` | `{ account, identifier, password, kind?, confirmed?, keepCurrent? }` → credential id |
| `verifyPassword` | `{ identifier, password, kind?, requireConfirmed?, ttl?, totp? }` → `{ account, token }` or `null` |
| `issueApiKey`, `verifyApiKey` | `{ account, name?, ttl? }` → `{ key, id }`; `(key)` → sign-in or `null` |
| `issueKeySecret`, `verifyKeySecret` | `{ account, name? }` → `{ key, secret, id }`; `(key, secret)` → sign-in or `null` |
| `enrollTotp`, `verifyTotp`, `totpEnabled` | `{ account, issuer?, label? }` → `{ secret, uri }`; `{ account, code, window? }` → `boolean`; `(account)` → `boolean` |
| `issueOtp`, `verifyOtp` | `{ account, identifier, kind?, ttl?, digits?, maxAttempts? }` → `{ code }`; `{ identifier, code, kind? }` → sign-in or `null` |
| `link`, `lookup` | `{ account, kind, identifier, meta?, confirmed? }` → id; `{ kind, identifier, requireConfirmed?, ttl?, totp? }` → sign-in or `null` |
| `credentials`, `revokeCredential`, `setFlags` | `(account)` → credentials without secrets; `(id, { keepCurrent? })`; `(id, { confirmed?, enabled? })` |
| `sessionFor`, `refresh`, `revoke`, `revokeAll` | `(account, { ttl? })` → token; `({ ttl? })` → the new expiration time (the token stays the same); `()`; `(account?)` → number of sessions |
| `tenants`, `switch` | `()` → `[{ tenant, roles }]`; `(tenant)` |
| `purgeAccount` | `(account)` → `{ account, rows, versions, memberships, owned }` |

Password, code and TOTP checks, session issuing and credential confirmation are called by the service (`auth.*`
permissions); a regular user gets `acl_denied`. The credentials of System, services and system administrators can be
changed only by the account itself after a recent interactive sign-in, or by the system administrator. The exception is
the service's keys: the service issues and revokes its own API keys and "key + secret" pairs itself with a session of
its own key, but not its other credentials; nobody can revoke the last active key of a service (`acl_denied`). With
`totp`, `verifyPassword` and `lookup` also check the TOTP code (the `auth.totp` permission) and issue a session with the
`TOTP` method. The credential kind `kind` is `^[A-Z][A-Z0-9_]{1,31}$` (`PASSWORD`, `EMAIL`,
`TELEGRAM` …); `SESSION`, `APIKEY`, `KEYSECRET`, `OTP`, `TOTP` and `KEY` are taken.

### Projector

`db.projector(name, options)` works only on an admin connection ([Projectors](#projectors)). The name is lowercase
Latin letters, digits and `_.:-`, up to 64 characters; it is also the `derivedBy` of the derived classes. Wrong options
give `invalid_data`.

| Member | What it does |
|---|---|
| options `ProjectorOptions` | `from`, `into`: classes with descendants; `version`: an integer from 1; `handle(changes, out)`; `withBefore`; `onExpired: 'rebuild' \| 'error'` (`'rebuild'` rebuilds in batches); `batch`: changes in a batch (500, from 1 to 10,000); `pollMs`: fallback polling (1000 ms); `lockTimeout`: waiting for another transaction's row lock (5000 ms, 0 — no limit); `lockRetries`: passes in a row before a tenant with another transaction's lock drops out (0 — never); `tenants`: ids of the participant tenants |
| `run({ once })` | catch up with the journal (`once`) or follow it until `stop()` → `ProjectorReport` |
| `rebuild({ chunked, tenant })` | rebuild from the current state: atomically, in batches or for one tenant → `ProjectorReport` |
| `status()` | → `ProjectorStatus`: `{ name, state, version, cursor, at, lag, failed, rebuildingTenants }`; `failed` is `{ [tenant id]: ProjectorFailure }`, where `ProjectorFailure` is `{ cursor, code, message }` |
| `stop()`, `close()` | stop `run()` after the current batch; the same plus unsubscribing from signals |
| `ProjectorReport` | `{ batches, changes, created, updated, deleted, unchanged, skipped, rebuilds, locked }` |
| `ProjectorChange` | `{ cursor, id, class, tenant, op, rev, at, author, row }` and, when present, `agent`, `reason`, `moved`, `before`, `rebuild` |
| `ProjectorOut` | `upsert(class, row, { tenant })`, `inc(class, row, deltas, { tenant })`, `delete(class, key or id, { tenant })`, `get(class, key or id, { tenant })` → `Row \| null`; a row is a `ProjectorRow` in the loader format |

### Result row

| Field | Meaning |
|---|---|
| `id`, `class`, `rev` | id, class, version number (for `update(patch, { rev })`) |
| `tenant`, `owner` | the tenant and the owner of the row |
| `links`, `data`, `tags` | ends, fields, tags |
| `at`, `author`, `agent`, `op`, `reason` | version time (ISO, UTC, microseconds), author, agent (the service under impersonation), kind of operation, reason |
| `moved` | the reference to the old or the new id after `reclass` and `rekey` |
| `$deleted` | tombstone: a deleted entity or a deletion version |
| `$depth` | the depth of a node in `deep()`; the cascade level in a deletion preview |
| `$upsert`, `$action`, `$versions`, `$purged` | what `upsert` did; what the deletion will do; the number of versions in `purge`; the history is erased |

### Reserved names

The Proxy parses the names below before classes, so a class with such a name cannot be reached as a step, and the
database does not accept a link with such a name (`reserved_names()`; the installer fills in the list from
`RESERVED_CLASS_NAMES`).

- chain methods: `then`, `entity`, `paths`, `rows`, `first`, `ids`, `count`, `limit`, `offset`, `sort`, `asOf`,
  `withDeleted`, `deep`, `exact`, `sum`, `avg`, `min`, `max`, `countBy`, `after`, `versions`, `create`, `update`,
  `upsert`, `set`, `unset`, `add`, `remove`, `delete`, `anonymize`, `reclass`, `restore`, `purge`, `alias`, `tags`,
  `owner`, `forUpdate`, `cache`, `rekey`, `diff`, `blame`; guards of the removed API: `run`, `execute`, `account`;
- the `db` root: `as`, `begin`, `commit`, `rollback`, `lock`, `batch`, `watch`, `close`, `registry`, `sql`, `load`,
  `verify`, `maintain`, `reset`, `describe`, `auth`, `acl`, `idOf`, `refresh`, `transaction`, `flushSignals`,
  `schema`, `token`, `tenant`, `trimHistory`, `rekeyClass`, `cache`, `projector`, `rebuildAggregates`; guards: `reloadSchema`,
  `accounts`, `credentials`, `resources`, `rules`, `compact`;
- batch: `discard`, `size`.

## 16. Errors

The text of an error is `letopis: <code>: <message>`. The code is in `err.code`, the details are in `err.detail`.
Errors are `LetopisError` objects; data errors are `ValidationError` with `err.issues: [{ path, keyword, message }]`.

Database codes. Raw SQL gets them too: SQLSTATE class `LT`, the details are JSON in `DETAIL`.

| Code | SQLSTATE | When |
|---|---|---|
| `no_session` | LT001 | there is no valid session |
| `target_not_found` | LT002 | the target is not found; the same for a nonexistent, a foreign and an invisible target |
| `invalid_data` | LT003 | the data does not match the class description; `err.issues` gives the path, keyword and message |
| `undeclared_end` | LT004 | the end is not declared in the class |
| `tenant_denied` | LT005 | a foreign tenant or no membership |
| `acl_denied` | LT006 | denied by the access rules |
| `id_mismatch`, `id_from_db` | LT007, LT008 | the id is not v5 of the key; the id of a class without a key is assigned by the database |
| `immutable_key` | LT009 | a key field, the id, the tenant and the owner do not change (a new key is `rekey`) |
| `invalid_class` | LT010 | the class description is rejected, the class is not found or is abstract; a class with rows, descendants or a history of rows is not deleted |
| `use_reclass`, `reclass_denied` | LT011, LT012 | changing the class with `update` when the old or the new class has a key: the id changes, so use `reclass()`; the roles of referencing rows do not accept the new class |
| `tightening_conflict` | LT013 | rows prevent tightening the description |
| `isolation_level` | LT014 | deleting, changing the class and changing the key work only in `read committed` |
| `recreated_in_statement` | LT015 | an id was deleted and created again in one statement |
| `cursor_expired` | LT016 | the cursor of a subscription or a projector is older than the `all` tier of the retention policy |
| `delete_restricted` | LT017 | referencing rows prevent the deletion (`onDelete: 'restrict'`) |
| `not_deleted` | LT018 | `restore` and `purge` work only for deleted objects |
| `reset_disabled` | LT019 | reset is disabled in the installation (`allowReset`) |
| `confirm_mismatch` | LT020 | the reset confirmation does not match the schema name |
| `derived_class` | LT021 | a row of a derived class (`derivedBy`) is written, edited or deleted by someone other than its projector; an end leads to such a row or to a derived class; a projector writes to a class outside its `into` or has found no tenant in which every `into` class is marked with its `derivedBy` |
| `aggregate_field` | LT022 | the application passed or changed an aggregate field (`aggregate`): the database calculates it |
| `projector_pending` | LT023 | `purge` of a deleted object whose deletion a projector of its class has not read yet, or `trimHistory` whose first remaining version it has not read yet: run the projector first |

Library codes:

| Code | When |
|---|---|
| `exists` | the object already exists: `create` (`detail.id` is its id), `rekey` (the new id is taken) or the loader |
| `duplicate`, `deleted` | the loader: a repeated id in the load; an object with this id existed before. The loader throws the code of the first problem row, the first 100 are in `detail.rows`, the total is `detail.total` |
| `conflict` | `update(patch, { rev })`: the row was changed in the meantime (`detail`: `id`, `rev`, `expected`) |
| `rev_ambiguous` | `{ rev }` on a step that does not have exactly one target |
| `tx_required` | `forUpdate()`, `lock()`, `commit()` or `rollback()` outside an active `db.begin()` |
| `lock_unsupported` | `forUpdate()` with an aggregate, `asOf`, `versions`, `withDeleted`, `deep` or a verb |
| `commit_unknown` | the connection dropped during `COMMIT`: the outcome is unknown |
| `tx_rolled_back` | PostgreSQL answered `ROLLBACK` to `COMMIT`: the error was caught inside `tr.transaction(fn)` |
| `no_key` | `upsert`, `rekey` or `idOf` on a class without a key |
| `no_path` | there is no hop between the classes of neighboring steps |
| `invalid_query` | the chain or the API is used incorrectly (a step modifier `deep`, `exact`, `alias`, `tags` or `owner` after a verb, a slot not after a verb, an `after()` cursor with a value of a different type than the `sort` field, without `v` or with an `id` that is not a uuid, and so on) |
| `admin_required` | the loader, a projector and `rebuildAggregates` need an admin connection |
| `rebuild_required` | the projection was built by another version of the projector (`version`): a rebuild with `rebuild()` is needed; `rebuild({ tenant })` while there is no projection or a batch rebuild is in progress |
| `projector_busy` | a rebuild cannot start: the projector is running in another process right now |
| `not_empty` | the initial load (`initial`) goes only into an empty schema |
| `class_not_loadable` | the loader does not accept `Class` rows |
| `bypass_rls` | `connect()` with a role that bypasses RLS, without `allowBypassRls`; `createMcpServer` with a connection that bypasses RLS |
| `user_session_required` | `createMcpServer` and `letopis mcp`: a user session is needed — the connection has no session, it is the service root without `as()`, a session in the System tenant without `allowSystemAdmin`, or the command line got the service key or no token |
| `confirmation_required` | `letopis_write` (MCP): a deletion without a human confirmation — the client has no elicitation, the human declined, the answer belongs to another operation, or the data changed after the preview |
| `removed` | a removed 0.21 API; the text gives the replacement |

A PostgreSQL permission denial (`42501`) comes, for example, on an `upsert` over someone else's row that you may not
edit.

## 17. Performance

Benchmark of 1.0 against 0.21 on the same datasets (`cd lib && npx tsx bench/compare.bench.mjs`, 2026-10-09,
PostgreSQL 18, and 0.21 on PostgreSQL 17 with TimescaleDB, one machine): salon has ~980 thousand rows (in 0.21 they
belong to System without isolation, in 1.0 they are in a tenant under RLS and permissions); tenants has 500 thousand
customers with 2 versions each, across ten tenants. The numbers depend on the machine; what matters is the ratio.

| Measurement | 1.0 | 0.21 | Unit | Note |
|---|---|---|---|---|
| loading the salon dataset | 6359 | 3609 | rows/s | 1.0: the loader in history mode with checks; 0.21: raw INSERTs into Entity |
| loading the tenants dataset | 8566 | 35186 | rows/s | 0.21: INSERT … SELECT with triggers disabled |
| row-by-row create | 128 | 156 | rows/s |  |
| read by key | 2.2 | 3.81 | ms (p50) |  |
| three-step chain (count) | 222.79 | 1233.83 | ms (p50) | organization → specialists → bookings |
| point-in-time query (asOf) | 202.77 | 327.98 | ms (p50) | a specialist's bookings as of mid-year |
| 20 concurrent writers | 982 | 522 | rows/s |  |
| class change (reclass) | 9.5 | — | ms (p50) | 0.21 has no such verb |
| count() of bookings: a tenant under RLS and permissions | 272.25 | 890.73 | ms (p50) | 0.21: without isolation and permissions (enforceAccount: false); 1.0 without RLS (admin): 18.59 ms |
| count() of customers of tenant 1 (50.0%) | 114.09 | 667.19 | ms (p50) |  |
| count() of customers of tenant 3 (10.0%) | 23.8 | 229.94 | ms (p50) |  |
| count() of customers of tenant 8 (1.0%) | 5.3 | 88.02 | ms (p50) |  |
| count() of customers of tenant 10 (0.3%) | 3.54 | 26.08 | ms (p50) |  |

A full import of the salon dataset from 0.21 (`npm run test:import-salon`): 539,580 objects and 980,180 versions in
193 s (5,084 rows/s); the per-class counters matched, and `verify()` is clean. Checkpoint B tuning (revision 5): the
journal index on reference targets, `log_ends`, made an `asOf` read across a hop 16 times faster (3.37 s → 0.20 s) and
costs the loader 15–17% of its speed. Reading `letopis.changed` and `COMMIT` in one pipeline removed a round trip to the
database from every write (row-by-row writes: 119 → 128–147 rows/s in different runs). Row-by-row `create` is still
12–18% slower than 0.21 (the measurements vary): most of the time goes to the check triggers in the database and to the
commit with a disk write.

Initial load (`cd lib && npx tsx bench/initial-load.mjs`, 2026-10-11, median of three rounds): the regular loader
writes 1.07 million objects of the salon dataset without history in 169 s (6,351 rows/s, 4.0 GB of WAL), the initial
load in 77 s (13,902 rows/s, 1.4 GB of WAL). Most of the difference comes from the GIN indexes: maintaining them during
the load costs 36 s, building them at the end about 5 s. Preparing rows in the loader itself (checks, ends, ids) runs
alongside the `COPY` of the previous batch and now sets the pace: about 60 s of the 77.

Derived data in 1.2 (`cd lib && npx tsx bench/derived.bench.mjs`, 2026-10-27, PostgreSQL 18.6, one machine; for
aggregates, the median of three rounds; the projector rows are a repeat of series 2 and 3 after the folding of `inc` in
`out`, `BENCH_SERIES=2,3`):

| Measurement | 1.2 | For comparison |
|---|---|---|
| an operation with an aggregate, one writer | 94 operations/s, p50 10.7 ms | without an aggregate 137 and 6.9 ms; the `inc` recipe 69 |
| operations on one wallet with an aggregate, 20 writers | 152 operations/s, p95 0.47 s | without an aggregate 1,987; the `inc` recipe 190 |
| operations on 20 wallets with an aggregate, 20 writers | 1,379 operations/s | without an aggregate 2,023 |
| projector catch-up, `out.inc` for every change | 6,076 and 33,395 changes/s (`batch` 500 and 2000) | before the folding of `inc` in `out`: 992 and 1,203 |
| rebuild of 75 thousand rows | atomic 13.3–13.5 s, in batches 13.0–13.2 s | before the folding of `inc` in `out`: 101 s and 58–63 s |
| delay of a subscription event during a rebuild | atomic up to 13.4 s, in batches up to 0.21 s | without a rebuild up to 0.12 s |

The aggregate triggers fire on every write statement, but for classes without aggregates the measurement does not see
their cost: the p50 difference is from −0.28 to +0.21 ms. The benchmark against 1.0.1 (`bench/vs-101.bench.mjs`, four
runs) showed no write or read regressions against 1.1: two outliers did not repeat in separate checks.

## 18. Limitations

This section lists what letopis 1.3 deliberately does not do or does with caveats, and where you need to watch the
behavior.

**Platform**

- PostgreSQL 18 or newer is required; there are no workarounds for 15–17. AWS RDS, Google Cloud SQL, Azure Flexible
  Server and Neon support 18, while Supabase, as of October 2026, offers only 15 and 17, so 1.0 will not work there.
- The database must be in UTF8 encoding (`casefold()` and the `pg_unicode_fast` collation). If a new major PostgreSQL
  version updates the Unicode tables, the unique index of credential identifiers is rebuilt with the `reindex` command.
- PGlite has one superuser connection: no concurrent writers and no `LISTEN`, and RLS does not apply
  (`allowBypassRls: true`); it does not replace `postgres:18` for permissions, race tests and CI.
- A pool in transaction mode (PgBouncer): `LISTEN` is not available, so use `connect({ listen: false })`; the
  subscription polls the journal, and the result cache is off. Prepared statements work with PgBouncer 1.21; with older
  versions, pass a postgres.js pool with `prepare: false` in `connect({ sql })`.
- The NUL character (`\u0000`) is impossible in data strings: PostgreSQL does not store it in `jsonb`; such data is
  rejected already when the JSON is parsed (in the official JSON-Schema-Test-Suite, the "nul characters" groups are
  skipped).
- On PostgreSQL before 18.6, a parallel GIN index build could write a wrong row count into the table statistics
  (`pg_class.reltuples`), after which autovacuum stopped processing the table. That is why the initial load always ends
  with `ANALYZE`, but it is better to upgrade the server to 18.6 or newer.

**Writing and integrity**

- Row-by-row writing costs more than a plain insert: triggers check every row (data, ends, id, journal, hash, RLS).
  Row-by-row `create` is 12–18% slower than 0.21 ([section 17](#17-performance)); for bulk writing there is the loader.
- Deleting, changing the class and changing the key work only in `read committed` (`isolation_level`); library
  transactions always open at this level.
- PostgreSQL does not run `COPY` into tables under RLS; bulk loading works only through the loader on an admin
  connection.
- The initial load closes the schema's tables for the whole load, for writing and for reading: it is meant for an
  empty schema (seeding, migration, import), not for a running system. Its gain is in the database (indexes and
  constraints are built once); it does not speed up the row preparation in the loader, only runs it alongside `COPY`,
  so on a million objects it is about 2.2 times faster than the regular load.
- The database trusts the loader: the data, ends and ids of loaded rows are checked by the library code (the TypeScript
  validator), not by the triggers; the database checks only the targets outside the load, the tenants and the owners,
  with one query at the end. The safeguards: the loader is available only to an admin, differential tests of the
  validator against the database, `load({ verify: true })` and `db.verify({ data: true })`. Keep the admin connection
  in a separate loading process, not in the web application: an SQL injection there would get the owner's rights.
- The schema owner and a superuser can disable the triggers and change anything. letopis does not prevent this; it
  detects it: `verify()` recomputes the hash chains, `verify({ data: true })` checks the rows again, and the anchor (a
  hash of all chain heads) should be kept outside the database.
- The database checks a subset of JSON Schema: Zod `refine`, `superRefine` and `transform` work only in the library,
  and the database does not accept a description with an unknown keyword; `pattern` is a limited subset of regular
  expressions shared by Zod, the validator and the database. The output of `z.toJSONSchema()` changes between Zod
  versions: the database stores an already normalized schema, and a `syncModels` dry run shows the difference before it
  is applied.
- The key is the only way to get uniqueness: the id is computed from the key values without normalization, so the same
  value written in a different way (an email in a different case, a time with and without milliseconds) gives different
  ids. The model sets the format of a key field, and the database checks it.
- Frequent changes of a key value (email, phone) require `rekey`. Values that change often and personal values are
  better moved to a separate hub with a link: an id from an email can be found by brute force and stays in references and in the journal
  even after `anonymize`, while a separate hub is deleted together with the link through `purge`.
- `create` with a taken key answers `exists` with the id, and `upsert` without permission on the existing row answers
  with a `42501` denial: this reveals that the key is taken, but only within your own tenant, because in other tenants
  the same keys give other ids.
- Changing the class and the key rewrites all incoming references (and, recursively, the links whose key includes this
  end), so its cost is proportional to the number of references. Tightening a class description and `rekeyClass` pause
  writes to the family while they check or move rows.
- `rekeyClass` moves rows in one transaction under an exclusive lock of the family, not in batches: between batches,
  rows with old ids would break the rule "the id is v5 of the key".
- v5 ids land in the primary key index in scattered places; on very large tables with heavy inserts this is more
  noticeable than with sequential ids.
- Hot reference targets (an organization that almost everything references) accumulate `for key share` locks and
  MultiXact, as with regular foreign keys; this needs monitoring. Operations on one wallet go one after another under a
  lock of its row ([section 8](#8-transactions-batches-and-money), "Recipe: wallet").
- A link cannot have a reserved name, and a hub with such a name cannot be reached as a step
  (["Reserved names"](#reserved-names)).

**Access**

- The service key is the root of trust: its compromise allows acting on behalf of any enabled user of the
  installation except System, services and system administrators; the access rules do not narrow this scope. The key
  is reissued (`db.auth.issueApiKey`) and revoked (`db.auth.revokeCredential`) by the service itself with a session of
  its own key, or by the system administrator; with its key the service also issues itself new keys, so after a leak
  revoke all its keys except the new one (`credentials` lists them). Nobody can revoke the last active key of a
  service: to cut a service off, set `enabled: false` on its account. A database password alone, without a token,
  gives nothing.
- The permission pass reveals its own plan to the client (the classes and rule conditions that apply to it).
- Raw SQL without the permission pass pays for the permission plan on every query: 0.3–1.3 ms depending on the number
  of rules.
- The end names `User`, `Tenant` (membership), `Group` and `Object` (rule) are taken by system classes across the
  whole schema.
- OTP and TOTP attempt counters are rolled back together with the caller's transaction: the service limits the rate of
  attempts.
- When users link a taken identifier themselves, the answer is `acl_denied`, so a user with a recent sign-in learns
  this way that the identifier is taken. Permission changes in all tenants are serialized through one counter row.
- Refusal texts name the class, role and id of a referencing row only if the actor can see it: a cascade delete,
  unsetting an end, rewriting references on a class or key change, and a `parent` change conflict
  (`tightening_conflict`). The number of invisible rows that block a deletion or a
  class change (`reclass_denied`), and the existence of an account by id (as a reference target), are not hidden.
- Tightening a class description and `rekeyClass` check all rows of the family, so they need the `READ` permission
  without conditions on all rows of the class and its descendants: otherwise a trial tightening (`maximum`, `enum`,
  `pattern`) would answer with the number of invisible rows that do not match it. A system administrator who tightens
  a System class gets the number of violating rows of other tenants (`others`): this is the installation level.
- Class metadata (`meta`) is visible to anyone who has a session: anyone can read `Class` rows. Secrets do not belong
  there.
- An application role can slow the installation down for everyone: `LOCK TABLE entity`, advisory locks with the keys
  of the application's `lock()`, fake `NOTIFY` signals (they only clear the cache), frequent permission changes (one
  counter row per installation). The global journal number reveals the overall write activity. Internal locks — class
  families, projectors and maintenance — are rows of the `secret` table, not advisory locks: neither the application
  role nor any other database role can take them. A family writer passes the tightening gate in a subtransaction — one
  per transaction for the first write to the family.

**History, signals, cache**

- An `asOf` read is rebuilt from the journal; only the current state is cheap. In the thinned part of the journal, a
  point-in-time read shows the last kept version before the moment: its precision there equals the period of the tier,
  a day, a week, a month or a year. A history import into a class with a policy is thinned right away, and a subscriber
  may not see the old versions.
- The thinned part of the journal proves neither that the history is complete nor that old versions are authentic: for
  a class with a policy, `verify()` cannot tell the tampering of a version older than the `all` tier from thinning.
- The journal has no partitions: thinning deletes versions in batches, and the table file does not shrink by itself
  (new versions take the space after autovacuum); to return the space to the system, use `VACUUM FULL` or `pg_repack`
  in a maintenance window.
- Signals reveal activity: PostgreSQL lets any role listen to a channel. In the `class` mode one sees when and to which
  classes writes happen; `tenant` adds tenant pseudonyms; `opaque` hides what was written but not when: the write
  time and frequency per pseudonym stay visible, and a deterministic token is the basis of frequency attacks. Write
  times are visible without signals too: `pg_stat_all_tables` and `pg_locks` are open to PUBLIC. The `none` mode
  removes signals, but then a revoked session leaves the cache of other processes only by term, and a new class
  appears in their registry within 5 seconds. Real protection from foreign roles is a separate database. A fake
  signal only clears the cache one extra time: on `*` and unknown tokens the registry is re-read not more often than
  once in 5 seconds, and a fake class change signal re-reads it like a real one, but with at most one re-read at a
  time.
- The signal mode is changed by `up({ signals })`, and the processes have to be restarted after that: a process reads
  the mode and the signal key on connect (it treats a payload of another mode as foreign and clears the whole cache).
- PostgreSQL below 18.2 could truncate CLOG that unread signals still need: `up()` warns about it.
- The `NOTIFY` queue (8 GB) is shared by the whole cluster: a stuck listener fills it up, and then transactions with
  `NOTIFY` fail on commit. The library reads signals right away, and `maintain()` warns when the queue is more than
  half full.
- PostgreSQL commits transactions with `NOTIFY` one at a time: a commit holds the cluster-wide lock of the signal queue
  together with the disk write. A raw SQL write on its own connection sends the signal from a trigger in the same
  transaction, so concurrent raw SQL writers commit one after another: on the benchmark machine, 20 such writers did
  about 520 inserts per second. Library transactions, `db.sql` and `db.transaction()` included, commit the data
  without `NOTIFY` and send the signals later, separately, so their writers do not wait in this queue: 20 library
  writers did about 2,000 operations per second.
- The subscription horizon is shared by the whole cluster: a long write transaction delays the events of all
  subscribers (`sub.lag()`); long operations are better done in batches.
- Between processes, the result cache goes stale for the signal sending interval (100 ms) plus delivery, and for the
  time of a listener reconnect: postgres.js does not report a broken listener connection, so the cache works until the
  reconnect and is cleared completely after it. The `ttl` term is a safeguard.
- A "from now" subscription cursor carries a snapshot of the subscription moment until it passes that boundary: such a
  cursor is longer than a regular one.

**Projectors**

- A projector is an admin process: it works only on an admin connection, reads the journal of all tenants bypassing
  RLS and writes its results as the owner role. Keep it in a separate process, like the loader. A participant of a
  projector is a tenant in which all `into` classes are marked with its `derivedBy`; only an administrator may mark a
  class (the `letopis.projector` permission).
- The totals of a derived class are seen by everyone whom the tenant rules give `READ` on it — even by those who do not
  read the source rows: decide who reads it with rules on the derived class itself. With `history: true`, its journal
  shows the change of every batch, that is, the contribution of single source rows too.
- Only their projector writes the rows of derived classes: the application, raw SQL and the loader get
  `derived_class`, and ends may not refer to such rows.
- An atomic rebuild is one long write transaction: while it runs, the subscription horizon stands still, and events
  are delayed for the subscribers and projectors of all processes. On the benchmark machine, a rebuild of 75 thousand
  rows took 13 s, and the subscriber got no event until it ended. That is why `run()` itself rebuilds in batches, and
  only an explicit `rebuild()` runs an atomic rebuild.
- A batch rebuild holds the horizon only for the time of a batch (in the same measurements, events were delayed by up
  to 0.2 s), but the derived data is incomplete until it ends: the rows are deleted at once and reappear as the
  rebuild goes on.
- A projector sees only the changes from the journal, so a class with `history: false` cannot be a source: a tenant
  with such a source drops out of the projector (`invalid_class`) until the journal of the class is turned on and the
  tenant is rebuilt.
- Thinning the journal older than the `all` tier leads to a rebuild: a projector that lags behind by more than that
  tier gets `cursor_expired` or, with `onExpired: 'rebuild'`, rebuilds itself. The tier is per tenant: if it has
  expired only for some participants, only they drop out and rebuild.
- A projector works only on a schema with the engine revision the library expects; on a schema of another revision it
  answers `invalid_data`.
- `purge()` waits for projectors: while a projector whose sources include the class of the object, and which has a
  derived class in the object's tenant, has not read the deletion, `purge` answers `projector_pending`. A projector
  that is no longer run holds `purge` of its sources while the tenant has its derived classes: run it or delete them.
  `trimHistory` waits the same way: while the projector has not read the first remaining version, trimming answers
  `projector_pending`.

**Aggregates in the database**

- An aggregate queues the writers of one object: every operation locks the target row and writes its version. On the
  benchmark machine, 20 writers of one wallet with an aggregate did 152 operations per second (p95 is 0.47 s), without
  an aggregate 1,987. For hot counters, use a projector that folds a batch.
- `reclass` and `rekey` accumulate contributions until the end of the move, while a delete cascade and the loader apply
  them per statement: the class rule is checked on the total of each cascade statement and of each loader batch. So a
  load in which debits come in a batch before top-ups gets `invalid_data`, although the total of the whole load is
  valid. Every batch that touches a target writes its version.
- A tenant aggregate does not count rows of a System class, and the field of a System row counts only System sources.

**Agents and MCP**

- The `<untrusted-data-…>` wrapper is a mitigation, not a protection: the model may follow the text inside it. The
  protection is the rights in the database: the agent reads and writes only what its user is allowed to. In
  `structuredContent`, the database data lies in `data` and `error` next to the `notice`, without marks: a client that
  gives the model that instead of the text passes the data with the note but without a random mark.
- By default the server only reads; writing is `write: true` (`--write`); deletion is only with a human confirmation.
  The server writes the permission classes only with `allowAclWrite` and accepts a session in the System tenant only
  with `allowSystemAdmin`; `create`, `update` and `upsert` of the other classes need no human confirmation.
- The HTTP handler serves revision 2025 statelessly: the per-request instance does not know the client's
  capabilities, so deletion through it is refused (`confirmation_required`). Delete over stdio or in revision
  2026-07-28.
- A confirmation in revision 2026-07-28 is signed with a process key: a retried call that lands in another process of
  the application (several instances behind a load balancer) is refused with `confirmation_required`.
- `versions` returns the latest versions within `maxRows` and `maxBytes` (at most `maxRows` + 1 versions are read
  from the database) and `more`; earlier ones, through `diff` and `blame` with `from`, `to`, `at`. A mode where the
  agent writes code against the API (code mode) is not part of the package.

**Import from 0.21**

- 1.0 is a new major version, not a continuation of 0.21: `count()`, `paths()`, `create`, roles, multiple ends and
  `reclass` behave in a new way, and the data is moved by an import; see [MIGRATION.md](MIGRATION.md) (in Russian).
- Import: the steps (classes, accounts, credentials, permissions, the data of each tenant) are separate transactions,
  and the source is read into memory entirely; a row owner that is not found among the accounts becomes the tenant;
  0.21 access rules move to System and apply in all tenants; the `onDelete` of ends is `cascade`, the way 0.21 deleted.

## 19. Tests

This section is for those who develop letopis itself. Run: `cd lib && npm test`. The harness starts the
`letopis-pg18` container (`postgres:18`, port 15433) by itself if the database does not respond; each test file works in its own schema `v2.t_<name>`.

```
# connect — connecting under a session, refusing roles that bypass RLS, the registry, the deferred signal, error translation (stage 2)
# context — sessions, service sign-in by key, the RLS policies of stage 1 (stage 1)
# access-rest — the remaining rows of stage 5: loading on behalf of a user, balance No. 20, 22, 29, upsert and { rev } under ACL, inlining of acl_ok (stage 5)
# aggregate — aggregates in the database: 20 writers of one wallet, raw SQL, a cascade, reclass, restore, the loader, account deletion, restore and rekey of the target, a description change under writes and race No. 18, aggregate_field, repair and verify, a System row (plan 1.1, stage 4b)
# acl — ACL permissions: the 0.21 suite ported, row conditions, weight and default deny, cascade, deny on a descendant, deep, an invisible target, raw SQL versus the library; a change of parent and alias of a class only with permissions on all its rows, an alias is not the name of another class, a name is not another class's alias (stage 5; security review No. 2)
# acl-parity — 1000 random rule sets: the database permission plan and endpoint decisions versus decide from 0.21 (stage 5)
# auth — credentials (password, key, key + secret, OTP, TOTP, identity), timing equalization, case, session revocation, recent sign-in (stage 5)
# balance — top-up and debit: idempotency by opId, races, deadlock, connection drop (TCP proxy), adjustment under { rev } and forUpdate (stage 4)
# chain-api — guards of the removed API, reserved names, build errors, the plan cache, onQuery (stage 3)
# chain-read — read chains on the demo domain: hops, roles, multiple ends, 18 operators, keyset, aggregates, deep, asOf, withDeleted, pivot (stage 3)
# chain-types — types of steps, rows and filters from models: connect({ models }) (stages 3, 4)
# chain-write — writing with chains: create, update, upsert, delete with preview, anonymize, reclass, slots, inc, { rev }, fan-out, plan rollback (stage 4)
# demo — the booking demo domain on Zod: seed from models, writing data, id by key, agreement between Zod and the database (stage 2)
# docs — documentation examples are executed: the marked blocks of the README and the cheatsheet (Russian and English) run as scenarios against PostgreSQL 18 (stage 8)
# engine-attacks — raw SQL attacks from the application role: the rows of §7.3.1 for stages 1 and 3 with specific outcomes; the signal key without permission, flooding with fake signals, Class included; writing to a derived class and a reference to it, a projector checkpoint through the credential functions; an agent through MCP without --write and without a human confirmation; a change of parent, alias and derivedBy of a class with the WRITE permission on Class alone, deleting and re-creating a class with a history of rows, a trial tightening as an oracle, reclass without DELETE and rewriting references deeper than the first level, a retention policy with the WRITE permission on Class alone; an agent through MCP grants a membership or a rule, a system administrator session; a tenant user creates a derived class on their own, `rekeyClass` of an ancestor of a derived class; moving a row in a way that would rewrite references of derived class rows; the application role holds advisory locks with the former keys of internal locks, while lock rows are out of its reach; a forged note of the family locks already taken (stages 1, 3; plan 1.1, stages 2, 4a, 5, checkpoint A, security review No. 2, checkpoint B and the work after it, security review No. 3)
# engine-class — classes as entities: metaschema, inheritance, recomputing descendants, tightening, metadata; a class with a history of rows is deleted only after purge() (stage 1; the work after checkpoint B)
# engine-write — the write pipeline in raw SQL: v5 ids, defaults, merge, inc, deletion, resurrection, journal, signals (stage 1)
# engine-races — races on two connections in both orders, without timed pauses; tightening during continuous writes to the family does not starve; locking families whose roots differ only in case, and a planted row of kind LOCK (stage 1; security review No. 3)
# explain — chain indexes from the application role: outside, the primary key and (class, tenant); inside find_*(), GIN; an asOf slice by class does not read another tenant's journal (stage 3; the work after checkpoint B)
# find-ids-parity — 30 chains through find_*() and through a direct read under RLS give the same answers; own memberships in other tenants and the Class rows of System — now, asOf and withDeleted (stage 3; the work after checkpoint B)
# hash — the version hash chain, journal tampering and gaps, verify() (stage 1)
# harness — the test harness: starting the database, a schema per file, two connection strings (stage 0)
# jsonschema — compiling JSON Schema to jsonpath and checking data in the database (stage 1)
# impersonation — impersonation: letopis.account only for a service with the permission, target restrictions, author and agent in the journal, sessionFor; the db.as() registry is one per tenant, does not empty, is re-read on a signal of its tenant (stage 5; the work after checkpoint B); the facade registry is not shared with the root, an empty registry is not cached (security review No. 3 leftovers)
# install — the installer and roles: a repeated installation, two installations in one database, three tables (stage 1)
# member — memberships: working in a tenant by roles, auth.switch, leaving with ownership transfer, system rows, tenant roles without System permissions (stage 5)
# model — Zod models, the JSON Schema normalizer, pattern translation, agreement with the database metaschema (stage 2)
# load — the loader: several classes, cycles, $key and $ext, repeats, existing, portions, history mode, the query for targets outside the load, CLI (stage 4)
# roles — roles and privileges: installation without a superuser, owner functions, triggers by catalog, the log without the changed column (stage 1; plan 1.1, checkpoint A)
# write-races — write races: 20 concurrent edits of different fields without losses and strict rev, concurrent add/remove on a multiple end, the loader versus class tightening and versus a concurrent edit (existing: update) in both orders (stage 4)
# validator-parity — the TypeScript validator versus the database check: the official suite, 10,000 random documents, defaults (stage 2)
# scenario-barbershop — end-to-end barbershop scenario: 9 scenes from 0.21 (integration) on 1.0 chains — catalog, free slots in a batch, bookings under lock, multi-slot and multi-specialist, versions, cancellation and booking again on the same id, closing a month with restrict (stage 4)
# scenario-real-life — the "real life" of a salon: 16 scenes from 0.21 (real-life) — a booking service on top of chains, races of double booking, rescheduling and cancellation, walk-in, refusals, reports and daily invariants (stage 4)
# system-classes — system classes instead of the 0.21 facades: the System seed, accounts, credentials, resources and rules, transactions (stage 5)
# sync — letopis sync (dry run, apply, tightening, lost refine) and letopis types (stage 2)
# tx — explicit db.begin() transactions: a broken transaction, lock(), 40P01; forUpdate(); the batch and its merging, a batch queue per facade; db.as(…, { owner }) (stage 4)
# v5 — v5 identifiers on the SQL side versus the vectors of an independent implementation (stage 1)
# zod-output — a snapshot of the z.toJSONSchema() output by field kind of the demo domain versus a reference (stage 0)
# time — history: versions({ follow }) across reclass and rekey, withDeleted, restore, purge, history trimming, account deletion (stage 6)
# rekey — a new key value of an object and a new key of a class: new ids, moving references, recursion through links with the end in the key (stage 6)
# reset — reset of sessions, tenant, all: the allowReset flag, the letopis.reset permission, confirmation by the schema name, the reset record, a new service key (stage 6)
# verify — legitimate gaps and tampering, verify({ data: true }): data, ends, tenants, id by key; permissions and CLI (stage 6)
# retention — retention policy: tiers, a finite term, special versions, deleted rows, asOf, cursor_expired, time zone, catch-up run, inheritance and default — versus a reference in TypeScript (stage 6)
# watch — cursor subscription: commit order, a long transaction, resuming, listener drop, two tenants (stage 6)
# cache — result cache: hits, own and others' writes, the key with the user, permissions, revoked sessions, listener drop, ttl, class marking, without LISTEN, a race, db.sql, the limit of signal counters (stage 6; plan 1.1, checkpoint A)
# maintain — maintenance: expired sessions and codes, permissions, one process under a lock, schedule (stage 6)
# up — the full installer: fresh installation, re-apply, custom seeds, automatic database creation, UTF8, version 17, upgrade with migrations, PGlite, the first tenant and user (up({ tenant }), createTenant) (stages 6, 8)
# upgrade — schema upgrade from 1.1.0 (re-apply) and from 1.0.1 (upgrade: true, migration 0006) with the letopis-11 and letopis-1 packages: versions and hashes written by the old engine, verify(), the catalog against a clean installation, lock rows, the application, a subscription and a projector over old data, a repeated up() (work after 1.2.0, stage 1)
# scenario-salon — end-to-end salon scenario: 21 acts from 0.21 (salon) with a coverage matrix of the 1.0 API (stage 6)
# telemetry — onQuery and slowMs, describe() and class metadata with inheritance, describeText (stage 6)
# history — diff and blame over the log, the reason of a change for verbs, db.begin() and batches; a version hidden by an ACL condition, the changed column, a missing version, row_changes over 20 thousand targets (plan 1.1, stage 1 and checkpoint A)
# signals — signal modes: the payload seen by a foreign role, cache precision per tenant, System, permission classes, a process without the key, the loader, subscriptions, the key, none, coalescing, the server version, a class change, a resend, the mode after up() and reset({ all }) (plan 1.1, stage 2)
# initial-load — the initial load: equality with the regular loader, structure and trigger modes, system rows, a non-empty schema, an insert during the start, rollback, MULTI_INSERT in WAL, commitEvery, import --initial, aggregates (agg_fill) (plan 1.1, stages 3 and 4b)
# projector — projectors from the journal: catching up, exactly once on a break, one writer, a long transaction, a transaction on the boundary of the rebuild snapshot, no writes to derived classes and no references to them, the bounds of out, atomic and batch rebuilds during source writes, purge of a source, lag and cursor_expired, the credential functions; the version, the name, an admin connection; a race of two processes; a data error of one tenant drops out only this tenant (failed, rebuild({ tenant }), the tenants option), the checkpoint is only a System row, a rebuild touches only the rows of participants and into families, before after rekey, the all tier and the journal of sources per tenant; folding of out.inc by key in a batch, batch rebuilds on the automatic paths of run() and a second process during them; rebuilding one tenant in batches while the tail goes on; onExpired in batches in another process, a data error without retries, the tier from the start of the rebuild; an empty last pass of a batch rebuild, a tenant that drops out in the middle of its rebuild keeps no partial rows, a class change that keeps the id out of the source family and into it, purge of an unread tombstone (plan 1.1, stage 4a; security review No. 2; checkpoint B and the work after it; security review No. 3)
# mcp — MCP tools: the model and meta only in results, tenant rights, the JSON chain and hints of similar names, row and byte limits with a cursor, the untrusted-data wrapper, writing only with write, update only with rev, deletion with a human confirmation (elicitation in revisions 2025 and 2026-07-28), the reason in blame, credentials, tool schemas, letopis without the SDK; letopis mcp over stdio, the HTTP handler; the confirmation window without the alias and meta, countBy and versions limited in the query itself, limits of steps and $or conditions; the permission classes only with allowAclWrite, a session in the System tenant only with allowSystemAdmin; structuredContent with a note, a requestState signature of the server user with an expiry (plan 1.1, stage 5; security review No. 2; checkpoint B and the work after it)
# import — import from 0.21 with a fixture of a real 0.21: key violation, --keyless, per-class counters, verify, self-reference, repeat, ids without a key, a dangling reference, $$strict and fields starting with $, update, credentials, CLI (stage 7)
# security-final — the final security review (stage 8, §7.10 No. 8.4): a family lock by the tenant of the root, account_purge without permission and restore/purge of a foreign id give neither a leak nor a lock; the functions of stage 6, log_refs_at, journal-based find_* reads and watch_read stay within their own tenant; NOTIFY carries only names or mode tokens; the cache key distinguishes the token, the actor and the tenant (stage 8)
```
