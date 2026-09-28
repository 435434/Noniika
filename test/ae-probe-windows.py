"""列出 AfterFX.exe 的所有顶层窗口（类名 + 标题 + 是否可见）。

用来判断 AE 是否卡在模态对话框上：
标准 Win32 对话框的窗口类名是 #32770。如果列表里出现它，
就说明 AE 在等人工点击，脚本自然不会执行。
"""
import ctypes
import ctypes.wintypes as w
import subprocess
import sys

user32 = ctypes.windll.user32

# --- 找 AfterFX.exe 的 PID ---
# 注意：中文 Windows 上 tasklist 输出是 GBK，用 text=True 默认按 UTF-8 解码会抛
# UnicodeDecodeError（踩过），所以这里显式指定 encoding + errors="replace"。
pids = set()
try:
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"],
        capture_output=True, encoding="gbk", errors="replace", timeout=15,
    ).stdout or ""
    for line in out.splitlines():
        line = line.strip()
        if not line or not line.startswith('"'):
            continue
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower().startswith("afterfx"):
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
except Exception as exc:  # noqa: BLE001
    print("tasklist 调用失败:", exc)

if not pids:
    print("AfterFX.exe: 没有进程")
    sys.exit(0)

print("AfterFX PID:", sorted(pids))

# --- 枚举顶层窗口 ---
EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
user32.EnumWindows.argtypes = [EnumProc, w.LPARAM]
user32.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [w.HWND]
user32.IsWindowVisible.argtypes = [w.HWND]

found = []


def callback(hwnd, _lparam):
    pid = w.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value in pids:
        cls_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls_buf, 256)
        length = user32.GetWindowTextLengthW(hwnd)
        title_buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title_buf, length + 1)
        found.append((cls_buf.value, title_buf.value, bool(user32.IsWindowVisible(hwnd))))
    return True


user32.EnumWindows(EnumProc(callback), 0)

if not found:
    print("  （没有枚举到窗口）")
for cls, title, visible in found:
    print(f"  可见={visible}  类={cls!r}  标题={title!r}")

dialogs = [f for f in found if f[0] == "#32770"]
if dialogs:
    print("  => 发现对话框窗口！AE 正卡在等人工点击，脚本不会执行。")
    print("     对话框标题:", [d[1] for d in dialogs])
else:
    print("  => 没有 #32770 对话框窗口")
