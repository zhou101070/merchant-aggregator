# 独角数卡（Dujiao-Next）商品同步技术方案

| 字段 | 值 |
| --- | --- |
| 状态 | M1 已实现（client / identify / 同步管线 / 库存刷新） |
| 日期 | 2026-07-18 |
| 参考站 | https://flyai.qzz.io/ |
| 优先级 | P1（平台族扩展，次于 shopApi） |
| 覆盖 | 本库 `collector_kind=dujiao` 约 23 家 · offer 约 266 |

---

## 1. 背景与目标

### 1.1 现状

- 本应用仅对 **shopApi 白标族**（`ldxp` / `catfk`）做店内商品深刮。
- `collector_kind=dujiao` 的商家已能识别为「独角数卡」，但 `scrapeStrategy=unsupported`，无本地 `shop_products`。
- PriceAI 主档仍有 offer 摘要，但缺实时库存、全量 SKU 价、分类等店内字段。

### 1.2 目标

1. 对 **Dujiao-Next** 部署站实现与 shopApi 同级的商品深刮（列表 + 入库 + 可选单品库存刷新）。
2. 复用现有 `ShopScraper` / `NormalizedShopProductRow` / `sync-orchestrator` 管线，不另起同步引擎。
3. 识别与路由按 **族（family）** 适配，不为每家店写专用爬虫。

### 1.3 非目标（本方案不做）

- 下单、支付、查单、登录会话。
- 经典 Laravel 版 `assimon/dujiaoka` 全兼容（见 §8；当前样本几乎全是 Next）。
- 把 23 个 host 写进静态 `SHOP_PROFILES` 白名单（形态与 shopApi 不同，见 §4）。

---

## 2. 样本调研结论

### 2.1 产品族判定

| 项目 | 结论 |
| --- | --- |
| 开源上游 | 原版 [assimon/dujiaoka](https://github.com/assimon/dujiaoka)（Laravel）已停更，官方指向 **Dujiao-Next** |
| flyai.qzz.io | Vue SPA + `/api/v1`；`app_version=v1.2.2`；站点名「AI开发商」 |
| 同库其它 dujiao 店 | 抽测 18 家可访问站 **全部** 响应 `GET /api/v1/public/config` + `GET /api/v1/public/products`，字段核心一致 |
| 版本跨度 | `v1.0.0`～`v1.6.6` 及带 `-security` 后缀；有扩展字段，核心列表字段稳定 |
| 经典 `/api/goods` | 样本中基本 404；**不要**按旧 Laravel 路由实现 |

### 2.2 公开 API（已实测）

统一前缀：`{origin}/api/v1`

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| GET | `/public/config` | 指纹、站名、币种、版本 | 探测「是否 Next」的首选 |
| GET | `/public/products` | **全量商品列表** | 样本无分页参数；一次返回全部（约 2～20 条） |
| GET | `/public/products/:slug` | 单品详情 | 形状与列表项基本一致；适合库存刷新 |
| GET | `/public/categories` | 分类列表 | 可选；列表项已嵌 `category` |

前台页面路径（SPA，与 API 不同）：

| 页面 | 路径 | 示例 |
| --- | --- | --- |
| 商品列表（整店） | `{origin}/products` | https://flyai.qzz.io/products |
| 商品详情 | `{origin}/products/{slug}` | https://flyai.qzz.io/products/xxx |

响应信封（全站一致）：

```json
{ "status_code": 0, "msg": "success", "data": ... }
```

- 成功：`status_code === 0`
- 与 shopApi 的 `{ code: 1, data }` **不同**，适配器内单独解析

### 2.3 商品列表字段（核心）

列表项稳定字段（flyai 及多数站）：

| 字段 | 类型/说明 |
| --- | --- |
| `id` | number，站内商品 ID |
| `slug` | string，URL 键（详情与外链用） |
| `title` | i18n 对象 `{ "zh-CN", "zh-TW", "en-US" }` |
| `description` / `content` | i18n；content 常为 HTML |
| `price_amount` | string 数字，如 `"129.00"` |
| `images` | string[]，常为站内相对路径 `/uploads/...` |
| `category_id` / `category` | 分类；`category.name` 亦为 i18n |
| `tags` | string[] |
| `purchase_type` | 如 `guest` |
| `fulfillment_type` | `auto` / 人工等 |
| `min_purchase_quantity` / `max_purchase_quantity` | number |
| `manual_stock_available` | number |
| `auto_stock_available` | number |
| `stock_status` | `in_stock` / `low_stock` / `out_of_stock` / … |
| `is_sold_out` | boolean |
| `skus` | SKU 数组（见下） |

扩展字段（部分版本/站）：`promotion_rules`、`wholesale_prices`、`payment_channel_ids`、`stock_display` / `stock_display_mode` / `stock_quantity_hidden`、`sold_count` 等——**解析时忽略未知字段即可**。

### 2.4 SKU

```json
{
  "id": 11,
  "sku_code": "微軟信箱 代RT",
  "spec_values": { "zh-CN": "微軟信箱 代RT 附Json" },
  "price_amount": "10.00",
  "manual_stock_total": 0,
  "manual_stock_sold": 0,
  "auto_stock_available": 7,
  "upstream_stock": 0,
  "is_active": true
}
```

注意：

- 部分站 **商品级** 有 `manual_stock_available`，SKU 级只有 total/sold；库存要以 **SKU 级 available + 商品级 fallback** 合并计算。
- 多 SKU 常见（如 burstpro：13 商品中 8 个多规格），且 **SKU 价差大**（例：10 vs 18、16.8 vs 110）→ 比价场景应 **按 SKU 展开行**，不能只存商品最低/最高价。

### 2.5 跨站可达性（2026-07-18 抽测）

| 结果 | 站点数（约） | 说明 |
| --- | --- | --- |
| Next API 正常 | 18+ | 含 flyai、ultra.makelove.cloud、burstpro、xtacc、gmail91、morimm 等 |
| 403 / 宕机 / 非 JSON | 少数 | 如 shop.auto-subscribe.com 403；部分历史上健康状态为 failing 的站 |
| 仅 SPA 壳无 API | 极少数 | 同步时记失败，不拖垮批任务 |

### 2.6 合规与访问策略

- `robots.txt` 对 `/api/` 为 `Disallow`（站点声明面向公共爬虫）。
- 本应用为 **个人桌面本地聚合**，请求频率应对齐现有 shop 限速（默认 ≥500ms 间隔），禁止并发扫全站。
- 不抓管理端、不绕过登录、不破解验证码；只用 `public/*`。
- Cloudflare 等 WAF：沿用 `mainFetch` + 浏览器态 UA；遇 challenge 抛 `NEED_BROWSER`（与 shopApi 一致）。

---

## 3. 与现有架构的契合点

| 现有组件 | 作用 | dujiao 接入方式 |
| --- | --- | --- |
| `identifyShopPlatform` | 族识别 + 是否可刮 | `dujiao`：`unsupported` → `dujiao` 策略且 scrapable |
| `ShopScraper` / `registry` | 适配器分发 | 新增 `dujiaoScraper` |
| `NormalizedShopProductRow` | 入库行 | 直接映射，无需改表 |
| `sync-orchestrator` | 任务/进度/取消 | `resolveShopTarget` 支持 host 型 ref |
| `ProductStockService` | 单品刷库存 | 走 `GET .../public/products/:slug` |
| `SCRAPABLE_SQL` | `shop_platform + shop_token` 非空 | 写入 `platform=dujiao` + `token=host` |

`registry.ts` 已预留注释：*Formal adapter interface for future non-shopApi families (D11)*。

---

## 4. 身份模型（关键设计）

### 4.1 与 shopApi 的差异

| | shopApi（ldxp/catfk） | Dujiao-Next |
| --- | --- | --- |
| 部署形态 | 多租户，共享 host | **一店一域名** |
| 凭证 | URL path 中的 `token` | **无 token**；`origin/host` 即店 |
| Profile | 静态 `SHOP_PROFILES` 白名单 host | 不宜把 23 个 host 写死进 profiles |
| 商品 URL | `/item/{goodsKey}` | `/products/{slug}` |

### 4.2 推荐编码（复用现有列）

| 字段 | 取值 | 理由 |
| --- | --- | --- |
| `shop_platform` | `dujiao` | 与 family / UI 标签一致 |
| `shop_token` | **规范化 hostname**（小写、去尾点） | 满足 scrapable 条件；UNIQUE 维度沿用 `(platform, token)` |
| `source`（shop_products） | `dujiao` | 与 platform 对齐 |
| `source_shop_token` | 同上 hostname | 与 merchant 对齐，便于 `findByShopRef` |
| `source_goods_key` | 见 §5.3 | 商品/SKU 唯一键 |
| `source_url` | `{origin}/products/{slug}` | 外链打开 |

`baseUrl` 运行时由 `https://${host}` 推导（若 merchant `entry_url`/`shop_url` 带 path，只取 origin）。样本中存在 `http://shop.whh985.com`：以入口 URL 的 scheme 为准，缺省 https。

### 4.3 识别优先级（建议）

1. 已存 `shop_platform=dujiao` + 非空 `shop_token`（host）→ 可刮  
2. `shop_url` / `entry_url` 可解析 host，且（可选）探测 config 成功 → 可刮并回写 ref  
3. 仅有 `collector_kind=dujiao` + host → **可刮**（高置信；与当前「仅标注不可刮」不同）  
4. 探测失败 / 非 Next 响应 → 保持不可刮或任务失败信息

> 与 shopApi 不同：dujiao **不需要** path token；`collector_kind=dujiao` + 有效 host 即可进入队列。

### 4.4 `ScrapeStrategy` 扩展

```ts
type ScrapeStrategy = 'shopapi' | 'dujiao' | 'unsupported' | 'none'
```

- `identityToScrapeRef`：strategy 为 `shopapi` **或** `dujiao` 时返回 `{ platformId, token }`  
- `isIdentityScrapable`：同步放宽  
- `scraperForIdentity`：`dujiao` → `scrapeDujiao(...)`

**不**把 `dujiao` 塞进 `ShopFamily = 'shopapi'` 的静态 profile 模型；可：

- A. `platformId` 固定字面量 `dujiao`，scraper 用 `token` 当 host（推荐，改动面小）  
- B. 引入 `DujiaoSiteTarget { baseUrl, host }` 扩展 `ShopScrapeTarget`（更清晰，略多类型改动）

推荐 **A + target 上可选 `baseUrl`/`label`**，避免 23 条假 profile。

---

## 5. 数据映射

### 5.1 文案 i18n

```ts
function pickI18n(obj: Record<string, string> | null | undefined): string {
  if (!obj) return ''
  return (obj['zh-CN'] || obj['zh-TW'] || obj['en-US'] || Object.values(obj).find(Boolean) || '').trim()
}
```

### 5.2 库存

```ts
function productStock(p): number {
  // 优先商品级 available
  const top = num(p.auto_stock_available) + num(p.manual_stock_available)
  if (top > 0) return top
  // 回退 SKU 合计（含 upstream_stock）
  let sum = 0
  for (const s of p.skus ?? []) {
    if (s.is_active === false) continue
    sum += num(s.auto_stock_available) + num(s.manual_stock_available) + num(s.upstream_stock)
    // 部分站仅 manual_stock_total - sold
    if (sum === 0 && s.manual_stock_total != null) {
      sum += Math.max(0, num(s.manual_stock_total) - num(s.manual_stock_sold))
    }
  }
  return sum
}
```

过滤策略（对齐 shopApi）：

- **仅入库 `stock > 0`** 的行；`is_sold_out===true` 或算得 0 则跳过。  
- `stock_quantity_hidden===true` 时：若 available 仍为数字则用之；若完全无数字仅有 `in_stock`，记 `stock=1`（有货占位）或跳过——**实现时默认：无正数库存则跳过**，避免假库存污染比价。

### 5.3 行粒度：按 SKU 展开（推荐）

| 场景 | `source_goods_key` | `title` | `price` / `stock` |
| --- | --- | --- | --- |
| 单 SKU 或空 skus | `slug` | 商品 title | 商品价 / 商品库存 |
| 多 SKU 且 `is_active` | `{slug}#{sku.id}` | `{title} · {spec}` | SKU 价 / SKU 库存 |

- `id`：`dujiao:{host}:{source_goods_key}`  
- 非 active SKU 丢弃  
- 同步结束对应该 merchant 的 **旧 key 清理** 策略：与 shopApi 批同步一致（全量替换该 token 下商品，或 diff 删除缺失 key——以现有 orchestrator 行为为准，不另开语义）

### 5.4 其它字段

| Normalized 字段 | 来源 |
| --- | --- |
| `shop_name` | `config.brand.site_name` 或 merchant.name |
| `currency` | `config.currency`（缺省 `CNY`） |
| `category_id` | `category_id` |
| `category_name` | `pickI18n(category.name)` |
| `image` | `images[0]`，相对路径拼 `origin` |
| `description_text` | `stripHtml(pickI18n(content) || pickI18n(description))` |
| `description_html` | 可选存 `pickI18n(content)` |
| `goods_type` | `fulfillment_type` 或固定 `dujiao` |
| `market_price` | 有 promotion 再议；MVP 置 null |
| `raw_json` | 原始 product（或 product+sku）JSON 字符串 |
| `fetched_at` | ISO now |

---

## 6. 模块设计

建议目录：

```
src/main/platforms/dujiao/
  client.ts      # HTTP：config / products / productBySlug
  normalize.ts   # → NormalizedShopProductRow[]
  scraper.ts     # scrapeDujiao：config → products → normalize
  zod.ts         # 宽松 schema（未知字段透传）
  __tests__/
    normalize.test.ts
    client.fixture.json
```

### 6.1 Client 行为

- `IntervalLimiter`（默认 500ms，复用 settings 的 shop 间隔）  
- Headers：浏览器 JSON Accept + UA + `Referer: {origin}/`  
- `status_code !== 0` → `AppError('NETWORK', msg)`  
- 非 JSON / 空 body / HTML challenge → 与 shopApi 同类错误码  
- **不需要** shop 页 warmup cookie（样本 public API 无 cookie 依赖）；若遇 403 可再加 document warmup 作为降级

### 6.2 Scrape 流程

```
1. GET /public/config     → shopName, currency, 确认 Next
2. onProgress phase=config
3. GET /public/products   → list
4. normalize → rows (filter stock>0)
5. onProgress phase=products current=rows.length
6. return { rows, shopName, goodsCount: list.length }
```

商品量级极小（通常 <50），**不必**分页；若未来 `data` 变为分页对象，再扩展 `page` 参数（防御：若 `data` 非数组则报 schema 错误）。

### 6.3 库存刷新

`ProductStockService`：

- 若 `source===dujiao'`：解析 `source_goods_key` 得 slug（`#` 前），`GET /public/products/:slug`  
- 再 normalize 对应 SKU 行；无货则 delete 本地行（与 shopApi 一致）

### 6.4 商家主档回写

在 PriceAI 商家同步 normalize 之后，或独立「标记可刮」步骤：

```
if collector_kind == 'dujiao' && host:
  shop_platform = 'dujiao'
  shop_token = normalizeHost(host)
```

这样 UI 批刮队列（`SCRAPABLE_SQL`）自动纳入，无需用户手填。

可选：首次批刮前轻量 `HEAD/GET config` 过滤已挂站，减少失败噪声。

---

## 7. 同步编排改动清单

| 文件/区域 | 改动 |
| --- | --- |
| `identify.ts` | dujiao → strategy `dujiao`、scrapable 规则、`identityToScrapeRef` |
| `registry.ts` | 分发 `dujiao` scraper |
| `sync-orchestrator.ts` | resolve 时带 host；错误码与 PAUSED 语义 |
| `priceai/normalize` 或 merchants upsert | 回写 `shop_platform/token` |
| `product-stock-service.ts` | dujiao 分支 |
| `shop-types` / UI 文案 | platform 筛选出现「独角数卡」而非「其他」 |
| 测试 | identify / normalize / orchestrator resolve |

**预计不改**：SQLite schema、搜索 SQL 主路径、IPC 协议形状。

---

## 8. 风险与边界

| 风险 | 缓解 |
| --- | --- |
| 版本字段漂移 | zod 宽松 + 只依赖核心字段；单测夹 fixture |
| 多 SKU 库存字段不一致 | §5.2 合并公式 + fixture 覆盖 burstpro / txyxt / ccdawang |
| 站挂 / 403 | 单店失败不中断批任务；记 job message |
| 混入非 Next 的「独角」旧站 | config 探测失败则 skip；日志 `not dujiao-next` |
| 假库存（隐藏数量） | 默认无正数不入库 |
| robots / 站方限流 | 单店串行 + 全局间隔；个人用 |
| host 变更 | token=host，换域即新店；旧商品残留靠 merchant 维度清理或手动 |

经典 dujiaoka（Laravel 模板 HTML / 旧 API）若后续出现：

- 另开 `dujiao_legacy` 或 HTML 适配，**不要**硬塞进 Next client。  
- 当前库内 healthy 样本表明 Next 已是主流。

---

## 9. 实现分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M1 MVP** | client + normalize + scraper；identify/registry/orchestrator；商家 ref 回写；单测 | 对 flyai.qzz.io 同步后本地有货商品可搜可比价 |
| **M2** | 单品库存刷新；批刮纳入 dujiao 计数文案 | 刷新后 OOS 删除、有货更新 |
| **M3** | 多 SKU 展开打磨；promotion/批发价可选 | burstpro 等多规格价正确 |
| **M4**（可选） | 启动/同步时 config 探测缓存；失败分类 | failing 站不反复重试 |

---

## 10. 建议默认决策（待确认）

1. **平台 ID**：`dujiao`（不叫 `dujiao-next`，避免与 PriceAI collector 分裂）。  
2. **token**：hostname。  
3. **粒度**：按 SKU 展开。  
4. **库存**：仅 `stock>0` 入库。  
5. **探测**：MVP 可信 `collector_kind` + host，不强制每次 config 探测；失败再报错。  
6. **不**把各店 host 写入 `SHOP_PROFILES`。

---

## 11. 附录：flyai.qzz.io 实测摘要

```
GET /api/v1/public/config
  status_code=0
  app_version=v1.2.2
  brand.site_name=AI开发商
  currency=CNY

GET /api/v1/public/products
  17 条
  有货约 2（其余 is_sold_out / out_of_stock）

GET /api/v1/public/products/7
  详情可用；slug 可为数字字符串

前端路由: /products, /products/:slug, /categories/:slug
sitemap 含商品 loc，可作人工核对，同步不依赖 sitemap
```

---

## 12. 参考

- 适配器接口：`src/main/platforms/registry.ts`  
- 识别：`src/shared/platforms/identify.ts`  
- shopApi 对照实现：`src/main/platforms/shopapi/*`  
- 上游：Dujiao-Next（dujiao-next.com）；归档原版 assimon/dujiaoka  
- 样本：库内 `collector_kind=dujiao` 商家（host / entry_url）
