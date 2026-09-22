---
name: web-search
description: >
  联网检索统一入口与实测参考手册。多引擎自动路由（中文→m.baidu/cn.bing/sogou 国内直连，
  生产结果过少 raw<12 时自动并入搜索 API 抢救；英文→intlBing+ddgs 代理并行融合）、
  垃圾域黑名单与 UGC 降权、权威源加权与官方文档召回、正文结构化抽取管线。
  提供 MCP 工具、ws.js CLI 兜底与 360 保底三级链路。
metadata:
  version: "1.3"
  category: web
---

# Web Search 检索纪律与实测参考手册

本项目提供免费、多引擎融合的联网检索与正文抽取能力。核心原则：**MCP 优先，CLI 兜底，360 保底；语言自动路由；指定网站必用 site_search**。

## 1. 工具总览

不同客户端给 MCP 工具加的前缀不同（例如某些实现显示为 `mcp__<server>__<tool>`），以客户端实际注册的名称为准。

| 工具 | 用途 |
|---|---|
| `web_search(query, max_results?)` | 多引擎路由 + 质量管线（黑名单/去重/RRF 融合排序/缓存），主力工具。**结果带 `⚠️ DEGRADED` 前缀表示引擎限流**，非最优结果。 |
| `site_search(domain, query, max_results?)` | 站内搜索，100% 限制在目标域名（中文：cn.bing+sogou+百度+intlBing；英文：intlBing 主+ddgs 补），查官方文档首选。 |
| `web_fetch(url, max_length?, format?)` | 抓页面正文，返回结构化 Markdown（保留标题/列表/代码块/表格）。`format="text"` 返回纯文本。 |

> **生效提醒**：`search-core.mjs` 改动后需**新开会话**生效（MCP stdio 进程不热重载）；`ws.js` CLI 每次执行重新加载，即改即生效。

## 2. 决策树

1. **MCP 优先**：调用 `web_search` / `site_search` / `web_fetch`。
2. **MCP 未注册或调用失败** → `ws.js` CLI 兜底（接口逐字节兼容）：
   ```bash
   cd <repo>
   # 搜索（中文直连更快；设代理则走代理出网）
   node ws.js search "<关键词>"
   # 抓外网页（必须走代理）
   $env:HTTP_PROXY="http://127.0.0.1:<proxy>"; node ws.js fetch "<URL>"
   # 条数控制使用环境变量（尾部数字会并入查询，勿改）
   $env:MAX_RESULTS="10"; node ws.js search "<关键词>"
   ```
3. **关键词搜索全线故障**（返回固定垃圾/验证墙）→ 360 搜索页兜底：
   调用 `web_fetch("https://www.so.com/s?q=<URL编码关键词>")`（多词用 `%20`，页尾热搜为噪音可忽略）。

## 3. 路由、代理与 API 抢救闸门

- **中文查询**（连续 CJK ≥2 字）→ **主融合：m.baidu（移动端）+ cn.bing + sogou + 搜狗微信（仅微信生态查询）**（国内直连），经 RRF 融合排序后取 top-N。全空才用 so360/intlBing/ddgs 兜底。
  - **代理与直连分派**：国内引擎必须直连以保证低延迟与解析正确。即使全局配置了 `HTTP_PROXY`，系统内部亦通过 `directDispatcher` 确保国内引擎走直连通道，避免代理节点污染国内检索。
  - **搜索 API「抢救闸门」**：生产候选池结果过少（`raw.length < rescueFloor()`，默认 12）时自动并入第三方 API 结果；结果充足时静默。
    - **判据演进与实测数据**：原「单引擎」判据提升 `+0.0399`（中文 `+0.0664`）→ **`raw<12` 提升 `+0.0607`（中文 `+0.1011`）**，英文两者均 **`±0`**；对照组「无条件全并入」伤英文 **`-0.0509`**。被救活的 4 条中文查询：虚拟支付 `0.000→0.624`、订阅消息 `0.000→0.500`、云开发数据库 `0.000→0.431`、微信支付 API v3 签名 `0.000→0.544`。
    - **raw 结构分布原理**：实测 raw 分布呈结构化双峰（`raw=5` 17 条为单路，`raw=13` 12 条为健康，`raw=10` 仅 1 条）。英文查询全部 `raw≥13`，这是英文列 `±0` 的**结构性原因**。蕴含方向：单引擎 ⇒ `raw<12`（每路宽度 5，单路最多 5 条），故新判据包含旧判据；⚠️ 反之不成立（`raw=10` 为 2 路引擎，由 `gate.test.mjs` 场景 A2 专门锁定）。覆盖门槛类判据（≥0.20/≥0.40）实测完全无效。
    - ⚠️ **方法学限制（不可盲目当作今日绝对收益）**：① 基线是 09-12 抓取的，当时中文引擎远弱于现在；② raw 分布是双峰、中间只有 1 条，「12 优于 10」属于脆弱结论；③ 改动每路宽度或引擎数后必须重跑 `--refetch` 重新标定。
    - **门槛环境变量覆盖**：`WEB_SEARCH_RESCUE_FLOOR=<n>`（默认 12），非法值（非整数/<1/空）静默回退默认。⚠️ **门槛方向别搞反**：调低门槛 = 触发更少（严格小于判据）。中文限流常导致 raw 跌落至 5~10，正落在「被 12 覆盖、被 10 排除」的最需抢救区间。调低门槛不是更保守，而是在最需要抢救的区间关掉抢救；真要更保守应调高。
  - **API Key 配置与环境变量清洗应对**：
    - 优先级：环境变量 > `api-keys.json` > Windows 用户注册表（`HKCU\Environment`）。无 key 时 `apiEngineAvailable()` 为 false，行为与加 API 引擎前完全一致。
    - ⚠️ 部分 MCP 客户端会清洗子进程环境变量，把名字含 KEY/PASSWORD/SECRET/TOKEN 的变量丢弃，导致 API key 传不进 MCP 进程；重启客户端不解决。本服务器的对策是回退读 Windows 用户注册表（`HKCU\Environment`），也有更通用的做法：`api-keys.json` 或客户端配置里的显式 env 字段。
    - ⚠️ **写密钥相关测试/探针时必须密封两个来源**（`api-keys.json` 与注册表 `__setRegistryFallback(false)`），否则会被本机真 key 击穿（已发生过两次，其中一次真打了付费 API）。
    - ⚠️ **验证 API 是否参与结果必须 `EVAL_NO_CACHE=1`**，否则会直接命中带 key 的旧缓存造成误判。
  - **Provider 优先级与成本**：`tavily > bocha > zhipu`（首个配了 key 的胜出）。
    - **Tavily**：单价 $0.0075~0.008/credit（月付~散买，月付折合约 54 元/千次），但**每账号每月 1000 credit 免费、无需信用卡、多账号可叠加**，免费额度内实际成本为 0 元。
    - **智谱**：search_std **【未核实：0.01 元/次，无免费额度需充值】**（官方计费页检索未确认，详见仓库 CHANGELOG）。
    - **博查**：**【未核实：0.036 元/次】**。时间范围默认跟随官方 `noLimit`，收窄可用 `BOCHA_FRESHNESS=oneYear` 等。
    - ⚠️ **官方首页的响应示例可能是简写，SDK 源码才是契约**（智谱/博查报错需区分 key 失效与结构变更，契约由 `eval/api-parsers.test.mjs` 52 项断言离线锁定）。
    - ⚠️ **换 provider 后跑 A/B 必须指定 `API_PROVIDER` 或 `--refetch`**，否则结论会归因到错误的引擎。
- **引擎可用性瓶颈实测**：百度桌面版恒返验证墙（HTTP 200 + 1438B + "百度安全验证"）；m.baidu 高频请求后同样被封；sogou 后期直接 HTTP 403；cn.bing 恒定可用但对长中文查询会退化为单字匹配（如"微信小程序 虚拟支付"返"微"字典页）。
- **so360 与 intlBing 移出/降级**：
  - **intlBing 已移出中文链**：实测对中文查询 100% 零词面覆盖（问"虚拟支付"返 Rockefeller 圣诞树、问"流量主开通条件"返越南美食）。
  - **so360 降为兜底**：恒定可用且在题（coverage 0.60~1.00），但返回 CSDN 等在题非权威结果，剥离实验证明它会把官方文档挤出 top-5（`vue3 组合式 API setup` cn.vuejs.org 1.0→0.0），中文 nDCG `-7.7%`。
- **英文查询与站内搜索**：英文查询走 intlBing + ddgs 并行融合（走本地代理）；站内搜索中文走 4 路直连、英文走 2 路代理。
- 语言判定：单个混入中文字不触发中文链（如 "nodejs http server 你" 按英文链处理）。

## 4. 查准与站内搜索纪律

- **查准指南**：
  - **2–5 个核心词**空格分隔（如 `微信小程序 虚拟支付 个人主体 条件`），切忌整句提问（分词效果更差）。
  - 限定词用**引号短语**（`"微信认证"`）；题材词与条件查询拆开搜。
  - 查官方文档优先 `site_search`（如 `site_search("developers.weixin.qq.com", "虚拟支付")`），精度远高于全网搜。
  - 结果筛选看三件套：标题含 ≥2 个查询词 + 摘要能对上条件 + URL 为官方/文档站。只中一个词的结果直接忽略并换词重搜。
- **站内搜索纪律**：
  - 用户指定网站（如 `docs.python.org`、`github.com`）必须调用 `site_search(domain, query)`，max_results 设 10。
  - `site_search` 无结果时：先简化 domain（去 www/协议）→ 换关键词 → 直接抓 sitemap/分类页/索引页。
  - 搜到目标 URL 后直接 `web_fetch` 读正文，不要发起二次搜索。

## 5. 正文抽取纪律

- `web_fetch` 基于 `linkedom` + `Readability` + `turndown` 提取结构化 Markdown（中文站/公众号特判 `#js_content`），自动解码 GBK/GB2312。
- ⚠️ **GBK 别当成中文质量的支撑**：实测扫描 30 个中国老站（部委/政务/高校/银行/12306/国家电网等）**全部为 UTF-8，命中 0 个非 UTF-8 站点**；多数站点 header 不带 charset、只靠 `<meta>`。GBK 分支仅为长尾兜底，日常极少触发。
- **6 条编码判据**（已由 `eval/extract.test.mjs` 固化为断言）：
  1. header charset 声明优先；
  2. 其次读取 meta 标签（含老式 `http-equiv` 写法）；
  3. 前两者均无则默认 utf-8；
  4. meta 落在前 4KB 之外落回默认；
  5. 字节 UTF-8 + header 谎称 gbk 自动退回 utf-8；
  6. 字节 GBK + header 谎称 utf-8 会乱码（有意接受，遵循浏览器原生行为）。

## 6. 质量、排序与权威源信号

- **降级可见机制**：百度验证墙/搜狗限流时，中文链可能只剩 cn.bing 独扛，系统会给结果添加 `⚠️ DEGRADED` 前缀且只存 90s 内存（不写盘），防止限流缓存污染后续检索。看到此提示应稍后重试或改用 site_search。
- **`[source]` 标签集**：`{baiduMobile, cnBing, sogou, sogouWeixin, intlBing, ddgs, so360, tavily, bocha, zhipu, officialDocs}`。
- **RRF 排序与权威源信号**：`score = 1.0 × RRF + authoritySignals`。权重配置：`wAuthority=0.18` / `wTutorial=0.08` / `wMirror=0.18` / `wHomepage=0.10`（文档子站 1.00 > 公司营销站 0.90 > 主题官方 0.60 > 深度文档路径 0.40；镜像站 `MIRROR_DOMAINS` 如 nodejs.cn / vueframework.com 额外降权）。
  - ⚠️ **不要按评估集最大值调参**：`wAuthority=0.8` 时英文 nDCG 达到 `1.0000` 属于假象（评估集 gold 全是官方域导致）。测试套件设保护性断言锁定 `wAuthority ≤ 0.30`。
  - **地板例外**：权威域（`authScore ≥ 0.9`）豁免 `covFloor` 硬过滤，但要求 `wAuthority > 0` 保持开关语义。
  - ⚠️ **衡量在线效果必须用「同一批池」对照**：逐次联网会被引擎波动淹没。同池对照 hit@1 `2/8 → 6/8`、hit@5 `6/8 → 8/8`（按官方域在池中挑选，偏乐观）；⚠️ **离线涨幅会高估**（基线为 09-12 缓存）。四个权重设 0 可逐位回退旧行为。
- **官方文档召回通道**：推断官方域 → 发起 `siteSearch` → 结果以 `officialDocs` 源并入 raw（在 API 抢救闸门之前）。
  - **推断规则**：查询拉丁词与 `AUTHORITY_DOMAINS` 比对（精确 > 前缀≥4字 > 包含≥4字 > 词首相同时编辑距离≤2），外加 6 条 `OFFICIAL_ALIASES`（如 `golang→go.dev`、`k8s→kubernetes.io`、`微信支付→pay.weixin.qq.com`）。⚠️ 模糊档必须词首相同（防 `setup` 误匹配为 `svelte.dev`），推不出则不猜。
  - ⚠️ **站内查询必须与站点文档同语种**（英文站搜中文词面零匹配，必须转为「产品 token + 文档意图词」）。
  - 实测同池对照效果：`mysql 索引 最左前缀原则` 池内文档页 `0 → 7 条`，`dev.mysql.com` rank 4 → 1；`微信小程序 虚拟支付` 官方域从无到有。开关：`OFFICIAL_DOCS_PASS=0`。
- **黑名单与降权实测**：`blacklist.json`（4,300+ 规则）。
  - **百度 UGC 降权**（`wk/zhidao/wen/aistudy/jingyan.baidu.com`）：真实场景 nDCG@5 `+8.4%`（0.7133 → 0.7730），技术集零回归。"顺丰 运费" top-5 官方域从 1 条提升至 4 条，第 1 名由百度与必应双引擎共同命中。
  - **搜狗跳转链降权**（`weixin.sogou.com`）：跳转链因 `cov=1.00` 虚高占榜，降权后问题查询 nDCG@5 `+86%`，官方域升至第 4 位；反向验证：该查询并入 API 反而让官方域再次掉出 top-5。
- **语义重排默认关闭**：`RERANK=1` 启用 cross-encoder（`bge-reranker-base` 266MB 模型），实测权重 1.0 时 nDCG@5 从 `0.8396` 塌陷至 `0.4628`，会系统性将官方文档降级为第三方博客（kubernetes.io → komodor.com）。仅在需要通俗教程时可开启并调节 `RERANK_WEIGHT=0.35`。

## 7. 质量评估与测试

```bash
npm test                                  # 9 套测试驱动（324 项断言，含 2 套真实网络测试）
                                          #   ⚠️ 联网套件遇限流会偶发失败，先看网络问题，勿当成代码回归；纯离线跑 npm run test:unit
npm run verify:quality                    # 【同池对照】真实联网对照生产与归零配置（约 8 次 API 调用）
npm run eval:capture <tag>                # 抓取原始候选池存盘（联网 3-5 分钟）
npm run eval:replay <tag>                 # 离线重放打分出 nDCG/MRR/hit@k（秒级）
npm run eval:compare <a> <b>              # 对比两份结果看逐条 delta
npm run eval:ab                           # API 闸门受控 A/B（换 provider 需 API_PROVIDER=<name> 或 --refetch）
node eval/show.mjs <tag> [keyword] --api  # 人眼核查最终排序结果（防被聚合宏观指标误导）
node update_blacklist.mjs                 # 黑名单维护更新脚本（走代理拉取最新规则）
node eval/gate.test.mjs                   # 闸门分支单测（20 项，含场景 A2 锁定与注册表密封）
node eval/extract.test.mjs                # 正文抽取单测（54 项：正文/噪音/结构/编码/相对链接/标题去重）
node eval/api-parsers.test.mjs            # API 契约单测（52 项，必须密封密钥）
node eval/officialdocs.test.mjs           # 官方文档召回单测（45 项，必须密封注册表）
node test-mcp-e2e.mjs                     # MCP 端到端 JSON-RPC 测试（15 项）
```

- **评估集**：40 条查询（18 中文 + 12 英文 + 10 条 `cn_real` 真实民生/服务类），见 `eval/queries.json`。
- **控制变量开关**：`EVAL_NO_API=1` 排除 API 引擎并同时关闭官方文档召回通道；`OFFICIAL_DOCS_PASS=0` 仅关闭召回通道；`EVAL_LANG=cn_real` 仅测试特定子集。

## 8. 团队提示词模板

在编写 Agent 提示词需要嵌入搜索工具段落时，可直接嵌入以下通用片段：

```
联网检索工具（国内直连，外网检索需配置本地代理）：
- 优先使用 MCP 工具：
  · web_search "<关键词>"       多引擎自动路由与 RRF 融合排序，带 ⚠️DEGRADED 表示引擎限流
  · site_search "<domain>" "<查询>"  站内搜索——指定网站必用，查官方文档首选
  · web_fetch "<URL>"           抓取网页正文 Markdown
- MCP 未就绪时的 CLI 兜底：
  · 搜索：node ws.js search "<关键词>"
  · 抓取：node ws.js fetch "<URL>"
- 查准原则：2–5 个核心词空格分隔，切忌整句提问；引号限定短语；指定网站一律 site_search
- 降级处理：全部引擎失败才换词重试，遭遇限流优先使用 site_search 或 360 搜索页兜底
```
