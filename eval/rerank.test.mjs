// _test-rerank.mjs — 验证重排器加载与推理
import { rerankResults, __rerankStats, warmup } from "../rerank.mjs";

console.log("stats before:", JSON.stringify(__rerankStats()));

const t0 = Date.now();
const ok = await warmup();
console.log(`warmup=${ok}  took ${Date.now() - t0}ms`);
console.log("stats after:", JSON.stringify(__rerankStats()));

// 构造一个"词面差异大、语义相关"的经典用例，检验 cross-encoder 是否真懂语义
const query = "撤销最近一次 commit";
const results = [
  { title: "Git 提交规范 - Conventional Commits", snippet: "feat: 新功能 fix: 修复 bug docs: 文档变更", url: "https://a.com/1" },
  { title: "git reset --soft HEAD~1 用法", snippet: "把最近一次提交撤回到暂存区，常用于撤销 commit 但不丢改动", url: "https://git-scm.com/docs/git-reset" },
  { title: "如何修改最后一次提交信息", snippet: "git commit --amend 修改最近一次 commit 的 message", url: "https://a.com/3" },
  { title: "今天天气怎么样", snippet: "晴转多云，气温 18-26 度", url: "https://a.com/4" },
];

const out = await rerankResults(query, results);
console.log("\n重排后顺序：");
out.forEach((r, i) => console.log(`  ${i + 1}. [score=${r.rerankScore?.toFixed(3)}] ${r.title}`));

console.log("\nstats:", JSON.stringify(__rerankStats()));
