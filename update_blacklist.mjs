#!/usr/bin/env node
/**
 * update_blacklist.mjs — 黑名单维护脚本（方案 2.1）
 *
 * 走代理下载 StevenBlack/hosts + hagezi/dns-blocklists（fake / spam-tlds / urlshortener），
 * 压缩去重后写 blacklist.json：{ "remove": [...], "lower": [...] }。
 *
 * remove[] = 垃圾 TLD 后缀 + 短链域 + 假货/骗局商店域 + 广告追踪域（封顶控制文件大小）
 * lower[]  = 硬编码策划名单（百度百家号/CSDN/知乎等，整域删除会误伤，只降权）
 *
 * 【健壮】任意下载失败 → 该源跳过，仍用内建垃圾 TLD + 策划 lower 名单写文件，离线可用。
 *
 * 运行：HTTP_PROXY=http://127.0.0.1:<port> node update_blacklist.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDispatcher, ProxyAgent } from "undici";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(moduleDir, "blacklist.json");

const PROXY = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
if (PROXY) {
  try { setGlobalDispatcher(new ProxyAgent(PROXY)); }
  catch (e) { console.error(`[update] proxy setup failed: ${e.message}`); }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── 数据源（raw.githubusercontent 国内被墙，必须走代理） ──
const SOURCES = [
  { name: "stevenblack", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", kind: "hosts" },
  { name: "hagezi-fake", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/fake.txt", kind: "abp", limit: 1500 },
  { name: "hagezi-urlshortener", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/urlshortener.txt", kind: "abp", limit: 1500 },
  { name: "hagezi-spam-tlds", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/spam-tlds.txt", kind: "abp-tlds" },
];
const STEVENBLACK_LIMIT = 1000;

// 恶名垃圾 TLD（即便 hagezi 有 denyallow 例外，仍整体封禁；方案 2.1 内置兜底同名单）
const NOTORIOUS_TLDS = new Set([
  "top", "xyz", "icu", "info", "zip", "mov", "click", "link", "sbs",
  "work", "site", "online", "shop", "club", "live", "fun", "store",
  "buzz", "loan", "gdn", "vip", "review", "racing", "stream", "download",
  "win", "bid", "party", "trade", "date", "faith", "webcam", "email",
  "rest", "cam", "men", "mom", "cricket", "quest", "realtor", "sport",
]);

// 硬编码短链兜底（下载失败也有）
const BUILTIN_SHORTENERS = [
  "bit.ly", "tinyurl.com", "goo.gl", "t.co", "shorturl.at", "cutt.ly",
  "is.gd", "buff.ly", "ow.ly", "tiny.cc", "rebrand.ly", "s.id", "tny.im",
  "rb.gy", "0rz.tw", "lnkd.in",
];

// lower[] 策划名单（方案 2.1：百度百家号/CSDN/知乎等）
const LOWER_CURATED = [
  "baijiahao.baidu.com", "blog.csdn.net", "zhihu.com",
  "mp.weixin.qq.com", "toutiao.com",
];

function isIp(d) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(d) || d.includes(":");
}

async function download(name, url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/plain,*/*" },
    signal: AbortSignal.timeout(60000),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

async function main() {
  const removeSet = new Set();
  const meta = { downloaded: [], skipped: [] };

  for (const src of SOURCES) {
    try {
      const text = await download(src.name, src.url);
      meta.downloaded.push(src.name);
      let added = 0;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("!") || line.startsWith("#") || line.startsWith("[")) continue;
        if (src.kind === "hosts") {
          const m = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([^\s#]+)/);
          if (!m) continue;
          const d = m[1].toLowerCase();
          if (!d.includes(".") || isIp(d)) continue;
          if (/^(localhost|local|localdomain|broadcasthost|ip6|0\.0\.0\.0)$/.test(d)) continue;
          if (added >= STEVENBLACK_LIMIT) break;
          removeSet.add(d); added++;
        } else if (src.kind === "abp-tlds") {
          const m = line.match(/^\|\|(\*)?(\.)?([a-z0-9-]{2,})\^/);
          if (!m) continue;
          const label = m[3].toLowerCase();
          // 带 denyallow 的 TLD 存在合法站点 → 仅保留 NOTORIOUS_TLDS 中的恶名 TLD
          if (line.includes("denyallow") && !NOTORIOUS_TLDS.has(label)) continue;
          removeSet.add("." + label); added++;
        } else {
          const m = line.match(/^\|\|([a-z0-9_.-]+)\^/);
          if (!m) continue;
          const d = m[1].toLowerCase();
          if (d.startsWith("*.")) continue;
          if (!d.includes(".") || isIp(d)) continue;
          if (added >= (src.limit || Infinity)) break;
          removeSet.add(d); added++;
        }
      }
      console.error(`[update] ${src.name}: +${added} entries`);
    } catch (e) {
      meta.skipped.push(`${src.name} (${e.message})`);
      console.error(`[update] ${src.name} FAILED: ${e.message}`);
    }
  }

  // 内建兜底：恶名垃圾 TLD + 短链（离线也必须写）
  for (const t of NOTORIOUS_TLDS) removeSet.add("." + t);
  for (const s of BUILTIN_SHORTENERS) removeSet.add(s);

  const out = {
    remove: [...removeSet].sort(),
    lower: [...LOWER_CURATED].sort(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
  const bytes = fs.statSync(OUT).size;

  const summary = {
    file: OUT,
    sizeBytes: bytes,
    remove: out.remove.length,
    lower: out.lower.length,
    downloaded: meta.downloaded,
    skipped: meta.skipped,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`[update] fatal: ${e.message}`);
  process.exit(1);
});
