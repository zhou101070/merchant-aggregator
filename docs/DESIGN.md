# DESIGN.md — Merchant Aggregator UI 规范

| 字段     | 值                                                                      |
| -------- | ----------------------------------------------------------------------- |
| 版本     | 1.0(2026-07-17)                                                         |
| 状态     | 已确认方向:双主题跟随系统 · 搜索即首页 · 石墨+黄铜 · macOS 无边框标题栏 |
| register | product(工具型 UI)                                                      |
| 适用范围 | `src/renderer/**` 全部界面,`src/main/index.ts` 窗口配置                 |

---

## 1. 设计立场

**概念:精密比价仪器(Instrument, not App)。**

这是一台单人使用的桌面仪器:深色石墨机身,黄铜只镶在关键读数上。用户来这里做一件事——认出最低价,然后离开。界面必须让位于数据。

四条原则,冲突时按序取舍:

1. **数据即界面**。价格、库存、新鲜度是主角;等宽数字是本产品的排印签名。装饰性元素一律不设。
2. **克制的唯一例外是黄铜**。整个界面只有一种非语义颜色(黄铜/古铜),且只出现在:主操作、选中/焦点、当前导航、最低价标记。黄铜出现 = 值得看。
3. **熟悉优先于新奇**。标准控件、标准布局、标准快捷键。工具应消失在任务里;惊喜只留给"找到最低价"那一刻。
4. **状态永远可见**。同步是唯一的网络行为,它的进度、结果、错误必须在任何页面都有着落(侧栏状态件),绝不静默。

**反 AI 味承诺**(实现与评审的硬性检查项,见 §11 禁则):不用渐变、不用毛玻璃、不用辉光背景、不用彩色侧条、不用胶囊徽章刷屏、不用图标+标题+描述的同构卡片阵列、不用大数字仪表盘模板。

---

## 2. 主题架构

- 双主题,**跟随系统**,无手动开关。实现:`:root { color-scheme: light dark }` + 全令牌 `light-dark()` 函数(Chromium 123+,Electron 39 原生支持)。
- 主进程窗口 `backgroundColor` 依 `nativeTheme.shouldUseDarkColors` 设定并监听 `updated` 事件,避免主题切换/启动白闪。
- 组件与页面样式**只允许引用语义令牌**,禁止裸色值;两主题共享同一套语义角色。

## 3. 色彩系统

策略:**Restrained(克制)**——中性石墨底 + 单一黄铜 accent(≤10% 表面积)+ 三个语义色。所有值为 OKLCH;十六进制仅为参考近似。**全部配对已通过 WCAG 对比度脚本验证**(见 §10)。

### 3.1 中性层(石墨,向黄铜色相 80–85° 微偏 0.002–0.008 chroma)

| 令牌              | 角色                       | 深色                              | 浅色                              |
| ----------------- | -------------------------- | --------------------------------- | --------------------------------- |
| `--bg-sunken`     | 侧栏/导轨(第二中性层)      | `oklch(0.135 0.004 80)` ≈ #090807 | `oklch(0.955 0.004 85)` ≈ #f1f0ed |
| `--bg`            | 内容画布                   | `oklch(0.165 0.005 80)` ≈ #0f0e0c | `oklch(0.975 0.003 85)` ≈ #f8f7f4 |
| `--bg-raised`     | 面板/表格/输入             | `oklch(0.19 0.006 80)` ≈ #151411  | `oklch(0.995 0.002 85)` ≈ #fefdfc |
| `--bg-overlay`    | 对话框/抽屉/弹层           | `oklch(0.215 0.007 80)` ≈ #1b1916 | `oklch(1 0 0)`                    |
| `--bg-hover`      | 行/项悬停                  | `oklch(0.93 0.007 85 / 5%)`       | `oklch(0.22 0.012 85 / 4%)`       |
| `--border`        | 发丝分隔线                 | `oklch(0.28 0.008 85)`            | `oklch(0.90 0.006 85)`            |
| `--border-strong` | 控件描边                   | `oklch(0.36 0.010 85)`            | `oklch(0.82 0.008 85)`            |
| `--ink`           | 主文字                     | `oklch(0.93 0.007 85)` ≈ #eae8e3  | `oklch(0.22 0.012 85)` ≈ #1d1a14  |
| `--ink-2`         | 次级文字                   | `oklch(0.70 0.010 85)`            | `oklch(0.44 0.014 85)`            |
| `--ink-3`         | 弱文字/占位符(仍须 ≥4.5:1) | `oklch(0.64 0.010 85)`            | `oklch(0.50 0.014 85)`            |
| `--ink-4`         | 仅限禁用态                 | `oklch(0.48 0.008 85)`            | `oklch(0.68 0.010 85)`            |

### 3.2 黄铜(唯一 accent)

| 令牌             | 角色                          | 深色                             | 浅色                             |
| ---------------- | ----------------------------- | -------------------------------- | -------------------------------- |
| `--accent`       | 主按钮填充/进度条/选中指示    | `oklch(0.80 0.125 84)` ≈ #e4b756 | `oklch(0.67 0.125 80)` ≈ #bd8b29 |
| `--accent-hover` | 主按钮悬停                    | `oklch(0.84 0.125 84)`           | `oklch(0.63 0.125 80)`           |
| `--accent-ink`   | 黄铜填充上的文字              | `oklch(0.23 0.04 84)`            | `oklch(0.22 0.03 80)`            |
| `--accent-text`  | 黄铜作为文字(最低价等)        | 同 `--accent`                    | `oklch(0.47 0.11 78)` ≈ #7c5100  |
| `--accent-edge`  | 主按钮描边(浅色需要,深色透明) | `transparent`                    | `oklch(0.52 0.11 78)`            |
| `--accent-wash`  | 选中行/激活项底色             | `oklch(0.80 0.125 84 / 10%)`     | `oklch(0.55 0.12 78 / 9%)`       |
| `--focus`        | 焦点环(2px, offset 1px)       | 同 `--accent`                    | `oklch(0.55 0.12 78)`            |

**黄铜使用白名单**:主按钮、focus ring、当前导航项指示、选中行底纹、同步进度条、最低价标记、搜索关键词高亮。其余场合一律中性或语义色。

### 3.3 语义色(仅表达状态,不做装饰)

| 令牌                                          | 语义                 | 深色                   | 浅色                   |
| --------------------------------------------- | -------------------- | ---------------------- | ---------------------- |
| `--ok`                                        | 有货/健康/成功       | `oklch(0.76 0.14 155)` | `oklch(0.50 0.13 155)` |
| `--danger`                                    | 异常/失败            | `oklch(0.72 0.16 25)`  | `oklch(0.50 0.18 27)`  |
| `--warn`                                      | 过期/重试/部分成功   | `oklch(0.76 0.13 60)`  | `oklch(0.51 0.12 60)`  |
| `--ok-wash` / `--danger-wash` / `--warn-wash` | 对应 10–12% 透明底纹 | —                      | —                      |

注意:`--warn`(橙,60°)与黄铜(84°)刻意拉开色相;黄铜=值得注意的**好事**,橙=需要留意的**风险**。

## 4. 字体排印

| 令牌          | 值                                                                                                  | 用途                                                        |
| ------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `--font-ui`   | `-apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif` | 全部界面文字(CJK 交由系统最优渲染,桌面原生质感)             |
| `--font-data` | `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`                                   | **数据签名字体**:价格、库存数、统计数、host、token、ID、kbd |

- IBM Plex Mono 经 `@fontsource/ibm-plex-mono` 打包进应用(400/500/600),离线可用,符合 CSP `self`。
- **固定 rem 刻度,不用 clamp 流式字号**(工具 UI 规范):

| 令牌         | 大小/行高   | 用途                   |
| ------------ | ----------- | ---------------------- |
| `--text-xs`  | 11px / 1.5  | 表头、徽章、元信息     |
| `--text-s`   | 12px / 1.5  | 次要说明、时间戳       |
| `--text-m`   | 13px / 1.55 | 正文与表格单元格(基准) |
| `--text-l`   | 14px / 1.5  | 输入框、按钮、强调正文 |
| `--text-xl`  | 16px / 1.4  | 面板/区块标题          |
| `--text-2xl` | 20px / 1.3  | 页面标题(weight 600)   |

- 字重仅 400 / 500 / 600;禁用 700+。CJK 不加负字距;表格数字一律 `font-variant-numeric: tabular-nums`。
- **价格排版(签名)**:等宽 500,币种符号用 `--text-s` `--ink-2`,金额用 `--text-l`;同列右对齐。最低价:金额转 `--accent-text` + 前置 `●` 圆点标记与「最低」小字,不用胶囊。
- 长文案(空态说明等)行宽 ≤ 34em(约 65ch 中文)。

## 5. 空间、圆角、边框、阴影、层级

- **间距**:4px 基础网格。刻度 `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40`。页面内容内边距 24px;面板内边距 16px;表格单元格 `10px 12px`。
- **圆角**:`--radius-xs: 4px`(徽章、kbd)· `--radius-s: 6px`(按钮、输入、chip)· `--radius-m: 10px`(面板)· `--radius-l: 14px`(对话框、抽屉)。**不用 999px 胶囊**,chip 亦是 6px。
- **边框**:分隔靠 `--border` 发丝线;控件用 `--border-strong`。禁止 >1px 的彩色边(侧条禁则)。
- **阴影**(深色主题阴影极轻,层次主要靠 surface 阶梯 + 边框):
  - `--shadow-1`(面板,浅色才明显):`0 1px 2px oklch(0.2 0.02 85 / 6%)`
  - `--shadow-2`(弹层):`0 4px 16px oklch(0.15 0.02 85 / 14%)`
  - `--shadow-3`(对话框/抽屉):`0 16px 48px oklch(0.1 0.02 85 / 22%)`
- **z 层级(语义刻度,禁止 999)**:`--z-sticky: 10`(表头)· `--z-widget: 20` · `--z-drawer: 30` · `--z-backdrop: 40` · `--z-dialog: 50` · `--z-toast: 60`。

## 6. 动效

- 缓动:`--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`(quint 出)。禁止弹跳/回弹。
- 时长:`--dur-1: 120ms`(悬停/按压)· `--dur-2: 200ms`(选中、切换)· `--dur-3: 280ms`(抽屉、对话框)。
- 动效只表达**状态**:对话框 fade + scale(0.98→1);抽屉 `translateX(16px)` + fade;toast 上浮 + fade;进度条宽度 300ms;行悬停仅背景色过渡。
- **无页面加载编排、无滚动入场动画、无 stagger**。工具打开即工作。
- `@media (prefers-reduced-motion: reduce)`:全部过渡与动画降为 `1ms`,进度条保留(它是信息)。

## 7. 组件规范

统一实现在 `components/ui.tsx` + `components/icons.tsx` + `components/select.tsx` + `components/dialog.tsx` + `components/toast.tsx`。每个交互组件必须实现:default / hover / focus-visible / active / disabled(/ loading 若适用)。

| 组件                      | 规格                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Button**                | 高度 32px(s: 26px),radius 6,text-l/500。变体:`primary`(黄铜填充 + `--accent-ink` 文字 + `--accent-edge` 描边)· `default`(`--bg-raised` + `--border-strong` 描边)· `ghost`(无框,悬停 `--bg-hover`)· `danger`(danger 文字 + 描边,填充仅确认对话框内)。loading:内置 14px 旋转圆环,文字保留。                                                                                                                                                                                                                                                                                                                          |
| **IconButton**            | 28×28,ghost 样式;必须带 `aria-label` 与 `title`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Input / Select 触发器** | 高度 32px,`--bg-raised` 底 + `--border-strong` 描边;focus 切 `--focus` 环(offset 0 贴边);占位符用 `--ink-3`(已验 ≥4.5:1)。搜索主输入为 40px 特例。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Select(下拉)**          | **全自绘,禁止原生弹出菜单**(`<select>` 不得出现在 renderer)。触发器=Input 规格 + 右侧 chevron(展开旋转 180°);面板=顶层 popover,CSS 锚定触发器下方 4px(`position-area`,空间不足 `flip-block` 自动上翻,`anchor-size` 保证宽度 ≥ 触发器),`--bg-overlay` + 边框 + shadow-2,radius-m,max-height 320;选项 30px/radius-xs,活动项 7% 墨色底(浮层底更亮,`--bg-hover` 不够辨识),选中项黄铜 ✓ + 500 字重(✓ 计入 §3.2 白名单:选中态),隐藏 ✓ 占位保证对齐;键盘=select-only combobox 模式:↑↓/Home/End 移动、Enter/Space 提交、Esc/外点光解散、Tab 关闭不提交、字符前缀跳转;焦点始终在触发器,`aria-activedescendant` 指示活动项。 |
| **Checkbox**              | 原生 `accent-color: var(--accent)`,16px。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Switch**                | 34×20 轨道,用于设置页布尔项;开=黄铜轨道,关=`--border-strong`;圆点 16px,`--dur-2` 过渡。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Badge**                 | 11px/500,radius 4,`*-wash` 底 + 语义色文字,无描边。仅用于**状态**(健康/任务态/商品类型),禁止装饰性使用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **StatusDot**             | 6px 圆点 + 12px 文字,替代表格里的大面积徽章;色即语义色。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Chip(过滤)**            | 26px 高,radius 6,`--border-strong` 描边;激活:`--accent-wash` 底 + `--accent-text` 文字 + accent 描边。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Segmented**             | 排序等互斥小选择;28px 高容器 `--bg-sunken`,选中片 `--bg-raised` + 边框 + shadow-1。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Kbd**                   | 等宽 11px,`--bg-sunken` 底,radius 4,1px 边。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **ProgressBar**           | 3px 高,轨道 `--border`,值 `--accent`;不确定态:20% 宽度片段循环平移。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Table**                 | 表头:text-xs/500/`--ink-2`,`--bg-raised` 底,sticky + 底部发丝线,z-sticky;行:悬停 `--bg-hover`,键盘选中 `--accent-wash` 底(不用左侧条);单元格数字列右对齐 + 等宽。行操作按钮默认 40% 不透明度,行悬停/选中时恢复(键盘焦点不受影响)。                                                                                                                                                                                                                                                                                                                                                                                 |
| **EmptyState**            | 纯排印:text-xl 标题 + text-m/`--ink-2` 说明(≤34em)+ 操作组;不配插画不配 emoji;空态必须"教下一步"(给出可点的动作)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Skeleton**              | 表格加载用行骨架(`--bg-hover` 底微脉冲),禁止内容区中央转圈。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Dialog**                | 原生 `<dialog>.showModal()`;radius-l,`--bg-overlay`,shadow-3;标题 text-xl,正文 text-m/`--ink-2`;按钮右对齐(取消 default + 确认 primary/danger)。Promise 风格 `confirm(spec)` API,**全面替换 `window.confirm`**。backdrop `oklch(0 0 0 / 45%)`。                                                                                                                                                                                                                                                                                                                                                                    |
| **Toast**                 | 右上角(mac 无边框时避开红绿灯下移),`--bg-overlay` + 边框 + shadow-2,radius-m;text-m;4s 自动消失;成功/失败前置 StatusDot。**替换全部 flash banner。**                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Drawer(比价)**          | 右侧滑出 420px,`--bg-overlay`,左缘发丝线 + shadow-3;Esc/遮罩点击关闭;头部:标题 + 关闭 IconButton。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Icon**                  | 手绘内联 SVG,16×16,stroke 1.5,round cap/join,`currentColor`。集合:search / store / bookmark / sync / gear / clock / external / refresh / close / check / chevron-down / chevron-right / download / compare / alert / spinner。禁止混入其他风格图标。                                                                                                                                                                                                                                                                                                                                                               |

## 8. 交互模式

### 8.1 信息架构(本次变更)

```
侧栏:搜索(/) · 商家(/merchants) · 收藏(/favorites) · 同步(/sync) · 设置(/settings)
```

- **搜索即首页**:`/` = 搜索页;`/search` 302 到 `/`。原首页删除,其分阶段冷启动引导并入搜索空态(§9.1)。
- **顶栏取消**:原顶栏的二级搜索框与提示文案删除;窗口拖拽区由侧栏 + 内容区顶部 12px 隐形条带承担(`-webkit-app-region: drag`,交互元素 `no-drag`)。
- **⌘K**:任意页面聚焦搜索输入(不在 `/` 则先导航);输入框内右侧常驻 `⌘K` Kbd 提示。
- **侧栏同步状态件**(常驻底部):空闲=三行计数(等宽数字)+ 最近同步时间;运行中=任务名 + ProgressBar + `当前/总数` + 取消 IconButton;整体可点 → `/sync`。全局唯一的同步反馈锚点。

### 8.2 反馈与确认

- 长任务发起前:Dialog 确认(替代 `window.confirm`),正文说明范围/时长/可取消,确认按钮 primary。
- 操作回执(已收藏/已开始同步/已保存):Toast,不再用页面内 banner 挤压布局。
- 错误:同步错误落同步中心 + 侧栏状态件变 danger;表单错误就地红字。

### 8.3 macOS 原生化窗口

- `titleBarStyle: 'hiddenInset'`(仅 darwin;Win/Linux 保持默认 + `autoHideMenuBar`)。
- 红绿灯悬于侧栏 sunken 底上;侧栏顶部预留 52px;`minWidth 960 / minHeight 620`。
- 渲染层以 `data-platform="darwin|win32|linux"` 适配留白。

## 9. 页面规格

### 9.1 搜索(首页)

- 头部:40px 大输入框(左 search 图标,右 ⌘K Kbd),宽 ≤720px;右侧排序 Segmented(相关度/价格↑)+ 仅有货 Chip + CSV 导出 IconButton。
- 过滤行:规格 chips(质保/直登/成品/Pro/Plus/邮箱/Claude/GPT)+ 命中后店铺 facet chips(计数用等宽)。
- **起始态**(有数据、无查询):「从上次继续」最近浏览 6–8 条(单行列表:标题 + 类型 + 相对时间,点击=按标题重搜/进商家)+ 规格 chips。教用户从哪开始,不留白屏。
- **冷启动空态**(无商家/无商品):EmptyState 分阶段——`need_merchants`:一键初始化(primary)+ 只同步商家(default);`need_products`:同步 Top 50(primary)+ 全量 ldxp + 去商家列表。承接原首页职责。
- **无命中**:EmptyState + 候选店 CTA(「按关键词匹配到 N 家待同步…」primary 按钮)。
- 结果表:商品(标题高亮 `--accent-wash` 底 + 类型 Badge)| 价格(等宽右对齐,最低=`● 最低` 黄铜)| 店铺(名 + StatusDot 健康)| 库存(等宽)| 更新(相对时间,过期=warn 色 + 刷新链接)| 操作(打开源站 primary-s / 比价 / 收藏,悬停显影)。
- 键盘流:↑↓ 选行(`--accent-wash`)、Enter 开源站、Esc 取消;提示行固定在表格底部状态条:`N 条命中 · ↑↓ 选择 · Enter 打开 · Esc 取消`。
- 比价 = 右侧 Drawer:同标题跨店行(店/价/库存/开),最低行黄铜标记;弱聚合提示用 warn 文字置顶。

### 9.2 商家

- 头部:标题 + 计数元信息(等宽);操作组:同步商家列表 / 同步所选(n) / 全量同步 ldxp(primary)。运行中整组替换为「取消同步」。
- 过滤行:搜索输入 + 仅 ldxp Chip + 尚未同步商品 Chip + 健康 Select。
- 主从布局:列表(勾选列仅 ldxp 可选 / 店名+collector 等宽小字 / 同步状态 StatusDot+相对时间 / 本地商品数等宽 / host 等宽 / ldxp 可同步 Badge)‖ 右详情面板(sticky 独立滚动):店名 text-xl、id 等宽可复制、状态行、平台标签(纯文字 · 分隔)、操作组(打开店铺 primary / 同步该店 / 收藏 / 关闭 IconButton)、店内商品迷你表。
- 全量/多选同步走 Dialog 确认;回执走 Toast。

### 9.3 收藏与最近

- 两个面板:收藏(名称+备注 / 当前价等宽 / 库存 / 更新 / 类型 / 操作:开源站·商家·去比价·移除)与最近浏览(标题 / 类型 / 时间 / 开源站);行点击行为保留。
- 头部操作:刷新收藏的店(n)+ 刷新列表(ghost)。
- 空态按 §7 EmptyState 规范("在搜索结果里点收藏"= 教路径)。

### 9.4 同步中心

- 头部操作:同步商家列表 / 增量同步 ldxp(primary)/ 强制全量;运行中显示取消。
- 统计:**单行内联**(`商家 333 · ldxp 214 · 商品 6,512`,数字等宽 text-xl)+ 各类型最近成功时间的小字定义行。**不做大数字卡片网格**(禁则)。
- 任务表:任务 / 状态(StatusDot+文字)/ 进度(等宽 `当前/总数` + 运行行内嵌 3px ProgressBar)/ 信息(message + 错误码 hint;失败店列表用 `<details>` 展开 + 重试失败的店按钮)/ 时间(相对)。

### 9.5 设置

- max-width 560;三个分组面板:**同步**(暂停所有网络同步 Switch / 允许 ldxp 深刮 Switch / PriceAI 间隔 / ldxp 最小间隔 / 新鲜期小时,数字输入右缀单位)· **外链**(模式 Select + 各选项一行说明)· **数据与诊断**(诊断 JSON 折叠 `<details>`,等宽 11px)。
- 每项:label text-m + 说明 text-s/`--ink-2`;保存回执 Toast「已保存」。

## 10. 无障碍与质量门槛(发布前逐项过)

1. 正文/占位符对全部承载底 ≥ 4.5:1;大字(≥18.66px bold)≥ 3:1;黄铜填充上文字 ≥ 4.5:1。**用 `scripts/check-contrast.mjs` 对令牌矩阵回归**(本文档全部值已通过 26 组配对验证)。
2. 全部交互元素有可见 `:focus-visible`(`--focus` 2px 环,offset 1px);IconButton 有 `aria-label`。
3. 键盘:⌘K、↑↓/Enter/Esc、Dialog 焦点圈闭(原生 showModal)、抽屉 Esc 关闭。
4. `prefers-reduced-motion` 全覆盖。
5. 双主题 × 全 5 页截图审查(`MA_SCREENSHOT_DIR` 钩子),检查:溢出、对齐、层次、AI 味禁则。
6. `pnpm typecheck && pnpm lint` 零错误。

## 11. 禁则(评审硬性拒绝项)

1. 渐变(背景/按钮/文字 `background-clip: text` 一律禁止)。
2. `backdrop-filter` 毛玻璃、径向辉光、发光阴影。
3. > 1px 彩色左/右侧条(卡片、列表、callout)。
4. 胶囊(999px)徽章/按钮;装饰性 Badge。
5. 大数字 + 小标签的 hero-metric 卡片阵列。
6. 图标+标题+两行描述的同构卡片网格;嵌套卡片。
7. 全大写宽字距 eyebrow、01/02/03 章节编号。
8. emoji 当图标;混用图标风格。
9. 内容区中央 spinner(用 Skeleton);入场编排动画。
10. 裸色值(必须走令牌);任意 z-index(必须走刻度)。
11. 非白名单场合使用黄铜。
12. 原生 `<select>` / 系统弹出菜单(下拉一律用 `components/select.tsx`)。

## 12. 文件结构与实施说明

```
src/renderer/src/
  styles/tokens.css      # 全部令牌(light-dark 双主题)——唯一的颜色事实源
  styles/app.css         # 壳层 + 组件 + 页面样式(只引用令牌)
  components/icons.tsx   # 内联 SVG 图标集
  components/ui.tsx      # 基础控件
  components/select.tsx  # 统一下拉(自绘触发器 + 顶层 popover 列表,零原生 select)
  components/dialog.tsx  # ConfirmProvider(原生 <dialog>)
  components/toast.tsx   # ToastProvider
  components/use-confirm.ts  # ConfirmSpec 类型 + useConfirm()(与组件分文件,满足 react-refresh)
  components/use-toast.ts    # useToast()(同上)
  lib/confirm-sync.ts    # 同步类确认文案的规格构建器(供 useConfirm 使用)
  lib/focus-search.ts    # ⌘K 聚焦搜索输入(data-search-input)
  App.tsx                # 壳:侧栏(导航+同步状态件)+ 路由
  pages/{Search,Merchants,Favorites,SyncCenter,Settings}Page.tsx
scripts/check-contrast.mjs  # 令牌对比度回归
```

- 删除:`pages/HomePage.tsx`、`pages/PlaceholderPage.tsx`、`components/Versions.tsx`、`assets/{main,base}.css`、`assets/*.svg`。
- 依赖新增:`@fontsource/ibm-plex-mono`(唯一新增;不引组件库、不引动效库——本规范动效均为 CSS 可达)。
- 主进程:`titleBarStyle`/`minWidth`/`backgroundColor(nativeTheme)` + `MA_SCREENSHOT_DIR` 截图钩子(dev 工具,环境变量门控)。
