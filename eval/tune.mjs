#!/usr/bin/env node
/**
 * tune.mjs — 排序权重网格搜索（离线，基于 capture 的原始结果）
 *
 * 为什么：旧公式的权重是拍脑袋的。RRF 引入后，wRrf/wCoverage/echoPenalty 等
 * 存在组合空间，只能用评估集说话。本脚本在固定原始结果上穷举配置，
 * 输出按 nDCG@5 排序的排行榜 —— 选中的配置再写回 search-core.mjs 的默认值。
 *
 * 用法：node eval/tune.mjs <rawTag>
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline, __setRankConfig } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, loadQueries, scoreOne, aggregate } from "./lib.mjs";

const rawTag = process.argv[2] || "baseline";
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));

// 预清洗查询，避免每次重算
const items = store.items.map((it) => ({ ...it, q: it.q }));
console.log(`loaded ${items.length} captured queries from raw-${rawTag}.json`);

async function evaluate(cfg) {
  __setRankConfig(cfg);
  const rows = [];
  for (const item of items) {
    const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  const o = aggregate(rows);
  const cn = aggregate(rows.filter((r) => r.lang === "cn"));
  const en = aggregate(rows.filter((r) => r.lang === "en"));
  return { o, cn, en, rows };
}

const results = [];
async function tryCfg(label, cfg) {
  const { o, cn, en } = await evaluate(cfg);
  results.push({ label, cfg, o, cn, en });
  return o;
}

// ── Stage 0：旧公式基线（控制变量） ──
await tryCfg("LEGACY(旧公式)", { rankMode: "legacy" });
const base = results[0].o;
console.log(
  `\nLEGACY 基线: hit@1=${base.hit1} hit@3=${base.hit3} hit@5=${base.hit5} MRR=${base.mrr} nDCG@5=${base.ndcg5}`
);

// ── Stage 1：RRF 与 coverage 配比（bm25 先固定 0，中文恒 0） ──
console.log("\n[Stage 1] RRF vs coverage 配比 ...");
for (const wRrf of [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  for (const wCov of [1 - wRrf]) {
    for (const ew of [false, true]) {
      await tryCfg(`rrf=${wRrf} cov=${wCov.toFixed(2)} ew=${ew ? 1 : 0}`, {
        rankMode: "rrf", wRrf, wCoverage: wCov, wBm25: 0,
        engineWeightedRrf: ew, echoPenalty: 0, lowerPenalty: 0.15,
      });
    }
  }
}

results.sort((a, b) => b.o.ndcg5 - a.o.ndcg5 || b.o.mrr - a.o.mrr);
console.log("\n-- Stage 1 排行（top 8 by nDCG@5）--");
for (const r of results.slice(0, 8)) {
  console.log(
    `${r.label.padEnd(30)} nDCG@5=${r.o.ndcg5.toFixed(4)} MRR=${r.o.mrr.toFixed(4)} hit@3=${r.o.hit3.toFixed(3)} hit@1=${r.o.hit1.toFixed(3)}`
  );
}

const best1 = results[0];
console.log(`\nStage 1 最优: ${best1.label}`);

// ── Stage 2：在 Stage1 最优上扫 echoPenalty × lowerPenalty ──
console.log("\n[Stage 2] echoPenalty × lowerPenalty ...");
const stage2 = [];
for (const echoPenalty of [0, 0.15, 0.25, 0.4, 0.6, 0.8]) {
  for (const lowerPenalty of [0, 0.1, 0.15, 0.3]) {
    const cfg = { ...best1.cfg, echoPenalty, lowerPenalty };
    const { o, cn, en } = await evaluate(cfg);
    stage2.push({ label: `echo=${echoPenalty} lower=${lowerPenalty}`, cfg, o, cn, en });
  }
}
stage2.sort((a, b) => b.o.ndcg5 - a.o.ndcg5 || b.o.mrr - a.o.mrr);
console.log("-- Stage 2 排行（top 8）--");
for (const r of stage2.slice(0, 8)) {
  console.log(
    `${r.label.padEnd(30)} nDCG@5=${r.o.ndcg5.toFixed(4)} MRR=${r.o.mrr.toFixed(4)} hit@3=${r.o.hit3.toFixed(3)} junk=${r.o.junk} agg=${r.o.aggregator}`
  );
}

// ── Stage 3：rrfK 微调 ──
console.log("\n[Stage 3] rrfK 微调 ...");
const best2 = stage2[0];
const stage3 = [];
for (const rrfK of [10, 20, 40, 60, 100]) {
  const cfg = { ...best2.cfg, rrfK };
  const { o, cn, en } = await evaluate(cfg);
  stage3.push({ label: `k=${rrfK}`, cfg, o, cn, en });
}
stage3.sort((a, b) => b.o.ndcg5 - a.o.ndcg5 || b.o.mrr - a.o.mrr);
console.log("-- Stage 3 排行 --");
for (const r of stage3) {
  console.log(`${r.label.padEnd(12)} nDCG@5=${r.o.ndcg5.toFixed(4)} MRR=${r.o.mrr.toFixed(4)} hit@3=${r.o.hit3.toFixed(3)}`);
}

const champion = stage3[0];

// ── 最终对比 ──
console.log("\n================ FINAL ================");
const fmt = (r) =>
  `nDCG@5=${r.o.ndcg5.toFixed(4)} MRR=${r.o.mrr.toFixed(4)} hit@1=${r.o.hit1.toFixed(3)} hit@3=${r.o.hit3.toFixed(3)} hit@5=${r.o.hit5.toFixed(3)}`;
console.log(`LEGACY   ${fmt(results.find((r) => r.cfg.rankMode === "legacy"))}`);
console.log(`CHAMPION ${fmt(champion)}   cfg=${JSON.stringify(champion.cfg)}`);
console.log(`  [cn] legacy nDCG=${base ? results.find((r) => r.cfg.rankMode === "legacy").cn.ndcg5 : "?"} -> champion ${champion.cn.ndcg5}`);
console.log(`  [en] legacy nDCG=${results.find((r) => r.cfg.rankMode === "legacy").en.ndcg5} -> champion ${champion.en.ndcg5}`);

const legacyRow = results.find((r) => r.cfg.rankMode === "legacy");
const out = {
  rawTag,
  tunedAt: new Date().toISOString(),
  legacy: { cfg: legacyRow.cfg, overall: legacyRow.o, cn: legacyRow.cn, en: legacyRow.en },
  champion: { cfg: champion.cfg, overall: champion.o, cn: champion.cn, en: champion.en },
  stage1Top: results.slice(0, 10).map((r) => ({ label: r.label, cfg: r.cfg, o: r.o })),
  stage2Top: stage2.slice(0, 10).map((r) => ({ label: r.label, cfg: r.cfg, o: r.o })),
  stage3: stage3.map((r) => ({ label: r.label, cfg: r.cfg, o: r.o })),
};
fs.writeFileSync(path.join(evalDir, `tune-${rawTag}.json`), JSON.stringify(out, null, 2), "utf8");
console.log(`\nsaved -> eval/tune-${rawTag}.json`);
