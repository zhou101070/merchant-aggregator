# Merchant Aggregator

个人向桌面比价聚合工具：从 **PriceAI** 同步商家主档，按需深刮 **shopApi 系发卡网**（当前 `ldxp` / `catfk`）店内商品，在 **本地 SQLite** 上跨店搜索、比价、收藏并跳转源站。

- **搜索永不联网**；所有外网请求均由用户显式发起的同步任务完成
- **价格以店内商品为准**（非 PriceAI offers）
- UI 为工具风「精密比价仪器」：石墨底 + 黄铜 accent；主题默认跟随系统，可在设置中强制浅/深色

## 功能概览

| 页面             | 能力                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| **搜索（首页）** | 关键词 / 规格 chips / 店铺 facet / 分页；结果标「最低」与新鲜度；无数据时推荐待同步候选店 |
| **商家**         | 列表筛选（平台、健康度、可刮店等）+ 详情；单店 / 多选同步                                 |
| **收藏与最近**   | 盯价清单与最近浏览；可只刷新相关店                                                        |
| **同步中心**     | 一键初始化 / 增量 / 强制全量 / 单店；任务历史筛选与分页、详情、删除与清空、重试失败店     |
| **设置**         | 主题、限速、新鲜期、UA、外链 allowlist 等合规控制                                         |

规格 chips（如 Plus）在标题子串匹配基础上会排除否定表述（`非Plus`、`不含plus` 等）。

## 数据流

```
PriceAI /api/merchants  ──同步──►  merchants（主档）
shopApi Shop/info + goodsList ──►  shop_products（店内商品）
用户搜索 / 筛选 / 比价          ──►  仅读本地 SQLite
```

- 库文件：`userData/merchant-aggregator.db`（schema **v5**：含 `shop_platform` / `shop_token`、收藏基线/目标价等）
- 平台配置单一来源：`src/shared/platforms/shop-profiles.ts`

## 技术栈

| 层     | 技术                                              |
| ------ | ------------------------------------------------- |
| 壳     | Electron 39 + electron-vite                       |
| UI     | React 19 + React Router + 自研组件（无 UI 框架）  |
| 主进程 | TypeScript、better-sqlite3、undici（请求头/UA）   |
| 通信   | preload 类型安全 IPC（`src/shared/types/ipc.ts`） |
| 测试   | Vitest（`pnpm test` 会先 rebuild native 模块）    |

### 目录（简）

```
src/
  main/           # 窗口、DB、同步编排、平台客户端、IPC
    db/           # schema / migrate / repositories
    platforms/    # priceai · shopapi（含 ldxp 兼容）
    services/     # search / sync-orchestrator / http-client
  preload/        # 暴露 window.api
  renderer/       # 页面与样式
  shared/         # 类型、常量、平台 profile、查询工具
docs/             # 产品与视觉规范
```

## 开发

```bash
pnpm install
pnpm dev          # 开发（会 rebuild better-sqlite3 给 Electron）
pnpm test         # 单测（临时 rebuild 给 Node，结束后再给 Electron）
pnpm typecheck
pnpm lint
pnpm build        # typecheck + 打包编译
```

常用脚本：

| 命令                                           | 说明                |
| ---------------------------------------------- | ------------------- |
| `pnpm dev`                                     | 本地跑应用          |
| `pnpm test`                                    | Vitest              |
| `pnpm typecheck`                               | main + web 类型检查 |
| `pnpm build:win` / `build:mac` / `build:linux` | 各平台安装包        |

**说明**：`better-sqlite3` 需与运行时 Node/Electron ABI 一致。若测试或 dev 报 native 模块版本错误，先关掉正在运行的应用，再执行 `pnpm run rebuild:native:node` 或 `pnpm run rebuild:native:electron`。

Windows 上若 `git push` 的 SSH 22 端口超时，可改用 HTTPS remote。

## 使用（最短路径）

1. **一键初始化**：同步商家列表 + 报价数 Top 店铺商品，完成后即可搜货
2. **`⌘/Ctrl+K`** 聚焦搜索：`↑↓` 选行、`Enter` 打开源站；规格 chips 与店铺 facet 收窄结果
3. **增量同步**：同步中心按设置中的新鲜期跳过近期成功店；「强制全量」忽略新鲜期
4. 任务失败可在历史里打开详情，**重试失败的店**
5. **收藏** = 盯价清单，可只刷新相关店铺

## 文档索引

| 文档                               | 内容                                |
| ---------------------------------- | ----------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品定位、核心面、语气              |
| [docs/DESIGN.md](docs/DESIGN.md)   | UI 视觉与交互规范（实现以代码为准） |

## 边界（不做）

- 账号体系、云同步、多用户
- 下单 / 支付 / 上传等写接口
- 整站镜像或对外数据 API
- 搜索路径上的任何自动联网 scrape
