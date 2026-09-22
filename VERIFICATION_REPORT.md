# ws.js 检索工具优化验收报告（VERIFICATION_REPORT）

> 验收员实测 · 2026-08-02 · Windows11 + Git Bash · Node v24.16.0
> 对照基准：`baseline_results.md`（改动前，2026-08-02 记录）
> 设计依据：`OPTIMIZATION_PLAN.md`
> 结论：**达标**。工程化修复（缓存/黑名单/去重/验证墙降级/u=a1解码/英文主路/site_search）全部实测生效；8 条查询无 `null` URL、无营销/聚合霸屏、无垃圾 TLD、无 /ck/a 包裹。遗留 1 个关键调优点（ddgs 触发条件过严）与 3 个低中风险项（见 ISSUES）。

---

## 一、8 条查询前后对比（命令与基线逐字一致）

判定口径（与基线一致）：**相关**=仅凭 title+url+snippet 可确认与查询主题相关；**需fetch**=必须打开页面才能判断（null/聚合落地页/含糊）。垃圾站=营销霸屏、百度聚合模块（精选笔记/视频大全/图片）、离题字典型页等非目标内容。

| # | 查询 | 引擎来源(前→后) | 相关(前→后) | 需fetch(前→后) | null/非http URL | 垃圾站/营销霸屏变化 |
|---|------|----------------|------------|----------------|-----------------|--------------------|
| Q1 | node.js cheerio 教程 | [baidu] → [cnBing] | 3 → 5 | 0 → 0 | 0 → **0** | 无 → 无（但 0 条 cheerio 专项） |
| Q2 | python 异步编程 asyncio | [baidu] → [cnBing] | 1 → 3 | 2 → **0** | **1→0** | 精选笔记+视频大全 → **无** |
| Q3 | docker 入门教程 | [baidu] → [cnBing] | 1 → 5 | 2 → **0** | **1→0** | 精选笔记+视频大全 → **无** |
| Q4 | nodejs http server best practices | [baidu]中文错位 → [intlBing] | 2 → 5 | 1 → **0** | 0 → 0 | 英文查返中文 → **全英文正站** |
| Q5 | mcp server protocol guide | [baidu]中文营销 → [intlBing] | 3 → 5 | 2 → **0** | 0 → 0 | sohu/qq/163/weibo 营销 → **5条权威MCP英文站** |
| Q6 | python async programming | [baidu]中文 → [intlBing] | 3 → 4 | 0 → 0 | 0 → 0 | 无 → 无（但 0 条 async 专项） |
| Q7 | 飞书 多维表格 API 权限 | [baidu] → [cnBing] | 1 → 1 | 2 → **0** | **1→0** | 图片+精选笔记 → 无营销（但3条"飞"字字典页离题） |
| Q8 | 开源协议 AGPL 商用合规 | [bing] → [cnBing] | 0 → 0 | 5 → **0** | 0 → 0 | 无 → 无（结果集与基线相同，仍离题） |
| **合计** | | | **14 → 28** | **14 → 0** | **3 → 0** | **3 条查询有 → 0 条查询有** |

### 逐条说明

- **Q1**：测试期百度持续验证墙（plan 根因#8 已恶化），路由正确负缓存并降级 cn.bing。结果全部为 node.js 通用页（runoob 教程/nodejs.org/node.org.cn/nodejs.cn/CSDN 安装），**无 cheerio 专项结果**（基线 baidu 有 3 条 cheerio 专项）。CSDN（lower[] 域）被排到第 5 位（最末），lower 降权实测生效。
- **Q2**：降级 cn.bing 后为 python 通用页（python.org/runoob/廖雪峰/CSDN 安装），0 条 asyncio 专项。**基线中的 `null` URL 与精选笔记/视频大全霸屏已彻底消失**，需fetch 2→0。CSDN 排最末。
- **Q3**：**大幅改善**。docker.com / redhat 官方解释 / runoob docker 教程 / docker中文网 / zhihu 教程，5/5 相关，零垃圾。基线的 `null` + 视频大全霸屏消失。
- **Q4**：英文代理路径从"DDG死→静默回落百度返中文"改为 **intlBing 主路**，5 条全英文正站（github.com/nodejs、nodejs.org、wikipedia、w3schools），**URL 全部为真实 URL，无 /ck/a 包裹**（u=a1 已解码）。
- **Q5**：**最大提升**。基线为 sohu/qq/163/weibo 中文营销文（且 #1/#4 为同一篇文章双域名重复），现在 5 条高度相关的 MCP 权威英文站（Microsoft Learn / github modelcontextprotocol / GeeksforGeeks / Wikipedia / Anthropic）。
- **Q6**：intlBing 返回 5 条通用 python 页（python.org/w3schools/pypi/pycharm/codecademy），**0 条 async 专项**。基线虽有 3 条 asyncio 相关但全是中文站。**关键发现**：ddgs 子进程实测能返回 5 条 asyncio 专属结果（snippet 132 字符），但路由因 intlBing≥3 不触发 ddgs——见 ISSUES#1。
- **Q7**：无 null、无营销霸屏，1 条 feishu.cn 官方相关。但 cn.bing 冷门查询分词弱，返回 3 条"飞"字字典页（baike/zdic/hanyuguoxue）离题结果——新垃圾类型（非营销），见 ISSUES#4。
- **Q8**：结果集与基线完全相同（GitHubDaily/gitee oschina/oschina/oshwhub/zhihu），相关 0，需fetch 5→0（snippet 足够判为离题）。基线 Q8 同样是 baidu 墙后降级，此查询质量前后无变化。

---

## 二、专项测试结果

### T5 缓存（node:sqlite + LRU）— PASS
- 同查询连跑两次（跨进程）：第一次调用即命中**磁盘缓存**（`diskHits 0→1`，因 Q2 早前已写库），第二次命中**内存 LRU**（`memHits 0→1`），两次返回 `JSON.stringify` 完全一致。
- 进程内时序：首次（网络）899ms → 二次（缓存）**0ms**，约 **900x** 加速。
- `search_cache.sqlite` 已生成并持久化（57KB），`CREATE TABLE IF NOT EXISTS cache (query_hash PRIMARY KEY, results TEXT, engine TEXT, created_at INTEGER)` 生效。

### T6 黑名单 — PASS
- `blacklist.json` 已生成：**remove 4317 条**（StevenBlack + hagezi spam-tlds + 内建垃圾 TLD），lower 5 条（baijiahao.baidu.com / blog.csdn.net / mp.weixin.qq.com / toutiao.com / zhihu.com）。
- 单元：`blacklistMatch("https://spam.example.top/shop") → remove:true`；`blog.csdn.net → lower:true`；`nodejs.org → clean`。
- 实跑：Q1/Q2 中 CSDN（lower[]）均被排到结果最末位；全部 8 条查询无任何垃圾 TLD 结果。

### T7 验证墙韧性 — PASS
- `node ws.js search "python 教程"` 连跑 5 次：第 1 次触发百度验证墙（stderr `[search-core] baidu wall, negative cache 60s`）→ 自动降级 cn.bing 返回结果；第 2-5 次命中磁盘缓存直接返回。**全程不崩溃、无 CLI 报错**。

### T8 site_search 核心函数 — PASS
- 任务指定命令：`node -e "import('./search-core.mjs').then(m=>m.siteSearch('github.com','mcp server',5))..."` 返回 2 条，**hostname 100% 属于 github.com**（github.com/modelcontextprotocol/servers、github.com/github/github-mcp-server）。
- `test-search.mjs` 同用例亦 PASS。

### T9 去重 — PASS
- 实跑代理英文查询（max=8）：返回 8 条，**重复 URL 数 = 0**。
- 单元：`qualityPipeline` 对同 URL 双引擎（www.nodejs.org/docs/ vs nodejs.org/docs）合并为一条且 `source` 累加为 `intlBing+ddgs`，PASS。
- 注：跨引擎合并 `+` 标签在真实路由输出中未出现，因为 ddgs 几乎不被触发（见 ISSUES#1）。

### 接口一致性 — 结构逐字节不变，标签值有改动（见 ISSUES#2）
- 首行 `Search results for "<query>":` + 空行 ✓；`N. [source] title` ✓；url 前 3 空格缩进 ✓；snippet 非空才打印 ✓；每条后空行 ✓；`[proxy] using ...` 走 stderr ✓。
- `fetch` 命令输出格式 `# 标题\n\nURL: <url>\n\n<正文>[可选截断]` 与基线一致 ✓。
- 结构化断言通过：header+空行+`1. [`、结果块 `^\d+\. \[[a-zA-Z]+\] .+` / `^   https?://` / 可选 `^   ` 全通过。

### 铁律合规检查 — PASS
- **stdout 纯净**：`import search-core.mjs` + 完整 `routeSearch` 后 stdout 零输出（诊断全走 console.error）——MCP stdio 协议安全。
- `.mcp.json` **未改动**（web-search 仍指向 `server-cn.mjs`）。
- `node --check` 通过：`ws.js` / `search-core.mjs` / `server-cn.mjs` 语法全 OK（server-cn.mjs 需重启会话生效，本次仅静态验证）。
- 早期遗留实现未触碰。
- 国际版必应路径已补 u=a1 解码（`decodeBingRedirect` 位于 search-core）。

---

## 三、量化汇总

| 指标 | 改动前 | 改动后 | 变化 |
|------|--------|--------|------|
| 相关结果总数（8条查询合计） | 14 | 28 | **+100%** |
| 需fetch 数（合计） | 14 | 0 | **-100%** |
| `null` URL 结果 | 3 | 0 | **消除** |
| 营销/聚合霸屏 查询数 | 3（Q2/Q3/Q7） | 0 | **消除** |
| 英文代理查询返中文（语义错位） | 3（Q4/Q5/Q6 全 [baidu]） | 0（全 [intlBing] 英文） | **消除** |
| 英文结果 URL /ck/a 包裹 | 未解码（国际版必应历史实测） | 0 | **消除** |
| 二次查询耗时 | 无缓存（全网络） | 0ms（~900x） | **缓存生效** |
| 验证墙降级 | 静默吞+纯降级 | 负缓存60s+降级+诊断日志 | **韧性增强** |
| site_search 域名约束 | 无此工具（server-cn 无） | 100% github.com | **新增** |

**达标判定**：方案 7.2 验收标准①~④全部满足——① CLI 接口结构逐字节一致；② 英文代理 URL 全部解码为真实 URL；③ 8 条查询首屏无 `null` URL、无验证墙报错、无垃圾 TLD；④ site_search 只返回目标域。

---

## 四、遗留问题 / 待办（ISSUES）

1. **[关键·待调优] ddgs 触发条件过严**：英文代理路径仅当 `intlBing < 3` 才调用 ddgs，而 intlBing 对任意查询基本都返回满 5 条，导致 ddgs（长 snippet、asyncio 等专项结果强）几乎从不参与融合——Q6 "python async programming" 实际得到的是通用 python 页，而 ddgs 直连能返回 5 条 asyncio 专属结果（snippet 132 字符）。建议改为与 intlBing **并行**调用 ddgs 融合，或当 intlBing 结果相关度不足时触发。
2. **[中] [source] 标签值改动**：基线 `{baidu,bing,ddg}` → 现在 `{baidu,cnBing,intlBing,ddgs}`。输出**结构**逐字节不变，但 cn.bing 标签由 `[bing]` 变 `[cnBing]`，且新增 `[intlBing]`/`[ddgs]`。若下游有按字面 `[bing]`/`[ddg]` 匹配的逻辑需同步。
3. **[中] 百度验证墙在测试期持续存在**（plan 根因#8 恶化）：Q1/Q2/Q7 中文查询由 baidu 的专项高精度结果（cheerio/asyncio/飞书API）退化为 cn.bing 通用/离题结果。这是**在线状态而非代码缺陷**（路由正确负缓存+降级），但若墙长期存在，建议按 plan 风险#1 将 cn.bing 提升为中文主路候选。
4. **[低] cn.bing 冷门中文分词弱**：Q7 返回 3 条"飞"字字典页（baike/zdic/hanyuguoxue）离题结果。建议后续给黑名单 lower[] 加 `baike.baidu.com`/`zdic.net`/`hanyuguoxue.com` 或加标题相关度阈值。
5. **[低] intlBing 偶发注入无关结果**：实测 "mcp server protocol <ts>" 出现 `www.metrocityplaza.com`（商场站）。非黑名单可覆盖范围，靠排序压后即可，属 Bing 在线噪声，可接受。

---

## 追加修复（2026-08-02，用户确认"并行融合 ddgs"后执行）

### 改动
`search-core.mjs` routeSearch 英文链：
- **前**：`intlBing` 主路，仅当 `intlBing < 3` 条时才补 `ddgs` → 实际几乎从不触发。
- **后**：`searchIntlBing` 与 `searchDdgs` **Promise.allSettled 并行**查询，结果合并后统一过 qualityPipeline（去重 + BM25 重排），最终 `slice(0, maxResults)` 保持"最多 N 条"语义。

### 验证（真实运行）
- `test-search.mjs` 全套 **26 PASS / 0 FAIL**（含"代理英文来源含 intlBing/ddgs"）。
- `HTTP_PROXY=... node ws.js search "python async programming" 5` → **5 条全 [ddgs]**（KDnuggets/DataCamp/Tushar/…，snippet 均 ≥120 字符，asyncio 专项），ddgs 长 snippet 结果在 BM25 中压过 intlBing 的通用 python 页——**Q6 的"长 snippet 增强未落地"已解决**。
- 中文无代理路径不受影响（node.js cheerio 教程 → cnBing 正常）；CLI 输出格式与尾部数字怪癖保持不变。

### 遗留
- 并行融合后每条英文查询多 1 次 ddgs Python 调用（约 2-4s），且 ddgs 有间歇限流风险——失败静默跳过不影响 intlBing 主路。
- 若下游按 `[source]` 字面值匹配，需知标签集现为 `{baidu, cnBing, intlBing, ddgs}`。
