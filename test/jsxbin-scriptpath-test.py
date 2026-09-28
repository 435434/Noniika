# -*- coding: utf-8 -*-
"""验证：分发包的 AE 扩展能不能正常加载（重点是 manifest 指向 .jsxbin 这条路）

为什么需要这个测试：
  面板 HTML/JS 跑在 CEF 里没法编译，但 AE 侧的 ExtendScript 可以走 Adobe 自家的
  .jsxbin 格式。于是分发包的 manifest 里 ScriptPath 指向的是 ae-bridge.jsxbin。
  「CEP 到底认不认 .jsxbin 作为 ScriptPath」这件事没法靠看代码确认 —— 必须真跑。

做法（全程不碰用户在用的 com.aesub.autosubtitle）：
  1. 从 插件打包/ 的产物复制一份，改成测试 bundle id 与菜单名，装进 CEP 扩展目录
  2. 启动 AE，用 app.findMenuCommandId + app.executeCommand **自动打开那个面板**
     （面板一打开，CEP 才会加载 ScriptPath）
  3. 检查桥接层的几个全局函数是否真的被注入
  4. 无论成败都删掉测试扩展；若 AE 是本次启动的，跑完把它关掉

结论三种：
  PASS    —— 面板打开成功且桥接层已注入（.jsxbin 这条路通）
  FAIL    —— 面板打开了但函数没注入（.jsxbin 没被 CEP 加载，得回退明文 jsx）
  INVALID —— 菜单项都没找到，面板没打开，什么都没证明（别当成功）

用法：python test/jsxbin-scriptpath-test.py
注意：会启动 After Effects（约 2 分钟）并自动开关一个测试面板，仅影响 CEP 扩展目录。
"""
import io, json, os, re, shutil, subprocess, sys, time, winreg

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PKG = os.path.join(ROOT, "插件打包", "com.aesub.autosubtitle")
TESTID = "com.aesub.jsxbtest"
MENU = "JsxbinTest"
EXTDIR = os.path.join(os.environ["APPDATA"], "Adobe", "CEP", "extensions")
DEST = os.path.join(EXTDIR, TESTID)
W = os.path.join(ROOT, "test", "output", "_jsxbin")
PROBE = os.path.join(W, "probe-scriptpath.jsx")
RESULT = os.path.join(W, "probe-result.json")
PROGRESS = os.path.join(W, "probe-progress.txt")

passes, fails = [], []


def ok(name, cond, extra=""):
    (passes if cond else fails).append(name)
    print("   %s %s%s" % ("OK  " if cond else "FAIL", name, ("   -> " + str(extra)) if extra else ""))


def find_ae():
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe") as k:
            return winreg.QueryValueEx(k, "")[0]
    except OSError:
        return None


def ae_running():
    r = subprocess.run(["tasklist", "/fi", "imagename eq AfterFX.exe"],
                       capture_output=True, text=True, timeout=60,
                       encoding="utf-8", errors="replace")
    return "AfterFX.exe" in (r.stdout or "")


AE = find_ae()
started_by_us = False
try:
    print("=== 0. 前置检查 ===")
    if not AE or not os.path.exists(AE):
        print("   没找到 After Effects（注册表 App Paths），跳过本项验证")
        sys.exit(0)
    print("   AE:", AE)
    if not os.path.isdir(PKG):
        print("   没有分发包产物（%s），先跑 python tools/build-package.py" % PKG)
        sys.exit(0)
    if ae_running():
        print("   **AE 正在运行**：本测试需要独占启动 AE 才能观察面板加载。")
        print("   请先关闭 After Effects 再跑本测试。")
        sys.exit(0)

    os.makedirs(W, exist_ok=True)

    # ---------- 1. 造测试扩展 ----------
    for p in (RESULT, PROGRESS):
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(DEST, ignore_errors=True)
    shutil.copytree(PKG, DEST)

    mf_path = os.path.join(DEST, "CSXS", "manifest.xml")
    mf = io.open(mf_path, encoding="utf-8").read()
    mf = mf.replace("com.aesub.autosubtitle", TESTID)
    mf = re.sub(r"<Menu>[^<]*</Menu>", "<Menu>%s</Menu>" % MENU, mf)
    mf = re.sub(r"<Name>[^<]*</Name>", "<Name>%s</Name>" % MENU, mf)
    io.open(mf_path, "w", encoding="utf-8", newline="").write(mf)

    sp = re.search(r"<ScriptPath>([^<]+)</ScriptPath>", mf)
    sp_val = sp.group(1) if sp else ""
    print("\n=== 1. 测试扩展已就位（独立 ID，不动你自己的面板）===")
    print("   ScriptPath:", sp_val)
    print("   jsx 目录:", sorted(os.listdir(os.path.join(DEST, "jsx"))))

    # ---------- 2. 探针 ----------
    io.open(PROBE, "w", encoding="utf-8").write(u'''var OUT = "%s";
var PROG = "%s";
function mark(s, append) {
  try {
    var f = new File(PROG); f.encoding = "UTF-8";
    if (f.open(append ? "a" : "w")) {
      f.write(new Date().toLocaleTimeString() + "  " + s + "\\n"); f.close(); return true;
    }
  } catch (e) { }
  return false;
}
mark("0 entered", false);
var out = { steps: [], ok: false };
function step(s) { out.steps.push(s); mark(s, true); }

try {
  step("1 aeReady version=" + app.version);
  var id = app.findMenuCommandId("%s");
  out.menuId = id;
  step("2 findMenuCommandId -> " + id);
  if (id > 0) {
    app.executeCommand(id);
    step("3 executeCommand done（面板已开，CEP 该去加载 ScriptPath 了）");
  } else {
    step("3 **菜单项没找到 —— 面板没打开，本次验证无效**");
  }
  $.sleep(6000);
  step("4 slept 6s");

  var names = ["AESub_getTimelineSelection", "AESub_createSubtitleLayers",
               "AESub_placeSeparatedAudio", "AESub_searchFonts", "AESub_selfTest"];
  out.fns = {};
  var hit = 0;
  for (var i = 0; i < names.length; i++) {
    var t = eval("typeof " + names[i]);
    out.fns[names[i]] = t;
    if (t === "function") hit++;
    step("5 " + names[i] + " -> " + t);
  }
  out.hitCount = hit;
  out.ok = (id > 0) && (hit > 0);
  out.verdict = (id > 0)
    ? (hit > 0 ? "PASS" : "FAIL：面板打开了，但桥接层没注入（.jsxbin 没被 CEP 加载）")
    : "INVALID：菜单项没找到，面板没打开，什么都没证明";
  step("6 verdict=" + out.verdict);
} catch (e) {
  out.err = e.message + " @" + e.line;
  step("E exception: " + out.err);
}

try {
  var f2 = new File(OUT); f2.encoding = "UTF-8";
  if (f2.open("w")) { f2.write(JSON.stringify(out)); f2.close(); }
} catch (e2) { }
''' % (RESULT.replace("\\", "/"), PROGRESS.replace("\\", "/"), MENU))

    print("\n=== 2. 启动 AE 跑探针（冷启动可能要 2 分钟）===")
    t0 = time.time()
    subprocess.Popen([AE, "-r", PROBE], creationflags=0x8 | 0x200, close_fds=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started_by_us = True
    for i in range(100):                       # 最多 200 秒
        time.sleep(2)
        if os.path.exists(RESULT):
            break
    print("   用时 %.0f 秒" % (time.time() - t0))

    if os.path.exists(PROGRESS):
        print("   --- 进度 ---")
        for line in io.open(PROGRESS, encoding="utf-8", errors="replace").read().splitlines():
            print("     " + line[:150])

    res = None
    if os.path.exists(RESULT):
        try:
            res = json.loads(io.open(RESULT, encoding="utf-8", errors="replace").read())
        except Exception as e:
            print("   结果文件解析失败:", str(e)[:120])

    print("\n=== 3. 判定 ===")
    ok("探针脚本真的执行了", os.path.exists(PROGRESS))
    if res:
        ok("找到并打开了测试面板（菜单 id > 0）", res.get("menuId", 0) > 0,
           "menuId=%s" % res.get("menuId"))
        ok("桥接层有函数被注入", res.get("hitCount", 0) > 0,
           "%s/5" % res.get("hitCount"))
        ok("结论为 PASS", res.get("verdict") == "PASS", res.get("verdict"))
        for k, v in (res.get("fns") or {}).items():
            ok("  %s" % k, v == "function", v)
    else:
        ok("结果文件产出并可解析", False, "超时或空文件 —— 可能弹了对话框卡住")
finally:
    print("\n=== 4. 清理 ===")
    shutil.rmtree(DEST, ignore_errors=True)
    print("   测试扩展已移除:", not os.path.isdir(DEST))
    if started_by_us and ae_running():
        print("   本次启动的 AE 还在跑（可能停在面板上），结束它")
        subprocess.run(["taskkill", "/F", "/IM", "AfterFX.exe"], capture_output=True, timeout=60)
        print("   结束后还在运行吗:", ae_running())

print("\n  通过 %d · 失败 %d" % (len(passes), len(fails)))
print("ALLPASS|%d" % len(passes) if not fails else "FAILED|%d" % len(fails))
sys.exit(1 if fails else 0)
