/**
 * 正文抽取质量离线对比（不需要联网）。
 *
 * 目的：在固定 HTML 夹具上对比三种抽取策略，确认「清洗」这一步到底有没有
 * 把广告/导航/页脚/脚本去掉，以及是否保留了标题层级、链接、代码块、表格。
 * 这样改动抽取逻辑时不必联网、不受反爬抖动影响（与 run-eval.mjs 的 replay 思路一致）。
 *
 * 用法：node eval/extract-quality.mjs
 *       node eval/extract-quality.mjs --dump     # 额外打印完整 Markdown 便于人眼核查
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import { makeTurndown, extractMainContent } from "../extract-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "extract-basic.html");
const DUMP = process.argv.includes("--dump");

const html = fs.readFileSync(FIXTURE, "utf8");

// ── 必须出现的正文事实（抽不出来就是漏） ──
const MUST_KEEP = [
  "虚拟支付接入指南", "个人主体小程序", "已完成微信认证",
  "wx.requestPayment", "签名失败", "密钥不匹配", "小程序开发文档",
];

// ── 绝不能出现的噪音（抽出来就是没洗干净） ──
const MUST_DROP = [
  "限时优惠", "优惠券", "首页", "关于", "热门文章一", "热门文章二",
  "相关推荐", "版权所有", "隐私政策", "扫码加入交流群", "window.__noise", "这段 script 内容",
];

/** 策略 A：旧实现（cheerio 直接取 text，与删除前的 server-cn.mjs fetchUrl 一致） */
function strategyLegacyText() {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, iframe, svg, form, button, input, select, textarea, [role='navigation'], [role='banner'], [role='contentinfo']").remove();
  const title = $("title").first().text().trim();
  const body = $("body");
  let content = body.find("main, article, [role='main'], .post-content, .article-content, #content, .content").first().text() || body.text();
  content = content.replace(/\s+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return `# ${title}\n\n${content}`;
}

/** 策略 B：Readability 抽正文 → 纯文本（不转 Markdown） */
function strategyReadabilityText() {
  const { document } = parseHTML(html);
  const art = new Readability(document).parse();
  if (!art) return "(Readability 未抽出正文)";
  return `# ${art.title}\n\n${art.textContent.replace(/\s+/g, " ").trim()}`;
}

/** 策略 C：新实现（站内选择器 → Readability → turndown 出 Markdown） */
function strategyNewPipeline() {
  const { title, html: contentHtml, plain, via } = extractMainContent(html, "https://example.com/doc");
  const md = makeTurndown().turndown(contentHtml);
  return `# ${title}\n\n${md}\n<!-- via=${via} plainLen=${plain.length} -->`;
}

const strategies = {
  "A 旧实现(cheerio text)": strategyLegacyText,
  "B Readability→text": strategyReadabilityText,
  "C 新实现(→Markdown)": strategyNewPipeline,
};

let allPass = true;

for (const [name, fn] of Object.entries(strategies)) {
  let out;
  try {
    out = fn();
  } catch (e) {
    console.log(`\n─── ${name} ───\n  执行失败: ${e.message}`);
    allPass = false;
    continue;
  }

  const kept = MUST_KEEP.filter((s) => out.includes(s));
  const leaked = MUST_DROP.filter((s) => out.includes(s));
  const missKeep = MUST_KEEP.filter((s) => !out.includes(s));
  const ok = missKeep.length === 0 && leaked.length === 0;
  if (!ok) allPass = false;

  console.log(`\n─── 策略 ${name} ───`);
  console.log(`  保留正文 ${kept.length}/${MUST_KEEP.length}｜噪音泄漏 ${leaked.length}/${MUST_DROP.length}｜字数 ${out.length}`);
  if (missKeep.length) console.log(`  ✗ 漏掉正文: ${missKeep.join(", ")}`);
  if (leaked.length) console.log(`  ✗ 混入噪音: ${leaked.join(", ")}`);
  if (ok) console.log("  ✓ 全部通过");

  console.log(`  Markdown 结构标记: 标题 ${(out.match(/^#{1,6} /gm) || []).length}｜列表 ${(out.match(/^[-*] /gm) || []).length}｜代码块 ${(out.match(/```/g) || []).length / 2}｜链接 ${(out.match(/\]\(http/g) || []).length}｜表格行 ${(out.match(/^\|/gm) || []).length}`);
  if (DUMP) console.log(`\n${out}\n${"─".repeat(60)}`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(allPass ? "结论：至少一种策略完全通过（见上方逐条）" : "结论：存在未通过项，需检查抽取规则");
process.exit(0);
