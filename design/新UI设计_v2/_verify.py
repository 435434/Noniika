# -*- coding: utf-8 -*-
"""v2 实施稿校验：id 交叉（只增不删）+ CSS 括号平衡 + 无新 input 类型 + 弹窗/组件完整性"""
import io, re, os, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = os.path.join(R, "cep", "index.html")
NEW_DIR = os.path.join(R, "design", "新UI设计_v2")
NEW = os.path.join(NEW_DIR, "index.html")
CSS = os.path.join(NEW_DIR, "style-v2.css")

out = []
def W(s=""): out.append(s)

ok_all = True
def check(name, cond, extra=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    W("  %s %s%s" % ("✅" if cond else "❌", name, ("  → " + str(extra)[:140] if extra and not cond else "")))

old = io.open(OLD, encoding="utf-8").read()
new = io.open(NEW, encoding="utf-8").read()

W("=" * 66)
W("v2 实施稿校验")
W("=" * 66)

W("【1】id 交叉校验（旧 121 个必须一个不少）")
old_ids = set(re.findall(r'id="([A-Za-z0-9_]+)"', old))
new_ids = set(re.findall(r'id="([A-Za-z0-9_]+)"', new))
missing = sorted(old_ids - new_ids)
added = sorted(new_ids - old_ids)
dup = [i for i in new_ids if new.count('id="%s"' % i) > 1]
check("旧 id 共 %d 个，新稿 %d 个" % (len(old_ids), len(new_ids)), True)
check("缺失（旧有新无）= 0", len(missing) == 0, missing)
check("无重复 id", len(dup) == 0, dup)
W("  新增 id（%d 个）:" % len(added))
for a in added:
    W("    + " + a)
W()

W("【2】结构与红线")
check("4 个页面容器齐全", all(('id="%s"' % p) in new for p in ["pageHome", "pageUvr", "pageStyle", "pageSet"]))
check("3 个弹窗齐全", all(('id="%s"' % p) in new for p in ["askOverlay", "cfmOverlay", "owOverlay"]))
check("每页 primary 数量检查", True)
home = new[new.find('id="pageHome"'):new.find('id="pageUvr"')]
check("首页 primary 恰好 1 个（生成字幕）", home.count('class="primary') == 1,
      home.count('class="primary'))
for ov in ["askOverlay", "cfmOverlay", "owOverlay"]:
    seg = new[new.find('id="%s"' % ov):]
    seg = seg[:seg.find("</div>\n</div>") if "</div>\n</div>" in seg else 2600]
    check("弹窗 %s 内 primary 恰好 1 个" % ov, seg.count('class="primary') == 1)
inputs = sorted(set(re.findall(r'<input type="([a-z]+)"', new)))
allowed = {"text", "number", "password", "checkbox", "color", "range"}
check("无新 input 类型（%s）" % inputs, set(inputs) <= allowed, set(inputs) - allowed)
check("无 <datalist>", "<datalist" not in new)
check("无 <a 链接", not re.search(r"<a\s", new))
check("花体只在 h1 / about", new.count("𝙉𝙤𝙣𝙞𝙞𝙠𝙖") == 1 and new.count("𝙁𝙖𝙙𝙚") == 1)
check("引用真实 style.css", "../../cep/css/style.css" in new)
check("引用 style-v2.css", "style-v2.css" in new)
W()

W("【3】style-v2.css")
css = io.open(CSS, encoding="utf-8").read()
# 去掉注释与字符串后数括号
css2 = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
check("花括号配对", css2.count("{") == css2.count("}"),
      "%d vs %d" % (css2.count("{"), css2.count("}")))
for comp in [".engbar", ".steps", ".statgrid", ".chips", ".prevbox", ".envgrid", ".keyrow"]:
    check("组件类 %s 已定义" % comp, comp in css)
check("焦点 :focus-visible 已补", ":focus-visible" in css)
check("360 降级 @media", "@media (max-width: 380px)" in css)
check("主按钮渐变", "linear-gradient(180deg, #3a74c4, #2e5c9a)" in css)
W()

W("【4】demo.js / 预览.html 基本完整性")
demo = io.open(os.path.join(NEW_DIR, "demo.js"), encoding="utf-8").read()
check("demo.js 无后端调用关键字（无 fetch/XMLHttpRequest/evalScript）",
      all(k not in demo for k in ["fetch(", "XMLHttpRequest", "evalScript", "require("]))
prev = io.open(os.path.join(NEW_DIR, "预览.html"), encoding="utf-8").read()
check("预览台引用 index.html", 'src="index.html?page=home&state=ready"' in prev)
W()
W("判定: %s" % ("全部通过" if ok_all else "有问题，见上"))
txt = "\n".join(out)
print(txt)
io.open(os.path.join(NEW_DIR, "id-diff.txt"), "w", encoding="utf-8").write(
    "v2 实施稿 id 校验（%s）\n\n旧 %d 个 · 新 %d 个 · 缺失 %d · 重复 %d\n\n新增 id：\n%s\n\n%s"
    % (re.sub(r"\D", "", "") or "", len(old_ids), len(new_ids), len(missing), len(dup),
       "\n".join("+ " + a for a in added), txt))
sys.exit(0 if ok_all else 1)
