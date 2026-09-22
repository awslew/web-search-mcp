#!/usr/bin/env node
/**
 * parsers.test.mjs — 引擎解析层回归测试（2026-09-12 重写）
 *
 * 重写原因（重要）：旧版本在**测试文件里重新实现了一遍选择器逻辑**（parseBaiduSnippet），
 * 测的是那个副本，不是 search-core.mjs 里的真实解析器。真实解析器改坏时套件照样全绿——
 * 这正是"百度改版 29/29 snippet 变空，而套件 28 PASS"能发生的根因。
 *
 * 现在改为：通过 __setFetchImpl 注入固定 HTML，**直接调用真实的 searchBaiduMobile /
 * searchSo360 / searchBaidu / searchCnBing 等函数**，断言真实输出。
 * 引擎改版（选择器变、URL 字段改名、噪音页混入）会直接让本文件变红。
 *
 * 固定 HTML 片段均取自 2026-09-12 的真实响应结构（已裁剪，保留关键属性/class）。
 */
import { __setFetchImpl, searchBaiduMobile, searchSo360, searchBaidu, searchCnBing, BaiduWallError } from "../search-core.mjs";

let pass = 0, fail = 0;
function t(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

function mockResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "text/html" },
    text: async () => html,
  };
}
function withHtml(html, status = 200) { __setFetchImpl(async () => mockResponse(html, status)); }

// ── 1. m.baidu.com（百度移动端）──
// 关键契约：真实 URL **不在 href**，而在 data-log 属性的 JSON 里（字段 mu）。
// 同时必须滤掉百度系非内容页（实测：m/haokan/baike/ailegal/ikan/recommend_list...）。
const BAIDU_MOBILE = `<html><body>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://developers.weixin.qq.com/minigame/dev/guide/virtual-payment.html","order":1}'>
  <div class="c-result-content"><h3>官方开放能力 / 虚拟支付 / 虚拟支付进件</h3>
  <div class="summary-gap_x">开通条件：主体类型为个体工商户或企业已认证小游戏。</div></div>
</div>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://m.baidu.com/from=844b/s?word=xxx"}'>
  <h3>微信小程序iOS虚拟支付新规 - 知乎</h3><div class="summary-gap_x">百度代理页，应被过滤</div>
</div>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://haokan.baidu.com/v?vid=1"}'>
  <h3>个人小程序终于能收钱 教学视频</h3><div class="summary-gap_x">视频聚合，应被过滤</div>
</div>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://baike.baidu.com/item/x"}'>
  <h3>虚拟支付(经济术语) - 百度百科</h3><div class="summary-gap_x">百科词条，应被过滤</div>
</div>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://34689.recommend_list.baidu.com/x"}'>
  <h3>大家还在搜</h3><div class="summary-gap_x">推荐聚合页，应被过滤</div>
</div>
<div class="c-result result" tpl="www_index" data-log='{"mu":"https://zhidao.baidu.com/question/1"}'>
  <h3>虚拟支付怎么开通 - 百度知道</h3><div class="summary-gap_x">这是有效内容页，应保留（验证过滤不过宽）</div>
</div>
</body></html>`;

withHtml(BAIDU_MOBILE);
{
  const r = await searchBaiduMobile("微信小程序 虚拟支付", 10);
  t("baiduMobile：从 data-log.mu 取到真实 URL（非 href）", r[0]?.url === "https://developers.weixin.qq.com/minigame/dev/guide/virtual-payment.html", r[0]?.url);
  t("baiduMobile：解析出 2 条（4 条噪音被过滤）", r.length === 2, `got ${r.length}: ${r.map(x => x.url).join(" ")}`);
  t("baiduMobile：m.baidu.com 代理页被过滤", !r.some((x) => /m\.baidu\.com/.test(x.url)));
  t("baiduMobile：haokan 视频聚合被过滤", !r.some((x) => /haokan\.baidu\.com/.test(x.url)));
  t("baiduMobile：baike 百科词条被过滤", !r.some((x) => /baike\.baidu\.com/.test(x.url)));
  t("baiduMobile：recommend_list 推荐聚合被过滤", !r.some((x) => /recommend_list/.test(x.url)));
  t("baiduMobile：zhidao（有效答案页）保留 —— 过滤不过宽", r.some((x) => /zhidao\.baidu\.com/.test(x.url)), JSON.stringify(r.map(x => x.url)));
  t("baiduMobile：snippet 非空", (r[0]?.snippet || "").length > 10, JSON.stringify(r[0]?.snippet));
  t("baiduMobile：source 标记正确", r[0]?.source === "baiduMobile", r[0]?.source);
}

// 墙页必须抛 BaiduWallError（否则负缓存不生效，会每查重复撞墙）
withHtml(`<html><head><title>百度安全验证</title></head><body>网络不给力，请稍后重试</body></html>`);
{
  let threw = null;
  try { await searchBaiduMobile("x", 5); } catch (e) { threw = e; }
  t("baiduMobile：墙页抛 BaiduWallError（触发负缓存）", threw instanceof BaiduWallError, String(threw?.name));
}

// 正常页面里含 "wappass" 字样时**不得**误判为墙（实测 m.baidu 正常页含该字样）。
// 注意：注入的是 script 标签引用，不能顺手注入"百度安全验证"字样——那本身就是墙特征。
const BAIDU_OK_WITH_WAPPASS = BAIDU_MOBILE.replace("<body>", '<body><script src="https://wappass.baidu.com/static/x.js"></script>');
withHtml(BAIDU_OK_WITH_WAPPASS);
{
  let threw = null, r = [];
  try { r = await searchBaiduMobile("微信小程序 虚拟支付", 10); } catch (e) { threw = e; }
  t("baiduMobile：页内含 wappass 字样不误判为墙", !threw && r.length === 2, String(threw?.message || `n=${r.length}`));
}

// ── 2. www.so.com（360 搜索）──
// 关键契约：真实 URL 在 a 的 **data-mdurl** 属性；自家聚合页（so.com/360.cn）必须过滤。
const SO360 = `<html><body><ul class="result">
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://blog.csdn.net/x/article/1">微信小程序虚拟支付全解析</a></h3><p class="res-desc">接入流程与费率说明。</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=def" data-mdurl="https://ai.so.com/search/so123">微信小程序虚拟支付</a></h3><p class="res-desc">自家 AI 卡片，应被过滤</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=ghi" data-mdurl="https://image.so.com/i?q=xxx">【图】虚拟支付整改通知</a></h3><p class="res-desc">图片垂直页，应被过滤</p></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=jkl" data-mdurl="https://www.woshipm.com/it/123.html">微信小程序虚拟支付正式开放</a></h3><p class="res-desc">个人开发者不用注册公司了。</p></li>
</ul></body></html>`;

withHtml(SO360);
{
  const r = await searchSo360("微信小程序 虚拟支付", 10);
  t("so360：从 data-mdurl 取真实 URL（非跳转链）", r[0]?.url === "https://blog.csdn.net/x/article/1", r[0]?.url);
  t("so360：过滤自家聚合页后剩 2 条", r.length === 2, `got ${r.length}: ${r.map(x => x.url).join(" ")}`);
  t("so360：ai.so.com AI 卡片被过滤", !r.some((x) => /ai\.so\.com/.test(x.url)));
  t("so360：image.so.com 垂直页被过滤", !r.some((x) => /image\.so\.com/.test(x.url)));
  t("so360：snippet 非空", (r[0]?.snippet || "").length > 5, JSON.stringify(r[0]?.snippet));
  t("so360：source 标记正确", r[0]?.source === "so360", r[0]?.source);
}

// ── 3. 桌面百度（已不用于生产，但函数仍在英文兜底/兼容路径中使用）──
const BAIDU_DESKTOP = `<html><body>
<div class="result c-container" mu="https://docs.example.com/vue3">
  <h3><a href="https://www.baidu.com/link?url=abc">Vue3 组合式 API</a></h3>
  <div class="summary_xyz">Vue3 使用组合式 API 的地方为 setup。</div>
</div>
<div class="result c-container" mu="null">
  <h3><a href="https://www.baidu.com/link?url=def">无 mu 的候选</a></h3>
  <div class="summary_abc">应当走 rawUrl 分支</div>
</div>
</body></html>`;
withHtml(BAIDU_DESKTOP);
{
  const r = await searchBaidu("vue3 组合式 api", 10);
  t("baidu 桌面：解析出 2 条", r.length === 2, `got ${r.length}`);
  t("baidu 桌面：新版 [class*=summary] 取到 snippet", /组合式 API 的地方为 setup/.test(r[0]?.snippet || ""), r[0]?.snippet);
}

// ── 4. cn.bing（.b_algo，snippet 在 .b_caption p）──
const BING = `<html><body>
<li class="b_algo"><h2><a href="https://docs.docker.com/storage/volumes/">Volumes</a></h2>
<div class="b_caption"><p>Docker volumes are the preferred mechanism for persisting data.</p></div></li>
<li class="b_algo"><h2><a href="https://docs.docker.com/engine/storage/">Storage</a></h2>
<div class="b_caption"><p>Storage overview.</p></div></li>
</body></html>`;
withHtml(BING);
{
  const r = await searchCnBing("docker volumes", 10);
  t("cnBing：.b_algo 解析出 2 条", r.length === 2, `got ${r.length}`);
  t("cnBing：snippet 非空", (r[0]?.snippet || "").length > 10);
  t("cnBing：标题正确", r[0]?.title === "Volumes", r[0]?.title);
}

__setFetchImpl(null); // 恢复真实网络（避免影响同进程后续测试）

// 显式关闭 undici dispatcher，并用 exitCode 而非 process.exit()：
// 本测试全程走注入的 fetch、不发真实请求，但 search-core 导入时会因 HTTP(S)_PROXY 存在而安装
// ProxyAgent；进程退出时若仍有未关闭的 agent socket，会触发 libuv teardown 断言硬崩
// （实测约半数概率 0xC0000409）。断言其实全绿，但退出码异常会让 CI/npm test 误判为失败。
try {
  const { getGlobalDispatcher } = await import("undici");
  const { directDispatcher } = await import("../search-core.mjs");
  await Promise.allSettled([getGlobalDispatcher()?.close?.(), directDispatcher()?.close?.()]);
} catch { /* 清理失败不影响断言结论 */ }

console.log(`\n== SUMMARY: ${pass} PASS, ${fail} FAIL ==`);
process.exitCode = fail ? 1 : 0;
