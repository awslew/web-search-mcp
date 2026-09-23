# 本地联网检索工具优化方案（OPTIMIZATION_PLAN）

> 日期：2026-08-02 · 作者：架构研究（读码 + 4 路 GitHub 检索 + 本机实测）
> 目标：修复 ws.js / server-cn.mjs 的检索质量问题，同时**不破坏现有 CLI 接口与使用习惯**。
> 铁律：`node ws.js search/fetch` 命令接口一字不改；`.mcp.json` 注册的 server-cn.mjs 是活跃服务，改动需 MCP 重启生效。
>
> ⚠️ **2026-09-20 例外备案**：`fetch` 命令的**输出内容格式**已从"拍平纯文本"改为"干净 Markdown"（命令行接口仍一字不改，
> 且 `FETCH_FORMAT=text` 可回退）。原因与实测数据见 §5.3 末条与 CHANGELOG-2026-09.md「A-更正」。
> 简言之：旧格式把标题/列表/代码块/表格全部碾成单行，保护它等于保护缺陷本身。

---

## 0. 实测结论与根因核实（每条都有真实数据支撑）

本方案的所有判断基于 2026-08-02 本机实测 + 4 路研究员对 GitHub 的真实检索。根因清单逐条核实如下（含对原假设的**修正**）：

| # | 原假设 | 核实结果 |
|---|--------|----------|
| 1 | 百度霸屏/精度差 | **确认，但有条件**。"node.js cheerio 教程""python 异步编程 asyncio" 等中文技术词百度结果尚可（腾讯云/官方文档/CSDN），但"跨境电商 独立站 赚钱"返回 百家号营销 + 知乎营销文，且出现一条 `url: null`（`mu="null"` 字符串 bug）。英文查询走百度会返回纯中文 CSDN 克隆页（实测 "javascript async await" 全是 CSDN） |
| 2 | cn.bing.com 跳转/质量差 | **部分修正**。实测 cn.bing.com 返回 200 且 href 是**直接 URL**（runoob.com/linux.org/ubuntu.com），不跳转 www.bing.com，也无 u=a1 重定向包裹。但 zh-CN locale 会把英文查询污染成中文结果（"linux command line tutorial" 返回菜鸟教程/百度百科/Ubuntu 中文站）——这是质量差而非跳转差 |
| 3 | 无质量打分/垃圾域过滤/去重 | **确认**。ws.js 仅 `seen.add(title)` 按标题去重；无黑名单、无打分、无 URL 归一化 |
| 4 | snippet 太短 | **确认**。百度 snippet 约 40-80 字符，Bing ~90-190，ddgs 实测 153-258。百度 snippet 不足以判断相关性 |
| 5 | site_search 文档与工具脱节 | **确认**。纪律文档要求用 site_search，但活跃 server-cn.mjs 只有 web_search/web_fetch；唯一 site_search 实现在**未注册**的早期服务器模块里（DDG 后端已死，该模块已从仓库移除） |
| 6 | 无缓存/无查询改写 | **确认**。无缓存、无 site:/filetype: 自动改写 |
| 7 | 国际版必应路径质量好但未接入 | **确认**。该路径走 www.bing.com + setlang=en&cc=US 英文质量好，但**返回的是 `/ck/a?` 重定向包裹 URL，未解码**（实测每个结果的 `u=a1` 前缀 + base64 可解码出真实 URL，如 `u=a1aHR0cHM6Ly9ub2RlanMub3JnLw` → `https://nodejs.org/`） |

**新发现根因（原清单未覆盖，优先级最高）：**
- **8. 百度反爬验证墙**：连续几次查询后，百度返回"百度安全验证"页（实测 html 仅 1438 字节、0 条结果），12 秒后仍未恢复。这是比"霸屏"更致命的可靠性问题——百度抓取路径随时可能整体失效。**查询缓存 + 降级链是刚需**。
- **9. 代理路径 DDG 已死，静默回落百度**：实测 `HTTP_PROXY=... node ws.js search "linux command line tutorial"` → DDG 分支 0 结果（html.duckduckgo.com 反爬/anomaly），静默回落百度。英文查询通过代理得到的是 `[baidu]` 标签的中文引擎结果，语义错位。
- **10. ws.js 尾部数字并入查询**：`node ws.js search "query" 5` 会把 `5` 拼进 query（`rest.join(" ")`）。文档声明支持 `[max_results]` 但代码没实现。**修复会破坏"一字不改"铁律，故本次不动，改用 `MAX_RESULTS` 环境变量**（客户端侧的约束文档里就是这么写的）。

---

## 1. 选定的引擎组合与路由策略

### 1.1 引擎实测画像

| 引擎 | 可用性（实测） | 优点 | 缺点 | 定位 |
|------|---------------|------|------|------|
| 百度 | 间歇性（验证墙） | 中文技术词质量尚可 | 验证墙、营销垃圾、mu="null"、英文查询返中文 | 中文主路（带缓存+降级） |
| cn.bing.com | 稳定直连 | 中文技术词质量高（docker.com/runoob/github 实测），直接 URL | 英文查询被 zh-CN 污染 | 中文回落 + 站内搜索底座 |
| www.bing.com (setlang=en&cc=US, 代理) | 稳定 | 英文质量高（nodejs.org/W3Schools/Anthropic 实测） | 返回 /ck/a 重定向包裹，需 u=a1 解码 | **英文主路** |
| ddgs (Python, 代理) | 稳定（实测 9.14.4 走代理返回 4 条真结果，snippet 153-258） | 长 snippet、多引擎聚合 | 需 Python 子进程、单引擎可能限流 | 英文次路（长 snippet 补充） |
| DDG html（现行 ws.js 解析器） | **死**（fetch failed / anomaly） | — | — | 删除/替换 |
| Tavily（SaaS） | 大陆直连 200（研究员实测） | LLM 长摘要、SLA 稳定 | 需注册 API key | **可选**英文兜底（有 key 才启用） |

### 1.2 路由规则（routeSearch）

```
无代理（国内直连）：
  1. 查缓存 → 命中直接返回
  2. 百度 searchBaidu()
     - 若检测到验证墙/0 结果 → 记负缓存 60s，走 3
  3. cn.bing.com searchCnBing()（直接 URL，中文质量高）
  4. 都失败 → 沿用现有错误文案 "All search engines returned no results"

有代理（HTTP_PROXY 已设）：
  1. 查缓存 → 命中直接返回
  2. 若查询含 CJK 字符 → 走中文链：百度 → cn.bing
  3. 否则（英文/技术词）→ 英文链：
     a. www.bing.com 国际版（u=a1 解码后返回真实 URL）——主路
     b. ddgs（Python 子进程，长 snippet）——结果不足 3 条时补
     c. Tavily（若 TAVILY_API_KEY 已设）——主路或补位
     d. 百度 → cn.bing 兜底（英文查询返中文也要有结果，不抛错）
  4. 融合：多引擎结果按质量管线（第 2 节）去重+重排，标注 [source]
```

**国际版必应接入主路由方式**：把国际版必应的搜索逻辑（www.bing.com + setlang=en&cc=US + **u=a1 解码**）抽进 `search-core.mjs` 的 `searchIntlBing()`，ws.js 代理分支调用它（原先那个独立的英文助手脚本已从仓库移除）。

**是否引入新引擎**：是——www.bing.com 国际版（由早期独立脚本提升为主路）与 ddgs（Python）。不引入 SearXNG/Whoogle（研究结论：重、AGPL/GPL 传染、上游引擎从大陆跑仍需代理且易碎，对轻量 CLI 过重）。

---

## 2. 结果质量处理

### 2.1 垃圾域黑名单（数据源 + 维护）

- **数据源（研究员 GitHub API 实测）**：
  - `StevenBlack/hosts`（MIT，30,782★）：纯 hosts 格式 `0.0.0.0 domain`，广告/追踪/恶意域 → 精确域名集。
  - `hagezi/dns-blocklists`（GPL-3.0，24,938★）：`fake.txt`（假货/骗局商店）、`spam-tlds.txt`（.top/.xyz/.icu 垃圾 TLD）、`urlshortener.txt`（短链）。ABP `||domain^` 语法。**个人/本地使用 GPL 数据无合规问题**；若未来产品化闭源分发，仅取 spam-tlds（纯数据文件，风险最低）。
- **维护方式**：`update_blacklist.mjs` 维护脚本，走 `HTTP_PROXY=127.0.0.1:<proxy-port>`（raw.githubusercontent.com 国内需代理）下载上述列表，压缩成运行时文件 `blacklist.json`：
  ```json
  { "remove": ["*.xyz", "*.top", "spam.example.com", ...], "lower": ["baijiahao.baidu.com", "blog.csdn.net", "zhihu.com"] }
  ```
  手动/低频运行（每月一次），运行时**只读本地 blacklist.json，不联网**。
- **两级策略（借鉴 SearXNG hostnames 插件的 remove/lower 思想）**：
  - `remove[]`：硬过滤（精确域 + 子域前缀匹配），命中即丢。
  - `lower[]`：降权不删除（百度百家号、CSDN、知乎营销页——整域删除会误伤大量有用中文内容）。
- **内建兜底规则**（硬编码，不依赖下载）：垃圾 TLD 后缀集合（.top/.xyz/.icu/.xyz 等，对应 hagezi spam-tlds）；`mu="null"` 与无法解析出合法 http(s) URL 的结果直接丢弃。

### 2.2 去重策略

- **归一化 URL hash**（抄 SearXNG `results.py` 的思路，纯代码 ~20 行）：`hash(hostname | path | params | query | fragment)`，丢弃 scheme 与 `www.`，剔除 `utm_*`/`fbclid`/`gclid` 等跟踪参数，去尾部 `/`。同一 URL 多引擎重复 → 合并，累加引擎来源与 position（多引擎命中加分）。
- **标题相似去重**：归一化后 token 集合 Jaccard > 0.85 视为同页，保留 snippet 最长者。

### 2.3 相关性打分（轻量、可落地）

- **minisearch**（npm，MIT，零依赖，6,064★）内置 BM25：对每结果 `title + snippet + domain` 建文档，对 query 打分。
- **混合排序**（排序键，降序）：
  `finalScore = 0.6 * bm25 + 0.4 * positionWeight(source, index) - 0.3 * lowerPenalty`
  其中 `positionWeight` 让百度/bing 的天然前位保留一定权重（引擎可信度 > 纯词频），`lowerPenalty` 对 lower[] 域减分。引擎可信度常量：intlBing=1.0、ddgs=0.95、cnBing=0.9、baidu=0.85。
- 结果集 10-50 条，BM25 性能绰绰有余。

### 2.4 snippet 增强（让 AI 先判相关性再决定抓不抓）

- 引擎侧优先取长 snippet：ddgs（153-258 实测）> Bing（~150）> 百度（~60）。
- **可选增强 `SNIPPET_ENRICH=1`**：对排序后 top-3 结果，snippet < `MIN_SNIPPET`（默认 60 字符）时，用 cheerio（已有依赖）抓页面 `og:description` / `<meta name="description">` / 首个 `<p>`（每个超时 3s、并发 2，不阻塞返回）。产出后 snippet 足够长，AI 能判断相关性，**避免盲抓**。
- 默认**关闭**（避免每次搜索都多抓 3 个页面拖慢速度）；需要精读场景用 env 打开。

---

## 3. 查询改写与缓存

### 3.1 查询改写（轻量、保守）

- **操作符透传**：检测并原样透传 `site:`、`filetype:`、`"..."`（引号）、`-`（排除），百度/必应均支持 site:（必应还支持 filetype:/引号）。
- **净化**：trim、折叠连续空白、去尾部多余标点。
- **site: 便捷**：仅当显式调用 site_search 工具时，自动拼 `site:<domain> <query>` 并做结果层 hostname 后过滤（见第 6 节）。
- **不自动加引号**（默认）：对多词查询加引号会过度限制召回；暴露 `AUTO_QUOTE=1` env 给需要精确短语的场景（仅对必应生效）。
- 不接入 querqy/searchbetter（研究员结论：重依赖/研究性质，查询改写在本项目优先级最低，自写同义短表即可，暂不实现）。

### 3.2 查询缓存

- **内存 LRU**：Map 200 条，TTL 10 分钟——快速路径，同会话重复查询零成本。
- **磁盘缓存 `search_cache.sqlite`**：用 Node 24 内置 `node:sqlite`（实测可用，**零新增依赖**）。表：`query_hash PRIMARY KEY, results JSON, engine TEXT, created_at INTEGER`。TTL 默认 6 小时（`CACHE_TTL_MINUTES` env 可调）。
- **负缓存**：百度验证墙/空结果缓存 60 秒，避免连续命中验证墙（实测 12 秒不恢复，负缓存是刚需）。
- 缓存键 = 净化后的 query（含 site:/filetype: 算子原文）。

---

## 4. 开源库取舍（基于研究结果，无 Docker，pip/npm 可装）

| 库 | 许可 | 实测/研究证据 | 决定 |
|----|------|--------------|------|
| **minisearch** | MIT | 零依赖纯 JS，内置 BM25，6,064★ | ✅ 接入（已装，package.json 已加） |
| **ddgs** | MIT | 本机 venv 实测 9.14.4 走代理返回真实结果，snippet 153-258；duckduckgo-search 官方继承者 | ✅ 接入（Python 子进程，可选降级） |
| **node:sqlite** | Node 内置 | Node 24.16.0 实测可用 | ✅ 接入（零依赖磁盘缓存） |
| **cheerio** | MIT | 已在依赖里 | ✅ 复用（解析 + snippet 增强） |
| **StevenBlack/hosts** 数据 | MIT | 30,782★，纯 hosts 格式零解析成本 | ✅ 接入（维护脚本取数据） |
| **hagezi/dns-blocklists** 数据 | GPL-3.0 | 24,938★，fake/spam-tlds 是搜索垃圾最高信号 | ✅ 个人本地使用接入；产品化闭源时只取 spam-tlds |
| **Tavily API** | 商业 SaaS | 研究员实测大陆直连 200、免费 1000/月循环、免信用卡 | ⚠️ 可选（有 TAVILY_API_KEY 才启用，英文兜底） |
| SearXNG | AGPL-3.0 | 34,742★，但部署重、上游引擎仍要代理、Windows 无 uWSGI | ❌ 不接入（研究第 1/3/4 路一致） |
| Whoogle | MIT | 单 Google 引擎、无黑名单、大陆不可用 | ❌ 不接入 |
| googlesearch-python / yagooglesearch | BSD | 实测返回空列表，Google 反爬封 | ❌ 不接入 |
| duck-duck-scrape / npm duckduckgo-search | MIT | 2025-01 停更/项目转移/死库 | ❌ 不接入 |
| better-duckduckgo-search | — | 查无此库 | ❌ 划掉 |
| duckduckgo-mcp-server | MIT | 1389★ 活跃，但整体 MCP 化改造大于最小修复 | ❌ 本次不接入（与 ddgs 二选一，选 ddgs） |
| ~~trafilatura~~ | — | Python 版抽取质量好，但**每次抽取要起 Python 子进程 955–2028ms**（含解释器启动），且对微信公众号同样失效 | ❌ 不接入（改用 Node 侧 linkedom+Readability，约 280ms） |
| **mozilla/readability + linkedom + turndown** | Apache-2.0 / ISC / MIT | 11,451★ / 11,440★。**2026-09-20 已接入**（`extract-core.mjs`）：实测 MDN 页正文 2772→20170 字，结构标记 0→5 标题/3 列表/1 代码块/4 表格行 | ✅ 已接入（推翻 09-12 的"收益接近零"，见 CHANGELOG A-更正） |
| querqy / searchbetter | — | 重依赖/研究项目 | ❌ 不接入 |

**自己写多少**：核心引擎路由、u=a1 解码、mu="null" 过滤、验证墙检测、URL 归一化去重、两级黑名单匹配、混合排序、缓存层、site_search 工具、查询改写——全部自写（约 400-500 行，分散在 search-core.mjs 与维护脚本）。第三方只引入数据与两个轻量算法库（minisearch、ddgs）。

---

## 5. 改动范围（文件清单）

### 5.1 新增文件

| 文件 | 作用 | 说明 |
|------|------|------|
| `search-core.mjs` | 共享检索核心：引擎（baidu/cnBing/intlBing/ddgs/tavily 可选）+ 质量管线（黑名单/去重/BM25/排序/snippet增强）+ 缓存（node:sqlite + LRU）+ 路由（routeSearch） | ws.js 与 server-cn.mjs 共用，避免逻辑双份 |
| `ddgs_search.py` | Python 子进程桥：`python ddgs_search.py "<query>" [max]` → JSON stdout | 供 search-core.mjs 的 `searchDdgs()` spawn；ddgs 未安装时自动跳过 |
| `update_blacklist.mjs` | 黑名单维护：走代理下载 StevenBlack + hagezi → 压缩写 `blacklist.json` | 手动低频运行；运行时只读 blacklist.json |
| `blacklist.json` | 两级域名单（remove[] / lower[]） | 首次由 update_blacklist.mjs 生成，含内建垃圾 TLD 兜底 |
| `OPTIMIZATION_PLAN.md` | 本方案文档 | — |

### 5.2 修改文件

| 文件 | 改动 | 注意 |
|------|------|------|
| `ws.js` | 内部引擎与质量逻辑改为调用 `search-core.mjs`（routeSearch/qualityPipeline）；修复：DDG 死路替换为 intlBing+ddgs 英文链、u=a1 解码、百度 mu="null" 过滤、验证墙检测+负缓存、黑名单/去重/BM25/缓存。**CLI 参数解析逐字节不变**（`node ws.js search/fetch` 接口铁律） | 铁律：接口一字不改。⚠️ 2026-09-20：`fetch` 的**输出格式**已解禁为 Markdown（接口仍不变，`FETCH_FORMAT=text` 可回退），见 §5.3 |
| `server-cn.mjs` | import search-core.mjs 复用路由与质量管线；**新增 `site_search` 工具**（见第 6 节）；web_search/web_fetch 行为与参数不变 | 活跃 MCP，改后需**重启 MCP 会话**生效 |
| `searchIntlBing()` | 已并入主路由的 u=a1 解码（strip `a1` 前缀 → base64 → 真实 URL） | 与主路由逻辑一致 |
| `package.json` | 新增 `minisearch`（已装）；无其他新依赖 | — |
| `site-search-discipline.md` | "相关工具"一节更新：site_search 现位于活跃的 server-cn.mjs（需重启会话后可用），纪律正文不变 | 文档与工具对齐（见第 6 节结论） |

### 5.3 不动的文件（明确列出）

- 早期 DuckDuckGo 时代的 MCP/CLI 实现（已被 `server-cn.mjs` 与 `ws.js` 取代）——已从仓库移除，不再保留。
- `.mcp.json`——**不改注册项**（web-search 仍指向 server-cn.mjs）；site_search 直接加进现有 server-cn.mjs，无需换注册目标。
- 早期探索阶段的抓取脚本与临时数据文件——与检索质量优化无关，已从仓库移除。
- `ws.js` 的 `fetch` 命令——⚠️ **此条已于 2026-09-20 部分解禁**：内容格式从"拍平的纯文本"改为"干净 Markdown"
  （理由见下）。**命令行接口仍逐字节不变**（`fetch <url> [max_length]`、标题头 `# {title}\n\nURL: {url}\n\n`、
  截断标注格式均未动），且可用 `FETCH_FORMAT=text` 一键退回旧行为。

> **为什么解禁"输出格式不变"这一条**（2026-09-20，显式记录而非默默绕过）：
> 旧 `fetchUrl` 先取 `main, article, …` 的 `.first()`，再在 `sanitizeText` 里做 `.replace(/\s+/g, " ")`
> ——这一步把所有换行碾成空格，紧随其后的 `.replace(/\n{3,}/g, "\n\n")` 成了**永不触发的死代码**。
> 结果：无论页面多规整，输出永远是**单行长文本**，标题/列表/代码块/表格全部被销毁。
> 这与"给 LLM 提供干净内容"的目标**正相反**，所以"格式不变"在这条命令上保护的是缺陷本身。
> 实测：结构标记旧实现 0 个 → 新管线 5 标题/3 列表项/1 代码块/1 链接/4 表格行；
> MDN Fetch API 页正文字数 2772 → 20170（7.28×）。详见 CHANGELOG-2026-09.md「A-更正」。

### 5.4 依赖安装步骤（无 Docker）

```bash
cd <repo>
npm install minisearch                      # 已在本轮验证时安装
python -m venv .venv-ddg                    # 已建
./.venv-ddg/Scripts/python.exe -m pip install ddgs   # 已装 9.14.4
node update_blacklist.mjs                    # 走代理拉取黑名单（HTTP_PROXY 必需）
```

---

## 6. site_search 纪律对齐（结论：给 server-cn.mjs 加 site_search）

**二选一结论：给活跃的 server-cn.mjs 新增 `site_search` 工具**，不改纪律文档的规则。

理由（基于实测）：
1. **工具缺失是纪律无法执行的根本原因**：site-search-discipline.md 要求"必须用 site_search"，但活跃 server 根本没这工具，AI 只能退化到 web_search 全网搜——这正是原反馈里"AI 发散搜索浪费 token"的源头。改文档只能治标，加工具才能治本。
2. **站点过滤底座现成且可靠**：cn.bing.com 实测返回直接 URL、支持 `site:` 算子、中文英文都能搜。`site_search = cn.bing site:查询 + 结果层 hostname 后过滤`，约 30 行，复用 searchBing + 现有 extractDomain 逻辑即可。比修 DDG 时代的旧实现（后端已死）更省事且真实可用。
3. 纪律文档的"相关工具"一节顺带更新为指向 server-cn.mjs（并注明需重启会话），**纪律正文规则一字不动**。

site_search 实现要点：domain 归一化（去协议/www/尾斜杠、无点补 .com）、查询层 `site:<domain> <query>`、结果层 `hostname === domain || endsWith('.' + domain)` 双重过滤（与早期实现的现成逻辑一致）、无结果时给出尝试简化 domain 的提示。

---

## 7. 测试方案与阶段三验收

### 7.1 自动化/半自动测试用例（落地为 `test-search.mjs`）

| 用例 | 命令 | 断言 |
|------|------|------|
| T1 中文技术 | `node ws.js search "node.js cheerio 教程"` | ≥3 结果；无 `null`/非 http URL；首屏无营销垃圾 |
| T2 英文直连 | `node ws.js search "linux command line tutorial"` | 有结果（cn.bing 回落）；snippet 存在 |
| T3 英文代理 | `HTTP_PROXY=127.0.0.1:<proxy-port> node ws.js search "nodejs http server best practices"` | ≥3 结果；**URL 无 /ck/a 包裹**（u=a1 已解码）；来源含 [bing]/[ddgs] |
| T4 长 snippet | `HTTP_PROXY=... node ws.js search "python async programming"` | ddgs 来源结果 snippet ≥100 字符 |
| T5 缓存 | 同一查询连续两次 | 第二次日志显示 cache hit，无新网络请求（node:sqlite 生效） |
| T6 黑名单 | 搜"xxx .top 站"类 | remove[] 域结果被剔除；lower[] 域排到后面 |
| T7 验证墙韧性 | 连续 5 次快速搜索 | 触发验证墙后自动降级 cn.bing，不崩溃、不抛错 |
| T8 site_search | server-cn.mjs 重启后 `site_search("github.com","mcp server")` | 全部结果 hostname 属于 github.com |
| T9 去重 | 多引擎融合场景 | 同一 URL 不出现在两条 |

### 7.2 阶段三验收对比查询（分中文技术/英文技术/站内/冷门）

1. 中文技术（无代理）：`node.js cheerio 教程` —— 预期：百度/必应中文，无 null URL，无纯营销霸屏
2. 中文技术（无代理）：`python 异步编程 asyncio` —— 预期：官方文档可进前 3
3. 中文技术（无代理）：`docker 入门教程` —— 预期：docker.com/runoob/github 等高质量站（cn.bing 实测已能给出）
4. 英文技术（代理）：`nodejs http server best practices` —— 预期：nodejs.org/W3Schools/GitHub 等英文站，URL 已解码，snippet ≥100
5. 英文技术（代理）：`mcp server protocol guide` —— 预期：Anthropic/GitHub/Wikipedia 英文站
6. 英文技术（代理）：`python async programming` —— 预期：长 snippet（ddgs ≥150）
7. 站内（MCP site_search）：`site_search("github.com", "mcp server")` —— 预期：100% github.com 域名
8. 冷门（无代理）：`飞书 多维表格 API 权限` 或 `开源协议 AGPL 商用合规` —— 预期：有相关结果且首屏无垃圾站

验收标准：① ws.js 命令接口与输出格式与改动前一致；② 英文代理路径 URL 全部解码为真实 URL；③ 上述 8 条查询首屏无 `null` URL、无验证墙报错、无垃圾 TLD；④ site_search 只返回目标域。

---

## 8. 风险与不确定项

1. **百度验证墙加剧**：本次实测已触发一次。若百度进一步收紧反爬，中文主路将更依赖 cn.bing.com（目前稳定且中文质量实测好）。预案：cn.bing 提升为中文主路候选（路由里百度连续 3 次验证墙则熔断 30 分钟，期间直接走 cn.bing）。
2. **DDG/ddgs 单引擎限流**：ddgs 底层仍是 DDG 生态，可能间歇限流。预案：ddgs 失败静默跳过，不影响 intlBing 主路；可选 Tavily 兜底。
3. **www.bing.com 可能反爬变化**：国际版必应实测稳定，但 u=a1 重定向格式若改版需跟进解码逻辑。预案：解码失败时保留原 href（可点击），不丢结果。
4. **黑名单误杀**：lower[] 降权域（CSDN/知乎/百家号）整域降权可能压低个别优质文章。预案：只降权不删除 + 黑名单可手工编辑 blacklist.json。
5. **GPL-3.0 数据合规**：hagezi 数据仅限个人/本地使用；若未来产品化闭源分发需去掉或只保留 spam-tlds 纯数据。
6. **Tavily 依赖外部服务**：免费 1000/月循环，需注册拿 key。仅在有 key 时启用，非硬依赖。
7. **Python 子进程依赖**：ddgs 需本机 Python 3.11 + venv；若环境缺 ddgs，英文链自动降级为仅 intlBing，功能不中断。
8. **MCP 重启成本**：server-cn.mjs 改动需重启 MCP 会话才生效；重启前旧工具仍可用（行为不变）。
9. **ws.js 尾部数字并入查询的怪癖**（`node ws.js search "q" 5` → 查询变 "q 5"）：按铁律本次不修；已在客户端侧的约束文档中以 `MAX_RESULTS` env 为准，不影响现有 skill。
