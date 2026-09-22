#!/usr/bin/env node
/**
 * gate.test.mjs — API「抢救闸门」的**确定性分支测试**（2026-09-12 新增）
 *
 * 为什么必须有这个文件：现场引擎正常时只能观察到闸门**静默**的那一支；真正关键的
 * "单路时触发"分支如果没有确定性测试锁住，一旦回归就会**静默失效**——而这类静默失效
 * 本机已经踩过一次（百度改版导致 29/29 snippet 全空，而 28 条断言仍全绿）。
 *
 * 做法：用 `__setFetchImpl` 注入固定响应，精确构造"单引擎 / 双引擎"两种局面，两个分支都断言。
 *
 * 踩坑记录（首版测试即暴露，故写入注释防复发）：
 *   ① `searchBaiduMobile` 在"页面无结果"时**抛错并写入按查询键的 5 分钟负缓存**。
 *      因此每个场景必须用**不同查询**，否则第二个场景里 m.baidu 根本不会被调用。
 *   ② `stats.engines` 统计的是**最终 raw**（含 API 自身），判断"生产引擎几路"必须
 *      过滤掉 API 自己的 source，否则"1 路"和"2 路"都能被同一份 stats 蒙混通过。
 *
 * ⚠️ 2026-09-21 改为 **provider 无关**（原先硬编码 `api.tavily.com` 与 `!== "tavily"`）：
 *   本套原本写死 "tavily"，于是换成智谱/博查 key 时会出现两种坏情况——
 *   fixture URL 不再被命中 → API 结果恒为空 → A 场景断言失败（尚且会红，能发现）；
 *   而 `prodEngines` 按字面 `!== "tavily"` 过滤则可能**统计错路数**，把不该绿的判绿。
 *   现在按**实际配置的 provider** 动态选端点与 source 名，并在切 provider 时自动跳过
 *   （A/B 场景首个断言会报告 "skipped"），不会静默假绿。
 */
// 先清掉可能存在的真实 key，避免"本机配了 key"导致测试行为随环境漂移。
// 随后**由本测试显式注入一个测试 key**，保证三家的解析/闸门路径都能被固定覆盖。
delete process.env.TAVILY_API_KEY;
delete process.env.BOCHA_API_KEY;
delete process.env.ZHIPU_API_KEY;

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 让测试**真正密封**：临时把 `api-keys.json` 移开，并关掉注册表回退。
 *
 * 为什么必须这样做（2026-09-21 实测暴露）：
 *   `loadApiKeys()` 的密钥来源有**三个**——环境变量、同目录 `api-keys.json`、
 *   以及 **Windows 用户注册表**（2026-09-21 新增的兜底通道，见 search-core 的"密钥来源"注释）。
 *   上面只删了 env，另两个来源依然会被读到，于是：
 *     `api-keys.json` 里有 tavily key + `GATE_PROVIDER=zhipu`
 *     → `searchApi` 按优先级仍然走 **tavily** → 本套的 zhipu fixture 永不被命中
 *     → 结果 9 PASS / 2 SKIP，且 SKIP 理由是"本 provider 未产出结果（fixture 或契约变化）"，
 *       **把归因指向了错误的方向**（实际是 provider 被抢走，不是契约坏了）。
 *   而 `api-keys.json` 的注释恰好写着"推荐把 key 放这里（比注入 env 可靠）"，
 *   所以用户很可能真的把 key 填进文件 —— 那本套就会在他机器上悄悄失去覆盖。
 *   本文件开头"本机是否配了真 key 不会改变测试结论"这句承诺，靠删 env 是**做不到**的。
 *
 * 注册表那一层的密封尤其关键：本机 `HKCU\Environment` 里**确实有真 tavily key**，
 * 所以只清 env + 文件时，注册表兜底会把真 key 补回来 → 三家 provider 的覆盖全部失效、
 * 且症状与上面完全相同（静默 SKIP + 错误归因）。关它用 `__setRegistryFallback(false)`。
 *
 * 做法：把文件临时改成不含任何 key 的内容 + 关注册表回退，退出时（含异常）**无条件还原**。
 */
const keysPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api-keys.json");
const keysBackup = fs.existsSync(keysPath) ? fs.readFileSync(keysPath, "utf8") : null;
let keysTampered = false;
if (keysBackup !== null) {
  try {
    const parsed = JSON.parse(keysBackup);
    const scrubbed = { ...parsed };
    for (const k of ["tavily", "bocha", "zhipu"]) scrubbed[k] = "";
    // 只在文件里**确实有** key 时才动它 —— 平时（key 留空）本文件一个字节都不会被改
    if (JSON.stringify(scrubbed) !== JSON.stringify(parsed)) {
      // 防数据丢失：先在同一目录留一份备份。万一进程被硬杀（`exit` 处理器不执行），
      // 用户的真实 key 仍能从 api-keys.json.bak 找回，不会无声消失。
      fs.writeFileSync(keysPath + ".bak", keysBackup, "utf8");
      fs.writeFileSync(keysPath, JSON.stringify(scrubbed, null, 2), "utf8");
      keysTampered = true;
    }
  } catch { /* 文件缺失或非 JSON：忽略，环境变量路径仍可用 */ }
}
// 关掉注册表兜底的时机：必须在 `search-core.mjs` **import 之后**
// （import 前模块尚未加载，拿不到该导出）；但要在 `__reloadApiKeys()` **之前**，
// 否则缓存里可能已经混进注册表的真 key。见下方实际调用处。
//
// ⚠️ 初值必须是 `true`：这个变量会传给 exit 处理器的 `__setRegistryFallback` 做还原，
// 而进程启动时开关本来就是开的。（若写成 `false`，还原时会把用户机器上的兜底永久关掉——
// 更糟的是 `__setRegistryFallback(undefined)` 也走 false 分支，同样会误关。）
let registryWasOn = true;
function restoreKeysFile() {
  try { __setRegistryFallback(registryWasOn); } catch { /* 模块未加载时忽略 */ }
  if (!keysTampered || keysBackup === null) return;
  try {
    fs.writeFileSync(keysPath, keysBackup, "utf8");
    fs.rmSync(keysPath + ".bak", { force: true });
  } catch { /* 还原失败：备份文件仍在，可手工恢复，下面会提示 */ }
}
// 无论正常结束、断言失败还是抛异常，都必须还原
process.on("exit", restoreKeysFile);

/**
 * 选定的 provider 与对应端点/source 名。
 * 之所以由测试自己指定（而非跟随本机配置）：这样三家都能被固定覆盖，
 * 且本机是否配了真 key 不会改变测试结论。想测某一家时用
 * `GATE_PROVIDER=zhipu node eval/gate.test.mjs`。
 */
const PROVIDERS = {
  tavily: {
    envKey: "TAVILY_API_KEY",
    // 只让"选定 provider"这一家可用；另两家留空 → searchApi 必然走选定分支
    match: "api.tavily.com",
    encode: (u) => JSON.stringify({ results: [{ title: "docker 数据卷 挂载 权威说明", url: u, content: "数据卷 挂载 说明（仅 API 提供）", score: 0.9 }] }),
    source: "tavily",
  },
  bocha: {
    envKey: "BOCHA_API_KEY",
    match: "api.bochaai.com",
    // ⚠️ 必须用**真实回包形态** `data.webPages.value`。
    // 2026-09-21 修：原 fixture 写的是顶层 `webPages`（照抄官方**首页示例**），
    // 而官方 SDK 源码（BochaAI/bocha-search-mcp 的 server.py:88 `if "data" not in resp`）
    // 证实真实回包有 data 包装层。fixture 与生产契约不一致时，测试会"通过"但没测到真东西。
    encode: (u) => JSON.stringify({ data: { webPages: { value: [{ name: "docker 数据卷 挂载 权威说明", url: u, summary: "数据卷 挂载 说明（仅 API 提供）", siteName: "Docker Docs" }] } } }),
    source: "bocha",
  },
  zhipu: {
    envKey: "ZHIPU_API_KEY",
    match: "open.bigmodel.cn",
    encode: (u) => JSON.stringify({ search_result: [{ title: "docker 数据卷 挂载 权威说明", link: u, content: "数据卷 挂载 说明（仅 API 提供）" }] }),
    source: "zhipu",
  },
};
const WANT = process.env.GATE_PROVIDER;
if (WANT && !PROVIDERS[WANT]) { console.error(`未知 GATE_PROVIDER=${WANT}（可选 ${Object.keys(PROVIDERS).join("/")}）`); process.exit(1); }
const PROVIDER = PROVIDERS[WANT || "tavily"];
process.env[PROVIDER.envKey] = "gate-test-fake-key"; // 走 env，不依赖真实 api-keys.json
delete process.env.EVAL_NO_API;
// 本测试**全程走注入的 fetch，不需要真实网络**，故清掉代理环境变量：
// search-core 只在 HTTP_PROXY/HTTPS_PROXY 存在时才安装 ProxyAgent，清掉可少一份 undici 句柄，
// 显著降低 Windows 上 Node 退出期 `UV_HANDLE_CLOSING` 断言崩溃的概率（test-search.mjs 同款做法）。
// 与真实网络的隔离由 __setFetchImpl 保证，不依赖此处。
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

/**
 * ⚠️ **必须关掉「官方文档召回通道」**（2026-09-21 第二轮发现，症状是 5 条断言集体变红）。
 *
 * 为什么：本套件的断言建立在"**池子由假引擎独占**"这个前提上 ——
 *   ① 「生产引擎恰为 1 路」按 `stats.engines` 数路数；
 *   ② 「生产 raw 条数 < 12」按 `raw.length` 判闸门触发。
 * 而召回通道会**多发一路 `siteSearch`**，且本套件的假 fetch 对**任何**请求都返回那份
 * docker 兜底页（`mkEngineHtml` 里写死了 `docs.docker.com...`）—— 于是 5 条真·docker 文档页
 * 被灌进池：引擎数从 1 变 3，`raw` 从 5 涨到 15，闸门判据的两条前提**同时失效**。
 *
 * 这不是"fixture 不真实"（那种情况要改 fixture）：`docker 数据卷 挂载` 这个查询**本来就该**
 * 召回 `docs.docker.com` —— 真跑生产时它正是**正确**行为。问题在于**这套测试要测的是闸门分支，
 * 不是召回通道**，所以应当把被测对象之外的那一路显式关掉，而不是让它参与池子构造。
 * 该通道自身有 `eval/officialdocs.test.mjs`（45 项）专门覆盖，覆盖不丢。
 * （`OFFICIAL_DOCS_PASS=0` 只关这一路；不要用 `EVAL_NO_API=1`，那会把本套件的主角——API 闸门——一起关掉。）
 */
process.env.OFFICIAL_DOCS_PASS = "0";

const { __setFetchImpl, fetchRawResults, runPipeline, cleanQuery, apiEngineAvailable, __reloadApiKeys, __setRegistryFallback, directDispatcher } =
  await import("../search-core.mjs");
// 密封注册表兜底：本机 HKCU\Environment 里**确实有真 tavily key**，
// 不关它的话 GATE_PROVIDER=bocha/zhipu 的覆盖会全部失效（症状是静默 SKIP + 错误归因）。
registryWasOn = __setRegistryFallback(false);
__reloadApiKeys();

let pass = 0, fail = 0, skipped = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}
function skip(name, why) { skipped++; console.log(`SKIP  ${name}  (${why})`); }

const API_URL = "https://api-only.example.org/unique";
const Q = (suffix) => `docker 数据卷 挂载 ${suffix}`; // 每场景独立查询，避开百度负缓存

function mkResp(body, status = 200, isJson = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => (isJson ? "application/json" : "text/html") },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 只让指定引擎返回结果，其余返回空页 → 精确控制"生产引擎几路"。 */
/**
 * 只让指定引擎返回结果，其余返回空页 → 精确控制"生产引擎几路"与"生产 raw 条数"。
 *
 * 为什么要能控制条数（2026-09-21）：闸门判据已从"单引擎"改为"生产 raw 条数 < 12"
 * （见 search-core 的 PROD_RAW_RESCUE_FLOOR 推导）。于是"引擎路数"不再足以决定闸门开合——
 * 原 fixture 每路只给 1~2 条，2 路合计才 3 条，在新判据下**本就该触发**，
 * 于是"多路应静默"这条断言测的其实是**不真实的小样本**。
 *
 * ⚠️ 注意每路有条数上限：`routeSearch` 的请求宽度是 `Math.max(maxResults, 5) = 5`，
 * 所以**单路最多 5 条**，2 路最多 10 条 —— 想构造"raw ≥ 12 的健康局面必须至少 3 路引擎活着**
 * （与真实语料一致：健康中文查询 raw=13 是 4 路都在应答）。
 * 另注：本机 `.sogou` 域因反爬/回退有 5 分钟熔断，故每路用不同的 `sogou.com` 子域绕开。
 */
function mkEngineHtml(kind, u, n, tag = "") {
  if (kind === "baidu") {
    return `<html><body>` + Array.from({ length: n }, (_, i) =>
      `<div class="c-result result" tpl="www_index" data-log='{"mu":"${u(i)}","order":${i + 1}}'>
  <div class="c-result-content"><h3>docker 数据卷 挂载 官方文档 ${tag}${i}</h3>
  <div class="summary-gap_x">数据卷 挂载 说明：卷由 Docker 管理，位于宿主机文件系统中。</div></div>
</div>`).join("") + `</body></html>`;
  }
  if (kind === "sogou") {
    // sogou 解析器认 `.vrwrap` + `h3 > a`；真实 URL 从块的 [data-url] 还原。
    // ⚠️ 解析器还要求 `html.length >= 20000`（否则判为反爬墙页并写 5 分钟熔断），
    //    故这里必须填充到 20KB 以上，否则 sogou 那一路永远不贡献结果。
    const items = Array.from({ length: n }, (_, i) =>
      `<div class="vrwrap"><h3><a href="/link?url=enc">docker 数据卷 挂载 教程 ${tag}${i}</a></h3>
  <div data-url="${u(i)}"></div></div>`).join("");
    const pad = `<!--${"sogou-fixture-padding-".repeat(1000)}-->`;
    return `<html><body>${items}${pad}</body></html>`;
  }
  // cn.bing：`.b_algo` + `.b_caption p`
  return `<html><body>` + Array.from({ length: n }, (_, i) =>
    `<li class="b_algo"><h2><a href="${u(i)}">Volumes ${tag}${i}</a></h2>
<div class="b_caption"><p>Docker volumes are the preferred mechanism for persisting data ${tag}${i}.</p></div></li>`).join("") + `</body></html>`;
}

/**
 * 按引擎名生成互不重复的 URL（去重会吃掉重复项，必须每条都不同）。
 *
 * ⚠️ 域必须用**中性的非权威域**（2026-09-21 踩到）：
 * 原 fixture 用的是 `docs.docker.com`，而它**在 `AUTHORITY_DOMAINS` 里**
 * （docker.com 是通用官方文档域，收录标准见 search-core 的注释）。
 * 于是"权威加成"把生产结果抬到 API 结果之上，`A 抢救到达用户` 断言失败 ——
 * 但**失败的是 fixture 的真实性**，不是代码：真实世界里 docker 文档的官方域就该是 docs.docker.com，
 * 而本测试想验证的只是"API 结果能穿过管线到达用户"，与它是哪个域无关。
 * 换成 example.net 后，测试意图被纯净地测到（且不再受权威信号影响）。
 */
const bingUrl = (i) => `https://blog.example.net/tutorials/volumes-${i}/`;
const baiduUrl = (i) => `https://forum.example.net/threads/storage-${i}/`;
const sogouUrl = (tag) => (i) => `https://wiki.example.net/manuals/guide-${tag}-${i}/`;

const BING_HTML = mkEngineHtml("bing", bingUrl, 2);
const BAIDU_HTML = mkEngineHtml("baidu", baiduUrl, 1);

/**
 * sogou 的"无结果"响应**必须也是一个合法长度的页面**，不能是空串。
 *
 * 踩坑记录（2026-09-21，值得写下来）：`searchSogou` 有个反爬判据
 *   `html.length < 20000 && !html.includes("vrwrap")` → 判为墙页并**写入 5 分钟全局熔断**
 *   （`sogouWallUntil` 是模块级变量，跨查询、**跨场景**共享）。
 * 最初我在"不需要 sogou 结果"的场景里返回空串，于是第一个场景就把熔断点亮，
 * 后面所有场景的 sogou 全部 "wall backoff" —— 表现为"3 路引擎却只拿到 10 条"，
 * 而根因与闸门判据毫无关系。空页面**代码长度够**即可，不触发熔断，也自然产出 0 条结果。
 */
const sogouEmptyHtml = () => `<html><body><!--${"no-result-".repeat(2500)}--></body></html>`;

function mockEngines({ bing = 2, baidu = 0, sogou = 0 }) {
  __setFetchImpl(async (url) => {
    const u = String(url);
    if (u.includes(PROVIDER.match)) return mkResp(PROVIDER.encode(API_URL), 200, true);
    if (u.includes("cn.bing.com")) return mkResp(mkEngineHtml("bing", bingUrl, bing), 200);
    if (u.includes("m.baidu.com")) return mkResp(mkEngineHtml("baidu", baiduUrl, baidu), 200);
    if (u.includes("sogou.com")) {
      if (!sogou) return mkResp(sogouEmptyHtml(), 200); // 空但有长度 → 不触发熔断
      const mm = u.match(/sogou\.com\/(\w+)/);
      return mkResp(mkEngineHtml("sogou", sogouUrl(mm ? mm[1] : "default"), sogou), 200);
    }
    return mkResp("", 200); // 其他引擎 → 空
  });
}

const hasApi = (arr) => arr.some((r) => String(r.url).includes("api-only.example.org"));
/** 生产引擎（排除**当前 provider 的** source）——判断"几路"必须用它。 */
const prodEngines = (stats) =>
  stats.engines.map((e) => e.name).filter((n) => n !== PROVIDER.source).sort();
/** 反向检查：raw 里**只**应出现选定 provider 的 API 来源，不该混入别的 provider。 */
const apiSources = (arr) =>
  [...new Set(arr.map((r) => r.source).filter((s) => Object.prototype.hasOwnProperty.call(PROVIDERS, s)))];

console.log(`\n（provider = ${WANT || "tavily"}；用 GATE_PROVIDER=zhipu|bocha 可切换）`);

// ── 前置：引擎必须可用（否则整个测试无意义）──
t("前置：搜索 API 引擎可用（env 注入的测试 key 被读到）", apiEngineAvailable());
// 前置：召回通道必须已关 —— 否则下面"池子由假引擎独占"的断言会集体变红，
// 而症状看起来像闸门坏了（2026-09-21 第二轮实测踩到：5 条断言同时红）。
{
  const { officialDocsPassEnabled } = await import("../search-core.mjs");
  t("前置：官方文档召回通道已关（本套件要独占池子）", officialDocsPassEnabled() === false);
}

// ── 场景 A：单引擎（只有 cn.bing，5 条）→ 闸门应触发 ──
mockEngines({ bing: 5, baidu: 0 });
{
  const q = Q("alpha");
  const { raw, stats } = await fetchRawResults(cleanQuery(q), 5);
  const pe = prodEngines(stats);
  t("A 构造有效：生产引擎恰为 1 路（cnBing）", pe.length === 1 && pe[0] === "cnBing", JSON.stringify(pe));
  if (!hasApi(raw)) {
    skip("A 闸门触发：单路时并入 API 结果", "本 provider 未产出结果（fixture 或契约变化）");
    skip("A 抢救到达用户：管线输出含 API 结果", "同上");
  } else {
    t("A 闸门触发：单路时并入 API 结果", hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
    // 关键防假绿：并入的必须是**选定的那个 provider**，不能是别家（换 key 时最容易错）
    const srcs = apiSources(raw);
    t(`A 并入来源确为 ${PROVIDER.source}（防串 provider）`, srcs.length === 1 && srcs[0] === PROVIDER.source, JSON.stringify(srcs));
    const { results } = await runPipeline(raw, cleanQuery(q), 5);
    t("A 抢救到达用户：管线输出含 API 结果", hasApi(results), JSON.stringify(results.map((r) => r.url)));
  }
}

// ── 场景 A2：**2 路引擎但生产结果不足 12 条** → 闸门仍应触发 ──
// 这是 2026-09-21 新判据的核心分支：old 判据（`单引擎`）在这里会**静默**，
// 而受控 A/B 证明该情形恰恰是抢救收益的来源（raw=10 那条中文查询）。
// 缺了本场景，"判据从单引擎换成 raw 条数"这个改动就没有确定性测试锁住。
mockEngines({ bing: 5, baidu: 4 });
{
  const q = Q("alpha2");
  const { raw, stats } = await fetchRawResults(cleanQuery(q), 5);
  const pe = prodEngines(stats);
  const beforeApi = raw.filter((r) => !String(r.url).includes("api-only.example.org"));
  t("A2 构造有效：生产引擎为 2 路", pe.length === 2, JSON.stringify(pe));
  t("A2 构造有效：生产 raw 条数确实 < 12（新判据的触发条件）", beforeApi.length < 12, `raw=${beforeApi.length}`);
  t("A2 新判据生效：2 路但结果偏少时仍并入 API（旧判据在此会静默）", hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
}

// ── 场景 B：健康状态（cnBing + baidu + sogou 三路各 5 条，raw≥12）→ 闸门应静默 ──
// 对应真实语料：健康中文查询 raw=13（4 路都在应答）。因为单路请求宽度上限是 5，
// 这里必须凑够 **3 路** 才能越过 PROD_RAW_RESCUE_FLOOR=12。
mockEngines({ bing: 5, baidu: 5, sogou: 5 });
{
  const q = Q("beta");
  const { raw, stats } = await fetchRawResults(cleanQuery(q), 5);
  const pe = prodEngines(stats);
  const beforeApi = raw.filter((r) => !String(r.url).includes("api-only.example.org"));
  t("B 构造有效：生产引擎至少 2 路", pe.length >= 2, JSON.stringify(pe));
  t("B 构造有效：生产 raw 条数 ≥ 12（健康，不该触发闸门）", beforeApi.length >= 12, `raw=${beforeApi.length}`);
  t("B 闸门静默：结果充足时不并入 API 结果", !hasApi(raw), JSON.stringify(raw.map((r) => r.url)));

  const { results } = await runPipeline(raw, cleanQuery(q), 5);
  t("B 管线输出不含 API 结果（不稀释官方源）", !hasApi(results), JSON.stringify(results.map((r) => r.url)));
}

// ── 场景 E：门槛运行时覆盖 WEB_SEARCH_RESCUE_FLOOR ──
// 只测 rescueFloor() 的解析是不够的 —— 必须证明它**真的驱动闸门**（接错线就白搭）。
// 这里从两个方向各打一次，任一方向接错都会红：
//   · 门槛调得极低 → 本来该触发的薄弱局面（raw=5）必须**静默**
//   · 门槛调得极高 → 本来该静默的健康局面（raw≥12）必须**触发**
{
  mockEngines({ bing: 5, baidu: 0, sogou: 0 }); // 单路、raw=5 → 默认门槛下会触发
  {
    const q = Q("eps-low");
    process.env.WEB_SEARCH_RESCUE_FLOOR = "2";
    const { raw } = await fetchRawResults(cleanQuery(q), 5);
    t("E 门槛=2：raw=5 不再触发（证明覆盖真的接进了闸门）", !hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
    delete process.env.WEB_SEARCH_RESCUE_FLOOR;
  }
  mockEngines({ bing: 5, baidu: 5, sogou: 5 }); // 三路、raw≥12 → 默认门槛下静默
  {
    const q = Q("eps-high");
    process.env.WEB_SEARCH_RESCUE_FLOOR = "999";
    const { raw } = await fetchRawResults(cleanQuery(q), 5);
    t("E 门槛=999：健康局面也触发（反方向证明，防覆盖被写成单向）", hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
    delete process.env.WEB_SEARCH_RESCUE_FLOOR;
  }
  // 非法值必须回退默认，且**不得把闸门带偏**：单路 raw=5 在默认门槛下应触发
  mockEngines({ bing: 5, baidu: 0, sogou: 0 });
  {
    const q = Q("eps-bad");
    process.env.WEB_SEARCH_RESCUE_FLOOR = "not-a-number";
    const { raw } = await fetchRawResults(cleanQuery(q), 5);
    t("E 非法门槛值回退默认（闸门行为与未设时一致）", hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
    delete process.env.WEB_SEARCH_RESCUE_FLOOR;
  }
}

// ── 场景 C：控制变量开关 EVAL_NO_API=1 → 即使单路也不并入 ──
process.env.EVAL_NO_API = "1";
__reloadApiKeys();
mockEngines({ bing: 5, baidu: 0 });
{
  const q = Q("gamma");
  const { raw } = await fetchRawResults(cleanQuery(q), 5);
  t("C EVAL_NO_API=1 完全禁用 API（控制变量可用）", !hasApi(raw), JSON.stringify(raw.map((r) => r.url)));
}
delete process.env.EVAL_NO_API;

// ── 场景 D：API 报错时不拖垮主链路（单路引擎仍应返回结果）──
__reloadApiKeys();
__setFetchImpl(async (url) => {
  const u = String(url);
  if (u.includes(PROVIDER.match)) throw new Error("simulated network failure");
  if (u.includes("cn.bing.com")) return mkResp(BING_HTML, 200);
  return mkResp("", 200);
});
{
  const q = Q("delta");
  const { raw, stats } = await fetchRawResults(cleanQuery(q), 5);
  t("D API 抛错时不崩且保留引擎结果", raw.length >= 2, `raw=${raw.length}`);
  t("D API 错误被记录到 stats.apiError", Boolean(stats.apiError), JSON.stringify(stats.apiError));
  t("D API 抛错时不并入任何 API 结果", !hasApi(raw));
}

__setFetchImpl(null); // 恢复真实网络
// 回收本套件为隔离池子而设的开关（放在最后，且不改动其他套件的环境）
delete process.env.OFFICIAL_DOCS_PASS;

// 显式关闭 undici dispatcher：进程退出时若还有未关闭的 agent socket，会触发 libuv teardown
// 断言（实测 `npm test` 串跑时约**半数概率**硬崩 0xC0000409——四套断言其实全绿，但退出码异常
// 会误导 CI 与自动化判断）。显式 close 让它确定性退出。
try {
  const { getGlobalDispatcher } = await import("undici");
  await Promise.allSettled([getGlobalDispatcher()?.close?.(), directDispatcher()?.close?.()]);
} catch { /* 清理失败不影响断言结论 */ }

console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL${skipped ? `, ${skipped} SKIP` : ""} ==`);
// 用 exitCode 而非 process.exit()：search-core 被导入时会装 ProxyAgent，仍有未关闭的 socket，
// 强制退出会触发 libuv teardown 断言（实测串跑 npm test 时硬崩 0xC0000409），造成误判。
process.exitCode = fail ? 1 : 0;
