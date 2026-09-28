# -*- coding: utf-8 -*-
"""全新 UI 校验：id 交叉（只增不删）+ CSS 括号 + 红线 + 弹窗/组件完整性"""
import io, re, os, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = os.path.join(R, "cep", "index.html")
NEW_DIR = os.path.join(R, "design", "新设计")
NEW = os.path.join(NEW_DIR, "index.html")
CSS = os.path.join(NEW_DIR, "style.css")

out = []
def W(s=""): out.append(s)
ok_all = True
def check(name, cond, extra=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    W("  %s %s%s" % ("✅" if cond else "❌", name, ("  → " + str(extra)[:150] if extra and not cond else "")))

old = io.open(OLD, encoding="utf-8").read()
new = io.open(NEW, encoding="utf-8").read()

W("=" * 66)
W("全新 UI（design/新设计）校验")
W("=" * 66)

W("【1】id 交叉（cep/index.html 的 121 个 id 必须一个不少）")
old_ids = set(re.findall(r'id="([A-Za-z0-9_]+)"', old))
new_ids = set(re.findall(r'id="([A-Za-z0-9_]+)"', new))
missing = sorted(old_ids - new_ids)
added = sorted(new_ids - old_ids)
dup = [i for i in new_ids if new.count('id="%s"' % i) > 1]
check("旧 %d 个 → 新 %d 个" % (len(old_ids), len(new_ids)), True)
check("缺失 = 0", len(missing) == 0, missing)
check("无重复 id", len(dup) == 0, dup)
W("  新增 id（%d 个）: %s" % (len(added), ", ".join(added)))
W()

W("【2】结构与红线")
check("4 页容器", all(('id="%s"' % p) in new for p in ["pageHome", "pageUvr", "pageStyle", "pageSet"]))
check("3 弹窗", all(('id="%s"' % p) in new for p in ["askOverlay", "cfmOverlay", "owOverlay"]))
check("标签栏 4 个 tab", all(('id="%s"' % t) in new for t in ["tabHome", "tabUvr", "tabStyle", "tabSet"]))
home = new[new.find('id="pageHome"'):new.find('id="pageUvr"')]
check("首页 primary 恰好 1 个", home.count('class="primary') == 1, home.count('class="primary'))
for ov in ["askOverlay", "cfmOverlay", "owOverlay"]:
    start = new.find('id="%s"' % ov)
    ends = [new.find('id="%s"' % o) for o in ["askOverlay", "cfmOverlay", "owOverlay"]
            if new.find('id="%s"' % o) > start]
    seg = new[start:min(ends)] if ends else new[start:]
    check("弹窗 %s primary 恰好 1 个" % ov, seg.count('class="primary') == 1)
inputs = sorted(set(re.findall(r'<input type="([a-z]+)"', new)))
check("无新 input 类型（%s）" % inputs, set(inputs) <= {"text", "number", "password", "checkbox", "color", "range"})
check("无 <datalist>", "<datalist" not in new)
check("无 <a 链接", not re.search(r"<a\s", new))
check("花体只在 h1 / about（各 1 次）", new.count("𝙉𝙤𝙣𝙞𝙞𝙠𝙖") == 1 and new.count("𝙁𝙖𝙙𝙚") == 1)
check("引用全新 style.css（非覆盖层）", 'href="style.css"' in new and "style-v2" not in new)
check("无旧版返回按钮（标签栏已取代）", new.count("data-home") == 0)

# 28 个持久化设置的控件必须全部在位（main.js persistKeys 直接 el[k] 取值）
persist = ["maxChars", "dropSuspect", "limitOn", "limitMin", "keepAudio", "mode", "fontSize",
           "color", "createLayers", "uvrOn", "uvrTarget", "uvrModel", "uvrFormat", "uvrKeep",
           "uvrPython", "uvrGpu", "subPrefix", "nameMode", "snapSpeech", "skipPresetShort",
           "dataDir", "stripPunct", "asrProfile", "asrApiKey", "asrSecretId", "asrSecretKey",
           "asrModel", "asrBaseUrl", "asrPrompt", "asrChunk"]
miss_p = [k for k in persist if ('id="%s"' % k) not in new]
check("28+2 个持久化设置控件全在位", len(miss_p) == 0, miss_p)
W()

W("【3】style.css（全新文件）")
css = io.open(CSS, encoding="utf-8").read()
css2 = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
check("花括号配对", css2.count("{") == css2.count("}"), "%d vs %d" % (css2.count("{"), css2.count("}")))
for cls in [".tabs", ".tab", ".rrow", ".rk", ".rv", ".rlink", ".steps", ".statgrid", ".chips",
            ".prevbox", ".envgrid", ".keyrow", ".stateRow", ".dot", ".cleanGroup", ".tip",
            ".runbtn", ".favBtn", ".reloadBtn", ".indent", ".overlay", ".askBox", ".log"]:
    check("类 %s 已定义" % cls, cls in css)
check("color-scheme: dark", "color-scheme: dark" in css)
check("password 在表单选择器里", 'input[type="password"]' in css)
check("深色滚动条", "::-webkit-scrollbar" in css)
check(":focus-visible", ":focus-visible" in css)
check("360 降级 @media", "@media (max-width: 380px)" in css)
check("动画 keyframes（pgIn/pgBack）", "@keyframes pgIn" in css and "@keyframes pgBack" in css)
check("动画无 fill-mode 属性（IME 防线；注释里提及不算）", "fill-mode" not in css2)
W()

W("【4】demo.js / 预览.html")
demo = io.open(os.path.join(NEW_DIR, "demo.js"), encoding="utf-8").read()
check("demo.js 无后端调用", all(k not in demo for k in ["fetch(", "XMLHttpRequest", "evalScript", "require("]))
prev = io.open(os.path.join(NEW_DIR, "预览.html"), encoding="utf-8").read()
check("评审台引用 index.html", 'src="index.html?page=home&state=ready"' in prev)
W()
W("判定: %s" % ("全部通过" if ok_all else "有问题，见上"))
txt = "\n".join(out)
print(txt)
io.open(os.path.join(NEW_DIR, "id-diff.txt"), "w", encoding="utf-8").write(
    "全新 UI id 校验\n\n旧 %d 个 · 新 %d 个 · 缺失 %d · 重复 %d\n\n新增 id：\n%s\n\n%s"
    % (len(old_ids), len(new_ids), len(missing), len(dup), "\n".join("+ " + a for a in added), txt))
sys.exit(0 if ok_all else 1)
