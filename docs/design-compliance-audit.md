# Design Compliance Audit — Multi-platform Shop Scrape

| Field | Value |
|---|---|
| **Design source of truth** | `docs/multi-platform-shop-scrape-design.md` (R2) |
| **Codebase root** | `/Users/zhouhuang/Documents/myCode/merchant-aggregator` |
| **Audit date** | 2026-07-17 |
| **Auditor** | Compliance agent (static code review) |
| **Method** | Full design read + targeted codebase verification of D1–D20 and non-decision requirements |

---

## Summary

- **Overall:** **mostly compliant → fixes applied 2026-07-17 (post-audit remediations)**
- **Remediation pass:** Favorites §8/D20 refresh, registry item URLs, neutral UI copy, `scrapableOnly`, health SCRAPABLE_SQL, resolve priority, NETWORK non-JSON, `requestedJobType` on progress, `ShopScraper` interface, strict enabled filter.
- **Still deferred by design:** PR6 catfk `enabled:false` until smoke; PR7 alias cleanup.

Architecture (registry SSOT, host-gated parse, DB v4 scrapable SQL, `ShopApiClient(profile)`, orchestrator `shop_*` jobs/lane, catfk `enabled:false`, wrong-platform bugfix) is landed.

---

## Checklist

| ID | Requirement | Status | Evidence (file:symbol) | Gap |
|---|---|---|---|---|
| **D1** | Registry + Family Adapter (`ShopSiteProfile` + shopapi) | ✅ met | `src/shared/platforms/shop-profiles.ts:SHOP_PROFILES`; `src/main/platforms/registry.ts:scrapeShopTarget`; `src/main/platforms/shopapi/*` | — |
| **D2** | `LdxpClient` → `ShopApiClient(profile)`; no host-if / `profile.id` branches in client | ✅ met | `src/main/platforms/shopapi/client.ts:ShopApiClient`; thin alias `LdxpClient`; `src/main/platforms/ldxp/client.ts` re-export | No `profile.id ===` / host switches in client body |
| **D3** | `shop_platform` + `shop_token`; PR2 force scrapable SQL; dual-write `ldxp_token` only for ldxp | ✅ met | `merchants-repo.ts:SCRAPABLE_SQL`; `migrate.ts` v4; `normalize.ts:deriveShopRef` (`ldxp_token` null when non-ldxp) | — |
| **D4** | Product id `{sourceId}:{token}:{goods_key}`; `source = profile.sourceId` | ✅ met | `shopapi/scraper.ts:normalizeGoods` (`id = \`${source}:${token}:${key}\``) | — |
| **D5** | Canonical `shop_*`; insert-time normalize; progress with canonical (+ optional requested) | ⚠️ partial | `shared/types/sync.ts:normalizeJobType`; `sync-orchestrator.ts:start` stores canonical + `meta.requestedJobType` | `SyncProgressEvent` / `emitProgress` **omit** `requestedJobType` (design optional, not wired) |
| **D6** | Lane `'ldxp'` → `'shop'` | ✅ met | `sync-orchestrator.ts:Lane`, `lanesFor` | — |
| **D7** | Manual `shopUrl` → parse only; never fetch user URL as root | ✅ met | `sync-orchestrator.ts:resolveShopTarget`; `ShopApiClient` uses `profile.baseUrl` + paths | — |
| **D8** | Settings get coalesce / set dual-write | ✅ met | `shared/types/settings.ts:coalesceAppSettings`, `dualWriteSettingsPatch`; `settings-repo.ts:get/set` | — |
| **D9** | `CATFK_PROFILE.enabled=false` + `probeStatus:'unverified'` until PR6 | ✅ met | `shop-profiles.ts:CATFK_PROFILE` | Intentional; smoke script exists but profile still disabled |
| **D10** | Search/Favorites `platformId`+`shopToken`; no token-only refresh; no item URL as shopUrl | ⚠️ partial | Search: `search-service.ts` maps `platformId: row.source`; `SearchPage.tsx:refreshShop` uses platformId+token. Favorites: `favorites-repo.ts` selects `s.source` | Favorites **batch refresh requires `merchantId`** (`FavoritesPage.tsx:refreshableIds`); orphans / platform+token-only path not implemented (§8 / D10) |
| **D11** | `ShopScraper` interface; orchestrator not bound to HTTP JSON | ⚠️ partial | Runtime path: `registry.ts:scrapeShopTarget` + family switch | No formal `ShopScraper` / `main/platforms/types.ts` as designed; only shopapi path |
| **D12** | No synthetic merchants; orphan `merchant_id=null` | ✅ met | Scraper accepts null merchantId; no auto-create merchant in orchestrator | — |
| **D13** | Always store canonical `shop_*`; alias in meta | ✅ met | `sync-orchestrator.ts:start` insert `jobType` after normalize; `meta.requestedJobType` | — |
| **D14** | Orphan re-link one-shot UPDATE on scrape with merchantId | ✅ met | `merchants-repo.ts:relinkShopProducts`; called from `runShopQueue` when `target.merchantId` set | — |
| **D15** | `enabled===false`: parse OK; batch skip; explicit `shop_one` → PAUSED | ✅ met | Parse uses all profiles; `start` PAUSED if `!profile.enabled`; `shop_all`/`bootstrap` filter `enabledIds` | `shop_selected` uses `p?.enabled !== false` (unknown platform id would pass) — mild |
| **D16** | `shop_all` only scrapable merchants + enabled profile | ✅ met | `runJob` shop_all branch filters `enabledIds.includes(m.shopPlatform)` | Orphans correctly excluded |
| **D17** | `shopScrapeEnabled=false`: pure shop PAUSED; bootstrap merchants OK, skip deep scrape | ✅ met | `start` gate for `isShopJob`; bootstrap branch `shopSkipped: true` | Meta key `shopSkipped` vs design `shopScrapeSkipped` (naming only) |
| **D18** | Profile SSOT `src/shared/platforms/shop-profiles.ts` | ✅ met | Shared profiles; `registry.ts` re-exports | No automated `mainHosts === sharedHosts` equality test found (design optional) |
| **D19** | derive null → preserve existing shop_*/ldxp_token | ✅ met | `normalize.ts:_shopRefDerived`; UPSERT CASE on `@shop_ref_derived` | — |
| **D20** | Refresh: `shop_one` + `{platformId,token}`; never item `sourceUrl` as shopUrl | ⚠️ partial | `SearchPage.tsx:refreshShop`; `MerchantsPage` single-shop start | Favorites batch: `shop_selected` by merchantId only — not D20 platformId+token; no single-favorite shop refresh |
| **ND-01** | Host-gated `parseShopUrl` (unknown host / path-only / bare → null) | ✅ met | `url-parse.ts:parseShopUrl`; tests `url-parse.test.ts` | — |
| **ND-02** | `parseLdxpShopToken` must not attribute catfk | ✅ met | `url-parse.ts:parseLdxpShopToken`; test expects null for catfk URL | — |
| **ND-03** | Scrapable SQL fully on shop_* (no residual ldxp_token as sole gate) | ⚠️ partial | List/count/candidates/NEEDS_SYNC use `SCRAPABLE_SQL` | `deriveAppHealthStatus` still `shop_token \|\| ldxp_token` without requiring `shop_platform`; Search merchant_health CASE ORs `ldxp_token` |
| **ND-04** | DB schema v4 / `DB_SCHEMA_VERSION = 4` | ✅ met | `constants.ts:DB_SCHEMA_VERSION`; `migrate.ts` v4 block; tests | Index name `idx_merchants_shop_ref` vs design `idx_merchants_shop_platform_token` (cosmetic) |
| **ND-05** | Settings dual-key + allowlist catfk | ✅ met | `constants.ts:DEFAULT_ALLOWLIST_HOSTS`; settings dual-write | — |
| **ND-06** | Job `lastSuccessAt` alias merge | ✅ met | `sync.ts:mergeLastSuccessAt`; applied in `getStatus` | Repo raw `lastSuccessAt()` unmerged — OK if all reads go through orchestrator |
| **ND-07** | SearchHit selects `s.source` → platformId | ✅ met | `search-service.ts:SHOP_SELECT` + hit map | Field named `shopGoodsKey` not design `sourceGoodsKey` (semantic dual-fill OK) |
| **ND-08** | UI shopUrl entry (Sync Center) | ✅ met | `SyncCenterPage.tsx:scrapeByUrl` → `start('shop_one', { shopUrl })` | — |
| **ND-09** | No host-if / catfk string outside profiles in adapters | ⚠️ partial | Client/scraper clean | **Renderer** `FavoritesPage.tsx:recentItemUrl` hardcodes `catfk` / `pay.ldxp.cn`; confirm-sync hardcodes pay.ldxp.cn |
| **ND-10** | Empty body → `NETWORK` (R1) | ⚠️ partial | `client.ts` empty body → NETWORK | Non-JSON body still `SCHEMA_VALIDATION` (design: empty **or** non-JSON → NETWORK) |
| **ND-11** | `resolveShopTarget` priority & merchant lazy backfill | ⚠️ partial | Priority: shopUrl → **merchantId** → platformId+token → bare token→ldxp | Design order is shopUrl → platformId+token → merchantId → bare; **no** lazy `parseShopUrl(shop_url\|entry_url)` + shop_* backfill |
| **ND-12** | `setAppHealthByShopRef`; no cross-platform token health | ✅ met | `merchants-repo.ts:setAppHealthByShopRef`; queue uses it; `setAppHealthByToken` deprecated → ldxp | — |
| **ND-13** | MerchantListQuery `scrapableOnly` (+ deprecated ldxpOnly) | ❌ missing | Only `ldxpOnly?: boolean` in `merchant.ts`; list filter still `query.ldxpOnly` | No `scrapableOnly` alias field |
| **ND-14** | UI neutral copy (「可深刮」/ 已注册发卡网; not ldxp-only promises) | ❌ missing | `confirm-sync.ts` still “ldxp / pay.ldxp.cn”; `MerchantsPage` “仅 ldxp”, “同步全部 ldxp” | Design §11 / PR5 incomplete |
| **ND-15** | Favorites external link via registry `itemUrl` when no source_url | ❌ missing | `FavoritesPage.tsx:recentItemUrl` if/else host strings | Should use profile `itemPageUrl` / registry (D18 spirit) |
| **ND-16** | Favorites batch refresh §8: dedupe (platformId, shopToken); orphan OK | ❌ missing | Requires merchantId + `startLdxpSelected` only | Orphans dropped; not platform-aware multi-one queue |
| **ND-17** | `requestedJobType` on progress events | ⚠️ partial | Stored in job meta only | Not on `SyncProgressEvent` type or emit |
| **ND-18** | PR6 catfk enable after smoke | ➖ n/a | `scripts/smoke-catfk-shop.mjs` present; profile still `enabled:false` | Deferred by design until smoke green |
| **ND-19** | PR7 alias cleanup | ➖ n/a | Legacy aliases still present by design | Deferred |
| **ND-20** | Formal `ShopScraper` / future families | ➖ n/a | Family switch only shopapi | Future non-shopApi deferred (Non-Goals) |

---

## Critical violations

Items that contradict **no patch-style** architecture or that could still **mis-scrape catfk as ldxp**:

### 1. UI host/platform branching (patch-style) — medium

Design anti-patch rule: hosts/base URLs live only in `shop-profiles.ts`; adapters must not branch on host/`profile.id`.

| Location | Behavior |
|---|---|
| `src/renderer/src/pages/FavoritesPage.tsx:recentItemUrl` | `if (source === 'ldxp') return 'https://pay.ldxp.cn/item/…'` / `if (source === 'catfk') return 'https://catfk.com/item/…'` |
| `src/renderer/src/lib/confirm-sync.ts` | Hardcodes “ldxp 店铺” / “串行访问 pay.ldxp.cn” |

These do not drive HTTP scrape targets (SSRF risk low), but they reintroduce **per-platform string tables** outside the SSOT and will rot as platforms grow.

### 2. Wrong-platform scrape risk — largely fixed; residual footguns — medium/low

| Path | Status |
|---|---|
| PriceAI `deriveLdxpToken` any `/shop/` → ldxp_token | **Fixed** via `deriveShopRef` + host-gated parse |
| `parseLdxpShopToken(catfk URL)` | **Fixed** → null |
| Search refresh token-only | **Fixed** — requires `platformId` |
| Bare `token` without platformId | **Still defaults ldxp** (by design for legacy IPC). Multi-platform UI must not use this; Search complies; Favorites batch avoids tokens |
| Merchants detail `platformId: selected.shopPlatform \|\| 'ldxp'` | Safe when dual-fill is consistent; fails open to ldxp if only token present without platform |

**No remaining main-process path was found that writes catfk tokens into `ldxp_token` or scrapes catfk hosts via `pay.ldxp.cn`.** Residual risk is legacy bare-token IPC / incomplete UI platform fields.

### 3. Orphan product re-scrape from Favorites — functional gap (not mis-scrape)

Design §8 / D10 / D20: favorites refresh must work with `{ platformId, shopToken }` without merchantId. Current UI filters `merchantId` required → **orphans never refresh**, and multi-platform is only OK when merchant rows exist. Does not mis-attribute platforms, but **violates re-scrape contract**.

---

## Deferred by design

| Item | Design stance | Code state |
|---|---|---|
| `CATFK_PROFILE.enabled` | false until PR6 smoke | `enabled: false`, `probeStatus: 'unverified'` |
| PR6 fixtures / enable flip | After smoke | Smoke script present; profile not flipped |
| PR7 alias cleanup | Optional after stable | `ldxp_*` jobs, settings keys, method aliases retained |
| kami / dujiao adapters | Non-goal | Not present |
| DROP `ldxp_token` column | Out of scope | Column kept + dual-write |
| SearchHit remove deprecated aliases | +1 version | dual-fill still present |
| Manual “关联商家” UI | Non-goal | Not present (re-link SQL only) |

---

## Recommended fix list (by severity)

1. **High — Favorites refresh contract (D10/D20/§8)**  
   - Collect unique `{ platformId, shopToken, merchantId? }` from favorites (including orphans).  
   - Issue `shop_one` per pair (or queue) with platformId+token; **do not** require merchantId.  
   - Stop relying solely on `startLdxpSelected(merchantIds)`.

2. **High — UI patch hosts (ND-09/ND-15)**  
   - Replace `FavoritesPage.recentItemUrl` hardcodes with shared `itemPageUrl(findProfileById(source), goodsKey)`.  
   - Prefer `source_url` when present (already for favorites table via `f.sourceUrl`).

3. **Medium — Neutral multi-platform UI copy (ND-14 / PR5)**  
   - `confirm-sync.ts`: “已注册发卡网 / 可深刮店铺”, not “ldxp only / pay.ldxp.cn only”.  
   - MerchantsPage: rename chip “仅可深刮”, counts “可刮店铺”, actions “同步全部可刮店铺”; wire `scrapableOnly` (or keep `ldxpOnly` as deprecated dual-key).

4. **Medium — API surface completeness (ND-13)**  
   - Add `MerchantListQuery.scrapableOnly` (alias of `ldxpOnly`) and prefer it in IPC/UI.

5. **Medium — Health / scrapable consistency (ND-03)**  
   - Align `deriveAppHealthStatus` and Search `merchant_health` CASE with full `SCRAPABLE_SQL` (require `shop_platform` + `shop_token`).  
   - Avoid treating bare `ldxp_token` as scrapable for health scoring after v4 backfill.

6. **Low — `resolveShopTarget` parity (ND-11)**  
   - Match design priority: shopUrl → platformId+token → merchantId → bare token.  
   - Optional: when merchant has shop_url but empty shop_*, parse + lazy backfill shop_* if enabled.

7. **Low — Error mapping (ND-10)**  
   - Map non-JSON shop responses to `NETWORK` (design R1), keep snippet in details.

8. **Low — Progress event optional field (D5/ND-17)**  
   - Add `requestedJobType?` to `SyncProgressEvent` and `emitProgress` for old-entry UX.

9. **Low — shop_selected enabled filter**  
   - Use `getProfile(id)?.enabled === true` (strict) instead of `!== false`.

10. **Low — Formal `ShopScraper` type (D11)**  
    - Extract interface for future families; keep current function adapter.

11. **Deferred — PR6**  
    - Run `scripts/smoke-catfk-shop.mjs`; on success set `enabled: true`, `probeStatus: 'ok'`, add fixtures.

12. **Deferred — PR7**  
    - Deprecate residual `ldxp_*` IPC/UI names after multi-platform UX is stable.

---

## PR Plan coverage (implementation vs design)

| PR | Design intent | Observed code state |
|---|---|---|
| **PR1** Profiles + parseShopUrl | Landed | `shop-profiles.ts`, `shop-types.ts`, `url-parse.ts` + tests |
| **PR2** DB v4 + scrapable + deriveShopRef | Landed | migrate v4, SCRAPABLE_SQL, deriveShopRef + tests |
| **PR3** ShopApiClient/scraper | Landed | `shopapi/*`, ldxp re-exports |
| **PR4a** Types / settings / jobs / Search / Favorites fields | Mostly landed | Types, dual settings, normalize jobs, Search/Favorites fields |
| **PR4b** Orchestrator multi-platform | Landed | resolve, runShopQueue, health-by-ref, relink, D15–D17 |
| **PR5** UI multi-platform | **Partial** | SyncCenter URL + Search D20 OK; Merchants/Favorites/confirm copy incomplete |
| **PR6** catfk enable | Deferred | Smoke script only; `enabled:false` |
| **PR7** Cleanup | Deferred | Aliases retained |

---

## Verification notes / not fully exercised

- No runtime/integration scrape against live catfk or ldxp was executed in this audit (static review only).  
- `scraperFor` throwing PAUSED when disabled is implemented at `scrapeShopApi` + orchestrator `start`, not as a separate named `scraperFor` export matching the design snippet.  
- Whether all UI entry points avoid bare-token `shop_one` was checked for Search / Merchants / SyncCenter / Favorites; other callers (if any) not found.  
- Index rename and meta key renames treated as cosmetic unless product depends on exact strings.

---

## Appendix — design quotes vs code (spot checks)

| Design quote (abbrev.) | Code |
|---|---|
| “禁止 host-if / profile.id 散落分支；profile 单源” | Client clean; Favorites UI violates |
| “默认 CATFK_PROFILE.enabled=false” | `shop-profiles.ts` L40 |
| “可刮 SQL 全部切 shop_*” | `SCRAPABLE_SQL` in merchants-repo |
| “insert 前 normalize 为 canonical” | `normalizeJobType` in `start` |
| “刷新禁止 token-only … 永不 hit.sourceUrl” | SearchPage `refreshShop` |
| “orphan re-link one-shot UPDATE” | `relinkShopProducts` |
| “empty body → NETWORK” | Empty yes; invalid JSON still SCHEMA_VALIDATION |
