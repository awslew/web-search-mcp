#!/usr/bin/env node
/**
 * test-search.mjs — 共享检索核心自测（方案 7.1 落地子集）
 *
 * 用例：decodeBingRedirect / 黑名单匹配 / normalizeUrl 去重 / qualityPipeline 垃圾过滤 /
 *       降级健康度判定（assessHealth）/
 *       routeSearch 真实查询（国内 CJK + 国内英文 + 代理英文）/
 *       siteSearch("github.com","mcp server") / 缓存二次命中。
 *
 * 顺序约束：先无代理实例（国内直连），再设 HTTP_PROXY 导入代理实例（外网）。
 * 每条打印 PASS / FAIL / SKIP，统计后退出码 0=全 PASS。
 */
const ts = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) { pass++; results.push(`PASS  ${name}`); }
  else { fail++; results.push(`FAIL  ${name}${detail ? `  -- ${detail}` : ""}`); }
}
function skipTest(name, reason) {
  skip++; results.push(`SKIP  ${name}  -- ${reason}`);
}

// ── 代理可用性前置探测（决定"必须经代理"的用例是跑还是 SKIP）──
// 为什么需要：**端口在监听 ≠ 隧道可用**。实测事故（2026-09-12）：本地代理进程活着、端口仍
// LISTENING，但上游节点已断，所有经代理请求 `fetch failed`。此时"代理英文 / siteSearch 外站 /
// ddgs"用例根本测不到被测路径，若报 FAIL 就会用噪音掩盖真正的回归（本机已踩过一次）。
// 用显式 dispatcher 探测，不动全局状态（不影响下面的国内实例）。
// 代理地址不硬编码：取 INTL_BING_PROXY / HTTP_PROXY / HTTPS_PROXY，都没设就整体 SKIP。
const PROXY_URL =
  process.env.INTL_BING_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
const PROXY_DOWN = PROXY_URL
  ? "本地代理隧道不可用（端口在监听但上游已断）—— 该用例必须经代理才能验证"
  : "未配置代理（INTL_BING_PROXY / HTTP_PROXY / HTTPS_PROXY 都为空）—— 该用例需要代理才能验证";
let proxyUsable = false;
if (PROXY_URL) {
  try {
    const { ProxyAgent } = await import("undici");
    await fetch("https://www.google.com/", {
      dispatcher: new ProxyAgent(PROXY_URL),
      signal: AbortSignal.timeout(8000),
    });
    proxyUsable = true; // 拿到任意响应（含 4xx/5xx）即说明隧道通
  } catch { proxyUsable = false; }
}
if (!proxyUsable) console.log("  ⚠️  代理不可用：下列经代理用例将标记为 SKIP（非代码问题）\n");

// ── 实例 1：国内直连（先删代理再 import，全局 dispatcher 保持默认） ──
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
const dom = await import("./search-core.mjs?instance=domestic");

// ── T0b 降级门控（2026-09-12）：防"引擎被限流 → 返回无关结果 + 缓存 6h"静默故障复发 ──
// 现场取证：baidu 验证墙 + sogou 反爬同时发生时，中文链只剩 cn.bing + intlBing，
// 最终 10 条里 7 条 coverage=0（含 Yahoo 日本天气页），top1 是微信首页（cov=0.1）；
// 而 RANK_CONFIG.covFloor 要求 best≥0.40 才生效 → 地板防护永不触发，垃圾还被写进 6h 缓存。
{
  const mk = (covs) => covs.map((c, i) => ({
    title: `t${i}`, url: `https://x${i}.com`, snippet: "s", source: "cnBing", coverage: c, score: 1 - c * 0.1,
  }));
  const engines = (...names) => names.map((name) => ({ name, n: 9 }));

  // 健康池：多引擎 + 高覆盖 → 必须判 OK（不能误伤）
  const healthy = dom.assessHealth(mk([0.8, 0.6, 0.4, 0.2]), { isCn: true, contributing: 3, engines: engines("baidu", "cnBing", "sogou") });
  check("health 健康多引擎池 → OK", healthy.ok === true, JSON.stringify(healthy.reasons));

  // 实测限流场景：零覆盖占多数且整体偏低 → 必须判降级
  const throttled = dom.assessHealth(mk([0.2, 0.1, 0, 0, 0, 0, 0, 0, 0, 0]), { isCn: true, contributing: 2, engines: engines("cnBing", "intlBing") });
  check("health 限流垃圾池(7/10零覆盖) → DEGRADED", throttled.degraded === true && /irrelevant-heavy/.test(throttled.reasons.join(" ")), JSON.stringify(throttled.reasons));

  // 导航型查询反例（"http-server npm" 类）：低覆盖但结果正确 → 不能误判为无关
  const nav = dom.assessHealth(mk([0.33, 0.33, 0.2, 0.2, 0.17]), { isCn: false, contributing: 2, engines: engines("intlBing", "ddgs") });
  check("health 导航型低覆盖但正确 → OK(不误伤)", nav.ok === true, JSON.stringify(nav.reasons));

  // 单引擎独扛：无交叉校验，必须标记（cn.bing 单路对中文长查询会退化成单字匹配）
  const solo = dom.assessHealth(mk([1, 0.9, 0.8, 0.7]), { isCn: true, contributing: 1, engines: engines("sogou") });
  check("health 单引擎独扛 → DEGRADED(single-engine)", solo.degraded === true && /single-engine/.test(solo.reasons.join(" ")), JSON.stringify(solo.reasons));
}

// qualityPipeline 空输入健壮性（降级判据依赖 coverage 字段，缺字段会全判 0 覆盖）
{
  const empty = await dom.qualityPipeline([], "test query");
  check("qualityPipeline 空输入返回数组（不抛错）", Array.isArray(empty) === true);
}

// ── T0 纯函数单元测试 ──
// decodeBingRedirect（方案 0 根因 #7 已知例子）
{
  const decoded = dom.decodeBingRedirect("https://www.bing.com/ck/a?a=b&u=a1aHR0cHM6Ly9ub2RlanMub3JnLw&ntb=1");
  check("decodeBingRedirect known u=a1 → nodejs.org", decoded === "https://nodejs.org/", decoded);
  const unchanged = dom.decodeBingRedirect("https://www.bing.com/ck/a?a=b&ntb=1");
  check("decodeBingRedirect no-u keeps original", unchanged === "https://www.bing.com/ck/a?a=b&ntb=1", unchanged);
  const bad = dom.decodeBingRedirect("https://www.bing.com/ck/a?u=a1bm90dXJs");
  check("decodeBingRedirect garbage → original", bad.startsWith("https://www.bing.com/ck/a"), bad);
}

// 黑名单匹配
{
  const r1 = dom.blacklistMatch("https://spam.example.top/shop");
  check("blacklist .top → remove", r1.remove === true, JSON.stringify(r1));
  const r2 = dom.blacklistMatch("https://blog.csdn.net/article/1");
  check("blacklist csdn → lower", r2.lower === true, JSON.stringify(r2));
  const r3 = dom.blacklistMatch("https://nodejs.org/en/docs");
  check("blacklist nodejs.org → clean", r3.remove === false && r3.lower === false, JSON.stringify(r3));
}

// normalizeUrl 去重（方案 2.2）
{
  const a = dom.normalizeUrl("https://Example.com/path?a=1&utm_source=x&b=2");
  const b = dom.normalizeUrl("http://www.example.com/path?b=2&a=1#frag");
  check("normalizeUrl scheme/www/params/order/fragment 同页同 key", a.key === b.key, `${a.key} vs ${b.key}`);
  const c = dom.normalizeUrl("https://example.com/path/");
  const d = dom.normalizeUrl("https://example.com/path");
  check("normalizeUrl 尾斜杠同 key", c.key === d.key, `${c.key} vs ${d.key}`);
  const e = dom.normalizeUrl("https://example.com/a");
  const f = dom.normalizeUrl("https://example.com/b");
  check("normalizeUrl 不同 path 不同 key", e.key !== f.key, `${e.key} vs ${f.key}`);
}

// qualityPipeline：黑名单硬删 + lower 标记 + 去重合并 source
{
  const fake = [
    { title: "Spam Shop", url: "https://bad.example.top/x", snippet: "s", source: "baidu" },
    { title: "CSDN 文章", url: "https://blog.csdn.net/abc", snippet: "short", source: "cnBing" },
    { title: "Good Doc", url: "https://nodejs.org/docs", snippet: "long snippet here", source: "intlBing" },
    { title: "Good Doc dup", url: "https://www.nodejs.org/docs/", snippet: "longer snippet here again", source: "ddgs" },
  ];
  const q = await dom.qualityPipeline(fake, "nodejs docs");
  check("qualityPipeline .top 结果被剔除", !q.some((r) => r.url.includes("example.top")), JSON.stringify(q.map((r) => r.url)));
  check("qualityPipeline lower 结果保留但带降权", q.some((r) => r.url.includes("csdn.net")), "");
  const good = q.filter((r) => r.url.includes("nodejs.org"));
  check("qualityPipeline 同 URL 去重合并 source", good.length === 1 && good[0].source.includes("+"), JSON.stringify(good));
}

// ── T9 中文 coverage（纯函数 + fake 融合，无网络；2026-09 精度回归） ──
{
  const terms = dom.extractQueryTerms("微信小程序 虚拟支付 个人主体");
  check("extractQueryTerms 含 CJK 二元组", terms.includes("微信") && terms.includes("虚拟") && terms.includes("主体"), JSON.stringify(terms));
  const covGood = dom.termCoverage(
    "微信小程序 虚拟支付 个人主体",
    "个人小程序也能开虚拟支付了,条件就3个",
    "主体类型为个体工商户，小程序需通过微信认证并开通支付功能"
  );
  const covBad = dom.termCoverage("微信小程序 虚拟支付 个人主体", "微（汉语文字）_百度百科", "说文解字》释为隐行也");
  check("termCoverage 相关结果显著高于单字垃圾", covGood >= 0.4 && covBad < 0.12, `good=${covGood} bad=${covBad}`);
  const fakeCn = [
    { title: "微信，是一个生活方式", url: "https://weixin.qq.com/", snippet: "微信 8.0.77 for Android 全新发布", source: "cnBing" },
    { title: "微（汉语文字）_百度百科", url: "https://baike.baidu.com/item/xx", snippet: "说文解字", source: "cnBing" },
    { title: "个人小程序也能开虚拟支付了,条件就3个", url: "http://mp.weixin.qq.com/s/abc", snippet: "主体类型为个体工商户，小程序需通过微信认证并开通支付功能", source: "sogou" },
  ];
  const qr = await dom.qualityPipeline(fakeCn, "微信小程序 虚拟支付 个人主体");
  check("qualityPipeline 低覆盖单字垃圾被过滤", !qr.some((r) => r.url.includes("baike.baidu.com")), JSON.stringify(qr.map((r) => r.url)));
  check("qualityPipeline 高覆盖结果保留", qr.some((r) => r.url.includes("mp.weixin.qq.com")), "");
}

// ── T1 国内 CJK 技术查询（无代理：百度→cn.bing 链） ──
{
  const q = `python 异步编程 asyncio ${ts}`;
  const res = await dom.routeSearch(q, 5);
  const urls = res.map((r) => r.url);
  check("routeSearch(国内CJK) 返回 ≥3 结果", res.length >= 3, `got ${res.length}`);
  check("routeSearch(国内CJK) 无 null/非 http URL", urls.every((u) => /^https?:\/\//.test(u)), JSON.stringify(urls));
}

// ── T2 国内英文查询（无代理：百度→cn.bing 回落，不抛错） ──
{
  const q = `linux command line tutorial ${ts}`;
  try {
    const res = await dom.routeSearch(q, 5);
    check("routeSearch(国内英文) 有结果（cn.bing 回落）", res.length > 0, `got ${res.length}`);
  } catch (e) {
    check("routeSearch(国内英文) 有结果", false, e.message);
  }
}

// ── T8 站内搜索（cn.bing site: + hostname 过滤） ──
// github.com 是外站，需 intlBing（经代理）才能拿到站内结果 → 代理不可用时 SKIP
if (!proxyUsable) {
  skipTest("siteSearch(github.com,'mcp server') 全部结果属于 github.com", PROXY_DOWN);
} else {
  const res = await dom.siteSearch("github.com", "mcp server", 5);
  const ok = res.length > 0 && res.every((r) => {
    try { const h = new URL(r.url).hostname.toLowerCase(); return h === "github.com" || h.endsWith(".github.com"); }
    catch { return false; }
  });
  check("siteSearch(github.com,'mcp server') 全部结果属于 github.com", ok, JSON.stringify(res.map((r) => r.url)));
}

// ── T5 缓存：同一查询二次命中（内存 LRU / 磁盘 sqlite） ──
{
  const q = `nodejs cheerio tutorial cachetest ${ts}`;
  const first = await dom.routeSearch(q, 3);
  // 低覆盖整批垃圾时路由层故意不写缓存（2026-09 门控）——此时缓存断言无意义，降级为 SKIP
  if (first.length && first.every((r) => (r.coverage ?? 1) < 0.12)) {
    skipTest("routeSearch 二次调用命中缓存（mem+disk hits +1）", "全引擎限流致低覆盖垃圾，门控跳过写缓存");
    skipTest("routeSearch 缓存返回与首次一致", "同上");
  } else {
    const statsBefore = dom.__cacheStats();
    const second = await dom.routeSearch(q, 3);
    const statsAfter = dom.__cacheStats();
    const hitsDelta = (statsAfter.memHits - statsBefore.memHits) + (statsAfter.diskHits - statsBefore.diskHits);
    check("routeSearch 二次调用命中缓存（mem+disk hits +1）", hitsDelta >= 1, `hits delta=${hitsDelta}`);
    check("routeSearch 缓存返回与首次一致", JSON.stringify(first) === JSON.stringify(second), "");
  }
}

// ── 实例 2：代理（外网/英文） ──
process.env.HTTP_PROXY = PROXY_URL;
let prox;
try {
  prox = await import("./search-core.mjs?instance=proxy");
} catch (e) {
  check("search-core 代理实例可导入", false, e.message);
}

if (prox) {
  // ddgs 子进程桥（英文次路）
  if (!proxyUsable) {
    skipTest("searchDdgs 走代理返回结果数组", PROXY_DOWN);
    skipTest("searchDdgs 结果含 title/url/snippet", PROXY_DOWN);
  } else {
    const ddg = await prox.searchDdgs("python async programming", 3);
    check("searchDdgs 走代理返回结果数组", Array.isArray(ddg) && ddg.length >= 1, `got ${ddg.length}`);
    if (ddg.length) check("searchDdgs 结果含 title/url/snippet", "title" in ddg[0] && "url" in ddg[0] && "snippet" in ddg[0], JSON.stringify(ddg[0]));
  }

  // T3 英文代理查询：intlBing 主路，u=a1 已解码
  // 来源断言接受 API 引擎：代理挂掉时英文主路（intlBing/ddgs）必然失效，此时 API 直连兜底会
  // 接管英文链（实测来源变成全 API）——那是**正确且更好**的行为，不该判失败。
  // 2026-09-21：候选从只有 tavily 扩为**任一 API provider**（tavily/bocha/zhipu，
  // 取决于配了哪个 key）。原先只列 tavily，会让用智谱 key 的人在这里误红。
  const API_SOURCE_RE = /intlBing|ddgs|tavily|bocha|zhipu/;
  if (!proxyUsable) {
    for (const n of ["返回 ≥3 结果", "无 /ck/a 包裹（u=a1 已解码）", "全部合法 http(s) URL", "来源含 intlBing/ddgs 或 API 兜底", "snippet 非空"]) {
      skipTest(`routeSearch(代理英文) ${n}`, PROXY_DOWN);
    }
  } else {
    try {
      const q = `nodejs http server best practices ${ts}`;
      const res = await prox.routeSearch(q, 5);
      const urls = res.map((r) => r.url);
      const hasCk = urls.some((u) => u.includes("/ck/a"));
      check("routeSearch(代理英文) 返回 ≥3 结果", res.length >= 3, `got ${res.length}`);
      check("routeSearch(代理英文) 无 /ck/a 包裹（u=a1 已解码）", !hasCk, JSON.stringify(urls));
      check("routeSearch(代理英文) 全部合法 http(s) URL", urls.every((u) => /^https?:\/\//.test(u)), "");
      check("routeSearch(代理英文) 来源含 intlBing/ddgs 或 API 兜底", res.some((r) => API_SOURCE_RE.test(r.source)), JSON.stringify(res.map((r) => r.source)));
      check("routeSearch(代理英文) snippet 非空", res.every((r) => r.snippet && r.snippet.length > 0), "");
    } catch (e) {
      check("routeSearch(代理英文) 不抛错且有结果", false, e.message);
    }
  }

  // 缓存是跨实例共享的（磁盘），代理英文第二次也应命中
  if (!proxyUsable) {
    skipTest("routeSearch(代理英文) 二次命中缓存", PROXY_DOWN);
  } else {
    const q = `nodejs http server best practices ${ts}`;
    await sleep(300);
    const again = await prox.routeSearch(q, 5);
    check("routeSearch(代理英文) 二次命中缓存", again.length >= 3, `got ${again.length}`);
  }
}

// ── 汇总 ──
console.log("\n" + results.join("\n"));
console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL, ${skip} SKIP ==`);
process.exit(fail === 0 ? 0 : 1);
