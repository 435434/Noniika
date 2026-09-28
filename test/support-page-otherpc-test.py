# -*- coding: utf-8 -*-
"""模拟「别人的电脑」：把**分发包里的插件目录**原样拷到一个外部路径
（带空格 + 中文用户名 + 长路径），然后逐条验：

  ① 分发包里到底有没有 support.html 与赞赏码（打包白名单漏了就是这里暴露）
  ② 真实桥接层能不能在该目录下解析出 support.html（URI / 普通形态都试）
  ③ support.html 里的相对路径 assets/zanshang-code.png 在该目录下能不能落地
  ④ 页面里**不含任何写死的本机路径**（换台电脑就废的那种写法）
  ⑤ 反面用例：把 support.html 改名后，判定必须变成"不存在"（证明判定不是恒真）
  ⑥ 【可选，需 AESUB_TEST_LAUNCH=1】真用 explorer.exe 打开该副本，
     并枚举顶层窗口标题确认浏览器真的弹出来了

用法：
  python test/support-page-otherpc-test.py                 # 静态部分
  set AESUB_TEST_LAUNCH=1 && python test/support-page-otherpc-test.py   # 连弹窗一起验
"""
import ctypes
import ctypes.wintypes as wt
import io
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(ROOT, "插件打包", "com.aesub.autosubtitle")
NODE = os.environ.get("AESUB_NODE") or shutil.which("node") or "node"
BRIDGE_TEST = os.path.join(ROOT, "test", "bridge-path-test.js")

# 故意做成"别人的机器"的样子：中文用户名 + 空格 + 较深的长路径
FAKE = os.path.join(os.environ["TEMP"], "模拟别人的电脑", "C 盘", "Users", "张小明",
                    "AppData", "Roaming", "Adobe", "CEP", "extensions", "com.aesub.autosubtitle")

pass_n = fail_n = 0
def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  ✅ " + name)
    else:
        fail_n += 1
        print("  ❌ " + name + (("  → " + str(extra)) if extra else ""))

print("=== 0. 准备：把分发包拷成「别人电脑上的样子」 ===")
if not os.path.isdir(PKG):
    print("  **跳过：还没有分发包（先跑 tools/build-package.py）**")
    sys.exit(0)
if os.path.isdir(FAKE):
    shutil.rmtree(FAKE, ignore_errors=True)
os.makedirs(os.path.dirname(FAKE), exist_ok=True)
shutil.copytree(PKG, FAKE)
print("  目标目录（%d 字符）：%s" % (len(FAKE), FAKE))

print("\n=== ① 分发包里必须有这两样（打包白名单最容易漏）===")
check("support.html 在分发包里", os.path.isfile(os.path.join(FAKE, "support.html")))
qr_rel = None
m = re.search(r'<img[^>]*src="([^"]+)"', io.open(os.path.join(FAKE, "support.html"), encoding="utf-8").read())
if m:
    qr_rel = m.group(1)
check("support.html 里的 <img src> 是相对路径（不是写死的绝对路径）",
      bool(qr_rel) and not re.match(r"^([a-zA-Z]:|/|file:|https?:)", qr_rel), qr_rel)
check("赞赏码图片按该相对路径能在分发包里找到",
      bool(qr_rel) and os.path.isfile(os.path.join(FAKE, qr_rel.replace("/", os.sep))),
      os.path.join(FAKE, (qr_rel or "").replace("/", os.sep)))

print("\n=== ② 用**真实桥接层**在该目录下解析路径 ===")
env = dict(os.environ, AESUB_EXT_DIR=FAKE)
r = subprocess.run([NODE, BRIDGE_TEST], capture_output=True, text=True, timeout=180,
                   encoding="utf-8", errors="replace", env=env)
tail = [l for l in (r.stdout or "").splitlines() if l.strip().startswith(("✅", "❌", "通过"))]
print("\n".join("  " + l.strip() for l in tail))
check("桥接层在「别人的电脑」路径下全部通过", "通过 13 / 13" in (r.stdout or ""),
      (r.stdout or "").splitlines()[-1] if r.stdout else r.stderr[:200])

print("\n=== ③ 页面里不能有写死的本机路径 / 也不能有编辑器注入 ===")
html = io.open(os.path.join(FAKE, "support.html"), encoding="utf-8").read()
for bad in ["C:/Users/kunku", "C:\\Users\\kunku", "file:///"]:
    check("不含 " + bad, bad not in html)
check("爱发电链接是绝对网址（本来就该绝对）", "https://afdian.com/a/Noniika007" in html)
# ⚠ 编辑器/预览工具会往 HTML 里回写 data-page-node-id 这类属性（本项目实测被注入过两次，各 37 处）。
#   它们只服务于可视化编辑，不该随包发出去。
#   **包内必须干净（这条是硬失败）**；源文件只提示 —— 编辑器可能正开着它，
#   由 tools/strip-injected-html.py 清理，打包脚本也会在包内副本上再剥一遍兜底。
check("包内页面不含编辑器注入属性（data-page-node-id）", "data-page-node-id" not in html)
_src = io.open(os.path.join(ROOT, "cep", "support.html"), encoding="utf-8").read()
_src_norm = re.sub(r'\s+data-page-node-id="[^"]*"', "", _src)
if _src != _src_norm:
    print("  ⚠ 源文件 cep/support.html 被编辑器回写了 %d 处注入属性"
          "（跑 python tools/strip-injected-html.py 可清掉；包内已自动剥除）"
          % _src.count("data-page-node-id"))
check("源文件与包内页面内容一致（忽略编辑器注入属性）",
      _src_norm.encode("utf-8") == html.encode("utf-8"))

print("\n=== ④ 反面用例：页面不在时，判定必须是「不存在」 ===")
sp = os.path.join(FAKE, "support.html")
bak = sp + ".bak"
os.rename(sp, bak)
try:
    r2 = subprocess.run([NODE, BRIDGE_TEST], capture_output=True, text=True, timeout=180,
                        encoding="utf-8", errors="replace", env=env)
    out2 = r2.stdout or ""
    check("改了名之后，support.html 判定为不存在（说明判定有效，不是恒真）",
          "❌ support.html 在该目录下真实存在" in out2)
    check("此时整体结论为失败（避免「漏带文件却全绿」）", "通过 12 / 13" in out2,
          out2.splitlines()[-1] if out2 else r2.stderr[:150])
finally:
    os.rename(bak, sp)

print("\n=== ⑤ 真实弹窗验证（需 AESUB_TEST_LAUNCH=1）===")
if os.environ.get("AESUB_TEST_LAUNCH") != "1":
    print("  （跳过：未设置 AESUB_TEST_LAUNCH=1 —— 跑它会在你屏幕上真的开一个浏览器）")
else:
    u = ctypes.windll.user32
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def titles():
        out = []
        def cb(h, _):
            n = u.GetWindowTextLengthW(h)
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if b.value:
                out.append(b.value)
            return True
        u.EnumWindows(CB(cb), 0)
        return out

    before = set(titles())
    subprocess.run(["explorer.exe", sp], capture_output=True, timeout=60)
    time.sleep(5)
    after = set(titles())
    hit = [t for t in after if "支持 Noniika" in t or "Noniika" in t]
    check("浏览器真的打开了支持页（窗口标题命中）", bool(hit), "；".join(t[:60] for t in hit))
    if hit:
        print("     命中窗口：" + hit[0][:80])
    new = [t for t in after - before]
    check("（附）确实有新窗口出现", bool(new) or bool(hit), "；".join(t[:40] for t in new[:3]))

print("\n  通过 %d / %d" % (pass_n, pass_n + fail_n))

shutil.rmtree(FAKE, ignore_errors=True)
print("  已清理模拟目录")
sys.exit(1 if fail_n else 0)
