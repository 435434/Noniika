"""统一校验 + 跑全部测试套件（一次跑完，输出汇总）。"""
import io, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get("AESUB_NODE") or shutil.which("node") or "node"
PY = os.environ.get("AESUB_PYTHON") or sys.executable

def run(args, cwd=ROOT, timeout=900):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return p.returncode, (p.stdout or ""), (p.stderr or "")

print("=== 1. 语法检查 ===")
files = ["cep/js/main.js", "cep/js/cleanup.js", "cep/js/ae-api.js", "cep/js/cep-bridge.js",
         "pipeline/cli.js", "pipeline/lib/speech.js", "pipeline/lib/separate.js",
         "pipeline/lib/ffmpeg.js", "pipeline/lib/postprocess.js"]
bad = []
for f in files:
    rc, out, err = run([NODE, "--check", f])
    if rc != 0:
        bad.append(f + " :: " + (err or out).strip()[:160])
# jsx 要当 js 检查
tmp = os.path.join(tempfile.gettempdir(), "aesub_check.js")
io.open(tmp, "w", encoding="utf-8").write(
    io.open(os.path.join(ROOT, "cep/jsx/ae-bridge.jsx"), encoding="utf-8").read())
rc, out, err = run([NODE, "--check", tmp])
if rc != 0:
    bad.append("cep/jsx/ae-bridge.jsx :: " + (err or out).strip()[:200])
os.remove(tmp)
print("  全部语法 OK" if not bad else "  ** 有语法错误 **\n    " + "\n    ".join(bad))

print("\n=== 2. 面板 id 交叉 ===")
html = io.open(os.path.join(ROOT, "cep/index.html"), encoding="utf-8").read()
js = io.open(os.path.join(ROOT, "cep/js/main.js"), encoding="utf-8").read()
hs = set(re.findall(r'id="([A-Za-z0-9_]+)"', html))
# 锚定在 ids.forEach 之前的那一个数组 —— 不能用"第一个 var ids = ["，
# 因为 main.js 里还有别处会用这个变量名（setStepCells 就曾撞过名，
# 导致这里静默检查了错误的数组、报出一堆假"冗余"）。
_anchor = js.find("ids.forEach(function (id)")
_arr_start = js.rfind("var ids = [", 0, _anchor if _anchor > 0 else len(js))
m = re.match(r'var ids = \[(.*?)\];', js[_arr_start:], re.S)
arr = re.findall(r'"([A-Za-z0-9_]+)"', m.group(1))
refs = re.findall(r'(?<![A-Za-z0-9_])el\.([A-Za-z0-9_]+)', js)
ids = set(arr + refs)
print("  HTML %d / JS %d → 缺失 %s · 冗余 %s" %
      (len(hs), len(ids), [i for i in ids if i not in hs] or "无", sorted(hs - ids) or "无"))

print("\n=== 3. 测试套件 ===")
suites = [
    ("清理模块（AeClean）", [NODE, "test/cleanup-test.js"], 600),
    ("面板清理逻辑", [NODE, "test/panel-clean-test.js"], 120),
    ("面板收藏与切页动画", [NODE, "test/panel-fav-test.js"], 120),
    ("拼音搜索（纯逻辑）", [NODE, "test/pinyin-search-test.js"], 120),
    ("面板分离按钮", [NODE, "test/panel-separate-test.js"], 180),
    ("桥接层关键帧/短句判定", [NODE, "test/bridge-keys-test.js"], 120),
    ("面板体检逻辑", [NODE, "test/panel-subcheck-test.js"], 120),
    ("只分离端到端（真跑分离）", [NODE, "test/separate-only-test.js"], 900),
    ("媒体探测两条路一致性", [NODE, "test/probe-both-ways.mjs"], 400),
    ("桥接层路径归一化（file:/// 坑）", [NODE, "test/bridge-path-test.js"], 120),
    ("流水线语音校正", [NODE, "pipeline/test/speech-test.mjs"], 300),
    ("分发脚本（安装/卸载 bat 真跑）", [PY, "test/bat-test.py"], 1200),
    ("分发后「支持页」在别人的电脑上", [PY, "test/support-page-otherpc-test.py"], 600),
    ("发前终检（zip vs 源码）", [PY, "test/package-preflight.py"], 120),
]
total_pass = total_fail = 0
for name, args, tmo in suites:
    rc, out, err = run(args, timeout=tmo)
    last = ""
    for line in reversed(out.splitlines()):
        if line.strip().startswith(("ALLPASS|", "FAILED|", "通过")):
            last = line.strip(); break
    print("  %-26s %s" % (name, last or ("rc=" + str(rc))))
    if last.startswith("ALLPASS|"):
        total_pass += int(last.split("|")[1])
    elif last.startswith("通过"):
        mm = re.search(r"通过 (\d+) / (\d+)", last)
        if mm:
            total_pass += int(mm.group(1)); total_fail += int(mm.group(2)) - int(mm.group(1))
    else:
        total_fail += 1
        print("      ⚠ " + (out or err).strip()[-300:].replace("\n", " | "))

print("\n  断言合计：通过 %d · 失败 %d" % (total_pass, total_fail))
print("  总结论：" + ("全部通过" if total_fail == 0 and not bad else "有问题，见上"))
