#!/usr/bin/env node
/**
 * tune-grid.mjs — 排序权重三维网格（离线，基于 capture 原始结果）
 *
 * 动机：tune-bm25.mjs 发现"wRrf 取任何值结果都一样"——因为 RRF 被**按本次最大值归一化**，
 * 排序是尺度无关的，wRrf 只在"与 coverage/echo 等项竞争"时才起作用。
 * 当池里只有 1 个引擎时各项同源、排序恒定；一旦多引擎参与，coverage 才能提供鉴别信号。
 * 因此必须**联合**扫 wRrf × wCoverage × wBm25，而不是各自单独扫。
 *
 * 用法：node eval/tune-grid.mjs [rawTag] [--cn]
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline, __setRankConfig } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, scoreOne, aggregate } from "./lib.mjs";

const rawTag = process.argv[2] || "v7";
const onlyCn = process.argv.includes("--cn");
// N 可调：用于验证"候选池变大但只显示 5 条"是否才是回退主因（截断假设）
const N = Math.max(1, Math.min(10, parseInt(process.env.EVAL_N || String(MAX_RESULTS), 10) || MAX_RESULTS));
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));
const items = onlyCn ? store.items.filter((i) => i.lang === "cn") : store.items;
console.log(`loaded ${items.length} queries from raw-${rawTag}.json${onlyCn ? " (cn only)" : ""}  N=${N}`);

async function evaluate(cfg) {
  __setRankConfig({ rankMode: "rrf", rrfK: 20, echoPenalty: 0.40, lowerPenalty: 0.15, ...cfg });
  const rows = [];
  for (const item of items) {
    const { results } = await runPipeline(item.raw, item.q, N);
    rows.push(scoreOne(item, results));
  }
  return aggregate(rows);
}

const grid = [];
for (const wRrf of [1.0, 0.8, 0.6, 0.4, 0.2, 0.0]) {
  for (const wCoverage of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    for (const wBm25 of [0, 0.2, 0.4]) {
      // 每次评估都重置，避免权重串味
      const o = await evaluate({ wRrf, wCoverage, wBm25 });
      grid.push({ wRrf, wCoverage, wBm25, o });
    }
  }
}

const baseline = grid.find((g) => g.wRrf === 1.0 && g.wCoverage === 0 && g.wBm25 === 0);
console.log(`\n基线（现行生产 cfg）：nDCG@5=${baseline.o.ndcg5.toFixed(4)} MRR=${baseline.o.mrr.toFixed(4)} hit@1=${baseline.o.hit1.toFixed(3)}`);

const sorted = [...grid].sort((a, b) => b.o.ndcg5 - a.o.ndcg5);
console.log(`\n--- top 12 / ${grid.length} 组合 ---`);
for (const g of sorted.slice(0, 12)) {
  const d = ((g.o.ndcg5 - baseline.o.ndcg5) * 100).toFixed(1);
  console.log(
    `wRrf=${g.wRrf.toFixed(1)} wCov=${g.wCoverage.toFixed(1)} wBm25=${g.wBm25.toFixed(1)} | nDCG@5=${g.o.ndcg5.toFixed(4)} (${d >= 0 ? "+" : ""}${d}%) MRR=${g.o.mrr.toFixed(4)} hit@1=${g.o.hit1.toFixed(3)} junk=${g.o.junk}`,
  );
}

console.log(`\n--- 只看 wCoverage=0（现今生产：关掉 coverage）top 5 ---`);
for (const g of sorted.filter((x) => x.wCoverage === 0).slice(0, 5)) {
  console.log(`wRrf=${g.wRrf.toFixed(1)} wBm25=${g.wBm25.toFixed(1)} | nDCG@5=${g.o.ndcg5.toFixed(4)} MRR=${g.o.mrr.toFixed(4)}`);
}
console.log(`\n--- 只看 wCoverage>0 top 5 ---`);
for (const g of sorted.filter((x) => x.wCoverage > 0).slice(0, 5)) {
  console.log(`wRrf=${g.wRrf.toFixed(1)} wCov=${g.wCoverage.toFixed(1)} wBm25=${g.wBm25.toFixed(1)} | nDCG@5=${g.o.ndcg5.toFixed(4)} MRR=${g.o.mrr.toFixed(4)}`);
}

const out = { rawTag, tunedAt: new Date().toISOString(), baseline, grid: grid.map((g) => ({ wRrf: g.wRrf, wCoverage: g.wCoverage, wBm25: g.wBm25, o: g.o })) };
fs.writeFileSync(path.join(evalDir, `tune-grid-${rawTag}.json`), JSON.stringify(out, null, 2), "utf8");
console.log(`\nsaved -> eval/tune-grid-${rawTag}.json`);
