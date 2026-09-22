#!/usr/bin/env node
/**
 * api-parsers.test.mjs — 搜索 API 引擎（tavily / bocha / zhipu）离线回归测试
 *
 * 为什么需要这个文件：截至 2026-09-20，`parseZhipuResponse` / `parseBochaResponse`
 * **在离线套件里完全没有覆盖**（parsers.test.mjs 只测了 Tavily）。Grep 已确认：
 * 两个函数仅在 search-core.mjs 内部与需真 key 的 verify-api.mjs / eval/api-*.mjs 里被引用。
 * 后果是契约写错时**要等你花了钱调用才会发现**——而"花了钱却拿不到结果"是最难自查的失败。
 *
 * 本文件用 `__setFetchImpl` 注入构造响应，直接调**真实的** searchApi / parseBochaResponse /
 * parseZhipuResponse，并同时断言**请求体**（而不是只断言响应解析）——因为对这两家来说，
 * 请求体写错（如漏传 count）同样会造成"能跑但结果不对"。
 *
 * 契约依据（2026-09-20 核对官方原文，非猜测）：
 *   · 智谱 docs.bigmodel.cn/cn/guide/tools/web-search 的响应示例：
 *       { created, id, request_id, search_intent:[...], search_result:[{ content, icon, link,
 *         media, publish_date, refer, title }] }
 *     文档参数表另确认：count 范围 1–50 **默认 10**；content_size = medium(默认)/high。
 *   · 博查 open.bochaai.com 首页 "API 响应内容" 段：
 *       { _type:"SearchResponse", queryContext:{originalQuery},
 *         webPages:{ webSearchUrl, totalEstimatedMatches,
 *                    value:[{ id,name,url,siteName,siteIcon,snippet,summary,datePublished }] } }
 *     官方 curl 示例的请求体：{ query, freshness:"oneYear", summary:true, count:8 }
 *
 * 用法：node eval/api-parsers.test.mjs
 */
import {
  __setFetchImpl, searchApi, parseBochaResponse, parseZhipuResponse, __reloadApiKeys, __setRegistryFallback,
} from "../search-core.mjs";

/**
 * 密封密钥来源（2026-09-21 补，起因是一次真实事故）：
 *
 * `loadApiKeys()` 现在有三个来源——环境变量、`api-keys.json`、**Windows 用户注册表**
 * （见 search-core 的"密钥来源"注释）。本文件的断言是"某 provider 的请求体长这样"，
 * 它**隐式假设**当时生效的 provider 就是它正在测的那一家。
 *
 * 事故现场：本机 HKCU\Environment 里配了真 tavily key。测 **zhipu** 解析器时，
 * `searchApi` 按优先级走了 **tavily**，`__setFetchImpl` 注入的 zhipu fixture 根本没被命中，
 * 于是**真的发出了网络请求**，拿到真实回包后抛：
 *   Error: Tavily response shape unexpected (keys=created,id,request_id,search_intent,search_result)
 * 这比"测试失败"更糟：它悄悄打了真实付费 API，且报错信息指向"响应结构异常"，
 * 把归因引向契约问题，而根因是 provider 被抢走。
 *
 * 关掉注册表兜底即可密封（环境变量与文件在本套里都没配 key）。
 * `provider-select.test.mjs` 有同样的假设，同样需要关。
 */
const _registryWasOn = __setRegistryFallback(false);
process.on("exit", () => { try { __setRegistryFallback(_registryWasOn); } catch { /* 忽略 */ } });
__reloadApiKeys();

let pass = 0, fail = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// ── 注入工具 ────────────────────────────────────────

let lastRequest = null;
/** 注入一个返回固定 JSON 的 fetch；同时记录最后一次请求以便断言请求体。 */
function withJson(json, status = 200) {
  lastRequest = null;
  __setFetchImpl(async (url, init) => {
    lastRequest = { url: String(url), init, body: init?.body ? JSON.parse(init.body) : null };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => json,
    };
  });
}
function setKeys({ tavily = "", bocha = "", zhipu = "" }) {
  process.env.TAVILY_API_KEY = tavily;
  process.env.BOCHA_API_KEY = bocha;
  process.env.ZHIPU_API_KEY = zhipu;
  __reloadApiKeys();
}

// ═══════════════════════════════════════════════════════
console.log("\n═══ 1. 智谱 parseZhipuResponse（官方响应示例原样） ═══");
// 取官方文档示例逐字段构造，验证 title/link/content/media/publish_date 都被正确映射
const ZHIPU_OK = {
  created: 1748261757,
  id: "20250526201557dda85ca6801b467b",
  request_id: "20250526201557dda85ca6801b467b",
  search_intent: [{ intent: "SEARCH_ALL", keywords: "2025年4月 财经新闻", query: "搜索2025年4月的财经新闻" }],
  search_result: [
    {
      content: "一、1-4月我国对外直接投资575.4亿美元，同比增长7.5%。以旧换新成效持续显现，家电类商品零售额连续8个月保持两位数增长。",
      icon: "https://sfile.chatglm.cn/searchImage/sohu_icon_new.jpg",
      link: "https://www.sohu.com/a/897879632_121123890",
      media: "搜狐",
      publish_date: "2025-05-23",
      refer: "ref_1",
      title: "2025年5月23日财经早资讯",
    },
    {
      content: "第二条结果的摘要内容，用于验证多条映射。",
      link: "https://example.com/second",
      media: "示例站",
      publish_date: "2025-05-20",
      title: "第二条",
    },
  ],
};
{
  const r = parseZhipuResponse(ZHIPU_OK, 5);
  t("智谱：解析出 2 条", r.length === 2, `got ${r.length}`);
  t("智谱：title 取自 title 字段", r[0]?.title === "2025年5月23日财经早资讯", r[0]?.title);
  t("智谱：url 取自 link 字段（不是 url）", r[0]?.url === "https://www.sohu.com/a/897879632_121123890", r[0]?.url);
  t("智谱：snippet 取自 content 字段", /对外直接投资575/.test(r[0]?.snippet || ""), r[0]?.snippet);
  t("智谱：publish_date 映射到 datePublished", r[0]?.datePublished === "2025-05-23", r[0]?.datePublished);
  t("智谱：media 映射到 siteName", r[0]?.siteName === "搜狐", r[0]?.siteName);
  t("智谱：source 标记为 zhipu", r[0]?.source === "zhipu", r[0]?.source);
  t("智谱：maxResults 生效（取 1 条）", parseZhipuResponse(ZHIPU_OK, 1).length === 1);
}

console.log("\n═══ 2. 智谱 字段缺失/脏数据容错 ═══");
{
  const dirty = {
    search_result: [
      { title: "无链接的条目", content: "应被过滤（url 缺失）" },
      { link: "https://example.com/no-title", content: "应被过滤（title 缺失）" },
      { title: "非法 URL 条目", link: "not-a-url", content: "应被过滤" },
      { title: "正常条目", link: "https://example.com/ok", content: "应保留" },
    ],
  };
  const r = parseZhipuResponse(dirty, 5);
  t("智谱：过滤掉缺 title/url/非法URL 的条目，只留 1 条", r.length === 1, `got ${r.length}: ${r.map(x => x.url).join(" ")}`);
  t("智谱：保留的是正常条目", r[0]?.url === "https://example.com/ok", r[0]?.url);

  // 兼容 data 包一层（部分网关形态）
  const wrapped = { data: { search_result: [{ title: "包一层的", link: "https://example.com/wrapped", content: "x" }] } };
  t("智谱：兼容 data.search_result 包一层形态", parseZhipuResponse(wrapped, 5)[0]?.url === "https://example.com/wrapped");
}

console.log("\n═══ 3. 博查 parseBochaResponse：**data.webPages.value**（官方 SDK 证实的真实形态） ═══");
// 契约依据：BochaAI/bocha-search-mcp → src/bocha_search_mcp/server.py
//   88:  resp = response.json();  if "data" not in resp: → "Search error."
//   97:  for result in data["webPages"]["value"]:
// 即回包是 { data: { webPages: { value: [...] } } }，而**不是**首页示例的顶层 webPages。
// 这是主路径（已证实），顶层形态只作容错——两者都必须能解析。
const BOCHA_PAGE = {
  id: "https://api.bochaai.com/v1/#WebPages.0",
  name: "阿里巴巴发布2024年ESG报告 持续推进减碳与数字化普惠",
  url: "https://www.alibabagroup.com/document-1752073403914780672",
  siteName: "阿里巴巴集团",
  siteIcon: "https://th.bochaai.com/favicon?domain_url=...",
  snippet: "阿里巴巴集团发布《 2024 财年环境、社会和治理（ ESG ）报告 》（下称“报告”）...",
  summary: "报告显示，阿里巴巴扎实推进减碳举措，全集团自身运营净碳排放和价值链碳强度继续实现“双降”。",
  datePublished: "2024-07-22T00:00:00+08:00",
};
const BOCHA_DATA = {
  _type: "SearchResponse",
  queryContext: { originalQuery: "告诉我阿里巴巴2024年ESG报告的重点" },
  data: {
    webPages: {
      webSearchUrl: "https://bochaai.com/search?q=...",
      totalEstimatedMatches: 606721,
      value: [JSON.parse(JSON.stringify(BOCHA_PAGE))],
    },
  },
};
{
  let r = [];
  let threw = null;
  try { r = parseBochaResponse(BOCHA_DATA, 5); } catch (e) { threw = e.message; }
  t("博查：data 包装形态（官方 SDK 证实）解析成功", threw === null, String(threw));
  t("博查：解析出 1 条", r.length === 1, threw || `got ${r.length}`);
  t("博查：name 映射到 title", /阿里巴巴发布2024年ESG报告/.test(r[0]?.title || ""), r[0]?.title);
  t("博查：summary 优先于 snippet（长摘要更有信息量）", /扎实推进减碳/.test(r[0]?.snippet || ""), r[0]?.snippet);
  t("博查：datePublished 映射正确", r[0]?.datePublished === "2024-07-22T00:00:00+08:00", r[0]?.datePublished);
  t("博查：siteName 映射（官方也在输出里展示站点名）", r[0]?.siteName === "阿里巴巴集团", r[0]?.siteName);
  t("博查：source 标记为 bocha", r[0]?.source === "bocha", r[0]?.source);
}

console.log("\n═══ 3b. 博查：顶层 webPages 作为容错（首页示例的简写形态） ═══");
{
  // 首页 "API 响应内容" 段写的是顶层 webPages —— 那是展示用简写、不是真实回包，
  // 但既然见过，就容错支持，万一某天官方真改成这样也不会全线失效。
  const topLevel = { _type: "SearchResponse", webPages: { value: [JSON.parse(JSON.stringify(BOCHA_PAGE))] } };
  let r = [];
  let threw = null;
  try { r = parseBochaResponse(topLevel, 5); } catch (e) { threw = e.message; }
  t("博查：顶层 webPages 形态也容错解析", threw === null && r.length === 1, thrown => String(threw));
  t("博查：两种形态字段映射一致", r[0]?.url === BOCHA_PAGE.url && r[0]?.siteName === "阿里巴巴集团", JSON.stringify(r[0]));
}

console.log("\n═══ 4. 博查：脏数据过滤 ═══");
{
  const dirty = { data: { webPages: { value: [{ name: "无url" }, { url: "https://example.com/noname" }, { name: "好", url: "https://example.com/good" }] } } };
  t("博查：过滤脏条目只留 1 条", parseBochaResponse(dirty, 5).length === 1);
  t("博查：maxResults 生效（取 1 条时只回 1 条）", parseBochaResponse({ data: { webPages: { value: [BOCHA_PAGE, BOCHA_PAGE] } } }, 1).length === 1);
}

console.log("\n═══ 5. 鉴权失败必须归因到 key，而不是误报“契约变更” ═══");
{
  // 401 + 无 search_result 字段（真实的错误响应形态）
  let msg = "";
  try { parseZhipuResponse({ error: { code: "401", message: "invalid api key" } }, 5); } catch (e) { msg = e.message; }
  t("智谱 401：错误信息提示检查密钥", /密钥|key/i.test(msg), msg);
  t("智谱 401：给出申请地址", /bigmodel\.cn/.test(msg), msg);

  let msg2 = "";
  try { parseZhipuResponse({ unexpected: true }, 5); } catch (e) { msg2 = e.message; }
  t("智谱 契约变更：提示结构不符（不误导去改 key）", /契约变更/.test(msg2) && !/密钥无效/.test(msg2), msg2);

  let msg3 = "";
  try { parseBochaResponse({ code: 403, message: "quota exceeded" }, 5); } catch (e) { msg3 = e.message; }
  t("博查 403 额度用尽：提示检查密钥/额度", /额度|密钥/.test(msg3), msg3);
  t("博查 403：给出申请地址", /bochaai\.com/.test(msg3), msg3);
}

console.log("\n═══ 6. searchApi 请求体：count 必须传（官方默认 10，不传就白处理一倍） ═══");
{
  setKeys({ zhipu: "test-zhipu-key" });
  withJson(ZHIPU_OK);
  const r = await searchApi("测试查询", 5);
  t("智谱：命中 zhipu 端点", /open\.bigmodel\.cn\/api\/paas\/v4\/web_search/.test(lastRequest?.url || ""), lastRequest?.url);
  t("智谱：POST 方法", lastRequest?.init?.method === "POST", lastRequest?.init?.method);
  t("智谱：Authorization 带 Bearer", /^Bearer test-zhipu-key$/.test(lastRequest?.init?.headers?.Authorization || ""), lastRequest?.init?.headers?.Authorization);
  t("智谱：用了最便宜的 search_std 档", lastRequest?.body?.search_engine === "search_std", lastRequest?.body?.search_engine);
  t("智谱：**传了 count**（漏传会默认返回 10 条）", lastRequest?.body?.count === 5, JSON.stringify(lastRequest?.body));
  t("智谱：content_size=high（按次计费，加长摘要不加钱）", lastRequest?.body?.content_size === "high", JSON.stringify(lastRequest?.body));
  t("智谱：返回 2 条且 source 正确", r.length === 2 && r[0].source === "zhipu", `got ${r.length}`);

  // count 夹紧：官方范围 1–50，越界会 400
  withJson(ZHIPU_OK);
  await searchApi("测试查询", 999);
  t("智谱：count 超过 50 被夹紧（官方上限）", lastRequest?.body?.count === 50, String(lastRequest?.body?.count));
  withJson(ZHIPU_OK);
  await searchApi("测试查询", 0);
  t("智谱：count 为 0 时兜底为 5（不传 0）", lastRequest?.body?.count === 5, String(lastRequest?.body?.count));
}

console.log("\n═══ 7. searchApi 请求体：博查与官方 SDK 源码逐项对齐 ═══");
{
  setKeys({ bocha: "test-bocha-key" });
  withJson(BOCHA_DATA);
  await searchApi("测试查询", 8);
  const body = lastRequest?.body;
  t("博查：命中 bocha 端点", /api\.bochaai\.com\/v1\/web-search/.test(lastRequest?.url || ""), lastRequest?.url);
  t("博查：带 utm_source（与官方 SDK 一致）", /utm_source=/.test(lastRequest?.url || ""), lastRequest?.url);
  t("博查：传了 count（官方范围 1–50，SDK 默认 10）", body?.count === 8, JSON.stringify(body));
  t("博查：summary=true（官方把 summary 当 Description 用）", body?.summary === true, JSON.stringify(body));
  t("博查：freshness 跟随官方 SDK 的 noLimit", body?.freshness === "noLimit", JSON.stringify(body));
  t("博查：Authorization 带 Bearer", /^Bearer test-bocha-key$/.test(lastRequest?.init?.headers?.Authorization || ""), lastRequest?.init?.headers?.Authorization);
  t("博查：query 原样传出", body?.query === "测试查询", JSON.stringify(body));

  // count 夹紧（官方 1–50）
  withJson(BOCHA_DATA);
  await searchApi("q", 999);
  t("博查：count 超过 50 被夹紧（官方上限）", lastRequest?.body?.count === 50, String(lastRequest?.body?.count));

  // freshness 可用环境变量收窄
  process.env.BOCHA_FRESHNESS = "oneMonth";
  withJson(BOCHA_DATA);
  await searchApi("q", 5);
  t("博查：BOCHA_FRESHNESS 可收窄时间范围", lastRequest?.body?.freshness === "oneMonth", JSON.stringify(lastRequest?.body));
  delete process.env.BOCHA_FRESHNESS;
}

console.log("\n═══ 8. provider 优先级：首个配置了 key 的胜出 ═══");
{
  // 三家都配 → tavily 胜（这是当前代码契约；想换引擎要清空更高优先级的 key）
  setKeys({ tavily: "k-t", bocha: "k-b", zhipu: "k-z" });
  withJson({ results: [{ title: "T", url: "https://example.com/t", content: "tavily 结果" }] });
  await searchApi("q", 5);
  t("三家都配时走 tavily（优先级最高）", /api\.tavily\.com/.test(lastRequest?.url || ""), lastRequest?.url);

  // 只有 bocha → bocha
  setKeys({ bocha: "k-b", zhipu: "k-z" });
  withJson(BOCHA_DATA);
  await searchApi("q", 5);
  t("清空 tavily 后走 bocha", /api\.bochaai\.com/.test(lastRequest?.url || ""), lastRequest?.url);

  // 只有 zhipu → zhipu（推荐配置：最便宜 + 中文最好）
  setKeys({ zhipu: "k-z" });
  withJson(ZHIPU_OK);
  await searchApi("q", 5);
  t("只配 zhipu 时走 zhipu", /open\.bigmodel\.cn/.test(lastRequest?.url || ""), lastRequest?.url);

  // 都没配 → 静默返回空数组（系统行为与"没有此引擎"完全一致，且**不许发请求**）
  setKeys({});
  let called = false;
  __setFetchImpl(async () => { called = true; throw new Error("不该被调用"); });
  const none = await searchApi("q", 5);
  t("未配置任何 key：返回空数组", Array.isArray(none) && none.length === 0, JSON.stringify(none));
  t("未配置任何 key：不发任何网络请求", called === false, `called=${called}`);
}

console.log("\n═══ 9. HTTP 错误：不得静默吞掉 ═══");
{
  setKeys({ zhipu: "k-z" });
  withJson({ error: { code: "401", message: "invalid api key" } }, 401);
  let m = "";
  try { await searchApi("q", 5); } catch (e) { m = e.message; }
  t("智谱 HTTP 401：抛错且带状态码", /401/.test(m), m);

  setKeys({ bocha: "k-b" });
  withJson({ code: 429, message: "rate limit exceeded" }, 429);
  let m2 = "";
  try { await searchApi("q", 5); } catch (e) { m2 = e.message; }
  t("博查 HTTP 429：抛错且带状态码", /429/.test(m2), m2);
}

__setFetchImpl(null);

// 退出清理：同 parsers.test.mjs 的处理。本文件全程走注入 fetch，
// 但 search-core 导入时可能因 HTTP(S)_PROXY 安装 ProxyAgent，
// 未关闭的 agent socket 会在退出期触发 libuv teardown 断言硬崩（约半数概率 0xC0000409）。
try {
  const { getGlobalDispatcher } = await import("undici");
  const { directDispatcher } = await import("../search-core.mjs");
  await Promise.allSettled([getGlobalDispatcher()?.close?.(), directDispatcher()?.close?.()]);
} catch { /* 清理失败不影响断言结论 */ }

console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL ==`);
process.exitCode = fail ? 1 : 0;
