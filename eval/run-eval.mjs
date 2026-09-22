#!/usr/bin/env node
/**
 * run-eval.mjs — 检索质量评估器
 *
 * 设计要点（为什么这样做）：
 *   搜索引擎结果有抖动（限流/墙/排序变化），直接跑端到端无法判断"是算法改动生效了"
 *   还是"今天引擎心情好"。因此拆两阶段：
 *     1) capture —— 抓一次原始引擎结果存盘（raw-<tag>.json）
 *     2) replay  —— 在同一份原始结果上离线重放 qualityPipeline
 *   这样算法 A/B 对比完全可复现，只受算法影响。
 *
 * 用法：
 *   node eval/run-eval.mjs capture <tag>     # 抓原始结果（联网，慢）
 *   node eval/run-eval.mjs replay  <tag>     # 离线重放并算指标
 *   node eval/run-eval.mjs live    <tag>     # 端到端（走 routeSearch，含缓存）
 *   node eval/run-eval.mjs compare <a> <b>   # 对比两份指标
 */
import fs from "node:fs";
import path from "node:path";
import { fetchRawResults, runPipeline, cleanQuery } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, loadQueries, scoreOne, aggregate, byLang, printReport } from "./lib.mjs";

function save(tag, payload) {
  const f = path.join(evalDir, `result-${tag}.json`);
  fs.writeFileSync(f, JSON.stringify(payload, null, 2), "utf8");
  return f;
}

// ── capture：抓原始引擎结果 ──
async function doCapture(tag) {
  const only = process.env.EVAL_LANG; // 只抓某个语言分类（如 EVAL_LANG=cn_real）
  const qf = process.env.EVAL_Q;      // 只抓含任一子串的查询（逗号分隔），用于针对性复现单条问题
  const queries = loadQueries().filter(
    (q) => (!only || q.lang === only) && (!qf || qf.split(",").some((s) => q.q.includes(s.trim())))
  );
  const store = { tag, capturedAt: new Date().toISOString(), items: [] };
  for (const query of queries) {
    const cleaned = cleanQuery(query.q);
    try {
      const { raw } = await fetchRawResults(cleaned, MAX_RESULTS);
      store.items.push({ q: query.q, lang: query.lang, gold: query.gold, raw });
      console.error(`[capture] ${String(raw.length).padStart(3)} raw  ${query.q}`);
    } catch (e) {
      store.items.push({ q: query.q, lang: query.lang, gold: query.gold, raw: [], error: String(e?.message || e) });
      console.error(`[capture] FAIL      ${query.q} :: ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 900)); // 礼让引擎，降低限流
  }
  const f = path.join(evalDir, `raw-${tag}.json`);
  fs.writeFileSync(f, JSON.stringify(store, null, 2), "utf8");
  console.log(`captured ${store.items.length} queries -> ${f}`);
}

// ── replay：离线重放管线 ──
async function doReplay(tag, saveAs) {
  const f = path.join(evalDir, `raw-${tag}.json`);
  const store = JSON.parse(fs.readFileSync(f, "utf8"));
  // EVAL_RANK_MODE=legacy 可在同一份原始数据上复刻旧公式，做控制变量对比
  const mode = process.env.EVAL_RANK_MODE || "rrf";
  const { __setRankConfig } = await import("../search-core.mjs");
  if (mode === "legacy") __setRankConfig({ rankMode: "legacy" });
  else if (mode === "norRerank") __setRankConfig({ rankMode: "rrf" });
  const rows = [];
  for (const item of store.items) {
    const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  const payload = {
    tag: saveAs || tag, mode: `replay:${mode}`, sourceRaw: `raw-${tag}.json`,
    scoredAt: new Date().toISOString(),
    overall: aggregate(rows), byLang: byLang(rows), rows,
  };
  const out = save(payload.tag, payload);
  printReport(payload);
  console.log(`\nsaved -> ${out}`);
}

// ── live：端到端 ──
async function doLive(tag) {
  const { routeSearch } = await import("../search-core.mjs");
  const queries = loadQueries();
  const rows = [];
  for (const query of queries) {
    try {
      const results = await routeSearch(query.q, MAX_RESULTS);
      rows.push(scoreOne(query, results));
      console.error(`[live] ${String(results.length).padStart(3)} res  ${query.q}`);
    } catch (e) {
      rows.push(scoreOne(query, []));
      console.error(`[live] FAIL      ${query.q} :: ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  const payload = { tag, mode: "live", scoredAt: new Date().toISOString(), overall: aggregate(rows), byLang: byLang(rows), rows };
  const out = save(tag, payload);
  printReport(payload);
  console.log(`\nsaved -> ${out}`);
}

function doCompare(a, b) {
  const A = JSON.parse(fs.readFileSync(path.join(evalDir, `result-${a}.json`), "utf8"));
  const B = JSON.parse(fs.readFileSync(path.join(evalDir, `result-${b}.json`), "utf8"));
  const keys = ["hit1", "hit3", "hit5", "mrr", "p5", "ndcg5", "junk", "aggregator"];
  console.log(`\n===== COMPARE  A=${a}  B=${b} =====`);
  console.log(`metric      ${"A".padStart(9)} ${"B".padStart(9)}   delta`);
  for (const k of keys) {
    const av = A.overall[k], bv = B.overall[k];
    const d = bv - av;
    const flag = d > 0.0001 ? "  UP  +" : d < -0.0001 ? "  DOWN " : "  =     ";
    console.log(`${k.padEnd(11)} ${String(av).padStart(9)} ${String(bv).padStart(9)}${flag}${d.toFixed(4)}`);
  }
  const bm = new Map(B.rows.map((r) => [r.q, r]));
  const up = [], down = [];
  for (const r of A.rows) {
    const o = bm.get(r.q);
    if (!o) continue;
    if (o.mrr > r.mrr + 0.001) up.push(`${r.q} ${r.mrr.toFixed(2)}→${o.mrr.toFixed(2)}`);
    else if (o.mrr < r.mrr - 0.001) down.push(`${r.q} ${r.mrr.toFixed(2)}→${o.mrr.toFixed(2)}`);
  }
  console.log(`\nMRR 提升 ${up.length} 条: ${up.slice(0, 12).join(" | ") || "-"}`);
  console.log(`MRR 下降 ${down.length} 条: ${down.slice(0, 12).join(" | ") || "-"}`);
}

const [mode, tag, tag2] = process.argv.slice(2);
if (mode === "capture") await doCapture(tag);
else if (mode === "replay") await doReplay(tag, tag2);
else if (mode === "live") await doLive(tag);
else if (mode === "compare") doCompare(tag, tag2);
else {
  console.log("usage: node eval/run-eval.mjs capture|replay|live <tag> | compare <a> <b>");
  process.exit(1);
}
