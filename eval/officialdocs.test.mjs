#!/usr/bin/env node
/**
 * officialdocs.test.mjs — **召回侧**「官方文档页独立检索」通道（离线，注入 fetch）
 *
 * 为什么单独一套（而不是并进 echo.test.mjs）：
 * echo.test.mjs 测的是**排序**（打分函数纯函数），本套测的是**引擎层接线** ——
 * 推断官方域 → 站内检索 → 并入 raw。两者失败时的归因完全不同，
 * 混在一起会让"接线错"伪装成"打分错"（本项目在 server-cn.mjs 上踩过同类坑：
 * 单测看不出接线）。
 *
 * 覆盖三件事：
 *   A. `inferOfficialDomain` 的**正例**（含别名与中文产品名）
 *   B. **反证**：泛化词不得推出域、别名表不得越权（值必须在 AUTHORITY_DOMAINS 内）
 *   C. **接线**：官方域进池 / 已进池时不重复灌水 / 第二段请求只在没有文档页时才发 /
 *      `EVAL_NO_API=1` 必须能整体关掉（否则离线评估不可复现）
 *
 * ⚠️ 全程注入 fetch + 密封 api-keys 与注册表 —— 本套**不发任何真实请求**。
 *    （不密封的话，本机注册表里的真 key 会让 `apiEngineAvailable()` 为 true，
 *      于是"官方域进池"的断言里会混进 API 结果，测不到本通道。
 *      本项目已有两次被真 key 击穿密封的真实事故记录，见 CHANGELOG §零之五。）
 */
import { __setRegistryFallback, __setFetchImpl, fetchRawResults, cleanQuery } from "../search-core.mjs";

let pass = 0, fail = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// ── 密封：真 key（api-keys.json / 注册表）不得参与 ────────────────────────────
delete process.env.EVAL_NO_API;
delete process.env.OFFICIAL_DOCS_PASS;
delete process.env.TAVILY_API_KEY;
delete process.env.BOCHA_API_KEY;
delete process.env.ZHIPU_API_KEY;
// 代理清掉：search-core 只在 HTTP_PROXY/HTTPS_PROXY 存在时装 ProxyAgent，
// 少一份 undici 句柄可显著降低 Windows 退出期 UV_HANDLE_CLOSING 断言崩溃概率
// （test-search.mjs / gate.test.mjs 同款做法）。
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
const registryWasOn = __setRegistryFallback(false);

const {
  inferOfficialDomain, officialDocsPassEnabled, OFFICIAL_ALIASES, AUTHORITY_DOMAINS,
} = await import("../search-core.mjs");

// ── A. 正例：推断必须命中真实官方域 ─────────────────────────────────────────
// 这 8 条用的是 `verify-quality.mjs` 同一批主题（那是**在线**对照用的常驻工具），
// 但断言只依赖"查询里有产品名"这一属性，不依赖任何 gold 标注文件。
const POSITIVE = [
  ["redis rdb aof 持久化 区别", "redis.io"],
  ["nginx reverse proxy 配置", "nginx.org"],
  ["mysql 索引 最左前缀原则", "mysql.com"],
  ["docker 数据卷 挂载", "docker.com"],
  ["python asyncio gather 用法", "python.org"],
  ["kubernetes liveness probe 配置", "kubernetes.io"],
  ["vue3 组合式 API setup 用法", "vuejs.org"],
  ["nodejs fs readFile 用法", "nodejs.org"],
  ["golang defer panic recover 顺序", "go.dev"],          // 别名
  ["k8s pod 调度 原理", "kubernetes.io"],                   // 别名
  ["微信支付 API v3 签名", "pay.weixin.qq.com"],            // 中文别名
  ["微信小程序 虚拟支付", "developers.weixin.qq.com"],      // 中文别名（§零之八 的失败样本）
];
for (const [q, want] of POSITIVE) {
  const got = inferOfficialDomain(q);
  t(`推断 ${want.padEnd(24)} ← ${q}`, got === want, `got=${got}`);
}

// ⚠️ **保守反例**（不是遗漏，是有意的行为契约）：`kafka` 推不出域。
// 原因：`AUTHORITY_DOMAINS` 收的是 `apache.org`，**没有** `kafka.apache.org`
// （见该清单的收录标准）。于是只剩两条路，都不能走：
//   ① `apache.org` 的最左段是 "apache"，查询里没有这个词；
//   ② 拿 "kafka" 去比 "apache" 属模糊档，而模糊档要求**词首相同**（kaf≠apa）——
//      正是这条规则挡住了 `setup`→`svelte` 那类假阳。
// 设计取舍：**推不出就不猜**。宁可这一条少一次站内召回，也不要拿"字母重合"去撞一个官方域 ——
// 撞错时灌进池里的页面还会因权威信号拿到 authScore 加成，那正是本信号要修的错误。
// （该场景当前并不吃亏：`kafka 消费者组 rebalance 机制` 的官方域本来就在池里、且排第 1。
//   若将来真要给 kafka 开站内召回，正确做法是把它加进 AUTHORITY_DOMAINS，而不是放松模糊匹配。）
t("保守：'kafka' 推不出域（清单里只有 apache.org，且模糊档要求词首相同）",
  inferOfficialDomain("kafka 消费者组 rebalance 机制") === null);

// ── B. 反证一：泛化词/无产品名的查询不得推出任何域 ───────────────────────────
// 假阳的代价不是"多一次请求"，而是**往池里灌一个不相关官方域的页面**，
// 它还会拿到 authScore 加成（恰是权威信号要修的那类错误）。
const NEGATIVE = [
  "如何做红烧肉",
  "顺丰 运费 收费标准",
  "个税 专项附加扣除 怎么算",
  "vscode 插件 推荐",
  "a b c",
  "",
];
for (const q of NEGATIVE) {
  const got = inferOfficialDomain(q);
  t(`不误推域 ← ${q || "(空查询)"}`, got === null, `got=${got}`);
}
// 单独反证 "setup"→"svelte"：这是实现时**实测出现过的**假阳
// （setup 与 svelte 编辑距离 2）。保留它是因为它正是"词首必须相同"这条规则的来源。
t("反证：'setup' 不得命中 svelte.dev（词首不同）", inferOfficialDomain("vue3 组合式 api setup") !== "svelte.dev");

// ── B2. 别名表的越权防护 ────────────────────────────────────────────────────
// 若别名表能指向 AUTHORITY_DOMAINS 之外的域，它就绕过了权威清单的收录标准
// （"第一方 + 独立可判定"），退化成一张随手加域的后门。
for (const [alias, dom] of OFFICIAL_ALIASES) {
  t(`别名表值在权威清单内: ${alias} → ${dom}`, AUTHORITY_DOMAINS.has(dom));
}
t("别名表键不含空格（必须是「通用叫法」而非整句查询）",
  [...OFFICIAL_ALIASES.keys()].every((k) => !/\s/.test(k)));

// ── C. 接线：假引擎（记录请求 URL，按 site: 返回可控结果）─────────────────────
const requested = [];
/**
 * 构造一个假引擎响应。
 * ⚠️ 形状必须与**真实解析器契约**一致（`.b_algo` + `h2 > a` + `.b_caption p`），
 * 否则本套测的是"我自己编的 HTML"，而不是接线（gate.test.mjs 的 fixture 真实性
 * 已经踩过一次坑：CHANGELOG §零之八「因 fixture 不真实而失败的测试」）。
 */
function mkEngineHtml(items) {
  const links = items.map((it) =>
    `<li class="b_algo"><h2><a href="${it.url}">${it.title}</a></h2>` +
    `<div class="b_caption"><p>${it.snippet || ""}</p></div></li>`).join("");
  return `<html><body><ol id="b_results">${links}</ol></body></html>`;
}
const OFFICIAL_ITEMS = [
  { url: "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/", title: "Redis persistence", snippet: "RDB AOF 持久化" },
  { url: "https://redis.io/docs/latest/commands/", title: "Commands", snippet: "命令参考" },
];
/**
 * 假引擎：**按请求类型分流**。
 *
 * 为什么必须分流（这是本套最容易把测试写成假绿的地方）：若主检索与 `site:` 检索
 * 返回同一批 URL，那么"官方域原本在池里"与"由本通道带进来"这两种情形**无法区分** ——
 * 而 C1/C2 的**全部意义**就是区分它们（stats 的 `inPoolBefore` 就是为此存在的）。
 * 实测踩到过：第一版不分流时 C1 的 `inPoolBefore` 为 true，场景根本没被构造出来。
 */
function mockEngines({ plainItems = [], siteItems = OFFICIAL_ITEMS } = {}) {
  requested.length = 0;
  __setFetchImpl(async (url) => {
    const u = String(url);
    requested.push(u);
    const isSite = /site%3A|site:/i.test(u);
    const items = isSite ? siteItems : plainItems;
    if (u.includes("bing.com")) return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => mkEngineHtml(items) };
    return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => mkEngineHtml([]) };
  });
}
/** 只数发往 cn.bing 的**站内**请求（其余引擎在本 fixture 下返回空页，数它们没有意义）。 */
const siteReqs = () => requested.filter((u) => u.includes("cn.bing.com") && /site%3A/i.test(u));

// C1 官方域**原本不在池里** → 本通道把它带进来（这正是 CHANGELOG §零之八 的剩余瓶颈形态）
mockEngines({ plainItems: [{ url: "https://www.runoob.com/redis/redis-tutorial.html", title: "Redis 教程", snippet: "菜鸟教程" }] });
{
  const q = cleanQuery("redis rdb aof 持久化 区别");
  const { raw, stats } = await fetchRawResults(q, 5);
  const inPool = raw.some((r) => String(r.url).includes("redis.io/docs/"));
  t("C1 官方文档页被并入 raw（本通道的核心目的）", inPool, JSON.stringify(raw.map((r) => r.url).slice(0, 6)));
  t("C1 结果带 officialDocs 来源戳", raw.some((r) => String(r.source || "").includes("officialDocs")));
  t("C1 stats 记录了推断出的官方域", stats.officialDocs?.dom === "redis.io", JSON.stringify(stats.officialDocs));
  t("C1 stats 记为「事前不在池里」（归因必需）", stats.officialDocs?.inPoolBefore === false, JSON.stringify(stats.officialDocs));
  t("C1 stats 记为「事前没有文档页」（归因必需）", stats.officialDocs?.docPageBefore === false);
}

// C2 官方域**已经在池里（但只有首页）** → stats 要如实区分"带进来"与"本来就有"
mockEngines({ plainItems: [{ url: "https://redis.io/", title: "Redis", snippet: "首页" }] });
{
  const q = cleanQuery("redis rdb aof 持久化 区别");
  const { stats } = await fetchRawResults(q, 5);
  t("C2 事前已在池里 → inPoolBefore=true", stats.officialDocs?.inPoolBefore === true, JSON.stringify(stats.officialDocs));
  t("C2 事前只有首页（无文档页）→ docPageBefore=false", stats.officialDocs?.docPageBefore === false);
}

// C3 第一段没捞到文档页（只有下载页）→ **必须**追加第二段（文档意图词）
mockEngines({
  plainItems: [{ url: "https://www.runoob.com/mysql/mysql-tutorial.html", title: "MySQL 教程", snippet: "菜鸟教程" }],
  siteItems: [{ url: "https://dev.mysql.com/downloads/", title: "MySQL Downloads", snippet: "下载" }],
});
{
  const q = cleanQuery("mysql 索引 最左前缀原则");
  const { stats } = await fetchRawResults(q, 5);
  t("C3 未捞到文档页 → 追加第二段请求", siteReqs().length >= 2, JSON.stringify(siteReqs().slice(0, 3)));
  const decoded = siteReqs().map((u) => decodeURIComponent(u));
  // 第二段必须是「产品 token + 文档意图词」：`site:mysql.com mysql reference guide documentation`
  // ⚠️ 这条断言锁的是**一次在线实测纠正过的错误**：第一版用的是「清洗后查询 + 文档词」，
  //    即 `site:mysql.com mysql 索引 最左前缀原则 文档 reference guide` —— 中文词面在英文官方站上
  //    零匹配，引擎退化成返回首页与 `/downloads/`（实测见 search-core 的 docsHintQuery 注释）。
  t("C3 第二段只含产品 token 与文档词（不带中文查询词）",
    decoded.some((u) => /site%3Amysql\.com mysql reference|site:mysql\.com mysql reference/.test(u) ||
      (u.includes("mysql") && u.includes("reference") && !/[\u4e00-\u9fff]/.test(u.split("q=")[1] || ""))),
    JSON.stringify(decoded.slice(0, 3)));
  t("C3 推断域记为 mysql.com（非 dev.mysql.com 子站）", stats.officialDocs?.dom === "mysql.com", JSON.stringify(stats.officialDocs));
  t("C3 子域结果仍算数（dev.mysql.com 属于 mysql.com）",
    stats.officialDocs?.inPoolBefore === false, JSON.stringify(stats.officialDocs));
}

// C3b 第一段**已**捞到文档页 → 不再发第二段（请求预算是本通道唯一的新增成本）
mockEngines({ plainItems: [{ url: "https://www.runoob.com/redis/redis-tutorial.html", title: "Redis 教程", snippet: "菜鸟教程" }] });
{
  const q = cleanQuery("redis rdb aof 持久化 区别");
  await fetchRawResults(q, 5);
  t("C3b 已捞到文档页 → 只发一段 site: 请求", siteReqs().length === 1, JSON.stringify(siteReqs().slice(0, 3)));
}

// C3c 官方站若**本来就是中文站**（中文产品名场景）→ 第二段必须保留原查询语义，
//     不得变成"中文查询 + 英文文档词"那种半吊子（那种查询实测只会捞回首页与下载页）。
mockEngines({
  plainItems: [{ url: "https://www.runoob.com/w3cnote/wx-miniprogram.html", title: "小程序教程", snippet: "菜鸟教程" }],
  siteItems: [{ url: "https://developers.weixin.qq.com/miniprogram/dev/framework/", title: "小程序开发文档", snippet: "开发" }],
});
{
  const q = cleanQuery("微信小程序 虚拟支付");
  await fetchRawResults(q, 5);
  const decoded = siteReqs().map((u) => decodeURIComponent(u));
  t("C3c 推不出产品 token 时第二段退回原查询（不做中英混排）",
    decoded.some((u) => u.includes("虚拟支付") && !/reference guide documentation/.test(u)),
    JSON.stringify(decoded.slice(0, 3)));
}

// C4 关掉开关 → 完全不参与（**离线评估可复现的前提**）
{
  __setFetchImpl(async () => { throw new Error("本通道关闭时不应发任何请求"); });
  process.env.OFFICIAL_DOCS_PASS = "0";
  t("C4 OFFICIAL_DOCS_PASS=0 时通道停用", officialDocsPassEnabled() === false);
  const q = cleanQuery("redis rdb aof 持久化 区别");
  const { raw, stats } = await fetchRawResults(q, 5);
  t("C4 停用时 raw 里没有本通道产物", !raw.some((r) => String(r.source || "").includes("officialDocs")));
  t("C4 停用时 stats 不记录 officialDocs", stats.officialDocs === undefined, JSON.stringify(stats.officialDocs));
  delete process.env.OFFICIAL_DOCS_PASS;
}

// C5 `EVAL_NO_API=1` 必须**同时**关掉本通道（否则离线重放会随引擎/代理状态漂移）
{
  process.env.EVAL_NO_API = "1";
  t("C5 EVAL_NO_API=1 时本通道停用（离线评估可复现）", officialDocsPassEnabled() === false);
  delete process.env.EVAL_NO_API;
}
t("C5 默认启用（未设任何环境变量）", officialDocsPassEnabled() === true);

// ── 收尾 ───────────────────────────────────────────────────────────────────
__setFetchImpl(null);
__setRegistryFallback(registryWasOn);
console.log(`\n${pass} PASS  ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
