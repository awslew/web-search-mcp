#!/usr/bin/env node
/**
 * Web Search MCP Server — 中国网络友好版
 *
 * 搜索：百度 + 必应中国站（国内直连，不需要翻墙）
 * 抓取：直接请求 URL（国内可达的站能抓，被墙的会报错）
 *
 * 替代 Claude Code 内置 WebSearch/WebFetch（走 Console Go 代理必挂）
 *
 * 2026-09-20 变更：正文抽取迁至 extract-core.mjs，web_fetch 默认返回干净 Markdown。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { routeSearch, siteSearch, __lastSearchHealth } from "./search-core.mjs";
// 正文抽取已抽到 extract-core.mjs（server-cn.mjs 与 ws.js 共用，消除此前的逐字重复副本）。
// 行为变化（2026-09-20）：web_fetch 默认返回干净 Markdown 而非拍平的纯文本；
// 需要旧行为时调用方传 format="text"。详见 extract-core.mjs 顶部注释。
import { fetchUrl, DEFAULT_UA as EXTRACT_UA } from "./extract-core.mjs";

// ─── 常量 ──────────────────────────────────────────

/** 引擎被限流时的降级告警前缀。返回给调用方模型，避免把"引擎全被墙"误当成"这就是最优结果"。 */
const DEGRADED_HINT =
  "⚠️ DEGRADED SEARCH — 引擎限流中（如百度验证墙/sogou 反爬/代理抖动），结果可能不相关。" +
  "本次结果未写缓存，稍后重试或换关键词可恢复；高精度需求请改用 site_search。";

function degradedBanner(query) {
  const h = __lastSearchHealth();
  if (!h) return "";
  if (h.query !== query) return ""; // 健康度属于上一次不同查询 → 不复用
  return h.degraded ? `${DEGRADED_HINT}\n\n` : "";
}

const USER_AGENT = EXTRACT_UA; // 保留此别名以免下游引用失效；真身在 extract-core.mjs

const TOOL_DEFS = [
  {
    name: "web_search",
    description:
      "Search the web using Baidu + Bing China. Returns title, URL, and snippet. " +
      "Use this when you need to search for information online. " +
      "Works without VPN in China.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: { type: "number", description: "Maximum results (1–10, default 5)", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its readable content as clean Markdown " +
      "(headings, lists, fenced code blocks, GFM tables and links preserved; " +
      "ads, nav, footer, sidebar and recommendation blocks stripped). " +
      "Use this to read articles, documentation, or any web page. " +
      "Pass format=\"text\" if you want flat plain text instead of Markdown. " +
      "NOTE: Foreign websites blocked in China will fail.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        max_length: { type: "number", description: "Max characters (default 8000)", default: 8000 },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "Output format: markdown (default, preserves structure) or text (flat plain text).",
          default: "markdown",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "site_search",
    description:
      "Search within a single website (restricted to one domain). " +
      "Appends site:<domain> to the query and filters results by hostname, " +
      "so 100% of results belong to the target site. " +
      "Use this when the user asks to search a specific website " +
      "(e.g. github.com, docs.python.org) instead of web_search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        domain: { type: "string", description: "The domain to restrict to, e.g. github.com (www/protocol optional)" },
        max_results: { type: "number", description: "Maximum results (1–10, default 5)", default: 5 },
      },
      required: ["query", "domain"],
    },
  },
];

// ─── 抓取 URL ───────────────────────────────────────
// fetchUrl / sanitizeText / isValidUrl 已迁至 extract-core.mjs（2026-09-20）。
// 旧实现在此处与 ws.js 各有一份**逐字重复**的副本，两处已同时删除。
// 旧实现的两个结构性缺陷（详见 extract-core.mjs 顶部注释）：
//   ① 取 `main, article, ...` 的 `.first()` 而非**最大正文块** → 选错块就整篇丢正文；
//   ② sanitizeText 先 `\s+ → " "` 把换行全碾平 → Markdown 结构在此销毁，
//      导致输出永远是单行长文本（喂给 LLM 与"干净 Markdown"目标正相反）。

// ─── MCP Server ──────────────────────────────────────

const server = new Server(
  { name: "web-search-cn", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "web_search": {
        const query = String(args?.query || "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");
        const maxResults = Math.min(Math.max(Number(args?.max_results) || 5, 1), 10);

        const results = await routeSearch(query, maxResults);
        if (!results.length) {
          return { content: [{ type: "text", text: `No results found for "${query}".` }] };
        }

        const formatted = results
          .map((r, i) => {
            const cov = r.coverage !== undefined ? ` (coverage: ${r.coverage.toFixed(2)})` : "";
            return `${i + 1}. **${r.title}**\n   ${r.url}\n   🔍 ${r.snippet || "(no snippet)"}${cov}`;
          })
          .join("\n\n");

        const degraded = __lastSearchHealth()?.degraded;
        if (degraded) {
          return { content: [{ type: "text", text: `${degradedBanner(query)}Search results for "${query}":\n\n${formatted}` }] };
        }

        return {
          content: [{ type: "text", text: `Search results for "${query}":\n\n${formatted}` }],
        };
      }

      case "site_search": {
        const query = String(args?.query || "").trim();
        const domain = String(args?.domain || "").trim();
        if (!query) throw new McpError(ErrorCode.InvalidParams, "query is required");
        if (!domain) throw new McpError(ErrorCode.InvalidParams, "domain is required");
        const maxResults = Math.min(Math.max(Number(args?.max_results) || 5, 1), 10);

        const results = await siteSearch(domain, query, maxResults);
        if (!results.length) {
          return {
            content: [
              {
                type: "text",
                text: `🔒 Results restricted to ${domain}\n\nNo results found for "${query}" on ${domain}. ` +
                  `Try simplifying the domain (drop www/protocol) or using different keywords.`,
              },
            ],
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   🔍 ${r.snippet || "(no snippet)"}`)
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `🔒 Results restricted to ${domain}\n\nSearch results for "${query}" on ${domain}:\n\n${formatted}`,
            },
          ],
        };
      }

      case "web_fetch": {
        const url = String(args?.url || "").trim();
        if (!url) throw new McpError(ErrorCode.InvalidParams, "url is required");
        const maxLength = Math.min(Number(args?.max_length) || 8000, 50000);
        const format = args?.format === "text" ? "text" : "markdown";
        const content = await fetchUrl(url, maxLength, { markdown: format === "markdown" });
        return { content: [{ type: "text", text: content }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ─── 启动 ────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Web Search MCP (CN) server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
