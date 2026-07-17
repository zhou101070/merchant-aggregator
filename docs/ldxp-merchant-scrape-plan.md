# 链动小铺（ldxp.cn）商家商品采集技术方案

> 目标链接：`https://pay.ldxp.cn/shop/EXZMM8SQ`  
> 调研日期：2026-07-17  
> 状态：**可行（推荐直调公开 JSON API，无需浏览器渲染）**  
> 样本商家：token=`EXZMM8SQ`，店铺名「team最后的余晖」，卡密类商品约 148 件

---

## 1. 结论摘要

| 项 | 结论 |
|---|---|
| 是否可拿到店铺信息 | **可以**（`POST /shopApi/Shop/info`） |
| 是否可拿到商品列表 | **可以**（`POST /shopApi/Shop/goodsList` 分页） |
| 是否可拿到商品详情 | **可以**（`POST /shopApi/Shop/goodsInfo`，`goods_key`） |
| 是否可拿到分类 | **可以**（`POST /shopApi/Shop/categoryList`） |
| 推荐方式 | **直调 `pay.ldxp.cn/shopApi/*` 公开接口** |
| 是否需要 Playwright/Electron 渲染 | **首期不需要**；仅作反爬升级后备 |
| 登录 / 签名 / 加密 | **不需要**（调研时点） |
| 鉴权 Cookie | 非硬性；浏览器态建议携带会话 Cookie |
| 全量规模（样本店） | `goods_count=148`，`card_count=148`，其它类型 0 |
| 全量耗时估算 | `pageSize=20` → 约 8 页；含 300–800ms 间隔约 **5–15s/店** |
| 主防爬层 | 阿里云 **ESA**（`acw_tc` / `cdn_sec_tc`）+ 频控 / Bot 能力预留 |

**一句话方案**：从商家 URL 解析 `token` → 拉 `Shop/info` 建档 → 按 `goods_type` 拉分类与分页商品列表 → 按需补 `goodsInfo` 详情；全程 HTTP JSON，Session 保 Cookie，限速 + 重试应对 ESA。

---

## 2. 目标站点与页面结构

### 2.1 平台定位

- 品牌：**链动小铺**（`ldxp.cn` / `pay.ldxp.cn`）
- 类型：虚拟商品 / 卡密自动发货平台（发卡网）
- 主体：四川链动万商科技有限公司（ICP：蜀ICP备2024101722号-1）
- 支付与店铺前台域名：`pay.ldxp.cn`
- 静态资源 / 图床：`qn.ldxp.cn`（七牛）

### 2.2 页面形态

| 特征 | 说明 |
|---|---|
| 技术栈 | **Vue 3 + Arco Design + Axios** SPA |
| HTML 壳 | 仅 loading spinner，**无 SSR 商品数据** |
| 路由 | `/shop/:token/:categoryKey?`、`/item/:goodsKey/:trade_no?` |
| 入口脚本 | `/package/shop/assets/index.<hash>.js` |
| 业务分包 | `index.32beeed8.js`（店铺页）、`index.e85bbe60.js`（商品详情）等 |

商家链接模式：

```text
https://pay.ldxp.cn/shop/{token}
https://pay.ldxp.cn/shop/{token}/{categoryKey}   # 可选分类深链
https://pay.ldxp.cn/item/{goodsKey}              # 商品详情
```

样例：

```text
https://pay.ldxp.cn/shop/EXZMM8SQ
→ token = EXZMM8SQ
```

### 2.3 前端请求约定（逆向自 bundle）

```js
// 主包 axios 默认配置（压缩后还原）
axios.defaults.baseURL = '/'
axios.defaults.withCredentials = true

// 请求拦截：注入访客 ID
const visitorId = localStorage.getItem('visitorId') || randomId()
config.headers.Visitorid = visitorId

// 响应拦截：直接返回 response.data
// 业务成功判定：body.code === 1
```

要点：

1. 同源相对路径 `/shopApi/...`
2. `withCredentials=true` → 自动带 Cookie
3. 自定义头 `Visitorid`（前端 localStorage 持久化随机串，**服务端当前不强制**）
4. 统一 `POST` + JSON body

---

## 3. 公开接口契约（实测 2026-07-17）

基址：`https://pay.ldxp.cn`

通用约定：

| 项 | 值 |
|---|---|
| Method | `POST` |
| Content-Type | `application/json` |
| 成功 | HTTP 200 且 `code === 1` |
| 失败 | `code !== 1`，`msg` 为文案 |
| 鉴权 | 店铺浏览接口 **无需登录** |

推荐请求头：

```http
Content-Type: application/json
Accept: application/json, text/plain, */*
Origin: https://pay.ldxp.cn
Referer: https://pay.ldxp.cn/shop/{token}
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
Visitorid: {client_generated_id}
```

### 3.1 系统配置（可选）

```http
POST /shopApi/system/config
Body: {}
```

用途：站点名、客服、公告等元信息；与单店商品无强依赖。

### 3.2 店铺信息（必选）

```http
POST /shopApi/Shop/info
```

```json
{
  "token": "EXZMM8SQ",
  "category_key": null
}
```

实测关键字段：

| 字段 | 样例 / 说明 |
|---|---|
| `nickname` | team最后的余晖 |
| `avatar` | 头像 URL |
| `description` | 店铺公告/简介 |
| `token` | EXZMM8SQ |
| `link` | 完整店铺 URL |
| `sell_count` | 销量展示（1180） |
| `deposit_money` | 保证金 |
| `goods_count` / `card_count` / `article_count` / `resource_count` / `equity_count` | 各类型商品数 |
| `goods_type_sort` | `["card","article","resource","equity"]` 前端 Tab 顺序 |
| `contact_qq` / `contact_wechat` / `contact_mobile` | 联系方式 |
| `auth_status` | 认证状态 |
| `shop_pc_style` / `shop_h5_style` | 模板皮肤 |
| `params` | 展示开关（是否显示分类全部、销量等） |

### 3.3 分类列表

```http
POST /shopApi/Shop/categoryList
```

```json
{
  "token": "EXZMM8SQ",
  "goods_type": "card",
  "category_key": null
}
```

| 字段 | 说明 |
|---|---|
| `goods_type` | **必填语义字段**：`card` / `article` / `resource` / `equity` |
| 响应 | 数组；含 `{ id, name, goods_count, image? }`，`id=0` 表示「全部」 |

样例店分类：邮箱、gemini、chatgpt、Claude成品号、GPT-pro…（按 `goods_type=card`）

### 3.4 商品列表（核心）

```http
POST /shopApi/Shop/goodsList
```

```json
{
  "token": "EXZMM8SQ",
  "keywords": "",
  "category_id": 0,
  "goods_type": "card",
  "current": 1,
  "pageSize": 20
}
```

| 参数 | 说明 | 实测 |
|---|---|---|
| `token` | 店铺 token | 必填 |
| `goods_type` | 商品大类 | 必填语义；前端按 Tab 分别请求 |
| `category_id` | 分类 ID | `0` 或空 = 全部；可用分类列表 id |
| `keywords` | 搜索关键词 | 可空字符串 |
| `current` | 页码，从 1 起 | 前端递增 |
| `pageSize` | 每页条数 | 前端默认 **20**；亦见 `999999` 用于特殊场景，**生产勿滥用** |

响应：

```json
{
  "code": 1,
  "msg": "success",
  "data": {
    "total": 148,
    "list": [ /* goods item */ ]
  }
}
```

列表项关键字段：

| 字段 | 说明 |
|---|---|
| `goods_key` | 商品唯一键（详情/深链用） |
| `goods_type` | card / article / … |
| `name` | 标题 |
| `price` / `market_price` | 售价 / 划线价 |
| `image` | 主图 |
| `link` | `https://pay.ldxp.cn/item/{goods_key}` |
| `description` | HTML 详情摘要（列表已带，可能很长） |
| `category` | `{ id, name }` |
| `user` | 所属店铺摘要（nickname/token/avatar） |
| `extend.stock_count` | 库存（若展示） |
| `extend.limit_count` | 限购 |
| `coupon_status` / `discount` / `multipleoffers` / `fullgift` | 营销扩展 |
| `create_time` | Unix 秒 |

### 3.5 商品详情

```http
POST /shopApi/Shop/goodsInfo
```

```json
{
  "goods_key": "w0gpvq",
  "trade_no": null
}
```

相对列表额外字段：`status`、`verify`、`real_price`、`js`（插件脚本）、更完整 `user` / 营销结构。

> 列表 `description` 已较完整时，**可先不逐条拉详情**，降低请求量；需要 `status`/`real_price` 或插件数据时再补。

### 3.6 其它相关接口（非采集主路径）

| 接口 | 用途 | 采集建议 |
|---|---|---|
| `POST /shopApi/Shop/getGoodsPrice` | 算价（数量/优惠码/渠道） | 可选；监控真实到手价 |
| `POST /shopApi/Shop/getUserChannel` | 分销渠道 | 一般不需要 |
| `POST /shopApi/Shop/goodsPartDetail` | 分段详情 | 特殊商品 |
| `POST /shopApi/Pay/order` / `Pay/query` | 下单/查单 | **禁止爬取/调用** |
| `POST /shopApi/upload/file` | 上传 | 禁止 |

### 3.7 商品类型枚举

| goods_type | 含义（平台语境） |
|---|---|
| `card` | 卡密 / 自动发货虚拟货 |
| `article` | 图文/文章类商品 |
| `resource` | 资源类 |
| `equity` | 权益类 |

采集时应遍历 `Shop/info.data.goods_type_sort`（或四类全扫），并对 `*_count === 0` 的类型跳过。

---

## 4. 反爬 / 风控机制分析

### 4.1 已观测层

| 层级 | 现象 | 影响 |
|---|---|---|
| **阿里云 ESA** | 响应头 `server: ESA`；`Set-Cookie: acw_tc`、`cdn_sec_tc` | 会话标记，用于 CC/扫描统计 |
| **应用 Session** | `PHPSESSID`、`server_session_*` | 常规会话；浏览接口不强制登录 |
| **前端访客头** | `Visitorid` | 当前可不传也能 200；建议模拟浏览器带上 |
| **SPA 壳** | HTML 无数据 | 禁绝「只 curl HTML 解析」的朴素爬虫 |
| **无签名体** | 请求体明文 JSON | 逆向成本低 |

ESA 官方说明（摘要）：边缘节点会通过 `acw_tc` / `cdn_sec_tc` 标记客户端会话，用于统计同会话攻击频率；在开启 CC 防护、扫描防护、Bot 管理等能力时，**缺 Cookie 或行为异常可能触发挑战/拦截**。

### 4.2 调研时点实测

| 探测 | 结果 |
|---|---|
| 无 Cookie + 极简 UA 调 `Shop/info` | **200 / code=1** |
| 带 Origin/Referer/Visitorid | 200 / code=1 |
| 连续 20 次 `goodsList`（同 IP） | 全部成功，**未触发明显限流** |
| JS 挑战页（`acw_sc__v2` 类） | **本次未出现** |
| 登录态 | **店铺商品读接口不需要** |

结论：**当前防爬偏「边缘会话 + 潜在频控」，不是强制人机验证**。  
但平台具备 ESA Bot / 滑块 / 威胁情报等升级能力，方案必须预留降级。

### 4.3 可能升级的对抗面（预案）

| 场景 | 特征 | 应对 |
|---|---|---|
| 缺 `acw_tc` 被拒 | 403 / 5xx / 空 body | 先 `GET` 店铺页种 Cookie 再调 API |
| JS 挑战（`acw_sc__v2` 等） | HTML 含挑战脚本 | 切换 **Playwright/Electron 真实浏览器** 执行挑战后导出 Cookie |
| 频率封禁 | 429 / 业务码异常 / 长时间失败 | 指数退避、降并发、换代理 IP 池 |
| Bot 指纹 | 仅 TLS/JA3 或无头请求失败 | 完整浏览器头序、HTTP/2、有头浏览器 |
| 接口改版 / 加签 | `code` 异常、字段变化 | 监控主包 hash；失败告警；定期回归 |

### 4.4 推荐反爬策略（工程向）

按投入从低到高分三档：

#### L1 — 直连 HTTP（**默认推荐**）

- Node `fetch` / `undici` / `got`，**CookieJar 持久化**
- 启动：`GET /shop/{token}` 预热 Cookie（`acw_tc`、`cdn_sec_tc`、`PHPSESSID`）
- 固定合理 UA + `Origin` + `Referer` + `Visitorid`
- 全局限速：每店 QPS ≤ 1～2；全局 ≤ 3～5 QPS
- 页间随机 sleep 300～1000ms
- 错误重试：网络错误 / 5xx / 非 JSON → 最多 3 次指数退避
- 禁止使用 `pageSize=999999` 扫全站

#### L2 — 代理与会话轮换

- 住宅/动态代理池按店铺或按 N 页轮换
- 每会话独立 `Visitorid` + CookieJar
- 熔断：连续失败 N 次标记 IP 冷却

#### L3 — 有头浏览器兜底

- Playwright / 本项目 Electron 内嵌窗口打开店铺页
- 拦截 XHR 拿 JSON，或执行完挑战后把 Cookie 回灌 L1 客户端
- 仅在 L1/L2 连续失败或检测到挑战页时启用（成本高）

**不建议**：无节制分布式爆破、验证码打码刷量、伪造支付/下单链路。

---

## 5. 推荐采集流程

```text
输入: shopUrl | token
        │
        ▼
  parseToken(url)  ──  /shop/([A-Za-z0-9]+)
        │
        ▼
  session.warmup(GET /shop/{token})   # 种 ESA Cookie
        │
        ▼
  POST /shopApi/Shop/info { token }
        │
        ├─ 持久化 Merchant
        └─ goods_type_sort / *_count
        │
        ▼
  for type in goods_types (skip count==0):
        │
        ├─ POST categoryList { token, goods_type }
        │
        └─ current=1
           loop:
             POST goodsList { token, goods_type, category_id:0, current, pageSize:20 }
             append list
             if list.length==0 or current*pageSize >= total: break
             current++
             sleep(jitter)
        │
        ▼
  (可选) for goods_key in keys:
        POST goodsInfo { goods_key }   # 限速更严
        │
        ▼
  normalize → 本地统一商品模型 → 入库 / 推送给聚合层
```

### 5.1 Token 解析

```ts
function parseLdxpShopToken(input: string): string | null {
  const s = input.trim()
  if (/^[A-Za-z0-9]{6,16}$/.test(s)) return s
  try {
    const u = new URL(s)
    const m = u.pathname.match(/\/shop\/([A-Za-z0-9]+)/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}
```

### 5.2 统一商品模型（建议）

便于与 `merchant-aggregator` / PriceAI 等源对齐：

```ts
interface UnifiedProduct {
  source: 'ldxp'
  sourceShopToken: string
  sourceGoodsKey: string
  sourceUrl: string
  shopName: string
  title: string
  price: number
  marketPrice?: number
  currency: 'CNY'
  goodsType: 'card' | 'article' | 'resource' | 'equity'
  categoryId?: number
  categoryName?: string
  stock?: number | null
  image?: string
  descriptionHtml?: string
  raw?: unknown
  fetchedAt: string // ISO
}
```

字段映射：

| 统一字段 | 来源 |
|---|---|
| `sourceShopToken` | URL / `info.token` / `item.user.token` |
| `sourceGoodsKey` | `item.goods_key` |
| `sourceUrl` | `item.link` |
| `shopName` | `info.nickname` |
| `title` | `item.name` |
| `price` | `item.price` |
| `stock` | `item.extend?.stock_count` |
| `categoryName` | `item.category?.name` |

---

## 6. 模块设计（贴合本仓库 Electron 架构）

建议落在 **main process**（避免渲染进程 CORS/暴露实现）：

```text
src/main/
  platforms/
    ldxp/
      types.ts          # 接口 DTO
      client.ts         # CookieJar + postJson + 限速
      parser.ts         # token / URL
      scraper.ts        # 编排 info → list → detail
      normalize.ts      # → UnifiedProduct
  services/
    scrape-queue.ts     # 多店队列、并发=1~2
```

IPC 建议：

| channel | 方向 | 说明 |
|---|---|---|
| `scrape:ldxp:shop` | renderer → main | `{ url \| token, options }` |
| `scrape:ldxp:progress` | main → renderer | 页码/进度 |
| `scrape:ldxp:result` | main → renderer | 商品数组或落盘路径 |

依赖：

- 首期：**零浏览器依赖**（Node 原生 fetch + 自管 Cookie 即可）
- 可选：`tough-cookie` + `fetch-cookie`，或 `got` 的 cookie jar
- 后备：`playwright-core`（L3）

---

## 7. 伪代码（L1 客户端）

```ts
async function scrapeLdxpShop(token: string) {
  const jar = new CookieJar()
  const http = createClient({
    baseURL: 'https://pay.ldxp.cn',
    jar,
    headers: {
      'User-Agent': CHROME_UA,
      Origin: 'https://pay.ldxp.cn',
      Referer: `https://pay.ldxp.cn/shop/${token}`,
      Visitorid: randomVisitorId(),
      Accept: 'application/json, text/plain, */*',
    },
    minIntervalMs: 400,
  })

  await http.get(`/shop/${token}`) // warmup ESA cookies

  const info = await http.postJson('/shopApi/Shop/info', { token })
  assertCode(info)

  const products = []
  for (const goodsType of info.data.goods_type_sort ?? ['card', 'article', 'resource', 'equity']) {
    const countKey = `${goodsType}_count`
    if (info.data[countKey] === 0) continue

    let current = 1
    const pageSize = 20
    for (;;) {
      const res = await http.postJson('/shopApi/Shop/goodsList', {
        token,
        keywords: '',
        category_id: 0,
        goods_type: goodsType,
        current,
        pageSize,
      })
      assertCode(res)
      const { list, total } = res.data
      products.push(...list.map((x) => normalize(x, info.data)))
      if (!list.length || current * pageSize >= total) break
      current++
    }
  }
  return { merchant: info.data, products }
}
```

---

## 8. 风险、合规与边界

1. **ToS / 法律**：公开读接口 ≠ 授权批量抓取。产品用途应限于比价聚合、个人/授权监控；控制频率，避免镜像整站。
2. **robots / 商誉**：平台若后续收紧 API 或上强 Bot，需停用并评估官方合作。
3. **数据质量**：价格/库存实时变化；`description` 为 HTML，需消毒后再展示。
4. **敏感内容**：样本店含各类账号/订阅虚拟货，展示与存储需符合业务合规策略。
5. **禁止范围**：下单、支付、投诉、上传、撞库、验证码黑产绕过。
6. **稳定性**：前端 chunk hash 会变；**以路径 `/shopApi/Shop/*` 为准**，不写死 asset 文件名。

---

## 9. 验收标准

| 用例 | 期望 |
|---|---|
| 输入 `https://pay.ldxp.cn/shop/EXZMM8SQ` | 正确解析 token |
| `Shop/info` | `code=1`，拿到 nickname、goods_count |
| `goodsList` 翻页 | `total` 与累计条数一致（样本约 148） |
| 单商品字段 | 至少含 name、price、goods_key、link |
| 限速 | 默认不触发封禁；失败可重试 |
| 挑战页 | 检测到非 JSON/挑战 HTML 时标记 `NEED_BROWSER` 而非死循环 |

---

## 10. 实施分期

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0** | `client` + `scrapeShop(token)` 列表全量 + 单测/手工脚本 | 0.5–1d |
| **P1** | 接入 Electron IPC、进度 UI、本地缓存/SQLite | 1–2d |
| **P2** | 定时刷新、价格变更 diff、多店队列 | 1–2d |
| **P3** | Playwright 挑战兜底、代理池、可观测告警 | 按需 |

---

## 11. 调研附录

### 11.1 样本实测摘要

```text
token: EXZMM8SQ
nickname: team最后的余晖
goods_count: 148 (card=148, 其它=0)
首条 goods_key: w0gpvq
首条 name: Gemini Pro 12个月个人账号充值【质保一年】
首条 price: 48
首条 link: https://pay.ldxp.cn/item/w0gpvq
```

### 11.2 关键逆向入口

| 资源 | 作用 |
|---|---|
| `/package/shop/assets/index.*.js` | axios 配置、`Visitorid`、`/shopApi/system/config` |
| `index.32beeed8.js`（hash 会变） | 店铺页：`info` / `categoryList` / `goodsList` |
| `index.e85bbe60.js`（hash 会变） | 详情页：`goodsInfo` / `getGoodsPrice` |

### 11.3 与 PriceAI 方案差异

| 维度 | PriceAI | 链动小铺 |
|---|---|---|
| 协议 | GET query | **POST JSON** |
| 分页 | `limit` + `offset` | **`current` + `pageSize`** |
| 主键 | 站点内 merchant id | **`token` + `goods_key`** |
| 边缘防护 | Cloudflare 系 | **阿里云 ESA** |
| 浏览器需求 | 否 | 默认否，ESA 升级时可能要 |

---

## 12. 变更记录

| 日期 | 说明 |
|---|---|
| 2026-07-17 | 初版：基于 `EXZMM8SQ` 在线逆向与接口实测落档 |
