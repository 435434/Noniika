# -*- coding: utf-8 -*-
"""用 Kimi v2 渲染图合成宣传图（pymupdf 贴图+排版，无新依赖）"""
import fitz, os, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(R, "design", "新UI设计_v2", "shots")
OUT = os.path.join(R, "design", "宣传图")
os.makedirs(OUT, exist_ok=True)

F_SYM = r"C:\Windows\Fonts\seguisym.ttf"
F_CN = r"C:\Windows\Fonts\msyh.ttc"
F_CN_B = r"C:\Windows\Fonts\msyhbd.ttc"
F_MONO = r"C:\Windows\Fonts\consola.ttf"

def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) / 255 for i in (0, 2, 4))

def put_text(page, x, y, text, size, color, font="cn", fontfile=None):
    page.insert_font(fontname=font, fontfile=fontfile or
                     {"cn": F_CN, "cnb": F_CN_B, "sym": F_SYM, "mono": F_MONO}[font])
    page.insert_text((x, y), text, fontname=font, fontsize=size, color=rgb(color))

# ============================================================
# 主图 1920×1080：左文案 + 右面板（首页·就绪）
# ============================================================
doc = fitz.open()
page = doc.new_page(width=1920, height=1080)
page.draw_rect(fitz.Rect(0, 0, 1920, 1080), fill=rgb("#141414"), color=None)
page.draw_rect(fitz.Rect(0, 0, 1920, 5), fill=rgb("#2e5c9a"), color=None)

# 右侧面板：就绪态（2x 渲染图 960×1880 → 高 940 等比）
panel = os.path.join(SHOTS, "01-首页-就绪-460.png")
pw, ph = 470, 940
px, py = 1330, 70
page.draw_rect(fitz.Rect(px + 10, py + 14, px + pw + 10, py + ph + 14),
               fill=rgb("#0b0b0b"), color=None)          # 影
page.insert_image(fitz.Rect(px, py, px + pw, py + ph), filename=panel)
page.draw_rect(fitz.Rect(px, py, px + pw, py + ph), color=rgb("#3a3a3a"), width=1)

# 左侧文案
put_text(page, 110, 210, "𝙉𝙤𝙣𝙞𝙞𝙠𝙖", 96, "#f2f2f2", font="sym")
put_text(page, 114, 300, "After Effects 一键自动字幕", 44, "#eaeaea", font="cnb")
put_text(page, 116, 356, "选中素材，点一下 —— 字幕图层自动建好、自动对齐时间轴", 24, "#9c9c9c")

feats = [
    "本地人声分离 —— 音频不出你的电脑",
    "免费识别引擎 · 自动标出\"档位默认\"模型",
    "带 BGM 的素材也能用：先分离再识别，准确率明显提升",
    "字幕样式实时预览 · 字体拼音搜索 · 一键体检排障",
]
y = 440
for line in feats:
    page.draw_circle((124, y - 8), 4.5, fill=rgb("#7ddba3"), color=None)
    put_text(page, 146, y, line, 26, "#c9c9c9")
    y += 64

put_text(page, 116, 760, "免费 · 深色面板 · 上传前明确提示，拒绝机密内容", 22, "#6f6f6f")
put_text(page, 116, 990, "v0.9.1 · Windows · AE 2019+ · 无需付费 API", 22, "#6f6f6f")

out1 = os.path.join(OUT, "宣传图-主图.png")
doc[0].get_pixmap().save(out1)
doc.close()
print("  主图:", os.path.getsize(out1) // 1024, "KB")

# ============================================================
# 三联 1920×1000：就绪 / 样式预览 / 已出结果
# ============================================================
doc = fitz.open()
page = doc.new_page(width=1920, height=1000)
page.draw_rect(fitz.Rect(0, 0, 1920, 1000), fill=rgb("#121212"), color=None)

put_text(page, 110, 80, "三步出字幕：选素材 → 点生成 → 看结果", 38, "#eaeaea", font="cnb")

trio = [
    ("01-首页-就绪-460.png",        "① 开工前检查：能不能点，一眼可判"),
    ("06-字幕样式-预览框-460.png",   "② 字幕样式：改完立刻看见"),
    ("03-首页-已出结果-460.png",     "③ 结果统计 + 字幕文件一键打开"),
]
ph = 780
pw = round(ph * 960 / 1880)            # 2x 渲染图 960×1880 等比
x = 110
for name, cap in trio:
    p = os.path.join(SHOTS, name)
    page.draw_rect(fitz.Rect(x + 8, 118 + 12, x + 8 + pw, 118 + ph + 12),
                   fill=rgb("#0b0b0b"), color=None)
    page.insert_image(fitz.Rect(x, 118, x + pw, 118 + ph), filename=p)
    page.draw_rect(fitz.Rect(x, 118, x + pw, 118 + ph), color=rgb("#3a3a3a"), width=1)
    put_text(page, x, 118 + ph + 46, cap, 24, "#c9c9c9")
    x += pw + 60

out2 = os.path.join(OUT, "宣传图-三联.png")
doc[0].get_pixmap().save(out2)
doc.close()
print("  三联:", os.path.getsize(out2) // 1024, "KB")
print("done →", OUT)
