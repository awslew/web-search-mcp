#!/usr/bin/env node
/**
 * echo.test.mjs — 回显惩罚 / RRF 打分单元测试
 *
 * 为什么单独测：评估集里没有"聚合页回显"这类样本（junk=0），
 * 用评估集无法证明 echoPenalty 有效，只能用合成用例锁定行为契约：
 *   必须罚 → 聚合页 / 标题复述整句 + 泛化词
 *   不能罚 → 官方文档短标题（防误伤 gold）
 */
import {
  echoPenaltyOf, rrfScore, __setRankConfig, __getRankConfig,
  authoritySignals, isSiteHomepage, extractDomain, runPipeline, ENGINE_WEIGHT,
  termCoverage, GENERIC_HOMEPAGE_COV_MAX,
} from "../search-core.mjs";

let pass = 0, fail = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

const saved = __getRankConfig();
__setRankConfig({ echoPenalty: 0.4, echoRatio: 0.8, rrfK: 20 });

// ── 应罚 ──
t("聚合页 image.baidu.com 直接罚",
  echoPenaltyOf("python venv", { url: "https://image.baidu.com/search/index?tn=baiduimage", title: "x" }) === 1);
t("标题复述整句+泛化词（图片大全）→ 罚",
  echoPenaltyOf("微信小程序 虚拟支付", { url: "https://a.com/x", title: "微信小程序 虚拟支付图片大全" }) === 1);
t("标题复述整句+泛化词（相关搜索）→ 罚",
  echoPenaltyOf("vue3 组合式 API", { url: "https://a.com/x", title: "vue3 组合式 API 相关搜索" }) === 1);
t("标题复述整句+泛化词（在线观看）→ 罚",
  echoPenaltyOf("rust ownership", { url: "https://a.com/x", title: "rust ownership 在线观看" }) === 1);

// ── 不应罚（防误伤） ──
t("官方文档短标题（Python asyncio.gather）不罚",
  echoPenaltyOf("python asyncio gather", { url: "https://docs.python.org/3/library/asyncio-task.html", title: "asyncio.gather" }) === 0);
t("无泛化词的高覆盖标题不罚",
  echoPenaltyOf("vue3 组合式 API setup", { url: "https://vuejs.org/api/", title: "vue3 组合式 API setup" }) === 0);
t("低覆盖标题不罚（覆盖率未达阈值）",
  echoPenaltyOf("python venv 虚拟环境", { url: "https://a.com/x", title: "python 教程" }) === 0);
t("空标题不罚",
  echoPenaltyOf("python venv", { url: "https://a.com/x", title: "" }) === 0);

// ── 关键回归：官方文档站不会被误杀 ──
const goldCases = [
  ["python venv 虚拟环境", "venv — Creation of virtual environments", "https://docs.python.org/3/library/venv.html"],
  ["docker 数据卷 挂载", "Volumes", "https://docs.docker.com/storage/volumes/"],
  ["redis 持久化 RDB AOF", "Redis persistence", "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/"],
  ["nginx 反向代理 配置", "NGINX Reverse Proxy", "https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/"],
  ["kubernetes liveness probe 配置", "Configure Liveness, Readiness and Startup Probes", "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/"],
];
for (const [q, title, url] of goldCases) {
  const p = echoPenaltyOf(q, { title, url });
  t(`gold 不误伤: ${title.slice(0, 42)}`, p === 0, `penalty=${p}`);
}

// ── RRF 契约：共识 > 单引擎头名 ──
__setRankConfig({ rrfK: 20, engineWeightedRrf: false });
const consensus = rrfScore({ intlBing: 3, ddgs: 3, sogou: 3, cnBing: 3 }); // 4 引擎都排第 3
const solo = rrfScore({ intlBing: 1 });                                     // 单引擎排第 1
t(`RRF 共识(4×rank3)=${consensus.toFixed(4)} > 单引擎头名=${solo.toFixed(4)}`, consensus > solo);

const better = rrfScore({ intlBing: 1, ddgs: 2 });
const worse = rrfScore({ intlBing: 2 });
t("RRF 单调性：rank 越小分越高", rrfScore({ a: 1 }) > rrfScore({ a: 5 }));
t("RRF 多引擎累加：双引擎命中 > 单引擎同 rank", better > worse);

// ── RRF 排序稳定性：engineWeightedRrf 开关不改变单调性 ──
__setRankConfig({ engineWeightedRrf: true });
t("加权模式下共识仍 > 单引擎头名", rrfScore({ intlBing: 3, ddgs: 3, sogou: 3, cnBing: 3 }) > rrfScore({ intlBing: 1 }));
__setRankConfig(saved);
t("__setRankConfig 可恢复配置", __getRankConfig().rankMode === saved.rankMode);

// ── ENGINE_WEIGHT 必须覆盖所有会出现在结果里的 source ──
// 为什么测这个（2026-09-21 修的真实疏漏）：`ENGINE_WEIGHT[eng] || 0.8` 这种兜底写法
// 会把**漏登记的引擎静默当成最低档 0.8**（= so360 那档）。新增搜索 API 时正踩了这个坑：
// tavily/bocha/zhipu 三个都不在表里。影响面核实后**仅限 legacy 排序路径**
// （生产 rrf + engineWeightedRrf:false 时权重不参与打分），但评估对比时会悄悄失真。
// 故断言"每个 source 都必须显式登记"，避免下次新增引擎再漏。
{
  const { ENGINE_WEIGHT } = await import("../search-core.mjs");
  // 实际会出现在结果 source 字段里的全部取值（来源：search-core.mjs 的各处 push 语句）
  const ALL_SOURCES = [
    "baidu", "baiduMobile", "so360", "sogou", "sogouWeixin", "cnBing", "intlBing", "ddgs", "bing",
    "tavily", "bocha", "zhipu",
  ];
  const missing = ALL_SOURCES.filter((s) => !(s in ENGINE_WEIGHT));
  t("ENGINE_WEIGHT 覆盖全部已知 source（漏登记会被静默当 0.8）", missing.length === 0, `缺: ${missing.join(",")}`);

  // 搜索 API 语义上是"权威、无抓取噪声"的一路，不该与被降权的 so360 同级
  for (const p of ["tavily", "bocha", "zhipu"]) {
    t(`${p} 权重不低于 so360（不是被降权的那类）`, (ENGINE_WEIGHT[p] ?? 0) > (ENGINE_WEIGHT.so360 ?? 0), `got ${ENGINE_WEIGHT[p]}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 权威源信号（2026-09-21 新增）：纯函数 + 接线验证
//
// 为什么这段必须有：权威信号是本项目**唯一直接按域名给分**的信号，
// 也是评估集上增益最大的一个。正因为"太好用"，它最容易被后人顺手调大 ——
// 评估集上 wAuthority=0.8 能让英文 nDCG 到 **1.0000**，但那是假象：
// 该评估集的 gold 全是官方域，"按权威度排序"在此天然接近满分。
// 故这里锁住：① 纯函数判定正确；② 权重为 0 时排序稳定；
//            ③ 权重大时确实改变排序（防"信号没接进打分"的假绿）。
// ══════════════════════════════════════════════════════════════════════════════
{
  const savedCfg = __getRankConfig();
  const ZERO = { wAuthority: 0, wTutorial: 0, wHomepage: 0, homepageCovMax: 0.15, multiResultBonus: 0 };

  // ── ① 纯函数 ──
  const S = (url, q = "") => authoritySignals(q, { url, domain: extractDomain(url) });

  t("权威域 → 满分", S("https://nodejs.org/api/fs.html").authority === 1);
  t("权威域子域也算（developers.weixin.qq.com）", S("https://developers.weixin.qq.com/miniprogram/dev/x").authority === 1);
  t("教程站 → tutorial 标记", S("https://www.runoob.com/redis/x.html").tutorial === 1);
  t("教程站不因路径像文档而变权威", S("https://www.runoob.com/docs/x.html").authority < 1);
  t("非权威但路径是文档 → 0.4", S("https://random-blog.example.com/docs/guide").authority === 0.4);
  t("普通博客页 → 0", S("https://random-blog.example.com/posts/1").authority === 0);
  t("主题官方方：查询含拉丁词且域名含之 → 0.6", S("https://www.sqlite.org/docs.html", "sqlite 事务 隔离级别").authority === 0.6);
  t("权威清单优先于主题匹配（不给 0.6）", S("https://nodejs.org/api/fs.html", "nodejs fs readFile").authority === 1);

  t("首页：根路径", isSiteHomepage("https://weixin.qq.com/") === true);
  t("首页：无斜杠", isSiteHomepage("https://weixin.qq.com") === true);
  t("文档页不是首页", isSiteHomepage("https://nodejs.org/api/fs.html") === false);
  t("权威域首页也判为首页（靠 covMax 保护，不靠域名）", isSiteHomepage("https://redis.io/") === true);

  // ── ② / ③ 接线：池里放一个教程站 + 一个官方文档，覆盖率刻意相当 ──
  const mk = (url, title, snippet) => ({ url, title, snippet, source: "cnBing", engineRank: { cnBing: 1 }, sources: ["cnBing"] });
  const pool = () => [
    mk("https://www.runoob.com/redis/rdb.html", "Redis RDB AOF 持久化", "redis 持久化 RDB AOF 教程"),
    mk("https://nodejs.org/api/fs.html", "Redis RDB AOF 持久化说明", "redis 持久化 RDB AOF 文档"),
  ];

  const off1 = await runPipeline(pool(), "redis 持久化 RDB AOF", 5, ZERO);
  const off2 = await runPipeline(pool(), "redis 持久化 RDB AOF", 5, ZERO);
  t("零权重两次排序一致（确定性）", off1.results.map((r) => r.url).join("|") === off2.results.map((r) => r.url).join("|"));

  const on = await runPipeline(pool(), "redis 持久化 RDB AOF", 5, { ...ZERO, wAuthority: 1.0, wTutorial: 0.3 });
  t("wAuthority 大时权威源排到第 1（信号确实参与打分）",
    (on.results[0]?.url || "").includes("nodejs.org") === true, JSON.stringify(on.results.map((r) => r.url)));
  const onTut = await runPipeline(pool(), "redis 持久化 RDB AOF", 5, { ...ZERO, wTutorial: 1.0 });
  t("wTutorial 大时教程站掉下去", (onTut.results[0]?.url || "").includes("nodejs.org") === true, JSON.stringify(onTut.results.map((r) => r.url)));

  // 泛首页：低覆盖的站点首页必须被罚下去（wHomepage 生效的反方向验证）
  const homePool = () => [
    mk("https://weixin.qq.com/", "微信，是一个生活方式", ""),
    mk("https://example.com/a", "微信 小程序 虚拟支付 说明", "微信 小程序 虚拟支付"),
  ];
  const homeOff = await runPipeline(homePool(), "微信 小程序 虚拟支付", 5, ZERO);
  const homeOn = await runPipeline(homePool(), "微信 小程序 虚拟支付", 5, { ...ZERO, wHomepage: 0.5 });
  t("wHomepage 把低覆盖泛首页罚下去",
    (homeOn.results[0]?.url || "").includes("example.com") === true, JSON.stringify(homeOn.results.map((r) => r.url)));
  t("同一池在零权重下泛首页不被罚（对照，证明上一条是权重带来的）",
    (homeOff.results[0]?.url || "").includes("weixin.qq.com") === true, JSON.stringify(homeOff.results.map((r) => r.url)));

  // 用**真实失败样本**锁住阈值量级：weixin.qq.com 首页对"微信 小程序 虚拟支付"的覆盖率实测 ≈0.167，
  // 必须落在常量之内，否则线上那个 bad case 又不会被罚（第一版把阈值设 0.15 就漏掉了它）。
  const realCov = termCoverage("微信 小程序 虚拟支付", "微信，是一个生活方式", "");
  t("真实失败样本 weixin.qq.com 首页的覆盖率落在阈值内",
    realCov <= GENERIC_HOMEPAGE_COV_MAX, `cov=${realCov.toFixed(3)} 需 ≤ ${GENERIC_HOMEPAGE_COV_MAX}`);
  t("该样本确实会被判为泛首页", authoritySignals("微信 小程序 虚拟支付", {
    url: "https://weixin.qq.com/", domain: "weixin.qq.com", coverage: realCov,
  }).homepage === 1);
  t("阈值必须保守：放宽会误伤 redis.io/ 这类正确官方入口", GENERIC_HOMEPAGE_COV_MAX <= 0.25, String(GENERIC_HOMEPAGE_COV_MAX));
  t("wAuthority 必须在收益平台段（≤0.30；评估集最优的 0.8 是过拟合）",
    (savedCfg.wAuthority ?? 0) <= 0.30, String(savedCfg.wAuthority));

  // ── ④ 地板例外：权威域不受低覆盖地板约束 ──
  // 动机（2026-09-21 在线实测，同一批池对照）：`vuejs.org`/`cn.vuejs.org` 在池里但 **cov=0.000**
  // （标题是 "Vue.js - The Progressive JavaScript Framework" 这类英文精确术语，不含中文查询词），
  // 于是被 covFloor **硬过滤**掉 —— 而地板是**过滤**，`wAuthority` 这种**加分项够不到它**。
  // 两个信号能力边界不对称，故给权威域开例外（仅 authScore ≥ 0.9 的"权威域"档）。
  const authPool = () => [
    mk("https://cn.vuejs.org/", "Vue.js - The Progressive JavaScript Framework", ""),                                  // cov=0
    mk("https://www.runoob.com/vue3/x.html", "vue3 组合式 API setup 用法 教程", "vue3 组合式 API setup 用法"),
  ];
  const noExc = await runPipeline(authPool(), "vue3 组合式 API setup 用法", 5, { ...ZERO, wAuthority: 0 });
  const withExc = await runPipeline(authPool(), "vue3 组合式 API setup 用法", 5, { ...ZERO, wAuthority: 0.18, wTutorial: 0.08 });
  t("wAuthority=0（总开关关闭）时零覆盖权威域被地板滤掉",
    noExc.results.every((r) => !String(r.url).includes("vuejs.org")), JSON.stringify(noExc.results.map((r) => r.url)));
  t("wAuthority>0 时权威域豁免地板、被救回",
    withExc.results.some((r) => String(r.url).includes("vuejs.org")), JSON.stringify(withExc.results.map((r) => r.url)));

  // 例外**不得滥用**：非权威的零覆盖结果不能因例外混入（否则等于废掉地板）
  const weakPool = () => [
    mk("https://random-blog.example.com/p/1", "无关页面", ""),                                                          // cov≈0，非权威
    mk("https://www.runoob.com/vue3/y.html", "vue3 组合式 API setup 用法", "vue3 组合式 API setup 用法"),
  ];
  const weak = await runPipeline(weakPool(), "vue3 组合式 API setup 用法", 5, { ...ZERO, wAuthority: 0.18, wTutorial: 0.08 });
  t("非权威的零覆盖结果不因例外混入（例外只认权威域档）",
    weak.results.every((r) => !String(r.url).includes("random-blog")), JSON.stringify(weak.results.map((r) => r.url)));

  __setRankConfig(savedCfg);
}

console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
