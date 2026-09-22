/**
 * lib.mjs — 评估指标共享库
 * 被 run-eval.mjs（跑基线/回放）与 tune.mjs（权重网格搜索）共用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDomain, blacklistMatch, __reloadApiKeys } from "../search-core.mjs";

export const evalDir = path.dirname(fileURLToPath(import.meta.url));
export const K = 5;
export const MAX_RESULTS = 5;

// 引擎内部页/聚合页泄漏（不是真实内容页，属管线缺陷）
export const AGGREGATOR_RE =
  /image\.baidu\.com|lightapp\.baidu\.com|baijiahao\.baidu\.com|baidu\.com\/s\?|so\.com\/s\?|bing\.com\/search|google\.com\/search|search\?q=/i;

const JUNK_TLD_RE =
  /\.(top|xyz|icu|club|online|shop|fun|work|live|buzz|click|link|zip|review|stream|download|win|bid|party|trade|date|faith|monster|science|rest|cam|men|mom|site|vip|gdn|loan)$/;

export function loadQueries() {
  const raw = JSON.parse(fs.readFileSync(path.join(evalDir, "queries.json"), "utf8"));
  const out = [];
  for (const lang of ["cn", "en", "cn_real"]) {
    for (const item of raw[lang] || []) out.push({ ...item, lang });
  }
  return out;
}

export const KNOWN_PROVIDERS = ["tavily", "bocha", "zhipu"];

/**
 * 选定搜索 API provider，并处理 `API_PROVIDER` 环境变量覆盖。
 *
 * 为什么需要这个 helper（2026-09-21 实测踩到）：
 *   ① `searchApi` 永远按优先级 `tavily > bocha > zhipu` 取**首个**配了 key 的，
 *      所以配了多家时无法单独评估某一家 —— 除非能强制指定。
 *   ② 更隐蔽的一条：`api-ab.mjs` 的缓存文件名是 `raw-api-<provider>.json`，
 *      但**判断"缓存是否可用"看的是查询是否齐全，与 provider 无关**。
 *      于是"先跑 tavily、后改配智谱"时，它会复用那份 tavily 缓存，
 *      报告标题却写着 provider=zhipu —— **A/B 结论会指向错误的引擎**。
 *      本 helper 强制每次重新读取 provider，并把缓存文件名与之一一绑定，
 *      同时在缓存里再核一次 provider 是否匹配，不匹配就重抓。
 *
 * 用法：API_PROVIDER=zhipu node eval/api-ab.mjs
 * @returns {{provider: string|null, forced: boolean, allConfigured: string[]}}
 */
export function selectProvider() {
  const forced = process.env.API_PROVIDER || null;
  if (forced && !KNOWN_PROVIDERS.includes(forced)) {
    console.error(`未知 API_PROVIDER=${forced}（可选 ${KNOWN_PROVIDERS.join("/")}）`);
    process.exit(1);
  }
  // ⚠️ allConfigured 必须在**删除任何 env key 之前**算出来。
  // 曾经写成"先删后算"，导致强制指定时它永远只剩被指定那家，
  // 于是"已配置：xxx"这句提示总是错的（会让人以为别家都没配）。
  const allConfigured = KNOWN_PROVIDERS.filter((k) => __reloadApiKeys()[k]);
  // 强制指定时：清掉其余各家的 env key，并重新加载，使 searchApi 必然走到被指定那家。
  if (forced) {
    for (const k of KNOWN_PROVIDERS) {
      if (k !== forced) delete process.env[`${k.toUpperCase()}_API_KEY`];
    }
    __reloadApiKeys();
  }
  const keys = __reloadApiKeys();
  const provider = forced || allConfigured[0] || null;
  if (forced && !keys[forced]) {
    console.error(`API_PROVIDER=${forced} 被指定，但没有读到该家的密钥（已配置：${allConfigured.join("/") || "无"}）。`);
    console.error(`请先设 ${forced.toUpperCase()}_API_KEY，或去掉 API_PROVIDER。`);
    process.exit(1);
  }
  return { provider, forced: Boolean(forced), allConfigured };
}

export function isGold(url, gold) {
  const host = extractDomain(url);
  if (!host) return false;
  return gold.some((g) => host === g || host.endsWith("." + g));
}

export function isJunk(url) {
  try {
    if (blacklistMatch(url).remove) return true;
    return JUNK_TLD_RE.test(extractDomain(url));
  } catch {
    return false;
  }
}

/** 二值相关度的 nDCG@K；IDCG 按"已找到的相关文档全部排最前"归一化。 */
export function ndcg(rels) {
  const dcg = rels.reduce((a, r, i) => a + r / Math.log2(i + 2), 0);
  const n = rels.filter(Boolean).length;
  let idcg = 0;
  for (let i = 0; i < Math.min(n, K); i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

export function scoreOne(query, results) {
  const rels = results.map((r) => (isGold(r.url, query.gold) ? 1 : 0));
  const firstGold = rels.indexOf(1);
  return {
    q: query.q,
    lang: query.lang,
    n: results.length,
    hit1: rels[0] === 1 ? 1 : 0,
    hit3: rels.slice(0, 3).includes(1) ? 1 : 0,
    hit5: rels.slice(0, K).includes(1) ? 1 : 0,
    mrr: firstGold >= 0 ? 1 / (firstGold + 1) : 0,
    p5: rels.slice(0, K).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(K, results.length)),
    ndcg5: ndcg(rels.slice(0, K)),
    junk: results.filter((r) => isJunk(r.url)).length,
    aggregator: results.filter((r) => AGGREGATOR_RE.test(r.url)).length,
    // snippet 覆盖率：百度改版曾导致 100% snippet 静默变空，而所有旧断言仍全绿。
    // 把它量化进指标，让"摘要失效"从隐形故障变成可见回归。
    snipEmpty: results.filter((r) => !(r.snippet || "").trim()).length,
    snipShort: results.filter((r) => {
      const L = (r.snippet || "").trim().length;
      return L > 0 && L < 40;
    }).length,
    snipChars: results.reduce((a, r) => a + (r.snippet || "").trim().length, 0),
    top1: results[0] ? { title: (results[0].title || "").slice(0, 70), url: results[0].url } : null,
    cov: results.map((r) => (r.coverage ?? 0).toFixed(2)).join(","),
  };
}

export function aggregate(rows) {
  const n = rows.length || 1;
  const avg = (f) => rows.reduce((a, r) => a + f(r), 0) / n;
  const totalRes = rows.reduce((a, r) => a + r.n, 0);
  return {
    n: rows.length,
    hit1: +avg((r) => r.hit1).toFixed(4),
    hit3: +avg((r) => r.hit3).toFixed(4),
    hit5: +avg((r) => r.hit5).toFixed(4),
    mrr: +avg((r) => r.mrr).toFixed(4),
    p5: +avg((r) => r.p5).toFixed(4),
    ndcg5: +avg((r) => r.ndcg5).toFixed(4),
    junk: +avg((r) => r.junk).toFixed(3),
    aggregator: +avg((r) => r.aggregator).toFixed(3),
    // 全库 snippet 健康度（分母是全部结果数，不是查询数）
    snipEmptyRate: totalRes ? +(rows.reduce((a, r) => a + r.snipEmpty, 0) / totalRes).toFixed(4) : 0,
    snipAvgChars: totalRes ? +(rows.reduce((a, r) => a + r.snipChars, 0) / totalRes).toFixed(1) : 0,
    empty: rows.filter((r) => r.n === 0).length,
  };
}

export function byLang(rows) {
  const out = {};
  for (const lang of ["cn", "en", "cn_real"]) {
    const sub = rows.filter((r) => r.lang === lang);
    if (sub.length) out[lang] = aggregate(sub);
  }
  return out;
}

export function printReport(p) {
  const o = p.overall;
  console.log(`\n===== ${p.tag} (${p.mode}) =====`);
  console.log(`queries=${o.n}  empty=${o.empty}`);
  console.log(`hit@1=${o.hit1}  hit@3=${o.hit3}  hit@5=${o.hit5}  MRR=${o.mrr}  P@5=${o.p5}  nDCG@5=${o.ndcg5}`);
  console.log(`junk@5=${o.junk}  aggregator@5=${o.aggregator}`);
  for (const [lang, s] of Object.entries(p.byLang)) {
    console.log(`  [${lang}] hit@1=${s.hit1} hit@3=${s.hit3} hit@5=${s.hit5} MRR=${s.mrr} nDCG@5=${s.ndcg5}`);
  }
}
