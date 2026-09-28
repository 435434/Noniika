# -*- coding: utf-8 -*-
"""隔离实测：一键安装.bat / 一键卸载.bat

真跑这两个 bat（不是假装跑），三重隔离：
  · 所有目标路径改到 %TEMP%\\aesub-battest 下
  · reg add / reg delete 替换成 echo 占位（不碰真实注册表）
  · 不读也不删任何真实目录

关于交互：非交互环境下 cmd 的 set /p 拿不到管道/重定向里的输入
（实测：管道与文件重定向都读不到，跨 chcp 与否都一样），
所以「用户敲了什么」这一层没法在这里真测 —— 改为把 set /p 注入成固定值，
专门验证「读到值之后的全部逻辑」；交互那一层另做静态断言。
顺带说明：读不到输入时的行为是「什么都不删」，失败方向是安全的。
"""
import io, os, shutil, subprocess, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.path.join(ROOT, "插件打包")
T = os.path.join(tempfile.gettempdir(), "aesub-battest")

pass_n, fail_n = 0, 0
results = []


def check(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        results.append("  OK    " + name)
    else:
        fail_n += 1
        results.append("  FAIL  " + name + ("   -> " + str(extra) if extra else ""))


def run(bat):
    r = subprocess.run(["cmd", "/c", bat], stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    return r.stdout.decode("utf-8", "replace")


def reset():
    shutil.rmtree(T, ignore_errors=True)
    os.makedirs(T, exist_ok=True)


def write(p, text, pad=0):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        if pad:
            f.write("x" * pad)


def build_plugin(root, bundle_id="com.aesub.autosubtitle", with_manifest=True):
    write(os.path.join(root, "index.html"), "<html>fake</html>", 120 * 1024)
    write(os.path.join(root, "js", "main.js"), "// fake", 60 * 1024)
    if with_manifest:
        write(os.path.join(root, "CSXS", "manifest.xml"),
              "<ExtensionBundleId>%s</ExtensionBundleId>" % bundle_id)


def build_data(root):
    write(os.path.join(root, "models", "Kim_Vocal_2.onnx"), "M", 300 * 1024)
    write(os.path.join(root, "python-env", "Scripts", "python.exe"), "P", 80 * 1024)


# ================================================================ 场景 1：安装
reset()
SRC_PLUGIN = os.path.join(T, "install", "com.aesub.autosubtitle")
build_plugin(SRC_PLUGIN)
EXT = os.path.join(T, "installext")

raw_install = io.open(os.path.join(PKG, "一键安装.bat"), encoding="utf-8").read()
test_install = raw_install.replace(
    'set "DEST=%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle"',
    'set "DEST={0}"'.format(os.path.join(EXT, "com.aesub.autosubtitle"))
).replace(
    'if not exist "%APPDATA%\\Adobe\\CEP\\extensions" mkdir "%APPDATA%\\Adobe\\CEP\\extensions"',
    'if not exist "{0}" mkdir "{0}"'.format(EXT)
).replace(
    'reg add "HKCU\\Software\\Adobe\\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1',
    'echo [测试] 跳过写注册表 CSXS.%%V'
)
bat_install = os.path.join(T, "install", "t_install.bat")
with io.open(bat_install, "w", encoding="utf-8", newline="\r\n") as f:
    f.write(test_install)

out = run(bat_install)
TGT = os.path.join(EXT, "com.aesub.autosubtitle")

check("安装：复制到目标目录成功", os.path.isfile(os.path.join(TGT, "index.html")),
      os.listdir(EXT) if os.path.isdir(EXT) else "目标目录都没建起来")
check("安装：连子目录一起复制（js / CSXS）",
      os.path.isfile(os.path.join(TGT, "js", "main.js")) and
      os.path.isfile(os.path.join(TGT, "CSXS", "manifest.xml")))
check("安装：输出中文没乱码（能读到「安装完成」）", "安装完成" in out)
check("安装：AE 检测给出了明确结论（检测到 / 没找到，二者必居其一）",
      ("已检测到 After Effects" in out) or ("没能在注册表里找到 After Effects" in out))
check("安装：真读到了本机 AE 路径（注册表 App Paths 命中）",
      ("已检测到 After Effects" in out) and ("AfterFX.exe" in out))
check("安装：打印了脚本权限提醒", "允许脚本写入文件和访问网络" in out)
check("安装：权限提醒给了菜单路径", ("脚本和表达式" in out) and ("首选项" in out))
check("安装：提示了重启 AE", "重启 After Effects" in out)
check("安装：没有出现失败字样", "[失败]" not in out, out[-300:])
check("安装：写注册表那步确实走到了（隔离占位出现）", "[测试] 跳过写注册表" in out)

# 覆盖安装：应走「替换旧版本」分支
write(os.path.join(TGT, "js", "old-stale.js"), "// 旧版本残留")
out2 = run(bat_install)
check("安装（重复执行）：识别出旧版本", "检测到已安装的旧版本" in out2)
check("安装（重复执行）：旧版本的程序目录被清掉",
      not os.path.exists(os.path.join(TGT, "js", "old-stale.js")))
check("安装（重复执行）：新文件仍在", os.path.isfile(os.path.join(TGT, "index.html")))


# ============================================================ 卸载脚本的构造
P_AE_ASK = 'set /p "ANS=  仍然继续吗？（输入 Y 继续，直接回车退出）："'
P_1 = 'set /p "ANS=  删除插件本体？（输入 Y 删除，直接回车跳过）："'
P_2 = 'set /p "ANS=  删除数据目录？（输入 Y 删除，直接回车跳过）："'
P_3 = 'set /p "ANS=  一并删掉这个开关吗？（输入 Y 删除，直接回车保留）："'

raw_un = io.open(os.path.join(PKG, "一键卸载.bat"), encoding="utf-8").read()

check("卸载：脚本里有 4 处交互提问（AE 警告 + 三步）",
      all(p in raw_un for p in (P_AE_ASK, P_1, P_2, P_3)),
      [p[-30:] for p in (P_AE_ASK, P_1, P_2, P_3) if p not in raw_un])
check("卸载：每一问都用 /i not ANS==Y 判定（大小写不敏感、非 Y 即跳过）",
      raw_un.count('if /i not "!ANS!"=="Y"') == 4, raw_un.count('if /i not "!ANS!"=="Y"'))
check("卸载：每句提问都写清了「输入 Y」与「直接回车」各自的后果",
      raw_un.count("输入 Y") >= 4 and raw_un.count("直接回车") >= 4,
      "输入Y=%d 回车=%d" % (raw_un.count("输入 Y"), raw_un.count("直接回车")))
check("卸载：插件目录删除前先核对 manifest.xml",
      raw_un.index("CSXS\\manifest.xml") < raw_un.index('rmdir /S /Q "%PLUGIN%"'))
check("卸载：删除插件目录前先核对 bundle id",
      'findstr /c:"com.aesub.autosubtitle"' in raw_un)
check("卸载：数据目录删除前先核对 models / python-env",
      ('"%DATA%\\models"' in raw_un) and ('"%DATA%\\python-env"' in raw_un))
check("卸载：全程用 rmdir /S /Q（不做通配符删除）",
      raw_un.count("rmdir /S /Q") == 2 and "*" not in raw_un.split(":dir_size")[0].replace("*.*", ""))
check("卸载：明确声明不删用户的字幕与人声作品",
      ("不会被删" in raw_un) and ("_人声分离" in raw_un))


def make_uninstall(tag, plugin, data, ans_ae="Y", ans1="", ans2="", ans3=""):
    a = 'set "PLUGIN=%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle"'
    b = ('set "DATA=%USERPROFILE%\\Documents\\AE自动字幕"\n'
         'if not exist "%DATA%" if exist "%USERPROFILE%\\OneDrive\\Documents\\AE自动字幕" '
         'set "DATA=%USERPROFILE%\\OneDrive\\Documents\\AE自动字幕"')
    s = raw_un.replace(a, 'set "PLUGIN={0}"'.format(plugin))
    s = s.replace(b, 'set "DATA={0}"'.format(data))
    s = s.replace('for %%V in (9 10 11 12) do reg delete '
                  '"HKCU\\Software\\Adobe\\CSXS.%%V" /v PlayerDebugMode /f >nul 2>&1',
                  'echo [测试] 跳过删注册表 CSXS.%%V')
    for old, val in ((P_AE_ASK, ans_ae), (P_1, ans1), (P_2, ans2), (P_3, ans3)):
        s = s.replace(old, 'set "ANS={0}"'.format(val))
    p = os.path.join(T, "t_un_%s.bat" % tag)
    with io.open(p, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(s)
    return p


# ============================================================ 场景 2：全部跳过
reset()
P1, D1 = os.path.join(T, "ext", "com.aesub.autosubtitle"), os.path.join(T, "data")
build_plugin(P1)
build_data(D1)
bat = make_uninstall("skipall", P1, D1, ans_ae="Y", ans1="", ans2="", ans3="")
out = run(bat)
check("卸载（全部跳过）：插件目录保留", os.path.isdir(P1))
check("卸载（全部跳过）：数据目录保留", os.path.isdir(D1))
check("卸载（全部跳过）：三个步骤的章节标题都打印了",
      all(k in out for k in ("第 1 步：插件本体", "第 2 步：数据目录", "第 3 步：CEP 调试模式开关")))
seg = out.split("占用：", 1)[1][:24] if "占用：" in out else ""
check("卸载：体积真的算出了数字（PowerShell 那条路走通了）",
      ("MB" in seg) or ("KB" in seg), seg)
check("卸载：体积没有退化成「未知」", "未知" not in seg, seg)
check("卸载（全部跳过）：没有删注册表", "[测试] 跳过删注册表" not in out)
check("卸载（全部跳过）：结尾交了底（作品文件没删）", "没有被删" in out)
check("卸载（全部跳过）：中文没乱码（能读到「卸载结束」）", "卸载结束" in out)
check("卸载（全部跳过）：没出现未完成字样", "[未完成]" not in out)

# ============================================================ 场景 3：全部确认
out = run(make_uninstall("allyes", P1, D1, ans_ae="Y", ans1="Y", ans2="Y", ans3="Y"))
check("卸载（全部确认）：插件目录已删除", not os.path.exists(P1), os.listdir(P1) if os.path.isdir(P1) else "")
check("卸载（全部确认）：数据目录已删除", not os.path.exists(D1))
check("卸载（全部确认）：注册表删除走到位（隔离占位出现）", "[测试] 跳过删注册表" in out)
check("卸载（全部确认）：报告了释放体积",
      ("已删除插件本体" in out) and ("已删除数据目录" in out))
check("卸载（全部确认）：没有残留目录",
      not os.path.exists(os.path.join(T, "ext")) or os.listdir(os.path.join(T, "ext")) == [])

# ==================================================== 场景 4：不是我们的插件
reset()
P2 = os.path.join(T, "notours")
build_plugin(P2, bundle_id="com.someone.else.extension")
out = run(make_uninstall("notours", P2, os.path.join(T, "nodata"), ans1="Y", ans2="Y"))
check("卸载（别人家的扩展）：拒绝删除", os.path.isdir(P2), "目录被误删了！")
check("卸载（别人家的扩展）：明确跳过并说明原因", ("[跳过]" in out) and ("ID 对不上" in out))
check("卸载（别人家的扩展）：不再追问删除", "删除插件本体？" not in out)
check("卸载（数据目录不存在）：提示没找到且不报错", "没找到数据目录" in out)

# ==================================================== 场景 5：缺 manifest.xml
reset()
P3 = os.path.join(T, "nomanifest")
build_plugin(P3, with_manifest=False)
out = run(make_uninstall("nomanifest", P3, os.path.join(T, "nodata"), ans1="Y", ans2="Y"))
check("卸载（目录里没有 manifest.xml）：拒绝删除", os.path.isdir(P3), "目录被误删了！")
check("卸载（目录里没有 manifest.xml）：说明原因", "没有本插件的特征文件" in out)

# ================================================ 场景 6：数据目录不是我们的
reset()
P4 = os.path.join(T, "ext", "com.aesub.autosubtitle")
D4 = os.path.join(T, "mydocs")
build_plugin(P4)
write(os.path.join(D4, "我的笔记.txt"), "手写的，别删")
write(os.path.join(D4, "素材", "a.mp4"), "video")
out = run(make_uninstall("fakedata", P4, D4, ans1="", ans2="Y", ans3=""))
check("卸载（数据目录里只有用户自己的文件）：拒绝删除", os.path.isdir(D4), "用户的目录被误删了！")
check("卸载（数据目录里只有用户自己的文件）：说明原因", "没有本插件的数据" in out)
check("卸载（数据目录里只有用户自己的文件）：用户文件完好",
      os.path.isfile(os.path.join(D4, "我的笔记.txt")) and
      os.path.isfile(os.path.join(D4, "素材", "a.mp4")))

# ============================================================ 场景 7：编码自检
enc = os.path.join(T, "t_enc.bat")
with io.open(enc, "w", encoding="utf-8", newline="\r\n") as f:
    f.write("@echo off\r\nchcp 65001 >nul\r\n"
            "echo 中文编码自检：允许脚本写入文件和访问网络\r\n")
out = run(enc)
check("bat 中文字符串在 chcp 65001 下能正确输出",
      "中文编码自检：允许脚本写入文件和访问网络" in out, repr(out[-120:]))

# ============================================================ 场景 8：zip 内容
import glob as _glob
_zips = sorted(_glob.glob(os.path.join(PKG, "Noniika-v*.zip")))
zp = _zips[-1] if _zips else os.path.join(PKG, "Noniika-v0.8.3.zip")
check("分发包里有 zip", bool(_zips), os.path.basename(zp))
with zipfile.ZipFile(zp) as z:
    names = z.namelist()
    zipped = {f: z.read(f) for f in ("一键安装.bat", "一键卸载.bat") if f in names}
check("zip 里有 一键安装.bat", "一键安装.bat" in names)
check("zip 里有 一键卸载.bat", "一键卸载.bat" in names)
check("zip 里有 安装说明.md", "安装说明.md" in names)
for f in ("一键安装.bat", "一键卸载.bat"):
    disk = open(os.path.join(PKG, f), "rb").read()      # 二进制读，避免换行被规范化
    check("%s 在 zip 里与磁盘上逐字节一致" % f, zipped.get(f) == disk)

md = io.open(os.path.join(PKG, "安装说明.md"), encoding="utf-8").read()
check("安装说明.md 写了脚本权限步骤", "允许脚本写入文件和访问网络" in md)
check("安装说明.md 的卸载章节指向卸载脚本", "一键卸载.bat" in md)
check("安装说明.md 的安装步骤改成了 4 步", "安装（4 步）" in md)
use = io.open(os.path.join(PKG, "com.aesub.autosubtitle", "使用说明.md"), encoding="utf-8").read()
check("插件目录里的使用说明.md 也写了权限步骤", "允许脚本写入文件和访问网络" in use)
check("插件目录里的使用说明.md 卸载指向脚本", "一键卸载.bat" in use)

# ============================================ 场景 9：分发包的 AE 侧已 jsxbin 化
JI = os.path.join(PKG, "com.aesub.autosubtitle", "jsx")
jfiles = sorted(os.listdir(JI)) if os.path.isdir(JI) else []
check("分发包 jsx/ 里没有明文 .jsx", not any(f.lower().endswith(".jsx") for f in jfiles), jfiles)
check("分发包 jsx/ 里有 ae-bridge.jsxbin", "ae-bridge.jsxbin" in jfiles)
_binp = os.path.join(JI, "ae-bridge.jsxbin")
if os.path.isfile(_binp):
    _head = io.open(_binp, encoding="utf-8", errors="replace").read(15)
    check("编译产物是真正的 jsxbin 格式（首行头 @JSXBIN@ES@）",
          _head.startswith("@JSXBIN@ES@"), repr(_head))
    _src = os.path.join(ROOT, "cep", "jsx", "ae-bridge.jsx")
    check("jsxbin 体积小于明文（说明确实被编码了）",
          os.path.getsize(_binp) < os.path.getsize(_src),
          "%.1f KB vs %.1f KB" % (os.path.getsize(_binp) / 1024, os.path.getsize(_src) / 1024))
_man = io.open(os.path.join(PKG, "com.aesub.autosubtitle", "CSXS", "manifest.xml"),
               encoding="utf-8").read()
check("分发包 manifest 的 ScriptPath 指向 .jsxbin",
      "<ScriptPath>./jsx/ae-bridge.jsxbin</ScriptPath>" in _man)
check("开发目录的明文 jsx 还在（打包不影响开发）",
      os.path.isfile(os.path.join(ROOT, "cep", "jsx", "ae-bridge.jsx")))
check("开发目录的 manifest 仍指向明文 .jsx（本地调试照旧）",
      "<ScriptPath>./jsx/ae-bridge.jsx</ScriptPath>" in
      io.open(os.path.join(ROOT, "cep", "CSXS", "manifest.xml"), encoding="utf-8").read())
check("面板 HTML/JS 仍是明文（CEF 要执行，编译不了 —— 如实保留）",
      os.path.isfile(os.path.join(PKG, "com.aesub.autosubtitle", "index.html")) and
      os.path.isfile(os.path.join(PKG, "com.aesub.autosubtitle", "js", "main.js")))
_z = None
with zipfile.ZipFile(zp) as z:
    _z = [n for n in z.namelist() if "/jsx/" in n]
check("zip 里 jsx/ 也只有 jsxbin", _z == ["com.aesub.autosubtitle/jsx/ae-bridge.jsxbin"], _z)

print("\n".join(results))
print("\n  通过 %d / %d" % (pass_n, pass_n + fail_n))
shutil.rmtree(T, ignore_errors=True)
print("ALLPASS|%d" % pass_n if fail_n == 0 else "FAILED|%d" % fail_n)
