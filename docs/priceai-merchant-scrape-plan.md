# PriceAI 商家数据采集可行性方案

> 目标页面：`https://priceai.cc/channels?scope=merchants`  
> 调研日期：2026-07-17  
> 状态：**可行（推荐 API 分页拉取，无需浏览器渲染）**

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| 是否可拿到商家列表 | **可以** |
| 是否可拿到商家信息 | **可以**，列表接口字段已较完整 |
| 推荐方式 | 调用 `GET /api/merchants` 分页拉取（`limit` + `offset`） |
| 是否需要 Playwright/Electron 渲染 | **不需要**（首期） |
| 全量规模 | 约 **333** 家商家（调研时点） |
| 全量耗时 | `limit=100` 分页约 **4 次请求 / ~8s**（含 300ms 间隔） |
| 单页上限 | `limit` 最大约 **200**（`250+` 返回 400） |
| 详情接口 | **无** `/api/merchants/:id`，列表行即主数据 |
| 报价关联 | `GET /api/offers` 可用；按商家过滤不稳定，建议本地用 `sourceId` / `sourceStoreName` 关联 |

**一句话方案**：以 `https://priceai.cc/api/merchants` 为主数据源，分页拉全量商家入库；报价/商品明细用 `https://priceai.cc/api/offers` + `https://priceai.cc/api/explorer` 做补充，在本地按 `sourceId` / 店名做关联。

---

## 2. 目标页面与站点结构

### 2.1 页面行为

- 站点：PriceAI（卡网订阅比价），技术栈 **Next.js**（Cloudflare / OpenNext）
- 页面 ` /channels?scope=merchants` 为前端路由；商家数据 **不依赖 HTML 表格硬爬**
- 前端 chunk 中明确存在：

```js
// 伪代码（来自 channels page bundle）
async function fetchMerchants(params, offset, signal) {
  const n = new URLSearchParams(params)
  n.set('limit', String(30))
  n.set('offset', String(offset))
  const res = await fetch(`/api/merchants?${n}`, { signal })
  return res.json()
}
```

- 同源 `fetch`，无鉴权 Cookie 要求（公开读）

### 2.2 相关公开接口（实测）

| 接口 | 用途 | 实测 |
|---|---|---|
| `GET /api/merchants` | 商家列表（本方案核心） | ✅ 200 + JSON |
| `GET /api/offers` | 报价列表（商品 × 渠道） | ✅ 200 + JSON，总量约 6500+ |
| `GET /api/explorer` | 标准商品目录 + 最低价摘要 | ✅ 200 + JSON |
| `POST /api/submissions` | 用户提交渠道（写接口） | 存在，**不在爬取范围** |
| `GET /api/merchants/:id` | 商家详情 | ❌ 404 |
| `GET /api/products` | 商品列表 | ❌ 404 |

### 2.3 robots.txt 注意

```
Disallow: /api/
Disallow: /*?*scope=
```

- 对通用爬虫明确禁止 `/api/`
- **技术上接口可访问**，但自动化抓取存在合规/ToS 风险
- 产品侧建议：
  1. 控制频率、使用可识别 UA
  2. 缓存结果，避免高频打满
  3. 仅用于聚合展示与比价参考，不镜像整站
  4. 后续评估是否可申请官方合作 / 数据授权

---

## 3. 商家接口契约（实测）

### 3.1 请求

```http
GET https://priceai.cc/api/merchants?limit=100&offset=0
Accept: application/json
User-Agent: MerchantAggregator/0.1 (+local research)
```

**查询参数（已验证）**

| 参数 | 说明 | 实测 |
|---|---|---|
| `limit` | 每页条数 | 默认 30；最大约 **200**；≥250 → 400 |
| `offset` | 偏移 | 支持；`offset=330` 可取到末页 |
| `q` | 关键词搜索 | ✅ 如 `q=陆柒` → total=1 |
| `platform` | 平台过滤 | ✅ `platform=ChatGPT` → total 约 270 |
| `sort` / `healthStatus` | 排序/健康状态 | 传参不报错，但排序效果不明显，**勿依赖** |
| `page` | 页码 | 忽略（仍按默认 offset） |

### 3.2 响应结构

```json
{
  "rows": [ /* Merchant[] */ ],
  "total": 333,
  "message": null,
  "degraded": false,
  "generatedAt": "2026-07-17T05:52:07.748+00:00",
  "limited": true,
  "limit": 100,
  "offset": 0
}
```

| 字段 | 含义 |
|---|---|
| `rows` | 本页商家 |
| `total` | 全量总数 |
| `limited` | 是否还有后续页（末页为 `false` 或 rows 不足 limit） |
| `degraded` | 后端降级标记；为 `true` 时数据可能不完整，应重试/告警 |
| `generatedAt` | 数据生成时间，可用于增量判断 |

### 3.3 商家对象字段（列表即主档）

| 字段 | 类型 | 含义 | 覆盖率（333 样本） |
|---|---|---|---|
| `id` | string | 稳定商家 ID，如 `merchant-41c7…` | 100% |
| `name` / `storeName` | string | 店铺名 | 100% |
| `host` | string \| null | 店铺域名 | 约 89%（214+ 有值；36 为 null） |
| `shopUrl` / `entryUrl` | string | 店铺入口 URL | shopUrl 约 89% |
| `sourceId` | string | 源站标识（关联报价关键） | 约 89%（unique ~298） |
| `sourceName` | string | 源站展示名 | 高 |
| `collectorKind` / `collectorGroup` / `collectorLabel` | string | 采集器类型 | 有 null |
| `healthStatus` | string | `healthy` / `failing` / `retrying` / `unknown` / null | healthy≈269, failing≈20 |
| `offerCount` | number | 报价数 | 100% |
| `inStockCount` / `outOfStockCount` | number | 有货/缺货数 | 100% |
| `productCount` / `platformCount` | number | 商品数 / 平台数 | 100% |
| `platforms` | string[] | 如 ChatGPT、Claude、Gemini… | 100% |
| `productTypes` | string[] | 成品账号、订阅/会员、接码… | 100% |
| `representativeProduct` | string | 代表商品 | 高 |
| `representativeOfferTitle` | string | 代表报价标题 | 高 |
| `representativePrice` | number | 代表价 | 高 |
| `representativeCurrency` | string | 通常 `CNY` | 高 |
| `lowestHitCount` / `warrantyLowestHitCount` | number | 最低价命中相关统计 | 100% |
| `riskFeedbackCount` | number | 风险反馈数 | 100% |
| `hasPlatformAftersalesMechanism` | boolean | 是否有平台售后机制 | 100% |
| `shopCreatedAt` | string \| null | 店铺创建时间 | 约 64%（214/333） |
| `includedAt` | string | 纳入 PriceAI 时间 | 高 |
| `lastSuccessAt` / `latestSeenAt` | string | 最近采集成功 / 见到时间 | 高 |
| `observationStartedAt` | string | 观测开始 | 高 |
| `consecutiveFailures` | number | 连续失败次数 | 100% |

**示例（截断）**

```json
{
  "id": "merchant-41c7037cc0c7151045308a4cb1d116f1",
  "name": "奥特曼严选",
  "storeName": "奥特曼严选",
  "host": "pay.ldxp.cn",
  "shopUrl": "https://pay.ldxp.cn/shop/PAXOVOVJ",
  "entryUrl": "https://pay.ldxp.cn/shop/PAXOVOVJ",
  "sourceId": "ldxp-paxovovj",
  "sourceName": "链动小铺 / PAXOVOVJ",
  "collectorKind": "shopApi",
  "healthStatus": "healthy",
  "offerCount": 196,
  "inStockCount": 136,
  "outOfStockCount": 60,
  "productCount": 21,
  "platforms": ["ChatGPT", "Claude", "Gemini", "Grok", "其他", "接码", "邮箱"],
  "productTypes": ["API额度", "其他", "工具账号", "成品账号", "接码/验证", "虚拟卡", "订阅/会员", "邮箱/账号"],
  "representativeProduct": "Outlook / Hotmail 邮箱",
  "representativePrice": 0.06,
  "representativeCurrency": "CNY",
  "riskFeedbackCount": 0,
  "hasPlatformAftersalesMechanism": true
}
```

### 3.4 数据分布（调研时点）

- **host 集中度**：`pay.ldxp.cn` 约 214 家（链动小铺系占主导）
- **collectorKind**：`shopApi` 为主，另有 `kami`、`dujiao`、`genericHtml` 等
- **platforms 全集**：`ChatGPT | Claude | Gemini | Grok | 其他 | 接码 | 邮箱`
- **平均 offerCount**：约 20

---

## 4. 关联数据：报价与商品

### 4.1 Offers

```http
GET https://priceai.cc/api/offers?limit=100&offset=0
GET https://priceai.cc/api/offers?platform=ChatGPT&limit=100&offset=0
```

响应行结构：

```json
{
  "offer": {
    "id": "id-10myqs",
    "sourceId": "ldxp-2vwx76a4",
    "sourceName": "LDXP / 2VWX76A4",
    "sourceStoreName": "牟利ai",
    "sourceTitle": "GPT Free-账密直登-长效outlook-...",
    "price": 0.3,
    "currency": "CNY",
    "status": "in_stock",
    "url": "https://pay.ldxp.cn/item/s0lh2m",
    "stockCount": 49,
    "capturedAt": "...",
    "effectiveStatus": "available",
    "freshnessStatus": "fresh"
  },
  "product": {
    "id": "chatgpt-free-account",
    "slug": "chatgpt-free-account",
    "displayName": "ChatGPT 普号",
    "platform": "ChatGPT",
    "productType": "成品账号"
  }
}
```

**过滤实测**

| 参数 | 是否生效 |
|---|---|
| `platform=ChatGPT` | ✅ total 从 ~6593 → ~2421 |
| `limit` / `offset` | ✅ |
| `merchantId` / `sourceId` / `product` / `productId` | ❌ 实测未过滤（total 不变） |
| `stock=in_stock` | ❌ 反而 total=0（勿用） |

**与商家关联键（本地 join）**

1. 优先：`offer.sourceId` **==** `merchant.sourceId`
2. 次选：`offer.sourceStoreName` **==** `merchant.name` / `storeName`
3. 辅助：从 `offer.url` / `merchant.shopUrl` 解析 host + path

> 注意：`sourceId` 在商家侧 unique 约 298 / 333，存在 null 或缺映射，join 不能 100% 覆盖。

### 4.2 Explorer（标准商品）

```http
GET https://priceai.cc/api/explorer
```

返回标准商品列表、别名、最低价摘要，适合构建本地商品字典，不必从商家反推。

---

## 5. 推荐架构方案

### 5.1 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. API 分页拉取** | 直连 `/api/merchants` | 快、稳、字段全、实现简单 | robots 禁止 /api；接口可能变更 | **推荐主路径** |
| B. 浏览器 DOM 爬取 | Playwright 打开 channels 页 | 更接近“用户所见” | 慢、分页/虚拟列表复杂、字段不如 API | 仅作兜底 |
| C. HTML SSR 解析 | 解析 `/channels` HTML | 无需 JS | 当前页默认偏商品视图；商家字段不全 | 不推荐主路径 |
| D. 再下钻源站店铺 | 跟 `shopUrl` 抓发卡网 | 信息更“一手” | 反爬强、站点异构、合规风险高 | **二期可选** |

### 5.2 推荐数据流

```
┌─────────────────┐     limit/offset      ┌──────────────────┐
│  Scheduler      │ ───────────────────►  │ priceai.cc       │
│  (定时/手动)     │                       │ /api/merchants   │
└────────┬────────┘                       │ /api/offers      │
         │                                │ /api/explorer    │
         ▼                                └────────┬─────────┘
┌─────────────────┐                                │
│  Fetcher        │ ◄──────────────────────────────┘
│  - 重试/限速     │
│  - degraded 检测 │
└────────┬────────┘
         ▼
┌─────────────────┐
│  Normalizer     │  字段映射、join sourceId、去重
└────────┬────────┘
         ▼
┌─────────────────┐     IPC/本地查询      ┌──────────────────┐
│  Local Store    │ ───────────────────► │ Electron 渲染进程  │
│  SQLite/JSON    │                       │ 商家列表/详情 UI   │
└─────────────────┘                       └──────────────────┘
```

### 5.3 本地数据模型（建议）

```ts
// 商家主档
interface Merchant {
  id: string                 // priceai merchant id
  name: string
  storeName: string | null
  host: string | null
  shopUrl: string | null
  entryUrl: string | null
  sourceId: string | null
  sourceName: string | null
  collectorKind: string | null
  healthStatus: string | null
  offerCount: number
  inStockCount: number
  outOfStockCount: number
  productCount: number
  platformCount: number
  platforms: string[]
  productTypes: string[]
  representativeProduct: string | null
  representativeOfferTitle: string | null
  representativePrice: number | null
  representativeCurrency: string | null
  lowestHitCount: number
  warrantyLowestHitCount: number
  riskFeedbackCount: number
  hasPlatformAftersales: boolean
  shopCreatedAt: string | null
  includedAt: string | null
  lastSuccessAt: string | null
  latestSeenAt: string | null
  consecutiveFailures: number
  // 本地元数据
  fetchedAt: string
  raw: object                // 原始 JSON 备份，便于接口变更
}

// 报价（可选二期）
interface Offer {
  id: string
  merchantId: string | null  // 本地 join 后回填
  sourceId: string | null
  sourceStoreName: string | null
  productId: string | null
  productSlug: string | null
  title: string | null
  price: number | null
  currency: string | null
  status: string | null
  url: string | null
  stockCount: number | null
  platform: string | null
  capturedAt: string | null
  fetchedAt: string
}
```

存储建议：

- 首期：主进程侧 **SQLite**（`better-sqlite3`）或简单 **JSON 快照**
- 索引：`id` UNIQUE、`sourceId`、`host`、`name`、`healthStatus`
- 保留 `raw` 便于接口字段演进

---

## 6. 采集策略（可落地）

### 6.1 全量商家同步（MVP）

```text
limit = 100
offset = 0
loop:
  GET /api/merchants?limit={limit}&offset={offset}
  if degraded → 退避重试
  upsert rows by id
  if rows.length < limit OR offset + rows.length >= total:
    break
  offset += rows.length
  sleep 300~800ms
```

**停止条件**：`rows` 为空，或累计条数 ≥ `total`，或 `limited === false` 且不足一页。

**幂等**：以 `id` 做 upsert；记录 `generatedAt` / `fetchedAt`。

### 6.2 限速与稳健性

| 策略 | 建议值 |
|---|---|
| 请求间隔 | 300–1000 ms |
| 并发 | **1**（串行即可） |
| 超时 | 20–30 s |
| 重试 | 最多 3 次，指数退避；遇 429/5xx 拉长间隔 |
| 失败熔断 | 连续失败 5 次停止并告警 |
| UA | 固定可识别字符串，避免伪装成搜索引擎爬虫 |
| 缓存 TTL | 商家列表 15–30 min；手动刷新可强制 |

### 6.3 增量策略

1. 对比上次 `generatedAt` / 本地 hash（`id + lastSuccessAt + offerCount`）
2. 无变化则跳过写库
3. 定时：开发期手动；上线后每 30–60 min 一次全量即可（体量很小）

### 6.4 报价补充（Phase 2）

- 全量 offers 约 6500+，`limit` 建议 100，串行分页
- 或按 `platform` 分片拉取，降低单次压力
- join 回填 `merchantId` 后供详情页展示“该商家在售报价”

### 6.5 兜底：浏览器方案（仅当 API 失效）

1. Electron/Playwright 打开 `https://priceai.cc/channels?scope=merchants`
2. 拦截 `**/api/merchants*` 响应（**仍拿 JSON，不解析 DOM**）
3. 若连 API 都改版，再解析列表 DOM（成本高，最后手段）

---

## 7. 与本项目（Electron）集成建议

当前仓库为 **electron-vite + React + TS**。

| 模块 | 位置建议 | 职责 |
|---|---|---|
| `MerchantFetcher` | `src/main/services/priceai/fetcher.ts` | HTTP 分页、重试、限速 |
| `MerchantRepository` | `src/main/db/merchants.ts` | 持久化 / 查询 |
| IPC | `src/main` ↔ `src/preload` | `merchants:list` / `merchants:sync` / `merchants:get` |
| UI | `src/renderer` | 商家表格、筛选（平台/健康状态/关键词）、详情抽屉 |
| 类型 | `src/shared/types/merchant.ts` | 主进程与渲染进程共享 |

**MVP 用户故事**

1. 打开应用 → 点击「同步商家」→ 进度条显示分页
2. 列表展示：店名、host、有货数、报价数、平台、健康状态、代表价
3. 搜索/按平台过滤（可本地过滤，不必每次打远端）
4. 详情：展示完整字段 + shopUrl 外链 +（二期）关联报价

---

## 8. 风险与边界

| 风险 | 等级 | 应对 |
|---|---|---|
| robots 禁止 `/api/`，存在合规争议 | 中高 | 限速、缓存、可关闭同步；评估授权 |
| 接口无版本号，字段/路径可能变更 | 中 | 保留 `raw`；运行时 zod 校验；失败降级提示 |
| `sort` 等参数不可靠 | 低 | 排序在本地做 |
| offers 按商家服务端过滤无效 | 中 | 本地 join；或只展示商家汇总字段 |
| `host` / `sourceId` 为空的商家 | 中 | UI 标记“信息不完整”；join 放宽 |
| Cloudflare / 反爬升级 | 中 | 兜底走浏览器拦截 XHR；加长间隔 |
| 源站店铺二跳采集 | 高 | 二期再评估，默认不做 |

**法律与产品边界（务必遵守）**

- 本方案仅采集 PriceAI **公开展示的比价元数据**
- 不采集用户隐私、不绕过登录、不破解付费墙
- 不批量攻击式请求；不做整站镜像
- 展示时注明数据来源与更新时间；价格仅供参考

---

## 9. 实施分期

### Phase 0 — 调研落档 ✅（本文档）

- [x] 确认 API、字段、分页、总量
- [x] 确认无详情接口、offers 关联方式

### Phase 1 — MVP 商家同步（建议下一步）

- [ ] 主进程 `fetchAllMerchants()`
- [ ] 本地存储 + 去重 upsert
- [ ] IPC + 渲染进程商家列表 UI
- [ ] 手动同步按钮 + 上次同步时间

### Phase 2 — 报价关联与筛选

- [ ] 拉取 explorer 商品字典
- [ ] 分页拉取 offers，按 `sourceId` join
- [ ] 商家详情页展示在售报价 Top N

### Phase 3 — 增强

- [ ] 定时同步、变更 diff、健康状态告警
- [ ] 导出 CSV/JSON
- [ ] API 变更探测（schema snapshot）
- [ ] （可选）浏览器 XHR 拦截兜底

---

## 10. 快速验证命令

```bash
# 首页商家
curl -sS 'https://priceai.cc/api/merchants?limit=5&offset=0' | jq '{total, limited, names: [.rows[].name]}'

# 全量分页（示例：只数条数）
python3 - <<'PY'
import json, urllib.request, time
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent':'MerchantAggregator/0.1','Accept':'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())
all_rows, offset, limit = [], 0, 100
while True:
    d = get(f'https://priceai.cc/api/merchants?limit={limit}&offset={offset}')
    rows = d['rows']
    all_rows.extend(rows)
    print(offset, len(rows), 'acc', len(all_rows), '/', d['total'])
    if len(rows) < limit or len(all_rows) >= d['total']:
        break
    offset += len(rows)
    time.sleep(0.4)
print('done', len(all_rows), 'unique', len({r['id'] for r in all_rows}))
PY

# 搜索
curl -sS --get 'https://priceai.cc/api/merchants' --data-urlencode 'q=陆柒' --data-urlencode 'limit=5' | jq '.total, .rows[0].name'

# 平台过滤
curl -sS 'https://priceai.cc/api/merchants?platform=ChatGPT&limit=3' | jq '{total, names: [.rows[].name]}'
```

---

## 11. 最终推荐

**采用方案 A：API 分页拉取 `/api/merchants` 作为商家主数据源。**

理由：

1. 公开 JSON，无需登录，字段覆盖“商家 + 经营概况 + 健康度 + 入口 URL”
2. 全量仅约 333 条，4 次请求内可完成，非常适合桌面端本地聚合
3. 比 DOM 爬取稳定 1–2 个数量级，实现成本最低
4. 报价与商品可用 `/api/offers`、`/api/explorer` 渐进增强

首期交付范围：**商家全量同步 + 本地列表/搜索/详情（基于列表字段）**。  
报价明细 join、源站二跳采集放入后续迭代。
