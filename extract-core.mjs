/**
 * 网页正文抽取管线（server-cn.mjs 与 ws.js 共用，消除两份逐字重复的实现）
 *
 * 设计目标（按优先级）：
 *   1. 留住正文 —— 旧实现取 `main, article, ...` 里的**第一个**元素（`.first()`），
 *      选错块就整篇丢正文：实测 MDN Fetch API 页只抽到 2772 字，Readability 抽到 20170 字（7.28×）。
 *   2. 留住结构 —— 旧实现把 `.text()` 拍平再把 `\n` 全压成空格，标题/列表/代码块/表格
 *      在 sanitizeText 里就被销毁，喂给 LLM 全是糊成一坨的文本。改为输出 Markdown。
 *   3. 去掉噪音 —— 广告位/导航/页脚/推荐位/评论区。
 *
 * 为什么不直接用 trafilatura（Python 版，抽取质量也很好）：
 *   每次抽取要起 Python 子进程，实测 955–2028ms/页（含解释器启动），
 *   而 linkedom+Readability 约 280ms；且它对微信公众号这类中文站同样失效。
 *   本模块用已装好的现成积木（linkedom + @mozilla/readability + turndown），零新增运行时。
 *
 * 决策记录：仓库 CHANGELOG-2026-09.md:99 曾记录「Readability 收益接近零 → 不做」。
 *   该结论是**测错了**——当时四类页面恰好全是生产实现已命中对的站（k8s/dev.to 等），
 *   且只用「正文字数」单指标，无法区分「抽到更多正文」与「抽到整页噪音」
 *   （阮一峰博客：生产实现字数最多 30950，却含评论区+上下篇；Readability 2960 但干净）。
 *   本模块的离线夹具测试（eval/extract.test.mjs）用「正文保留 + 噪音不泄漏 + 结构标记」
 *   三组断言替代单指标，避免重蹈覆辙。
 *
 * 依赖版本注意（2026-09-20 核实）：
 *   Node 的 `gbk` TextDecoder 曾长期损坏（nodejs/node#61041，confirmed-bug），
 *   修复于 PR #61099（2025-12-28 合入 main，2026-01 回移植 v22/v24）。
 *   故本模块**不依赖 Node 内置解码器**，统一走 `iconv-lite`（已在依赖树中），
 *   以免部署到 Node 22 早期或 24.12.x 及更早版本时中文整篇乱码。
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** 抓取前就删掉的噪音容器（与正文无关的纯装饰/交互件）。 */
const PRE_STRIP =
  "script, style, noscript, iframe, svg, canvas, form, button, input, select, textarea, " +
  "[role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']";

/**
 * 站内正文选择器表。
 * Readability 对**中文 CMS 模板**经常失效（实测微信公众号正文只抽出 45 字），
 * 这类站必须靠选择器直取。命中即优先于 Readability。
 * 选择器顺序 = 优先级；首个能抽出足够正文的胜出。
 */
const SITE_SELECTORS = [
  // 微信公众号：实测 #js_content 得 2774 字纯正文；#js_article 得 3645 字但含
  // "在小说阅读器读本章/去阅读"等噪音，故必须选 #js_content。
  { test: /mp\.weixin\.qq\.com/, selectors: ["#js_content"] },
  { test: /zhuanlan\.zhihu\.com|zhihu\.com\/question/, selectors: [".RichText", ".Post-RichText", ".QuestionAnswer-content"] },
  { test: /blog\.csdn\.net/, selectors: ["#content_views", ".blog-content-box"] },
  { test: /juejin\.cn/, selectors: ["#article-root", ".article-content", ".markdown-body"] },
  { test: /cnblogs\.com/, selectors: ["#cnblogs_post_body", ".postBody"] },
  { test: /segmentfault\.com/, selectors: [".article-content", ".fmt"] },
  { test: /developers\.weixin\.qq\.com/, selectors: [".markdown-body", ".content", "#js_content"] },
  { test: /docs\.python\.org|developer\.mozilla\.org|docs\.docker\.com|kubernetes\.io/, selectors: ["main", "article", "[role='main']"] },
];

/** 从 HTML 里探测字符集（中文站大量使用 GBK/GB2312，按 UTF-8 解会整篇乱码）。 */
export function detectCharset(html, contentType = "") {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1].toLowerCase();
  // 只看前 4KB，meta charset 必在 head 内
  const head = html.slice(0, 4096);
  const meta1 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (meta1) return meta1[1].toLowerCase();
  const meta2 = /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (meta2) return meta2[1].toLowerCase();
  return "utf-8";
}

/** 把响应体按探测到的字符集解码为字符串。传入 Uint8Array/Buffer。 */
export function decodeBody(bytes, contentType = "") {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // 先按 latin1 粗略看一眼 head 以探测 charset（head 是 ASCII 兼容的）
  const probe = buf.slice(0, 4096).toString("latin1");
  const charset = detectCharset(probe, contentType);
  if (/^(utf-?8)$/i.test(charset)) return buf.toString("utf8");
  // 刻意不用 Node 内置 TextDecoder('gbk')——见文件头「依赖版本注意」
  if (iconv.encodingExists(charset)) {
    const decoded = iconv.decode(buf, charset);
    // 解码结果里出现大量替换符，说明猜错了，退回 utf8
    const bad = (decoded.match(/\uFFFD/g) || []).length;
    if (bad > decoded.length * 0.01) return buf.toString("utf8");
    return decoded;
  }
  return buf.toString("utf8");
}

export function makeTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  td.use(gfm);
  td.remove(["script", "style", "noscript"]);
  // 放宽转义（实测对比后决定）：turndown 默认把 `_ * [ ] ( ) # + - . ! | > ~ \`` 全部反斜杠转义，
  // 于是 `#js_content` 变成 `#js\_content`、`wx_requestPayment` 变成 `wx\_requestPayment`。
  // 这类逃逸对**喂给 LLM**是纯噪音（正文里下划线/井号字面量极常见）。
  // 实测放宽后：强调 `**x**`、下划线强调 `_x_`、代码块、GFM 表格、`*args`、反引号、已有反斜杠
  // 的输出**逐字节不变**；只有"标识符里的下划线"和"字面量方括号/圆括号"不再逃逸。
  // 唯一代价：正文里天然写成 `[文字](网址)` 的字面文本可能被 Markdown 渲染器当成链接——
  // 这是可接受的取舍（且 LLM 不需要渲染，更需要低噪音）。
  td.escape = (s) => s.replace(/([\\*`[\]])/g, "\\$1");
  // 空链接（纯图标/占位 <a>）没有信息量，去掉以免污染上下文
  td.addRule("dropEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent.trim(),
    replacement: () => "",
  });
  // 图片：只保留有 alt 的，避免一堆无意义 CDN 链接塞满上下文
  td.addRule("dropImagesWithoutAlt", {
    filter: (node) => node.nodeName === "IMG" && !node.getAttribute("alt"),
    replacement: () => "",
  });
  return td;
}

/**
 * 纯文本化（合并行内空白、保留段落换行）。
 * ⚠️ 不要对 Markdown 结果调用它——会把标题/列表/代码块的换行全部压掉。
 * 旧实现是 `text.replace(/\s+/g, " ")`，把一切换行碾成空格（连段落都糊成一行）；
 * 这里只压行内空白与 3+ 连续空行，段落结构保留。
 */
export function sanitizeText(text) {
  return text
    .replace(/[ \t\u00a0\u3000]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 块级标签之间补换行，避免 `…operations.Learn more` 这种段落粘连。 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);

function htmlToPlainText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  $("br").replaceWith("\n");
  // 自底向上：先给块级元素的内容两侧补换行，再整体取 text
  const blocks = $("body *").toArray().reverse();
  for (const el of blocks) {
    const tag = (el.tagName || "").toLowerCase();
    if (!BLOCK_TAGS.has(tag)) continue;
    const $el = $(el);
    $el.replaceWith(`\n${$el.text()}\n`);
  }
  return sanitizeText($.root().text());
}

/**
 * 给 DOM 注入 <base href>。
 * linkedom 的 `document.baseURI` 恒为 null → Readability 内部 `new URL(href, baseURI)` 抛错
 * 被它自己的 try/catch 吞掉 → parse() **正常返回但链接退化为相对路径**（静默失败）。
 * baseURI 是只读 getter，不能赋值，只能插标签来修（@extractus/article-extractor 同样做法）。
 */
function withBaseHref(html, url) {
  if (!url) return html;
  const tag = `<base href="${url.replace(/"/g, "&quot;")}">`;
  if (/<base[\s>]/i.test(html)) return html;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  return `<head>${tag}</head>${html}`;
}

/** 站内选择器直取。命中且正文够长才返回，否则 null 让 Readability 接手。 */
function extractBySiteSelector($, url) {
  const rule = SITE_SELECTORS.find((r) => r.test.test(url));
  if (!rule) return null;
  for (const sel of rule.selectors) {
    const node = $(sel).first();
    if (!node.length) continue;
    const text = node.text().trim();
    if (text.length >= 200) return node.html() || "";
  }
  return null;
}

/**
 * 把容器内的相对链接/图片地址改写为绝对地址，返回该容器的 HTML。
 * 为什么需要：Readability 路径靠 `<base href>` 修 baseURI（见 withBaseHref），
 * 但**兜底路径用 cheerio，它不做任何 URL 解析**——不补这一步，兜底结果里的
 * `/docs/x`、`../img/a.png` 会被原样交给下游，变成无法访问的地址。
 */
function resolveRelativeLinks($, url) {
  if (!url) return $.root().html() || "";
  let base;
  try {
    base = new URL(url);
  } catch {
    return $.root().html() || "";
  }
  $.root().find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || /^(https?:|mailto:|tel:|javascript:|#|data:)/i.test(href)) return;
    try { $(el).attr("href", new URL(href, base).href); } catch { /* 保留原值 */ }
  });
  $.root().find("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!src || /^(https?:|data:)/i.test(src)) return;
    try { $(el).attr("src", new URL(src, base).href); } catch { /* 保留原值 */ }
  });
  return $.root().html() || "";
}

/**
 * 抽正文，返回 { title, html, plain, via }。
 * via 记录实际生效的策略，便于诊断（"为什么这篇只抽到 50 字"）。
 * plain 与 html 一次抽取同时产出——调用方按需取用，避免重复跑抽取（大页面上代价明显）。
 */
export function extractMainContent(rawHtml, url = "") {
  // 用 cheerio 做前置剔除 + 站内选择器（它的选择器引擎比 linkedom 稳）
  const $ = cheerio.load(rawHtml);
  $("script, style, noscript").remove();
  const docTitle = $("title").first().text().trim();

  const siteHtml = extractBySiteSelector($, url);
  if (siteHtml) {
    return {
      title: docTitle || new URL(url).hostname,
      html: siteHtml,
      plain: htmlToPlainText(siteHtml),
      via: "site-selector",
    };
  }

  // Readability 路径：先剔除装饰件，再交给它判正文
  const cleaned = cheerio.load(rawHtml);
  cleaned(PRE_STRIP).remove();
  let readHtml = null;
  let readTitle = "";
  try {
    const { document } = parseHTML(withBaseHref(cleaned.html(), url));
    const art = new Readability(document).parse();
    // 阈值刻意放低（80 字）：Readability 能返回结果就说明它已成功定位正文区，
    // 门槛设高反而会把它判对的**短页**（实测一个正文仅 110 字的页面）踢到兜底分支，
    // 而兜底分支的内容拼装与链接解析都更差。这里只用来挡"返回了但几乎没内容"。
    if (art && art.content && art.textContent && art.textContent.trim().length >= 80) {
      readHtml = art.content;
      readTitle = (art.title || "").trim();
    }
  } catch {
    // Readability 抛错不该让整次抓取失败，走兜底
  }
  if (readHtml) {
    return {
      title: readTitle || docTitle || new URL(url).hostname,
      html: readHtml,
      plain: htmlToPlainText(readHtml),
      via: "readability",
    };
  }

  // 兜底：候选块里挑**文字最多**的那个（旧实现是 .first()，选错就整篇丢正文）
  const $2 = cheerio.load(rawHtml);
  $2(PRE_STRIP).remove();
  let best = { len: 0, html: "" };
  $2("main, article, [role='main'], .post-content, .article-content, .markdown-body, #content, .content").each((_, el) => {
    const len = $2(el).text().trim().length;
    if (len > best.len) best = { len, html: $2(el).html() || "" };
  });
  // 兜底分支也必须做 baseURI 修复：cheerio 不做 URL 解析，
  // 若不在这里补，走兜底路径时页面上的相对链接会原样保留（下游拿到 /docs/x 这种无法访问的地址）。
  if (best.len > 0) {
    const fixed = resolveRelativeLinks($2, url);
    return {
      title: docTitle || new URL(url).hostname,
      html: fixed,
      plain: htmlToPlainText(fixed),
      via: "fallback-largest",
    };
  }
  const fixedBody = resolveRelativeLinks($2, url);
  return {
    title: docTitle || new URL(url).hostname,
    html: fixedBody,
    plain: htmlToPlainText(fixedBody),
    via: "body",
  };
}

/**
 * 去掉 ATX 井号、尾部闭合井号，并把 `[文字](链接)` 压成 `文字`。
 *
 * ⚠️ 链接文字若**本身就是 `#`**（站点常见的 `<a class="header-anchor">#</a>` 锚点图标，
 * 微信/语雀/VitePress 等都用），必须**整个丢掉**而不是保留文字——否则剥完得到
 * `# 小程序开发指南`，那个井号会被当成 ATX 标题前缀，导致与页面标题比较失败（实测踩到）。
 */
function unmarkHeading(line) {
  return String(line)
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => {
      const text = m.slice(1, m.indexOf("]")).trim();
      return /^#*$/.test(text) ? " " : text;
    })
    .replace(/^#+\s*/, "")
    .replace(/\s*#+\s*$/, "");
}

/**
 * 规范化标题，用于"正文 H1 是否与页面标题重复"的比较。
 *
 * 为什么不直接比字符串（实测微信开放文档踩到）：页面 `<title>` 通常带**站点后缀**
 *   `<title>小程序开发指南 | 微信开放文档</title>`
 * 而正文 H1 只有核心标题
 *   `<h1><a href="#小程序开发指南">#</a> 小程序开发指南</h1>`
 * 两者永远不相等 → 逐字比较必然漏判 → 同一个大标题出现两次（白占上下文，实测每次约 20 字符）。
 * 故这里剥掉常见的站点分隔后缀（`|` `-` `–` `—` `·` `_` `｜`），只留最长的一段作为核心标题。
 */
function normalizeHeading(line) {
  return unmarkHeading(line)
    .split(/\s*[|｜\-–—·_]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]
    ?.replace(/\s+/g, " ")
    .toLowerCase() || "";
}

/**
 * 抓取 URL 并返回干净内容。
 * @param {string} targetUrl
 * @param {number} maxLength 截断长度
 * @param {{markdown?: boolean, fetchImpl?: typeof fetch, timeoutMs?: number, userAgent?: string}} opts
 *        markdown=true（默认）输出 Markdown；false 输出保留段落的纯文本。
 *        fetchImpl 供离线测试注入（见 eval/extract.test.mjs）。
 */
export async function fetchUrl(targetUrl, maxLength = 8000, opts = {}) {
  const { markdown = true, fetchImpl = fetch, timeoutMs = 20000, userAgent = DEFAULT_UA } = opts;

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  const response = await fetchImpl(targetUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text") && !contentType.includes("html")) {
    return `[${contentType}] Binary content — cannot display as text.`;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const rawHtml = decodeBody(bytes, contentType);

  // 纯文本响应（text/plain、text/markdown）直接返回，不必走 HTML 管线
  if (!contentType.includes("html") && !/^\s*</.test(rawHtml)) {
    let text = rawHtml.trim();
    if (text.length > maxLength) text = text.slice(0, maxLength) + `\n\n[...truncated at ${maxLength} characters]`;
    return `# ${parsed.hostname}\n\nURL: ${targetUrl}\n\n${text}`;
  }

  // 一次抽取同时拿到 html 与 plain（避免为 text 模式重跑一遍抽取——大页面上是双倍开销）
  const { title, html, plain, via } = extractMainContent(rawHtml, targetUrl);
  let content = markdown
    ? makeTurndown().turndown(html).replace(/\n{3,}/g, "\n\n").trim()
    : plain;

  if (!content) {
    // 抽空说明抽取器选错了块——把 via 暴露出来便于诊断，而不是静默返回空
    return `# ${title}\n\nURL: ${targetUrl}\n\n(正文抽取为空，抽取策略=${via}；该页可能依赖 JS 渲染，或正文容器不在已知选择器内)`;
  }

  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + `\n\n[...truncated at ${maxLength} characters]`;
  }

  // Readability / 站内选择器给出的正文通常已含页面 H1（实测 example.com 会输出两次
  // "# Example Domain"；微信文档会输出 "# [#](#锚点) 小程序开发指南"），若开头就是与标题
  // 同义的 ATX H1 就去掉，避免重复占上下文。
  //
  // 两种情况都要处理：
  //   ① 标题完全相同，只是多了一层"点击跳锚点"的链接包裹（`[#](#xxx) 标题文字`）；
  //   ② 正文 H1 是核心标题，而 `<title>` 带站点后缀（`核心标题 | 站点名`）——见 normalizeHeading。
  // 剥掉锚点再比较还有额外好处：那个裸 `#` 链接本身对 LLM 零信息量，留着只是噪音。
  const firstLine = content.split("\n", 1)[0].trim();
  if (/^#\s/.test(firstLine)) {
    const nFirst = normalizeHeading(firstLine);
    const nTitle = normalizeHeading(title);
    if (nFirst && nTitle && (nFirst === nTitle || nTitle.startsWith(nFirst))) {
      // ⚠️ 不能用 firstLine.length 切片：第一行可能是 `[#](#锚点) 这是很长的标题` 这类
      // 带 Markdown 链接语法的形式，此时"标记长度 ≠ 明文长度"。按 **\n** 整行切才正确。
      content = content.slice(content.indexOf("\n") + 1).replace(/^\n+/, "");
    }
  }

  return `# ${title}\n\nURL: ${targetUrl}\n\n${content}`;
}
