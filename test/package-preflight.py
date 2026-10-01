# -*- coding: utf-8 -*-
"""发前终检（只读）：解开 `插件打包` 里最新的 Noniika-v*.zip，逐项核对是否为当前最新内容。

版本号不再写死 —— 用 glob 取序号最大的那个 zip（写死过一次，v0.9.2 时就得回来改）。
"""
import glob
import io, os, re, time, zipfile

R = os.getcwd()

def _ver_key(p):
    m = re.search(r"Noniika-v([0-9]+(?:\.[0-9]+)*)\.zip$", os.path.basename(p))
    return [int(x) for x in m.group(1).split(".")] if m else [0]

_cands = glob.glob(os.path.join(R, "插件打包", "Noniika-v*.zip"))
if not _cands:
    raise SystemExit("插件打包/ 里没有 Noniika-v*.zip —— 先跑 tools/build-package.py")
zpath = sorted(_cands, key=_ver_key)[-1]
if len(_cands) > 1:
    print("   （发现 %d 个 zip，取最新：%s）" % (len(_cands), os.path.basename(zpath)))
pass_n = fail_n = 0
def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond: pass_n += 1; print("  ✅ " + name)
    else:    fail_n += 1; print("  ❌ " + name + (("  → " + str(extra)) if extra else ""))

print("=== 0. zip 基本状态 ===")
mt = time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(zpath)))
print("   %s  %.1f MB  修改于 %s" % (os.path.basename(zpath), os.path.getsize(zpath)/1048576, mt))
z = zipfile.ZipFile(zpath)
check("zip 结构完整（testzip）", z.testzip() is None)
names = z.namelist()
print("   条目 %d 个" % len(names))

def zread(suffix):
    hits = [n for n in names if n.endswith(suffix)]
    return z.read(hits[0]) if hits else None

print("\n=== 1. 必备文件在不在 ===")
for k in ["一键安装.bat", "一键卸载.bat", "安装说明.md",
          "com.aesub.autosubtitle/support.html",
          "com.aesub.autosubtitle/assets/zanshang-code.png",
          "com.aesub.autosubtitle/LICENSE",
          "com.aesub.autosubtitle/THIRD-PARTY-NOTICES.md",
          "com.aesub.autosubtitle/使用说明.md",
          "com.aesub.autosubtitle/CSXS/manifest.xml",
          "com.aesub.autosubtitle/jsx/ae-bridge.jsxbin",
          "com.aesub.autosubtitle/node-runtime/node.exe",
          "com.aesub.autosubtitle/pipeline/vendor/ffmpeg/ffmpeg.exe"]:
    check("含 " + k.split("/")[-1] + ("（" + k.split("/com.aesub")[0] + "）" if "com.aesub" in k else "（包根）"),
          zread(k) is not None)

print("\n=== 2. 关键内容是最新版（与当前源码逐字节比对）===")
pairs = [
    ("cep/index.html",                  "com.aesub.autosubtitle/index.html"),
    ("cep/support.html",                "com.aesub.autosubtitle/support.html"),
    ("cep/css/style.css",               "com.aesub.autosubtitle/css/style.css"),
    ("cep/js/main.js",                  "com.aesub.autosubtitle/js/main.js"),
    ("cep/js/cep-bridge.js",            "com.aesub.autosubtitle/js/cep-bridge.js"),
    ("cep/assets/zanshang-code.png",    "com.aesub.autosubtitle/assets/zanshang-code.png"),
    ("LICENSE",                         "com.aesub.autosubtitle/LICENSE"),
    ("THIRD-PARTY-NOTICES.md",          "com.aesub.autosubtitle/THIRD-PARTY-NOTICES.md"),
]
for src, dst in pairs:
    a = open(os.path.join(R, src.replace("/", os.sep)), "rb").read()
    b = zread(dst)
    check(os.path.basename(src) + " = 源文件", a == b,
          "%d vs %s 字节" % (len(a), len(b) if b else "缺失"))

print("\n=== 3. 支持页是今天改过的文案 ===")
sp = zread("com.aesub.autosubtitle/support.html").decode("utf-8")
check("含「想留句话，从这里进：」", "想留句话，从这里进：" in sp)
check("旧提示行已删（个人收款码）", "个人收款码" not in sp)
check("爱发电按钮在", "afdian.com/a/Noniika007" in sp)
check("无编辑器注入属性", "data-page-node-id" not in sp)
check("赞赏码是相对路径", 'src="assets/zanshang-code.png"' in sp)
# ♥ 按钮这一环：光有文件不够 —— 面板里的按钮与打开逻辑也得在
# （自用版是**故意**去掉的，分发包必须有；删改任一处都会在这里被拦下）
_pidx = zread("com.aesub.autosubtitle/index.html").decode("utf-8")
_pjs = zread("com.aesub.autosubtitle/js/main.js").decode("utf-8")
check("面板 ♥ 按钮在（btnSupport）", 'id="btnSupport"' in _pidx)
check("♥ 打开逻辑在（openSupportPage + 绑定）",
      "function openSupportPage" in _pjs and "el.btnSupport" in _pjs)

print("\n=== 4. 许可与文档是免费模式 ===")
lic = zread("com.aesub.autosubtitle/LICENSE").decode("utf-8")
check("LICENSE = 免费使用许可 v1.0", "免费使用许可 v1.0" in lic and "专有许可" not in lic)
ins = zread("安装说明.md").decode("utf-8")
check("安装说明有「八、赞助」", "八、赞助" in ins)
check("安装说明开头点明免费", "没有付费版" in ins)
use = zread("com.aesub.autosubtitle/使用说明.md").decode("utf-8")
check("使用说明有 ♥ 说明", "♥" in use)

print("\n=== 5. 版本与合规红线 ===")
man = zread("com.aesub.autosubtitle/CSXS/manifest.xml").decode("utf-8")
# 版本不再写死在这 —— 改成"四处必须一致"的一致性检查（写死过一次，v0.9.2 时就得回来改）
_mv = re.search(r'ExtensionBundleVersion="([0-9][0-9.]*)"', man)
v = _mv.group(1) if _mv else "?"
check("manifest 有版本号", v != "?", "读不到 ExtensionBundleVersion")
check("manifest 两处版本一致",
      ('<Extension Id="com.aesub.autosubtitle.panel" Version="%s"' % v) in man,
      "bundle 与 Extension 节点的版本不一致")
check("zip 文件名版本 = manifest", os.path.basename(zpath) == "Noniika-v%s.zip" % v,
      os.path.basename(zpath))
check("ScriptPath 指向 jsxbin", "ae-bridge.jsxbin" in man)
check("无明文 jsx", not any(n.endswith("ae-bridge.jsx") for n in names))
check("无 node_modules", not any("/node_modules/" in n for n in names))
check("无 python-env / models", not any(("/python-env/" in n or "/models/" in n) for n in names))
check("自带 node.exe 在", zread("com.aesub.autosubtitle/node-runtime/node.exe") is not None)
_html = zread("com.aesub.autosubtitle/index.html").decode("utf-8")
check("面板关于串版本 = manifest", ("Noniika v%s ·" % v) in _html,
      "index.html 里的 about 串与 manifest 不一致")
js = zread("com.aesub.autosubtitle/js/main.js").decode("utf-8")
check("启动日志版本 = manifest", ('log("Noniika v%s")' % v) in js,
      "main.js 启动日志的版本与 manifest 不一致")

print("\n  通过 %d / %d" % (pass_n, pass_n + fail_n))
print("  结论：" + ("可以发（包内全部为当前最新内容）" if fail_n == 0 else "**有问题，先修再发**"))
