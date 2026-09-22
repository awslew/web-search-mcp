/**
 * test-mcp-e2e.mjs — MCP 端到端冒烟（真实 stdio JSON-RPC + 真实联网抓取）
 *
 * 真的起 `server-cn.mjs` 子进程，走 stdio JSON-RPC，调 tools/list 与 tools/call，
 * 验证新契约（`format` 参数 + Markdown 输出 + 站内选择器 + 中文编码 + 单 H1）
 * 在**真实链路**上成立。
 *
 * 为什么不替代单测：抽取**质量**由 `eval/extract.test.mjs` 离线保证（注入 fetch、可控夹具）；
 * 本文件只验证"接线是否正确"——即 server 的 JSON-RPC schema 与 handler 真的把参数透传下去了。
 * 两者互补：单测快且确定，本文件慢且依赖网络，但能发现"模块对、接线错"这类问题。
 *
 * 从 tmp_mcp_smoke.mjs 改名而来（2026-09-21）：它已是常态验证的一部分，不该再挂 `tmp_` 前缀。
 * 2026-09-21 实测：example.com / developers.weixin.qq.com（命中站内选择器，标题带站点后缀
 * 且正文单 H1）/ www.gov.cn（中文列表页）三站，各 15 项全过。
 *
 * 用法：node test-mcp-e2e.mjs [url]
 *   node test-mcp-e2e.mjs https://developers.weixin.qq.com/miniprogram/dev/framework/
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server-cn.mjs");

// 默认用**中文真实页面**而不是 example.com：中文页才能真正覆盖
// 站内选择器 / 中文编码 / 标题去重这三条本项目的重点路径。
const URL_TO_FETCH = process.argv[2] || "https://developers.weixin.qq.com/miniprogram/dev/framework/";

const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 40000);
  });
}

const results = [];
let skipped = 0;
function check(name, cond, detail = "") {
  results.push({ name, cond });
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name}  -- ${reason}`);
}

/**
 * 抓取失败是**网络/目标站波动**还是**代码问题**？必须区分开。
 *
 * 沿用 `test-search.mjs` 的既有约定（那里对代理不可用一律 SKIP 并标注"非代码问题"）：
 * 本套件走真实网络，若因超时/连接失败/目标站限流而拿不到内容，**断言没验到代码**，
 * 记为 SKIP 而不是 FAIL —— 否则一次网络抖动就会被误读成"改动引入回归"
 * （本文件第一次纳入 `npm test` 时就发生过：同一份代码连跑两次，一次 8/8、一次 7/8）。
 * 反之，只要**拿到了内容但内容不对**，一律 FAIL —— 那才是真回归。
 */
function isTransientFetchFailure(text) {
  return /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|502|503|504|429/i.test(text);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("initialize 成功", !!init.result?.serverInfo, JSON.stringify(init).slice(0, 200));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("\n═══ tools/list 契约 ═══");
  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  check("注册了三个工具", names.includes("web_search") && names.includes("web_fetch") && names.includes("site_search"), names.join(","));

  const wf = (tools.result?.tools || []).find((t) => t.name === "web_fetch");
  check("web_fetch 声明 format 参数", !!wf?.inputSchema?.properties?.format, JSON.stringify(wf?.inputSchema?.properties));
  check("format 枚举含 markdown/text", JSON.stringify(wf?.inputSchema?.properties?.format?.enum) === '["markdown","text"]');
  check("format 默认 markdown", wf?.inputSchema?.properties?.format?.default === "markdown");

  console.log(`\n═══ tools/call web_fetch（真实联网抓 ${URL_TO_FETCH}）═══`);
  const md = await rpc("tools/call", { name: "web_fetch", arguments: { url: URL_TO_FETCH, max_length: 3000 } });
  const mdText = md.result?.content?.[0]?.text || "";

  // 抓不到内容 → 整组内容断言 SKIP（接线类断言上面已验完，不受影响）
  if (!mdText || isTransientFetchFailure(mdText)) {
    skip("web_fetch 内容断言（markdown）", `目标站不可达/超时，非代码问题：${mdText.slice(0, 60)}`);
  } else {
    check("返回非空内容", mdText.length > 0, `len=${mdText.length}`);
    check("含标题头与 URL", /^# /m.test(mdText) && mdText.includes(`URL: ${URL_TO_FETCH}`), mdText.slice(0, 120));
    check("标题只出现一次 H1", (mdText.match(/^# /gm) || []).length === 1, `H1 数=${(mdText.match(/^# /gm) || []).length}`);

    // ── 中文内容断言 ──
    // 必要性（2026-09-21 补）：上面几条在**一整页乱码**的情况下同样会通过
    // （乱码页也有 # 标题行、也有 URL、也只有一个 H1）。中文站点必须单独断言"真的读出了中文"，
    // 否则这条端到端测试对"编码搞错"这种最典型的中文故障是瞎的。
    const cjkCount = (mdText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const mojibake = (mdText.match(/\uFFFD/g) || []).length;
    check("输出含足量中文（真的读出了内容，不是乱码页）", cjkCount >= 20, `中文字数=${cjkCount}`);
    check("无替换符乱码", mojibake === 0, `U+FFFD 个数=${mojibake}`);
    check("标题不是纯英文（中文站标题应含中文）", /[\u4e00-\u9fa5]/.test(mdText.split("\n")[0] || ""), `标题=${mdText.split("\n")[0]}`);
    console.log(`  ── markdown 输出前 260 字 ──\n${mdText.slice(0, 260)}\n`);

    const txt = await rpc("tools/call", { name: "web_fetch", arguments: { url: URL_TO_FETCH, max_length: 3000, format: "text" } });
    const txtText = txt.result?.content?.[0]?.text || "";
    check("format=text 生效", txtText.length > 0 && txtText !== mdText, `len=${txtText.length}`);
    const bodyLines = txtText.split("\n").filter((l) => l.trim()).length;
    check("text 模式保留段落（非单行）", bodyLines >= 3, `行数=${bodyLines}`);
    console.log(`  ── text 输出前 200 字 ──\n${txtText.slice(0, 200)}\n`);
  }

  console.log("═══ 错误路径 ═══");
  const bad = await rpc("tools/call", { name: "web_fetch", arguments: { url: "not-a-url" } });
  const badText = bad.result?.content?.[0]?.text || "";
  check("非法 URL 返回可读错误", bad.result?.isError === true || /Invalid URL|Error/i.test(badText), badText.slice(0, 120));

  // 非法 format 值：schema 声明了 enum，客户端越界时必须有确定行为（不能静默当 markdown）
  let badFmt = null;
  try {
    const r = await rpc("tools/call", { name: "web_fetch", arguments: { url: URL_TO_FETCH, max_length: 500, format: "html" } });
    badFmt = r.result?.isError === true ? "rejected" : (r.result?.content?.[0]?.text ? "accepted" : "empty");
  } catch (e) { badFmt = `throw:${e.message}`; }
  check("非法 format 有确定行为（报错或按默认处理，不静默出错值）",
    badFmt === "rejected" || badFmt === "accepted", String(badFmt));
} catch (e) {
  // 整体异常不一定是代码问题：子进程起不来/网络全断也会走到这里。
  // 但仍记为失败——因为"连 server 都起不来"本身就是必须被看到的信号。
  console.log(`\n✗ 冒烟测试异常: ${e.message}`);
  results.push({ name: "整体执行", cond: false });
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.cond);
console.log("\n" + "═".repeat(60));
console.log(`MCP 冒烟：${results.length - failed.length} 通过 / ${failed.length} 失败 / ${skipped} SKIP`);
if (failed.length) { console.log(`失败项：${failed.map((f) => f.name).join(", ")}`); process.exit(1); }
if (skipped) console.log("（SKIP = 目标站不可达/超时，非代码问题；重跑或用 `node test-mcp-e2e.mjs <url>` 换目标站）");
