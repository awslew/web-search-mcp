#!/usr/bin/env node
/**
 * provider-select.test.mjs — 评估脚本的 provider 选择逻辑（离线，注入 env）
 *
 * 为什么值得单独测：这段逻辑一旦出错**不会报错，只会给出错误的结论**——
 *   ① 配了多家时无法单独评估某一家 → "验证过了"其实只验证了优先级最高那家；
 *   ② `api-ab.mjs` 的缓存按 provider 命名，但"查询齐全即复用"的判断与 provider 无关
 *      → 先跑 tavily、后改配智谱时会复用旧缓存，报告却写 provider=zhipu。
 * 这两种都属于"看着有结果、其实归因错了"，比直接崩溃危险得多。
 *
 * 做法：直接调用 `eval/lib.mjs` 的 selectProvider()，用 env 构造各种组合来断言。
 * 注：lib.mjs 只 import search-core 与 fs/path/url，不发网络请求，可安全离线调用。
 *
 * 用法：node eval/provider-select.test.mjs
 */
import fs from "node:fs";
import { selectProvider, KNOWN_PROVIDERS } from "./lib.mjs";
import { __setRegistryFallback, __setRegistryReader, __reloadApiKeys, apiEngineAvailable } from "../search-core.mjs";

/**
 * 密封注册表兜底（2026-09-21 补）：
 * `loadApiKeys()` 的第三个来源是 Windows 用户注册表（见 search-core 的"密钥来源"注释）。
 * 本套的第 1~5 节断言"无 key / 只配某一家"这类**局面**，隐式假设密钥来源只有 env。
 * 本机 HKCU\Environment 里配了真 tavily key 时，注册表兜底会把 tavily 补回来，
 * 于是："无 key → allConfigured 为空" 变成 ["tavily"]、
 * "只配 bocha → provider=bocha" 变成 provider=tavily（实测 22 PASS / 6 FAIL）。
 *
 * `selectProvider` 是**进程内**调用 `__reloadApiKeys()`（不 spawn 子进程），
 * 所以这里关掉即可完全密封，无需动子进程环境。
 */
const _registryWasOn = __setRegistryFallback(false);
process.on("exit", () => { try { __setRegistryFallback(_registryWasOn); } catch { /* 忽略 */ } });

let pass = 0, fail = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

const KEYS = ["TAVILY_API_KEY", "BOCHA_API_KEY", "ZHIPU_API_KEY"];

/**
 * 在子 env 里跑被测函数，并捕获 process.exit 与 stderr。
 * selectProvider 在参数非法时会 console.error + process.exit(1)，
 * 直接用会杀掉测试进程，故需要包一层。
 */
function runWith({ env = {}, clearAll = true }) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  const savedForced = process.env.API_PROVIDER;
  const savedExit = process.exit, savedErr = console.error;
  let exited = null, errText = "";
  // 快照必须在 finally 还原 env **之前**取：selectProvider 会清掉别家的 key，
  // 若在 runWith 返回后再断言 process.env，只会看到还原后的值（曾经因此误判过一次）。
  const envAfter = {};
  try {
    if (clearAll) for (const k of KEYS) delete process.env[k];
    delete process.env.API_PROVIDER;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    process.exit = (code) => { exited = code; throw new Error("__EXIT__"); };
    console.error = (...a) => { errText += a.join(" ") + "\n"; };
    let ret = null;
    try { ret = selectProvider(); } catch (e) { if (e.message !== "__EXIT__") throw e; }
    for (const k of KEYS) envAfter[k] = process.env[k];
    return { ret, exited, errText, envAfter };
  } finally {
    process.exit = savedExit; console.error = savedErr;
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (savedForced === undefined) delete process.env.API_PROVIDER; else process.env.API_PROVIDER = savedForced;
  }
}

console.log("\n═══ 1. 无 key ═══");
{
  const r = runWith({ env: {} });
  t("无 key → provider 为 null，且不退出", r.ret?.provider === null && r.exited === null, JSON.stringify(r.ret));
  t("无 key → allConfigured 为空数组", Array.isArray(r.ret?.allConfigured) && r.ret.allConfigured.length === 0, JSON.stringify(r.ret?.allConfigured));
}

console.log("\n═══ 2. 单家 key → 就该是那家 ═══");
for (const p of KNOWN_PROVIDERS) {
  const r = runWith({ env: { [`${p.toUpperCase()}_API_KEY`]: `k-${p}` } });
  t(`只配 ${p} → provider=${p}`, r.ret?.provider === p, JSON.stringify(r.ret));
  t(`只配 ${p} → allConfigured=[${p}]`, JSON.stringify(r.ret?.allConfigured) === JSON.stringify([p]), JSON.stringify(r.ret?.allConfigured));
}

console.log("\n═══ 3. 多家 key：默认取优先级最高（且 must 报告还有哪些家） ═══");
{
  const r = runWith({ env: { TAVILY_API_KEY: "t", BOCHA_API_KEY: "b", ZHIPU_API_KEY: "z" } });
  t("三家都配 → 默认 provider=tavily（代码优先级）", r.ret?.provider === "tavily", JSON.stringify(r.ret));
  t("三家都配 → allConfigured 为三家（供上层提示“只测了一家”）", r.ret?.allConfigured.length === 3, JSON.stringify(r.ret?.allConfigured));
  t("三家都配 → forced=false", r.ret?.forced === false, String(r.ret?.forced));
}

console.log("\n═══ 4. API_PROVIDER 覆盖：即使高优先级那家也配了 key ═══");
{
  const r = runWith({ env: { TAVILY_API_KEY: "t", ZHIPU_API_KEY: "z", API_PROVIDER: "zhipu" } });
  t("强制 zhipu → provider=zhipu（不再被 tavily 抢走）", r.ret?.provider === "zhipu", JSON.stringify(r.ret));
  t("强制 zhipu → forced=true", r.ret?.forced === true, String(r.ret?.forced));
  // 关键副作用：必须把高优先级那家的 env key 清掉，否则 searchApi 仍会走 tavily
  t("强制 zhipu → 已清掉 TAVILY_API_KEY（否则 searchApi 仍走 tavily）", !r.envAfter.TAVILY_API_KEY, String(r.envAfter.TAVILY_API_KEY));
  t("强制 zhipu → 保留 ZHIPU_API_KEY", Boolean(r.envAfter.ZHIPU_API_KEY), String(r.envAfter.ZHIPU_API_KEY));
}

console.log("\n═══ 5. 非法 / 未配置的强制指定必须明确失败（不能静默降级） ═══");
{
  const r1 = runWith({ env: { ZHIPU_API_KEY: "z", API_PROVIDER: "bogus" } });
  t("非法 API_PROVIDER → 退出码 1", r1.exited === 1, String(r1.exited));
  t("非法 API_PROVIDER → 报错列出可选值", /tavily\/bocha\/zhipu/.test(r1.errText), r1.errText.trim());

  const r2 = runWith({ env: { TAVILY_API_KEY: "t", API_PROVIDER: "bocha" } });
  t("指定的那家没配 key → 退出码 1", r2.exited === 1, String(r2.exited));
  t("指定的那家没配 key → 提示该设哪个环境变量", /BOCHA_API_KEY/.test(r2.errText), r2.errText.trim());
  t("指定的那家没配 key → 顺带告知已配了哪家", /tavily/.test(r2.errText), r2.errText.trim());
}

console.log("\n═══ 6. api-ab 的缓存-provider 一致性（静态检查，防止再次踩坑） ═══");
{
  const src = fs.readFileSync(new URL("./api-ab.mjs", import.meta.url), "utf8");
  t("api-ab 会核对缓存内的 provider 字段", /cached\.provider\s*!==\s*provider/.test(src), "未找到 cached.provider 比对");
  t("api-ab 不匹配时应当忽略缓存（有提示）", /与本次 .* 不符/.test(src) || /不符 → 忽略该缓存/.test(src), "未找到不符提示");
  t("api-ab 落盘前会校正 store.provider", /store\.provider = provider/.test(src), "未找到 store.provider 校正");
  t("api-ab 使用共享 selectProvider（不再自己推断）", /selectProvider/.test(src) && !/keys\.tavily \? "tavily"/.test(src), "仍在自行推断 provider");

  const src2 = fs.readFileSync(new URL("./api-score.mjs", import.meta.url), "utf8");
  t("api-score 使用共享 selectProvider", /selectProvider/.test(src2) && !/keys\.tavily \? "tavily"/.test(src2), "仍在自行推断 provider");
  t("api-score 结果文件名带语种范围（防只测一家被误读）", /scopeSuffix/.test(src2), "未找到 scopeSuffix");
}

console.log("\n═══ 7. verify-api 与 eval 脚本行为一致 ═══");
{
  const src = fs.readFileSync(new URL("../verify-api.mjs", import.meta.url), "utf8");
  t("verify-api 使用共享 selectProvider", /selectProvider/.test(src), "未使用共享 helper");
  t("verify-api 不再自己拼 provider 推断", !/keys\.tavily \? "tavily"/.test(src), "仍自行推断");
}

console.log("\n═══ 8. 注册表兜底通道（注入假读取器，机器无关） ═══");
{
  // 这一段覆盖的是"宿主清洗掉环境变量后 key 仍能到达 MCP 进程"的兜底通道（见 search-core 的"密钥来源"注释）。
  // 用注入的假读取器而不是读真实注册表 → 断言确定性，且本套在没配 key 的机器上同样有效。
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  const restoreEnv = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

  try {
    for (const k of KEYS) delete process.env[k];
    // 本节要验证兜底**生效**的路径，而顶部为了第 1~7 节把开关关掉了 → 这里临时打开。
    // 结束时（finally + exit 处理器）都还原成"关"，保证第 1~7 节的密封不被本段破坏。
    __setRegistryFallback(true);

    // (a) 注册表有值 → 兜底生效
    __setRegistryReader((n) => (n === "TAVILY_API_KEY" ? "reg-tavily" : ""));
    t("注册表有值 → 兜底读到 key", __reloadApiKeys().tavily === "reg-tavily", String(__reloadApiKeys().tavily));
    t("注册表有值 → 闸门开启", apiEngineAvailable() === true);

    // (b) 显式 env 必须压过注册表（否则"临时覆盖"能力会失效）
    process.env.TAVILY_API_KEY = "env-wins";
    t("env 优先于注册表", __reloadApiKeys().tavily === "env-wins", String(__reloadApiKeys().tavily));
    delete process.env.TAVILY_API_KEY;

    // (c) 关掉开关 → 兜底失效（gate/api-parsers 的密封依赖这一条）
    // `prev` 反映的是**本条之前**的状态。此时本节已把开关打开（见 try 开头），
    // 故期望 true —— 第一版误写成 false，是"忘了本节开头刚打开"导致的。
    const prev = __setRegistryFallback(false);
    t("关闭开关 → 注册表不再被读取", __reloadApiKeys().tavily === undefined, String(__reloadApiKeys().tavily));
    t("关闭开关 → 闸门关闭", apiEngineAvailable() === false);
    t("__setRegistryFallback 返回旧值以便还原", prev === true, String(prev));
    __setRegistryFallback(true);

    // (d) 恢复后兜底重新生效（证明 (c) 不是把状态永久改坏）
    t("恢复开关 → 兜底重新生效", __reloadApiKeys().tavily === "reg-tavily", String(__reloadApiKeys().tavily));

    // (e) 空串/空白不得被当成"已配置"
    __setRegistryReader(() => "   ");
    t("注册表返回空白 → 不得当成已配置", __reloadApiKeys().tavily === undefined, String(__reloadApiKeys().tavily));

    // (f) 读取器抛错不得让整个密钥加载崩掉
    __setRegistryReader(() => { throw new Error("simulated registry failure"); });
    let threw = false;
    try { __reloadApiKeys(); } catch { threw = true; }
    t("注册表读取抛错 → 密钥加载不崩", threw === false);
  } finally {
    __setRegistryReader(null);
    // 还原成"关"（而不是 _registryWasOn）：顶部密封必须维持到进程结束，
    // 否则本节之后若有断言再读密钥，真注册表的 key 会重新混进来。
    __setRegistryFallback(false);
    restoreEnv();
  }
}

console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL ==`);
process.exitCode = fail ? 1 : 0;
