# letopis (летопись, "chronicle")

[Русский](README.md)

A versioned entity store on **PostgreSQL 18** for Node.js. The database itself enforces integrity, history, tenant
isolation and access rules: triggers and RLS policies apply both to the library and to raw SQL.
Every change is a version in the journal (`versions`, `asOf`, cursor subscriptions), the graph is traversed with
chains, classes are described with Zod models and stored in the database, and sign-in, sessions and access rules are
built in.

```bash
npm install letopis zod
```

<!-- run -->
```ts
import { up, connect } from 'letopis'

const ADMIN = 'postgres://postgres:secret@localhost:5432/app'   // admin: installs the schema
const APP = 'postgres://app:app-secret@localhost:5432/app'      // application: a role that is a member of letopis_app

// schema v2.salon with the salon demo domain (seeds), the first tenant and its user
const r = await up({ dsn: ADMIN, schema: 'salon', seeds: ['booking'],
  tenant: { name: 'Salon', user: { name: 'Anna', login: 'anna@salon.ru', password: 'Lilac-2026!' } } })
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: r.serviceKey! })   // r.serviceKey is the service key
const login = await svc.auth.verifyPassword({ identifier: 'anna@salon.ru', password: 'Lilac-2026!' })
const db = await svc.as(login!.account, { tenant: r.tenant!.tenant })             // on behalf of Anna in her salon

const [org] = await db.Org().create({ name: 'Mira Street Salon' }).rows()
const [vasya] = await db.Org(org).Staff().create({ name: 'Vasya', phone: '+7 900' }).rows()
const services = await db.Staff(vasya).skill().Service().rows()                  // paths through the graph
const earlier = await db.Org(org).Staff().asOf('2026-10-01T00:00:00Z').count()    // snapshot as of a date
await svc.close()
```

ESM, Node 22 or newer. One runtime dependency: `postgres`; Zod 4 is an optional peer dependency for describing
models (`letopis/model`). TimescaleDB, Redis and Docker are not needed. MIT license.

## Where to go next

| I want | File |
|---|---|
| **to get started quickly / I am an AI agent** | [`lib/AGENT-CHEATSHEET.en.md`](lib/AGENT-CHEATSHEET.en.md) — the working cycle on one page and common mistakes (shipped in the package); [`lib/llms.txt`](lib/llms.txt) — an index for language models |
| to learn by example | [`guide/`](guide/) (in Russian) — the documentation site for people: chapters with runnable examples (the data after every step), diagrams and four sample services; local only — `cd guide && npm install && npm run dev` (http://127.0.0.1:5173) or the stand `docker compose -f services/compose.yaml up --build` (site with the sandbox — http://127.0.0.1:8080, services — 8081–8084) |
| the full guide | [`lib/README.en.md`](lib/README.en.md) — by task: quick start, installation, model, writing, reading, transactions and money, loading, sign-in and access rules, history, subscription, operations; API reference, errors, limitations |
| to move from 0.21 | [`lib/MIGRATION.md`](lib/MIGRATION.md) (in Russian) — data import and the API replacement table |
| to see what changed | [`lib/CHANGELOG.md`](lib/CHANGELOG.md) (in Russian) — the source of truth for the version, together with `lib/package.json` |
| a machine-readable API contract | [`docs/api-contract.json`](docs/api-contract.json) — exports, chain methods, error texts, removed names (generated) |
| a comparison with alternatives | [`COMPARISON.md`](COMPARISON.md) |
| to work on the library itself | [`AGENTS.md`](AGENTS.md) — the project map for an agent (atlas): modules, scenario traces, protocol |

## Repository layout

```
lib/            ← the npm package itself (src, sql, scripts, test, bench) and its documentation
docs/atlas/     ← scenario traces (F-*); module cards are in .claude/rules/atlas/ (M-*)
db/             ← the repository script apply.mjs, a wrapper around up() for CI
```

The package is `lib/`; there is no `package.json` at the repository root.

## Development

```bash
cd lib
npm ci
npm run typecheck        # tsc --noEmit
npm run check:docs       # check the documentation against the code (versions, links, anchors, test list, API contract, names, English versions)
npm test                 # the whole suite against a live PostgreSQL 18, including running the documentation examples
npm run prerelease       # everything before a push and a release: tests, site examples, sandbox, service scenarios, package
```

The tests are integration tests, without database mocks: the harness starts the `letopis-pg18` container
(`postgres:18`, port 15433) by itself if the database does not respond. `ENTITY_DSN` and `ENTITY_APP_DSN` override the
connections. CI runs no tests — they run locally with `npm run prerelease`. How to contribute —
[CONTRIBUTING.en.md](CONTRIBUTING.en.md).
