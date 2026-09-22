#!/usr/bin/env node
/**
 * api-ab.mjs — 受控 A/B：在**同一份生产原始结果**上，只增减「搜索 API 结果」，
 * 重放质量管线，看 nDCG@5 是涨是跌。
 *
 * 为什么必须这样做：capture 新数据会把"引擎今天健不健康"混进来，无法归因。
 * 本脚本把生产 raw 固定（默认 raw-v6-baseline.json），唯一变量 = 是否并入 API 结果
 * 以及并入哪几条，因此 delta 只能由 API 结果解释。
 *
 * 用法：
 *   node eval/api-ab.mjs                # 首跑会抓 API 原始结果并缓存（约 30 credit）
 *   CACHE 已存在则直接复用；FRESH=1 强制重抓。
 *   node eval/api-ab.mjs --refetch
 *   API_PROVIDER=zhipu node eval/api-ab.mjs    # 配了多家时，指定要评估哪一家
 *
 * ⚠️ 换 provider 后**必须**用 API_PROVIDER 指定（或先 --refetch）：
 *   缓存文件名是 raw-api-<provider>.json，但"查询齐全即复用"的判断**与 provider 无关**——
 *   先跑 tavily、后改配智谱时，会复用那份 tavily 缓存，而报告标题写 provider=zhipu，
 *   **A/B 结论就指向了错误的引擎**。本脚本现在会核对缓存内记录的 provider，
 *   不匹配即自动重抓（见下方 cacheOk 判定）。
 */
import fs from "node:fs";
import path from "node:path";
import { searchApi, cleanQuery, runPipeline, apiEngineAvailable, termCoverage } from "../search-core.mjs";
import { evalDir, MAX_RESULTS, loadQueries, scoreOne, aggregate, byLang, selectProvider } from "./lib.mjs";

const RAW_BASE = process.env.RAW_BASE || "raw-v6-baseline";
const REFETCH = process.argv.includes("--refetch") || process.env.FRESH === "1";

if (!apiEngineAvailable() && !process.env.API_PROVIDER) { console.error("未配置 API key（可用 API_PROVIDER=<name> 指定，但仍需对应 key）"); process.exit(1); }
const { provider, forced, allConfigured } = selectProvider();
if (!provider) { console.error("未读到任何搜索 API 密钥。"); process.exit(1); }
if (allConfigured.length > 1) {
  console.log(`注意：配了 ${allConfigured.length} 家（${allConfigured.join("/")}），本次评估 ${provider}${forced ? "（已指定）" : "（优先级最高者）"}。`);
  console.log(`      要评估别家请用：API_PROVIDER=<name> node eval/api-ab.mjs`);
}
const cacheFile = path.join(evalDir, `raw-api-${provider}.json`);

// ── 1) 取 API 原始结果（带磁盘缓存，避免反复烧额度）──
async function getApiRaw() {
  let store = { provider, capturedAt: new Date().toISOString(), items: [] };
  if (!REFETCH && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    // ⚠️ 必须核对缓存里记录的 provider：文件名虽带 provider，但历史上可能存在
    //    "文件名与内容不符"或"换 provider 后误复用"的情况，宁可信文件内容。
    if (cached.provider && cached.provider !== provider) {
      console.error(`⚠️ 缓存 ${path.basename(cacheFile)} 内记录的 provider=${cached.provider}，与本次 ${provider} 不符 → 忽略该缓存并重抓。`);
    } else {
      store = cached;
      console.log(`复用缓存 ${path.basename(cacheFile)}（provider=${cached.provider || provider}，已有 ${store.items.length} 条，抓于 ${store.capturedAt}）`);
    }
  } else if (REFETCH) {
    console.log(`--refetch/FRESH=1：忽略缓存，强制重抓（约 ${loadQueries().length} credit）。`);
  }
  store.provider = provider; // 落盘前校正，保证文件内容与本次 provider 一致
  const have = new Set(store.items.map((x) => x.q));
  const missing = loadQueries().filter((q) => !have.has(q.q));
  if (!missing.length) return store;
  console.log(`缓存缺失 ${missing.length} 条，抓取中（约 ${missing.length} credit）…`);
  for (const q of missing) {
    let results = [];
    try { results = await searchApi(cleanQuery(q.q), MAX_RESULTS); }
    catch (e) { console.error(`[api] FAIL ${q.q} :: ${e?.message || e}`); }
    store.items.push({ q: q.q, lang: q.lang, results });
    console.error(`[api] n=${String(results.length).padStart(2)}  ${q.q}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  store.capturedAt = new Date().toISOString();
  fs.writeFileSync(cacheFile, JSON.stringify(store, null, 2), "utf8");
  return store;
}

const base = JSON.parse(fs.readFileSync(path.join(evalDir, `${RAW_BASE}.json`), "utf8"));
const apiStore = await getApiRaw();
const apiMap = new Map(apiStore.items.map((x) => [x.q, x.results || []]));

// ── 2) 合并策略（唯一变量）──
const cov = (q, r) => termCoverage(q, r.title, r.snippet);
const srcCount = (prod) => new Set(prod.flatMap((r) => String(r.source || "").split("+"))).size;
const STRATEGIES = {
  "prod（基线，无 API）": () => [],
  "append 全并入": (q, api) => api,
  "gate≥0.20 覆盖门槛": (q, api) => api.filter((r) => cov(q, r) >= 0.2),
  "gate≥0.40 覆盖门槛": (q, api) => api.filter((r) => cov(q, r) >= 0.4),
  "newDomain 仅补新域": (q, api, prod) => {
    const have = new Set(prod.map((r) => { try { return new URL(r.url).hostname; } catch { return ""; } }));
    return api.filter((r) => { try { return !have.has(new URL(r.url).hostname); } catch { return false; } });
  },
  "max5 只取前 5 条 API": (q, api) => api.slice(0, 5),
  // ── rescue 系列：API 只在生产链路"交白卷/单路"时介入，避免稀释已经正确的结果 ──
  "rescue 单引擎才用": (q, api, prod) => (srcCount(prod) < 2 ? api : []),
  "rescue raw<8": (q, api, prod) => (prod.length < 8 ? api : []),
  "rescue raw<12": (q, api, prod) => (prod.length < 12 ? api : []),
  "rescue 单引擎或raw<8": (q, api, prod) => (srcCount(prod) < 2 || prod.length < 8 ? api : []),
};

const summaries = [];
for (const [name, merge] of Object.entries(STRATEGIES)) {
  const rows = [];
  for (const item of base.items) {
    const api = apiMap.get(item.q) || [];
    const extra = merge(item.q, api, item.raw);
    const { results } = await runPipeline(item.raw.concat(extra), item.q, MAX_RESULTS);
    rows.push(scoreOne(item, results));
  }
  const o = aggregate(rows);
  summaries.push({ name, o, byLang: byLang(rows), rows });
}

// ── 3) 报告 ──
const baseLine = summaries[0].o;
console.log(`\n===== 受控 A/B（生产 raw 固定 = ${RAW_BASE}，API provider = ${provider}）=====`);
console.log(`策略                       nDCG@5    Δ基线     hit@1    MRR    P@5   junk`);
for (const s of summaries) {
  const d = s.o.ndcg5 - baseLine.ndcg5;
  const flag = d > 0.0005 ? "+" : d < -0.0005 ? "" : " ";
  console.log(
    `${s.name.padEnd(24)} ${String(s.o.ndcg5).padStart(7)} ${(flag + d.toFixed(4)).padStart(9)}` +
      ` ${String(s.o.hit1).padStart(7)} ${String(s.o.mrr).padStart(6)} ${String(s.o.p5).padStart(6)} ${String(s.o.junk).padStart(5)}`
  );
}

console.log(`\n按语言 nDCG@5：`);
const langs = [...new Set(summaries.flatMap((s) => Object.keys(s.byLang)))];
console.log("策略".padEnd(24) + langs.map((l) => l.padStart(20)).join(""));
for (const s of summaries) {
  let line = s.name.padEnd(24);
  for (const lang of langs) {
    const b = summaries[0].byLang[lang], a = s.byLang[lang];
    if (!a || !b) { line += "".padStart(20); continue; }
    const d = a.ndcg5 - b.ndcg5;
    line += `${String(a.ndcg5).padStart(10)}${(d >= 0 ? "+" : "") + d.toFixed(4)}`.padStart(20);
  }
  console.log(line);
}

// ── 4) 逐条归因：哪个策略动了哪些查询 ──
const best = summaries.reduce((a, b) => (b.o.ndcg5 > a.o.ndcg5 ? b : a));
if (best.name !== summaries[0].name) {
  console.log(`\n最佳策略 = ${best.name}，逐条差异（基线 → 最佳）：`);
  const bm = new Map(summaries[0].rows.map((r) => [r.q, r]));
  for (const r of best.rows) {
    const b = bm.get(r.q);
    if (!b) continue;
    const d = r.ndcg5 - b.ndcg5;
    if (Math.abs(d) < 0.005) continue;
    console.log(`  ${d > 0 ? "▲" : "▼"} ${r.q}  nDCG ${b.ndcg5.toFixed(3)}→${r.ndcg5.toFixed(3)} (MRR ${b.mrr.toFixed(2)}→${r.mrr.toFixed(2)})`);
  }
}

const out = path.join(evalDir, `result-api-ab-${provider}.json`);
fs.writeFileSync(out, JSON.stringify({ rawBase: RAW_BASE, provider, strategies: summaries.map((s) => ({ name: s.name, overall: s.o, byLang: s.byLang })) }, null, 2), "utf8");
console.log(`\nsaved -> ${out}`);
