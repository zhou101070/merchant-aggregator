# 双池频率同步策略（落档方案）

| 字段 | 值 |
| --- | --- |
| 状态 | 已落档 · P0/P1 已实现（内置代理 / 节点 pin 已移除） |
| 日期 | 2026-07-18 |
| 范围 | shop 类任务（`shop_*` / bootstrap 刮店阶段）；`merchants` 任务不变 |
| 非目标 | 不改自动刷新选店逻辑本身；不改单品库存刷新；不持久化池快照到 SQLite |

---

## 1. 问题与目标

### 1.1 现状

- 店级串行：`runShopQueue` 一次只刮完一整店再进下一店。
- 店内（shopApi）按 `goodsType` 顺序分页，页级有 `shopPageConcurrency`。
- 任务详情弹窗只有摘要/错误；**同步请求表**与运行态信息挂在同步中心页外层。

### 1.2 目标

1. **商家池 → 商品组池** 双线并行：发现与消费解耦，提高吞吐且仍受限速/并发约束。
2. 商品组池水位与**并发配置**挂钩，避免空转或无界膨胀。
3. 任务弹窗可观测：两池实时表 + 详细状态；页外「同步请求」等表迁入对应任务弹窗。

### 1.3 吞吐边界（写死）

双池首要收益是 **发现与消费时间重叠**（店 A 分页时店 B 可 discover），不是把有效 HTTP 并发放大到 \(C^2\)。

全局 **in-flight 页/请求预算** = `settings.shopPageConcurrency`（夹紧同 `SHOP_API_LIMITS.pageConcurrency`）。见 §3.2。

---

## 2. 概念模型

### 2.1 商家池（MerchantPool）

| 项 | 定义 |
| --- | --- |
| 工作单元 | 一个待发现的店铺目标 `ShopScrapeTarget`（platformId + token + merchantId?） |
| 入池来源 | 与现网一致：`listScrapableNeedingSync` / 显式 ids / URL / bootstrap TopN |
| 出池动作 | **发现**：取得/复用 StoreSession → 产出商品组清单并**原子**入商品组池 |
| 商家状态 | `queued` → `discovering` → `discovered` \| `failed` \| `skipped` \| `cancelled` |

`skipped` 仅用于「策略跳过 / 未启用平台 / 任务取消前未开始」等**未完成发现**的情况；**已确认空店不算 skipped**（见 §3.3）。

### 2.2 商品组（ProductGroup）

跨平台统一抽象为「可独立拉取的一组商品」：

| 平台族 | 商品组粒度 | 发现 | 消费 |
| --- | --- | --- | --- |
| shopApi（ldxp/catfk…） | `(platformId, token, goodsType)` | session.warmup + shopInfo → `goods_type_sort`（空则 profile 默认 types） | 该 type 的 goodsList 全部分页（共享同一 StoreSession） |
| dujiao | 整店 1 组（`groupKey='*'`） | 轻量就绪（可与现网 scrape 入口合并） | 内部调用现有 `scrapeDujiao` 等价逻辑（或整段 scrape） |
| yiciyuan | 整店 1 组（`groupKey='*'`） | 同上 | 现有 yiciyuan 列表拉取 |

> 分页 page **不是**池单元。

### 2.3 商品组池（ProductGroupPool）

| 项 | 定义 |
| --- | --- |
| 工作单元 | `ProductGroupPoolItem` |
| 入池 | 仅发现线，且与 `expectedGroups` **同临界区**写入（§3.1） |
| 出池 | 消费线；结果进 `ShopAccumulator`，店终态一次提交 |
| 组状态 | `queued` → `running` → `succeeded` \| `failed` \| `cancelled` |

### 2.4 StoreSession（B1 写死）

每个 `storeKey = platformId + '\0' + token` 在 job 内最多一个会话：

| 项 | 规则 |
| --- | --- |
| 创建 | 商家进入 `discovering` 时创建（shopApi：`ShopApiClient` + warmup） |
| 共享 | 该店全部 group 的 consume **必须**复用同一 client/tab/cookie；**禁止** per-group warmup |
| dispose | 该店 `commitStore` / `failStore` / 取消终态之后调用；不得在仍有 group `running` 时 dispose |
| WAF 开浏览器 | `openSystemBrowserOnWaf` 仅挂在该 session 的请求路径上；同一 session 生命周期内按现网 client 行为，不因多 group 重复「策略性」多开 |
| 上限 | `maxOpenStores`（常量，默认 **2**）：已创建未 dispose 的 session 数达上限时，**暂停**新的 discover（反压），避免多店 tab 堆积 |

### 2.5 核心类型（shared）

```ts
type MerchantPoolStatus =
  | 'queued' | 'discovering' | 'discovered' | 'failed' | 'skipped' | 'cancelled'

type GroupPoolStatus =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

interface MerchantPoolItem {
  id: string
  jobId: string
  merchantId: string | null
  platformId: string
  token: string
  status: MerchantPoolStatus
  message?: string
  groupCount?: number
  startedAt?: number
  endedAt?: number
}

interface ProductGroupPoolItem {
  id: string
  jobId: string
  merchantPoolItemId: string
  merchantId: string | null
  platformId: string
  token: string
  /** shopApi: goodsType；整店族: '*' */
  groupKey: string
  status: GroupPoolStatus
  message?: string
  productCount?: number
  startedAt?: number
  endedAt?: number
}

interface JobPoolSnapshot {
  jobId: string
  merchants: MerchantPoolItem[]
  groups: ProductGroupPoolItem[]
  caps: {
    discoverConcurrency: number
    /** 全局 in-flight 页/组请求预算，= shopPageConcurrency */
    requestBudget: number
    startConsumeAt: number
    maxOpenStores: number
  }
}
```

---

## 3. 双线调度

```
targets[] ──enqueue──► MerchantPool
                            │
              [发现线 × discoverConcurrency，受 maxOpenStores 反压]
                            │ StoreSession + discover（原子入组）
                            ▼
                      ProductGroupPool
                            │
         水位 ≥ startConsumeAt 或 尾波
              [消费线：全局 requestBudget 内调度]
                            │ 共享 StoreSession
                            ▼
                   ShopAccumulator（按 storeKey）
                            │ expected 已最终确定且全部 group 终态
                      commitStore / failStore
                            │
                         dispose session
```

### 3.1 发现线（Producer）

- `discoverConcurrency = 1`（常量）。
- 取 `queued` → `discovering` → 创建 StoreSession → 平台 discover。
- **原子入池（B3）**——同一临界区内顺序执行，中途不 yield 给 consume 提交逻辑：

  ```
  acc = getOrCreateAccumulator(storeKey)
  // expected 在此之前必须仍是「未最终」哨兵（null）
  groups = discoveredGroupKeys  // length N，N 可为 0
  acc.expectedGroups = N        // 最终确定
  acc.expectedFinal = true
  enqueueAll(groups as queued)  // N 条一次入队
  merchant.status = N === 0 ? /* 见空店 */ : 'discovered'
  merchant.groupCount = N
  ```

- Consume **禁止**在 `acc.expectedFinal !== true` 时对该 store 调用 `replaceForShop` / commit。
- 单测名建议：`does not commit store before expectedGroups finalized`；`slow multi-type discover vs fast first group`。

### 3.2 消费线与并发预算（B4 写死）

**单一旋钮**：`requestBudget = clamp(settings.shopPageConcurrency)`。

| 规则 | 值 |
| --- | --- |
| 水位 `startConsumeAt` | `max(1, requestBudget)` |
| 开抽条件 | 有任意 `queued` 组即开抽（避免 maxOpenStores 占满却未达水位的死锁）；水位/尾波/session 满仅作加速语义 |
| 全局 in-flight | 任意时刻，所有 group 内进行中的 **goodsList/等价 HTTP 页请求** 总数 ≤ `requestBudget` |
| 组间并行 | 允许，但受预算约束：例如 budget=3 时可 3 组各 1 页，或 1 组 3 页，由调度器分配 |
| 组内 TaskManager | `pageConcurrency` 动态 ≤ 剩余预算，**默认优先把预算分给已 running 的组补页**，有空闲再拉新 group |
| 禁止 | `groupConcurrency = pageConcurrency` 且两者同时拉满（禁止 \(C^2\)） |

  请求间隔 limiter：**所有 group 共享**该 job 内与现网一致的 limiter 行为，禁止绕过。

设置文案：`shopPageConcurrency` = **「店刮请求并发预算」**（全局 in-flight 上限），不再写「兼作商品组并发上限」这种易误解表述。

### 3.3 按店提交 + 与现网 markOk/markFail 对照（B6/B7）

#### ShopAccumulator

```
storeKey → {
  target, expectedGroups, expectedFinal,
  doneGroups, rows[], groupErrors[],
  wafDeferred?: boolean
}
```

#### 空店（B7）

| 情况 | 行为 |
| --- | --- |
| discover 成功且 N=0（确认无 type/无商品） | `expectedGroups=0`，立即 `commitStore`：`replaceForShop([])` + 走 markOk 健康路径（**清空本地旧 SKU**，与现网空列表一致） |
| 平台未启用 / 解析前跳过 | merchant `skipped`，**不** `replaceForShop`，不计 failed |
| discover/consume 全失败且 0 成功 row | `failStore`：health=failing，**不** `replaceForShop`（保留旧数据） |

#### commitStore（对齐 markOk）

在 `expectedFinal && doneGroups === expectedGroups` 且存在至少一条成功 path（含 N=0 空店）时：

| 现网 | 池化后 |
| --- | --- |
| `shopProducts.replaceForShop(source, token, rows)` | 同；rows = 各成功 group 合并（N=0 则 `[]`）；`source` 回退链与现网 markOk 一致：`rows[0]?.source ?? profile.sourceId ?? platformId` |
| `setAppHealth(merchantId, 'healthy')` 或 `setAppHealthByShopRef` | 同 |
| `relinkShopProducts(platformId, token, merchantId)` | **保留**（有 merchantId 时） |
| job `ok += 1`，`done/current` 推进 | 同；**部分 group 失败但 rows 非空或 N=0 已提交**：仍计 **ok**，失败 group 写入 `meta.errors`（带 groupKey） |
| progress 文案 | 店级 message，不把页序号写入 `job.current` |

#### failStore（对齐 markFail）

当 `expectedFinal && 全部 group 终态且成功 row 数为 0` 且非空店成功，或 discover 直接失败：

| 现网 | 池化后 |
| --- | --- |
| `errors.push({ merchantId, platformId, token, message, code, details })` | 同；group 失败可附 `groupKey` 于 details |
| `notFamily`（SCHEMA_VALIDATION + details.notFamily）→ `clearShopRef` | **保留** |
| 否则 `setAppHealth(..., 'failing', message)` 或 byShopRef | **保留** |
| `shouldBlockMerchantAfterSyncFailure` → blocklist.add | **保留**（读 settings.blockOnShopSyncFail） |
| 开始刮店前 `retrying` | 商家 `discovering` / 首 group `running` 时：有 merchantId → `setAppHealth(...,'retrying')`；否则 → `setAppHealthByShopRef(...,'retrying')`（对齐现网） |
| job `failed += 1` | 同 |
| **不** `replaceForShop` | 同（全失败保留旧数据） |

#### 部分 group 失败

- 合并成功 group 的 rows → `commitStore`（replace，允许缺类目）。
- 店计 **ok**；job 若存在任意 store fail 或 group 级 errors，终态 **partial**（全店 ok 且无 errors → succeeded）。
- 零成功 row → `failStore`，不 replace。

### 3.4 进度语义

- `total` = 入池商家数（按店）。
- `current` = 商家终态数（commit/fail/skipped/cancelled 已结算）。
- **禁止**把组内 page 进度写入 `job.current`（避免条乱跳）；页进度只进池表 `message` / group 行。
- `phase`：`pool_discover` | `pool_consume` | `pool_drain` | 结束。
- `message` 例：`发现 12/40 · 组 28队/3跑/90完 · 预算 3`。
- **bootstrap**：进入刮店阶段时 `total/current` 重置为店维度（与现网切换一致）；UI 接受一次跳变。

### 3.5 取消与收尾

- AbortSignal 传到 discover/consume/组内请求。
- 取消：两池 `queued` → `cancelled`；in-flight 结束后 `cancelled`；各 store dispose session。
- 对齐现网：`markCancelledImmediate` 后 **不得**再 `finish` 为 succeeded/partial/failed。
- `cancelAll` / job 结束：`Map<jobId, runtime>` 删除；laneOwner 释放时机与现网一致（bootstrap 仍占 priceai+shop，池仅在 shop 段运行）。
- 进程重启：orphan running 由现网 `cancelOrphanedRunning` 清理；池仅内存，不恢复。

### 3.6 WAF / background（B2）

> 内置代理 / 节点 pin·rotate 已移除；出站仅直连或环境变量代理（`MA_PROXY` / `HTTP(S)_PROXY`）。

#### WAF

| 场景 | 手动任务 | background（auto-refresh） |
| --- | --- | --- |
| discover `NEED_BROWSER` | merchant 回商家池**队尾一次**（Pass2）；Pass2 再 WAF → fail；health 文案与现网 defer 一致 | **不** defer、**不**开系统浏览器 → 立即 failStore |
| consume 中 `NEED_BROWSER` | 抬升为**整店** WAF：取消该店其余 queued groups；已 running 结束；整店按 defer 规则回队尾一次或 fail | 立即 failStore，不开浏览器 |
| `openSystemBrowserOnWaf` | 仅非 background，且与现网 `runShopQueue` 条件一致 | 恒 false |

#### Pass2

- 每个 merchant 最多 defer **1** 次；Pass2 入队标记 `wafPass2`，不再 defer。
- defer 时若该店已有部分 group 成功：仍取消未跑 group，**不** commit 部分快照；整店重来（避免半新半旧）。实现简单优先：defer 前丢弃该店 accumulator rows，dispose session，重新 discover。

### 3.7 适用范围与 P1 适配矩阵（B5）

| jobType | 行为 |
| --- | --- |
| `shop_one` / `shop_selected` / `shop_all` | 全程双池 |
| `bootstrap` | 商家列表阶段不变；刮店阶段双池 |
| `merchants` | 不变 |
| auto-refresh `shop_one` | 双池 + background 规则 |

**P1 即日起全平台可跑**（不是 P2 才接 dujiao）：

| collector / 平台 | P1 discover | P1 consume |
| --- | --- | --- |
| shopApi 族 | shopInfo → 多 goodsType | 每 type 一 group，共享 session |
| dujiao | 立即入池 1× `groupKey='*'`（discover 可 no-op 或轻探测） | 一组内调现有整店 scrape（`scrapeShopTarget` / scrapeDujiao） |
| yiciyuan | 同上 `*` | 同上现有 scrape |
| 未知/未启用 | merchant skipped 或 failed（同现网 platform gate） |

P2 仅做：抽象清理、去掉「整店组内再调 monolith scrape」的重复 warmup（若有）、文案与可选历史快照。

---

## 4. 后端落地

### 4.1 新模块

- `src/main/services/sync-pool-runtime.ts`：两池、accumulator、session 表、快照。
- `src/main/services/sync-pool-scheduler.ts`：发现/消费/预算/尾波/取消。
- 平台适配：`discoverProductGroups(session, target)` + `scrapeProductGroup(session, group)`；非 shopApi 可 thin-wrap 现有 scrape。

### 4.2 Orchestrator

- `runShopQueue` **替换为** `runShopPool`（无双路径 flag；降低分叉）。
- 保留：lane 锁、settings gate（networkPaused / shopScrapeEnabled / platform enabled）、finish/meta（`ok`/`failed`/`errors[]`/`skippedFresh`/`skippedDisabled`/…）。
- `Map<jobId, SyncPoolRuntime>`；job 结束删除；`leaveSyncRequestScope` 时机与现网一致。
- 开始处理店时 health=`retrying`（有 merchantId）。

### 4.3 IPC

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| `sync:poolSnapshot` | push ≤4Hz | `JobPoolSnapshot` |
| `sync:getPoolSnapshot` | invoke | 打开弹窗拉取；无 runtime 返回 `null` 或 meta 衍生空表 |
| `sync:progress` / `sync:requestLog` | 现有 | progress 按 §3.4；弹窗 request **filter jobId** |

- 通道名写入 `IPC_CHANNELS` + preload `RendererApi.sync`。
- 快照/日志展示 token 时 UI 可截断；主进程日志避免完整 dump。

### 4.4 Request log 清空（P0）

- 现有 buffer 仍为进程内全局 ring；`enterSyncRequestScope` 行为保持现网（新 job 时 scope）。
- 弹窗「清空」：**仅 UI 本地隐藏**该 job 已见条目，或调用 clear 时文档化为**全局清空**（与现网按钮一致）——P0 采用 **全局 clearRequestLogs**（与现网一致），避免假 per-job 清除。
- 历史已结束任务：若 buffer 已被后续 job 覆盖，弹窗请求表可空；不保证回放（可接受）。

### 4.5 持久化

- 池明细不进 SQLite。
- job 结束 `meta.pool = { merchantsTotal, groupsTotal, groupsOk, groupsFailed }`。
- 历史打开：meta 汇总 + 提示「池明细仅运行中可看」。

### 4.6 限速不变式

- 不降低 `shopMinIntervalMs` 下限。
- 一切页请求计入 `requestBudget` 与节点 limiter。
- `discoverConcurrency=1` + `maxOpenStores=2`。

---

## 5. 前端落地

### 5.1 同步中心页（外层）

**保留**

- 页头：同步商家 / 旧数据店 / 强制全量 / 取消（取消仍可针对 running job）
- 统计：粘贴 URL、counts、上次成功
- **任务历史**表（筛选/分页/删除）；running 行显示迷你 `current/total` + phase，点击进弹窗

**移出 → 任务弹窗**

1. **同步请求**整表  
2. **商品同步**运行列表面板  

侧栏全局同步状态保留（现有 App 状态件）。

### 5.2 任务详情弹窗

1. 头：类型 · 状态 · 进度 · 时间 · 本 job 取消  
2. 双池（shop/bootstrap 刮店；merchants 不显示）  
   - 商家池表 / 商品组池表 + caps 与计数  
3. 同步请求（jobId 过滤）  
4. 失败明细 / 重试失败的店  
5. 原始 meta（折叠）  

订阅：`onPoolSnapshot` + `onRequestLog` + `onProgress`。

### 5.3 文案

- `phaseLabel`：pool_*  
- `shopPageConcurrency`：店刮请求并发预算  

---

## 6. 实现分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | 请求表 + 商品同步面板迁入任务弹窗；jobId 过滤；历史 running 迷你进度 | 页外无两表；不打开弹窗仍能从历史/侧栏知 running |
| **P1** | runtime+scheduler+StoreSession+预算+原子 expected+全平台 adapter 矩阵+markOk/Fail 对照+pinExclusive（或明确暂缓 rotation）+pool IPC | 发现/消费重叠；无 \(C^2\)；混合平台 shop_all；空店清空；全失败保留旧数据；pin 期无它店 HTTP |
| **P2** | 非 shopApi 去 monolith 重复；meta/文案打磨；可选 | 结构统一 |
| **P3** | 历史快照 / discoverConcurrency 可配 | 可选 |

顺序：**P0 → P1 → P2**。P0 可先合。

---

## 7. 风险与决策

| 风险 | 处理 |
| --- | --- |
| 并行写同店 | accumulator + expectedFinal 门闩 |
| pin 全局 | pinExclusive |
| 并发放大 | 单一 requestBudget |
| 多 tab | StoreSession + maxOpenStores |
| 空店残留 | N=0 仍 replace [] |
| 池 UI 刷屏 | ≤4Hz；>200 行再虚拟化 |

### 已确认假设

1. 商品组 = shopApi **goodsType**；其它族 **`*` 整店一组**（P1 即支持）。  
2. **单一并发旋钮** `shopPageConcurrency` = 全局请求预算；不新增 group 并发设置。  
3. `discoverConcurrency=1`，`maxOpenStores=2`。  
4. 水位 `startConsumeAt = requestBudget`。  
5. 池仅内存；历史不保证池表/请求回放。  
6. 页外「另一个表」= **商品同步**运行面板。  
7. 部分 group 失败但有成功 rows → 店计 **ok**，job 可能 **partial**。  
8. background：不开浏览器、不 WAF defer。  
9. 无 merchantId 时 health 一律 `setAppHealthByShopRef`。  
10. 非 shopApi P1 可 thin-wrap 现有整店 scrape（组内可能自带 warmup；P2 再收）。  

---

## 8. 验收清单

- [ ] 多店任务：发现与组消费时间重叠  
- [ ] 慢 discover 多 type：不会在 expected 未最终时 replace  
- [ ] `requestBudget=3` 时 in-flight 页请求峰值 ≤3  
- [ ] 空店：本地 SKU 被清空且 healthy  
- [ ] 全失败店：旧 SKU 保留、failing、blocklist 策略仍生效  
- [ ] 成功店：replace + relink + healthy  
- [ ] notFamily：clearShopRef  
- [ ] pin 期间无其它 store HTTP  
- [ ] background WAF：立即失败、不开浏览器  
- [ ] 取消后无 running 残留、不错误 finish success  
- [ ] 混合平台 `shop_all`（shopApi+dujiao+yiciyuan）  
- [ ] 页外无同步请求表/商品同步面板；弹窗内按 job 可见  
- [ ] `merchants` 无回归  
- [ ] 单测：水位、尾波、expected 门闩、取消、预算  

---

## 9. 明确不做

- page 作为池单元  
- 跨 job 共享池  
- 多窗口协作  
- 削弱 networkPaused / platform enabled / blocklist  
- 静默 \(C^2\) 并发  
- 无互斥的并行 pin  
