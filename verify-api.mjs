#!/usr/bin/env node
/**
 * verify-api.mjs — 搜索 API 引擎的端到端验证（拿到 key 后跑这一条即可）
 *
 * 做三件事：
 *   ① 报告密钥是否被读到（以及从哪读到的）
 *   ② 对若干中文查询，分别用「API 引擎单独」与「当前生产链路（可能被反爬）」取结果，并排对比
 *   ③ 给出覆盖率/零覆盖条数/健康度，明确回答"是否值得启用"
 *
 * 用法：
 *   node verify-api.mjs                                  # 自动按优先级选 provider
 *   node verify-api.mjs "查询1" "查询2"                   # 自定义查询
 *   API_PROVIDER=zhipu node verify-api.mjs               # **强制只测智谱**（配了多家时必用）
 *   API_PROVIDER=bocha node verify-api.mjs
 *
 * 为什么要 API_PROVIDER（2026-09-21 补）：searchApi 是按优先级
 * `tavily > bocha > zhipu` 取**首个**配了 key 的，所以一家配多个 key 时，
 * 这里永远只报最高优先级那家，另外几家**根本没被测到**。
 * 想逐家对比就得能强制指定，否则"验证过了"只是验证了其中一家。
 */
import { searchApi, apiEngineAvailable, routeSearch, __lastSearchHealth, termCoverage } from "./search-core.mjs";
// provider 选择逻辑统一在 eval/lib.mjs 的 selectProvider() 里（api-ab.mjs / api-score.mjs 共用），
// 避免三处各写一遍、又各自走偏。
import { selectProvider, KNOWN_PROVIDERS } from "./eval/lib.mjs";

const { provider: which, forced, allConfigured } = selectProvider();
console.log(`API 引擎可用: ${apiEngineAvailable()}   provider: ${which || "(未配置)"}${forced ? "  [已强制指定]" : ""}`);
if (allConfigured.length > 1) {
  console.log(`注意：共配了 ${allConfigured.length} 家（${allConfigured.join("/")}），默认只测优先级最高的那家。`);
  console.log(`      要逐家验证请用：API_PROVIDER=<name> node verify-api.mjs`);
}
if (!which) {
  console.log("\n未读到密钥。推荐放**环境变量**（env 优先级高于文件，不必写进任何文件）：");
  console.log("  [Environment]::SetEnvironmentVariable('ZHIPU_API_KEY','你的key','User')   # 最便宜：0.01元/次");
  console.log("  [Environment]::SetEnvironmentVariable('TAVILY_API_KEY','你的key','User')  # 每月1000次免费");
  console.log("  [Environment]::SetEnvironmentVariable('BOCHA_API_KEY','你的key','User')   # 中文合规/多模态卡");
  process.exit(1);
}

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["微信小程序 虚拟支付 个人主体", "微信小程序 流量主 开通条件", "docker 数据卷 挂载", "nginx 反向代理 配置"];

function summarize(res, q) {
  const covs = res.map((x) => termCoverage(q, x.title, x.snippet));
  return {
    n: res.length,
    best: covs.length ? Math.max(...covs).toFixed(2) : "-",
    zero: `${covs.filter((c) => c === 0).length}/${res.length}`,
    avgSnip: res.length ? Math.round(res.reduce((a, x) => a + (x.snippet || "").length, 0) / res.length) : 0,
  };
}

for (const q of QUERIES) {
  console.log(`\n════════ ${q}`);
  let apiRes = [];
  try {
    apiRes = await searchApi(q, 5);
  } catch (e) {
    console.log(`  ❌ API 引擎报错: ${e.message}`);
  }
  const api = summarize(apiRes, q);
  console.log(`  【API 引擎】n=${api.n} best=${api.best} 零覆盖=${api.zero} 平均摘要=${api.avgSnip} 字`);
  apiRes.slice(0, 5).forEach((x, i) => {
    let h = ""; try { h = new URL(x.url).hostname; } catch {}
    console.log(`     ${i + 1}. ${h.padEnd(28)} ${x.title.slice(0, 44)}`);
  });

  process.env.EVAL_NO_CACHE = "1"; // 生产链路强制走实时，避免缓存掩盖反爬状态
  let prodRes = [];
  try { prodRes = await routeSearch(q, 5); } catch (e) { console.log(`  ❌ 生产链路报错: ${e.message}`); }
  const h = __lastSearchHealth() || {};
  const prod = summarize(prodRes, q);
  console.log(`  【生产链路】n=${prod.n} best=${prod.best} 零覆盖=${prod.zero} engines=${(h.engines || []).join(" ") || "-"} ${h.ok ? "OK" : "DEGRADED"}`);

  const verdict = api.n === 0 ? "API 无结果" :
    (Number(api.best) > Number(prod.best) && api.zero.split("/")[0] < prod.zero.split("/")[0])
      ? "★ API 明显更好" : "持平或需人工判断";
  console.log(`  → ${verdict}`);
}
