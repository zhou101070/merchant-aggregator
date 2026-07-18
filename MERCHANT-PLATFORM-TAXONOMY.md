# 商家平台类型分类

> 基于本机开发库快照整理 · 2026-07-18
>
> 库路径：`%APPDATA%\Merchant Aggregator\merchant-aggregator.db`
>
> 商家总数 **301** · PriceAI offer 合计 **6465** · 已识别可刮平台 **225** · 无 `shop_platform` **76**

## 结论（先看）

**不是。** 本地 301 家商家并非「各店自己从零开发的发卡平台」。

| 判断 | 说明 |
| --- | --- |
| **主体是租用/部署现成方案** | 约 **73%** 落在 shopApi 白标族（ldxp / catfk），共用同一套店内 API |
| **其次是开源/模板发卡** | 独角数卡 `dujiao` 23 家；卡密模板族 `kami` 32 家 |
| **真正像单站自研/强定制** | 专用 API / 品牌页：`getgptApi`、`ikunloveApi`、`blackcatWholesale`、`xiaoheiwan` 等，合计约 **个位数～十余家** |
| **本应用能深刮的** | 仅 **shopApi 系**（当前 profile：`ldxp`、`catfk`），其余只有 PriceAI 主档 |

分类依据：

1. 本应用字段：`shop_platform` / `shop_token`（由 URL host 匹配 `SHOP_PROFILES` 推导）
2. PriceAI 主档字段：`collector_kind`（上游采集器类型，是「技术栈/页面族」最强信号）
3. 公开信息：如独角数卡 [assimon/dujiaoka](https://github.com/assimon/dujiaoka)

未对 76 家无平台站逐一 HTTP 指纹探测；`kami` / 部分 HTML 类置信度为中/低，文中已标注。

## 总览：按 PriceAI `collector_kind`

| collector_kind | 商家数 | offer 数 | 有 shop_platform | 平台族归类 | 本应用深刮 |
| --- | ---: | ---: | ---: | --- | --- |
| `shopApi` | 221 | 5443 | 221 | shopApi 白标发卡网 | 是 |
| `kami` | 32 | 499 | 0 | 卡密系模板站 | 否 |
| `dujiao` | 23 | 266 | 0 | 独角数卡 | 否 |
| `genericHtml` | 9 | 104 | 0 | 通用 HTML 抓取 | 否 |
| `(null)` | 4 | 4 | 4 | collector 缺失 | 部分（ldxp） |
| `unicornHtml` | 2 | 9 | 0 | Unicorn 系 HTML | 否 |
| `publicProductsApi` | 2 | 33 | 0 | 公开商品 API | 否 |
| `xiaoheiwan` | 1 | 25 | 0 | xiaoheiwan 专用 | 否 |
| `shopUserProductsApi` | 1 | 1 | 0 | 店铺用户商品 API | 否 |
| `opensoraHtml` | 1 | 2 | 0 | OpenSora / AUTO FK HTML | 否 |
| `makerichHtml` | 1 | 15 | 0 | MakeRich HTML | 否 |
| `ikunloveApi` | 1 | 9 | 0 | ikunlove 专用 API | 否 |
| `getgptApi` | 1 | 5 | 0 | GetGPT 专用 API | 否 |
| `blackcatWholesale` | 1 | 40 | 0 | BlackCat 批发页 | 否 |
| `beibeiHtml` | 1 | 10 | 0 | beibei HTML | 否 |

## 本应用可深刮：shopApi 白标族

### 特征

- 店内接口同一族（`Shop/info` + `goodsList` 等），host 白名单在 `src/shared/platforms/shop-profiles.ts`
- 同步商家列表时由 `deriveShopRef()` 从 `shop_url` / `entry_url` 解析 `shop_platform` + `shop_token`
- **商家不自研整站**，而是使用同一套白标/多租户发卡网；ldxp = 链动小铺，catfk = 同族白标域名

### 本库数量

| shop_platform | 可刮商家 | offer 合计 | 说明 |
| --- | ---: | ---: | --- |
| `ldxp` | 218 | 5327 | 链动小铺 |
| `catfk` | 7 | 120 | catfk 白标 |

**小计：225 家可刮**（占全库 74.8%）。

其中 `collector_kind=shopApi` 221 家 + `collector_kind` 为空但 `shop_platform=ldxp` 4 家 = 225。

## 无 `shop_platform` 的 76 家：按技术族分类

这些店 **不能** 走本应用 shopApi 深刮；PriceAI 仍提供主档（名称、host、offer 数等）。

### A. 开源 / 知名发卡程序（可明确归类）

部署开源或衍生版，不是「从零自研」。

#### `dujiao` — 独角数卡（23 家 · offer 266）

- **来源/形态**：开源自动售货系统 assimon/dujiaoka（Laravel），后继 Dujiao-Next
- **开源？**：是（原版 MIT；fork/Next 变体常见）
- **是否自研整站？**：否 — 自建部署开源/衍生发卡程序
- **本应用深刮**：否 — 仅 PriceAI 主档，无本地深刮
- **置信度**：高（collector_kind 与业界指纹一致）

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| Auto Subscribe / ultra.makelove.cloud | `ultra.makelove.cloud` | 38 | healthy | https://ultra.makelove.cloud/ |
| Auto Subscribe / BurstPro AI | `burstpro-ai.online` | 29 | healthy | https://burstpro-ai.online/ |
| xtacc.top | `xtacc.top` | 22 | healthy | https://xtacc.top/ |
| 91网|一手货源 | `gmail91.shop` | 20 | healthy | https://gmail91.shop/ |
| Auto Subscribe / shop.aitonse.com | `shop.aitonse.com` | 20 | failing | https://shop.aitonse.com/ |
| flyai.qzz.io | `flyai.qzz.io` | 16 | healthy | https://flyai.qzz.io/ |
| TxyxT小店 | `shop.txyxt.dpdns.org` | 15 | healthy | https://shop.txyxt.dpdns.org/ |
| 小恐龙发卡网 | `morimm.com` | 15 | healthy | https://morimm.com/ |
| 艾琳 | `shop.aictk.shop` | 12 | healthy | https://shop.aictk.shop/ |
| 沐风源头 | `shop.mfttai.com` | 11 | healthy | https://shop.mfttai.com/ |
| cc-cat | `ccdawang.win` | 9 | healthy | https://ccdawang.win/products |
| jzai168.com | `jzai168.com` | 9 | failing | https://jzai168.com/ |
| Auto Subscribe / kapay.shop | `kapay.shop` | 7 | healthy | https://kapay.shop/ |
| 账号小卖铺 | `11.id2323.top` | 7 | failing | https://11.id2323.top/ |
| Auto Subscribe | `shop.auto-subscribe.com` | 6 | healthy | https://shop.auto-subscribe.com/ |
| n1.ccnmgpt.com | `n1.ccnmgpt.com` | 6 | failing | https://n1.ccnmgpt.com/ |
| zhang520.store | `zhang520.store` | 5 | healthy | https://zhang520.store/ |
| AIXOU | `buy.aixou.top` | 4 | healthy | https://buy.aixou.top/ |
| CC卡网 | `cccrad.uk` | 4 | healthy | https://cccrad.uk/ |
| geekaihub.com | `geekaihub.com` | 4 | healthy | https://geekaihub.com/ |
| 小久卡网 | `98-xj.com` | 4 | healthy | https://98-xj.com/ |
| team | `faka.aiceo.dev` | 2 | healthy | https://faka.aiceo.dev/ |
| 王哈哈Ai | `shop.whh985.com` | 1 | healthy | http://shop.whh985.com/ |

### B. 常见卡密模板族（非自研整站，具体上游难逐站钉死）

PriceAI 用同一采集器覆盖；页面/发货形态高度同质，多数为模板站或二次皮肤。

#### `kami` — 卡密系模板站（32 家 · offer 499）

- **来源/形态**：PriceAI 标注的 kami 采集族：常见「卡密自动发货」PHP/前后端模板（同类竞品众多，页面结构相近）
- **开源？**：部分 — 既有开源卡密程序也有商业模板；不能逐站断定具体仓库
- **是否自研整站？**：多数否 — 套模板/二次美化，非从零自研
- **本应用深刮**：否
- **置信度**：中（依赖 PriceAI 分类；未对每站做技术指纹核验）

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| WEB3Al | `web3chirou.com` | 94 | failing | https://web3chirou.com/ |
| 惠民ai | `fk.ybkjs.top` | 56 | healthy | https://fk.ybkjs.top/ |
| 会员权益在线 | `ai666.id` | 48 | healthy | https://ai666.id/ |
| 全网最低批发ai账号店铺 | `zhanghao66.com` | 38 | healthy | https://zhanghao66.com/ |
| tehuio | `tehuio.com` | 19 | healthy | https://tehuio.com/ |
| fk.10886.xyz | `fk.10886.xyz` | 17 | healthy | https://fk.10886.xyz/ |
| shihuiai | `shihuiai.cn` | 17 | failing | https://shihuiai.cn/ |
| 以太 AI服务订阅充值 | `google7676.top` | 17 | healthy | https://google7676.top/ |
| LynnZee 店铺 | `lynnzee.myweb999.cfd` | 16 | failing | http://lynnzee.myweb999.cfd/ |
| Aisou智充 | `aisou.pro` | 15 | healthy | https://aisou.pro/ |
| 谷歌邮箱 AI源头批发 | `hiemail.store` | 15 | healthy | https://hiemail.store/ |
| yh-mo | `yh-mo.xyz` | 13 | healthy | https://yh-mo.xyz/ |
| 小熊AI充值 | `aichongz.cc` | 12 | healthy | https://aichongz.cc/ |
| 购物 - KBS Hub 卡比兽Ai资源站 | `kbshub.store` | 12 | healthy | https://kbshub.store/ |
| BBAI | `faka.bbanai.site` | 11 | healthy | https://faka.bbanai.site/ |
| bmoplus | `shop.bmoplus.com` | 9 | healthy | https://shop.bmoplus.com/ |
| 菲区卡冲 | `yufenggpt.com` | 9 | healthy | https://yufenggpt.com/ |
| gpt free已接码账号、outlook邮箱 | `store.codesky.qzz.io` | 8 | healthy | https://store.codesky.qzz.io/ |
| weiloo | `shop.sunnydolls.dpdns.org` | 8 | healthy | https://shop.sunnydolls.dpdns.org/ |
| Ai能量小店 | `dimosky.com` | 7 | failing | https://dimosky.com/ |
| NikoCard | `nikoers.com` | 7 | healthy | https://nikoers.com/ |
| sol批发谷歌 | `gmailsol.com` | 7 | healthy | https://gmailsol.com/ |
| AI批发 | `fk.gptcz.cc` | 6 | healthy | https://fk.gptcz.cc/ |
| Gemini账号批发, douyiner | `douyiner.cn` | 6 | healthy | https://douyiner.cn/ |
| shopgpt.plus | `shopgpt.plus` | 6 | healthy | https://shopgpt.plus/ |
| Grok Super - 芳华小铺 | `wiki123.top` | 5 | healthy | https://wiki123.top/item/8 |
| 晴天小店 | `cool.cheggnow.com` | 5 | healthy | https://cool.cheggnow.com/ |
| RedeemGPT / faka.redeemgpt.com | `faka.redeemgpt.com` | 4 | healthy | https://faka.redeemgpt.com/ |
| Desolate 卡网 | `fk.desolate.codes` | 3 | healthy | https://fk.desolate.codes/ |
| 购物 - DN发卡网 | `shopcardai.click` | 3 | healthy | https://shopcardai.click/ |
| 购物 - NoDeexs | `nodeexs.com` | 3 | failing | https://nodeexs.com/ |
| 购物 - 棱镜店铺 | `shop.558686.xyz` | 3 | healthy | https://shop.558686.xyz/cat/3 |

### C. HTML 兜底 / 主题族（技术栈不明）

只说明 PriceAI 怎么采，不能直接等同「自研」或「某开源项目」。

#### `genericHtml` — 通用 HTML 抓取（9 家 · offer 104）

- **来源/形态**：页面结构未落入已知专用采集器时的兜底
- **开源？**：未知
- **是否自研整站？**：可能自研、也可能是冷门模板
- **本应用深刮**：否
- **置信度**：低（仅表示采集方式，不表示技术栈）

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| xxxyan | `xxxyan.cc` | 30 | healthy | https://xxxyan.cc/ |
| 我爱买号 | `woaimaihao.com` | 25 | healthy | https://woaimaihao.com/ |
| 星宝小店 | `xingbao-ai.shop` | 15 | healthy | https://xingbao-ai.shop/ |
| 柠檬西瓜 | `lemon-watermelon.com` | 11 | healthy | https://lemon-watermelon.com/ |
| 美国圣母大学nd.edu邮箱【大龄校友 可用Gemini Pro】 购买 | office 365 小店 - office | edu邮箱 | ai | 教育优惠 | `of365.vip` | 8 | healthy | https://of365.vip/ |
| GPT pro20x | `sulanjun.cc` | 7 | healthy | https://sulanjun.cc/ |
| 鲸鲨源头 | `chong.nerver.cc` | 5 | healthy | https://chong.nerver.cc/ |
| AI 批发 | `gpt.ybkjs.top` | 2 | healthy | https://gpt.ybkjs.top/ |
| 大白发卡 | `19cm.tech` | 1 | healthy | https://19cm.tech/ |

#### `unicornHtml` — Unicorn 系 HTML（2 家 · offer 9）

- **来源/形态**：PriceAI 专用 HTML 采集器 unicornHtml（页面特征固定）
- **开源？**：未知 / 可能为某套主题或定制站
- **是否自研整站？**：不确定
- **本应用深刮**：否
- **置信度**：中（仅知采集器名）

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| 麦门商店 | `ouvg.top` | 6 | healthy | https://ouvg.top/ |
| Meowka喵卡 | `meowka.vip` | 3 | failing | https://meowka.vip/ |

#### `opensoraHtml` — OpenSora / AUTO FK HTML（1 家 · offer 2）

- **来源/形态**：PriceAI opensoraHtml 采集器
- **开源？**：未知
- **是否自研整站？**：不确定
- **本应用深刮**：否
- **置信度**：中

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| AUTO FK | `aifk.opensora.de` | 2 | healthy | https://aifk.opensora.de/ |

#### `makerichHtml` — MakeRich HTML（1 家 · offer 15）

- **来源/形态**：makerich.club 专用 HTML 采集
- **开源？**：未知
- **是否自研整站？**：不确定（单站）
- **本应用深刮**：否
- **置信度**：中

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| AI创富俱乐部 | `makerich.club` | 15 | failing | https://makerich.club/ |

#### `beibeiHtml` — beibei HTML（1 家 · offer 10）

- **来源/形态**：beibeiHtml 专用 HTML 采集
- **开源？**：未知
- **是否自研整站？**：不确定（单站）
- **本应用深刮**：否
- **置信度**：中

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| beibei | `bei-bei.shop` | 10 | healthy | https://bei-bei.shop/ |

### D. 专用 API / 品牌单站（更接近自研或强定制）

专用采集器或单域名逻辑，复用通用发卡套件的概率较低。

#### `publicProductsApi` — 公开商品 API（2 家 · offer 33）

- **来源/形态**：站点暴露可枚举的商品 JSON/API，PriceAI 用 publicProductsApi 拉
- **开源？**：未知
- **是否自研整站？**：多为自研或定制后端
- **本应用深刮**：否
- **置信度**：中

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| 猫咔 - Gemini源头批发 | `catcard.uk` | 17 | healthy | https://catcard.uk/ |
| 苏哲AI订阅中心 | `academicgate.org` | 16 | healthy | https://academicgate.org/ |

#### `shopUserProductsApi` — 店铺用户商品 API（1 家 · offer 1）

- **来源/形态**：类似公开商品列表 API 的变体采集
- **开源？**：未知
- **是否自研整站？**：多为定制
- **本应用深刮**：否
- **置信度**：中

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| 发卡网 - 在线购买虚拟商品 | `sd.ncet.top` | 1 | healthy | https://sd.ncet.top/ |

#### `getgptApi` — GetGPT 专用 API（1 家 · offer 5）

- **来源/形态**：单站/单品牌 API 采集器
- **开源？**：否（站点私有接口）
- **是否自研整站？**：是（或强定制）
- **本应用深刮**：否
- **置信度**：高（专用采集器 = 非通用平台）

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| ChatGPT Plus 充值服务|GPT Pro官方充值|GPT5代充|Codex充值 | `getgpt.pro` | 5 | healthy | https://getgpt.pro/ |

#### `ikunloveApi` — ikunlove 专用 API（1 家 · offer 9）

- **来源/形态**：单站 API 采集器
- **开源？**：否
- **是否自研整站？**：是（或强定制）
- **本应用深刮**：否
- **置信度**：高

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| AI 商品站 | `ikunlove.best` | 9 | healthy | https://ikunlove.best/ |

#### `blackcatWholesale` — BlackCat 批发页（1 家 · offer 40）

- **来源/形态**：BlackCat AI 批发/专营页专用采集
- **开源？**：否
- **是否自研整站？**：是（品牌站）
- **本应用深刮**：否
- **置信度**：高

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| BlackCat AI · 全球 AI 会员专营 | `autopixel.qzz.io` | 40 | failing | https://autopixel.qzz.io/blackcat |

#### `xiaoheiwan` — xiaoheiwan 专用（1 家 · offer 25）

- **来源/形态**：upgrade.xiaoheiwan.com 购买页专用采集
- **开源？**：否
- **是否自研整站？**：是（品牌站）
- **本应用深刮**：否
- **置信度**：高

| 店名 | host | offer | 健康 | 入口 |
| --- | --- | ---: | --- | --- |
| xiaoheiwan | `upgrade.xiaoheiwan.com` | 25 | healthy | https://upgrade.xiaoheiwan.com/purchase |

## 三维对照（避免混用概念）

| 维度 | 字段 | 含义 |
| --- | --- | --- |
| **本应用可刮平台** | `shop_platform` + `shop_token` | 能否本地深刮店内商品 |
| **上游采集器** | `collector_kind` | PriceAI 用什么方式建主档 |
| **商品品类平台** | `platforms_json`（ChatGPT/Claude…） | 卖什么，不是站技术栈 |

例：一家 `collector_kind=dujiao` 的店可能卖 ChatGPT，但仍 **不可** 当 ldxp 深刮。

## 对产品的含义（可选后续）

| 优先级 | 方向 | 依据 |
| --- | --- | --- |
| P0 已完成 | shopApi（ldxp/catfk）深刮 | 覆盖 ~75% 商家与大部分 offer |
| P1 候选 | 独角数卡公开商品页/API | 23 家、结构相对标准、开源可对照 |
| P2 候选 | kami 模板族 | 32 家但变体多，需先统一指纹再写客户端 |
| P3 | 专用 API 单站 | 收益低（1～2 家/采集器），除非个人高频用 |
| 不做 | 把「其他」全当自研去适配 | 多数是模板/开源部署，应 **按族** 适配 |

## 数据口径

- 快照时间：文档生成日（以库内当前行为准，重新同步商家列表后数字会变）
- `shop_platform` 仅当 URL 命中 `SHOP_PROFILES` 时写入；否则为 NULL（UI 里常显示为「其他」）
- offer / product 计数来自 PriceAI 主档，**不是** 本地 `shop_products` 表
- 未把 host 与第三方威胁情报或备案信息关联

## 附录：全库 collector 占比

```
shopApi                221   73.4%  █████████████████████████████████████
kami                    32   10.6%  █████
dujiao                  23    7.6%  ████
genericHtml              9    3.0%  █
(null)                   4    1.3%  █
unicornHtml              2    0.7%  █
publicProductsApi        2    0.7%  █
xiaoheiwan               1    0.3%  █
shopUserProductsApi      1    0.3%  █
opensoraHtml             1    0.3%  █
makerichHtml             1    0.3%  █
ikunloveApi              1    0.3%  █
getgptApi                1    0.3%  █
blackcatWholesale        1    0.3%  █
beibeiHtml               1    0.3%  █
```

