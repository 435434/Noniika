# -*- coding: utf-8 -*-
"""v2 目检截图：无头 Chrome 按真实 CSS 渲染各页面/状态/宽度"""
import os, subprocess, shutil, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(R, "design", "新UI设计_v2")
OUT = os.path.join(D, "shots")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROF = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "aesub-v2shot")

os.makedirs(OUT, exist_ok=True)

shots = [
    ("01-首页-就绪-460.png",       "index.html?page=home&state=ready",  480, 940),
    ("02-首页-跑任务-460.png",     "index.html?page=home&state=running",480, 940),
    ("03-首页-已出结果-460.png",   "index.html?page=home&state=done",   480, 1100),
    ("04-首页-未配密钥-460.png",   "index.html?page=home&state=nokey",  480, 940),
    ("05-人声分离-460.png",        "index.html?page=uvr&state=ready",   480, 1080),
    ("06-字幕样式-预览框-460.png", "index.html?page=style&state=ready", 480, 1180),
    ("07-设置-460.png",            "index.html?page=set&state=ready",   480, 1500),
    ("08-弹窗-清理确认.png",       "index.html?page=home&dlg=cfm",      480, 900),
    ("09-首页-就绪-360最小宽.png", "index.html?page=home&state=ready",  372, 800),
    ("10-样式-360最小宽.png",      "index.html?page=style&state=ready", 372, 1100),
]

ok = 0
for name, src, w, h in shots:
    dst = os.path.join(OUT, name)
    url = "file:///" + os.path.join(D, src).replace("\\", "/")
    args = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
            "--hide-scrollbars", "--user-data-dir=" + PROF,
            "--force-device-scale-factor=2",
            "--window-size=%d,%d" % (w, h),
            "--screenshot=" + dst, "--virtual-time-budget=2500", url]
    try:
        r = subprocess.run(args, capture_output=True, timeout=120)
        if os.path.exists(dst) and os.path.getsize(dst) > 3000:
            print("  OK  %-30s %6.1f KB" % (name, os.path.getsize(dst) / 1024))
            ok += 1
        else:
            print("  **小/缺  %-26s rc=%d" % (name, r.returncode))
    except Exception as e:
        print("  **异常  %-26s %s" % (name, str(e)[:100]))

shutil.rmtree(PROF, ignore_errors=True)
print("\n完成 %d / %d" % (ok, len(shots)))
sys.exit(0 if ok == len(shots) else 1)
