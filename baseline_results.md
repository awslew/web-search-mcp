# 检索工具改动前行为基线（BASELINE）

> 记录时间：2026-08-02
> 目的：在 ws.js 优化改动【之前】记录 8 条查询的原始输出 + 质量判定，作为改动后验收的对照基准。
> 工具：当前未改动的 `node ws.js`（Web Search CLI Tool v2），依赖 cheerio + undici。
> 环境备注：本轮实测期间，百度在连续多次查询后触发"安全验证"反爬（静默失败，无 CLI 报错），查询 #8 与格式样本查询均被静默降级到 cn.bing。`[proxy] using ...` 行走 stderr（console.error），不污染 stdout。

---

## 一、8 条查询原始输出（逐字节抄录）

### Q1. node ws.js search "node.js cheerio 教程"（中文技术，无代理）

```
Search results for "node.js cheerio 教程":

1. [baidu] 欢迎使用 Cheerio! | Cheerio中文文档 | Cheerio中文网
   https://www.cheeriojs.cn/docs/intro

2. [baidu] Node.js HTML解析与操作终极指南:Cheerio的完整应用教程-CSDN博客
   https://blog.csdn.net/gitblog_00163/article/details/155300594

3. [baidu] 用node.js从零开始去写一个简单的爬虫-腾讯云开发者社区-腾讯云
   https://cloud.tencent.com/developer/article/2521371

```

### Q2. node ws.js search "python 异步编程 asyncio"（中文技术，无代理）

```
Search results for "python 异步编程 asyncio":

1. [baidu] asyncio --- 异步 I/O — Python 3.13.14 文档
   https://docs.python.org/zh-cn/3.13/library/asyncio.html

2. [baidu] python 异步编程 asyncio - 精选笔记
   null

3. [baidu] python 异步编程 asyncio - 视频大全 - 高清在线观看
   http://3108.lightapp.baidu.com/python+%D2%EC%B2%BD%B1%E0%B3%CC+asyncio
    29:27 快速搞定---异步 asyncio异步编程(asyncio 学... 哔哩哔哩 2025-9-5  08:25 Python异步编程 asyncio小白速通! 哔哩哔哩 2024-12-25

```

### Q3. node ws.js search "docker 入门教程"（中文技术，无代理）

```
Search results for "docker 入门教程":

1. [baidu] docker 入门教程 - 精选笔记
   null

2. [baidu] Docker快速入门上手教程(保姆式),含docker所有常用命令大全(详细)!_dock...
   https://blog.csdn.net/shandongjiushen/article/details/162030764

3. [baidu] docker 入门教程 - 视频大全 - 高清在线观看
   http://3108.lightapp.baidu.com/docker+%C8%EB%C3%C5%BD%CC%B3%CC
    07:27 Docker 快速上手教程,无废话纯干货 哔哩哔哩 2024-9-25  38:28 别再忽略Docker了!2025 AI时代必会技能!40分... 哔哩哔哩 2025-7-24

```

### Q4. HTTP_PROXY=http://127.0.0.1:<proxy-port> node ws.js search "nodejs http server best practices"（英文技术，走代理）

```
[proxy] using http://127.0.0.1:<proxy-port>
Search results for "nodejs http server best practices":

1. [baidu] Node js Best Practices and Security - TatvaSoft Blog
   https://www.tatvasoft.com/blog/node-js-best-practices/

2. [baidu] 怎样用Node.js搭建web服务器-腾讯云开发者社区-腾讯云
   https://cloud.tencent.com/developer/article/2427805

3. [baidu] NodeJS Best Practices
   https://www.javaguides.net/2025/02/nodejs-best-practices.html

```

### Q5. HTTP_PROXY=http://127.0.0.1:<proxy-port> node ws.js search "mcp server protocol guide"（英文技术，走代理）

```
[proxy] using http://127.0.0.1:<proxy-port>
Search results for "mcp server protocol guide":

1. [baidu] view.inews.qq.com/a/20250414A023WV00
   https://view.inews.qq.com/a/20250414A023WV00

2. [baidu] 全网最全面的 MCP 解读来了!_集成_Agent_模型
   https://m.sohu.com/a/889567574_121124377/?pvid=000115_3w_a

3. [baidu] 从原理到实践:一文讲透MCP|调用|代码|数据源|json|python|spiderlin...
   https://www.163.com/dy/article/JT9G03J50511DDOK.html

4. [baidu] new.qq.com/rain/a/20250414A023WV00
   https://new.qq.com/rain/a/20250414A023WV00

5. [baidu] 手搓Manus?MCP 原理解析与MCP Client实践
   https://weibo.com/ttarticle/p/show?id=2309405156451109699600

```

### Q6. HTTP_PROXY=http://127.0.0.1:<proxy-port> node ws.js search "python async programming"（英文技术，走代理）

```
[proxy] using http://127.0.0.1:<proxy-port>
Search results for "python async programming":

1. [baidu] 使用asyncio 開發 — Python 3.14.6 說明文件
   https://docs.python.org/zh-tw/3/library/asyncio-dev.html

2. [baidu] Python async 通过协程(coroutine)机制实现高效的并发操作-CSDN博客
   https://flyfish.blog.csdn.net/article/details/149134887

3. [baidu] 用Python asyncio 模块实现高效异步编程 - 腾讯云开发者社区-腾讯云
   https://cloud.tencent.com/developer/news/1719868

```

### Q7. node ws.js search "飞书 多维表格 API 权限"（冷门，无代理）

```
Search results for "飞书 多维表格 API 权限":

1. [baidu] ...API(创建一个多维表格) - 开发教程 - 开发文档 - 飞书开放平台
   https://open.feishu.cn/document/introduction-2

2. [baidu] 飞书 多维表格 API 权限 - 百度图片
   http://image.baidu.com/search/index?tn=baiduimage&ct=201326592&lm=-1&cl=2&ie=gb18030&word=%E9%A3%9E%E4%B9%A6+%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC+api+%E6%9D%83%E9%99%90

3. [baidu] 飞书 多维表格 API 权限 - 精选笔记
   null

```

### Q8. node ws.js search "开源协议 AGPL 商用合规"（冷门，无代理）

```
Search results for "开源协议 AGPL 商用合规":

1. [bing] GitHub - GitHubDaily/GitHubDaily: 坚持分享 GitHub 上高质量、有 …
   https://github.com/GitHubDaily/GitHubDaily
   坚持分享 GitHub 上高质量、有趣实用的开源技术教程、开发者工具、编程网站、技术资讯。A list cool, interesting projects of GitHub ...

2. [bing] 开源中国 - 开源中国 - Gitee
   https://gitee.com/oschina
   自 2013 年上线以来，Gitee 共服务了 1200 万开发者用户，累计托管仓库超过 2800 万个，是国内首屈一指的开源软件技术交流平台； …

3. [bing] 什么是开源？ - 知乎
   https://zhuanlan.zhihu.com/p/27501070
   2017年6月23日 · 在这里，我们诉说开源价值对生活所有领域的影响的故事—— 科学 、 教育 、 政府 、 工业 、健康、法律，以及 组 …

4. [bing] OSCHINA - 中文开源技术交流社区
   https://www.oschina.net/
   2026年2月5日 · 开源直播与录制工具 OBS Studio 32.2.0 发布 腾讯发布首个自研创意智能体 Miora 宇树科技发布 UnifoLM-OminiA-0.3 …

5. [bing] 立创开源广场 - 立创开源硬件平台
   https://oshwhub.com/explore
   简介：黄山派是专注于低功耗多媒体显示的蓝牙开发板，软硬件全部开源，体积小巧功能强大，板载九轴、充放电、音频众多外设，满 …

```

---

## 二、逐条结果质量判定表

判定口径：
- **相关**：仅凭 title+url+snippet 即可确认与查询相关。
- **需fetch**：title/snippet 含糊（或 URL 为 null / 聚合落地页），必须打开页面才能判断相关性。
- **垃圾站/营销霸屏**：百度"精选笔记""视频大全""百度图片"聚合模块、营销/导流页等明显非目标内容。

| # | 查询 | 代理 | 引擎来源 | 条数 | 相关 | 需fetch | null/非http URL | 垃圾站/营销霸屏 | 验证墙报错 |
|---|------|------|----------|------|------|---------|------------------|------------------|-----------|
| Q1 | node.js cheerio 教程 | 无 | [baidu] | 3 | 3 | 0 | 无 | 无 | 无 |
| Q2 | python 异步编程 asyncio | 无 | [baidu] | 3 | 1 | 2 | 有（1条 `null`） | 有（精选笔记#2 + 视频大全#3） | 无 |
| Q3 | docker 入门教程 | 无 | [baidu] | 3 | 1 | 2 | 有（1条 `null`） | 有（精选笔记#1 + 视频大全#3） | 无 |
| Q4 | nodejs http server best practices | 有 | [baidu]（DDG死→静默回落） | 3 | 2 | 1 | 无 | 无 | 无（但英文查询返中文=语义错位） |
| Q5 | mcp server protocol guide | 有 | [baidu]（DDG死→静默回落） | 5 | 3 | 2 | 无 | 部分（#1/#4为同一腾讯新闻文两域名；#1/#4 title=URL） | 无 |
| Q6 | python async programming | 有 | [baidu]（DDG死→静默回落） | 3 | 3 | 0 | 无 | 无 | 无（英文查询返中文=语义错位） |
| Q7 | 飞书 多维表格 API 权限 | 无 | [baidu] | 3 | 1 | 2 | 有（1条 `null`） | 有（百度图片#2 + 精选笔记#3） | 无 |
| Q8 | 开源协议 AGPL 商用合规 | 无 | [bing]（百度验证墙→回落cn.bing） | 5 | 0 | 5 | 无 | 无（均为正经站但全部离题） | 有（静默触发，CLI 无报错，仅引擎标签变 [bing]） |

### 判定补充说明

- **Q2/Q3/Q7 的 `null` URL**：来自百度 `mu="null"` 字符串 bug（plan 根因 #1），ws.js 直接把字符串 `"null"` 当 url 打出，无过滤。
- **Q2/Q3 视频大全**：`http://3108.lightapp.baidu.com/<查询词>` 是百度视频聚合落地页，snippet 为哔哩哔哩视频列表（内含私用区字符），非目标文档页。
- **Q7 #2 百度图片**：图片聚合页（url 带 gb18030 编码的查询词），非目标内容。
- **Q4/Q6 语义错位**：走代理的英文查询，DDG 分支 0 结果静默失败（plan 根因 #9），最终由百度返回中文站结果（腾讯云/CSDN/繁中官方文档），与英文查询意图错位。Q4 命中 2 条英文 best-practices 站属运气，Q6 全中文。
- **Q5 重复/低质标题**：#1 与 #4 是同一篇腾讯科技 MCP 文章（view.inews.qq.com vs new.qq.com），且两条 title 都直接是 URL（百度未给 h3 文本）；ws.js 仅按 title 去重，无法识别该重复。
- **Q8 验证墙降级**：Q8 无代理查询时百度已触发验证墙，ws.js `catch(()=>null)` 静默吞掉，自动回落 cn.bing（标签 [bing]），CLI 无任何报错文案。连续多次查询后百度才触发墙（Q1-Q7 中百度一直可用，Q8 起失效）；格式样本与状态检测查询随后也均为 [bing]。

---

## 三、CLI 接口格式样本（对照基准）

### 3.1 原始输出（`node ws.js search "接口格式测试"`，本次实测）

```
Search results for "接口格式测试":

1. [bing] 接口（软件接口）_百度百科
   https://baike.baidu.com/item/%E6%8E%A5%E5%8F%A3/15422203
   接口（硬件类接口）是指同一计算机不同功能层之间的通信规则称为接口。 接口（软件接口）是指对协定进行定义的引用类型。 其他类型实现接口，以保证它们支持某些操作。 接口指定必须由类提供的 …

2. [bing] Java 接口 - 菜鸟教程
   https://www.runoob.com/java/java-interfaces.html
   Java 接口 接口（英文：Interface），在JAVA编程语言中是一个抽象类型，是抽象方法的集合，接口通常以interface来声明。 一个类通过继承接口的方式，从而来继承接口的抽象方法。 接口并不是类，编 …

3. [bing] 开发口中的「接口」到底是什么 - 知乎
   https://zhuanlan.zhihu.com/p/184858592
   2020年8月15日 · 接口通过 网络协议 来调用，我们最常用的协议是 HTTP协议。 在定义一个接口时，会写好 接口路径 和接口方法名的 映射，然后前端通过接口路径来调用方法。 举个例子：一个获取商品 …

4. [bing] 什么是接口 - API 基础知识和教程-Apifox
   https://apifox.com/apiskills/what-is-an-interface/
   当我们在开始学习编程的时候，可能会被各种概念和技术所淹没，而其中一个非常重要的概念就是接口。 下面给大家介绍下接口的概念。 什么是接口？ 接口 在编程领域中，接口通常用于描述两个软件系统 …

5. [bing] API接口是干嘛的？这篇通俗理解让你彻底明白 - 知乎
   https://zhuanlan.zhihu.com/p/1942291841035796972
   2025年8月22日 · 今天我们就用最通俗的语言，带你彻底理解——什么是API接口，它到底在干嘛，又为什么那么重要。 API接口是干嘛的？ API，全称是 Application Programming Interface，中文叫“ 应用 …

```

### 3.2 逐字节格式规范（对应 ws.js main() 输出代码）

```js
console.log(`Search results for "${query}":\n`);          // 首行含引号原样 query + 一个换行（即首行后空一行）
results.forEach((r, i) => {
  console.log(`${i + 1}. [${r.source}] ${r.title}`);       // "序号. [source] 标题"   source ∈ {baidu, bing, ddg}
  console.log(`   ${r.url}`);                               // 3 空格缩进 + url（url 可能为字符串 "null"）
  if (r.snippet) console.log(`   ${r.snippet}`);            // 3 空格缩进 + snippet（空则整行省略）
  console.log();                                            // 每条结果后一个空行
});
```

要点：
1. 首行固定 `Search results for "<query>":`，`<query>` 为原样输入（含空格、中文、`%` 等），后接空行。
2. 每条结果 3-4 行：`N. [source] title` / `   url` / `   snippet`(可选) / 空行。
3. 序号从 1 开始；缩进恒为 3 个空格；`[source]` 标签紧贴序号与标题之间，无空格歧义。
4. url 为原始字符串，百度可能输出字面 `null` 或 `http://` 开头 URL；未做协议/合法性过滤。
5. snippet 非空才打印；空 snippet 结果块仅 2 行 + 空行。
6. `[proxy] using <proxy>` 走 **stderr**（console.error），stdout 只含搜索结果（已用重定向实测验证：`2>/dev/null` 时无代理行、`1>/dev/null` 时无搜索结果以外的内容）。
7. `fetch` 命令输出为 `# 标题\n\nURL: <url>\n\n<正文>[可选截断标记]`。

---

## 四、本次实测环境快照（供复现对照）

- 日期：2026-08-02；Windows 11 + Git Bash；Node v24.16.0。
- 命令逐一执行（非并发），Q4-Q6 走 `HTTP_PROXY=http://127.0.0.1:<proxy-port>`。
- 百度在 Q1-Q7 期间可用（返回 [baidu]），Q8 起触发"安全验证"反爬（静默失败→回落 cn.bing），此后无代理查询均为 [bing]。
- 代理路径 DDG（html.duckduckgo.com）每次均 0 结果静默失败，全部回落百度 → 英文查询全部为 [baidu] 中文结果（复现 OPTIMIZATION_PLAN 根因 #9）。
- 相关文件：`./ws.js`（改动前）、`./OPTIMIZATION_PLAN.md`（设计依据）。
