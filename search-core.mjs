#!/usr/bin/env node
/**
 * search-core.mjs — 共享检索核心
 *
 * 供 ws.js 与 server-cn.mjs 共用的引擎层 + 质量管线 + 缓存 + 路由。
 * 设计依据：OPTIMIZATION_PLAN.md（2026-08-02）。
 *
 * 铁律：本模块是 stdio MCP server 的依赖，【绝不能向 stdout 打印任何内容】，
 *       所有诊断信息一律 console.error。
 *
 * 导出：searchBaidu / searchCnBing / searchSogou / searchIntlBing / decodeBingRedirect /
 *       searchDdgs / routeSearch / siteSearch / qualityPipeline /
 *       hasCJK / queryLanguage / cleanQuery / extractQueryTerms / termCoverage /
 *       extractDomain / normalizeUrl / normalizeDomain /
 *       blacklistMatch / BaiduWallError / blacklist / __cacheStats（测试诊断）
 */

import * as cheerio from "cheerio";
import { setGlobalDispatcher, ProxyAgent, Agent } from "undici";
import MiniSearch from "minisearch";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RERANK_ENABLED, rerankResults } from "./rerank.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── 代理设置（沿用 ws.js 顶部逻辑：HTTP_PROXY / HTTPS_PROXY → ProxyAgent） ──
const PROXY = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
if (PROXY) {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY));
  } catch (e) {
    console.error(`[search-core] proxy setup failed: ${e.message}`);
  }
}

/**
 * 国内引擎直连 dispatcher（2026-09 关键修复）。
 *
 * 根因：全局 ProxyAgent 一旦装上，**所有** fetch 都走代理出国，包括 cn.bing / sogou / 百度。
 * 实测 cn.bing 经代理返回空页（即使代理规则里已有 .cn 直连），于是"中文多路融合"退化成
 * intlBing 单引擎——候选池平均只有 6.6 条，排序算法无从发挥。
 * 修法：给国内引擎显式传直连 dispatcher，国际引擎走代理。
 */
const DIRECT_AGENT = new Agent({ connect: { timeout: 15_000 } });
export function directDispatcher() { return DIRECT_AGENT; }

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// API「抢救」闸门的生产 raw 条数门槛（详见 routeSearch 里 `if (apiResults.length && raw.length < ...)` 处的推导）。
// 12 由 2026-09-21 的受控 A/B 标定得出（每路引擎请求宽度 5，健康中文查询 raw=13、单路 raw=5）。
// ⚠️ 改每路宽度或引擎数后必须重跑 `eval/api-ab.mjs --refetch` 重新标定。
export const PROD_RAW_RESCUE_FLOOR = 12;

/**
 * 闸门门槛的运行时覆盖：`WEB_SEARCH_RESCUE_FLOOR=<n>`（默认 12）。
 *
 * 为什么要留这个口子（2026-09-21 定的）：12 是**标定值**不是推导值，而它的证据里
 * 「12 优于 10」实际只由**一条**查询支撑（raw 分布双峰、中间只有 1 条），属脆弱结论。
 * 与其让人为了试一个数字去改代码（改完还得跑全套测试），不如给它一个运行时可调的口子 ——
 * 与既有的 `BOCHA_FRESHNESS` / `EVAL_NO_CACHE` / `GATE_PROVIDER` / `WEB_SEARCH_NO_REGISTRY`
 * 同一套做法。
 *
 * ⚠️ 方向别搞反（这条比"保守"两个字更容易误判）：门槛**调低 = 触发得更少**。
 * `raw.length < n` 是严格小于，所以 n=10 时恰好把 raw=10 那条排除掉。
 * 而实测的中文失败形态（sogou 反爬后只剩 2 路、raw 掉到 5~10）正落在
 * 「被 12 覆盖、被 10 排除」的区间 —— 那恰恰是最该抢救的场景。
 * 所以「调低门槛」不是更保守，而是**在最需要抢救的区间上关掉抢救**。
 * 真要更保守，应该是调**高**（更少抢救）；调低只在"API 结果确实在稀释好结果"时才合理。
 *
 * 非法值（非整数 / <1）一律静默回退到默认值，不抛 —— 这个函数在每次搜索的热路径上。
 */
export function rescueFloor() {
  const raw = process.env.WEB_SEARCH_RESCUE_FLOOR;
  if (raw === undefined || raw === "") return PROD_RAW_RESCUE_FLOOR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : PROD_RAW_RESCUE_FLOOR;
}

// ── 引擎可信度常量（方案 2.3；2026-09 精度优化：新增 sogou 国内直连中文链） ──
// 2026-09-12 新增 baiduMobile / so360（桌面百度恒墙、sogou 常限流时的实际可用中文源）
export const ENGINE_WEIGHT = {
  intlBing: 1.0, sogou: 0.95, sogouWeixin: 0.95, ddgs: 0.95, cnBing: 0.9, bing: 0.9,
  baiduMobile: 0.9, baidu: 0.85, so360: 0.8,
  // 搜索 API（tavily/bocha/zhipu）：语义上是**权威、无抓取噪声**的一路，
  // 与 so360 那种"被降权的抓取源"完全不是一类，故给与 intlBing 同档的 1.0。
  //
  // 2026-09-21 补这三个条目：原先它们**不在表里**，于是四处 `|| 0.8` 兜底把它们当最低档处理。
  // 影响面已核实**仅限** `rankMode === "legacy"`（`EVAL_RANK_MODE=legacy` 的控制变量对比）：
  //   · 生产用 `rankMode: "rrf"` 且 `engineWeightedRrf: false` → 此处权重根本不参与打分；
  //   · 但 legacy 路径下 `weight` 直接进 `finalScore`，API 结果会被压到与 so360 同级。
  // 属于"平时看不出来、一到对比就悄悄失真"的那类问题，故显式补上。
  tavily: 1.0, bocha: 1.0, zhipu: 1.0,
};

// 移动端 UA：m.baidu.com 用桌面 UA 会退化/被墙，实测移动 UA 才返回完整结果
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── 缓存参数（方案 3.2） ──
const MEM_CACHE_MAX = 200;
const MEM_TTL_MS = 10 * 60 * 1000;
const DISK_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES || "360", 10) || 360) * 60 * 1000;
// 百度验证墙负缓存：2026-09 从 60s 延长到 5min（实测墙持续数分钟，60s 会反复撞墙拖慢中文链）
const BAIDU_NEGATIVE_TTL_MS = 5 * 60 * 1000;

// ── 内建兜底黑名单（不依赖下载，离线可用；方案 2.1） ──
const BUILTIN_JUNK_TLDS = [
  ".top", ".xyz", ".icu", ".info", ".club", ".online", ".site", ".shop", ".fun",
  ".work", ".live", ".buzz", ".loan", ".gdn", ".vip", ".click", ".link", ".zip",
  ".review", ".racing", ".accountant", ".stream", ".download", ".win", ".bid",
  ".party", ".trade", ".date", ".faith", ".webcam", ".email", ".monster",
  ".science", ".rest", ".cam", ".men", ".mom",
];
const BUILTIN_SHORTENER_DOMAINS = [
  "bit.ly", "tinyurl.com", "goo.gl", "t.co", "shorturl.at", "cutt.ly", "is.gd",
  "buff.ly", "ow.ly", "tiny.cc", "rebrand.ly", "s.id", "tny.im", "rb.gy",
  "0rz.tw", "shortest.link", "lnkd.in",
];
const BUILTIN_LOWER = [
  "baijiahao.baidu.com", "blog.csdn.net", "zhihu.com", "mp.weixin.qq.com",
  "toutiao.com",
];

// ── 辅助：文本 / URL ──
function sanitizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isValidUrl(string) {
  try {
    const u = new URL(string);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

export function hasCJK(s) {
  return /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/.test(String(s || ""));
}

/**
 * 查询语言判定（路由用）：连续 CJK 词块 ≥2 字 → 中文链；否则英文链。
 * 比纯 hasCJK 友好：英文查询混了个别中文字（如误混/注释）不会整条被拖进中文链。
 */
export function queryLanguage(q) {
  const s = String(q || "");
  const blocks = s.match(/[一-鿿㐀-䶿豈-﫿]{2,}/g);
  return blocks && blocks.length ? "cn" : "en";
}

/** 净化查询：trim + 折叠空白 + 去尾部标点；site:/filetype:/引号/- 算子原样保留。 */
export function cleanQuery(query) {
  let q = String(query || "").trim();
  q = q.replace(/\s+/g, " ");
  q = q.replace(/[.,;:!?。，；：！？、]+$/u, "");
  return q;
}

export function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch { return ""; }
}

/** 域归一化（site_search 用）：去协议/www/尾斜杠，无点补 .com。 */
export function normalizeDomain(domain) {
  let d = String(domain || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/^www\./, "");
  d = d.replace(/\/+$/, "");
  d = d.split(/[/?#]/)[0];
  if (!d.includes(".")) d += ".com";
  return d;
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_cid", "utm_reader", "utm_viz_id", "fbclid", "gclid",
  "gclsrc", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref",
  "referrer", "spm", "from", "source", "cmpid",
]);

/** URL 归一化（方案 2.2）：丢 scheme/www/跟踪参数/尾斜杠，返回规范串与 key。 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const params = [];
    for (const [k, v] of u.searchParams) {
      const kk = k.toLowerCase();
      if (TRACKING_PARAMS.has(kk)) continue;
      params.push(`${kk}=${v}`);
    }
    params.sort();
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    const key = `${host}|${pathname}|${params.join("&")}`;
    return { host, pathname, params: params.join("&"), fragment: u.hash, key };
  } catch {
    return { host: "", pathname: "", params: "", fragment: "", key: url };
  }
}

// ── 黑名单（运行时只读 blacklist.json，加载失败用内建兜底） ──
let _blacklist = null;
export function loadBlacklist() {
  if (_blacklist) return _blacklist;
  const fallback = {
    remove: [...BUILTIN_JUNK_TLDS, ...BUILTIN_SHORTENER_DOMAINS],
    lower: [...BUILTIN_LOWER],
  };
  try {
    const raw = fs.readFileSync(path.join(moduleDir, "blacklist.json"), "utf8");
    const parsed = JSON.parse(raw);
    _blacklist = {
      remove: Array.isArray(parsed.remove) ? parsed.remove.map(String) : fallback.remove,
      lower: Array.isArray(parsed.lower) ? parsed.lower.map(String) : fallback.lower,
    };
  } catch {
    _blacklist = fallback;
  }
  return _blacklist;
}

/** 匹配单条规则：".tld" 后缀 / "*.sub" 子域 / 裸域精确或子域。 */
function matchDomainRule(host, entry) {
  const e = String(entry || "").toLowerCase().trim();
  if (!e) return false;
  if (e.startsWith(".")) return host.endsWith(e) || host.endsWith(e.slice(1));
  if (e.startsWith("*.")) { const rest = e.slice(1); return host === rest || host.endsWith(rest); }
  return host === e || host.endsWith("." + e);
}

/** 黑名单匹配：返回 { remove, lower }。可测。 */
export function blacklistMatch(url) {
  const host = extractDomain(url);
  if (!host) return { remove: false, lower: false };
  const bl = loadBlacklist();
  for (const e of bl.remove) if (matchDomainRule(host, e)) return { remove: true, lower: false };
  for (const e of bl.lower) if (matchDomainRule(host, e)) return { remove: false, lower: true };
  return { remove: false, lower: false };
}

// ── 专用错误：百度验证墙 ──
export class BaiduWallError extends Error {
  constructor(message = "Baidu security verification wall detected") {
    super(message);
    this.name = "BaiduWallError";
    this.wall = true;
  }
}

// ── 可注入 fetch（2026-09-12）──
// 动机：解析层回归测试原本在**测试文件里重新实现**一遍选择器逻辑，测的是副本；
// 真实解析器改坏时测试照样全绿（这正是"百度改版 29/29 snippet 变空而套件 28 PASS"的根因）。
// 有了注入点，测试可喂固定 HTML **直接驱动真实的 searchXxx 函数**，改版即红。
let _fetchImpl = null;
/** 测试/离线用：替换引擎层 fetch。传 null 恢复真实网络。 */
export function __setFetchImpl(fn) { _fetchImpl = fn; }
function engineFetch(url, init) { return (_fetchImpl || fetch)(url, init); }

// ── 百度 ──
// 2026-09-12：桌面版 /s 恒被墙（实测每次 HTTP 200 + 1438 字节 + "百度安全验证"/"网络不给力"），
// 中文链改用 searchBaiduMobile（实测 2.1MB、11 条、无墙）。
// 注意：**不要把 wappass / verify.baidu 写进墙特征**——实测 m.baidu 正常页面里也含 "wappass"
// 字样（打包资源引用），写成墙特征会把可用的移动端误判为墙、白丢一个引擎。
// 只用墙页独有的中文标题/文案，且结合"解析 0 条"共同判定。
const BAIDU_WALL_RE = /百度安全验证|请输入验证码|网络不给力/;

async function resolveBaiduRedirect(url) {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });
    const loc = resp.headers.get("location");
    if (loc && isValidUrl(loc)) return loc;
  } catch {}
  try {
    const resp = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });
    const text = await resp.text();
    const m = text.match(/URL='([^']+)'/);
    if (m && isValidUrl(m[1])) return m[1];
  } catch {}
  return url;
}

/**
 * 百度搜索，带验证墙检测（方案 0 根因 #8）。
 * 过滤 mu="null" 及无法解析出合法 http(s) URL 的结果。
 * 命中验证墙 → 抛 BaiduWallError（路由层记负缓存并降级）。
 */
export async function searchBaidu(query, maxResults = 5) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8&rn=${maxResults}`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT, // 国内引擎必须直连
    headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Baidu returned HTTP ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $(".result, .c-container").each((i, el) => {
    if (results.length >= maxResults) return false;
    const h3 = $(el).find("h3");
    const a = h3.find("a");
    const title = sanitizeText(a.text() || h3.text());
    const rawUrl = a.attr("href") || "";
    // 跳过广告（tuiguang 标记）
    if ($(el).find("[data-tuiguang]").length || $(el).attr("data-tuiguang")) return;
    // mu 属性为真实 URL；字符串 "null" 表示缺失 → 丢弃该候选
    const mu = $(el).attr("mu") || "";
    let urlOut = "";
    if (mu && mu !== "null" && isValidUrl(mu)) urlOut = mu;
    else if (isValidUrl(rawUrl) && !/^https?:\/\/www\.baidu\.com\/link/i.test(rawUrl)) urlOut = rawUrl;
    else if (isValidUrl(rawUrl)) urlOut = rawUrl; // baidu 跳转链，后续统一解析
    if (!title || !urlOut || seen.has(title)) return;
    // 2026-09：过滤百度垂直聚合页（标题回显整句查询导致 coverage 虚高，实为图片/视频聚合落地页；见 baseline Q2/Q3/Q7）
    if (/百度图片|视频大全/.test(title)) return;
    if (/image\.baidu\.com|lightapp\.baidu\.com/i.test(urlOut)) return;
    seen.add(title);
    // snippet 选择器链（2026-09 修复）：百度已改版，旧的 .c-abstract/.c-span-last 全部返回空
    // （实测 29/29 条 snippet 为空）。新类名是 [class*='summary']，实测返回 165~193 字真实摘要。
    // 保留旧选择器兜底，避免百度再次改版时彻底失效。
    const snippet = sanitizeText(
      $(el).find("[class*='summary']").first().text() ||
      $(el).find(".c-abstract").text() ||
      $(el).find(".c-span-last").text() ||
      $(el).find("[class*='abstract']").text() ||
      ""
    );
    results.push({ title, url: urlOut, raw_url: rawUrl, snippet, source: "baidu" });
  });

  // 验证墙检测（方案 1.1 / 根因 #8）：命中标记，或解析不出结果且 html 极小
  const isWall = BAIDU_WALL_RE.test(html) || (results.length === 0 && html.length < 3000);
  if (isWall) throw new BaiduWallError();

  // best-effort 解析 baidu /link? 跳转链（并发，失败保留原链接）
  const needResolve = results.filter((r) => r.url && /^https?:\/\/www\.baidu\.com\/link/i.test(r.url));
  if (needResolve.length) {
    await Promise.allSettled(
      needResolve.map(async (r) => { r.url = await resolveBaiduRedirect(r.url); })
    );
  }
  return results;
}

// ── m.baidu.com（百度移动端，2026-09-12 新增） ──
/**
 * 为什么需要它：桌面版 www.baidu.com/s 对脚本请求**恒返回验证墙**
 * （实测：HTTP 200 但仅 1438 字节、0 条结果、命中 wall 标记，每查必墙），
 * 导致"中文链"名义四路实际长期只有 cn.bing 独扛（capture 实测每查询仅 5 条候选）。
 * 实测移动端 m.baidu.com/s 完全可用：2.1MB、11 条结果、无墙。
 *
 * 解析要点：结果节点是 `[tpl]` / `.c-result`，**真实 URL 不在 href 里**，
 * 而在 `data-log` 属性的 JSON 中（字段 mu）。首条实测即为官方文档
 * （developers.weixin.qq.com/minigame/dev/guide/open-ability/virtual-payment/...）。
 */
export async function searchBaiduMobile(query, maxResults = 5) {
  const url = `https://m.baidu.com/s?word=${encodeURIComponent(query)}&rn=${maxResults}`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT,
    headers: {
      "User-Agent": MOBILE_UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`BaiduMobile returned HTTP ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("[tpl], .c-result").each((i, el) => {
    if (results.length >= maxResults) return false;
    const $el = $(el);
    // 真实 URL：data-log JSON 的 mu 字段（首选），退化到节点内首个外链
    let target = "";
    const dataLog = $el.attr("data-log") || "";
    if (dataLog) {
      try { target = JSON.parse(dataLog)?.mu || ""; } catch {}
    }
    if (!target || !isValidUrl(target)) {
      const href = $el.find("a[href^='http']").first().attr("href") || "";
      if (isValidUrl(href)) target = href;
    }
    if (!isValidUrl(target)) return;
    // 过滤百度系**非内容页**域名（2026-09-12 实测明细，逐个来自真实返回）：
    //   m.baidu.com        → 结果是"知乎问答"的百度代理页（不是知乎原页，点进去是百度中转）
    //   haokan.baidu.com   → 短视频聚合，无正文
    //   baike.baidu.com    → 百科词条，对"如何接虚拟支付"这类 how-to 查询是噪声
    //   ailegal/ikan/ad/lightapp/image/recommend_list → 法律问答/看视频/广告位/推荐聚合
    // 注意：**zhidao.baidu.com 必须保留**——实测它是有效答案页；曾因把 zhidao 一起列入
    // 黑名单而过宽误杀（由 parsers.test.mjs 的"过滤不过宽"断言抓出）。
    const BAIDU_NON_CONTENT = /^(m|haokan|baike|ailegal|ikan|ad|lightapp|image|recommend_list|baijiahao)\.baidu\.com$/i;
    try { if (BAIDU_NON_CONTENT.test(new URL(target).hostname)) return; } catch { return; }

    const title = sanitizeText($el.find("h3, .c-title, [class*='title']").first().text());
    if (!title || /百度图片|视频大全|大家还在搜|相关搜索/.test(title)) return;
    const snippet = sanitizeText(
      $el.find("[class*='summary'], [class*='abstract'], .c-abstract, [class*='content']").first().text(),
    );
    const key = title;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ title, url: target, raw_url: target, snippet, source: "baiduMobile" });
  });

  // 移动端也可能被墙（阈值比桌面宽：移动页体积大，不能只看 html.length）
  if (BAIDU_WALL_RE.test(html) && results.length === 0) throw new BaiduWallError("m.baidu wall");
  if (results.length === 0) throw new Error("BaiduMobile parse yielded 0 results");
  return results;
}

// ── www.so.com（360 搜索，2026-09-12 新增） ──
/**
 * 实测可用且无墙（366KB、8 条结果、187 链接）。选择器 `li.res-list`，结构稳定：
 *   <h3 class="res-title"><a href=".../link?m=..." data-mdurl="真实URL">
 * **data-mdurl 直接就是目标 URL**，无需解析跳转链（比百度省一步）。
 * 需过滤 360 自家的 AI 卡片（ai.so.com/search/...）、图片/视频垂直（image.so.com/i?...）
 * 与广告跳转，否则会把聚合页当结果返回。
 */
export async function searchSo360(query, maxResults = 5) {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}&pn=1`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`So360 returned HTTP ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("li.res-list").each((i, el) => {
    if (results.length >= maxResults) return false;
    const $el = $(el);
    const a = $el.find("h3 a").first();
    const title = sanitizeText(a.text());
    if (!title) return;
    // data-mdurl 是真实目标；退化到 href（跳转链，后续由通用 resolve 处理）
    let target = a.attr("data-mdurl") || a.attr("href") || "";
    if (!isValidUrl(target)) return;
    // 360 自家聚合页（AI 卡片/图片/视频/问问）不是内容页
    if (/^https?:\/\/([a-z0-9-]+\.)*so\.com\//i.test(target) || /^https?:\/\/([a-z0-9-]+\.)*360\.cn\//i.test(target)) return;
    if (seen.has(title)) return;
    seen.add(title);
    const snippet = sanitizeText($el.find("[class*='res-desc'], .res-desc, p").first().text());
    results.push({ title, url: target, raw_url: target, snippet, source: "so360" });
  });

  if (results.length === 0) throw new Error("So360 parse yielded 0 results");
  return results;
}

// ── weixin.sogou.com（搜狗微信搜索：公众号文章，2026-09-12 新增） ──
/**
 * 为什么需要它：本轮 IP 被反爬标记后（百度双端恒墙、sogou 网页 403、cn.bing 降质），
 * 实测**只有这一路完全可用**（34KB、10 条、461ms、无 wall），而且它给的是公众号原生内容：
 *   "微信小程序虚拟支付向个人主体开放:安卓抽 1%,iOS 抽 12%,月限额 10 万"
 * —— 这种具体数字/政策细节，是降质后的 cn.bing 完全给不了的。
 *
 * **已知边界（不假装解决）**：列表能读，但条目的 `/link?url=...` 跳转链走 antispider 反爬
 * （实测 302 → /antispider/?from=...），**自动化拿不到真实 mp.weixin.qq.com 文章 URL**。
 * 因此返回的 url 是 sogou 跳转链（**人类浏览器能正常打开**），并标记 linkViaSogou，
 * 避免下游把它当作"可直接抓取的正文 URL"去 fetch（那会拿到验证页）。
 * 摘要本身常含答案，即使不点开也有价值。
 */
export async function searchSogouWeixin(query, maxResults = 5) {
  const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`SogouWeixin returned HTTP ${response.status}`);
  const html = await response.text();
  if (/antispider|请输入验证码/i.test(html)) throw new Error("sogou-weixin anti-spider");
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("ul.news-list li").each((i, el) => {
    if (results.length >= maxResults) return false;
    const $el = $(el);
    const a = $el.find("h3 a").first();
    const title = sanitizeText(a.text());
    const href = a.attr("href") || "";
    if (!title || !href) return;
    if (seen.has(title)) return;
    seen.add(title);
    // 摘要：.txt-info 实测就是正文开头（常含政策细节/数字）
    let snippet = sanitizeText($el.find(".txt-info").text());
    // 来源账号：在 .s-p 里（真实账号名后面紧跟内联时间脚本，需截断）
    let account = sanitizeText($el.find(".s-p a, .s-p").first().text()).replace(/document\.write.*$/i, "");
    account = account.slice(0, 40);
    if (account) snippet = `【${account}】${snippet}`;
    results.push({
      title,
      url: new URL(href, "https://weixin.sogou.com").toString(),
      raw_url: href,
      snippet: snippet.slice(0, 400),
      source: "sogouWeixin",
      linkViaSogou: true, // 供下游识别：URL 是人类浏览器可开的跳转链，不是可直接抓取的正文
    });
  });

  if (results.length === 0) throw new Error("SogouWeixin parse yielded 0 results");
  return results;
}

// ── 搜索 API 引擎（2026-09-12 新增；中文链根治方案） ──
/**
 * 为什么这是根治方案：本轮实测确认，抓 HTML 的路线会被反爬按 IP 封禁
 * （百度双端恒墙、sogou 403、cn.bing 降质），且 headless Chrome 同样被拦——
 * 而**搜索 API 返回的是 JSON 鉴权错误**（博查/智谱均为 401 JSON），即"为程序调用设计的接口"。
 *
 * 密钥来源（不进仓库）：
 *   ① 环境变量 TAVILY_API_KEY / BOCHA_API_KEY / ZHIPU_API_KEY（优先级最高，便于临时覆盖）
 *   ② 同目录 api-keys.json（已在 .gitignore；模板见 api-keys.example.json）
 *   ③ **Windows 用户注册表**里同名环境变量（仅 win32；非 Windows 静默跳过）
 * 未配置密钥时该引擎静默跳过（不报错、不降级其他引擎），因此**没 key 的系统行为完全不变**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 为什么保留 ③ 这条兜底通道 —— 不是所有宿主都会把环境变量原样传给 MCP 子进程。
 *
 * MCP 服务器的 stdio 子进程由**客户端**拉起，而部分客户端为了安全会清洗子进程环境：
 * 把名字里含 KEY / PASSWORD / SECRET / TOKEN 的变量**整个丢弃**（`TAVILY_API_KEY`
 * 正因为含 KEY 而被过滤掉）。这是有意的设计，重启客户端也不会改变。
 * 于是"在系统里设了用户级环境变量"这件事，对 MCP 进程可能**根本不生效**。
 *
 * ③ 是绕开这个死结的第二条读取路径：进程环境被清洗了，但**注册表里的用户级环境变量还在**，
 * 读它不需要任何额外文件、也不经过客户端的 env 清洗。语义上仍是"用户的用户级环境变量"，
 * 只是取数路径从 `process.env` 换成了注册表。
 *
 * 安全边界（如实说明）：这**不提升**权限——任何以该用户身份运行的进程本来就能读
 * `process.env` 或注册表；它是"不落盘"而非"不可读"。真正被消除的是**泄漏面**：
 * 不再出现在配置文件、MCP 配置的 `env` 字段、以及任何会被传给子进程的环境快照里。
 * 另有更通用的等价做法：`api-keys.json`（本机文件）或 MCP 配置里的显式 `env` 字段。
 *
 * 关闭方式：设 `WEB_SEARCH_NO_REGISTRY=1`（测试用；`gate.test.mjs` 的密封场景必须关，
 * 否则注册表里的真 key 会击穿它的密封）。
 * 非 Windows 平台静默跳过（`reg.exe` 不存在时 `spawnSync` 返回错误，不抛）。
 */
let _registryFallback = true;
let _registryReader = null;
/** 测试/运维用：关闭或恢复注册表回退（返回旧值，便于测试还原）。 */
export function __setRegistryFallback(on) {
  const prev = _registryFallback;
  _registryFallback = Boolean(on);
  _apiKeys = null;
  return prev;
}
/**
 * 测试钩子：注入一个假的注册表读取器（返回旧值，便于还原）。
 *
 * 为什么需要它：注册表回退的分支若只能靠"本机是否恰好配了 key"来触发，
 * 那么这套逻辑在**没配 key 的机器上永远不被执行也不被覆盖**——
 * 而它恰恰是 key 能否到达 MCP 进程的**唯一通道**，属于最不能悄悄坏掉的一段。
 * 注入假读取器后，优先级（env > 文件 > 注册表）与开关行为都能确定性断言，
 * 且套件保持**机器无关**（不读真实注册表）。
 */
export function __setRegistryReader(fn) {
  const prev = _registryReader;
  _registryReader = typeof fn === "function" ? fn : null;
  _apiKeys = null;
  return prev;
}

/**
 * 从 Windows 用户级注册表读一个环境变量；读不到返回 ""。绝不抛。
 *
 * ⚠️ 编码坑（2026-09-21 实测）：`reg.exe` 的 stdout 是 **UTF-8**，不是 UTF-16LE。
 * 我原先按"Windows 原生命令输出 UTF-16LE"的成见写 `toString("utf16le")`，
 * 结果解出满屏 CJK 乱码（"਍䭈奅..."）、正则永不命中、回退静默失效。
 * 现在**不赌单一编码**：取原始 buffer，两种解码都试，谁命中用谁。
 *
 * ⚠️ 注入的读取器也必须包在 try 里（2026-09-21）：原先把 `_registryReader` 调用
 * 放在 try **之前**，于是测试里"读取器抛错"会直接逃到 `loadApiKeys()` 调用方，
 * 与真实的 `reg.exe` 失败路径行为不一致（真实路径被 catch 兜住 → 当成"没读不到"）。
 */
function readUserEnvFromRegistry(name) {
  if (!_registryFallback) return "";
  if (process.env.WEB_SEARCH_NO_REGISTRY) return "";
  try {
    if (_registryReader) return String(_registryReader(name) ?? "").trim();
    if (process.platform !== "win32") return "";
    // 不用 shell，避免引号/注入问题
    const r = spawnSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "buffer",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0 || !r.stdout) return "";
    const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout), "utf8");
    for (const enc of ["utf8", "utf16le"]) {
      const m = buf.toString(enc).match(/REG_SZ\s+([^\r\n]+)/);
      if (m && m[1].trim()) return m[1].trim();
    }
    return "";
  } catch { return ""; }
}

function loadApiKeys() {
  if (_apiKeys !== null) return _apiKeys;
  const merged = {};
  // 顺序敏感：`merged` 是**后赋值覆盖先赋值**，所以**环境变量放最后才能压过文件**
  // （2026-09-21 复核：本注释原写"所以文件放最前、环境变量放最后"——结论对，但把归因说反了，
  //   "放最后"的理由是"后赋值覆盖先赋值"，不是"文件优先"。下面的数组顺序照旧不动。）
  // （2026-09-12 修正：原实现把 env 放最前、文件放最后，导致文件覆盖 env，
  //   与上方注释"环境变量优先级最高，便于临时覆盖"相反——实测踩到。）
  //
  // 2026-09-21：注册表作为**兜底**追加在最后，但只在该 provider 的进程环境变量
  // **缺失**时取值 —— 否则若直接 `Object.assign` 会让"文件里配的 key"被注册表
  // 覆盖（文件优先级反而变低）。用 `??` 逐字段兜底，保持"env > 文件 > 注册表"。
  const fileKeys = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(moduleDir, "api-keys.json"), "utf8"));
    } catch { return null; }
  })();
  const sources = [
    fileKeys,
    process.env.TAVILY_API_KEY ? { tavily: process.env.TAVILY_API_KEY } : null,
    process.env.BOCHA_API_KEY ? { bocha: process.env.BOCHA_API_KEY } : null,
    process.env.ZHIPU_API_KEY ? { zhipu: process.env.ZHIPU_API_KEY } : null,
  ];
  for (const c of sources) if (c) Object.assign(merged, c);
  // 注册表兜底（逐 provider，仅在上述都没给值时）
  for (const [key, envName] of [["tavily", "TAVILY_API_KEY"], ["bocha", "BOCHA_API_KEY"], ["zhipu", "ZHIPU_API_KEY"]]) {
    const cur = String(merged[key] ?? "").trim();
    if (!cur || cur.startsWith("_")) {
      const reg = readUserEnvFromRegistry(envName);
      if (reg) merged[key] = reg;
    }
  }
  // 过滤空值/占位值：api-keys.json 模板里是 ""，"" 是 truthy 会导致误判"已配置"（实测踩过）
  _apiKeys = {};
  for (const [k, v] of Object.entries(merged)) {
    const s = String(v ?? "").trim();
    if (s && !s.startsWith("_")) _apiKeys[k] = s;
  }
  return _apiKeys;
}
let _apiKeys = null;
/** 测试/诊断用：强制重载密钥（改完 api-keys.json 无需重启即可生效）。 */
export function __reloadApiKeys() { _apiKeys = null; return loadApiKeys(); }
/** 当前是否有可用的搜索 API 密钥（供健康度/诊断显示）。 */
export function apiEngineAvailable() {
  const k = loadApiKeys();
  return Boolean(k.tavily || k.bocha || k.zhipu);
}

/**
 * 解析博查 API 响应（**纯函数，单独导出以便离线测试真实解析器**）。
 *
 * 契约（2026-09-21 以**官方 SDK 源码**为准，不再靠猜）：
 *   BochaAI/bocha-search-mcp → src/bocha_search_mcp/server.py
 *     66:  endpoint = "https://api.bochaai.com/v1/web-search?utm_source=bocha-mcp-local"
 *     69:  payload = { "query": query, "summary": True, "freshness": freshness, "count": count }
 *     88:  resp = response.json();  if "data" not in resp: → "Search error."
 *     97:  for result in data["webPages"]["value"]:
 *     99-103: 读取 result['name'] / ['url'] / ['summary'] / ['datePublished'] / ['siteName']
 *
 * ⚠️ 关键：响应**确实有 `data` 包装层**（第 88 行显式检查 `"data" not in resp`，
 *    第 97 行的 `data` 是 `resp["data"]`）。而官方首页 "API 响应内容" 示例写的是顶层
 *    `webPages` —— 那是**站点展示用的简写、不是真实回包**。
 *    本函数因此**以 `data.webPages.value` 为主**，同时容错顶层形态。
 *
 * 纠错记录（值得记住，因为踩了两次、方向还相反）：
 *   ① 原实现只认 `json.data.webPages.value` → 本来就是对的；
 *   ② 我一度依据首页示例改判为"顶层才对"，把顶层设为主路径 —— **判反了**；
 *   ③ 拿到官方 SDK 源码后确认 ① 正确。所幸两轮都保留了"两种形态都认"的容错，
 *      所以无论哪种都不会抛错；但**顺序**必须按已证实的来，否则报错归因会误导。
 *   教训：官方首页的响应示例可能是简写；**SDK 源码才是契约**。
 */
export function parseBochaResponse(json, maxResults = 5) {
  // data.webPages 为主（已由官方 SDK 证实），顶层 webPages 作为容错。
  const list = json?.data?.webPages?.value ?? json?.webPages?.value;
  if (!Array.isArray(list)) {
    const code = json?.code ?? json?.status;
    const detail = json?.message || json?.msg || json?.error?.message || "-";
    // 鉴权/限速类错误**必须与"契约变更"区分开**：否则会去改解析器而不是换 key（实测踩过）
    const hint = isAuthError(code) || /unauthorized|invalid.*key|api.?key|quota|rate.?limit/i.test(String(detail))
      ? "（疑似密钥无效/额度用尽/限速 —— 请检查 api-keys.json 的 bocha，或环境变量 BOCHA_API_KEY；申请：https://open.bochaai.com）"
      : "（响应结构不符，可能是官方契约变更；官方契约见 BochaAI/bocha-search-mcp 的 server.py）";
    throw new Error(`Bocha response shape unexpected (code=${code}, message=${detail}) ${hint}`);
  }
  return list
    .map((x) => ({
      title: sanitizeText(x?.name || x?.title || ""),
      url: String(x?.url || ""),
      // summary 是长摘要（官方把 summary 当 Description 用），比 snippet 信息量大，优先取
      snippet: sanitizeText(x?.summary || x?.snippet || "").slice(0, 500),
      source: "bocha",
      datePublished: x?.datePublished || x?.dateLastCrawled || undefined,
      // siteName 是站点名（如"阿里巴巴集团"），比 hostname 可读，官方也在输出里展示它
      siteName: x?.siteName || undefined,
    }))
    .filter((x) => x.title && isValidUrl(x.url))
    .slice(0, maxResults);
}

/**
 * 解析智谱 web_search 响应（纯函数）。
 * 契约已对官方文档核实（2026-09-20，docs.bigmodel.cn/cn/guide/tools/web-search 的响应示例）：
 *   { created, id, request_id, search_intent:[{intent,keywords,query}],
 *     search_result:[{ content, icon, link, media, publish_date, refer, title }] }
 * 注意标题字段是 `title`（不是 name）、URL 字段是 `link`（不是 url）——与博查不同，勿混。
 */
export function parseZhipuResponse(json, maxResults = 5) {
  const list = json?.search_result ?? json?.data?.search_result;
  if (!Array.isArray(list)) {
    const code = json?.error?.code ?? json?.code;
    const detail = json?.error?.message || json?.message || "-";
    const hint = isAuthError(code) || /unauthorized|invalid.*key|api.?key|quota|余额|限流|频率/i.test(String(detail))
      ? "（疑似密钥无效/额度用尽/限速 —— 请检查 api-keys.json 的 zhipu，或环境变量 ZHIPU_API_KEY；申请：https://open.bigmodel.cn）"
      : "（响应结构不符，可能是官方契约变更）";
    throw new Error(`Zhipu response shape unexpected (code=${code}, message=${detail}) ${hint}`);
  }
  return list
    .map((x) => ({
      title: sanitizeText(x?.title || ""),
      url: String(x?.link || x?.url || ""),
      snippet: sanitizeText(x?.content || x?.snippet || "").slice(0, 500),
      source: "zhipu",
      // media 是站点名（如"搜狐"），比 hostname 更可读，附在 source 里便于人眼辨认
      datePublished: x?.publish_date || undefined,
      siteName: x?.media || undefined,
    }))
    .filter((x) => x.title && isValidUrl(x.url))
    .slice(0, maxResults);
}

/**
 * 解析 Tavily 响应（纯函数）。
 * 契约（docs.tavily.com/documentation/api-reference/endpoint/search）：
 *   { query, results:[{ title, url, content, score, published_date? }], response_time }
 * `content` 是**正文片段**（比普通搜索的 snippet 长），对"从搜索结果直接得到答案"很有价值。
 */
export function parseTavilyResponse(json, maxResults = 5) {
  const list = json?.results;
  if (!Array.isArray(list)) {
    throw new Error(`Tavily response shape unexpected (keys=${Object.keys(json || {}).join(",") || "none"})`);
  }
  return list
    .map((x) => ({
      title: sanitizeText(x?.title || ""),
      url: String(x?.url || ""),
      snippet: sanitizeText(x?.content || x?.raw_content || "").slice(0, 800),
      source: "tavily",
      datePublished: x?.published_date || undefined,
      apiScore: typeof x?.score === "number" ? x.score : undefined,
    }))
    .filter((x) => x.title && isValidUrl(x.url))
    .slice(0, maxResults);
}

/**
 * 搜索 API 统一入口。provider 优先级：tavily > bocha > zhipu。
 *
 * ⚠️ 「优先级」是**首个配置了密钥的胜出**，不是"结果更好"的排序（见下方 searchApi 实现）。
 * 想切换引擎就把更高优先级的 key 清空，而不是改这里。
 *
 * 按 2026-09-20 核实的官方现价，**只比单价时与代码优先级相反**：
 *   智谱 search_std 0.01 元/次（10 元/千次，境内直连、专为中文/大模型设计）＜
 *   博查 0.036 元/次（36 元/千次）＜ Tavily $0.0075/credit（月付档；散买 $0.008。1000 credit = $7.50 ≈ 54 元，
 *   按 ~7.2 汇率）——⚠️ 本行原写"≈38 元/千次"是算错的，1000×$0.0075 反推需要汇率 5.07，2026-09-21 复核修正。
 * 但**不能只看单价**（2026-09-21 复核修正，原结论"故配了智谱 key 的用户应把 tavily/bocha 清空"已被推翻）：
 *   Tavily **每账号每月 1000 credit 免费、无需信用卡、多账号可叠加**（basic search = 1 credit）→
 *   **免费额度内实际成本 0 元**；智谱需先充值。且智谱中文结果明显强于 Tavily
 *   （Tavily 为"喂 RAG 正文"排序，偏在题但非权威）。
 * → 取舍：**用不完 1000 credit/月 就留 Tavily（等于免费）**；月用量远超免费额度、且更看重中文质量时再换智谱。
 *   ⚠️ 智谱那两个数（0.01 元/次、"无免费额度需先充值"）本轮**未能核实**（官方计费页检索零结果，见 CHANGELOG §零之七），
 *   换家前请自己确认一次。
 *
 * 为什么原本首选 Tavily（2026-09-12 实测）：
 *   - **直连与代理均可**：直连 401 鉴权错误（1.9~7.3s），经本地代理 376~960ms；实测两种
 *     方式的**返回结果完全一致**（证明结果与本机 IP 无关），故有代理时优先走代理（更快）。
 *   - 提供**每月 1000 次免费额度**（官方文档原文："1,000 free API Credits every month.
 *     No credit card required."，basic search = 1 credit/次），符合"零成本"要求。
 *   - 返回结构化 JSON（含**正文片段 content**，实测 683~1492 字，远长于普通搜索摘要），
 *     不受本机 IP 反爬标记影响。
 *
 * 历史纠错（避免重复误判）：本注释曾写"Brave / Jina Reader / SearXNG 公共实例实测全部超时被墙"。
 * 2026-09-12 复测纠正：**那是直连测试**。经本地代理实测 Brave 422 / Jina Reader 200 / Google 200
 * **均可达**；SearXNG 公共实例则确实不可用（searx.be 关 JSON、searxng.site 403、priv.au 429）。
 * 结论："需要代理"只是多一个依赖，**不等于**数据质量差；国际索引对中文技术查询往往强于国内站。
 */
/**
 * 判断某个引擎的 HTTP 错误是否属于**鉴权/限速**类（而非响应契约变更）。
 * 为什么要区分（2026-09-08 实测踩坑）：密钥失效时此前会落到"response shape unexpected"
 * ——断言错误直接掩盖调用错误，看到的人会去改解析器而不是换 key。
 * 故 401/403/429 必须单独识别并给出直白提示（附官方取 key 地址）。
 */
function isAuthError(status) {
  return status === 401 || status === 403 || status === 429;
}

/**
 * API 专用 fetch：**先按默认 dispatcher（通常已配好本地代理，更快），失败则强制直连重试**。
 *
 * 为什么必须这样（2026-09-12 实测事故）：本地代理进程活着、端口仍在监听，但上游节点已断——
 * 此时全局 ProxyAgent 会让 `searchApi` 与 `intlBing` **同时** `fetch failed`，
 * 于是"抢救引擎"自己先死了，恰恰在最需要它的时候失效（实测 3 个代理依赖用例全部失败，
 * 而直连的 cnBing 正常）。修复依据：Tavily **直连与代理返回结果完全一致**（证明与本机 IP 无关），
 * 仅速度有别（代理 376~960ms vs 直连 1.9~7.3s）→ 代理优先、直连兜底是**纯增益**。
 * 附带收益：代理挂掉时英文链主路（intlBing）失效，此时 API 直连兜底仍能提供结果。
 * 注：测试注入的 `__setFetchImpl` 会忽略 dispatcher，不影响离线用例。
 */
async function apiFetch(url, init = {}) {
  try {
    return await engineFetch(url, init);
  } catch (e) {
    if (init.dispatcher === DIRECT_AGENT) throw e;
    console.error(`[search-core] API via default dispatcher failed (${e?.message || e}); retry direct`);
    return await engineFetch(url, { ...init, dispatcher: DIRECT_AGENT });
  }
}

export async function searchApi(query, maxResults = 5) {
  const keys = loadApiKeys();
  if (keys.tavily) {
    const resp = await apiFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.tavily}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_depth: "basic",     // basic 省额度（advanced 更贵/更慢，额度紧张时不必）
        max_results: Math.max(maxResults, 5),
        include_answer: false,     // 我们只要来源列表，不要它生成的答案
        include_raw_content: false,
        include_published_date: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = json?.detail?.error || json?.detail || json?.message || "unknown";
      throw new Error(`Tavily HTTP ${resp.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 120)}`);
    }
    return parseTavilyResponse(json, maxResults);
  }
  if (keys.bocha) {
    // 端点与查询串按官方 SDK 源码（BochaAI/bocha-search-mcp server.py:66）保持一致，
    // 带 `utm_source` 便于官方统计来源；不带也不影响功能。
    const resp = await apiFetch("https://api.bochaai.com/v1/web-search?utm_source=web-search-mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.bocha}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        // count 官方范围 1–50（SDK 文档串写明），默认 10。必须夹紧，越界会 400。
        count: Math.min(Math.max(Number(maxResults) || 5, 1), 50),
        summary: true,           // 要长摘要：官方把 summary 当 Description 用，且按"次"计费，不要等于浪费
        // 时间范围默认**跟随官方 SDK 的 noLimit**（不是 oneYear）。
        // 理由：老页面对"查规范/查历史"有价值，oneYear 会把它们整片滤掉——
        // 那是**静默的质量损失**，比多几条噪音更糟。要收窄时用环境变量显式指定，
        // 可选 noLimit/oneYear/oneMonth/oneWeek/oneDay 或 YYYY-MM-DD[..YYYY-MM-DD]。
        freshness: process.env.BOCHA_FRESHNESS || "noLimit",
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`Bocha HTTP ${resp.status}: ${json?.message || json?.msg || "unknown"}`);
    return parseBochaResponse(json, maxResults);
  }
  if (keys.zhipu) {
    const resp = await apiFetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.zhipu}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        search_engine: "search_std",  // 最便宜档：0.01 元/次（search_pro 0.03、search_pro_sogou 0.05）
        search_query: query,
        // count 必传：官方**默认 10 条**，而我们通常只要 5 条 → 不传等于每次多解析一倍数据。
        // 注意官方范围是 1–50，必须夹紧，否则 400。
        count: Math.min(Math.max(Number(maxResults) || 5, 1), 50),
        // 按"次"计费，摘要加长不额外收费；而 snippet 最终截 500 字，
        // 故 high 只用于提高"截断前就有干货"的概率，不会让返回变臃肿（无匹配时官方回落到 medium）。
        content_size: "high",
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`Zhipu HTTP ${resp.status}: ${json?.error?.message || "unknown"}`);
    return parseZhipuResponse(json, maxResults);
  }
  return []; // 未配置密钥：静默跳过（系统行为与无此引擎完全一致）
}

// ── cn.bing.com（国内直连，返回直接 URL，中文质量高） ──
export async function searchCnBing(query, maxResults = 5) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT, // 国内引擎必须直连：经代理会返回空页（见 DIRECT_AGENT 注释）
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`cn.bing returned HTTP ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  $(".b_algo").each((i, el) => {
    if (results.length >= maxResults) return false;
    const h2 = $(el).find("h2");
    const a = h2.find("a");
    const title = sanitizeText(a.text() || h2.text());
    const href = a.attr("href") || "";
    if (!title || !isValidUrl(href)) return;
    const snippet = sanitizeText($(el).find(".b_caption p").text());
    results.push({ title, url: href, snippet, source: "cnBing" });
  });
  return results;
}

// ── sogou.com（国内直连，中文质量高；2026-09 新增：百度墙 + cn.bing 单字匹配兜底） ──
// 实测：长中文查询 "微信小程序 虚拟支付 个人主体" sogou 首条即 "个人小程序也能开虚拟支付了,条件就3个"（mp.weixin.qq.com），
// 而同期 cn.bing 全是 "微" 单字匹配垃圾。解析要点：.vrwrap > h3 a；/link?url= 加密链用同块 [data-url] 还原真实 URL。
// 限流退避：命中反爬墙（小页面无 vrwrap）后全局熔断 5min，期间直接抛错由路由层降级，避免连续撞墙。
let sogouWallUntil = 0;
export async function searchSogou(query, maxResults = 5) {
  if (Date.now() < sogouWallUntil) throw new Error("sogou wall backoff");
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const response = await engineFetch(url, {
    dispatcher: DIRECT_AGENT, // 国内引擎必须直连
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`sogou returned HTTP ${response.status}`);
  const html = await response.text();
  if (/访问过于频繁|验证码|防爬/i.test(html.slice(0, 5000)) || (html.length < 20000 && !html.includes("vrwrap"))) {
    sogouWallUntil = Date.now() + 5 * 60 * 1000;
    throw new Error("sogou anti-spider");
  }
  const $ = cheerio.load(html);
  const results = [];
  $(".vrwrap").each((i, el) => {
    if (results.length >= maxResults) return false;
    const h3 = $(el).find("h3").first();
    const a = h3.find("a").first();
    const title = sanitizeText(a.text() || h3.text());
    if (!title) return; // 跳过 "大家还在搜" 等无标题噪音块
    let href = (a.attr("href") || "").trim();
    let urlOut = "";
    if (href && isValidUrl(href)) urlOut = href;
    else {
      // sogou /link?url= 加密：同块 [data-url] 即真实 URL（实测 developers.weixin.qq.com / kf.qq.com 均可还原）
      const dataUrl = ($(el).find("[data-url]").attr("data-url") || "").trim();
      if (dataUrl && isValidUrl(dataUrl)) urlOut = dataUrl;
      else if (href && href.startsWith("/") && dataUrl) urlOut = dataUrl;
      else return;
    }
    const snippet = sanitizeText(
      $(el).find(".fz-mid, .space-txt, .str_info, .c-abstract").first().text() || ""
    );
    results.push({ title, url: urlOut, snippet, source: "sogou" });
  });
  return results;
}

// ── www.bing.com 国际版（setlang=en&cc=US；u=a1 解码） ──
// 不依赖全局 PROXY：国际引擎必须显式拿代理 dispatcher，才能与国内引擎的直连 dispatcher 并存。
// 优先级：INTL_BING_PROXY > HTTP_PROXY > HTTPS_PROXY > 直连。
// 不硬编码任何本地代理端口 —— 未配置代理时返回 null，调用方按直连发起
// （国内网络环境下国际引擎会连不通，属预期：README 里说明了要配 INTL_BING_PROXY）。
let _intlProxyAgent = null;
function getIntlProxyAgent() {
  if (_intlProxyAgent) return _intlProxyAgent;
  const proxy =
    process.env.INTL_BING_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
  if (!proxy) return null;
  try { _intlProxyAgent = new ProxyAgent(proxy); }
  catch (e) { console.error(`[search-core] intlBing proxy init failed: ${e.message}`); }
  return _intlProxyAgent;
}

export async function searchIntlBing(query, maxResults = 5) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&cc=US&count=${maxResults}`;
  const agent = getIntlProxyAgent();
  const response = await engineFetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
    ...(agent ? { dispatcher: agent } : {}),
  });
  if (!response.ok) throw new Error(`intlBing returned HTTP ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const results = [];
  $(".b_algo").each((i, el) => {
    if (results.length >= maxResults) return false;
    const h2 = $(el).find("h2");
    const a = h2.find("a");
    const title = sanitizeText(a.text() || h2.text());
    const href = a.attr("href") || "";
    const decoded = decodeBingRedirect(href);
    if (!title || !isValidUrl(decoded)) return;
    const snippet = sanitizeText($(el).find(".b_caption p").text());
    results.push({ title, url: decoded, snippet, source: "intlBing" });
  });
  return results;
}

/**
 * 解 Bing u=a1 重定向（方案 0 根因 #7）：取 u 参数 → 去 "a1" 前缀 →
 * base64 → 真实 URL。失败原样返回原 href（不丢结果）。单独导出，便于复用与单测。
 */
export function decodeBingRedirect(href) {
  try {
    const u = new URL(href, "https://www.bing.com");
    const raw = u.searchParams.get("u");
    if (!raw) return href;
    let b64 = raw;
    if (b64.startsWith("a1")) b64 = b64.slice(2);
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  return href;
}

// ── ddgs（Python 子进程桥，代理） ──
/**
 * 解析 ddgs 用的 Python 解释器，按优先级：
 *   ① DDGS_PYTHON 环境变量（指向任意解释器，最通用）
 *   ② 项目内虚拟环境 .venv-ddg（按平台取 Scripts/python.exe 或 bin/python）
 *   ③ 裸 "python3" / "python"（交给 PATH；Windows 上是 py 启动器语义）
 * 找不到时由调用方处理：spawn 失败 → 该引擎静默跳过，不影响其它引擎。
 */
function pythonPath() {
  if (process.env.DDGS_PYTHON) return process.env.DDGS_PYTHON;
  const bin = process.platform === "win32"
    ? path.join("Scripts", "python.exe")
    : path.join("bin", "python");
  return path.join(moduleDir, ".venv-ddg", bin);
}
function pythonFallback() {
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * spawn ddgs_search.py。python/ddgs 缺失或出错 → 返回 []（静默跳过，方案 8.2）。
 */
export function searchDdgs(query, maxResults = 5) {
  return new Promise((resolve) => {
    const script = path.join(moduleDir, "ddgs_search.py");
    if (!fs.existsSync(script)) { resolve([]); return; }
    const py = fs.existsSync(pythonPath()) ? pythonPath() : pythonFallback();
    const child = spawn(py, [script, query, String(Math.max(1, maxResults))], {
      windowsHide: true,
      timeout: 45000,
      env: {
        ...process.env,
        DDGS_PROXY: process.env.DDGS_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        if (Array.isArray(parsed)) {
          resolve(parsed.map((r) => ({ ...r, source: "ddgs" })));
          return;
        }
      } catch {}
      if (err) console.error(`[search-core] ddgs stderr: ${String(err).slice(0, 300)}`);
      resolve([]);
    });
  });
}

// ── 缓存（方案 3.2） ──
const memCache = new Map();
const negCache = new Map(); // 百度负缓存 query -> expireAt
const stats = { memHits: 0, diskHits: 0, sets: 0 };

function hashQuery(q) { return crypto.createHash("sha1").update(q).digest("hex"); }

// 磁盘缓存：懒初始化（首次搜索时才开 sqlite），避免 MCP 启动被文件锁/慢盘拖累导致"未注册"。
// busy_timeout 短值：并发进程（多窗口）抢同一 sqlite 时快速失败降级为纯内存缓存，绝不卡死启动。
let db = null;
let diskInitAttempted = false;

function initDiskCache() {
  if (diskInitAttempted) return;
  diskInitAttempted = true;
  try {
    const d = new DatabaseSync(path.join(moduleDir, "search_cache.sqlite"));
    d.exec("PRAGMA busy_timeout = 1500");
    d.exec("CREATE TABLE IF NOT EXISTS cache (query_hash TEXT PRIMARY KEY, results TEXT, engine TEXT, created_at INTEGER)");
    db = d;
  } catch (e) {
    console.error(`[search-core] sqlite init failed (memory-only cache): ${e.message}`);
    db = null;
  }
}

function cacheGet(query) {
  const hit = memCache.get(query);
  if (hit) {
    if (hit.expire > Date.now()) { stats.memHits++; return hit.results; }
    memCache.delete(query);
  }
  initDiskCache();
  if (db) {
    try {
      const row = db.prepare("SELECT results, created_at FROM cache WHERE query_hash = ?").get(hashQuery(query));
      if (row) {
        const age = Date.now() - row.created_at;
        if (age <= DISK_TTL_MS) {
          const parsed = JSON.parse(row.results);
          if (Array.isArray(parsed)) {
            stats.diskHits++;
            memCache.set(query, { expire: Date.now() + MEM_TTL_MS, results: parsed });
            return parsed;
          }
        }
      }
    } catch {}
  }
  return null;
}

function cacheSet(query, results) {
  stats.sets++;
  memCache.set(query, { expire: Date.now() + MEM_TTL_MS, results });
  if (memCache.size > MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  initDiskCache();
  if (db) {
    try {
      db.prepare("INSERT OR REPLACE INTO cache (query_hash, results, engine, created_at) VALUES (?, ?, ?, ?)")
        .run(hashQuery(query), JSON.stringify(results), "mixed", Date.now());
    } catch (e) {
      console.error(`[search-core] disk cache write failed: ${e.message}`);
    }
  }
}

function setBaiduNegative(query) { negCache.set(query, Date.now() + BAIDU_NEGATIVE_TTL_MS); }
function isBaiduNegative(query) {
  const expire = negCache.get(query);
  if (!expire) return false;
  if (expire < Date.now()) { negCache.delete(query); return false; }
  return true;
}

/** 测试诊断用。 */
export function __cacheStats() {
  return { ...stats, memSize: memCache.size, negSize: negCache.size };
}

// ── 质量管线（方案 2） ──
function splitSources(src) {
  return String(src || "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}
function mergeSources(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}
function jaccardTokens(a, b) {
  const toks = (s) => new Set((String(s || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / new Set([...ta, ...tb]).size;
}

// ── 中文感知词项覆盖（2026-09 精度优化核心） ──
// 背景：MiniSearch 默认按空白分词，中文长查询 BM25 全 0，只能靠引擎原序 → cn.bing 单字垃圾排前面。
// 解法：latin 词 + CJK 二元组 substring 覆盖率，直接衡量"查询词在标题+摘要出现了多少"。
export function extractQueryTerms(q) {
  const s = String(q || "");
  const terms = new Set();
  // latin / 数字词（≥2 字符；纯数字串如时间戳/随机后缀不计——永不命中，只会拉低覆盖率）
  for (const w of (s.toLowerCase().match(/[a-z0-9]+/g) || [])) {
    if (w.length >= 2 && !/^[0-9]+$/.test(w)) terms.add(w);
  }
  // CJK 二元组：连续 CJK 片段切 overlapping 2-gram（"微信小程序" → 微信/信小/小程序）
  const cjkSeqs = s.match(/[一-鿿㐀-䶿豈-﫿]{2,}/g) || [];
  for (const seq of cjkSeqs) {
    for (let i = 0; i < seq.length - 1; i++) terms.add(seq.slice(i, i + 2));
  }
  return [...terms];
}

export function termCoverage(query, title, snippet) {
  const terms = extractQueryTerms(query);
  if (!terms.length) return 1; // 纯符号查询不过滤
  const text = `${title || ""} ${snippet || ""}`.toLowerCase();
  let hit = 0;
  for (const t of terms) if (text.includes(t.toLowerCase())) hit++;
  return hit / terms.length;
}

// ── 排序配置（2026-09 精度重构） ──
// 背景：原排序是 score = 0.5*coverage + 0.25*bm25 + 0.25*positionWeight - 0.3*lower，
// 其中 positionWeight 取 min(indexes)（在拼接列表里的最好位次），导致
// "1 个引擎排第 1" 赢过 "5 个引擎都排第 3" —— 多引擎共识被系统性低估。
// 改为 RRF（Reciprocal Rank Fusion, Cormack et al. SIGIR 2009）：Σ 1/(k+rank_i)，
// 天然奖励跨引擎共识。权重经 eval 评估集网格搜索确定，不拍脑袋。
export let RANK_CONFIG = {
  rankMode: "rrf",       // "rrf"（生产）| "legacy"（复刻旧公式，仅评估对比用）
  rrfK: 20,              // RRF 平滑常数（评估集实测 k=20~100 无差异，取 20）
  wRrf: 1.00,            // 跨引擎共识（评估集实测：纯 RRF 最优，见 eval/tune-baseline.json）
  wCoverage: 0.00,       // 查询词覆盖率（实测加入后反而拉低 nDCG，因单引擎池中它只是复述引擎序）
  wBm25: 0.00,           // 中文因无空格分词恒 0；英文由 RRF 承载
  engineWeightedRrf: false, // 实测按 ENGINE_WEIGHT 加权反而变差（权重噪声 > 收益）
  engineQualityPower: 0,    // 引擎内在题率加权指数（0=关闭；实验项，见 rrfScore 注释）
  lowerPenalty: 0.15,    // 黑名单 lower 域降权
  echoPenalty: 0.40,     // 回显垃圾惩罚（评估集无此类样本，属安全网，见 eval/echo.test.mjs）
  echoRatio: 0.8,        // 标题覆盖率达到此值 + 含泛化词 → 判为回显
  // 覆盖率地板（不是排序权重，是"最低相关度门槛"）：
  // 纯 RRF 不看覆盖率，会让"在某引擎排第 1 但内容泛"的站点首页上位
  // （实测 "微信小程序 虚拟支付" → weixin.qq.com 首页 coverage 仅 0.14 却排第 1）。
  // 仅当池中已有高覆盖结果（best≥covBestGate）时才启用，避免整批都低覆盖时误删。
  covFloor: 0.12,        // 丢弃 coverage 低于此值的结果
  covBestGate: 0.40,     // 池中 best coverage 达到此值才启动地板

  // ── 权威源信号（2026-09-21 新增；动机见下方 authoritySignals 的注释）──
  // 关闭时（wAuthority=0 且 wTutorial=0 且 wHomepage=0）行为与加此信号前**逐位相同**（实测 0.7788 → 0.7788）。
  //
  // ⚠️ 权重为什么是 0.18 而不是评估集最优的 0.8（这条必须留着，否则后人会"顺手调优"）：
  //   评估集上 wAuthority 单调上升到 0.8 时英文 nDCG 达到 **1.0000**（满分）。
  //   但那是**信号与评测口径重合**造成的假象 —— 本评估集的 gold 全部是官方文档域，
  //   所以"按权威度排序"在它上面天然接近满分；把权重拉满等于**用官方域清单替代相关性**。
  //   在真实使用中官方域覆盖不了长尾查询，权重拉满会退化成"只有官方源可排"。
  //   故选在**收益平台段**起点（0.18→0.22 仅 +0.009，0.22 后完全不动），
  //   保留"覆盖率可压过权威度"的能力：官方文档与教程站覆盖率相当时权威源胜出，
  //   但覆盖率差距明显时仍按相关性走。
  wAuthority: 0.18,      // 官方文档域 / 主题官方域名 加成
  wTutorial: 0.08,       // 教程聚合站降权（runoob/csdn/juejin 类）
  wMirror: 0.18,         // 镜像/寄生域降权（nodejs.cn / vueframework.com 类，见 MIRROR_DOMAINS）
                         // 取与 wAuthority 等量：一条镜像结果"冒充官方"获得的正是这一档加成，
                         // 用同等力度抵消才谈得上对称（否则它仍净得正分）。
  wHomepage: 0.10,       // 泛首页降权（站点首页 **且** 覆盖率 ≤ GENERIC_HOMEPAGE_COV_MAX）
                         // 覆盖率上限是模块常量而非配置项：它与判定逻辑是同一概念的两半，
                         // 拆成两处会漂移。理由见 GENERIC_HOMEPAGE_COV_MAX 的注释。
  multiResultBonus: 0.00, // 同一 host 在同批结果里出现多次 → 该站是本主题的枢纽。
                          // 实测单独开启有 +0.0498，但与权威信号高度冗余（同一批结果里的官方域）
                          // 且会伤英文（−0.0109），故默认关闭，仅留作实验开关。
};

/**
 * 权威源清单（**通用**官方文档域，不是按评估集逐个挑的）。
 *
 * 收录标准（写清以便复核，避免变成"对着 gold 调参"）：
 *   ① 产品/标准的**第一方**域名（该主题的权威定义方就是它自己）；
 *   ② 独立于本项目评估集即可判定 —— 任何一个程序员看到 redis.io / nginx.org 都会同意它是权威源；
 *   ③ 只收**文档型**入口，不收聚合/问答/博客。
 * 判断"是否该收录"的方法：问"这个域对以其为主题的查询，是不是最终解释权方"。
 */
export const AUTHORITY_DOMAINS = new Set([
  "developers.weixin.qq.com", "pay.weixin.qq.com", "kf.qq.com", "mp.weixin.qq.com",
  "nodejs.org", "vuejs.org", "react.dev", "angular.io", "svelte.dev",
  "python.org", "rust-lang.org", "go.dev", "typescriptlang.org", "php.net", "ruby-lang.org",
  "redis.io", "nginx.org", "nginx.com", "docker.com", "kubernetes.io", "postgresql.org",
  "mysql.com", "elastic.co", "mongodb.com", "apache.org", "git-scm.com",
  "developer.mozilla.org", "w3.org", "ietf.org", "kernel.org", "gnu.org",
  "opendocs.alipay.com", "alipay.com", "amap.com", "lbs.amap.com",
  "12306.cn", "gov.cn", "sf-express.com",
]);

/** 教程聚合/内容农场：实测常压住同主题官方文档（见 CHANGELOG §零之八）。 */
export const TUTORIAL_DOMAINS = new Set([
  "runoob.com", "juejin.cn", "csdn.net", "cnblogs.com", "geeksforgeeks.org",
  "w3schools.com", "segmentfault.com", "jianshu.com", "fanruan.com",
  "developer.aliyun.com", "cloud.tencent.com", "cn.aliyun.com",
]);

/**
 * **镜像/寄生域**：内容抄自官方文档、却用"产品名 + 其它 TLD/仿名"占位，
 * 靠 `authoritySignals` 的"主题官方方"档（0.60）拿到权威加成。
 *
 * 为什么必须单独列：判定"域名含查询里的拉丁词"这条规则**无法区分正主与仿站** ——
 * `nodejs.cn`、`vueframework.com` 都含查询词，于是被当成"主题官方方"。
 * 在线实测（2026-09-21）：权威信号**关闭**时 `vueframework.com` 排第 1（真官方 vuejs.org 未出现），
 * `nodejs.cn` 也压过 nodejs.org。这是**明确的正确性缺陷**，不是调参偏好。
 *
 * 收录标准：非官方发布方、内容为官方文档的中文镜像或改名镜像。
 * ⚠️ 与 `TUTORIAL_DOMAINS` 分开是为语义清晰：这些不是"教程站"，是"**冒充官方的镜像站**"。
 */
export const MIRROR_DOMAINS = new Set([
  "nodejs.cn", "vueframework.com", "reactjs.org.cn", "reactjs.bootcss.com",
  "bootcss.com", "python3.com", "redis.cn", "dockerinfo.com",
]);

/** URL 路径里的"文档"特征（与域无关的第二路信号）。 */
const DOC_PATH_RE = /\/doc|\/docs|\/documentation|\/api\/|\/reference|\/manual|\/guide|\/spec|\/learn\b/i;

/**
 * **文档子站**的 host 特征：`docs.` / `dev.` / `developer.` / `developers.` / `learn.` / `api.` / `reference.`。
 *
 * 这是行业通用惯例而非逐站枚举 —— `docs.docker.com`、`dev.mysql.com`、`developer.mozilla.org`、
 * `developers.weixin.qq.com` 都落在同一个形状上。加它的原因见 authoritySignals 的注释：
 * 原清单把 `docker.com` 与 `docs.docker.com` 评为同级，导致**营销站压住自家文档站**。
 */
const DOC_HOST_RE = /(^|\.)(docs|dev|developer|developers|learn|api|reference)\./i;


/** 站点首页判定（pathname 为空或仅 "/"）。 */
export function isSiteHomepage(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return p === "";
  } catch { return false; }
}

function hostIn(set, host) {
  if (!host) return false;
  for (const d of set) if (host === d || host.endsWith("." + d)) return true;
  return false;
}

/**
 * 「泛首页」的覆盖率上限：站点首页 + 覆盖率低于此值 ⇒ 判定为**与主题无关的门面页**。
 *
 * 为什么是 0.20（两个独立来源都指向这个量级）：
 *   · 实测 `weixin.qq.com` 首页对 "微信小程序 虚拟支付" 的覆盖率 = **0.167**
 *     （标题"微信，是一个生活方式" + 页脚"小程序"）；
 *   · 另一个失败样本 `wx.qq.com` 首页 cov = **0.22**。
 * 但**不能再放宽**：`redis.io/`、`nodejs.org/` 这类**正确的官方入口**覆盖率在 0.20~0.50，
 * 放宽会把它们一起罚掉 —— 实测 `wHomepage=0.10` 时 covMax 0.15 → +0.0128，0.30 → **−0.0234**。
 * 所以 0.20 是"刚好覆盖已知失败形态、又不碰官方入口"的窄带，不是可以随手调的旋钮。
 *
 * ⚠️ 这条判据（首页 + 低覆盖）与 `homepageCovMax` 是**同一个概念的两半**，
 * 故此处只留一个常量：任何一处改名都必须同步（echo.test.mjs 有对应断言锁住上限）。
 */
export const GENERIC_HOMEPAGE_COV_MAX = 0.20;

/**
 * 权威源信号 —— 为什么需要它（这是本项目**长期存在**的一个系统性缺陷，不是调参）。
 *
 * 实测失败画像（评估集 40 条，见 CHANGELOG §零之八）：hit@5 已达 0.9333，
 * **gold 几乎都进了结果，但经常排在 2~4 位**，被两类东西压住：
 *   ① 教程/SEO 站（runoob / juejin / cnblogs / geeksforgeeks / 阿里云社区）
 *      —— 它们**查询词覆盖率天然高**（标题就把查询词复述一遍），于是纯 RRF 里占优；
 *   ② 站点**首页**（weixin.qq.com、wx.qq.com）—— cov 仅 0.17~0.22，靠单引擎第 1 名上位。
 * 而真正的答案（developers.weixin.qq.com、nodejs.org、redis.io）**覆盖率反而低**，
 * 因为官方文档的标题是精确术语（"Redis - Real-time data for agents & apps"）而非查询词复述。
 *
 * 这就是"覆盖率"作为主排序信号的固有偏差：它奖励**复述查询**，不奖励**权威作答**。
 * RRF 本身也没有权威概念。所以补一个显式的权威信号，与覆盖率**互补**而非叠加同向偏差。
 *
 * @param {string} query 查询
 * @param {object} r 结果项（需要 url / domain / coverage）
 * @returns {{authority:number,tutorial:number,homepage:number,isDocSite:number,host:string}}
 *   `authority` 为 0~1 连续分，`isDocSite` 为 0/1 的**独立**标志（见下）。分档：
 *   1.00 = 权威域**且**是文档子站（docs.docker.com / dev.mysql.com / developer.mozilla.org）
 *          —— 或该域本身就是纯文档域（nodejs.org / redis.io / rust-lang.org，无营销站可混）
 *   0.90 = 权威域但不是文档子站（www.docker.com / www.mysql.com 这类公司/营销站）
 *          —— **刻意低于文档子站**：同集团里"文档站 > 营销站"，实测 www.docker.com 曾压住 docs.docker.com
 *   0.60 = 域名含查询中的拉丁词（"nodejs fs readFile" → nodejs.cn；主题官方方）
 *   0.40 = URL 路径是文档型（**非**站点根：见下方为何要排除根路径）
 *
 * ── isDocSite 为什么必须与 authority 分开（2026-09-21 在线实测踩到）──
 * 原清单把 `docker.com` 与 `docs.docker.com` 评为**同级 1.00**，于是信号
 * **分不出"营销站"和"文档站"**，实测 `www.docker.com/products/docker-desktop/` 稳居第 1、
 * `docs.docker.com` 被压到第 3~5（`www.mysql.com/cn/` 压 `dev.mysql.com` 同理）。
 * 修法不是继续加域，而是**给文档子站单独加一档**：`DOC_HOST_RE` 认 host 里的
 * docs/dev/developer/developers/learn/api/reference 等词 —— 这是**跨所有技术站点通用的**结构特征
 * （`docs.*`、`dev.*`、`developer.*` 是行业惯例），不是逐站枚举。
 */
export function authoritySignals(query, r) {
  const host = r.domain || extractDomain(r.url || "") || "";
  const url = r.url || "";
  let authority = 0;
  let isDocHost = false;
  const isMirror = hostIn(MIRROR_DOMAINS, host);
  if (isMirror) {
    // 镜像站**直接归零**：它不得从"主题官方方"档拿分（那正是它冒充的对象）。
    authority = 0;
  } else if (hostIn(AUTHORITY_DOMAINS, host)) {
    isDocHost = DOC_HOST_RE.test(host);
    // 文档站档位：凡 host 自带 docs./dev./developer. 前缀（或该文本域本身就是文档域）→ 1.00；
    // 其余公司/营销站 → 0.90。`nodejs.org`、`redis.io` 这类**本身就是文档域**的没有
    // docs. 前缀，但也不存在同集团的 `www.nodejs.org` 营销站来竞争，故与 docs 子站同档即可。
    authority = isDocHost || !/^www\./i.test(host) ? 1 : 0.9;
  } else {
    // 主题官方方：域名里含查询的拉丁词（技术查询常带产品名，中文查询则未必）
    const qTokens = String(query).toLowerCase().match(/[a-z][a-z0-9.+#-]{2,}/g) || [];
    for (const t of qTokens) {
      const bare = t.replace(/[.+#-]/g, "");
      if (bare.length >= 3 && host.replace(/[.-]/g, "").includes(bare)) { authority = Math.max(authority, 0.6); break; }
    }
    // 路径型权威：**必须排除根级路径**。
    // 实测 `nginx.org/en/index.html`（首页英文版）靠 `/en/` 旁的路径形状拿到 0.40，
    // 但它对 "nginx location directive" 并不比其它结果更权威 —— 那是噪音。
    // 故只有"根之后再有一段真实子路径"才算文档型（/docs/guide、/api/fs.html 算；/en/ 不算）。
    if (!authority && DOC_PATH_RE.test(url)) {
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        if (segs.length >= 2) authority = 0.4;
      } catch { /* URL 异常则不判 */ }
    }
  }
  const tutorial = hostIn(TUTORIAL_DOMAINS, host) ? 1 : 0;
  const coverage = typeof r.coverage === "number" ? r.coverage : 0;
  // 「泛首页」= 站点首页 **且** 与主题几乎无词面重合。
  // 两个条件缺一不可：只按首页判会罚掉 redis.io/ 这类正确的官方入口（实测变负收益）。
  const homepage = isSiteHomepage(url) && coverage <= GENERIC_HOMEPAGE_COV_MAX ? 1 : 0;
  return { authority, tutorial, homepage, isMirror: isMirror ? 1 : 0, isDocSite: isDocHost ? 1 : 0, host };
}

// ── 官方文档召回（2026-09-21 第二轮：**召回侧**修复，不是排序） ───────────────
/**
 * 产品别名 → 官方文档域。**只处理"域名认不出来"的别名**，不是主题映射表。
 *
 * 为什么必须单独有它：`inferOfficialDomain` 的正常通路是「查询里的产品词与
 * AUTHORITY_DOMAINS 的域名在拼写上对得上」（redis→redis.io、kafka→kafka.apache.org）。
 * 但有几类产品**查询里的叫法与域名毫无字面关系**，纯字符串推导永远推不出来：
 *   `golang`   → `go.dev`          （语言曾用名 vs 双字母域名）
 *   `k8s`      → `kubernetes.io`   （行业缩写 vs 全称）
 *   `微信支付` → `pay.weixin.qq.com`（中文产品名 vs 英文子域）
 *
 * ⚠️ 收录纪律（防止它退化成"对着评估集抄答案的表"）：
 *   ① **键必须是"产品的通用叫法"**，不是某个具体查询的措辞（不许出现 "vue3 组合式" 这种）；
 *   ② **值必须已在 `AUTHORITY_DOMAINS` 里** —— 有断言锁住（`officialdocs.test.mjs`），
 *      否则本表就成了绕过权威清单收录标准的后门；
 *   ③ 能靠拼写对上的**一律不写进来**（redis/kafka/mysql/docker…都不必，写了反而是冗余）。
 */
export const OFFICIAL_ALIASES = new Map([
  ["golang", "go.dev"],
  ["k8s", "kubernetes.io"],
  ["微信支付", "pay.weixin.qq.com"],
  ["微信小程序", "developers.weixin.qq.com"],
  ["小程序", "developers.weixin.qq.com"],
  ["公众号", "mp.weixin.qq.com"],
]);

/**
 * host 里**没有产品语义**的通用段（子域前缀 + 注册域后缀）。
 *
 * 为什么要逐段扫描而不是只取"可注册域 label"：官方文档域**不总是**放在注册域上 ——
 *   `kafka.apache.org`（产品词在**最左**段，label 是 "apache"）
 *   `dev.mysql.com`   （产品词在中间段，label 是 "mysql"）
 *   `docs.docker.com` （同上）
 * 只取 label 会让 `kafka.apache.org` 永远推不出来（查询里没有 "apache" 这个词）。
 */
const SEG_STOP = new Set([
  "www", "docs", "doc", "dev", "developer", "developers", "learn", "api", "reference",
  "com", "org", "net", "io", "cn", "co", "gov", "edu", "ac",
  "pay", "mp", "kf", "lbs", "open", "portal", "support", "help",
]);

/** 编辑距离 ≤2（只在长度已设下限且**词首相同**后调用，避免短词乱配）。 */
function within2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n] <= 2;
}

/**
 * 查询的拉丁词 与 官方域各段 的匹配强度（0 = 不匹配）。分级不是调参，是为了压住假阳：
 *   4 精确（redis↔redis.io、mysql↔dev.mysql.com）
 *   3 前缀且 ≥4 字（vue→vuejs、typescript→typescriptlang、nodejs→node）
 *   2 包含且 ≥4 字
 *   1 **词首相同**（前 3 字）时允许编辑距离 ≤2（python↔python、setup↔svelte 会被"词首"挡掉）
 */
function segMatchScore(stem, seg) {
  if (stem.length < 3 || seg.length < 3) return 0;
  if (stem === seg) return 4;
  if (seg.startsWith(stem) && stem.length >= 4) return 3;
  if (stem.startsWith(seg) && seg.length >= 4) return 3;
  if (seg.includes(stem) && stem.length >= 4) return 2;
  if (stem.slice(0, 3) === seg.slice(0, 3) && within2(stem, seg)) return 1;
  return 0;
}

/**
 * 查询 → 官方文档域（推不出来返回 null）。
 *
 * 两条通路，**都以"查询里出现的通用产品名"为唯一依据**，不看评估集 gold：
 *   ① 别名表（`OFFICIAL_ALIASES`）：处理**拼写对不上**的（golang→go.dev、k8s→kubernetes.io、中文产品名）；
 *   ② 拼写比对：查询的拉丁词 与 `AUTHORITY_DOMAINS` 每个 host 的**各段**比较（强度见 `segMatchScore`），
 *      取全局最高；同分时优先"段更短"（更专指）的域。
 *
 * 同产品多域时同样由同分规则决定：`mysql` 对 `mysql.com` 与 `dev.mysql.com` 同分 →
 * 取段更短的 `mysql.com`。**文档子站优先**交给 sort 时按 `authScore` 处理（`docs.docker.com` 1.00 > `www.docker.com` 0.90）。
 */
export function inferOfficialDomain(query) {
  const domains = [...AUTHORITY_DOMAINS];
  const q = String(query || "");
  const low = q.toLowerCase();

  // ① 别名：中文键按原文比对，拉丁键按小写比对（别名都是"通用叫法"，故直接 includes）
  for (const [alias, dom] of OFFICIAL_ALIASES) {
    const hit = /[a-z]/.test(alias) ? low.includes(alias) : q.includes(alias);
    if (hit && domains.includes(dom)) return dom;
  }

  // ② 拼写比对
  const tokens = [...new Set(
    (low.match(/[a-z][a-z0-9+#]*/g) || []).filter((w) => w.length >= 3 && !/^[0-9]+$/.test(w))
  )];
  if (!tokens.length) return null;
  const stems = [];
  for (const tok of tokens) {
    const s = tok.replace(/\d+$/, "").replace(/[.+#-]/g, ""); // vue3→vue、node.js→nodejs
    if (s.length >= 3) stems.push(s);
  }
  if (!stems.length) return null;

  let best = null;
  for (const dom of domains) {
    const segs = String(dom).split(".");
    // ① 精确命中**最左段**：该 host 就是以这个产品命名的托管子域（`kafka.apache.org` ← "kafka"）。
    //    此时必须用**完整 host**，否则会退到注册域（`apache.org`）——那会把 `site:` 检索放宽到
    //    Apache 全基金会（hadoop/spark/flink…全进来），是把修复变成错误。
    //    ⚠️ **诚实说明：这条规则对当前 `AUTHORITY_DOMAINS` 是"不生效"的**（清单尚未收录任何
    //       "托管产品子域"形态的域：`docs./dev./pay.` 之类的最左段已由 `SEG_STOP` 排除，
    //       `kafka.` 本就未被收录）。保留它是因为它正好防住"将来有人加了这类域却拿到错误注册域"
    //       这个**静默**错误（症状会是 site: 检索范围莫名放大）。有断言锁住它的实际效果。
    //    ⚠️ 只在"精确"档生效：`vue3` 对 `vuejs.org` 属模糊档，不该因此改写域名形态。
    if (!SEG_STOP.has(segs[0]) && segs.length >= 3 && stems.includes(segs[0])) {
      if (!best || best.score < 5) best = { dom, score: 5, segLen: segs[0].length };
      continue;
    }
    // ② 逐段拼写比对（段更短者优先 = 更专指）
    for (const seg of segs) {
      if (seg.length < 3 || SEG_STOP.has(seg)) continue;
      for (const stem of stems) {
        const score = segMatchScore(stem, seg);
        if (score > 0 && (!best || score > best.score || (score === best.score && seg.length < best.segLen))) {
          best = { dom, score, segLen: seg.length };
        }
      }
    }
  }
  return best ? best.dom : null;
}

/**
 * 官文文档页召回通道的开关与请求预算。
 *
 * ⚠️ `EVAL_NO_API=1` **同时关掉本通道**（不是笔误）：该变量的语义是
 * "排除一切**独立于本机 IP 的付费/外部 API**"，而 `siteSearch` 会走 intlBing（需本地代理）。
 * 离线评估（`eval/run-eval.mjs replay`）必须靠它做到**逐位可复现**，
 * 否则重放结果会随代理/引擎状态漂移，控制变量对比就失效了。
 * 若只想要"API 闸门关闭、本通道保留"，用 `OFFICIAL_DOCS_PASS=0` 单独关本通道。
 */
export function officialDocsPassEnabled() {
  if (process.env.OFFICIAL_DOCS_PASS === "0") return false;
  if (process.env.EVAL_NO_API === "1") return false;
  return true;
}

/**
 * 第二段的查询词：**「产品 token + 文档意图词」**。
 *
 * 为什么不能直接用「清洗后查询 + 文档词」（这是第一版的写法，**在线实测已证否**）：
 * `mysql 索引 最左前缀原则` 配 `site:mysql.com` 只会捞回首页与 `/downloads/installer/` ——
 * 因为**中文词面在英文官方站上零匹配**，引擎退化成"按域返回最知名页"（首页/下载页）。
 * 实测对照（同一次运行，`site:mysql.com`）：
 *   查询「mysql 索引 最左前缀原则 文档 reference guide」→ 首页 + `/downloads/installer|mysql`
 *   查询「mysql reference guide」                        → `/doc/`、`/doc/refman/8.0/en/preface.html`
 *   查询「mysql indexes」                               → `/doc/refman/8.0/en/mysql-indexes.html` ★
 * 差别只在"查询词是否与站点文档**同语种**"。
 *
 * 产品 token 由「查询里的拉丁词 ∩ 推断出的官方域」推出（`mysql` ↔ `mysql.com`），
 * **不是** API 里硬编码产品名；推不出交集（如中文产品名的微信场景）时**退回清洗后查询**，
 * 保持与第一段一致的语义（那种场景下官方站本来就是中文的，中文词面不是问题）。
 */
function docsHintQuery(cleaned, dom) {
  const segs = new Set(String(dom).split(".").filter((s) => s.length >= 3 && !SEG_STOP.has(s)));
  const toks = [];
  for (const w of String(cleaned).toLowerCase().match(/[a-z][a-z0-9+#]*/g) || []) {
    const stem = w.replace(/\d+$/, "").replace(/[.+#-]/g, "");
    for (const seg of segs) if (segMatchScore(stem, seg) > 0) { toks.push(w); break; }
  }
  const uniq = [...new Set(toks)];
  return uniq.length ? `${uniq.slice(0, 3).join(" ")} reference guide documentation` : cleaned;
}

/** 文档型 URL 判定（站点首页不算：首页对"查某个具体问题"没有价值，正是要修的失败形态）。 */
function isDocUrl(url) {
  if (isSiteHomepage(url)) return false;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs.length >= 2 && DOC_PATH_RE.test(url);
  } catch { return false; }
}

/** 给本次召回结果盖 source 戳（供 `[source]` 标签与 stats 归并；见文件头标签集注释）。 */
function tagOfficialDocs(rows, dom) {
  return (rows || []).map((r) => ({ ...r, source: r.source ? `${r.source}+officialDocs` : "officialDocs", __officialDocs: dom }));
}

/**
 * 把官方文档通道的结果并入 `raw`，并把"官方域事前是否已在池里 / 事后是否进来了"写进 stats。
 *
 * 记这两个字段的理由（**没有它们就无法归因**）：本通道的收益只可能出现在
 * "官方域原本不在池里（或只有首页/下载页）"的场景；若它本来就在池里，
 * 本通道是纯浪费请求 —— 事后复盘时必须能区分这两种情况，而不是只看总分涨跌。
 */
function mergeOfficialDocs(raw, stats, { rows, dom }) {
  if (!dom) return;
  const isOff = (h) => h === dom || h.endsWith("." + dom);
  const inPoolBefore = raw.some((r) => isOff(extractDomain(r.url)));
  const docBefore = raw.some((r) => isOff(extractDomain(r.url)) && isDocUrl(r.url));
  stats.officialDocs = { dom, recalled: rows.length, inPoolBefore, docPageBefore: docBefore };
  if (rows.length) raw.push(...rows);
}

/**
 * 召回侧修复：**把"官方文档页"作为一路独立检索并入引擎调用**（CHANGELOG §零之八「下一步」第 1 条）。
 *
 * 动机（上一轮定位的**剩余瓶颈**，全部来自在线实测）：
 *   · `mysql 索引 最左前缀原则` —— 池里 `dev.mysql.com` 命中的是 `/downloads/`，
 *     对症的 `/doc/refman/8.0/en/mysql-indexes.html` **根本不在池里**；
 *   · `vueframework.com` 场景 —— 真官方 `vuejs.org` 同样不在池里。
 * 排序信号再强也排不出池里没有的条目，所以这一路的作用是**让它先进池**。
 *
 * 为什么是"推断官方域 + 站内检索"而不是"给所有查询加一路文档词检索"：
 * 后者会把 runoob/CSDN 这类**同样命中文档词**的教程站一起拉进池，
 * 等于放大已被权威信号修正的那个偏差（§零之八 的成因①）。
 *
 * 两段式请求（**只在第一段真的没捞到文档页时才追加第二段**，控制请求预算）：
 *   ① `site:<官方域> <清洗后查询>` —— 多数情况已能命中文档页；
 *   ② 追加文档意图词重试 —— 用于官方域只返回首页/产品页的场合。
 *
 * @returns {{rows:Array, dom:string|null}} 供并入 raw；dom 为 null 表示本通道未参与
 */
export async function fetchOfficialDocs(query, maxResults = 5) {
  if (!officialDocsPassEnabled()) return { rows: [], dom: null };
  const cleaned = cleanQuery(query);
  const dom = inferOfficialDomain(cleaned);
  if (!dom) return { rows: [], dom: null };

  const want = Math.max(maxResults, 8);
  const pulls = [() => siteSearch(dom, cleaned, want)];
  // 第一段的结果里若一条文档页都没有（典型形态：只回了站点首页与下载页），再试带文档意图词的一路。
  let rows = [];
  try { rows = await pulls[0](); } catch { rows = []; }
  if (!rows.some((r) => isDocUrl(r.url))) {
    const docsQuery = docsHintQuery(cleaned, dom);
    try {
      const second = await siteSearch(dom, docsQuery, want);
      const seen = new Set(rows.map((r) => normalizeUrl(r.url).key));
      for (const r of second) {
        const k = normalizeUrl(r.url).key;
        if (!seen.has(k)) { seen.add(k); rows.push(r); }
      }
    } catch { /* 静默降级：本通道失败不得影响主链结果 */ }
  }
  // 文档页优先、首页最后：并入 raw 后 `covered` 判定与"官方页是否真的进来了"都看这个顺序。
  rows.sort((a, b) => Number(isDocUrl(b.url)) - Number(isDocUrl(a.url)));
  return { rows: tagOfficialDocs(rows.slice(0, want), dom), dom };
}

/** 评估用：覆盖排序权重（离线网格搜索）。 */
export function __setRankConfig(cfg) { RANK_CONFIG = { ...RANK_CONFIG, ...cfg }; }
export function __getRankConfig() { return { ...RANK_CONFIG }; }

/**
 * RRF：对每个命中该结果的引擎按其在"该引擎内部"的名次累加 1/(k+rank)。
 * 与旧 positionWeight 的本质区别：这里用的是每个引擎各自的 rank，
 * 而不是结果在拼接大数组里的位置。
 */
export function rrfScore(engineRank, engineQuality = null) {
  const K = RANK_CONFIG.rrfK;
  let s = 0;
  for (const [eng, rank] of Object.entries(engineRank || {})) {
    let w = RANK_CONFIG.engineWeightedRrf ? (ENGINE_WEIGHT[eng] || 0.8) : 1;
    // 引擎内在题率加权（2026-09-12 实验项，默认关闭）：
    // 动机：so360 对中文长查询返回的是"在题但非权威"结果（runoob/CSDN，coverage 0.6~1.0），
    // 而 cn.bing 返回"权威但不在题"（官方文档标题不含查询词，coverage 0.05~0.25）。
    // 纯 RRF 让条数多的引擎淹没条数少的，实测把官方文档挤出 top-5（vue3/nodejs/go 三查询 1.0→0.0）。
    // engineQuality[eng] ∈ (0,1] 为该引擎本次结果的均值 coverage；加权后"在题引擎"话语权更大。
    if (engineQuality && engineQuality[eng] !== undefined) {
      const q = engineQuality[eng];
      w *= Math.pow(Math.max(q, 0.01), RANK_CONFIG.engineQualityPower);
    }
    s += w / (K + rank);
  }
  return s;
}

function mergeEngineRank(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = out[k] === undefined ? v : Math.min(out[k], v);
  return out;
}

// 回显垃圾特征词：聚合页标题常把整句查询 + 这类泛化词拼在一起
const GENERIC_ECHO_RE =
  /图片|视频|大全|相关搜索|最新|推荐|下载|专题|资讯|排行|问答|论坛|贴吧|在线观看|免费在线|高清|完整版|免费下载|聚合|导航|百科/i;
const AGGREGATOR_HOST_RE = /image\.baidu\.com|lightapp\.baidu\.com/i;

/**
 * 回显惩罚：标题几乎复述整句查询且带泛化词 → 判为聚合/SEO 垃圾。
 * 刻意保守：单靠"标题短"不判（官方文档标题也短，如 "Python asyncio.gather"），
 * 必须同时命中泛化词才罚，避免误伤 gold。
 */
export function echoPenaltyOf(query, r) {
  if (!RANK_CONFIG.echoPenalty) return 0;
  if (AGGREGATOR_HOST_RE.test(r.url || "")) return 1;
  const title = String(r.title || "");
  if (!title) return 0;
  if (termCoverage(query, title, "") < RANK_CONFIG.echoRatio) return 0;
  return GENERIC_ECHO_RE.test(title) ? 1 : 0;
}

// ── BM25 分词器（2026-09-12 修复） ──
// 缺陷：MiniSearch 默认按空白切词，中文查询被当作**一个整词**，
// 导致"个人小程序也能开虚拟支付了"这种文档完全匹配不上 query="微信小程序 虚拟支付"，
// BM25 全 0（旧注释因此写下"中文因无空格分词恒 0"并把 wBm25 设为 0）。
// 实测（同批数据）：默认分词仅命中 2 条正确结果；
// 改用 CJK 二元组后，正确结果 BM25=290.76/213.37，垃圾结果（微信首页/百度百科/日文天气）仅 5.64 或未命中。
// 做法与 termCoverage 保持一致：latin 词原样小写 + CJK 连续片段切 overlapping 2-gram。
export function cjkTokenize(text) {
  const out = [];
  const s = String(text || "");
  for (const w of s.match(/[A-Za-z0-9_]+/g) || []) out.push(w.toLowerCase());
  for (const seq of s.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []) {
    if (seq.length === 1) { out.push(seq); continue; }
    for (let i = 0; i < seq.length - 1; i++) out.push(seq.slice(i, i + 2));
  }
  return out;
}

/**
 * @param {object} [cfgOverride] 评估专用：临时覆盖 RANK_CONFIG（网格搜索用）。
 *   为什么要这个口子：评估脚本若自己**复刻**打分公式，就会与生产漂移 ——
 *   实测复刻版基线 0.7259 vs 生产 0.7788，差了 5pt，等于所有 delta 都不可信。
 *   所以让实验跑在**真代码路径**上，只换参数。
 */
function rankResults(items, query, cfgOverride = null) {
  if (!items.length) return [];
  const C = cfgOverride ? { ...RANK_CONFIG, ...cfgOverride } : RANK_CONFIG;
  const ms = new MiniSearch({
    fields: ["title", "text"],
    idField: "id",
    storeFields: [],
    tokenize: cjkTokenize,
    processTerm: (t) => t, // 关闭 MiniSearch 默认的 stem/stopword（对 CJK 无意义且会改动二元组）
  });
  ms.addAll(items.map((r, i) => ({ id: i, title: r.title || "", text: `${r.snippet || ""} ${r.domain || ""} ${r.url || ""}` })));
  const hits = ms.search(query, { boost: { title: 3 } });
  const scoreById = new Map(hits.map((h) => [h.id, h.score]));
  const maxScore = hits.length ? Math.max(...hits.map((h) => h.score)) : 0;

  // ①-b 每引擎"内在题率"（该引擎本次结果的均值 coverage）。
  // 用途见 rrfScore 注释：区分"在题但不权威"(so360/runoob) 与"权威但不在题"(cn.bing/官方文档)。
  // 仅在 engineQualityPower>0 时参与打分，否则纯计算开销（可忽略）。
  const engineQuality = {};
  if (C.engineQualityPower > 0) {
    const acc = {};
    for (const r of items) {
      const cov = termCoverage(query, r.title, r.snippet);
      for (const s of r.sources || []) {
        if (!acc[s]) acc[s] = { sum: 0, n: 0 };
        acc[s].sum += cov;
        acc[s].n += 1;
      }
    }
    for (const [eng, v] of Object.entries(acc)) engineQuality[eng] = v.n ? v.sum / v.n : 0;
  }

  // ① 逐项取原始信号
  const hostCount = {};
  for (const r of items) {
    const h = r.domain || extractDomain(r.url || "");
    if (h) hostCount[h] = (hostCount[h] || 0) + 1;
  }
  const scored = items.map((r, i) => {
    const coverage = termCoverage(query, r.title, r.snippet);
    const sig = authoritySignals(query, { ...r, coverage });
    return {
      ...r,
      bm25: maxScore ? (scoreById.get(i) || 0) / maxScore : 0,
      coverage,
      rrfRaw: rrfScore(r.engineRank, C.engineQualityPower > 0 ? engineQuality : null),
      echo: echoPenaltyOf(query, r),
      lowerPenalty: r.lower ? 1 : 0,
      rankIdx: i,
      authScore: sig.authority,
      isTutorial: sig.tutorial,
      isMirror: sig.isMirror,
      isHomepage: sig.homepage,
      hostN: hostCount[sig.host] || 1,
    };
  });

  // ② RRF 归一化（跨查询不可比，故按本次最大值归一，使权重含义稳定）
  const maxRrf = Math.max(...scored.map((r) => r.rrfRaw), 1e-9);
  for (const r of scored) r.rrf = r.rrfRaw / maxRrf;

  // ③ 线性组合（权重见 RANK_CONFIG，经评估集网格搜索确定）
  for (const r of scored) {
    if (C.rankMode === "legacy") {
      // 复刻 2026-09 旧公式：用于在同一批原始数据上做控制变量对比（评估专用，不用于生产）
      const primary = r.sources.length
        ? r.sources.reduce((a, b) => ((ENGINE_WEIGHT[b] || 0) > (ENGINE_WEIGHT[a] || 0) ? b : a))
        : "baidu";
      const weight = ENGINE_WEIGHT[primary] || 0.8;
      const idx = r.indexes && r.indexes.length ? Math.min(...r.indexes) : 0;
      r.finalScore = 0.5 * r.coverage + 0.25 * r.bm25 + 0.25 * (weight * (1 / (idx + 1))) - 0.3 * r.lowerPenalty;
    } else {
      r.finalScore =
        C.wRrf * r.rrf +
        C.wCoverage * r.coverage +
        C.wBm25 * r.bm25 -
        C.lowerPenalty * r.lowerPenalty -
        C.echoPenalty * r.echo +
        C.wAuthority * r.authScore -
        C.wTutorial * r.isTutorial -
        C.wMirror * r.isMirror -
        // 泛首页惩罚：`isHomepage` 已由 authoritySignals 按
        // 「站点首页 且 coverage ≤ GENERIC_HOMEPAGE_COV_MAX」判定（两条件缺一不可，理由见该常量注释），
        // 这里不再重复 coverage 判断，避免同一概念散落两处而漂移。
        C.wHomepage * r.isHomepage +
        C.multiResultBonus * (r.hostN >= 2 ? 1 : 0);
    }
  }
  scored.sort((a, b) => b.finalScore - a.finalScore || a.rankIdx - b.rankIdx);
  return scored;
}

async function enrichOne(r) {
  try {
    const resp = await fetch(r.url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
    });
    if (!resp.ok) return;
    const html = await resp.text();
    const $ = cheerio.load(html);
    const desc = $('meta[property="og:description"]').attr("content") ||
                 $('meta[name="description"]').attr("content") || "";
    let text = desc || $("p").first().text();
    text = sanitizeText(text).slice(0, 300);
    if (text.length >= 60) r.snippet = text;
  } catch {}
}

/** 可选 snippet 增强（SNIPPET_ENRICH=1）：top-3 中 snippet<60 者，并发2抓页面。 */
async function enrichSnippets(list) {
  const candidates = list.filter((r) => (r.snippet || "").length < 60);
  let i = 0;
  const worker = async () => {
    while (i < candidates.length) { const r = candidates[i++]; await enrichOne(r); }
  };
  await Promise.all([worker(), worker()]);
}

/**
 * 质量管线（方案 2）：
 * ① 黑名单过滤（remove 硬删 / lower 标记） ② 归一化 URL 去重 + 标题 Jaccard 去重
 * ③ BM25 重排 ④ 可选 snippet 增强。
 * 返回 [{title,url,snippet,source,score?}]。
 */
export async function qualityPipeline(rawResults, query, cfgOverride = null) {
  // ① 黑名单 + 百度垂直聚合页过滤（2026-09：图片/视频聚合标题回显查询，coverage 虚高但无信息量）
  // 同时记录【每个引擎内部的名次】——RRF 需要的是引擎内 rank，而非拼接大数组里的位次。
  const kept = [];
  const engineSeen = new Map();
  for (const r of rawResults) {
    if (!r || !r.url || !isValidUrl(r.url)) continue;
    if (/image\.baidu\.com|lightapp\.baidu\.com/i.test(r.url)) continue;
    if (/百度图片|视频大全/.test(r.title || "")) continue;
    const m = blacklistMatch(r.url);
    if (m.remove) continue;
    const sources = splitSources(r.source);
    const engineRank = {};
    for (const s of sources) {
      const n = (engineSeen.get(s) || 0) + 1;
      engineSeen.set(s, n);
      if (engineRank[s] === undefined) engineRank[s] = n;
    }
    kept.push({ ...r, lower: m.lower, sources, engineRank });
  }
  // ② 归一化 URL 去重（多引擎命中合并，累加 source）
  const byKey = new Map();
  const order = [];
  kept.forEach((item, idx) => {
    const n = normalizeUrl(item.url);
    if (!n.host) return;
    if (byKey.has(n.key)) {
      const prev = byKey.get(n.key);
      prev.sources = mergeSources(prev.sources, item.sources);
      prev.engineRank = mergeEngineRank(prev.engineRank, item.engineRank);
      prev.indexes = (prev.indexes || []).concat([idx]);
      if ((item.snippet || "").length > (prev.snippet || "").length) prev.snippet = item.snippet;
    } else {
      byKey.set(n.key, { ...item, domain: n.host, urlKey: n.key, indexes: [idx] });
      order.push(n.key);
    }
  });
  let merged = order.map((k) => byKey.get(k));
  // ②b 标题 token Jaccard>0.85 视同同页，取长 snippet
  const final = [];
  for (const item of merged) {
    let placed = false;
    for (const m of final) {
      if (jaccardTokens(item.title, m.title) > 0.85) {
        if ((item.snippet || "").length > (m.snippet || "").length) m.snippet = item.snippet;
        m.sources = mergeSources(m.sources, item.sources);
        m.engineRank = mergeEngineRank(m.engineRank, item.engineRank);
        m.indexes = (m.indexes || []).concat(item.indexes || []);
        placed = true;
        break;
      }
    }
    if (!placed) final.push(item);
  }
  merged = final;
  // ③ 中文感知重排（RRF 跨引擎融合 + coverage + 权威信号 + 防回显；权重见 RANK_CONFIG）
  let ranked = rankResults(merged, query, cfgOverride);
  // ③b 低覆盖地板（2026-09；阈值见 RANK_CONFIG.covFloor / covBestGate）：
  // 池中已有高覆盖结果时，丢弃 coverage 过低的"泛首页/单字匹配"结果。
  // 纯 RRF 不看覆盖率，否则会让"在引擎排第 1 但内容泛"的站点首页上位
  // （实测 "微信小程序 虚拟支付" → weixin.qq.com 首页 cov=0.14 却排第 1）。
  if (ranked.length) {
    const floorCfg = cfgOverride ? { ...RANK_CONFIG, ...cfgOverride } : RANK_CONFIG;
    const best = Math.max(...ranked.map((r) => r.coverage ?? 0));
    if (best >= floorCfg.covBestGate) {
      const floor = floorCfg.covFloor;
      // **权威例外**：权威域不受低覆盖地板约束。
      // 动机（2026-09-21 在线实测同一批池上的对照）：`vue3 组合式 API setup 用法` 一条中
      // `vuejs.org` / `cn.vuejs.org` **在池里但 cov=0.000**（标题是英文精确术语，不含中文查询词），
      // 于是被地板**过滤**掉 —— 而地板是硬过滤，`wAuthority` 这种加分项**够不到它**。
      // 这暴露出两个信号的**能力边界不对称**：权威分再高也救不回被滤掉的结果。
      // 故此处放行权威域：宁可让一条低覆盖的官方文档占位，也不让它被教程站顶掉。
      // 注意判据用 `authScore >= 0.9`（仅"权威域"档），**不含** 0.6/0.4 的弱档，
      // 避免把仅靠"域名含查询词"或"路径像文档"的结果也一起放行（那两类正是误报源）。
      //
      // ⚠️ 必须同时要求 `wAuthority > 0`：否则"把权重设为 0"就**不再等于关掉特性**
      // （地板例外会绕过权重继续放行权威域），控制变量反证的口径会被悄悄破坏。
      // 特性开关必须是一个真正的总开关。
      const authorityEnabled = (floorCfg.wAuthority ?? 0) > 0;
      const kept = ranked.filter(
        (r) => (r.coverage ?? 0) >= floor || (authorityEnabled && (r.authScore ?? 0) >= 0.9)
      );
      // 兜底：地板过狠导致清空时保留原序（宁可差也不给空结果）
      if (kept.length) ranked = kept;
    }
  }
  // ③c cross-encoder 语义重排（可选；RERANK=1）。
  // 补 RRF/BM25 都无法覆盖的语义空档（词不同义同）。失败静默回退原序。
  if (RERANK_ENABLED && ranked.length > 1) {
    ranked = await rerankResults(query, ranked);
  }
  // ④ snippet 增强（可选）
  if (process.env.SNIPPET_ENRICH === "1") await enrichSnippets(ranked);
  return ranked.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet || "",
    source: r.sources.join("+"),
    score: Math.round(r.finalScore * 10000) / 10000,
    coverage: Math.round((r.coverage ?? 0) * 10000) / 10000,
    ...(r.rerankScore !== undefined ? { rerankScore: Math.round(r.rerankScore * 1000) / 1000 } : {}),
  }));
}

// ── 路由（方案 1.2；2026-09 精度重构：中文多引擎融合 + 垃圾门控不缓存） ──
/**
 * 引擎层：只做并发拉取 + 原始结果拼接，不做质量管线。返回 { raw, stats }。
 * 拆出来是为了评估可复现——可先 capture 原始结果，再离线 replay 管线，
 * 算法改动不受引擎抖动/限流干扰（见 eval/run-eval.mjs）。stats 供健康度判定用。
 *
 * 中文链：**搜索 API（tavily，有 key 时）** + 百度移动端（负缓存 5min）+ cn.bing + sogou（国内直连）+
 * 搜狗微信（仅微信生态查询）多路融合，再经 coverage 感知 qualityPipeline。
 * 解决：百度墙 + cn.bing 单字匹配垃圾（如"微信小程序 虚拟支付"返"微"字典页）。
 * 英文链：intlBing + ddgs 主路；主路不足时兜底顺序为 **API → cn.bing → 360 → 百度移动端**
 * （API 不进英文主融合，理由见下方 useApi 注释的受控 A/B 实测）。
 */
export async function fetchRawResults(cleaned, maxResults = 5) {
  // 路由按查询语言判定，不依赖 HTTP_PROXY env（MCP 进程无代理环境也能走英文链）
  const isCn = queryLanguage(cleaned) === "cn";
  const stats = { isCn, engines: [], contributing: 0, total: 0, apiEngine: apiEngineAvailable() };
  let raw = [];

  // ── 官方文档召回通道（2026-09-21 第二轮）──────────────────────────────────
  // 与主链**并行**发起：它多走一次 siteSearch，串行会直接拖慢响应。
  // ⚠️ 起点与主链同时发车，不依赖主链结果 —— 故本通道用不上"镜像域出现在池里"这条线索，
  //    只能靠查询自身的通用产品名推断（`inferOfficialDomain`）。
  // onSettled 用它把"官方页是否真的因本通道进池"记进 stats，供 ws.js status / 评估归因使用。
  const officialDocsPromise = fetchOfficialDocs(cleaned, Math.max(maxResults, 5)).catch((e) => {
    console.error(`[search-core] officialDocs pass failed: ${e?.message || e}`);
    stats.officialDocsError = String(e?.message || e);
    return { rows: [], dom: null };
  });

  // 搜索 API 引擎（有 key 才启用）：它是唯一不受本机 IP 反爬标记影响的来源。
  // 无 key（或评估中显式 EVAL_NO_API=1）时 searchApi 返回 []，系统行为与加此引擎前完全一致。
  //
  // 【为什么中文走"抢救闸门"、英文只做兜底】2026-09-12 受控实验（eval/api-ab.mjs，
  // 两份 capture 各 30 / 10 条查询，同一套 gold 标注；生产 raw 固定，唯一变量 = 是否并入 API）：
  //   ① API 的价值集中在"把 0 分抢救成 0.5~1.0"：微信支付 API v3 签名 0.000→0.712、
  //      高德地图逆地理编码 0.000→1.000、云开发 0.000→0.501、订阅消息 0.000→0.500
  //      —— 恰好补上国内引擎被反爬拦死时的空缺。
  //   ② 但"全并入"会伤到本来正确的结果：英文 0.8415→0.8115（−3.6%，python asyncio gather
  //      0.885→0.431、react hooks 0.906→0.680）；真实场景集也有 4 条变差
  //      （顺丰 0.967→0.853、个税 0.920→0.853）。
  //   ③ 改用「仅在**生产引擎单路**时并入」后：中文仍是 +13.2%，英文回到 ±0，真实场景集 ±0
  //      —— 拿到全部收益、丢掉全部伤害。
  //   ⚠️ 覆盖率门槛（0.20 / 0.40）实测**完全无效**：三种门槛与"全并入"逐位相同 ——
  //      API 结果词面覆盖率普遍很高（都在题），coverage 无法区分"在题"与"权威"（同 so360 结论）。
  // 注：engineRank 按来源独立计数（见 qualityPipeline 的 engineSeen），故 API 结果在数组
  //     中的位置不影响融合结果——生产代码与 A/B 脚本的先后顺序等价，实验结论可迁移。
  const useApi = apiEngineAvailable() && process.env.EVAL_NO_API !== "1";
  const apiResults = useApi
    ? await Promise.resolve(searchApi(cleaned, Math.max(maxResults, 5))).catch((e) => {
        console.error(`[search-core] search API failed: ${e?.message || e}`);
        stats.apiError = String(e?.message || e);
        return [];
      })
    : [];

  if (isCn) {
    // 中文链（2026-09-12 重构）：m.baidu（移动端，实测无墙）+ cn.bing + sogou + 360(so.com)
    // 变更依据：桌面百度对脚本请求恒返墙页（1438B、0 条），sogou 常触发反爬/backoff，
    // 实测中文查询长期只剩 cn.bing 单引擎（capture：每查询仅 5 条候选，best 覆盖常 <0.3）。
    // 新增两路实测可用且无墙的来源后，候选池与冗余度显著提升。
    // intlBing 已移出中文链（实测对中文 100% 零词面覆盖，见 CHANGELOG 第零节）。
    const broad = Math.max(maxResults, 5);
    let baiduMobileRes = [];
    if (!isBaiduNegative(cleaned)) {
      try {
        baiduMobileRes = await searchBaiduMobile(cleaned, broad);
      } catch (e) {
        if (e instanceof BaiduWallError) console.error("[search-core] baiduMobile wall, negative cache 5min");
        else console.error(`[search-core] baiduMobile failed: ${e?.message || e}`);
        setBaiduNegative(cleaned);
      }
    }
    const safe = (p) => Promise.resolve(p).catch((e) => {
      console.error(`[search-core] cn-engine failed: ${e?.message || e}`);
      return [];
    });
    // 搜狗微信只在**微信生态查询**上启用（2026-09-12）：它对公众号内容最权威，
    // 但对通用查询是浪费请求且增加被反爬的概率。触发词覆盖小程序/公众号/视频号等。
    // 已知边界：返回的 url 是 sogou 跳转链（文章链接走 antispider），见 searchSogouWeixin 注释。
    const wantWeixin = /微信|小程序|公众号|视频号|朋友圈|微信支付/.test(cleaned);
    const [cnBingRes, sogouRes, weixinRes] = await Promise.all([
      safe(searchCnBing(cleaned, broad)),
      safe(searchSogou(cleaned, broad)),
      wantWeixin ? safe(searchSogouWeixin(cleaned, broad)) : Promise.resolve([]),
    ]);
    raw = raw.concat(baiduMobileRes, cnBingRes, sogouRes, weixinRes);
    // 官方文档召回通道并入（在 API 闸门**之前**：本通道自己就网罗了国内引擎的正规索引，
    // 池子是否够用的判断应当纳入它；且它抢救不动时，闸门仍会照常介入）。
    mergeOfficialDocs(raw, stats, await officialDocsPromise);
    // API「抢救」闸门：生产结果"少得不像话"时并入。
    //
    // 【判据演进】原为 `distinctSources(raw) < 2`（仅单引擎）。2026-09-21 用**强制的当日新数据**
    // （`eval/api-ab.mjs --refetch`，40 次 credit，provider=tavily）重测后改为 raw 条数门槛：
    //   策略              总体 nDCG@5   中文        英文        cn_real
    //   prod（无 API）      0.7181       0.6359      0.8415        -
    //   单引擎（原）        0.7580(+0.040) 0.7023(+0.066) 0.8415(±0)  -
    //   raw<12（现）       **0.7788(+0.061)** **0.7370(+0.101)** 0.8415(±0)  -
    //   全并入              0.7585(+0.040) 0.7370(+0.101) **0.7906(−0.051)** -
    // 四路中文查询由闸门救活：虚拟支付 0.000→0.624、订阅消息 0.000→0.500、
    // 云开发数据库 0.000→0.431、微信支付 API v3 签名 0.000→0.544。
    //
    // 【为什么 raw 条数比"几路引擎"更准】实测 raw 分布高度结构化：raw=5（17 条查询，只有 1 路活着）、
    // raw=13（12 条，健康）、raw=10（1 条）。**英文查询全部 raw≥13，故本改动对英文零影响** ——
    // 这正是上面英文列 ±0 的结构性原因，不是巧合；也正因如此才没落进"全并入"的 −5.1% 陷阱。
    // 注：`raw<12` 蕴含原来的"单引擎"（实测"单引擎 或 raw<12"与"raw<12"逐位相同），故不需要 OR。
    //
    // ⚠️ 12 这个值是**从数据得来**的，不是推导出来的：每路引擎请求宽度为 5，
    // "2 路引擎但结果异常少"（raw=10 那条查询）恰好是抢救生效的边界。若将来改每路宽度或引擎数，
    // 需重跑 `eval/api-ab.mjs --refetch` 重新标定，不要直接沿用。
    if (apiResults.length && raw.length < rescueFloor()) raw = raw.concat(apiResults);
    // so360 已从中文链主融合中移除（2026-09-12 实测，剥离实验）：
    // 它返回的是**在题但非权威**结果（引擎内均值 coverage 0.60~1.00，全是 runoob/CSDN 教程），
    // 而 cn.bing 返回**权威但标题不含查询词**的官方文档（coverage 0.05~0.25）。
    // 纯 RRF 按名次融合不看权威性 → 条数多的 so360 把官方文档挤出 top-5：
    //   "vue3 组合式 API setup"  cn.vuejs.org   1.0 → 0.0
    //   "nodejs fs readFile 文档" nodejs.org    1.0 → 0.0
    // 剥离实验（同一份 capture，只增删来源）：ALL 0.6563→0.7027、中文 0.5586→0.6359、英文不变。
    // 即 so360 是 -7.7% 中文 nDCG 的唯一来源；baiduMobile 剥离后无变化（无副作用）。
    // 保留为"前三路全空"的最后兜底（有结果好过空结果，且此时必判降级）。
    if (raw.length === 0) {
      const [so360Res, intlRes, ddgRes] = await Promise.all([
        safe(searchSo360(cleaned, broad)),
        safe(searchIntlBing(cleaned, broad)),
        safe(searchDdgs(cleaned, broad)),
      ]);
      raw = raw.concat(so360Res, intlRes, ddgRes);
    }
  } else {
    // 英文链：intlBing（走本地代理）+ ddgs 并行融合；代理不可用/结果不足 → 兜底国内
    let main = [];
    let ddg = [];
    const [ib, dg] = await Promise.allSettled([
      searchIntlBing(cleaned, maxResults),
      searchDdgs(cleaned, Math.max(maxResults, 8)),
    ]);
    if (ib.status === "fulfilled") main = ib.value;
    else {
      console.error(`[search-core] intlBing failed: ${ib.reason?.message}`);
      stats.intlBingError = String(ib.reason?.message || ib.reason);
    }
    if (dg.status === "fulfilled") ddg = dg.value;
    else stats.ddgsError = String(dg.reason?.message || dg.reason);
    raw = raw.concat(main, ddg);
    // 主路失效时的兜底（2026-09-12 更新）：**API 优先**（比国内降级引擎更权威、且不受反爬影响），
    // 再退 cn.bing → 360 → 百度移动端（桌面百度恒墙，已改移动端）。
    const qualityFloor = 3;
    if (raw.length < qualityFloor) raw = raw.concat(apiResults);
    if (raw.length < qualityFloor) {
      raw = raw.concat(await searchCnBing(cleaned, maxResults).catch(() => []));
      if (raw.length < 3) raw = raw.concat(await searchSo360(cleaned, maxResults).catch(() => []));
      if (raw.length < 3 && !isBaiduNegative(cleaned)) {
        try { raw = raw.concat(await searchBaiduMobile(cleaned, maxResults)); }
        catch { setBaiduNegative(cleaned); }
      }
    }
    // 官方文档召回通道并入（**放在兜底之后**：英文链的兜底顺序是"API 优先"，
    // 若提前并入会把 raw 撑到 qualityFloor 之上、**静默取消 API 兜底** —— 那是既有行为的回归）。
    mergeOfficialDocs(raw, stats, await officialDocsPromise);
  }

  return { raw, stats: finalizeStats(stats, raw) };
}

/**
 * 管线层：原始结果 → 质量管线 → 截断。返回 bestCov 供垃圾门控决策。
 * 独立导出使评估可在 capture 的原始结果上离线重放。
 */
export async function runPipeline(raw, cleaned, maxResults = 5, cfgOverride = null) {
  const results = await qualityPipeline(raw, cleaned, cfgOverride);
  // 融合后可能超 maxResults（如英文 intlBing+ddgs 各返回满额），截断保持"最多 N 条"语义
  const capped = results.slice(0, maxResults);
  const bestCov = capped.length ? Math.max(...capped.map((r) => r.coverage ?? 0)) : 0;
  return { results: capped, bestCov };
}

const HEALTH_CONFIG = {
  minEngines: 2,               // 只有 1 路引擎应答 → 无跨引擎校验（单路被污染时没有交叉验证）
  maxZeroCovRatio: 0.5,        // 半数以上结果与查询零词面重合 → 引擎明显退化
  lowCovFloor: 0.30,           // 配合 zeroCov 用的"整体偏低"参考线（不单独触发，见下）
  badZeroCovRatio: 0.4,        // 与低覆盖同时出现才判无关
  degradedMemTtlMs: 90 * 1000, // 降级结果只在内存留 90s，避免同一查询被反复轰炸
};

/** raw 里出现了几条不同的引擎来源（供 API 抢救闸门判断"是否单路"）。 */
function distinctSources(raw) {
  const s = new Set();
  for (const r of raw) for (const x of splitSources(r.source)) s.add(x);
  return s.size;
}

/** 引擎层统计：从 raw 结果按 source 归并，得出"几路引擎真在贡献"。 */
function finalizeStats(stats, raw) {
  const n = {}, ms = {};
  for (const r of raw) {
    for (const s of splitSources(r.source)) {
      n[s] = (n[s] || 0) + 1;
      if (r.__ms !== undefined && ms[s] === undefined) ms[s] = r.__ms;
    }
  }
  stats.engines = Object.keys(n).map((name) => ({ name, n: n[name] }));
  stats.contributing = stats.engines.length;
  stats.total = raw.length;
  return stats;
}

/**
 * 相关性健康度判定（2026-09-12 新增）。
 *
 * 背景：四路引擎会被真实限流（baidu 验证墙 / sogou 反爬 / cn.bing 单字退化 / intlBing 代理抖动）。
 * 实测"微信小程序 虚拟支付 个人主体"在 baidu+sogou 双双被限流时，最终 10 条里 7 条 coverage=0
 * （含 Yahoo 日本天气页），best=0.20 —— 而 RANK_CONFIG.covFloor 要求 best≥0.40 才启动，
 * 于是地板防护永不触发，这批垃圾还会被当"正常结果"写进 6h 缓存，之后 6 小时查什么都返回它。
 *
 * 这里不改排序（改排序会伤害健康态结果），只做两件事：
 *   ① 让调用方/用户看得见"本次是降级结果"；② 降级结果不写盘、只留 90s 内存。
 */
export function assessHealth(capped, stats) {
  const reasons = [];
  const covs = capped.map((r) => r.coverage ?? 0);
  const bestCov = covs.length ? Math.max(...covs) : 0;
  const zeroCov = covs.filter((c) => c === 0).length;
  const zeroCovRatio = capped.length ? zeroCov / capped.length : 1;
  const contributing = stats?.contributing ?? 0;

  // ① 单引擎：没有跨引擎交叉校验（中文链尤其危险——cn.bing 单路对长中文查询会退化成单字匹配）
  if (contributing < HEALTH_CONFIG.minEngines) {
    reasons.push(`single-engine(${contributing})`);
  }
  // ② 无关结果占多数 + 整体覆盖偏低 → 引擎退化。
  // 注意：**不能**用"bestCov 低"单独判降级。实测反例：导航型查询（"http-server npm"、
  // 查 nodejs.org 首页）本身就低覆盖但结果正确；v5 缓存里 24.8% 条目 bestCov<0.4，
  // 逐条看大多是正常导航结果。只有"零词面重合占多数"才是真无关（实测限流场景 7/10=70%）。
  if (zeroCovRatio > HEALTH_CONFIG.badZeroCovRatio && bestCov < HEALTH_CONFIG.lowCovFloor) {
    reasons.push(`irrelevant-heavy(${zeroCov}/${capped.length} zero-coverage, best=${bestCov.toFixed(2)})`);
  }

  return {
    ok: reasons.length === 0,
    degraded: reasons.length > 0,
    reasons,
    bestCov: +bestCov.toFixed(3),
    zeroCov,
    contributing,
    engines: (stats?.engines || []).map((e) => `${e.name}:${e.n}`),
  };
}

/** 上次搜索的健康度（测试/评估诊断用）。 */
let _lastHealth = null;
export function __lastSearchHealth() { return _lastHealth; }

export async function routeSearch(query, maxResults = 5) {
  const cleaned = cleanQuery(query);
  if (!cleaned) throw new Error("Empty query");

  const isCn = queryLanguage(cleaned) === "cn";
  // 缓存键带 cn/en 上下文 + 管线版本，避免国内外结果互相污染；v5 = 引擎层/管线层拆分 + 后续排序重构（与 v4 隔离）
  const cacheKey = `${cleaned}|${isCn ? "cn" : "en"}|v5`;
  // EVAL_NO_CACHE=1 时彻底绕过缓存，保证评估测的是实时结果而非历史缓存
  const noCache = process.env.EVAL_NO_CACHE === "1";
  if (!noCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const { raw, stats } = await fetchRawResults(cleaned, maxResults);
  if (raw.length === 0) throw new Error("All search engines returned no results");

  const { results: capped } = await runPipeline(raw, cleaned, maxResults);
  const health = assessHealth(capped, stats);
  health.rawTotal = raw.length;
  health.query = cleaned;
  // 显式带上引擎层诊断（而非只依赖 assessHealth 里的隐式展开），便于 __lastSearchHealth 排查
  health.apiEngine = stats.apiEngine;
  if (stats.apiError) health.apiError = stats.apiError;
  _lastHealth = health;

  if (noCache) return capped;

  if (!health.ok) {
    console.error(
      `[search-core] DEGRADED search (${health.reasons.join(", ")}) | engines=${health.engines.join(" ") || "none"} raw=${raw.length} ` +
      `→ not cached: "${cleaned.slice(0, 40)}"`,
    );
    // 降级结果只留 90s 内存：既不锁死 6h，又不至于同一查询被立刻重复打满引擎
    memCache.set(cacheKey, { expire: Date.now() + HEALTH_CONFIG.degradedMemTtlMs, results: capped });
    return capped;
  }
  if (health.bestCov < 0.12) {
    // 保留旧门控作为兜底（健康但整体低覆盖的英文链查询）
    console.error(`[search-core] low-coverage gate (best=${health.bestCov}), skip cache: "${cleaned.slice(0, 40)}"`);
    return capped;
  }
  cacheSet(cacheKey, capped);
  return capped;
}

// ── 站内搜索（方案 6 升级：多引擎融合；2026-09 中文加 sogou+intl） ──
/**
 * site_search 底座：多引擎 site: 算子 + 结果层 hostname 后过滤（含子域）。
 * 中文查询：cn.bing + sogou（国内直连双路）+ 百度补深索引 + intlBing（代理 best-effort，中文站内也常更准）；
 * 英文查询：intlBing 主（国际必应 site: 索引全）+ ddgs 补 + cn.bing 国内兜底。
 * 引擎失败静默降级（百度验证墙/代理未开都不崩），融合后按域过滤 + URL 去重。
 */
export async function siteSearch(domain, query, maxResults = 5) {
  const d = normalizeDomain(domain);
  const q = cleanQuery(query);
  const siteQuery = `site:${d} ${q}`;
  const broad = Math.max(maxResults * 2, 10); // 每引擎多取，融合后收窄
  const safe = (p) => Promise.resolve(p).catch(() => []);

  const isCn = queryLanguage(q) === "cn";
  const pulls = isCn
    ? [safe(searchCnBing(siteQuery, broad)), safe(searchSogou(siteQuery, broad)), safe(searchBaidu(siteQuery, broad)), safe(searchIntlBing(siteQuery, broad))]
    : [safe(searchIntlBing(siteQuery, broad)), safe(searchDdgs(siteQuery, broad)), safe(searchCnBing(siteQuery, broad))];

  const merged = (await Promise.all(pulls)).flat();

  const seen = new Set();
  const filtered = [];
  for (const r of merged) {
    const h = extractDomain(r.url);
    if (!(h === d || h.endsWith("." + d))) continue;
    const key = normalizeUrl(r.url).key;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(r);
    if (filtered.length >= maxResults) break;
  }
  return filtered;
}
