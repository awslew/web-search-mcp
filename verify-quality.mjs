/**
 * verify-quality.mjs — 权威源信号的在线验证（供新会话一条命令跑完，无需改代码）
 *
 * 为什么需要它：离线评估集是 09-12 的缓存，且 gold 与权威清单重合，**不能**证明线上效果。
 * 本脚本用**真实引擎**跑一组「官方源必然存在」的技术查询，并在**同一批原始池**上
 * 做「信号开 / 信号关」的对照 —— 池只取一次，避免被引擎波动污染（round-to-round 方差 ±2，
 * 逐次跑两遍是测不出来的，见 CHANGELOG §零之八）。
 *
 * 用法：
 *   npm run verify:quality                          # 走缓存（若今日已跑过则很快）
 *   CACHE_TTL_MINUTES=0 node verify-quality.mjs     # 强制真实网络
 *   CACHE_TTL_MINUTES=0 npm run verify:quality      # 同上，推荐写法
 *
 * ⚠️ 代理断流时的处置（2026-09-21 实测踩到，**不是代码问题**，别再重新诊断一遍）
 *   症状：本脚本 hit@5 偏低，且日志出现 `API via default dispatcher failed (fetch failed)`；
 *         同时 `curl -x http://127.0.0.1:<port> https://api.tavily.com/` 返回 000 / ECONNRESET，
 *         而**同一条 URL 直连返回 200** —— 说明是**订阅节点/隧道层**挂了（代理组自测延迟可能仍正常）。
 *   处置：临时摘掉代理变量，让它走直连（此时直连通常可达）：
 *     $env:HTTPS_PROXY=''; $env:HTTP_PROXY=''; CACHE_TTL_MINUTES=0 node verify-quality.mjs
 *   判据：只要**没有** `API via default dispatcher failed`，本次闸门就真的参与了，
 *         结果才算"完整生产链路"；否则 hit@5 的缺口不能归因到代码。
 */
import { fetchRawResults, runPipeline, cleanQuery, extractDomain, __getRankConfig, apiEngineAvailable } from "./search-core.mjs";

const CASES = [
  // 「官方域在权威清单里」的技术查询 —— 权威信号有机会发力
  // ⚠️ `official` 必须写**权威清单里真正存在的那个域形态**（不是"更精确的子域"）：
  //    本脚本两个用途都吃这个字段 —— ① 排名判定用 `endsWith` 后缀匹配（`apache.org` 能匹配
  //    `kafka.apache.org`，反向不成立）；② 召回归因要看"本通道实际推断出的域"。
  //    实测踩到过：原写 `kafka.apache.org`（**不在** AUTHORITY_DOMAINS 里，清单收的是 `apache.org`），
  //    于是推断不出域、本通道对该条不参与，而报告却显示"官方域"——归因会被自己误导。
  { q: "kafka 消费者组 rebalance 机制",      official: "apache.org" },
  { q: "golang defer panic recover 顺序",    official: "go.dev" },
  { q: "redis rdb aof 持久化 区别",          official: "redis.io" },
  { q: "微信支付 API v3 签名",               official: "pay.weixin.qq.com" },
  { q: "python asyncio gather 用法",         official: "python.org" },
  { q: "微信小程序 虚拟支付",                 official: "developers.weixin.qq.com" },
  // 已知薄弱项：官方文档页常常**不在池里**，排序信号无从发力（本轮已用官方文档召回通道修，见 §零之九）
  { q: "vue3 组合式 API setup 用法",          official: "vuejs.org" },
  { q: "mysql 索引 最左前缀原则",             official: "dev.mysql.com" },
];
const OFF = { wAuthority: 0, wTutorial: 0, wHomepage: 0, wMirror: 0, multiResultBonus: 0 };
const isOff = (dom, off) => dom === off || dom.endsWith("." + off);
const rankOf = (results, offDom) => results.findIndex((r) => isOff(extractDomain(r.url), offDom)) + 1;

// ── 环境自检（**必须在取池之前打印**）────────────────────────────────────────
// 为什么必须有：本脚本的"信号关"一列**同时**关掉了权威信号与 API 闸门之外的召回手段，
// 而 API 闸门是既有的召回侧手段之一。实测踩到过（§零之九 第一次运行）：代理上游节点断流
// 导致 **8/8 次 Tavily 调用全失败**，闸门整体哑掉，于是 hit@5 少 1 条 ——
// 若不先看环境，很容易把这 1 条当成"召回改动没做好"。先打印状态，结论才有归因基础。
console.log(`\n  环境自检：搜索 API 引擎 ${apiEngineAvailable() ? "可用（闸门开启）" : "**不可用**（无 key 或 EVAL_NO_API=1）"}`);
console.log(`            官方文档召回通道 ${process.env.OFFICIAL_DOCS_PASS === "0" || process.env.EVAL_NO_API === "1" ? "**已关闭**" : "开启"}`);
console.log(`            ⚠️ 若下方日志出现 "API via default dispatcher failed" → 本次闸门失效，`);
console.log(`               hit@5 的缺口可能只是"闸门哑了"而非改动没生效（见 CHANGELOG §零之九）。`);

console.log("\n  ── 逐条取**原始池**（只取一次，下面两种配置都在同一份池上跑）──");
const rows = [];
for (const c of CASES) {
  const cleaned = cleanQuery(c.q);
  const { raw, stats } = await fetchRawResults(cleaned, 20);
  const [prod, ctrl] = [
    await runPipeline(raw, cleaned, 5, null),
    await runPipeline(raw, cleaned, 5, OFF),
  ];
  rows.push({
    q: c.q, official: c.official, rawLen: raw.length,
    // ⚠️ `stats.engines` 是对象数组 `[{name,n}]`，**不是字符串数组** ——
    //    本行原写 `stats.engines.join("+")`，于是这一列一直打印 `[object Object]` 之外的空值
    //    （对象数组 join 出来是无意义的串），等于该列长期无声失效。现在按契约取 name。
    engines: (stats.engines || []).map((e) => (typeof e === "string" ? e : e.name)).join("+"),
    // 官方文档召回通道的战果（**本列是判断"召回侧改动是否真的生效"的唯一依据**）：
    // `有→无`/`无→有` 表示该查在本次运行中确实发生了"官方页进池/没进池"的变化。
    od: stats.officialDocs || null,
    rankProd: rankOf(prod.results, c.official),
    rankCtrl: rankOf(ctrl.results, c.official),
    inRaw: raw.some((r) => isOff(extractDomain(r.url), c.official)),
    top1: extractDomain(prod.results[0]?.url || ""),
  });
}

console.log("\n  查询                                  官方域                    池内? 池量 位置(开)  位置(关)  top1(开)");
for (const r of rows) {
  const mark = r.rankProd === 1 ? "★" : r.rankProd > 0 ? "○" : "✘";
  console.log(
    `  ${mark} ${r.q.padEnd(34)} ${r.official.padEnd(24)} ${(r.inRaw ? "有" : "无").padEnd(5)} ${String(r.rawLen).padEnd(4)} ${String(r.rankProd || "未出现").padEnd(9)} ${String(r.rankCtrl || "未出现").padEnd(9)} ${r.top1}`
  );
}

// ── 官方文档召回通道逐条归因（2026-09-21 第二轮新增）──────────────────────────
// 为什么必须单独一列：本通道的作用是"**让权威页先进池**"，它的效果**不体现在权重对照里**
// （两种权重配置用的是同一份池，池的组成对两列是共同背景）。没有这一列就无法回答
// "这次 hit@5 的变化，是排序改的还是召回改的"。
console.log("\n  官方文档召回通道（officialDocs）：");
for (const r of rows) {
  if (!r.od) { console.log(`  · ${r.q.padEnd(34)} 未参与（推断不出官方域 / 通道被关）`); continue; }
  const before = r.od.inPoolBefore ? "在池" : "不在池";
  const docB = r.od.docPageBefore ? "有文档页" : "无文档页";
  const mark = !r.od.inPoolBefore ? "★补召回" : r.od.docPageBefore ? "·已有" : "★补文档页";
  console.log(`  ${mark} ${r.q.padEnd(34)} ${r.od.dom.padEnd(24)} 事前:${before}/${docB} 本次召回 ${r.od.recalled} 条`);
}
const recalled = rows.filter((r) => r.od && r.od.recalled > 0).length;
const fixedRecall = rows.filter((r) => r.od && !r.od.inPoolBefore && r.od.recalled > 0).length;
const fixedDoc = rows.filter((r) => r.od && r.od.inPoolBefore && !r.od.docPageBefore && r.od.recalled > 0).length;
console.log(`\n  召回侧战果：参与 ${rows.filter((r) => r.od).length}/${rows.length} 条，` +
  `真召回 ${recalled} 条；其中「官方域原本不在池里」被补进来 ${fixedRecall} 条，` +
  `「原本只有首页/下载页」被补出文档页 ${fixedDoc} 条`);

const n = rows.length;
const h = (k) => rows.filter((r) => r[k] === 1).length;
const h5 = (k) => rows.filter((r) => r[k] >= 1 && r[k] <= 5).length;
console.log(`\n  汇总（同一批池，可比口径）：`);
console.log(`    信号开  hit@1=${h("rankProd")}/${n}   hit@5=${h5("rankProd")}/${n}`);
console.log(`    信号关  hit@1=${h("rankCtrl")}/${n}   hit@5=${h5("rankCtrl")}/${n}`);
console.log(`\n  若「池内?=无」：官方域根本没被引擎召回 → 属**召回**问题，排序信号无法修复（见 CHANGELOG §零之八 下一步）。`);
console.log(`  生产权重快照: wAuthority=${__getRankConfig().wAuthority} wTutorial=${__getRankConfig().wTutorial} wMirror=${__getRankConfig().wMirror} wHomepage=${__getRankConfig().wHomepage}`);
