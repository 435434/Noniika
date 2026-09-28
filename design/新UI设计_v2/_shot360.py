# -*- coding: utf-8 -*-
"""通过评审台 iframe 截真 360/460 宽"""
import os, subprocess, shutil, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(R, "design", "新UI设计_v2")
OUT = os.path.join(D, "shots")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROF = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "aesub-v2shot2")

os.makedirs(OUT, exist_ok=True)
shots = [
    ("09-首页-就绪-360最小宽.png", "预览.html?w=360&page=home&state=ready", 1300, 980),
    ("10-样式-360最小宽.png",      "预览.html?w=360&page=style&state=ready", 1300, 1350),
    ("11-设置-360最小宽.png",      "预览.html?w=360&page=set&state=ready", 1300, 1500),
    ("12-首页-就绪-460真宽.png",   "预览.html?w=460&page=home&state=ready", 1300, 980),
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
            print("  OK  %-28s %7.1f KB" % (name, os.path.getsize(dst) / 1024))
            ok += 1
        else:
            print("  **失败 %-26s rc=%d" % (name, r.returncode))
    except Exception as e:
        print("  **异常 %-26s %s" % (name, str(e)[:90]))
shutil.rmtree(PROF, ignore_errors=True)
print("\n完成 %d / %d" % (ok, len(shots)))
sys.exit(0 if ok == len(shots) else 1)
