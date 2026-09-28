# -*- coding: utf-8 -*-
"""全新 UI 渲染目检：经评审台 iframe 截真 460/360 宽（绕开无头 Chrome ~490px 最小视口宽）"""
import os, subprocess, shutil, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(R, "design", "新设计")
OUT = os.path.join(D, "shots")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROF = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "aesub-newshot")

os.makedirs(OUT, exist_ok=True)
shots = [
    ("01-首页-就绪-460.png",        "预览.html?w=460&page=home&state=ready",   1300, 960),
    ("02-首页-未配密钥-460.png",    "预览.html?w=460&page=home&state=nokey",   1300, 960),
    ("03-首页-跑任务-460.png",      "预览.html?w=460&page=home&state=running", 1300, 960),
    ("04-首页-已出结果-460.png",    "预览.html?w=460&page=home&state=done",    1300, 1150),
    ("05-人声分离-460.png",         "预览.html?w=460&page=uvr&state=ready",    1300, 1150),
    ("06-字幕样式-460.png",         "预览.html?w=460&page=style&state=ready",  1300, 1300),
    ("07-设置-460.png",             "预览.html?w=460&page=set&state=ready",    1300, 1500),
    ("08-弹窗-清理确认-460.png",    "预览.html?w=460&page=home&dlg=cfm",       1300, 960),
    ("09-弹窗-落轨询问-460.png",    "预览.html?w=460&page=home&dlg=ask",       1300, 960),
    ("10-首页-360最小宽.png",       "预览.html?w=360&page=home&state=ready",   1300, 980),
    ("11-样式-360最小宽.png",       "预览.html?w=360&page=style&state=ready",  1300, 1300),
    ("12-设置-360最小宽.png",       "预览.html?w=360&page=set&state=ready",    1300, 1500),
]
ok = 0
for name, src, w, h in shots:
    dst = os.path.join(OUT, name)
    url = "file:///" + os.path.join(D, src).replace("\\", "/")
    args = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
            "--hide-scrollbars", "--user-data-dir=" + PROF,
            "--force-device-scale-factor=1.5",
            "--window-size=%d,%d" % (w, h),
            "--screenshot=" + dst, "--virtual-time-budget=3000", url]
    try:
        r = subprocess.run(args, capture_output=True, timeout=120)
        if os.path.exists(dst) and os.path.getsize(dst) > 3000:
            print("  OK  %-26s %7.1f KB" % (name, os.path.getsize(dst) / 1024))
            ok += 1
        else:
            print("  **失败 %-24s rc=%d" % (name, r.returncode))
    except Exception as e:
        print("  **异常 %-24s %s" % (name, str(e)[:90]))
shutil.rmtree(PROF, ignore_errors=True)
print("\n完成 %d / %d" % (ok, len(shots)))
sys.exit(0 if ok == len(shots) else 1)
