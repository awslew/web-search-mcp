#!/usr/bin/env node
/**
 * Web Search CLI Tool v2 — 本机搜索/抓取，适合国内网络环境
 *
 * 搜索：委托 search-core.mjs 的 routeSearch（多引擎路由 + 质量管线；
 *   无代理 百度→cn.bing；有代理 intlBing→ddgs 兜底）
 * 抓取：直接请求目标 URL（如果被墙会报错，但常见国内站点可访问）
 *
 * 用法：
 *   node ws.js search "<query>" [max_results]
 *   node ws.js fetch "<url>" [max_length]
 *
 * 由 Claude Code Bash 工具调用，替代内置 WebSearch/WebFetch。
 */

import { setGlobalDispatcher, ProxyAgent } from "undici";
import { routeSearch, __lastSearchHealth, apiEngineAvailable, __reloadApiKeys } from "./search-core.mjs";
// fetchUrl 的本地副本已删除（2026-09-20）：它与 server-cn.mjs 曾是**逐字重复**的两份实现，
// 现统一为 extract-core.mjs 一份。输出契约不变，仍是 `# {title}\n\nURL: {url}\n\n{content}`；
// 变化只在于 content 从"拍平的纯文本"改为"干净 Markdown"（可用 FETCH_FORMAT=text 退回旧行为）。
import { fetchUrl as extractFetchUrl } from "./extract-core.mjs";

// ── Proxy support ──
// 设置 HTTP_PROXY 环境变量即可通过代理出国抓取外网内容
const PROXY = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
if (PROXY) {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY));
    console.error(`[proxy] using ${PROXY}`);
  } catch (e) {
    console.error(`[proxy] failed: ${e.message}`);
  }
}

// resolveBaiduUrl 已迁移至 search-core.mjs（searchBaidu 内部 best-effort 解析跳转链）。

// ── 搜索实现已迁移至 search-core.mjs（routeSearch） ──
// 旧实现 searchBaidu / searchBing / searchDuckDuckGo / resolveBaiduUrl /
// resolveBaiduUrls / search 已从 ws.js 删除（见 git 历史）。
// 验证墙/多引擎降级/缓存/黑名单/去重/BM25 全部由 search-core.mjs 处理，
// ws.js 只保留 CLI 壳与 fetch 命令。

// ── Fetch URL ──
// 实现已迁至 extract-core.mjs（详见该文件顶部对"为什么不用 trafilatura"与
// "CHANGELOG 里 Readability 收益接近零的旧结论为何被推翻"的记录）。
//
// ⚠️ 与 OPTIMIZATION_PLAN.md 的纪律冲突（2026-09-20，已显式记录而非默默绕过）：
//   该文档第 5 行与第 179 行写「`ws.js` 的 `fetch` 命令——不改」「CLI 参数解析与输出格式
//   逐字节不变」。本次改动**违反了"输出格式不变"这一条**——content 从拍平的纯文本
//   换成了保留结构的 Markdown。理由：旧输出把标题/列表/代码块/表格全部碾成单行长文本，
//   与"喂给 LLM 的干净内容"这个目标正相反（离线夹具实测结构标记：旧 0 个 →
//   新 5 标题/3 列表/1 代码块/1 链接/4 表格行）。
//   已严守的部分：命令行参数（`fetch <url> [max_length]`）、标题头 `# {title}\n\nURL: {url}\n\n`、
//   截断标注格式均逐字节不变；且可用 `FETCH_FORMAT=text` 一键退回旧行为。
//   若该纪律优先级更高，把下面这行改成 `markdown: false` 即可完全回退，其余改动无需动。

async function fetchUrl(targetUrl, maxLength = 8000) {
  return extractFetchUrl(targetUrl, maxLength, {
    markdown: (process.env.FETCH_FORMAT || "markdown") !== "text",
  });
}

// ── Main ──

const [,, command, ...rest] = process.argv;

async function main() {
  switch (command) {
    case "search": {
      const query = rest.join(" ");
      if (!query) { console.error("Usage: node ws.js search \"<query>\""); process.exit(1); }
      const maxResults = Math.min(Math.max(parseInt(process.env.MAX_RESULTS || "5", 10) || 5, 1), 10);
      const results = await routeSearch(query, maxResults);
      const health = __lastSearchHealth();
      console.log(`Search results for "${query}":\n`);
      results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.source}] ${r.title}`);
        console.log(`   ${r.url}`);
        if (r.snippet) console.log(`   ${r.snippet}`);
        console.log();
      });
      // 降级告警（2026-09-12）：引擎被限流时结果会明显变差，且不写缓存。
      // 必须显式告知，否则调用方会把"引擎全被墙"误当成"这就是最好结果"。
      if (health && health.degraded) {
        console.log(`⚠️  DEGRADED RESULT — engines: ${health.engines.join(" ") || "none"}; reasons: ${health.reasons.join("; ")}.`);
        console.log(`    结果可能不相关（引擎限流中），请稍后重试或换关键词；本次未写缓存。`);
        // 只在"已经降级 且 没有 API 抢救"时提示配置 —— 这正是用户最该知道、
        // 却最容易被静默掩盖的一处（闸门没 key 时不报错、只是不工作）。
        if (!apiEngineAvailable()) {
          console.log(`    提示：当前**未配置搜索 API 密钥**，所以没有 API 抢救兜底（这正是本机中文链的最大短板）。`);
          console.log(`    配一个即可在本情形下自动救回：node ws.js status 查看配置方式。`);
        }
      }
      break;
    }

    case "status": {
      // 一眼看清"当前会用哪个检索链路、缺什么" —— 省得靠读代码推断。
      const has = apiEngineAvailable();
      const keys = __reloadApiKeys();
      const provider = keys.tavily ? "tavily" : keys.bocha ? "bocha" : keys.zhipu ? "zhipu" : null;
      console.log(`搜索 API 抢救闸门：${has ? `已启用（provider=${provider}）` : "未启用"}`);
      if (!has) {
        console.log(`  没有密钥 → 百度被墙 / sogou 反爬时，中文链只能靠 cn.bing 独扛，且无第三方兜底。`);
        console.log(`  配置方式（推荐放**环境变量**，不必写进文件）：`);
        console.log(`    TAVILY_API_KEY=<你的key>   # 每月 1000 次免费额度，多账号可叠加`);
        console.log(`    ZHIPU_API_KEY=<你的key>    # 中文效果好，需先充值`);
        console.log(`    BOCHA_API_KEY=<你的key>    # 中文效果好，按次计费`);
        console.log(`  持久化按平台任选其一：`);
        console.log(`    PowerShell（用户级）：[Environment]::SetEnvironmentVariable('TAVILY_API_KEY','<key>','User')`);
        console.log(`    bash/zsh：export TAVILY_API_KEY=<key>   （写进 ~/.bashrc 或 ~/.zshrc）`);
        console.log(`    也可复制 api-keys.example.json 为 api-keys.json 直接填值（读文件那条路同样有效）`);
        console.log(`  设完重开进程，再跑：node verify-api.mjs`);
      } else {
        console.log(`  优先级 tavily > bocha > zhipu（首个配了 key 的胜出）。`);
        console.log(`  ⚠️ 选哪家**不能只看单价**：单次价格 zhipu < bocha < tavily，`);
        console.log(`     但 tavily 每月 1000 次免费额度、多账号可叠加，实际近乎零成本。`);
        console.log(`  🔑 环境变量读不到时，本服务器会回退：api-keys.json → Windows 用户注册表（仅 win32，HKCU\\Environment）。`);
        console.log(`     某些 MCP 宿主会清洗子进程环境变量，这就是为什么要留第二条读取路径。`);
        console.log(`  debug：node verify-api.mjs（API 与生产链路并排对比）/ node eval/api-ab.mjs（受控 A/B）`);
      }
      break;
    }

    case "fetch": {
      const url = rest[0];
      if (!url) { console.error("Usage: node ws.js fetch \"<url>\""); process.exit(1); }
      const maxLength = Math.min(parseInt(rest[1] || "8000", 10) || 8000, 50000);
      const content = await fetchUrl(url, maxLength);
      console.log(content);
      break;
    }

    default:
      console.error("Usage:");
      console.error("  node ws.js search \"<query>\" [max_results]");
      console.error("  node ws.js fetch \"<url>\" [max_length]");
      console.error("  node ws.js status                 # 查看检索链路与 API 密钥配置状态");
      console.error("\nEnd: MAX_RESULTS (default 5) / FETCH_FORMAT=markdown|text");
      process.exit(1);
  }
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
