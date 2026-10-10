# letopis 1.0

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
- **History**: versions, point-in-time reads, restoring deleted data, retention policy, hash chain verification —
  [section 11](#11-history-and-point-in-time-reads).
- **Tenants, sign-in and permissions** in the database itself: passwords, API keys, one-time codes, TOTP, sessions,
  impersonation, access rules — [section 10](#10-users-sign-in-and-permissions).
- **Change subscription** by cursor without losses, and a **result cache** — [section 12](#12-change-subscription-and-cache).
- **Bulk loading** of millions of rows and **import from 0.21** — [sections 9](#9-bulk-loading) and [14](#14-migrating-from-021).

Requirements:

- PostgreSQL 18 or newer with the pgcrypto extension (it is part of the standard distribution), and a database in UTF8
  encoding.
- Node.js 22 or newer; the package is an ES module.
- One runtime dependency: `postgres`. Zod 4 is an optional peer dependency: only the `letopis/model` subpath needs it,
  and `import { connect } from 'letopis'` works without it. For development without PostgreSQL there are the optional
  `@electric-sql/pglite` and `@electric-sql/pglite-socket`.

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
time, kind of operation and hash. `secret` holds credentials and sessions: the application sees none of its rows; only
the sign-in functions work with it.

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

A write reports changes through `NOTIFY` on the schema channel. Raw SQL sends the signal from a trigger, and PostgreSQL
delivers it on commit. Library transactions defer their signals: the process notifier sends them every 100 ms
(`notifyIntervalMs`) and retries the ones that failed to send. What a write signal carries is set by the installation
mode `up({ signals })`:

| Mode | Write signal | What any role that can connect to the database sees |
|---|---|---|
| `class` (default) | the class name: `Booking` | class names and write times |
| `tenant` | the class name and a tenant token: `Booking@3f9c…` | also tenant pseudonyms |
| `opaque` | a class token and a tenant token | only write times and frequency per pseudonym |
| `none` | no signals | nothing |

A revoked session sends `session:<start of the token hash>`, a reset sends `*`; signals carry no ids and no data. A
token is a keyed HMAC: only a process with the signal key can match a pseudonym to a name, and the key is given to
services (the `letopis.signals` permission). On signals, the class registry is re-read, the result cache is cleared
and subscriptions wake up; what the mode changes for the cache and subscriptions is in
[section 12](#12-change-subscription-and-cache).

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
connection (`allowBypassRls: true`) is needed only for the loader, verification and maintenance; keep it in a separate
process, not in the web application.

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

The loader needs a connection of a role that can become the owner, with `allowBypassRls: true`. `verify()` and
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

The schema has an engine revision (currently 5). If a new package version brings a new revision, `connect()` only warns
and names the command. It is `up()` that refuses: a lagging schema without `upgrade: true`, and a schema newer than the
package. So a startup script that calls `up()` on every start will stop after a package update until it gets
`upgrade: true`. `up({ dsn, schema, upgrade: true })` applies the migrations from `sql/migrate/` and re-applies the
functions; the data is kept.

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
  ([section 11](#11-history-and-point-in-time-reads)).
- `ownerDefault: 'actor'`: the owner of new rows is the user, not the tenant (the default is `'tenant'`). This is
  useful for the rule "everyone sees their own records".
- `cache: { ttl }`: reads of this class alone are cached without `.cache()` ([section 12](#12-change-subscription-and-cache)).
- `meta`: free-form metadata for the application: a title, an icon, a color, an order in a menu. Up to 64 KB,
  inherited key by key (`null` removes an inherited value), visible to anyone who has a session. For an end, use
  `.meta()`.

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
- `db.rekeyClass(class, key)` sets a new key for all rows of the family, in one transaction.
- `reclass(class, data)` changes the class; the data is optional, and if given, it is given whole. If the new class has
  no key, the id is kept (as for `vip` above); if it has one, the id is computed anew and the references are moved.
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

The database computes aggregates over the entities of the last step.

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
version 1, a `purge` record stays with the number of erased versions. The history of system classes is not erased. To
delete an account, use `db.auth.purgeAccount` ([section 10](#10-users-sign-in-and-permissions)).

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
set by `syncModels`).

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

- `diff()` returns one item per object of the step: `{ id, class, from, to, changes }`, where a change is
  `{ path, kind, before, after }`, `kind` is `added`, `removed` or `changed`, and the path starts with the section of
  the row: `data`, `links`, `tags`, `owner`, `class`. Data objects are compared by keys, arrays as a whole; a
  multi-valued end and tags element by element. If the object did not exist at `from`, every path is `added`; if it
  was deleted at `to`, `to.deleted` is `true`.
- `blame()` returns `{ id, class, rev, complete, fields }`: for every leaf, the version that changed it last,
  `author`, `agent`, `op`, `reason` and `exact`. `exact: false` means the history before that version is incomplete
  (thinned, trimmed or partly invisible), so the real change may be older. `complete: true` means the whole history
  was scanned without gaps; by default at most the 1000 latest versions are scanned.
- The database computes both with the caller's rights: raw SQL gets the same, `select "v2.shop".blame('<id>')`,
  `select "v2.shop".diff_versions('<id>')`.

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
  write made right after `db.watch()` may commit earlier and miss the stream. That is why the example above reads from
  `'start'`.
- `classes`: only these classes with their descendants; `pollMs`: fallback polling (1000 ms).
- Events come without losses or repeats, under the reader's permissions, in the order of transaction numbers, and
  within a transaction in the order of writing. This is not the commit order: compare versions of one object by `rev`.
- A long write transaction in any database of the cluster delays the stream: `await sub.lag()` shows the lag in ms.
- A cursor older than the `all` tier of the retention policy gives `cursor_expired`: read the current state again and
  subscribe with `'now'`.
- Without `LISTEN` (`connect({ listen: false })`), the subscription polls the journal.
- A subscription without losses is a saved cursor: store `ev.cursor` of the last processed event and resume from it
  after a restart.

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
transaction, and the first thing it does is take a transaction-level advisory lock (`pg_try_advisory_xact_lock`),
which is released when the batch commits. If another process holds the lock, the call answers `skipped: true` before
the first batch, and between batches it stops (that process continues) and reports what it has done with
`more: true`. There is no session-level lock, so `maintain()` works behind any pool, including PgBouncer in
transaction mode.

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
metadata, plus the multi-field conditions `anyOf` and `oneOf` with inheritance applied, when a class has them. From
the command line: `letopis describe --format text --out llms.txt`.

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
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify]
letopis verify --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--data]
letopis maintain --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--batches <N>]
letopis describe --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--format json|text] [--out <file>]
letopis import --from <0.21 dsn> --from-schema <v1.name> --dsn <dsn> --schema <v2.name> [--tenant <name>] [--keyless <Class>]…
  [--rename <Old>=<New>]… [--update] [--commit-every <N>] [--partition <name>]
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
| `letopis` | `connect`, `up`, `createTenant`; operators `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `inList`, `like`, `ilike`, `starts`, `ends`, `has`, `hasAny`, `hasAll`, `exists`, `isNull`, `not`, `or`, `isOp`; `inc`, `isInc`, `cursorOf`; `idOf`, `uuidv5`, `v5Name`, `v5Id`; `LetopisError`, `ValidationError`, `fromDbError`; `syncModels`, `generateTypes`, `schemaToTs`; `compileValidator`, `applyDefaults`, `Registry`; `totpCode`, `hashPassword`, `verifyHash`; `describeText`; constants `DDL_REVISION`, `RESERVED_CLASS_NAMES`, `CHAIN_METHODS`, `DB_METHODS`; types `Db`, `DbTx`, `TypedDb`, `Chain`, `Row`, `Filter`, `Cursor`, `ConnectOptions`, `UpOptions`, `LoadOptions`, `LoadReport`, `WatchOptions`, `WatchEvent`, `AuthApi`, `AclApi` and others |
| `letopis/model` | `hub`, `link`, `one`, `many`, `End`, types `Infer`, `InferLinks`, `Model`, `ClassDef`, `ClassMeta`, `HistoryPolicy`; `normalizeSchema`, `translatePattern`, type `JsonSchema` |
| CLI `letopis` | `sync`, `types`, `load`, `verify`, `maintain`, `describe`, `import` ([section 13](#13-operations)) |

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
| terminals | `rows()`, `first()`, `ids()`, `count({ paths })`, `paths()`, `versions({ follow })`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`, `countBy(field)` |

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
  `schema`, `token`, `tenant`, `trimHistory`, `rekeyClass`, `cache`; guards: `reloadSchema`, `accounts`,
  `credentials`, `resources`, `rules`, `compact`;
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
| `invalid_class` | LT010 | the class description is rejected, the class is not found or is abstract |
| `use_reclass`, `reclass_denied` | LT011, LT012 | changing the class with `update` when the old or the new class has a key: the id changes, so use `reclass()`; the roles of referencing rows do not accept the new class |
| `tightening_conflict` | LT013 | rows prevent tightening the description |
| `isolation_level` | LT014 | deleting, changing the class and changing the key work only in `read committed` |
| `recreated_in_statement` | LT015 | an id was deleted and created again in one statement |
| `cursor_expired` | LT016 | the subscription cursor is older than the `all` tier of the retention policy |
| `delete_restricted` | LT017 | referencing rows prevent the deletion (`onDelete: 'restrict'`) |
| `not_deleted` | LT018 | `restore` and `purge` work only for deleted objects |
| `reset_disabled` | LT019 | reset is disabled in the installation (`allowReset`) |
| `confirm_mismatch` | LT020 | the reset confirmation does not match the schema name |

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
| `admin_required` | the loader needs an admin connection |
| `class_not_loadable` | the loader does not accept `Class` rows |
| `bypass_rls` | `connect()` with a role that bypasses RLS, without `allowBypassRls` |
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

## 18. Limitations

This section lists what letopis 1.0 deliberately does not do or does with caveats, and where you need to watch the
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

**Writing and integrity**

- Row-by-row writing costs more than a plain insert: triggers check every row (data, ends, id, journal, hash, RLS).
  Row-by-row `create` is 12–18% slower than 0.21 ([section 17](#17-performance)); for bulk writing there is the loader.
- Deleting, changing the class and changing the key work only in `read committed` (`isolation_level`); library
  transactions always open at this level.
- PostgreSQL does not run `COPY` into tables under RLS; bulk loading works only through the loader on an admin
  connection.
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
- The number of invisible rows that block a deletion, and the existence of an account by id (as a reference target),
  are not hidden.
- Class metadata (`meta`) is visible to anyone who has a session: anyone can read `Class` rows. Secrets do not belong
  there.
- An application role can slow the installation down for everyone: `LOCK TABLE entity`, advisory locks with
  predictable keys, fake `NOTIFY` signals (they only clear the cache), frequent permission changes (one counter row per
  installation). The global journal number reveals the overall write activity.

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
- The subscription horizon is shared by the whole cluster: a long write transaction delays the events of all
  subscribers (`sub.lag()`); long operations are better done in batches.
- Between processes, the result cache goes stale for the signal sending interval (100 ms) plus delivery, and for the
  time of a listener reconnect: postgres.js does not report a broken listener connection, so the cache works until the
  reconnect and is cleared completely after it. The `ttl` term is a safeguard.
- A "from now" subscription cursor carries a snapshot of the subscription moment until it passes that boundary: such a
  cursor is longer than a regular one.

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
# acl — ACL permissions: the 0.21 suite ported, row conditions, weight and default deny, cascade, deny on a descendant, deep, an invisible target, raw SQL versus the library (stage 5)
# acl-parity — 1000 random rule sets: the database permission plan and endpoint decisions versus decide from 0.21 (stage 5)
# auth — credentials (password, key, key + secret, OTP, TOTP, identity), timing equalization, case, session revocation, recent sign-in (stage 5)
# balance — top-up and debit: idempotency by opId, races, deadlock, connection drop (TCP proxy), adjustment under { rev } and forUpdate (stage 4)
# chain-api — guards of the removed API, reserved names, build errors, the plan cache, onQuery (stage 3)
# chain-read — read chains on the demo domain: hops, roles, multiple ends, 18 operators, keyset, aggregates, deep, asOf, withDeleted, pivot (stage 3)
# chain-types — types of steps, rows and filters from models: connect({ models }) (stages 3, 4)
# chain-write — writing with chains: create, update, upsert, delete with preview, anonymize, reclass, slots, inc, { rev }, fan-out, plan rollback (stage 4)
# demo — the booking demo domain on Zod: seed from models, writing data, id by key, agreement between Zod and the database (stage 2)
# docs — documentation examples are executed: the marked blocks of the README and the cheatsheet (Russian and English) run as scenarios against PostgreSQL 18 (stage 8)
# engine-attacks — raw SQL attacks from the application role: the rows of §7.3.1 for stages 1 and 3 with specific outcomes; the signal key without permission, flooding with fake signals (stages 1, 3; plan 1.1, stage 2)
# engine-class — classes as entities: metaschema, inheritance, recomputing descendants, tightening, metadata (stage 1)
# engine-write — the write pipeline in raw SQL: v5 ids, defaults, merge, inc, deletion, resurrection, journal, signals (stage 1)
# engine-races — races on two connections in both orders, without timed pauses (stage 1)
# explain — chain indexes from the application role: outside, the primary key and (class, tenant); inside find_*(), GIN (stage 3)
# find-ids-parity — 30 chains through find_*() and through a direct read under RLS give the same answers (stage 3)
# hash — the version hash chain, journal tampering and gaps, verify() (stage 1)
# harness — the test harness: starting the database, a schema per file, two connection strings (stage 0)
# jsonschema — compiling JSON Schema to jsonpath and checking data in the database (stage 1)
# impersonation — impersonation: letopis.account only for a service with the permission, target restrictions, author and agent in the journal, sessionFor (stage 5)
# install — the installer and roles: a repeated installation, two installations in one database, three tables (stage 1)
# member — memberships: working in a tenant by roles, auth.switch, leaving with ownership transfer, system rows, tenant roles without System permissions (stage 5)
# model — Zod models, the JSON Schema normalizer, pattern translation, agreement with the database metaschema (stage 2)
# load — the loader: several classes, cycles, $key and $ext, repeats, existing, portions, history mode, the query for targets outside the load, CLI (stage 4)
# roles — roles and privileges: installation without a superuser, owner functions, triggers by catalog (stage 1)
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
# cache — result cache: hits, own and others' writes, the key with the user, permissions, revoked sessions, listener drop, ttl, class marking, without LISTEN, a race, db.sql (stage 6)
# maintain — maintenance: expired sessions and codes, permissions, one process under a lock, schedule (stage 6)
# up — the full installer: fresh installation, re-apply, custom seeds, automatic database creation, UTF8, version 17, upgrade with migrations, PGlite, the first tenant and user (up({ tenant }), createTenant) (stages 6, 8)
# scenario-salon — end-to-end salon scenario: 21 acts from 0.21 (salon) with a coverage matrix of the 1.0 API (stage 6)
# telemetry — onQuery and slowMs, describe() and class metadata with inheritance, describeText (stage 6)
# history — diff and blame over the log, the reason of a change for verbs, db.begin() and batches (plan 1.1, stage 1)
# signals — signal modes: the payload seen by a foreign role, cache precision per tenant, System, permission classes, a process without the key, the loader, subscriptions, the key, none, coalescing, the server version, a class change, a resend, the mode after up() and reset({ all }) (plan 1.1, stage 2)
# import — import from 0.21 with a fixture of a real 0.21: key violation, --keyless, per-class counters, verify, self-reference, repeat, ids without a key, a dangling reference, $$strict and fields starting with $, update, credentials, CLI (stage 7)
# security-final — the final security review (stage 8, §7.10 No. 8.4): a family lock by the tenant of the root, account_purge without permission and restore/purge of a foreign id give neither a leak nor a lock; the functions of stage 6, log_refs_at, journal-based find_* reads and watch_read stay within their own tenant; NOTIFY carries only names or mode tokens; the cache key distinguishes the token, the actor and the tenant (stage 8)
```
