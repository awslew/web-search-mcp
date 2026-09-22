// sweep-covfloor.mjs — 扫描覆盖率地板阈值，找最优 covFloor
import fs from "node:fs";
import path from "node:path";
import { runPipeline, __setRankConfig } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, scoreOne, aggregate, byLang } from "./lib.mjs";

const rawTag = process.argv[2] || "v3";
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));

async function run(cfg) {
  __setRankConfig(cfg);
  const rows = [];
  for (const item of store.items) {
    const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  return { o: aggregate(rows), cn: byLang(rows).cn, en: byLang(rows).en, rows };
}

console.log(`基线（floor=0.12）与各地板对照 —— raw-${rawTag}\n`);
console.log("covFloor   nDCG@5    MRR    hit@1  hit@3  hit@5   [cn nDCG] [en nDCG]  空结果");
const results = [];
for (const floor of [0.12, 0.2, 0.25, 0.3, 0.4, 0.5]) {
  const { o, cn, en } = await run({ covFloor: floor, covBestGate: 0.4 });
  results.push({ floor, o });
  console.log(
    `${String(floor).padEnd(10)} ${String(o.ndcg5).padEnd(9)} ${String(o.mrr).padEnd(7)} ${String(o.hit1).padEnd(7)} ` +
    `${String(o.hit3).padEnd(7)} ${String(o.hit5).padEnd(7)} ${String(cn?.ndcg5 ?? "-").padEnd(10)} ${String(en?.ndcg5 ?? "-").padEnd(10)} ${o.empty}`
  );
}

const best = results.reduce((a, b) => (b.o.ndcg5 > a.o.ndcg5 ? b : a));
console.log(`\n最优 covFloor = ${best.floor}  (nDCG@5=${best.o.ndcg5})`);
