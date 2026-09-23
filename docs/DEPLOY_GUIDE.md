# Web Search MCP 部署与排查指南

本文档介绍如何在本地环境中部署 Web Search MCP 服务器，并将其接入 Claude Code、Claude Desktop 或其他兼容 Model Context Protocol 的 AI 客户端。

---

## 1. 架构方案说明

本项目支持两种调用方式：

1. **MCP 服务器模式（推荐）**：
   - 基于 Model Context Protocol 标准 stdio 协议。
   - 自动向 AI 客户端注册 `web_search`、`site_search` 和 `web_fetch` 工具。
   - AI 在需要检索或抓取时自动调用，无需人工干预或额外的提示词约束。
2. **CLI 命令行模式（备选/调试）**：
   - 通过 `node ws.js search <关键词>` 或 `node ws.js fetch <网址>` 独立调用。
   - 适合脚本集成、网络连通性调试或终端手动检索。

---

## 2. 环境准备

### Node.js 版本要求
- **必须 Node.js ≥ 22.5**（推荐 Node 24 LTS）
- **验证命令**：
  ```bash
  node --version
  ```
- **注意**：本项目使用 Node.js 原生内置的 `node:sqlite`（`DatabaseSync`）实现持久化查询缓存，低于 22.5 的版本会报 `ERR_UNKNOWN_BUILTIN_MODULE` 错误。

---

## 3. 安装与依赖配置

通过 Git 克隆仓库并安装运行时依赖：

```bash
# 1. 克隆代码仓库至本地目录
git clone https://github.com/awslew/web-search-mcp.git

# 2. 进入项目目录
cd web-search-mcp

# 3. 安装依赖（包含 MCP SDK、Readability、linkedom、turndown 等）
npm install
```

> **获取本地绝对路径**：
> 记下当前仓库目录的绝对路径 `<repo>`（在 Linux/macOS 终端执行 `pwd`，在 Windows 终端执行 `cd` 或 `(Get-Location).Path`）。后续配置客户端时将使用该路径。

---

## 4. 客户端配置

### 4.1 Claude Code 接入

在 Claude Code 的配置文件 `mcp.json` 中，添加 `web-search` 服务器配置：

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

> 请将 `<repo>` 替换为实际的本地绝对路径。Windows 路径中若使用反斜杠需进行转义（如 `C:\\path\\to\\web-search-mcp\\server-cn.mjs`）或直接使用正斜杠（`C:/path/to/web-search-mcp/server-cn.mjs`）。

### 4.2 Claude Desktop 接入

编辑 Claude Desktop 的配置文件 `claude_desktop_config.json`：
- **macOS**：`~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**：`%APPDATA%\Claude\claude_desktop_config.json`

在 `mcpServers` 字段下添加：

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

### 4.3 重启生效
保存配置文件后，**完全重启**相应的 AI 客户端。客户端启动初始化时会与 MCP 服务器建立 stdio 连接并加载工具。

---

## 5. 网络与环境变量配置

### 5.1 代理策略（国内直连 + 国际代理）
- **国内引擎（百度/必应中国/搜狗）**：默认直连，以获得最低延迟和最准确的中文结果。
- **国际引擎与外网抓取**：若需检索外网或访问海外文档，需配置代理。
- **代理环境变量优先级**：
  `INTL_BING_PROXY` > `HTTP_PROXY` > `HTTPS_PROXY`
- **设计说明**：即便在系统或环境设置了全局 `HTTP_PROXY`，项目内部也通过独立的分派器确保国内引擎走直连通道，避免因外部代理节点抖动破坏国内搜索。

### 5.2 跨平台环境变量设置方式

#### Linux / macOS
在 `~/.bashrc` 或 `~/.zshrc` 中添加：
```bash
export HTTP_PROXY="http://127.0.0.1:<proxy_port>"
export HTTPS_PROXY="http://127.0.0.1:<proxy_port>"
```

#### Windows (PowerShell)
临时生效：
```powershell
$env:HTTP_PROXY = "http://127.0.0.1:<proxy_port>"
$env:HTTPS_PROXY = "http://127.0.0.1:<proxy_port>"
```
用户级永久生效：
```powershell
[Environment]::SetEnvironmentVariable('HTTP_PROXY', 'http://127.0.0.1:<proxy_port>', 'User')
[Environment]::SetEnvironmentVariable('HTTPS_PROXY', 'http://127.0.0.1:<proxy_port>', 'User')
```

### 5.3 搜索 API 抢救闸门（可选）
本项目在无任何 Key 的纯免费模式下即可完整工作。若希望在极端网络限流情况下具备第三方 API 抢救能力，可设置以下环境变量：

```bash
# 优先级：Tavily > 博查 (Bocha) > 智谱 (Zhipu)
export TAVILY_API_KEY="你的_tavily_key"
export BOCHA_API_KEY="你的_bocha_key"
export ZHIPU_API_KEY="你的_zhipu_key"
```

或复制 `api-keys.example.json` 为 `api-keys.json` 并在对应字段填入密钥。

---

## 6. 验证与排查手册

### 6.1 快速健康检查

在项目根目录下执行：

```bash
# 1. 查看链路与密钥状态
node ws.js status

# 2. 运行快速搜索自测
node ws.js search "Node.js fs 模块"

# 3. 运行网页提取测试
node ws.js fetch "https://nodejs.org"
```

---

### 6.2 常见故障与排查步骤

#### 故障 1：AI 客户端中找不到 `web_search` 工具或启动报错
1. **检查 Node.js 版本**：运行 `node --version`，必须 ≥ 22.5。若版本过低，MCP 服务器在加载 `node:sqlite` 时会直接退出。
2. **检查 JSON 路径配置**：
   - 确认配置文件中填写的是**绝对路径**而非相对路径。
   - Windows 路径必须双写反斜杠 `\\` 或使用正斜杠 `/`，切勿使用形如 `%VAR%` 的动态变量（JSON 解析器不展开环境变量）。
3. **独立启动验证**：在终端直接运行 `node <repo>/server-cn.mjs`。如果正常输出 `Web Search MCP (CN) server running on stdio` 且不崩溃，则说明服务端代码与依赖完好。

#### 故障 2：搜索返回空结果或提示限流降级
1. **原因分析**：特定国内引擎（如百度/搜狗）在短时间内收到连续高频请求时，可能会触发安全验证或滑动验证码页面。
2. **处理机制**：
   - 系统检测到反爬验证页后会自动记录 60 秒负缓存，并自动降级回落至必应中国等可用直连引擎。
   - CLI 和 MCP 输出会附带降级提示（`DEGRADED`），避免模型误判。
3. **建议对策**：
   - 稍后重试或更换查询关键词。
   - 精确查找某网站内容时，使用 `site_search` 工具限制目标域名。
   - 配置可选的 `TAVILY_API_KEY` 等 API 密钥开启自动抢救。

#### 故障 3：国际检索或外网抓取超时
1. **检查代理连通性**：确认本地代理客户端正常运行，且 `HTTP_PROXY` 端口配置正确。
2. **测试代理网络**：在配置了代理的终端中执行 `node ws.js search "rust ownership model"`。

#### 故障 4：页面抓取乱码或排版混乱
1. **正文抽取管线**：项目内置了 GBK、GB2312、BIG5 的自动探测与解码，并使用 Readability 结合站点专用选择器提取最大正文块。
2. **输出格式**：默认返回去除广告与导航的结构化 Markdown。如需拍平纯文本，可在调用 `web_fetch` 时传入 `format: "text"` 或设置环境变量 `FETCH_FORMAT=text`。

---

## 7. 部署检查清单

- [ ] Node.js 版本已确认（`node --version` ≥ 22.5）
- [ ] 仓库克隆完成且 `npm install` 依赖安装无报错
- [ ] 执行 `node ws.js status` 输出正常
- [ ] 客户端配置文件（如 `mcp.json` 或 `claude_desktop_config.json`）已写入绝对路径
- [ ] 客户端完全重启后，确认 `web_search`、`site_search`、`web_fetch` 3 个工具已注册
- [ ] 发送测试指令（如"搜索 Node.js 异步流最佳实践"），确认工具正常调用并返回结构化结果
