/**
 * 正文抽取管线离线测试（不联网，注入假 fetch）。
 *
 * 范式沿用仓库已有的 eval/parsers.test.mjs：注入 fetch → 驱动真实抽取函数 → 断言输出。
 * 断言用「正文保留 + 噪音不泄漏 + 结构标记」三向校验，而不是只看字数——
 * 只看字数会奖励「抽到整页噪音」的实现（见 extract-core.mjs 顶部决策记录）。
 *
 * 用法：node eval/extract.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { fetchUrl, extractMainContent, detectCharset, decodeBody } from "../extract-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 构造一个假的 fetch 实现，返回指定的响应体与 content-type。 */
function fakeFetch({ body, contentType = "text/html; charset=utf-8", status = 200, statusText = "OK" }) {
  return async () => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

const basicHtml = fs.readFileSync(path.join(FIXTURES, "extract-basic.html"), "utf8");

console.log("\n═══ 1. 基础夹具：正文保留 + 噪音剔除 + 结构保留 ═══");
{
  const out = await fetchUrl("https://example.com/doc", 8000, { fetchImpl: fakeFetch({ body: basicHtml }) });

  const MUST_KEEP = ["虚拟支付接入指南", "个人主体小程序", "已完成微信认证", "wx.requestPayment", "签名失败", "密钥不匹配", "小程序开发文档"];
  const MUST_DROP = ["限时优惠", "优惠券", "热门文章一", "相关推荐", "版权所有", "隐私政策", "扫码加入交流群", "window.__noise"];

  for (const s of MUST_KEEP) check(`保留正文「${s}」`, out.includes(s));
  for (const s of MUST_DROP) check(`剔除噪音「${s}」`, !out.includes(s));

  check("输出 Markdown ATX 标题", /^#{1,6} /m.test(out));
  check("输出围栏代码块", out.includes("```"));
  check("输出 GFM 表格", /^\|/m.test(out));
  check("输出链接", /\]\(http/.test(out));
  check("带 URL 与标题头", out.includes("URL: https://example.com/doc") && out.startsWith("# "));
  check("标题不重复出现为两个 H1", (out.match(/^# /gm) || []).length === 1, `H1 数=${(out.match(/^# /gm) || []).length}`);
}

console.log("\n═══ 1b. 标题去重：站点自锚链接 + 带站点后缀的 <title>（实测微信文档形态） ═══");
{
  // 取自实测 https://developers.weixin.qq.com/miniprogram/dev/framework/ 的真实结构：
  //   正文 H1：<h1 id="小程序开发指南"><a href="#小程序开发指南" class="header-anchor">#</a> 小程序开发指南</h1>
  //   页面标题：<title>小程序开发指南 | 微信开放文档</title>
  // 踩过的两个坑（本用例专门锁住，缺一个就会重复输出大标题）：
  //   ① 锚点链接的**链接文字就是 `#`** 本身 → 剥链接时必须整个丢掉，
  //      否则得到 `# 小程序开发指南`，那个井号被当成 ATX 前缀，比较必然失败；
  //   ② `<title>` 带**站点后缀** → 必须剥掉 `| 站点名` 再比，逐字比较必然失败。
  const html = `<!DOCTYPE html><html><head><title>小程序开发指南 | 微信开放文档</title></head><body>
    <div class="markdown-body">
      <h1 id="小程序开发指南"><a href="#小程序开发指南" class="header-anchor">#</a> 小程序开发指南</h1>
      <p>${"小程序提供了一个简单、高效的应用开发框架和丰富的组件及API。".repeat(6)}</p>
      <h2>目录</h2>
      <ul><li>框架</li><li>组件</li></ul>
    </div></body></html>`;
  const out = await fetchUrl("https://developers.weixin.qq.com/miniprogram/dev/framework/", 8000, {
    fetchImpl: fakeFetch({ body: html }),
  });
  const h1s = out.match(/^# .*/gm) || [];
  check("带站点后缀的标题被去重（只 1 个 H1）", h1s.length === 1, `H1 数=${h1s.length}: ${JSON.stringify(h1s)}`);
  check("标题头用的是 <title>", (h1s[0] || "").includes("小程序开发指南 | 微信开放文档"), h1s[0]);
  check("正文不再出现锚点装饰 [!](#…)", !out.includes("[#](#"), out.slice(0, 160));
  check("H2 结构保留", /^## 目录$/m.test(out), out.slice(0, 200));

  // 反向：标题**不**同名时不得误删（否则会吃掉真正的第一节标题）
  const html2 = `<!DOCTYPE html><html><head><title>站点首页 | 某站</title></head><body>
    <article><h1>完全不同的第一节标题</h1>
      <p>${"这段正文足够长，用来让 Readability 稳定识别为正文区域，避免被当成噪音剔除。".repeat(6)}</p></article></body></html>`;
  const out2 = await fetchUrl("https://example.com/other", 8000, { fetchImpl: fakeFetch({ body: html2 }) });
  check("标题不同名时保留正文 H1（不过度去重）", out2.includes("完全不同的第一节标题"), out2.slice(0, 160));
}

console.log("\n═══ 2. 回归防护：旧实现「第一块」选错就丢正文 ═══");
{
  // 第一个 article 是空的（占位/广告容器），真正文在第二个。
  // 旧实现用 .first() 会抽到这个空块；新实现应挑文字最多的块或交给 Readability。
  const html = `<!DOCTYPE html><html><head><title>选块测试</title></head><body>
    <article class="post-content"><p>敬请期待</p></article>
    <div class="content"><h1>真正的正文标题</h1>
      <p>${"这是一段足够长的正文内容，用来验证抽取器不会选中前面那个空块。".repeat(6)}</p></div>
    </body></html>`;
  const out = await fetchUrl("https://example.com/x", 8000, { fetchImpl: fakeFetch({ body: html }) });
  check("抽到真正文而非空块", out.includes("真正的正文标题"), `实际: ${out.slice(0, 120)}`);
}

console.log("\n═══ 3. 相对链接不被静默丢弃（linkedom baseURI 修复） ═══");
{
  // linkedom 的 document.baseURI 恒为 null → Readability 内部 new URL(href, null) 抛错被吞掉
  // → parse() 正常返回但链接退化为相对路径。修法是插 <base href>。
  const html = `<!DOCTYPE html><html><head><title>相对链接页</title></head><body>
    <article><h1>相对链接页</h1>
      <p>本页的正文包含一段足够长的说明文字，用来让 Readability 稳定识别为正文区域，避免被当作噪音剔除掉，从而可以验证相对链接是否被正确解析为绝对地址。</p>
      <p>参考 <a href="/docs/absolute-test">相对路径链接</a> 与 <a href="https://example.com/abs">绝对链接</a>。</p>
    </article></body></html>`;
  const out = await fetchUrl("https://example.com/base/page", 8000, { fetchImpl: fakeFetch({ body: html }) });
  check("相对链接被解析为绝对地址", out.includes("https://example.com/docs/absolute-test"), `实际含 /docs/absolute-test: ${out.includes("](/docs/absolute-test)")}`);
  check("绝对链接不受影响", out.includes("https://example.com/abs"));
}

console.log("\n═══ 4. GBK 中文站解码（按 UTF-8 解会整篇乱码） ═══");
{
  const gbkHtml = `<!DOCTYPE html><html><head><meta charset="gb2312"><title>中文站点</title></head>
    <body><article><h1>中文编码测试</h1><p>${"这一段中文使用 GBK 编码，必须正确解码否则全是乱码。".repeat(8)}</p></article></body></html>`;
  const buf = iconv.encode(gbkHtml, "gbk");
  const out = await fetchUrl("https://example.com/gbk", 8000, {
    fetchImpl: fakeFetch({ body: buf, contentType: "text/html; charset=gb2312" }),
  });
  check("GBK 正文正确解码", out.includes("中文编码测试") && out.includes("必须正确解码"));
  check("无替换符乱码", !out.includes("\uFFFD"));

  // header 不带 charset 时，必须靠 meta 嗅探（百度系页面确实返回裸 text/html）
  const out2 = await fetchUrl("https://example.com/gbk2", 8000, {
    fetchImpl: fakeFetch({ body: buf, contentType: "text/html" }),
  });
  check("header 无 charset 时靠 meta 嗅探", out2.includes("中文编码测试"), `实际: ${out2.slice(0, 80)}`);

  check("detectCharset 从 header 取", detectCharset("<html></html>", "text/html; charset=GBK") === "gbk");
  check("detectCharset 从 meta 取", detectCharset('<meta charset="gb2312">') === "gb2312");
  check("detectCharset 默认 utf-8", detectCharset("<html></html>", "text/html") === "utf-8");
  check("decodeBody 往返一致", decodeBody(iconv.encode("虚拟支付", "gbk"), "text/html; charset=gbk") === "虚拟支付");
}

console.log("\n═══ 4b. 声明与字节**互相矛盾**时的行为（真实世界的恶劣组合） ═══");
{
  // 背景（2026-09-21 实测）：扫描 30 个中国老站（部委/政务/高校/银行/12306/国家电网）
  // **全部是 UTF-8**，一个 GBK 都没有 —— 所以 GBK 分支是**兜底**而非常规路径。
  // 但"声明与字节矛盾"这种恶劣组合仍可能出现（中间层改写编码、老站迁移未改 meta、
  // 或服务端把 UTF-8 内容配上 charset=gb2312 的旧 header）。这里锁定现行为，防回归。

  const utf8Bytes = iconv.encode("虚拟支付开通条件", "utf8");

  // ① 字节是 UTF-8，但 header 谎称 gbk → 必须靠"替换符占比"退回 utf-8，不能吐乱码
  const a = decodeBody(utf8Bytes, "text/html; charset=gbk");
  check("字节UTF8 + header谎称gbk → 退回utf8得可读中文", a === "虚拟支付开通条件", `实际: ${JSON.stringify(a)}`);

  // ② 字节是 GBK，但 header 谎称 utf-8 → 我们信 header，会出乱码。
  //    这是**已知且有意接受**的取舍：header 优先级高于 meta（遵循浏览器行为），
  //    而"声明 utf-8 却发 gbk 字节"的服务端本身就是坏的。此处固化预期行为，
  //    以便将来若改判据能立刻看出差异。
  const gbkBytes = iconv.encode("虚拟支付开通条件", "gbk");
  const b = decodeBody(gbkBytes, "text/html; charset=utf-8");
  check("字节GBK + header谎称utf8 → 按header解（会乱码，属已知取舍）", b !== "虚拟支付开通条件", `实际: ${JSON.stringify(b)}`);

  // ③ 完全无声明（无 header charset / 无 meta）→ 默认 utf-8
  check("完全无声明 → 默认 utf-8", detectCharset("<html><body>hi</body></html>", "text/html") === "utf-8");

  // ④ meta 声明的两种写法都要认（老站常用 http-equiv 那种）
  check("meta http-equiv 写法可识别", detectCharset('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">') === "gb2312");
  check("meta charset 在 4KB 内可识别", detectCharset("<!-- " + "x".repeat(1000) + " -->" + '<meta charset="gbk">') === "gbk");

  // ⑤ 边界：meta 声明被推到 4KB 窗口之外 → 落回默认 utf-8。（记录该边界，不是 bug 而是权衡）
  const far = "<!-- " + "x".repeat(5000) + " -->" + '<meta charset="gbk">';
  check("meta 超 4KB 窗口 → 落回默认 utf-8（已知边界）", detectCharset(far, "text/html") === "utf-8");
}

console.log("\n═══ 5. 站内选择器优先于 Readability（微信公众号类模板） ═══");
{
  // 模拟微信模板：外层一堆导航噪音，真正文在 #js_content。
  // Readability 在这类中文 CMS 模板上实测只抽出 45 字，必须靠选择器。
  const html = `<!DOCTYPE html><html><head><title>公众号文章</title></head><body>
    <div id="js_article"><div class="rich_media_area_extra">在小说阅读器读本章 去阅读 京ICP备</div>
      <div id="js_content"><h2>正文小标题</h2><p>${"这是公众号正文，必须走站内选择器才能抽全内容。".repeat(12)}</p></div>
    </div><footer>版权信息</footer></body></html>`;
  const r = extractMainContent(html, "https://mp.weixin.qq.com/s/abc123");
  check("命中 site-selector 策略", r.via === "site-selector", `实际 via=${r.via}`);
  const out = await fetchUrl("https://mp.weixin.qq.com/s/abc123", 20000, { fetchImpl: fakeFetch({ body: html }) });
  check("抽到公众号正文", out.includes("正文小标题") && out.includes("必须走站内选择器"));
  check("剔除公众号模板噪音", !out.includes("在小说阅读器读本章"));

  // 未命中站点表时不应误用选择器
  const other = extractMainContent(html, "https://unknown-site.example.com/post");
  check("非白名单站点不误用选择器", other.via !== "site-selector", `实际 via=${other.via}`);
}

console.log("\n═══ 6. text 模式保留段落（旧实现把换行碾成空格） ═══");
{
  const out = await fetchUrl("https://example.com/doc", 8000, {
    fetchImpl: fakeFetch({ body: basicHtml }),
    markdown: false,
  });
  const lines = out.split("\n").filter((l) => l.trim());
  check("text 模式输出多行而非单行", lines.length >= 5, `行数=${lines.length}`);
  check("text 模式无 Markdown 标记", !out.includes("```") && !/^\|/m.test(out));
  check("text 模式仍含正文", out.includes("虚拟支付接入指南") && out.includes("密钥不匹配"));
}

console.log("\n═══ 7. 非 HTML / 纯文本响应直通 ═══");
{
  const out = await fetchUrl("https://example.com/a.md", 8000, {
    fetchImpl: fakeFetch({ body: "# 已经是 Markdown\n\n直接返回即可。", contentType: "text/markdown" }),
  });
  check("纯文本直通不套 HTML 管线", out.includes("已经是 Markdown") && out.includes("直接返回即可"));

  const bin = await fetchUrl("https://example.com/a.pdf", 8000, {
    fetchImpl: fakeFetch({ body: Buffer.from([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" }),
  });
  check("二进制内容明确告知", bin.includes("Binary content"), `实际: ${bin.slice(0, 80)}`);
}

console.log("\n═══ 8. 截断与错误路径 ═══");
{
  const long = `<!DOCTYPE html><html><head><title>长文</title></head><body><article><p>${"很长的一段正文。".repeat(500)}</p></article></body></html>`;
  const out = await fetchUrl("https://example.com/long", 500, { fetchImpl: fakeFetch({ body: long }) });
  check("超长内容被截断并标注", out.includes("[...truncated at 500 characters]"), `实际长度 ${out.length}`);

  const notFound = await fetchUrl("https://example.com/404", 8000, {
    fetchImpl: fakeFetch({ body: "nope", status: 404, statusText: "Not Found" }),
  }).catch((e) => `THREW: ${e.message}`);
  check("HTTP 错误抛出可读异常", String(notFound).includes("404"));

  const badUrl = await fetchUrl("ftp://example.com/x", 8000, { fetchImpl: fakeFetch({ body: "" }) })
    .catch((e) => `THREW: ${e.message}`);
  check("非 http(s) 协议被拒", String(badUrl).includes("Invalid URL"));
}

console.log("\n" + "═".repeat(60));
console.log(`抽取管线测试：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log(`失败项：\n  - ${failures.join("\n  - ")}`); process.exit(1); }
