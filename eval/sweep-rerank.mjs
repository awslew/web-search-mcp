// _sweep-rerank.mjs — 扫描 RERANK_WEIGHT，找最优混合比例
// 每个权重需重启进程（WEIGHT 在模块加载时读取），故本脚本按权重分批由外部驱动。
import fs from "node:fs";
import path from "node:path";
import { fetchRawResults, runPipeline, cleanQuery } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, loadQueries, scoreOne, aggregate, byLang } from "./lib.mjs";
import { __rerankStats } from "../rerank.mjs";

const rawTag = process.argv[2] || "v2";
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));
const rows = [];
for (const item of store.items) {
  const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
  rows.push(scoreOne(item, results));
}
const o = aggregate(rows);
const w = __rerankStats().weight;
console.log(
  `WEIGHT=${w}  nDCG@5=${o.ndcg5}  MRR=${o.mrr}  hit@1=${o.hit1}  hit@3=${o.hit3}  hit@5=${o.hit5}  ` +
  `[cn nDCG=${byLang(rows).cn?.ndcg5}] [en nDCG=${byLang(rows).en?.ndcg5}]  reranked=${__rerankStats().reranked}`
);
