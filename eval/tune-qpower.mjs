#!/usr/bin/env node
/**
 * tune-qpower.mjs — 扫"引擎内在题率加权指数" engineQualityPower
 *
 * 动机（现场取证）：v7 capture 中 so360 返回"在题但非权威"结果（runoob/CSDN，均值 coverage 0.6~1.0），
 * cn.bing 返回"权威但标题不含查询词"的官方文档（均值 coverage 0.05~0.25）。
 * 纯 RRF 按名次融合，条数多的引擎把官方文档挤出 top-5（vue3/nodejs/go 三查询 nDCG 1.0→0.0）。
 *
 * 用法：node eval/tune-qpower.mjs [rawTag]
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline, __setRankConfig } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, scoreOne, aggregate } from "./lib.mjs";

const rawTag = process.argv[2] || "v7";
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));
console.log(`loaded ${store.items.length} queries from raw-${rawTag}.json`);

async function evaluate(cfg) {
  __setRankConfig({ rankMode: "rrf", rrfK: 20, wRrf: 1, wCoverage: 0, wBm25: 0, echoPenalty: 0.4, lowerPenalty: 0.15, ...cfg });
  const rows = [];
  for (const item of store.items) {
    const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  return map(rows);
}
function map(rows) {
  return {
    o: aggregate(rows),
    cn: aggregate(rows.filter((r) => r.lang === "cn")),
    en: aggregate(rows.filter((r) => r.lang === "en")),
  };
}

const out = [];
console.log("\npower | ALL nDCG@5   MRR    hit@1 | cn nDCG@5  hit@1 | en nDCG@5  hit@1");
for (const p of [0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0]) {
  const r = await evaluate({ engineQualityPower: p });
  out.push({ power: p, ...r });
  console.log(
    `${String(p).padEnd(5)} | ${r.o.ndcg5.toFixed(4)}      ${r.o.mrr.toFixed(4)} ${r.o.hit1.toFixed(3)} | ` +
    `${r.cn.ndcg5.toFixed(4)}   ${r.cn.hit1.toFixed(3)} | ${r.en.ndcg5.toFixed(4)}   ${r.en.hit1.toFixed(3)}`,
  );
}

const base = out[0];
console.log(`\n基线 power=0（现生产）: ALL=${base.o.ndcg5.toFixed(4)} cn=${base.cn.ndcg5.toFixed(4)} en=${base.en.ndcg5.toFixed(4)}`);
const best = [...out].sort((a, b) => b.o.ndcg5 - a.o.ndcg5)[0];
console.log(`最优 power=${best.power}: ALL=${best.o.ndcg5.toFixed(4)} (${((best.o.ndcg5 - base.o.ndcg5) * 100 >= 0 ? "+" : "") + ((best.o.ndcg5 - base.o.ndcg5) * 100).toFixed(1)}%) cn=${best.cn.ndcg5.toFixed(4)} en=${best.en.ndcg5.toFixed(4)}`);

fs.writeFileSync(path.join(evalDir, `tune-qpower-${rawTag}.json`), JSON.stringify({ rawTag, baseline: base, best, all: out }, null, 2), "utf8");
console.log(`saved -> eval/tune-qpower-${rawTag}.json`);
