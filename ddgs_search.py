#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ddgs_search.py — ddgs Python 子进程桥（search-core.mjs 的 searchDdgs 调用）。
用法：
    python ddgs_search.py "<query>" [max]

输出：stdout 打 JSON 数组 [{title,url,snippet},...]。
ddgs 未装 / 出错 / 无结果 → 打印 [] 并以 exit 0 退出（Node 侧静默跳过）。
代理：读 DDGS_PROXY（其次 HTTPS_PROXY / HTTP_PROXY）；都不设则直连 —— 外网通常需要代理，
      由调用方（search-core.mjs）在 spawn 时把环境变量传进来，本脚本不硬编码任何端口。
"""
import json
import os
import sys

try:
    from ddgs import DDGS
except Exception:  # ddgs 未安装
    print("[]")
    sys.exit(0)

PROXY = (
    os.environ.get("DDGS_PROXY")
    or os.environ.get("HTTPS_PROXY")
    or os.environ.get("HTTP_PROXY")
    or ""
)


def main():
    args = sys.argv[1:]
    if not args:
        print("[]")
        return
    query = args[0]
    max_results = 10
    if len(args) > 1:
        try:
            max_results = int(args[1])
        except ValueError:
            pass
    try:
        ddgs = DDGS(timeout=15, **({"proxy": PROXY} if PROXY else {}))
        rows = ddgs.text(
            query,
            region="us-en",
            safesearch="moderate",
            max_results=max(max_results, 1),
        )
        out = []
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            title = (r.get("title") or "").strip()
            url = (r.get("href") or "").strip()
            body = (r.get("body") or "").strip()
            if title and url:
                out.append({"title": title, "url": url, "snippet": body})
        print(json.dumps(out, ensure_ascii=False))
    except Exception:
        print("[]")


if __name__ == "__main__":
    main()
