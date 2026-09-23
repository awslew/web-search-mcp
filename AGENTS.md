# AGENTS.md

面向在此仓库工作的 coding agent。**只写"看代码不容易知道"的约束**，通用工程规范不重复。

## 这是什么

一个 **MCP stdio 服务器**：多引擎联网检索 + 正文抽取。核心卖点是**无需任何 API key**
即可完整工作（国内引擎直连融合 + 英文国际链并行）。

## 常用命令

```bash
npm install                          # Node >= 22.5（node:sqlite 的 DatabaseSync 被缓存层使用）

npm run test:unit                    # 7 套纯离线确定性测试 —— 改代码后先跑这个
npm test                             # 9 套全量（含 2 套真实网络测试，可能因外部限流偶发失败）
npm run test:net                     # 单跑检索通道真实网络测试
npm run test:mcp                     # 单跑 MCP 端到端 JSON-RPC 测试

node ws.js search "关键词"            # CLI 入口
node ws.js fetch "https://..."       # 抓正文
node ws.js status                    # 看当前闸门/引擎/密钥状态（排查第一步）
```

## 改动纪律（重要）

1. **改排序 / 解析 / 权重逻辑后必须做受控对比，不能凭感觉**：
   先 `npm run eval:capture <tag>` 抓原始候选池，再 `npm run eval:replay <tag>` 离线重放，
   最后 `npm run eval:compare a b`。**同一份池子上做变量对比**，否则引擎波动会淹没结论。
2. **验证排序改动必须用 `eval/show.mjs` 人眼核查最终排序**——聚合指标（nDCG）会掩盖
   "分数涨了但官方文档被挤下去"这类问题。
3. **`npm run verify:quality` 会真实联网**（约 8 次外部 API 调用），别反复跑。
4. **改 `search-core.mjs` 后，正在运行的 MCP stdio 进程不会热重载**——需重启客户端。
5. **`blacklist.json` 不随仓库分发**（上游为 GPL-3.0），由 `npm run update:blacklist` 本地生成。
   代码内有一份兜底名单，改过滤逻辑时注意两者都要覆盖。
6. `skill/SKILL.md` 是**面向 agent 的检索纪律手册**，含多个"被自己推翻的判断"
   （语义重排实为负优化、按评估集调参得到的满分是假象）。改行为参数前先读它，
   能避免重走已否定的路。
7. `docs/` 下是开发过程记录（设计依据 / 基线 / 验收报告 / 部署手册），**不是使用必需**。
   改评测相关逻辑时它们是基准来源。

## 目录速览

| 文件 | 职责 |
|---|---|
| `server-cn.mjs` | MCP stdio 入口，注册 3 个工具 |
| `ws.js` | CLI 入口（search / fetch / status） |
| `search-core.mjs` | 检索核心：引擎驱动、RRF 融合、黑名单、权威加权、缓存、API 抢救闸门 |
| `extract-core.mjs` | 正文抽取：linkedom + Readability + turndown + GBK 解码 |
| `rerank.mjs` | 可选语义重排（cross-encoder，**默认关闭，实测会降级官方文档**） |
| `eval/` | 40 条标注查询的离线评估体系 |
| `skill/` | 检索纪律手册 |

## 不要做的事

- 不要为了让测试变绿而放宽断言——那 2 套联网测试失败**先确认是不是网络/限流问题**
- 不要在无 key 的前提下引入"必须有 API key 才能用"的路径（违反核心卖点）
- 不要把 `blacklist.json` 提交进仓库（许可证冲突）
