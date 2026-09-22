#!/usr/bin/env node
/**
 * run-tests.mjs — 各套测试的顺序驱动（**替代 npm 的 `A && B && C` 链**）。
 *
 * 为什么需要这个文件（2026-09-12 实测定位）：
 * 在 Windows 上经 cmd.exe 链式执行时，**最后一个** node 进程约有半数概率在**退出期**
 * 触发 libuv 断言硬崩（exit 0xC0000409 / -1073740791）。对照实验：
 *   · `node eval/gate.test.mjs` 单独跑 ......... 0/6 崩溃
 *   · PowerShell 里逐进程手工调用（同顺序）.... 0/4 崩溃
 *   · cmd.exe `A && B && C && D` ............... 4/6 崩溃
 *   · `npm test`（内部即 cmd 链）............... 3/6 崩溃
 * 四套断言其实**全绿**，只是退出码异常，会让 CI/自动化误判为失败。
 * 改用 Node 逐进程 spawn（stdio 继承）后不经过 cmd 的链式包装，稳定性与手工调用一致。
 *
 * 用法：
 *   node run-tests.mjs            # 全部套件
 *   node run-tests.mjs --unit     # 跳过 test-search.mjs（它走真实网络，最慢）
 *   node run-tests.mjs --only gate
 */
import { spawnSync } from "node:child_process";

const SUITES = [
  ["test-search.mjs", "通道自测（真实网络，含代理用例）"],
  ["test-mcp-e2e.mjs", "MCP 端到端（真实 stdio JSON-RPC + 联网抓中文页）"],
  ["eval/echo.test.mjs", "防回显 / 排序公式"],
  ["eval/parsers.test.mjs", "解析器（注入 fetch，离线）"],
  ["eval/api-parsers.test.mjs", "搜索 API 解析器（注入 fetch，离线）"],
  ["eval/extract.test.mjs", "正文抽取管线（注入 fetch，离线）"],
  ["eval/gate.test.mjs", "API 抢救闸门（注入 fetch，离线）"],
  ["eval/officialdocs.test.mjs", "官方文档召回通道（注入 fetch，离线）"],
  ["eval/provider-select.test.mjs", "评估脚本的 provider 选择（离线）"],
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
let suites = SUITES;
// --unit：跳过走**真实网络**的套件（最慢，且结果受引擎/网关状态影响）
if (args.includes("--unit")) suites = suites.filter(([f]) => f !== "test-search.mjs" && f !== "test-mcp-e2e.mjs");
if (only) suites = suites.filter(([f]) => f.includes(only));
if (!suites.length) {
  console.error(`没有匹配的测试套件（--only ${only}）`);
  process.exit(1);
}

let failed = 0;
const summary = [];
const NET_SUITES = new Set(["test-search.mjs", "test-mcp-e2e.mjs"]);
for (const [file, label] of suites) {
  console.log(`\n──────── ${file}   ${label}`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status !== 0) {
    failed++;
    console.log(`⚠️  ${file} 退出码 ${r.status}`);
    // 联网套件退出码非 0 时给一句归因提示：本项目历史上出现过
    // "网络抖动导致套件失败 → 被误读成代码回归"的误判。
    if (NET_SUITES.has(file)) {
      console.log(`   提示：${file} 走真实网络。若是抓取超时/目标站限流，属环境问题而非代码回归；`);
      console.log(`         先单独重跑确认：node ${file}`);
    }
  }
  summary.push(`${r.status === 0 ? "✓" : "✗"} ${file}`);
}

console.log(`\n──────── 汇总（${suites.length - failed}/${suites.length} 套通过）`);
for (const s of summary) console.log(`   ${s}`);
// 只有确实跑了联网套件时才提示"结果受网络影响"；--unit 下它们是过滤掉的，提示会变成空行
const ranNet = [...NET_SUITES].filter((f) => suites.some(([s]) => s === f));
if (ranNet.length) {
  console.log(`   注：${ranNet.join(" / ")} 走真实网络，受引擎健康/目标站限流影响；`);
  console.log(`       要只跑确定性离线套件用 npm run test:unit`);
}
process.exitCode = failed ? 1 : 0;
