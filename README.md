# Web Search MCP Server

一个专为 AI 编码助手打造的免费、跨引擎、高质量联网检索与正文抽取 MCP（Model Context Protocol）stdio 服务器。

[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](#环境要求)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证)
[![Protocol](https://img.shields.io/badge/MCP-stdio-orange.svg)](#客户端接入)

---

## 为什么选择本项目

通用搜索引擎直接喂给大模型常存在三大痛点：商业推广与 UGC 营销页挤占前排、重定向与泛首页因词面复述取得虚高得分、网页抽取丢失代码块与表格结构。

本项目通过多层质量管线解决上述问题：
1. **多引擎直连与融合**：中文查询并行聚合国内直连引擎（百度移动端、必应中国、搜狗），英文查询走国际引擎并行融合，经 RRF（Reciprocal Rank Fusion）多路交叉校验。
2. **两级垃圾域过滤**：对垃圾域名硬过滤（`remove`）、对百家号/知乎/CSDN 等 UGC 域降权（`lower`）。代码内置一份兜底名单（垃圾 TLD + 短链域 + 策划降权域），开箱即生效；完整名单（4,300+ 规则）由 `npm run update:blacklist` 从公开上游列表本地生成 —— **该数据文件因上游为 GPL-3.0 许可而不随本仓库分发**。实测真实场景查询 nDCG@5 提升 8.4% 且技术查询零回归。
3. **权威源信号加权与官方文档召回**：识别官方文档子站（如 `docs.*`、`dev.*`）并给予权威加权。离线评估集（40 条标注查询）总体 nDCG@5 由 `0.7788` 提升至 `0.9313`，hit@1 由 `0.6667` 提升至 `0.9000`；另有 8 条查询的**同一份候选池**在线开/关对照：信号开启时 hit@1 `8/8`、关闭时 `2/8`。⚠️ 该 8 条是按"官方域在候选池内"挑出的，**结果偏乐观**，离线涨幅也相对 09-12 的旧缓存基线，不宜当作普适增益。对技术查询自动推断官方域并发起站内召回，确保官方文档页进候选池。
4. **API 抢救闸门**：仅在生产引擎受限（候选池 `raw < 12`）时自动并入搜索 API（支持 Tavily / 博查 / 智谱），无 key 时保持纯免费直连。受控 A/B 实测（40 次 API 调用）：中文 nDCG@5 `0.6359 → 0.7370`（+0.1011），英文**逐位零影响**；对照的"无条件全并入"策略虽然中文同分，却把英文打掉 5.1% —— 这正是设置闸门条件的意义。
5. **结构化 Markdown 抽取**：采用 `linkedom` + `Readability` + `turndown` 抽取正文，保留标题、代码块、GFM 表格与链接，内置 GBK/GB2312 编码自动探测与解码。

---

## 环境要求

- **Node.js ≥ 22.5**（推荐 Node 24 LTS）
  - **原因**：项目内置的持久化查询缓存使用了 Node 原生 `node:sqlite` 的 `DatabaseSync` 同步接口，无需额外编译 C++ 原生模块。

---

## 快速安装

```bash
git clone https://github.com/awslew/web-search-mcp.git
cd web-search-mcp
npm install
```

---

## 客户端接入

通过 MCP stdio 协议接入各类 AI 客户端。将 `<repo>` 替换为本仓库所在的本地绝对路径（在终端执行 `pwd` 或 `cd` 获取）。

### 1. Claude Code
在配置文件 `mcp.json` 中添加：

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["<repo>/server-cn.mjs"]
    }
  }
}
```

### 2. Claude Desktop
在 `claude_desktop_config.json`（macOS 位于 `~/Library/Application Support/Claude/`，Windows 位于 `%APPDATA%\Claude\`）中添加：

```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["<repo>/server-cn.mjs"]
    }
  }
}
```

---

## MCP 工具列表

服务器暴露 3 个标准 MCP 工具：

| 工具名称 | 参数 | 说明 |
|---|---|---|
| `web_search` | `query` (string, 必填)<br>`max_results` (number, 1–10, 默认 5) | 全网多引擎搜索，返回去重与 RRF 排序后的标题、URL 与摘要 |
| `site_search` | `query` (string, 必填)<br>`domain` (string, 必填)<br>`max_results` (number, 1–10, 默认 5) | 指定域名站内搜索（如 `github.com`、`docs.python.org`），100% 限制在目标域 |
| `web_fetch` | `url` (string, 必填)<br>`max_length` (number, 默认 8000, 上限 50000)<br>`format` (enum: `markdown` \| `text`, 默认 `markdown`) | 抓取网页并提取结构化正文，自动剥离导航、页脚与广告 |

---

## CLI 命令行用法

除 MCP 模式外，亦可直接使用 `ws.js` 独立命令行：

```bash
# 1. 网页检索
node ws.js search "mysql 索引 最左前缀原则"

# 2. 网页正文抽取
node ws.js fetch "https://nodejs.org/api/fs.html"

# 3. 查看检索链路与 API 密钥配置状态
node ws.js status
```

---

## 配置与环境变量

### 1. 代理配置
国内引擎（百度、搜狗、必应中国）默认直连以保证低延迟与解析准确；国际引擎与外网抓取支持代理。
- 优先级：`INTL_BING_PROXY` > `HTTP_PROXY` > `HTTPS_PROXY`
- 若设置了全局 `HTTP_PROXY`，系统会自动为国内引擎保持直连（`directDispatcher`），避免代理节点干扰国内直连通道。

### 2. 可选 API 引擎（抢救闸门）
无需任何 API Key 即可完整使用多引擎免费检索。如需在极端限流时增强稳定性，可配置以下环境变量：
- `TAVILY_API_KEY`（优先级最高，每月提供免费额度）
- `BOCHA_API_KEY`（博查搜索）
- `ZHIPU_API_KEY`（智谱搜索）

亦可参考 `api-keys.example.json` 创建 `api-keys.json` 配置文件。未配置任何 Key 时行为完全不变。

### 3. 可选高级特性
- `RERANK=1`：开启语义重排（**默认关闭，且不建议开**）。开启后首次会下载 `Xenova/bge-reranker-base` 本地模型（约 283 MB）。混合权重由 `RERANK_WEIGHT` 控制，代码默认 0.35。
  - ⚠️ 但实测结论是**权重越大越差**：纯 RRF 基线中文 nDCG@5 为 `0.8396`，权重 0.35 时降到 `0.6446`，权重 1.0 时进一步掉到 `0.4628`。原因是 cross-encoder 偏好"像直接答案"的文本，会**系统性把官方文档降级为第三方博客**。想找权威文档时请保持关闭；只有明确想找通俗教程/问答时再考虑，并参考 `eval/sweep-rerank.mjs` 自行标定。
- `web_fetch` / `ws.js fetch` 的输出格式：通过参数 `format` 控制（`markdown` 默认、保留结构；`text` 为拍平纯文本）。

### 4. 垃圾域黑名单（本地生成，可选）

代码**内置一份兜底名单**（垃圾 TLD + 短链域 + 策划降权域），开箱即用、无需任何额外步骤。

完整名单（4,300+ 条规则）需本地生成：

```bash
HTTP_PROXY=http://127.0.0.1:<port> npm run update:blacklist   # 需代理（上游列表在境外）
```

它会从 StevenBlack/hosts 与 hagezi/dns-blocklists 下载、压缩去重后写入 `blacklist.json`，运行时**只读该文件、不再联网**（任意下载失败则跳过该源，仍用内建名单写出文件）。

> ⚠️ **该文件不随本仓库分发**：上游 hagezi/dns-blocklists 采用 **GPL-3.0** 许可，本仓库为 MIT，直接打包其衍生物会造成许可冲突。因此 `blacklist.json` 被列入 `.gitignore`，请自行生成（生成物仅供你本地使用，是否再分发请自行遵循上游许可）。若某次下载全部失败，程序行为与没有该文件时完全一致。

---

## 测试与评估

项目包含完善的单元测试与离线评估体系：

```bash
# 运行全量测试套件（共 9 套，包含 2 套真实网络测试）
npm test

# 仅运行纯离线确定性单元测试（7 套，跳过网络用例）
npm run test:unit

# 运行权威源信号在线同池开/关对照验证
npm run verify:quality

# 离线评估体系：录制原始候选池 / 离线重放打分 / 结果对比
npm run eval:capture mytag
npm run eval:replay mytag
npm run eval:compare mytag-baseline mytag-new
```

> **注意**：`npm test` 中有 2 套测试（`test-search.mjs` 与 `test-mcp-e2e.mjs`）需访问真实网络。如遇目标站限流或网络抖动可能出现偶发失败，确认代码逻辑时请优先使用 `npm run test:unit`。

---

## 项目结构

```
web-search-mcp/
├── server-cn.mjs         # MCP stdio 服务器入口（注册 3 个 MCP 工具）
├── ws.js                 # CLI 命令行入口（search / fetch / status）
├── search-core.mjs       # 核心检索层（引擎驱动、RRF 融合、黑名单、权威加权、缓存与 API 闸门）
├── extract-core.mjs      # 正文抽取管线（linkedom + Readability + turndown + GBK 解码）
├── rerank.mjs            # 可选语义重排层（cross-encoder，默认关闭）
├── blacklist.json        # 垃圾域名与降权规则数据（本地生成，未随仓库分发，见下）
├── ddgs_search.py        # 可选 DuckDuckGo 搜索 Python 桥接脚本
├── api-keys.example.json # API 密钥模板（复制为 api-keys.json 使用）
├── run-tests.mjs         # 测试驱动器（9 套测试调度）
├── test-search.mjs       # 检索通道真实网络测试
├── test-mcp-e2e.mjs      # MCP 端到端 JSON-RPC 通信测试
├── verify-quality.mjs    # 权威源信号在线同池对照脚本
├── verify-api.mjs        # 搜索 API 连通性与结果验证脚本
├── update_blacklist.mjs  # 黑名单生成脚本（`npm run update:blacklist`）
├── eval/                 # 离线评估套件（40 条标注基准查询 queries.json 与调参脚本）
├── skill/                # Agent skill：检索纪律与实测参考手册（见下）
├── CHANGELOG-2026-09.md  # 检索精准度改造记录（含大量受控实验与否定结论）
├── OPTIMIZATION_PLAN.md  # 设计依据与取舍记录
├── DEPLOY_GUIDE.md       # 部署与故障排查手册
├── baseline_results.md   # 改动前行为基线（8 条查询逐字输出）
└── VERIFICATION_REPORT.md # 改动后验收报告（与基线逐条对照）
```

---

## 附带：Agent Skill（`skill/`）

`skill/SKILL.md` 是一份可直接喂给 coding agent 的**检索纪律与实测参考手册**，把上面这些结论整理成可执行的规则：何时用 `site_search`、查询怎么切词、`⚠️ DEGRADED` 该怎么处理、闸门与权重这些参数的**调参陷阱**（哪些结论是脆弱的、哪些指标会高估）。

它同时是一份"踩坑清单"：里面记录了若干次**被自己推翻的判断**（例如语义重排看似提升实为负优化、按评估集调参得到的满分是假象），这些负面结论比正面结论更值得读。

如果你的客户端支持 skill / 自定义指令机制，可直接引用该文件；不支持的话，把其中「查准与站内搜索纪律」一节贴进系统提示词也有明显收益。

---

## 主要依赖

- `@modelcontextprotocol/sdk`：官方 Model Context Protocol SDK
- `linkedom` & `@mozilla/readability`：轻量 DOM 解析与 Mozilla 正文提取引擎
- `turndown` & `turndown-plugin-gfm`：HTML 转 Markdown 及 GFM 表格插件
- `minisearch`：内存级 BM25 词频与相关性打分
- `iconv-lite`：中文多编码（GBK/GB2312/BIG5）精准解码
- `undici`：高性能 Node 原生 HTTP 客户端与代理分派器
- `cheerio`：HTML 页面解析与抽取

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
