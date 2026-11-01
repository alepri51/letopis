# Contributing to letopis

Russian version — [CONTRIBUTING.md](CONTRIBUTING.md).

## What is where

- `lib/` — the `letopis` npm package: code (`src`), the engine in the database (`sql`), tests (`test`), benchmarks
  (`bench`), package documentation (`README.md`, the cheat sheet for agents, `CHANGELOG.md`).
- `guide/` — the documentation site with executable examples, local only and in Russian.
- `services/` — four sample services on letopis and the `services/compose.yaml` stand.
- `docs/` — check reports and the code atlas (`docs/atlas`); `reports/` — plans.
- The project map for people and agents is [AGENTS.md](AGENTS.md): modules, processes, what to change where.

## Requirements

- Node 22 or newer, Git.
- Docker: the tests start a PostgreSQL 18 container themselves (`letopis-pg18`, port 15433).

## How to run

```sh
cd lib && npm ci && npm test                         # library tests
cd guide && npm ci && npm run examples -- --check    # site examples against snapshots
docker compose -f services/compose.yaml up --build   # the site and services on 127.0.0.1:8080–8084
```

## Before a pull request

CI runs no tests: everything that checks behavior runs locally as one command.

```sh
cd lib && npm run prerelease
```

The steps run in order, and the first red one stops the run.

## Rules

- **A fix.** A test for a fix is named after its test-plan item (for example, "plan 2.0, 7.3 No. 1") and fails without
  the fix. The test checks behavior through the public API on a real PostgreSQL, not the internals.
- **Package documentation.** It is bilingual: a change to `lib/README.md` or the cheat sheet needs the same change in
  the English version. `cd lib && npm run check:docs` checks this.
- **The API contract.** Changed exports, methods or error texts — `cd lib && npm run api:contract`.
- **Versions.** The rules are in the "Versions and compatibility" section of `lib/README.en.md`; `npm run check:semver`
  checks the version step.
- **CHANGELOG.** A change to the core (the library and SQL) ends with the source of the finding: test, example, service,
  review, soak or adoption.
- **Branches.** Work happens on `dev`; `main` gets only pull requests from `dev`. The owner makes releases.

## Report a bug or an adoption

- A bug — an issue from the template: letopis, PostgreSQL and Node versions, a minimal chain, `err.code` and the error
  text.
- An adoption — a report using the form [docs/adoption/TEMPLATE.md](docs/adoption/TEMPLATE.md).
