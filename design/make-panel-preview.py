#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 cep/index.html 渲染成一份「可当幻灯片看」的独立预览稿：design/panel-preview.html

为什么有它：面板要新增「清理内存（火箭）」「清理插件产生的文件（垃圾桶）」
两个按钮，先出预览让用户挑落脚点。
做法：内联真实 CSS + 按 div 配平抠出四个页面 + 填典型示例数据 + 标注候选位置。
以后改完面板 UI，重跑本脚本即可刷新预览。

用法：python design/make-panel-preview.py
"""
import io
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "cep", "index.html")
CSS = os.path.join(ROOT, "cep", "css", "style.css")
OUT = os.path.join(ROOT, "design", "panel-preview.html")

html = io.open(SRC, encoding="utf-8").read()
css = io.open(CSS, encoding="utf-8").read()


# ----------------------------------------------------------------- 抠页面

def page_block(marker):
    """从 <div class="page" ...> 开始，按 div 配平抠出整块"""
    i = html.index(marker)
    depth = 0
    for m in re.finditer(r"</?div\b[^>]*>", html[i:]):
        depth += -1 if m.group(0).startswith("</") else 1
        if depth == 0:
            return html[i:i + m.end()]
    raise SystemExit("div 配平失败：" + marker)


pages = {
    "home": page_block('<div class="page on" id="pageHome">'),
    "uvr": page_block('<div class="page" id="pageUvr">'),
    "style": page_block('<div class="page" id="pageStyle">'),
    "set": page_block('<div class="page" id="pageSet">'),
}


# ----------------------------------------------------------------- 改内容的工具

def find_element(block, elem_id):
    """返回 (开标签起点, 开标签终点, 闭标签起点, 标签名)；找不到返回 None"""
    m = re.search(r'<(\w+)\b[^>]*\bid="' + re.escape(elem_id) + r'"[^>]*>', block)
    if not m:
        return None
    tag = m.group(1)
    if m.group(0).endswith("/>") or tag in ("input", "br", "img", "hr"):
        return (m.start(), m.end(), m.end(), tag)
    pat = re.compile(r"<" + tag + r"\b[^>]*>|</" + tag + r">")
    depth = 0
    for mm in pat.finditer(block, m.start()):
        depth += -1 if mm.group(0).startswith("</") else 1
        if depth == 0:
            return (m.start(), m.end(), mm.start(), tag)
    return None


def set_inner(block, elem_id, inner, warn=True):
    loc = find_element(block, elem_id)
    if not loc:
        if warn:
            print("  [!] 没找到 id=" + elem_id)
        return block
    _, o_end, c_start, _ = loc
    return block[:o_end] + inner + block[c_start:]


def replace_open(block, elem_id, new_open, warn=True):
    loc = find_element(block, elem_id)
    if not loc:
        if warn:
            print("  [!] 没找到 id=" + elem_id)
        return block
    s, o_end, _, _ = loc
    return block[:s] + new_open + block[o_end:]


def insert_before(block, anchor, snippet, warn=True):
    if anchor not in block:
        if warn:
            print("  [!] 没找到插入锚点：" + anchor[:40])
        return block
    return block.replace(anchor, snippet + "\n" + anchor, 1)


def row(cls, text):
    return '<div class="stateRow"><span class="dot ' + cls + '"></span><span>' + text + "</span></div>"


# ----------------------------------------------------------------- 候选按钮

CAND_A = """<div class="pvCand"><span class="pvCandTag">候选 A</span>
      <div class="actions fill">
        <button class="ghost small">🚀 清理内存</button>
        <button class="ghost small">🗑 清理插件文件</button>
      </div>
    </div>"""

CAND_B = """<div class="pvCand"><span class="pvCandTag">候选 B</span>
      <section class="card">
        <div class="card-title"><span>维护</span></div>
        <div class="actions fill">
          <button class="ghost small">🚀 清理内存</button>
          <button class="ghost small">🗑 清理插件文件</button>
        </div>
        <div class="hint">给内存放气、收拾插件自己留下的临时文件。</div>
      </section>
    </div>"""

CAND_C = """<div class="pvCand"><span class="pvCandTag">候选 C</span>
        <div class="actions" style="margin-top:6px">
          <button class="ghost small">🚀 清理内存</button>
          <button class="ghost small">🗑 清理插件文件</button>
        </div>
      </div>"""

CAND_D = """<div class="pvCand"><span class="pvCandTag">候选 D</span>
    <section class="card">
      <div class="card-title"><span>维护</span><span class="sumb">清理类操作</span></div>
      <div class="actions fill" style="margin-top:0">
        <button class="ghost small">🚀 清理内存</button>
        <button class="ghost small">🗑 清理插件文件</button>
      </div>
      <div class="hint">「清理内存」只放掉被占着不用的内存，不影响任何软件运行；
        「清理插件文件」会先列出清单让你确认，再删除本插件自己产生的中间文件。</div>
    </section>
  </div>"""

# ----------------------------------------------------------------- 首页

home = pages["home"]
home = replace_open(home, "envBadge", '<span id="envBadge" class="badge ok">环境就绪</span>')
home = set_inner(home, "selInfo",
    '<span class="k">合成</span>合成 1 · 1920×806<br>'
    '<span class="k">素材</span>无上光荣.mp4（视频 · 带音频）<br>'
    '<span class="k">选中</span>1 个图层<br>'
    '<span class="k">区间</span>0.00 ~ 154.20 秒')
home = set_inner(home, "selHint",
    "点「开始生成字幕」后：导出音频 → 人声分离 → 云端识别 → 在合成里建字幕图层。")
home = set_inner(home, "navUvr", '<span id="navUvr" class="on">当前：开（MelBand Roformer）</span>')
home = set_inner(home, "navStyle", '<span id="navStyle">每句一层 · 72</span>')
home = set_inner(home, "resultInfo",
    '<span class="k">字幕</span>42 句 · 612 字 · 语音覆盖 87%<br>'
    '<span class="k">图层</span>已在合成「合成 1」中创建 42 个<br>'
    '<span class="k">产物</span>无上光荣.json / .srt / .txt<br>'
    '<span class="k">用时</span>134 秒（识别 41 秒 / 分离 62 秒）')
home = set_inner(home, "log",
    "→ 导出音频：0.00 ~ 154.20 秒（16kHz 单声道）<br>"
    "→ 人声分离：MelBand Roformer · 62 秒<br>"
    "→ 上传识别：42 句<br>"
    "→ 按语音校正了 19 句（检测到 47 处语音），另有 23 句保持原样<br>"
    "   · 第 12 句「我们胜利了」8.20~9.05 秒 → 8.14~9.28 秒（+9 毫秒）<br>"
    "√ 预设动画跨度 2.00 秒 → 已铺满本句 5.00 秒（拉伸 2.50×）<br>"
    "√ 完成")
home = home.replace('id="resultCard" style="display:none"', 'id="resultCard"')
home = home.replace('<details class="card" id="logBox">', '<details class="card" id="logBox" open>')
home = home.replace('<div id="status" class="status">就绪</div>',
                    '<div id="status" class="status">完成：42 句字幕已创建</div>')
home = home.replace('<div id="bar"></div>', '<div id="bar" style="width:100%"></div>')
home = home.replace('id="noLayerWarn" class="hint warnText" style="display:none"',
                    'id="noLayerWarn" class="hint warnText"')
# 候选 A：导航按钮下方；候选 B：底部脚注上方
home = insert_before(home, '<div class="hint" style="margin-top:0">其余设置（识别选项', CAND_A)
home = insert_before(home, '<div class="footnote">音频会上传到字节跳动', CAND_B)

# ----------------------------------------------------------------- 人声分离

uvr = pages["uvr"]
uvr = uvr.replace('<input type="checkbox" id="uvrOn">', '<input type="checkbox" id="uvrOn" checked>')
uvr = uvr.replace('<div class="indent off" id="uvrBody">', '<div class="indent" id="uvrBody">')
uvr = replace_open(uvr, "uvrBadge", '<span id="uvrBadge" class="badge ok" style="margin-left:auto">已就绪</span>')
uvr = set_inner(uvr, "uvrModelHint",
    "MelBand Roformer · 人声 SDR 12.6（榜单最高）· 需 GPU · 模型 871 MB（已下载）")
uvr = set_inner(uvr, "uvrDeps",
    row("ok", "Python 3.13.12 · 独立环境 python-env（不污染系统）") +
    row("ok", "audio-separator 1.30.0 已安装") +
    row("ok", "本地运行，音频不会因为这一步离开你的电脑") +
    row("ok", "运算设备 GPU · NVIDIA GeForce RTX 4060 Laptop GPU（torch √ · ONNX √）"))
uvr = set_inner(uvr, "uvrPython", "")

# ----------------------------------------------------------------- 字幕样式

style = pages["style"]
style = replace_open(style, "fontSelect",
    '<select id="fontSelect">'
    '<option value="REEJI-PinboGB-Flash">REEJI-PinboGB-Flash（锐字奥运精神拼搏）</option>'
    '<option value="STKaiti">STKaiti（华文楷体）</option>'
    '<option value="SourceHanSansCN-Bold">SourceHanSansCN-Bold（思源黑体）</option>'
    '</select>')
style = set_inner(style, "fontCount", "AE 里共 220 个家族；匹配 10 个")
style = set_inner(style, "fontNow", "字体：REEJI-PinboGB-Flash")
style = replace_open(style, "presetSelect",
    '<select id="presetSelect">'
    '<option value="C:/Program Files/Adobe/.../打字机.ffx">打字机 · Text/Typewriter</option>'
    '<option value="">（不使用动画预设）</option>'
    '</select>')
style = set_inner(style, "presetHint", "共 300 个预设；匹配 11 个 · 已选：打字机")
style = set_inner(style, "subCheckOut",
    row("ok", "属性全部正常，渲染验证也通过 —— 字幕应该能看见") +
    row("bad", "有 1 个图层开了「独奏」—— 其余图层（含全部字幕）都会被隐藏"))

# ----------------------------------------------------------------- 设置

st = pages["set"]
# 候选 C：环境与诊断的动作行里；候选 D：about 之前新增一张卡片
# ⚠ 顺序要紧：先把候选插进去，再填 envDetail —— 否则锚点（空 div）已经被填掉了
st = insert_before(st, '<div id="envDetail" class="hint mono"></div>', CAND_C)
st = set_inner(st, "envDetail", "node v22.22.2 · ffmpeg 6.1 · 流水线 D:/.../pipeline")
st = insert_before(st, '<div class="about">', CAND_D)

# ----------------------------------------------------------------- 弹层与回报示意

DIALOG = """<div class="pvDialogWrap">
  <div class="overlay" style="position:static;background:transparent;padding:0">
    <div class="askBox" style="margin:0 auto">
      <div class="askTitle">清理插件产生的文件？</div>
      <div class="askBody">
        <div style="line-height:1.9">
          只会删除<b>本插件自己生成</b>的中间文件与缓存，<b>不影响你的工程和素材</b>：
        </div>
        <div class="pvList">
          <div><span>输出目录 / _中间音频</span><b>2.1 GB</b><i>12 个文件</i></div>
          <div><span>输出目录 / _人声分离</span><b>684 MB</b><i>6 个文件</i></div>
          <div><span>系统临时目录的插件文件</span><b>128 MB</b><i>23 个文件</i></div>
          <div><span>面板缓存（CEP / Chromium）</span><b>46 MB</b><i>8 个文件</i></div>
        </div>
        <div class="hint" style="margin-top:8px">
          合计 <b>49 个文件</b>，可释放约 <b>2.9 GB</b>。识别产物（.srt / .json）与分离出的人声默认保留。
        </div>
      </div>
      <div class="askBtns">
        <button class="primary small">确认清理</button>
        <button class="ghost small">取消</button>
      </div>
      <div class="hint">想连字幕产物一起删，可以在弹层里勾选「连识别产物一起删」。</div>
    </div>
  </div>
</div>"""

REPORT = """<div class="pvReport">
  <div class="pvReportCol">
    <div class="pvReportTitle">🚀 清理内存 · 完成回报</div>
    <div class="stateRow"><span class="dot ok"></span><span>已释放 <b>1.42 GB</b> 内存</span></div>
    <div class="stateRow"><span class="dot ok"></span><span>当前可用 <b>6.8 GB</b> / 15.9 GB（44%）</span></div>
    <div class="hint" style="margin-top:6px">
      做法：把各进程里"占着不用"的内存页还给系统（EmptSetSuperfetchInformation /
      EmptyWorkingSet）。<b>不结束任何进程、不关任何软件</b>，AE 与插件照常运行。
    </div>
  </div>
  <div class="pvReportCol">
    <div class="pvReportTitle">🗑 清理插件文件 · 完成回报</div>
    <div class="stateRow"><span class="dot ok"></span><span>删除 <b>49 个文件</b>，释放 <b>2.9 GB</b></span></div>
    <div class="stateRow"><span class="dot warn"></span><span>跳过 3 个正被占用的文件（下次清理时再试）</span></div>
    <div class="hint" style="margin-top:6px">
      日志会逐条列出删了什么、跳过了什么、以及每个位置释放了多少 —— 删错了也能从回收站找回来
      （全部走回收站，不走直接删除）。
    </div>
  </div>
</div>"""

# ----------------------------------------------------------------- 组装

PREVIEW_TITLE = "AE 自动字幕 · 面板全页预览（v0.7.0）· 选按钮落脚点用"

LEGEND = """<div class="pvLegend">
  <div class="pvLegendRow"><span class="pvCandTag">候选 A</span>
    <span>首页 · 两个导航按钮下方</span><i>小按钮条，最浅一层，不占卡片</i></div>
  <div class="pvLegendRow"><span class="pvCandTag">候选 B</span>
    <span>首页 · 底部（脚注上方）</span><i>独立「维护」卡片，最显眼</i></div>
  <div class="pvLegendRow"><span class="pvCandTag">候选 C</span>
    <span>设置页 · 环境与诊断 · 动作行内</span><i>与「重新检测环境 / 恢复默认 / 跑自检」并排</i></div>
  <div class="pvLegendRow"><span class="pvCandTag">候选 D</span>
    <span>设置页 · 环境与诊断 之后新增「维护」卡片</span><i>可写说明文字，最完整</i></div>
  <div class="pvLegendNote">
    虚线框里的按钮都是<b>示意</b>（点了不会有反应）。你只要告诉我用 A/B/C/D 哪个（或都要、或另指位置），
    我再动真面板。四个页面都是<b>真实面板的 HTML + CSS</b> 渲染出来的，示例数据是填的。
  </div>
</div>"""

EXTRA_CSS = """
/* ---------- 预览稿专属样式（不影响面板本身） ---------- */
body { background:#111; color:#d8d8d8; font-family:"Microsoft YaHei", -apple-system, sans-serif;
       padding:22px; margin:0; }
.pvWrap { max-width:1580px; margin:0 auto; }
.pvH1 { font-size:17px; margin:0 0 4px; color:#eaeaea; }
.pvSub { font-size:12px; color:#8b8b8b; margin-bottom:16px; }
.pvLegend { background:#1b1b1b; border:1px solid #303030; border-radius:10px; padding:12px 14px;
            margin-bottom:18px; }
.pvLegendRow { display:flex; align-items:center; gap:10px; font-size:12.5px; padding:3px 0; }
.pvLegendRow span:nth-child(2) { color:#cfcfcf; min-width:250px; }
.pvLegendRow i { color:#7e7e7e; font-style:normal; }
.pvLegendNote { font-size:12px; color:#9a9a9a; margin-top:8px; border-top:1px dashed #333;
                padding-top:8px; line-height:1.7; }
.pvGrid { display:flex; flex-wrap:wrap; gap:18px; align-items:flex-start; }
.pvFrame { background:#191919; border:1px solid #2e2e2e; border-radius:10px; padding:10px; }
.pvFrame.pvWide { flex:1 1 480px; }
.pvTitle { font-size:12px; color:#8ab4f8; margin:0 0 8px 2px; }
.pvTitle b { color:#cfe1ff; }
.pvPanel { width:460px; height:auto; overflow:visible; background:var(--bg);
           border-radius:8px; border:1px solid #2a2a2a; }
/* 真实面板是 460x720 可滚动；预览为了让你看全每一页（尤其是页面底部），按内容全展开 */
.pvPanel .page { display:block !important; }          /* 面板靠 JS 切页，这里全摊开 */
.pvCand { outline:2px dashed #7aa2f7; outline-offset:3px; border-radius:7px;
          padding:6px 6px 4px; margin:9px 0; position:relative; }
.pvCandTag { position:absolute; top:-9px; left:8px; font-size:10px; background:#7aa2f7; color:#10151f;
             padding:1px 7px; border-radius:9px; font-weight:700; letter-spacing:.5px; }
.pvDialogWrap { background:#101010; border-radius:8px; padding:16px; }
.pvList { margin:8px 0 2px; font-size:12.5px; }
.pvList > div { display:flex; align-items:baseline; gap:8px; padding:3px 0;
                border-bottom:1px dotted #333; }
.pvList > div span { flex:1 1 auto; color:#c6c6c6; }
.pvList > div b { color:#e8e8e8; min-width:64px; text-align:right; }
.pvList > div i { color:#7e7e7e; font-style:normal; min-width:70px; text-align:right; }
.pvReport { display:flex; gap:14px; flex-wrap:wrap; }
.pvReportCol { flex:1 1 320px; background:#191919; border:1px solid #2e2e2e; border-radius:10px;
               padding:12px 14px; }
.pvReportTitle { font-size:13px; color:#cfe1ff; margin-bottom:8px; }
"""

out = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    "<title>" + PREVIEW_TITLE + "</title>",
    "<style>",
    css,
    "</style>",
    "<style>",
    EXTRA_CSS,
    "</style>",
    "</head><body>",
    '<div class="pvWrap">',
    '<div class="pvH1">' + PREVIEW_TITLE + "</div>",
    '<div class="pvSub">四个页面都是真实面板 HTML + 真实 CSS 渲染；示例数据是填进去的，'
    "虚线框里的按钮只是示意。面板高度按内容展开（真实面板 460×720 可滚动），"
    "方便你看到每一页的底部。</div>",
    LEGEND,
    '<div class="pvGrid">',
    '<section class="pvFrame"><div class="pvTitle">① <b>首页</b> · 主操作页（含候选 A / B）</div>'
    '<div class="pvPanel">' + home + "</div></section>",
    '<section class="pvFrame"><div class="pvTitle">② <b>人声分离</b> · 独立菜单</div>'
    '<div class="pvPanel">' + uvr + "</div></section>",
    '<section class="pvFrame"><div class="pvTitle">③ <b>字幕样式</b> · 独立菜单</div>'
    '<div class="pvPanel">' + style + "</div></section>",
    '<section class="pvFrame"><div class="pvTitle">④ <b>设置</b> · 三组（含候选 C / D）</div>'
    '<div class="pvPanel">' + st + "</div></section>",
    "</div>",
    '<section class="pvFrame pvWide" style="margin-top:18px">'
    '<div class="pvTitle">🗑 <b>垃圾桶的二级确认界面</b>（草案 · 点按钮后先出这张）</div>'
    + DIALOG + "</section>",
    '<section class="pvFrame pvWide" style="margin-top:18px">'
    '<div class="pvTitle">🧾 <b>两个按钮的完成回报</b>（清理了多少 · 还剩多少）</div>'
    + REPORT + "</section>",
    "</div>",
    "</body></html>",
]

io.open(OUT, "w", encoding="utf-8").write("\n".join(out))
print("已写出：" + OUT)
print("  页面块大小：", {k: len(v) for k, v in pages.items()})
print("  成品大小：%.0f KB" % (os.path.getsize(OUT) / 1024))
