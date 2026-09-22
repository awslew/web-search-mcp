#!/usr/bin/env node
/**
 * show.mjs — 人眼核查：把某份 capture 的**最终排序**打出来（含每条的来源引擎与覆盖率）。
 *
 * 为什么需要它：nDCG 是聚合指标，会被宽松/严格的口径影响。判断"结果到底好不好"必须看具体条目，
 * 尤其是 gold 用 gov.cn 这类宽域时——命中≠有用。本工具让结论可被人工推翻。
 *
 * 用法：
 *   node eval/show.mjs <rawTag> [查询关键字] [--api] [--merge]
 *     --api    同时把 API 引擎对该查询的原始结果打出来做对照
 *     --merge  把 API 结果并入后再跑一遍管线，对比"并/不并"的最终排序差异
 *              （用于诊断"gold 明明在池子里却没进 top-5"这类排序问题）
 *   例：node eval/show.mjs real-noapi 顺丰
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline, searchApi, cleanQuery, termCoverage } from "../search-core.mjs";
import { evalDir, MAX_RESULTS } from "./lib.mjs";

const tag = process.argv[2];
const kw = process.argv.filter((a) => !a.startsWith("--"))[3] || "";
const withApi = process.argv.includes("--api");
const withMerge = process.argv.includes("--merge");
if (!tag) { console.log("usage: node eval/show.mjs <rawTag> [queryKeyword] [--api]"); process.exit(1); }

const store = JSON.parse(fs.readFileSync(path.join(evalDir, `raw-${tag}.json`), "utf8"));
const items = store.items.filter((x) => !kw || x.q.includes(kw));
if (!items.length) { console.log(`没有匹配 "${kw}" 的查询`); process.exit(1); }

for (const item of items) {
  const { results } = await runPipeline(item.raw, item.q, MAX_RESULTS);
  const srcCount = {};
  for (const r of item.raw) for (const s of String(r.source || "").split("+")) srcCount[s] = (srcCount[s] || 0) + 1;
  console.log(`\n═══ ${item.q}   [gold: ${(item.gold || []).join(", ")}]`);
  console.log(`    raw=${item.raw.length} 引擎=${Object.entries(srcCount).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  results.forEach((r, i) => {
    let h = ""; try { h = new URL(r.url).hostname; } catch {}
    const hit = (item.gold || []).some((g) => h === g || h.endsWith("." + g)) ? "★gold" : "     ";
    console.log(`    ${i + 1}. ${hit} ${h.padEnd(30)} cov=${(r.coverage ?? 0).toFixed(2)} src=${r.source}`);
    console.log(`          ${(r.title || "").slice(0, 72)}`);
  });
  if (withApi || withMerge) {
    const api = await searchApi(cleanQuery(item.q), MAX_RESULTS).catch(() => []);
    if (withApi) {
      console.log(`    ── API 原始结果 ──`);
      api.forEach((r, i) => {
        let h = ""; try { h = new URL(r.url).hostname; } catch {}
        const hit = (item.gold || []).some((g) => h === g || h.endsWith("." + g)) ? "★gold" : "     ";
        console.log(`    A${i + 1}. ${hit} ${h.padEnd(29)} cov=${termCoverage(item.q, r.title, r.snippet).toFixed(2)}`);
        console.log(`          ${(r.title || "").slice(0, 72)}`);
      });
    }
    if (withMerge) {
      const { results: merged } = await runPipeline(item.raw.concat(api), item.q, MAX_RESULTS);
      console.log(`    ── 并入 API 后的最终排序 ──`);
      merged.forEach((r, i) => {
        let h = ""; try { h = new URL(r.url).hostname; } catch {}
        const hit = (item.gold || []).some((g) => h === g || h.endsWith("." + g)) ? "★gold" : "     ";
        console.log(`    M${i + 1}. ${hit} ${h.padEnd(29)} cov=${(r.coverage ?? 0).toFixed(2)} src=${r.source}`);
        console.log(`          ${(r.title || "").slice(0, 72)}`);
      });
      // gold 是否在池中被管线丢弃？区分"没进池"与"进池但被排掉"
      const inPool = item.raw.concat(api).filter((r) => {
        let h = ""; try { h = new URL(r.url).hostname; } catch { return false; }
        return (item.gold || []).some((g) => h === g || h.endsWith("." + g));
      });
      const inOut = merged.some((r) => {
        let h = ""; try { h = new URL(r.url).hostname; } catch { return false; }
        return (item.gold || []).some((g) => h === g || h.endsWith("." + g));
      });
      console.log(`    诊断：池中 gold 条数=${inPool.length}（${inPool.map((r) => r.source).join("/") || "-"}）  →  输出含 gold=${inOut ? "是" : "否"}`);
    }
  }
}
