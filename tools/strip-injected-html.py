# -*- coding: utf-8 -*-
"""清掉 HTML 里被编辑器回写的 data-page-node-id 属性（源文件侧）。
打包脚本也会在包内副本上再剥一遍兜底，但源文件保持干净更省心。"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RX = re.compile(r'\s+data-page-node-id="[^"]*"')

targets = sys.argv[1:] or [
    os.path.join(ROOT, "cep", "support.html"),
    os.path.join(ROOT, "cep", "index.html"),
]
for p in targets:
    if not os.path.isfile(p):
        print("  %s 不存在，跳过" % p)
        continue
    s = io.open(p, encoding="utf-8").read()
    n = s.count("data-page-node-id")
    if not n:
        print("  %-28s 干净（0 处）" % os.path.basename(p))
        continue
    s2 = RX.sub("", s)
    io.open(p, "w", encoding="utf-8", newline="").write(s2)
    print("  %-28s 剥掉 %d 处 → 剩 %d 处" % (os.path.basename(p), n, s2.count("data-page-node-id")))
