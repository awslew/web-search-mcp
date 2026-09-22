/**
 * rerank.mjs — cross-encoder 重排（可选层）
 *
 * 为什么需要：BM25 与 RRF 都是**词面/投票**信号，无法理解"词不同义同"
 * （"撤销 commit" vs "reset HEAD"、"虚拟环境" vs "venv"）。
 * cross-encoder 把 (query, passage) 一起送进模型联合编码，产出真正的相关性分数，
 * 是唯一能补上语义空白的层（也是评估里收益最大的一层，见 docs 结论）。
 *
 * 工程约束（重要）：
 *   1. 依赖 @huggingface/transformers + onnxruntime，首次使用需下载模型（~279MB 量化版）。
 *   2. 因此本模块**默认不加载**：需 RERANK=1 开启；加载失败一律静默回退原序，
 *      绝不因为重排故障让搜索整体失败。
 *   3. 只重排 top-K（默认 15）候选，控制延迟。
 *
 * 环境变量：
 *   RERANK=1                     启用（默认关闭）
 *   RERANK_MODEL=<hf repo id>    默认 Xenova/bge-reranker-base（中英双语）
 *   RERANK_TOP_K=15              参与重排的候选数
 *   RERANK_WEIGHT=1.0            重排分与 RRF 分的混合比例（1=纯重排序）
 *   RERANK_CACHE_DIR=<path>      模型缓存目录（默认 ./models）
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const RERANK_ENABLED = process.env.RERANK === "1";
const MODEL_ID = process.env.RERANK_MODEL || "Xenova/bge-reranker-base";
const TOP_K = parseInt(process.env.RERANK_TOP_K || "15", 10) || 15;
// 混合权重：0 = 纯 RRF（等于不重排），1 = 纯重排（覆盖原顺序）。
// 实测（eval/result-v2-rrf-rerank.json）：纯重排会把官方文档系统性降级为第三方博客
// （kubernetes.io→komodor.com、go.dev→dev.to、redis.io→stackoverflow、typescriptlang.org→mimo.org），
// nDCG@5 从 0.8396 塌到 0.4628。原因：cross-encoder 优化的是"这段文字像不像在回答问题"，
// 而博客摘要天生写得比官方参考文档更像"直接答案"——模型不编码来源权威性。
// 因此生产默认用低权重做"轻度重排"（吸收强语义信号 + 打破 RRF 平票），而非整体替换顺序。
const WEIGHT = Math.max(0, Math.min(1, parseFloat(process.env.RERANK_WEIGHT ?? "0.35")));
const CACHE_DIR = process.env.RERANK_CACHE_DIR || path.join(moduleDir, "models");

let rankerPromise = null;
let loadFailed = false;
const stats = { calls: 0, reranked: 0, failed: 0, loadMs: 0 };

async function getRanker() {
  if (loadFailed) return null;
  if (!rankerPromise) {
    const t0 = Date.now();
    rankerPromise = (async () => {
      const tf = await import("@huggingface/transformers");
      tf.env.cacheDir = CACHE_DIR;
      tf.env.allowRemoteModels = true;
      const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await tf.AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
        dtype: "q8", // 量化：279MB，CPU 友好
      });
      stats.loadMs = Date.now() - t0;
      console.error(`[rerank] model loaded: ${MODEL_ID} in ${stats.loadMs}ms`);
      return { tf, tokenizer, model };
    })().catch((e) => {
      loadFailed = true;
      rankerPromise = null;
      console.error(`[rerank] load failed, disabling rerank: ${e?.message || e}`);
      return null;
    });
  }
  return rankerPromise;
}

/** 预热：可在空闲时调用，把模型加载从首次查询里挪走。 */
export async function warmup() {
  if (!RERANK_ENABLED) return false;
  const r = await getRanker();
  return !!r;
}

function passageOf(r) {
  const t = String(r.title || "");
  const s = String(r.snippet || "");
  return `${t}${t && s ? " — " : ""}${s}`.slice(0, 512);
}

/**
 * 对 results 做 cross-encoder 重排，返回**新数组**（不改原数组）。
 *
 * 混合策略（关键）：不是用重排分整体替换原顺序，而是
 *   combined = (1-WEIGHT) * rrfNorm + WEIGHT * rerankNorm
 * 其中 rrfNorm 取调用方已归一化的 r.rrf（0~1），rerankNorm 对本次候选做 min-max 归一。
 * WEIGHT=0 时等价于不重排；WEIGHT=1 时等价于纯重排。
 * 失败/未启用时原样返回，保证调用方逻辑简单。
 */
export async function rerankResults(query, results) {
  if (!RERANK_ENABLED || !results?.length) return results;
  // WEIGHT=0 等价于不重排：直接短路，省掉一次模型推理（也避免用 rrfNorm 重排打乱并列次序）
  if (WEIGHT === 0) return results;
  stats.calls++;
  try {
    const ranker = await getRanker();
    if (!ranker) { stats.failed++; return results; }
    const { tokenizer, model } = ranker;

    const head = results.slice(0, TOP_K);
    const tail = results.slice(TOP_K);
    const passages = head.map(passageOf);

    const inputs = await tokenizer(new Array(passages.length).fill(String(query)), {
      text_pair: passages,
      padding: true,
      truncation: true,
    });
    const out = await model(inputs);
    // bge-reranker 输出单个 logit 作为相关性分
    const raw = out.logits.tolist().map((x) => (Array.isArray(x) ? x[0] : x));

    const scores = head.map((_, i) => (typeof raw[i] === "number" ? raw[i] : -Infinity));
    const lo = Math.min(...scores);
    const hi = Math.max(...scores);
    const span = hi - lo || 1; // 全等分时避免除零

    const blended = head.map((r, i) => {
      const rerankNorm = (scores[i] - lo) / span;
      const rrfNorm = typeof r.rrf === "number" ? r.rrf : 0;
      const combined = (1 - WEIGHT) * rrfNorm + WEIGHT * rerankNorm;
      return { r, s: scores[i], combined };
    });
    blended.sort((a, b) => b.combined - a.combined);
    stats.reranked++;
    return [
      ...blended.map((x) => ({ ...x.r, rerankScore: x.s, _blended: x.combined })),
      ...tail,
    ];
  } catch (e) {
    stats.failed++;
    console.error(`[rerank] inference failed, keeping original order: ${e?.message || e}`);
    return results;
  }
}

export function __rerankStats() {
  return { ...stats, enabled: RERANK_ENABLED, model: MODEL_ID, topK: TOP_K, weight: WEIGHT, loadFailed, cacheDir: CACHE_DIR };
}

/** 模型是否已就绪（不触发加载）。 */
export function isReady() {
  try {
    return fs.existsSync(CACHE_DIR);
  } catch {
    return false;
  }
}
