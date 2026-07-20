# AGENTS.md — Merchant Aggregator

Personal Electron desktop app: sync merchant catalogs + shop products into **local SQLite**, search/compare offline. **Search never hits the network**; all HTTP is user-initiated sync (or explicit stock refresh).

## Stack & package manager

- **pnpm** only (`pnpm-lock.yaml`). Registry mirrors in `.npmrc` (npmmirror).
- Electron 39 + electron-vite + React 19 + better-sqlite3 + Vitest + Zod.
- No UI component library — custom CSS in `src/renderer/src/styles/`.

## Commands

| Command | Notes |
| --- | --- |
| `pnpm install` | postinstall rebuilds native deps for Electron |
| `pnpm dev` | rebuilds `better-sqlite3` for Electron ABI, then electron-vite dev |
| `pnpm test` | rebuilds for **Node** ABI → vitest → rebuilds back to Electron |
| `pnpm test <filter>` | e.g. `pnpm test src/main/services` (args passed through `scripts/run-tests.mjs`) |
| `pnpm typecheck` | `typecheck:node` then `typecheck:web` (tests excluded from both tsconfigs) |
| `pnpm lint` | eslint with cache |
| `pnpm format` | prettier write |
| `pnpm build` | typecheck + electron-vite build |

**Native module gotcha:** `better-sqlite3` must match the runtime ABI. If Node/Electron load fails, close the app and run `pnpm run rebuild:native:node` or `rebuild:native:electron`. Prefer `pnpm test` / `pnpm dev` over bare `vitest` so rebuild order is correct.

## Layout (where to change what)

```
src/main/          Electron main: window, DB, platforms, sync, IPC handlers
  db/              schema.sql.ts, migrate.ts, repositories/*
  platforms/       priceai · shopapi · dujiao · yiciyuan · registry
  services/        sync-orchestrator, search-service, http-client, pools…
  ipc/register.ts  all ipcMain.handle wiring
src/preload/       exposes window.api (typed RendererApi)
src/renderer/      React pages/components/hooks; HashRouter
src/shared/        types, constants, platform profiles, pure search/match libs
docs/              PRODUCT.md · DESIGN.md · POOL-SYNC-STRATEGY.md · DUJIAO-PRODUCT-SYNC.md
```

Aliases: `@shared/*` → `src/shared/*`; `@renderer/*` → `src/renderer/src/*` (renderer only).

## Cross-process contracts (do not invent)

1. **IPC surface of truth:** `src/shared/types/ipc.ts` (`IPC_CHANNELS` + `RendererApi`).
2. **Preload:** `src/preload/api.ts` must match those channels.
3. **Handlers:** `src/main/ipc/register.ts`.
4. Renderer talks only via `window.api` — never import main/db/electron from renderer.

## Domain sources of truth

| Concern | File |
| --- | --- |
| Shop site profiles (hosts, paths, enabled) | `src/shared/platforms/shop-profiles.ts` — **only** place for scrape hosts |
| Platform id / URL identity | `src/shared/platforms/identify.ts` |
| Scraper dispatch | `src/main/platforms/registry.ts` |
| Defaults / rate limits / schema version | `src/shared/constants.ts` (`DB_SCHEMA_VERSION` currently **12**) |
| Schema + migrations | `src/main/db/schema.sql.ts` + `migrate.ts` — bump version in constants + add migrate step + tests |
| Search ranking / query parse | `src/shared/lib/search-query.ts`, `search-rank.ts`, `shop-product-match.ts` |
| Settings shape / coalesce | `src/shared/types/settings.ts` |

Scrapable families today: **shopapi** (`ldxp`, `catfk` via profiles) + **dujiao** / **yiciyuan** (`EXTRA_SCRAPABLE_PLATFORM_IDS`). Adding a shopapi white-label = new profile entry; other families need a scraper + registry wiring.

DB path: Electron `userData/merchant-aggregator.db`. Tests use `:memory:` or temp files via `openDatabase`.

## Product / compliance constraints agents break easily

- **No auto-network on search path.** Sync jobs and explicit stock refresh only.
- Do not add accounts, cloud sync, checkout/payment, write APIs to remote shops, or public data APIs.
- External links go through allowlist / `evaluateOpenExternal` (`src/main/utils/url-safety.ts`).
- UI copy: short, neutral Chinese tool language (see `docs/PRODUCT.md`). Design tokens / anti-slop rules in `docs/DESIGN.md` — no new UI frameworks, no gradient/glass aesthetics.
- Sync pool architecture notes: `docs/POOL-SYNC-STRATEGY.md` (implemented; trust code if docs drift).

## Style (repo-specific)

- Prettier: single quotes, **no semicolons**, printWidth 100, trailingComma none.
- Prefer existing patterns: repositories for SQL, Zod at network edges, `AppError` for typed failures.
- ESLint: `react-hooks/set-state-in-effect` is intentionally **warn** (data-fetch effects start with sync `setLoading(true)`).
- `**/*.mjs` scripts skip explicit return-type rule.

## Tests

- Location: colocated `*.test.ts` / `*.spec.ts` or `__tests__/` under `src/`.
- Env: Node (not jsdom). Vitest aliases `@shared` only.
- After schema/migrate changes, run `pnpm test src/main/db` (and relevant repo tests).
- Full gate before packaging: `pnpm typecheck && pnpm lint && pnpm test`.

## Env / release

- `.env` is gitignored; only documented var is `GH_TOKEN` (gh / electron-builder publish) — not required for local dev.
- `MA_SCREENSHOT_DIR` + optional `MA_THEME=dark|light` enable design screenshot mode in main (`pnpm dev`).
- `MA_CHROMIUM_VERBOSE=1` restores full Chromium logs.

## Do not

- Commit `.env`, secrets, or rewrite native rebuild scripts without keeping Node↔Electron ABI restore semantics.
- Duplicate host lists outside `shop-profiles.ts`.
- Trust README schema version numbers over `DB_SCHEMA_VERSION` in code.
- Run bare `vitest` for DB/native tests without Node rebuild if you just used Electron.
