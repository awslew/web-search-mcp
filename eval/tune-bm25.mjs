#!/usr/bin/env node
/**
 * tune-bm25.mjs — 验证"CJK 分词修复后，BM25 该给多少权重"（离线，控制变量）
 *
 * 背景：wBm25 历史上被设为 0，理由是"中文无空格分词 → BM25 恒 0"。
 * 该理由已失效：search-core 改用 cjkTokenize（CJK overlapping 2-gram）。
 * 本脚本在同一份 capture 的原始结果上，只动 wBm25，其余权重固定，观察 nDCG@5 变化，
 * 并**分语言**输出（防止中文涨、英文跌被整体均值掩盖）。
 *
 * 用法：node eval/tune-bm25.mjs <rawTag>
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline, __setRankConfig } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, scoreOne, aggregate } from "./lib.mjs";

const rawTag = process.argv[2] || "v6-baseline";
const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${rawTag}.json`), "utf8"));
console.log(`loaded ${store.items.length} captured queries from raw-${rawTag}.json`);

const baseCfg = { rankMode: "rrf", rrfK: 20, engineWeightedRrf: false, echoPenalty: 0.40, lowerPenalty: 0.15 };

async function evaluate(cfg) {
  __setRankConfig({ ...baseCfg, ...cfg });
  const rows = [];
  for (const item of store.items) {
    const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  return {
    o: aggregate(rows),
    cn: aggregate(rows.filter((r) => r.lang === "cn")),
    en: aggregate(rows.filter((r) => r.lang === "en")),
  };
}

const rowsOut = [];
for (const wBm25 of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
  for (const wRrf of [0.4, 0.6, 0.8, 1.0]) {
    const r = await evaluate({ wRrf, wCoverage: 0, wBm25 });
    rowsOut.push({ wRrf, wBm25, ...r });
    console.log(
      `wRrf=${wRrf.toFixed(1)} wBm25=${wBm25.toFixed(1)} | ALL nDCG@5=${r.o.ndcg5.toFixed(4)} MRR=${r.o.mrr.toFixed(4)} | ` +
      `cn=${r.cn.ndcg5.toFixed(4)} (n=${r.cn.n}) | en=${r.en.ndcg5.toFixed(4)} (n=${r.en.n})`,
    );
  }
}

const baseline = rowsOut.find((r) => r.wBm25 === 0 && r.wRrf === 1.0);
console.log(`\n--- 基线（现行生产配置 wRrf=1.0, wBm25=0）---`);
console.log(`ALL nDCG@5=${baseline.o.ndcg5.toFixed(4)}  cn=${baseline.cn.ndcg5.toFixed(4)}  en=${baseline.en.ndcg5.toFixed(4)}`);

const sorted = [...rowsOut].sort((a, b) => b.o.ndcg5 - a.o.ndcg5);
console.log(`\n--- 全量排行 top 6 ---`);
for (const r of sorted.slice(0, 6)) {
  const d = (x, b) => (x >= b ? "+" : "") + ((x - b) * 100).toFixed(1) + "%";
  console.log(
    `wRrf=${r.wRrf.toFixed(1)} wBm25=${r.wBm25.toFixed(1)} | ALL ${r.o.ndcg5.toFixed(4)} (${d(r.o.ndcg5, baseline.o.ndcg5)}) ` +
    `cn ${r.cn.ndcg5.toFixed(4)} (${d(r.cn.ndcg5, baseline.cn.ndcg5)}) en ${r.en.ndcg5.toFixed(4)} (${d(r.en.ndcg5, baseline.en.ndcg5)})`,
  );
}

// 只看中文的排行：本次修复的目标是中文
console.log(`\n--- 中文子集排行 top 6（本次修复目标）---`);
for (const r of [...rowsOut].sort((a, b) => b.cn.ndcg5 - a.cn.ndcg5).slice(0, 6)) {
  const d = ((r.cn.ndcg5 - baseline.cn.ndcg5) * 100).toFixed(1);
  console.log(`wRrf=${r.wRrf.toFixed(1)} wBm25=${r.wBm25.toFixed(1)} | cn nDCG@5=${r.cn.ndcg5.toFixed(4)} (${d >= 0 ? "+" : ""}${d}%) hit@1=${r.cn.hit1.toFixed(3)} MRR=${r.cn.mrr.toFixed(4)}`);
}

const out = {
  rawTag, tunedAt: new Date().toISOString(), baseCfg, baseline,
  grid: rowsOut.map((r) => ({ wRrf: r.wRrf, wBm25: r.wBm25, o: r.o, cn: r.cn, en: r.en })),
};
fs.writeFileSync(path.join(evalDir, `tune-bm25-${rawTag}.json`), JSON.stringify(out, null, 2), "utf8");
console.log(`\nsaved -> eval/tune-bm25-${rawTag}.json`);
