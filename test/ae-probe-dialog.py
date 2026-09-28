"""深入读取 AfterFX.exe 的对话框内容：把 #32770 窗口的子控件（按钮、文字）全列出来。

这样不用截图也能知道：
  - 这是"脚本进度"对话框还是"运行脚本前警告"对话框
  - 它给了哪些按钮（确定 / 停止 / 是 / 否）
"""
import ctypes
import ctypes.wintypes as w
import subprocess
import sys

user32 = ctypes.windll.user32

# --- 找 PID（tasklist 输出是本地代码页，不能按 UTF-8 解）---
pids = set()
try:
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"],
        capture_output=True, timeout=20,
    ).stdout.decode("mbcs", errors="replace")
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith('"'):
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
    print("AfterFX.exe: 没有进程（AE 已关闭）")
    sys.exit(0)

print("AfterFX PID:", sorted(pids))

# --- 工具函数 ---
def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetClassNameW(hwnd, buf, 512)
    return buf.value


def window_text(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
user32.EnumWindows.argtypes = [EnumProc, w.LPARAM]
user32.EnumChildWindows.argtypes = [w.HWND, EnumProc, w.LPARAM]

# --- 收集顶层窗口 ---
tops = []


def on_top(hwnd, _lp):
    pid = w.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value in pids and user32.IsWindowVisible(hwnd):
        tops.append(hwnd)
    return True


user32.EnumWindows(EnumProc(on_top), 0)

dialogs = [h for h in tops if class_name(h) == "#32770"]
print(f"可见顶层窗口 {len(tops)} 个，其中 #32770 对话框 {len(dialogs)} 个")

if not dialogs:
    print("=> 当前没有可见的对话框")
    sys.exit(0)

for idx, dlg in enumerate(dialogs):
    print(f"\n--- 对话框 [{idx}] 标题 = {window_text(dlg)!r} ---")
    children = []

    def on_child(hwnd, _lp):
        children.append((class_name(hwnd), window_text(hwnd)))
        return True

    user32.EnumChildWindows(dlg, EnumProc(on_child), 0)
    if not children:
        print("   （没有子控件）")
    for cls, txt in children:
        if txt.strip() or cls.lower() == "button":
            print(f"   控件 类={cls!r}  文字={txt!r}")
