#!/usr/bin/env node
/**
 * api-score.mjs — 用**同一批评估查询 + 同一套 gold 标注**给"搜索 API 引擎单独"打分，
 * 并与已记录的生产链路基线并排对比。回答一个明确问题：
 *
 *   「把中文链换成/接上 API，检索质量到底涨多少？」
 *
 * 为什么可以这样比：nDCG@5 的判定只依赖 gold 域（人造标注），
 * 所以"API 单独跑"与"生产链路跑"的分数是**同一把尺子量出来的**，可直接对照。
 *
 * 用法：
 *   node eval/api-score.mjs                 # 全部 30 条
 *   node eval/api-score.mjs cn              # 只跑中文
 *   node eval/api-score.mjs en              # 只跑英文
 *   BASE=result-v6-replay node eval/api-score.mjs   # 指定对比基线
 *   API_PROVIDER=zhipu node eval/api-score.mjs      # 配了多家时，指定评估哪一家
 */
import fs from "node:fs";
import path from "node:path";
import { searchApi, cleanQuery, apiEngineAvailable, termCoverage } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, loadQueries, scoreOne, aggregate, byLang, printReport, selectProvider } from "./lib.mjs";

const only = process.argv[2];
const BASE = process.env.BASE || "result-v6-replay";

const { provider, forced, allConfigured } = selectProvider();
if (!provider) {
  console.error("未配置搜索 API key。推荐放环境变量：ZHIPU_API_KEY / TAVILY_API_KEY / BOCHA_API_KEY");
  process.exit(1);
}
if (allConfigured.length > 1) {
  console.log(`注意：配了 ${allConfigured.length} 家（${allConfigured.join("/")}），本次评估 ${provider}${forced ? "（已指定）" : "（优先级最高者）"}。`);
}
console.log(`API provider = ${provider}   基线 = ${BASE}`);

const queries = loadQueries().filter((x) => !only || x.lang === only);
const rows = [];
for (const query of queries) {
  const cleaned = cleanQuery(query.q);
  let results = [];
  try {
    results = await searchApi(cleaned, MAX_RESULTS);
    // 补 coverage 便于与生产链路同口径观察（scoreOne 会读 r.coverage）
    results = results.map((r) => ({ ...r, coverage: termCoverage(query.q, r.title, r.snippet) }));
  } catch (e) {
    console.error(`[api-score] FAIL ${query.q} :: ${e?.message || e}`);
  }
  const s = scoreOne(query, results);
  rows.push(s);
  console.error(
    `[api-score] n=${String(s.n).padStart(2)} gold@${s.mrr ? String(s.mrr.toFixed(2)) : " - "}  ${query.q}`
  );
  await new Promise((r) => setTimeout(r, 300));
}

const payload = {
  tag: `api-only-${provider}`,
  mode: "api-only",
  provider,
  base: BASE,
  scope: only || "all",           // 本次只测了哪个语种（避免"只测英文却当成全部"）
  queryCount: rows.length,
  scoredAt: new Date().toISOString(),
  overall: aggregate(rows),
  byLang: byLang(rows),
  rows,
};
// 文件名带上所测范围：只测一家/一个语种时，避免与"全量、另一家"的结果互相覆盖或误读
const scopeSuffix = only ? `-${only}` : "";
const out = path.join(evalDir, `result-api-only-${provider}${scopeSuffix}.json`);
fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");

console.log(`\n########## API 引擎（${provider}）单独 ##########`);
if (only) console.log(`（本次只评估了 [${only}] 语种，共 ${rows.length} 条查询；数字不可与全量结果直接比较）`);
printReport(payload);

// ── 与生产链路基线并排 ──
const basePath = path.join(evalDir, `${BASE}.json`);
if (fs.existsSync(basePath)) {
  const B = JSON.parse(fs.readFileSync(basePath, "utf8"));
  console.log(`\n########## 对照：生产链路 ${BASE} ##########`);
  printReport({ ...B, tag: BASE });
  const keys_ = ["hit1", "hit3", "hit5", "mrr", "p5", "ndcg5", "junk"];
  console.log(`\n===== API 相对生产链路的提升 =====`);
  console.log(`metric      生产链路   API引擎    delta`);
  for (const k of keys_) {
    const bv = B.overall[k] ?? 0, av = payload.overall[k] ?? 0, d = av - bv;
    const flag = d > 0.0001 ? "  UP  +" : d < -0.0001 ? "  DOWN " : "  =     ";
    console.log(`${k.padEnd(11)} ${String(bv).padStart(8)} ${String(av).padStart(8)}${flag}${d.toFixed(4)}`);
  }
  console.log(`\n按语言 nDCG@5：`);
  for (const lang of ["cn", "en"]) {
    const b = B.byLang?.[lang], a = payload.byLang?.[lang];
    if (!b || !a) continue;
    const d = a.ndcg5 - b.ndcg5;
    console.log(
      `  [${lang}] 生产 ${b.ndcg5} → API ${a.ndcg5}   delta=${d >= 0 ? "+" : ""}${d.toFixed(4)}` +
        `   (hit@1 ${b.hit1}→${a.hit1}, MRR ${b.mrr}→${a.mrr})`
    );
  }
} else {
  console.log(`\n(未找到基线 ${basePath}，跳过对照)`);
}
console.log(`\nsaved -> ${out}`);
