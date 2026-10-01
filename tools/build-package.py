"""
打包分发包（重新生成 插件打包/ 里的分发包）

用法： python tools/build-package.py

原始说明：
==========================================================
产出：<项目>/插件打包/
  ├── 安装说明.md
  ├── 一键安装.bat               ← 装前查 AE 是否装了（只提示），装完提示脚本权限那项必做设置
  ├── 一键卸载.bat               ← 三步各自确认：插件本体 / 数据目录 / 注册表开关
  ├── com.aesub.autosubtitle/     ← 插件本体（含 pipeline 与自带 Node；AE 侧是 .jsxbin）
  └── Noniika-v0.9.0.zip       ← 便于分发的压缩包

精简策略（功能一个不少）：
  · AE 侧桥接层编译成 .jsxbin（Adobe 自家的二进制/混淆格式），明文 jsx 不进包
    —— 只编译 ExtendScript；面板 HTML/JS 跑在 CEF 里必须可执行，无从编译
  · **不带 node_modules** —— pipeline 零运行时 npm 依赖（识别走纯 HTTP 适配器），
    带上它只会把 GPL 组件一起分发出去。合规与体积两头受益，详见 THIRD-PARTY-NOTICES.md
  · **带随包 ffmpeg（LGPL 构建）+ 许可全文** —— 打包前会校验它不含 --enable-gpl
  · 带 LICENSE 与 THIRD-PARTY-NOTICES.md —— 再分发必须保留
  · 不带 ffprobe（77 MB）—— 已改成用 ffmpeg 自己解析媒体信息，两条路结果已逐字段比对一致
  · 不带 python-env（6.9 GB）/ models（934 MB）—— 用户机器上按需生成；
    **模型权重授权不明确，不要预打包**
  · 不带 test / design / .workbuddy —— 开发用物料
  · 自带 node.exe（83 MB）+ **Node.js 许可全文**（MIT 要求随副本附版权与许可声明；
    该文件同时覆盖 node.exe 内嵌的 V8/OpenSSL/ICU/zlib/libuv 等组件）
  · **出厂自检**：打包前逐文件核对"没有素材/模型/字体、没有开发物料、没有密钥字面量、
    许可文件齐全"。任一不合格就删掉产物、拒绝出厂 —— 这几类问题都不会自己报错，
    只能靠机器拦（详见文件末"6b. 出厂自检"）。
  · **绝不带上**：你的 API 密钥、测试素材（视频/音频）。它们不在白名单里，
    且自检会再确认一次。

jsxbin 编译依赖：tools/jsxbin-tool/（npm install jsxbin --prefix tools/jsxbin-tool）
  找不到编译器时会打警告并退回明文 jsx，不会静默产出坏包。
"""
import io, json, os, re, shutil, subprocess, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "插件打包")
PLUGIN_NAME = "com.aesub.autosubtitle"
PKG = os.path.join(OUT, PLUGIN_NAME)
VERSION = "0.9.2"
NODE_EXE = os.environ.get("AESUB_NODE") or shutil.which("node") or "node"

def mb(n): return "%.1f MB" % (n / 1048576.0)

def size_of(p):
    if os.path.isfile(p): return os.path.getsize(p)
    t = 0
    for dp, dn, fn in os.walk(p):
        for f in fn:
            try: t += os.path.getsize(os.path.join(dp, f))
            except OSError: pass
    return t

log = []
def say(s):
    log.append(s)
    print(s)

# 出厂自检收集"该有却没有 / 不该有却有"的问题项（见文件末的"9. 出厂自检"）。
# 用清单而不是"撞到第一个就退出"：一次性把问题全列出来，省得来回试。
_MISSING = []

# ---------- 0. 清空输出目录 ----------
if os.path.isdir(OUT):
    for name in os.listdir(OUT):
        p = os.path.join(OUT, name)
        if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
        else: os.remove(p)
else:
    os.makedirs(OUT, exist_ok=True)
say("  清空输出目录")

# ---------- 1. 面板本体 ----------
# ⚠ 这是**白名单**：漏加一项，那一项在别人机器上就不存在。
#   support.html 与 assets/ 是「支持作者」页（面板 header 的 ♥ 按钮打开的就是它），
#   漏掉的症状很隐蔽 —— 面板会走兜底分支直接开爱发电，看起来"能用"，
#   实际是把插件自带的页面丢了（本项目真踩过：本地有、发出去的包里没有）。
os.makedirs(PKG, exist_ok=True)
for name in ["index.html", "support.html", "assets", "css", "js", "jsx", "CSXS"]:
    src = os.path.join(ROOT, "cep", name)
    dst = os.path.join(PKG, name)
    if os.path.isdir(src): shutil.copytree(src, dst)
    else: shutil.copyfile(src, dst)
say("  复制面板本体（cep/*）")

# ---------- 1a. 剥掉"编辑器回写"的注入属性（防呆，别删）----------
# 现象：用编辑器的可视化预览打开过 HTML 后，它会给标签回写 data-page-node-id="…"
#       （本项目实测：连 <html> / <head> / <meta> 都被加，37 处，+1591 字节）。
# 危害：**不报错、不失效**，只是文件悄悄变脏 —— 不查就跟着分发包一起发出去。
# 处理：在**包内副本**上剥除（源文件保持编辑器原样，避免两边来回打架），
#       并在源文件脏了的时候打警告，提醒顺手清一下。
import re as _re
_INJECT_RE = _re.compile(r'\s+data-page-node-id="[^"]*"')
for _dp, _dn, _fn in os.walk(PKG):
    for _f in _fn:
        if not _f.lower().endswith((".html", ".htm")):
            continue
        _full = os.path.join(_dp, _f)
        _txt = io.open(_full, encoding="utf-8", errors="replace").read()
        if "data-page-node-id" not in _txt:
            continue
        _clean = _INJECT_RE.sub("", _txt)
        io.open(_full, "w", encoding="utf-8", newline="").write(_clean)
        say("  · 包内 %s：剥掉 %d 处编辑器注入属性（源文件里也有，建议清理）"
            % (_f, _txt.count("data-page-node-id")))

# ---------- 1b. ExtendScript 桥接层编译成 .jsxbin（只进分发包，开发目录不动）----------
# 为什么只编译 AE 侧：面板 HTML/JS 跑在 CEF 里，必须可执行 ⇒ 编译/加密无从谈起；
# 而 .jsx 是交给 ExtendScript 引擎的，可以走 Adobe 自家的 jsxbin 格式。
# 注意：这是**混淆**不是加密（官方文档明说"第三方反编译器可还原源码，变量名会乱"），
# 目的是提高随手翻代码的门槛；真实的功能完整性已用 AE 端到端实测比对过（逐字段一致）。
JSX_SRC = os.path.join(ROOT, "cep", "jsx", "ae-bridge.jsx")
JSX_SRC_IN_PKG = os.path.join(PKG, "jsx", "ae-bridge.jsx")
JSX_BIN_IN_PKG = os.path.join(PKG, "jsx", "ae-bridge.jsxbin")
JSXBIN_PKG = os.path.join(ROOT, "tools", "jsxbin-tool", "node_modules", "jsxbin")
MANIFEST = os.path.join(PKG, "CSXS", "manifest.xml")

if os.path.isdir(JSXBIN_PKG):
    helper = os.path.join(tempfile.gettempdir(), "aesub_mkjsxbin.js")
    io.open(helper, "w", encoding="utf-8").write(
        "const j = require(%s);\n"
        "j(%s, %s).then(function () { process.exit(0); })\n"
        "  .catch(function (e) { console.error(String(e)); process.exit(1); });\n"
        % (json.dumps(JSXBIN_PKG), json.dumps(JSX_SRC), json.dumps(JSX_BIN_IN_PKG)))
    r = subprocess.run([NODE_EXE, helper], capture_output=True, text=True, timeout=300,
                       encoding="utf-8", errors="replace")
    os.remove(helper)
    if r.returncode != 0 or not os.path.exists(JSX_BIN_IN_PKG):
        raise SystemExit("  [失败] jsxbin 编译没成功：%s" % ((r.stderr or r.stdout or "")[:400]))

    head = io.open(JSX_BIN_IN_PKG, encoding="utf-8", errors="replace").read(15)
    if not head.startswith("@JSXBIN@ES@"):
        raise SystemExit("  [失败] 编译产物不是 jsxbin 格式（首行头异常：%r）" % head)

    # 明文 jsx 不进分发包
    if os.path.exists(JSX_SRC_IN_PKG):
        os.remove(JSX_SRC_IN_PKG)

    # manifest 的 ScriptPath 指向 .jsxbin
    mf = io.open(MANIFEST, encoding="utf-8").read()
    if "./jsx/ae-bridge.jsx" not in mf:
        raise SystemExit("  [失败] manifest 里找不到 ScriptPath 的旧值")
    mf = mf.replace("<ScriptPath>./jsx/ae-bridge.jsx</ScriptPath>",
                    "<ScriptPath>./jsx/ae-bridge.jsxbin</ScriptPath>")
    io.open(MANIFEST, "w", encoding="utf-8", newline="").write(mf)
    say("  jsx → jsxbin：%s → %s（明文 jsx 已剔除，manifest ScriptPath 已改指 .jsxbin）"
        % (mb(os.path.getsize(JSX_SRC)), mb(os.path.getsize(JSX_BIN_IN_PKG))))
else:
    say("  **警告**：没找到 jsxbin 编译器（%s）")
    say("            分发包将带上明文 jsx。安装编译器：")
    say("            npm install jsxbin --prefix tools/jsxbin-tool")

# ---------- 2. 流水线（**零 npm 依赖** + 随包 LGPL ffmpeg）----------
pipe_src = os.path.join(ROOT, "pipeline")
pipe_dst = os.path.join(PKG, "pipeline")
os.makedirs(pipe_dst, exist_ok=True)
for name in ["cli.js", "package.json"]:
    shutil.copyfile(os.path.join(pipe_src, name), os.path.join(pipe_dst, name))
shutil.copytree(os.path.join(pipe_src, "lib"), os.path.join(pipe_dst, "lib"))

# ⚠⚠ 刻意 **不复制 node_modules** —— 这条是合规红线，改回去之前先读 THIRD-PARTY-NOTICES.md。
#
# 旧版整目录复制 node_modules，结果把两个问题一起分发出去：
#   1) jianying-subtitle（GPL-3.0-only）—— 强 copyleft，整个插件会被要求按 GPL-3 开源
#   2) @ffmpeg-installer 里的 ffmpeg —— 该包 package.json 声明 **LGPL-2.1**，
#      但实测 `ffmpeg -version` 显示 `--enable-gpl`，**实际是 GPL 构建**（声明与实物不符）
# v0.9.0 起识别走纯 HTTP 适配器，pipeline 没有任何运行时 npm 依赖，
# 所以完全可以不带 node_modules —— 既避开许可义务，又省下约 139 MB。
say("  复制流水线（有意不含 node_modules：零运行时依赖 + 避开 GPL 传染）")

# 随包 ffmpeg：必须是 **LGPL 构建**，并带上许可全文
vend_src = os.path.join(pipe_src, "vendor", "ffmpeg")
vend_dst = os.path.join(pipe_dst, "vendor", "ffmpeg")
FFMPEG_EXE = os.path.join(vend_src, "ffmpeg.exe")
if not os.path.isfile(FFMPEG_EXE):
    raise SystemExit(
        "  [失败] 找不到随包 ffmpeg：%s\n"
        "         分发包必须自带 ffmpeg（LGPL 构建）。获取方式见 THIRD-PARTY-NOTICES.md。" % FFMPEG_EXE
    )

# 打包前先验一次"是不是 GPL 构建"：这是防呆，不是形式主义 ——
# 一旦误换成 GPL 构建，商业分发就多了源码随附义务，而这件事完全没有报错提示。
try:
    _ver = subprocess.run([FFMPEG_EXE, "-version"], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=30).stdout or ""
except Exception as e:
    raise SystemExit("  [失败] 无法执行随包 ffmpeg（%s）：%r" % (FFMPEG_EXE, e))
_cfg = next((l for l in _ver.splitlines() if l.startswith("configuration:")), "")
if "--enable-gpl" in _cfg:
    raise SystemExit(
        "  [失败] 随包 ffmpeg 是 **GPL 构建**（configuration 里含 --enable-gpl）。\n"
        "         分发包必须用 LGPL 构建，否则商业分发要承担 GPL 的源码随附义务。\n"
        "         请换回 ffmpeg-master-latest-win64-lgpl，并同步更新 THIRD-PARTY-NOTICES.md。\n"
        "         当前配置：" + _cfg[:200]
    )

os.makedirs(vend_dst, exist_ok=True)
for name in ("ffmpeg.exe", "LICENSE.txt"):
    src2 = os.path.join(vend_src, name)
    if not os.path.isfile(src2):
        raise SystemExit("  [失败] 随包 ffmpeg 目录缺少 %s：" % name + src2)
    shutil.copyfile(src2, os.path.join(vend_dst, name))
_fv = next((l for l in _ver.splitlines() if l.startswith("ffmpeg version")), "ffmpeg")
say("  随包 ffmpeg（LGPL 构建，已通过 --enable-gpl 检查）+ 许可全文")
say("            %s · %.1f MB" % (_fv[:60], os.path.getsize(FFMPEG_EXE) / 1048576))

# 合规文件：随包提供，再分发时必须保留
for _f in ("LICENSE", "THIRD-PARTY-NOTICES.md"):
    _p = os.path.join(ROOT, _f)
    if os.path.isfile(_p):
        shutil.copyfile(_p, os.path.join(PKG, _f))
    else:
        say("  **警告**：项目根缺少 %s，分发包将不含合规声明" % _f)
say("  已随包附带 LICENSE 与 THIRD-PARTY-NOTICES.md")

# ---------- 3. 自带 Node 运行时 ----------
os.makedirs(os.path.join(PKG, "node-runtime"), exist_ok=True)
shutil.copyfile(NODE_EXE, os.path.join(PKG, "node-runtime", "node.exe"))

# ⚠ Node.js 是 MIT 许可，而 MIT 明确要求「在软件的所有副本中附上版权声明与许可声明」。
#   随包分发 node.exe 就是分发它的副本 ⇒ **必须**附许可。
#   注意要附的是官方那份 **完整** LICENSE：它不只是 MIT 一段，还逐条列出了 node.exe
#   里内嵌的 V8 / OpenSSL / ICU / zlib / libuv / npm 等组件的各自许可
#   （OpenSSL 还有额外的"必须提及"要求）。只写一句"Node.js 是 MIT"是不够的。
_NODE_LIC = os.path.join(os.path.dirname(NODE_EXE), "LICENSE")
if os.path.isfile(_NODE_LIC):
    shutil.copyfile(_NODE_LIC, os.path.join(PKG, "node-runtime", "LICENSE"))
    say("  随包附 Node.js 许可全文（%.0f KB，含 V8/OpenSSL/ICU 等内嵌组件清单）"
        % (os.path.getsize(_NODE_LIC) / 1024))
else:
    _MISSING.append("Node.js 许可：%s 不存在，无法随包提供" % _NODE_LIC)

io.open(os.path.join(PKG, "node-runtime", "说明.txt"), "w", encoding="utf-8").write(
    "这个文件夹里是 Node.js 运行时（node.exe），随插件一起分发，保证你不用额外安装任何东西。\n"
    "\n"
    "· 如果删掉它，插件会改用你系统里装的 Node（需要 18 或更高版本）\n"
    "· 两者都没有时，面板会明确提示你去装\n"
    "\n"
    "Node.js 由 OpenJS Foundation 以 MIT 许可发布：https://nodejs.org/\n"
    "同目录的 LICENSE 是它的许可全文（含内嵌的 V8 / OpenSSL / ICU / zlib / libuv 等组件的清单），\n"
    "依 MIT 许可要求随副本一并提供，请不要删除。\n"
)
say("  复制自带 Node 运行时（node.exe + 许可全文）")

# ---------- 4. 使用说明（放进插件目录）----------
io.open(os.path.join(PKG, "使用说明.md"), "w", encoding="utf-8").write("""# Noniika · 使用说明

在 After Effects 里一键生成字幕：**导出音频 →（可选）本地人声分离 → 云端识别 → 自动建字幕图层**。

## 装完先做一件事（只需一次，很容易漏）

AE **默认不允许脚本写文件**。请在 AE 菜单里打开：

**编辑 → 首选项 → 脚本和表达式** → 勾上 **「允许脚本写入文件和访问网络」**

不开这个，生成字幕会在「导出音频」那一步失败，
而报错信息不会指向这个开关，很容易查错方向。

## 快速上手

1. 时间线上**选中要处理的素材图层**（视频或音频都行）
2. 首页点 **▶ 生成字幕** —— 跑完会在同一个合成里生成字幕文本图层

想只拿人声、不想要字幕？点左边那颗 **分离人声**：只做本地分离并落轨，
**不上传、不识别、不建字幕层**，跑完会问你要不要接着识别。

## 主界面两颗按钮的区别

| 按钮 | 做什么 |
|---|---|
| **分离人声** | 导出 → 本地分离 → 落轨。音频全程不出本机（需要先装 Python） |
| **▶ 生成字幕** | 完整流程，会把音频上传到你选的识别引擎做识别 |

## 人声分离需要 Python（可选功能）

分离用的是本机的 [audio-separator](https://github.com/nomadkaraoke/python-audio-separator)，
所以需要本机有 **Python 3.10 ~ 3.13**：

1. 到 https://www.python.org/downloads/ 下载 3.12 或 3.13（**不要用 3.14**，依赖包还没跟上）
2. 安装时**务必勾选 "Add python.exe to PATH"**
3. 回到面板「人声分离设置」页，点 **一键安装环境**（一次性，约 7 GB，几分钟到十几分钟）
4. 装完点「检查依赖」，看到绿色的「运算设备 ...」就绪了

> 有 NVIDIA 显卡的话，勾上「GPU 加速」会快十几倍，还能跑质量最高的模型。

## 数据放在哪儿？

- **分离环境与模型**：默认在「我的文档 / AE自动字幕」下（约 7 GB）
  —— 刻意不放在插件目录里，卸载时删掉它即可清干净。
  想换到别的盘：面板右上角 ⚙ → 环境与诊断 → 数据目录。
- **字幕产物**：面板里「输出目录」指定的位置（默认与素材同目录），
  包含 `.srt` / `.json` / `.txt` 与人声分离出的 `_人声分离/` 文件夹。

## 常见问题

**Q：点生成后提示"没找到 Node"？**
A：插件自带了一份运行时（`node-runtime/` 文件夹），正常不会出现这个提示 ——
请确认这个文件夹还在（有人清理垃圾时可能删掉）。删了也可以自己装 Node 18+。

**Q：识别失败了？**
A：识别走的是云端接口，需要联网，而且**要在「识别选项」里填一个 API Key**。
免费档（硅基流动）注册就给 key、不花钱；填好后可以点「测试密钥」先验证。
失败原因在面板下方「运行日志」里会写明。

**Q：想卸载？**
A：双击「一键卸载.bat」（和安装脚本放在一起的那个）。
   它会分三步问你 —— 插件本体 / 数据目录 / 调试模式开关 ——
   只删你输入 Y 确认的那些，插件目录和数据目录都会先核对身份再动手。
   也可以在 AE 扩展目录里手动删掉 `com.aesub.autosubtitle` 文件夹。

---

## 关于

- 本插件**免费使用**，功能完整：没有付费版、没有试用期、没有水印、没有功能锁。
  面板右上角那颗 **♥** 是「支持作者」页（赞赏码 + 爱发电），**纯自愿** ——
  赞助不换来额外权利、也不是技术支持的条件，不方便就直接关掉，不影响任何功能。
  完整条款见同目录的 `LICENSE`（免费使用许可 v1.0）。
- 本插件是**独立的第三方工具**，与 **Adobe Inc. 没有任何关联**，未获其赞助、认可或授权。
  名称中的"AE"指代 Adobe After Effects，仅用于说明本插件的**兼容对象**。
- 识别服务由**你自己申请的账号**提供。音频会上传到该服务商的服务器，
  请不要用它处理机密、敏感或你无权上传的内容。
- 本插件包含第三方组件（FFmpeg / Node.js / 拼音数据表），各自的许可与义务见同目录的
  `LICENSE` 与 `THIRD-PARTY-NOTICES.md`；**再分发时请一并保留这两个文件**。
""")
say("  写入使用说明.md")

# ---------- 5. 一键安装.bat ----------
BAT = """@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Noniika - 安装

set "SRC=%~dp0com.aesub.autosubtitle"
set "DEST=%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle"

echo ===============================================
echo   Noniika · 安装
echo ===============================================
echo.
echo   来源：%SRC%
echo   目标：%DEST%
echo.

if not exist "%SRC%\\index.html" (
  echo [失败] 找不到 com.aesub.autosubtitle 文件夹 ——
  echo        请把本安装程序与它放在同一个文件夹里。
  echo.
  pause
  exit /b 1
)

rem ---------- 检查 After Effects（只提示，不阻止安装）----------
set "AE_EXE="
call :find_ae "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe"
if not defined AE_EXE call :find_ae "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe"
if not defined AE_EXE goto :no_ae
echo   已检测到 After Effects：
echo     !AE_EXE!
goto :ae_done
:no_ae
echo   [提示] 没能在注册表里找到 After Effects。
echo.
echo          这不影响安装 —— 扩展装在固定位置，AE 启动时会自己去那里找。
echo          但请先确认你确实装了 AE，否则装完没有地方能打开它。
:ae_done
echo.

if not exist "%APPDATA%\\Adobe\\CEP\\extensions" mkdir "%APPDATA%\\Adobe\\CEP\\extensions"

if exist "%DEST%" (
  echo   检测到已安装的旧版本，正在替换程序文件...
  echo   ^(你的数据文件夹 python-env / models 不会被动到^)
  rem ⚠ 这份名单要跟着"面板实际有哪些文件/目录"走：
  rem   漏了谁，升级时那个旧文件就会残留（新版已删掉的文件会一直留着）
  for %%D in (js css jsx CSXS pipeline node-runtime assets) do (
    if exist "%DEST%\\%%D" rmdir /S /Q "%DEST%\\%%D" >nul 2>&1
  )
  for %%F in (index.html support.html) do (
    if exist "%DEST%\\%%F" del /Q "%DEST%\\%%F" >nul 2>&1
  )
)

echo   正在复制文件（体积较大，十几秒到一分钟，请稍候）...
xcopy "%SRC%" "%DEST%\\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo.
  echo [失败] 复制文件出错，请确认目标目录可写：%DEST%
  echo.
  pause
  exit /b 1
)

echo   正在打开 CEP 调试模式（未签名扩展必须）...
for %%V in (9 10 11 12) do (
  reg add "HKCU\\Software\\Adobe\\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo.
echo ===============================================
echo   安装完成！
echo ===============================================
echo.
echo   下一步：
echo     1. 重启 After Effects
echo     2. 菜单栏「窗口 - 扩展 - Noniika」
echo.
echo   ---------------------------------------------------------------
echo   [重要] 还需要在 AE 里开一个权限（只需做一次，很多人漏掉这步）
echo.
echo      AE 菜单：编辑 - 首选项 - 脚本和表达式
echo      勾上「允许脚本写入文件和访问网络」
echo.
echo      AE 默认不允许脚本写文件 —— 不勾的话，第一次生成字幕会在
echo      「导出音频」那一步失败，而报错信息不会直接指向这个开关。
echo   ---------------------------------------------------------------
echo.
echo   想只用人声分离功能的话，还需要装 Python 3.10~3.13，
echo   详见同目录下的「安装说明.md」。
echo.
pause
exit /b 0

:find_ae
for /f "tokens=2*" %%a in ('reg query %1 /ve 2^>nul ^| findstr /i "REG_SZ"') do set "AE_EXE=%%b"
goto :eof
"""
io.open(os.path.join(OUT, "一键安装.bat"), "w", encoding="utf-8", newline="\r\n").write(BAT)
say("  写入 一键安装.bat")

# ---------- 5b. 一键卸载.bat ----------
UNINSTALL = """@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Noniika - 卸载

set "PLUGIN=%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle"
set "DATA=%USERPROFILE%\\Documents\\AE自动字幕"
if not exist "%DATA%" if exist "%USERPROFILE%\\OneDrive\\Documents\\AE自动字幕" set "DATA=%USERPROFILE%\\OneDrive\\Documents\\AE自动字幕"

echo ===============================================
echo   Noniika · 卸载
echo ===============================================
echo.
echo   会分别处理下面两处（每一步都会单独问你）：
echo.
echo     插件本体  %PLUGIN%
echo     数据目录  %DATA%
echo.
echo   输出的字幕文件和人声文件不在这里，不会被删掉。
echo.

tasklist /fi "imagename eq AfterFX.exe" 2>nul | findstr /i "AfterFX.exe" >nul
if not errorlevel 1 (
  echo   [警告] After Effects 正在运行 —— 扩展文件可能被占用而删不干净。
  echo          建议先关掉 AE 再卸载。
  echo.
  set "ANS="
  set /p "ANS=  仍然继续吗？（输入 Y 继续，直接回车退出）："
  if /i not "!ANS!"=="Y" (
    echo.
    echo   已退出，什么都没做。
    echo.
    pause
    exit /b 0
  )
  echo.
)

echo   ---------------------------------------------------------------
echo   第 1 步：插件本体
echo   ---------------------------------------------------------------
if not exist "%PLUGIN%" (
  echo   没找到插件目录（可能已经卸载过，或者装在别处）：
  echo     %PLUGIN%
  goto :step2
)
if not exist "%PLUGIN%\\CSXS\\manifest.xml" (
  echo   [跳过] 该目录里没有本插件的特征文件 CSXS\\manifest.xml。
  echo          为了安全不做删除，请你手动检查：
  echo     %PLUGIN%
  goto :step2
)
findstr /c:"com.aesub.autosubtitle" "%PLUGIN%\\CSXS\\manifest.xml" >nul 2>&1
if errorlevel 1 (
  echo   [跳过] 该目录不是本插件（清单里的 ID 对不上），不做删除。
  goto :step2
)

call :dir_size "%PLUGIN%"
echo   占用：!DIR_SIZE!
echo.
set "ANS="
set /p "ANS=  删除插件本体？（输入 Y 删除，直接回车跳过）："
if /i not "!ANS!"=="Y" goto :skip_plugin
echo   正在删除...
rmdir /S /Q "%PLUGIN%" >nul 2>&1
if exist "%PLUGIN%" (
  echo   [未完成] 有文件删不掉（多半是被占用）。请关闭 AE 后重跑一次本脚本。
) else (
  echo   已删除插件本体，释放 !DIR_SIZE!。
)
goto :step2
:skip_plugin
echo   已跳过插件本体。

:step2
echo.
echo   ---------------------------------------------------------------
echo   第 2 步：数据目录（本地分离环境与模型）
echo   ---------------------------------------------------------------
if not exist "%DATA%" (
  echo   没找到数据目录（说明没装过人声分离环境，或者你改过它的位置）：
  echo     %DATA%
  echo   如果你在面板里改过「数据目录」，请去那里手动删。
  goto :step3
)
set "OURS="
if exist "%DATA%\\models" set "OURS=1"
if exist "%DATA%\\python-env" set "OURS=1"
if not defined OURS (
  echo   [跳过] 该目录里没有本插件的数据（models / python-env），不做删除：
  echo     %DATA%
  goto :step3
)

call :dir_size "%DATA%"
echo   占用：!DIR_SIZE!
echo.
echo   这里面是本地分离用的 Python 环境与模型，删了以后要重新下载（约 7 GB）。
echo   如果你还想继续用人声分离功能，这一步请跳过。
echo.
set "ANS="
set /p "ANS=  删除数据目录？（输入 Y 删除，直接回车跳过）："
if /i not "!ANS!"=="Y" goto :skip_data
echo   正在删除（文件很多，可能要一会儿）...
rmdir /S /Q "%DATA%" >nul 2>&1
if exist "%DATA%" (
  echo   [未完成] 有文件删不掉。请关闭 AE 后重跑一次本脚本。
) else (
  echo   已删除数据目录，释放 !DIR_SIZE!。
)
goto :step3
:skip_data
echo   已跳过数据目录（分离环境和模型都保留）。

:step3
echo.
echo   ---------------------------------------------------------------
echo   第 3 步：CEP 调试模式开关（可选）
echo   ---------------------------------------------------------------
echo   安装时为了加载未签名扩展，往注册表写过：
echo     HKCU\\Software\\Adobe\\CSXS.9 ~ .12   PlayerDebugMode = 1
echo.
echo   如果这台机器上还有别的未签名扩展（或你自己写的脚本），
echo   建议保留这个开关；确定不再需要了才删。
echo.
set "ANS="
set /p "ANS=  一并删掉这个开关吗？（输入 Y 删除，直接回车保留）："
if /i not "!ANS!"=="Y" goto :done
for %%V in (9 10 11 12) do reg delete "HKCU\\Software\\Adobe\\CSXS.%%V" /v PlayerDebugMode /f >nul 2>&1
echo   已删除调试模式开关。

:done
echo.
echo ===============================================
echo   卸载结束
echo ===============================================
echo.
echo   如果删了插件本体：重启 After Effects 后扩展就不见了。
echo.
echo   以下内容没有被删（它们是你的作品，不是插件）：
echo     · 输出目录里的 .srt / .json / .txt 字幕文件
echo     · 输出目录下 `_人声分离` 里的人声与伴奏
echo   想清掉的话：在插件里点「清理插件文件」，或手动删除。
echo.
pause
exit /b 0

:dir_size
set "DIR_SIZE="
set "SZFILE=%TEMP%\\aesub_dirsize.tmp"
del "%SZFILE%" >nul 2>&1
powershell -NoProfile -Command "$b=(Get-ChildItem -LiteralPath '%~1' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; if($b){[Console]::WriteLine('{0:N1} MB' -f ($b/1MB))}else{[Console]::WriteLine('0 MB')}" >"%SZFILE%" 2>nul
if exist "%SZFILE%" set /p DIR_SIZE=<"%SZFILE%"
del "%SZFILE%" >nul 2>&1
if not defined DIR_SIZE set "DIR_SIZE=未知"
goto :eof
"""
io.open(os.path.join(OUT, "一键卸载.bat"), "w", encoding="utf-8", newline="\r\n").write(UNINSTALL)
say("  写入 一键卸载.bat")

# ---------- 6. 安装说明.md ----------
total = size_of(PKG)
io.open(os.path.join(OUT, "安装说明.md"), "w", encoding="utf-8").write(f"""# Noniika v{VERSION} · 安装说明

在 After Effects 里一键生成字幕。**解压即用，不需要自己装 Node。**

> 本插件**免费**，功能完整：没有付费版、没有试用期、没有水印。
> 面板右上角的 **♥** 是自愿赞助入口（赞赏码 / 爱发电），不影响任何功能 —— 详见第八节。

---

## 一、装之前确认

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| After Effects | 2019 或更高版本 |
| 磁盘空间 | 插件本体约 **{mb(total)}**（已经带上了运行时，不用再装别的） |
| 网络 | 识别那一步需要联网（音频会上传到所选识别引擎的云端），并且要填一个 API Key |
| 想用人声分离 | 额外需要 Python 3.10~3.13（见第四节） |

## 二、安装（4 步）

1. **双击「一键安装.bat」**
   它会把插件复制到 AE 的扩展目录，并把 CEP 打开调试模式
   （未签名的第三方扩展必须开这个开关，否则 AE 里看不到）。
   如果提示权限不足，右键 →「以管理员身份运行」。
   脚本会顺手查一下你机器上装没装 AE —— 只是提示，不影响安装。

2. **重启 After Effects**（必须重启，扩展只在启动时加载）

3. **在 AE 里开一个权限（很容易漏，务必做）**

   | 项目 | 内容 |
   |---|---|
   | 位置 | AE 菜单：**编辑 → 首选项 → 脚本和表达式** |
   | 勾上 | **允许脚本写入文件和访问网络** |

   AE **默认不允许脚本写文件**（Adobe 官方设定，不是本插件的问题）。
   不勾的话，第一次生成字幕会在「导出音频」那一步失败，
   而那个报错信息不会指向这个开关，很容易查错方向。

4. AE 菜单栏 → **窗口 → 扩展 → Noniika**

## 三、第一次用（**先准备一个识别密钥，否则第 2 步必然失败**）

### 3.0 拿一个识别引擎的密钥（二选一，都不花钱）

**选项 A：硅基流动（默认引擎，免费不限量）**

| 步骤 | 做什么 |
|---|---|
| 1 | 打开 <https://cloud.siliconflow.cn>，用**手机号**注册 |
| 2 | 控制台 →「账号设置 / 实名认证」**完成实名**。⚠ 未实名**无法调用免费模型**，这是最容易卡住的一步 |
| 3 | 控制台 →「API 密钥」→ 新建密钥 → **立即复制**（`sk-` 开头，只显示一次） |

> 有资料称新账号需**充值最低 0.01 元**才能激活免费额度，也有资料说不需要。
> 以你注册时页面的实际提示为准 —— 反正最多一分钱。

**选项 B：腾讯云（有月度免费额度，且返回词级时间戳）**

| 步骤 | 做什么 |
|---|---|
| 1 | 打开 <https://console.cloud.tencent.com/cam/capi> |
| 2 | 开通「语音识别」服务（开通即自动下发每月 10 小时免费额度） |
| 3 | 新建密钥，拿到 **SecretId** 与 **SecretKey** 两个值 |

拿到之后回到面板：**⚙ 设置 → 识别选项 → 引擎**，选好档位，把密钥粘进去，
点 **测试密钥** —— 看到"鉴权通过"再往下走。
（「测试密钥」不消耗识别额度，可以随便点。）

### 3.1 然后开始

1. 在时间线上**选中要处理的素材图层**（视频 / 音频都行）
2. 点首页的 **▶ 生成字幕**
   面板会：导出这段音频 → 上传识别 → 在同一个合成里创建字幕文本图层
3. 想调字幕的字体 / 字号 / 动画预设：点「字幕样式」进二级页

> 第一次建议**挑一段 10~30 秒、有人说话、句子之间有明显停顿**的素材 ——
> 默认引擎不返回时间戳，时间轴是按"停顿"重建的，有停顿的素材出字幕最准。

> 只要人声、不要字幕？点左边那颗 **分离人声**。它只做本地分离并把人声落到时间线，
> **不上传、不识别、不建字幕层**，跑完会问你要不要接着识别。

## 四、想用人声分离功能（可选）

分离是在你本机跑的（[audio-separator](https://github.com/nomadkaraoke/python-audio-separator)），
所以需要本机有 **Python 3.10 ~ 3.13**：

1. 到 https://www.python.org/downloads/ 下载 **3.12 或 3.13**
   （**别用 3.14** —— 依赖的预编译包还没跟上，会安装失败）
2. 安装时**务必勾选** "Add python.exe to PATH"
3. 回到面板 →「人声分离设置」→ 点 **一键安装环境**
   （一次性下载约 7 GB，几分钟到十几分钟，删掉数据目录即可完全卸载）
4. 装完点「检查依赖」，看到绿色的「运算设备 ...」就是就绪了

> 有 NVIDIA 显卡就勾上「GPU 加速」，分离快十几倍，还能用质量最高的大模型。

## 五、数据放在哪

| 内容 | 位置 |
|---|---|
| 分离环境 + 模型（约 7 GB） | 「我的文档 / AE自动字幕」（可在 ⚙ → 数据目录 改到别的盘） |
| 字幕产物（.srt / .json / .txt） | 面板「输出目录」指定的位置 |
| 分离出的人声 / 伴奏 | 输出目录下的 `_人声分离/` |

插件本体**只有**安装目录那一份；数据都在上面这些地方，卸载时删干净即可。

## 六、卸载（双击「一键卸载.bat」）

脚本分三步走，**每一步都单独问你**，直接回车就是跳过：

| 步骤 | 删什么 | 默认 |
|---|---|---|
| 1 | 插件本体：`%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle` | 跳过 |
| 2 | 数据目录：「我的文档 / AE自动字幕」（约 7 GB 的分离环境与模型） | 跳过 |
| 3 | 注册表里的 CEP 调试模式开关：`HKCU\\Software\\Adobe\\CSXS.9 ~ .12` | 保留 |

**只删你输入 Y 确认的那些。** 删除前脚本会先核对目录身份 ——
插件目录里必须有 `CSXS\\manifest.xml` 且 ID 匹配，数据目录里必须有 `models` 或 `python-env`；
对不上就跳过并打印路径，不会误删别的目录。

同理，**下面这些不会被删**（它们是作品，不是插件）：
输出目录里的 `.srt` / `.json` / `.txt`，以及 `_人声分离\\` 里的人声与伴奏。
要清掉的话，在插件里点「清理插件文件」，或手动删。

> 卸载前建议先关掉 AE（文件被占用会删不干净，脚本会提醒）。
> 以后想装回来：第 2 步删掉的环境要用「一键安装环境」重下约 7 GB。

## 七、常见问题

**装完 AE 里找不到扩展？**
- 确认**重启过** AE（扩展只在启动时加载）
- 确认 `%APPDATA%\\Adobe\\CEP\\extensions\\com.aesub.autosubtitle\\CSXS\\manifest.xml` 存在
- 检查注册表 `HKCU\\Software\\Adobe\\CSXS.11` 的 `PlayerDebugMode` 是不是 `1`
  （双击一次「一键安装.bat」会确保它被设置）

**提示"没找到 Node"？**
- 插件自带 `node-runtime/node.exe`，正常不会出现这个提示 ——
  确认这个文件夹还在（清理工具可能误删），也可以在 ⚙ → 环境与诊断里手动指定

**在面板里打中文，候选词框跑到屏幕左上角？**
A：这是 Adobe 官方确认的 CEP 12 缺陷（编号 CEP-3029，CEP 9/10 没有这个问题），
   第三方扩展无法自行修复。我们的应对是**搜索框支持拼音**：字体和预设都能直接打
   拼音或首字母（如 ruizi / rz / dzj），一个汉字都不用打。
   另外：在里面用 Ctrl+V 粘贴中文也不会触发候选框。

**识别失败？**
- 识别需要联网、并需要在「识别选项」里填 API Key；把面板下方「运行日志」展开，里面会写明失败原因

**点生成后卡在「导出音频」就失败了？**
- 九成是没开脚本权限。AE 菜单：编辑 → 首选项 → 脚本和表达式 →
  勾上「允许脚本写入文件和访问网络」（见第二节第 3 步）。
  这个开关 AE 默认是关的，而且报错信息不会指向它。

**人声分离很慢？**
- 没装 GPU 加速时是纯 CPU 跑，10 分钟素材可能要十几分钟；
  有 N 卡就勾上「GPU 加速」（装完约 4 GB 的 CUDA 版依赖）

## 八、赞助（完全自愿，跳过这一节完全没问题）

- 本插件**免费使用、功能完整**：没有付费版、没有试用期、没有水印、没有功能锁。
- 想支持的话，点面板右上角的 **♥** —— 里面是微信赞赏码与爱发电主页。
  赞助属于**赠与**：不换来任何额外权利，不改变许可条款，也**不是技术支持的条件**。
- 不赞助**完全不影响使用**，不需要做任何设置，也不会有任何提示或限制。

**关于转发给别人**（欢迎，但有一条底线）

- ✅ 原样转发没问题：网盘、群聊、教程里附带、装机时顺手装 —— 都可以。
- ✅ 拿它接单做字幕、用在商业项目里也没问题（成品归你）。
- ❌ 但**不要收费提供下载、不要转售**，也不要改掉署名与 ♥ 入口。
- 条件只有一条：**一并保留** `LICENSE`、`THIRD-PARTY-NOTICES.md` 与本说明。
  完整条款见 `LICENSE`（免费使用许可 v1.0）。
""")
say("  写入 安装说明.md")

# ---------- 6b. 出厂自检：不合格就删掉产物，绝不出厂 ----------
# 为什么必须是"机器拦"而不是"人记得"：
#   这几类东西混进分发包时**都不会有任何报错** —— 测试视频和密钥会安静地跟着发出去，
#   许可文件缺了也照样能装能用。只有逐文件核对才发现得了，所以交给脚本。
say("")
say("=== 出厂自检 ===")

_MEDIA_EXT = (".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm", ".m4v", ".mpg", ".mpeg",
              ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".aiff", ".aif",
              ".onnx", ".ckpt", ".pth", ".pt", ".safetensors",      # 模型权重
              ".ttf", ".otf", ".ttc", ".woff", ".woff2")            # 字体（授权各不相同，一律不打）
_DEV_MARKERS = ("/.workbuddy/", "/test/", "/design/", "/tools/", "/node_modules/",
                "/models/", "/python-env/", "/插件备份/", "/.git/")
_SECRET_RX = [
    ("sk- 风格密钥", re.compile(rb"sk-[A-Za-z0-9]{20,}")),
    ("腾讯云 SecretId", re.compile(rb"AKID[A-Za-z0-9]{16,}")),
    ("Bearer 令牌", re.compile(rb"Bearer\s+[A-Za-z0-9\-_.]{24,}")),
    ("写成字面量的密钥", re.compile(
        rb"(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*[\"'][A-Za-z0-9\-_]{16,}[\"']", re.I)),
]
# 已知无害的常量，避免误报。
# ⚠ 这里**只能放明确的占位标记**，绝不能放宽（例如别加 "abcdefghijklmnopqrstuvwxyz"
#   这类"字母表"模式 —— 它会放行大量真实 key，是负向测试实测出来的洞）。
#   预览稿里的示例 key 不需要在这里豁免：design/ 根本不在复制白名单里。
_BENIGN_RX = re.compile(
    rb"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    rb"|sk-fake|your[_-]?key|placeholder|<[^>]*key[^>]*>|xxx", re.I)
# ⚠ 只扫文本文件：node.exe / ffmpeg.exe 这类二进制里的随机字节会大量误报
#   （实测 node.exe 里有 3 处假"AKID"，都是字节码数据），那是噪音，不是密钥。
_TEXT_EXT = (".js", ".mjs", ".json", ".jsx", ".jsxbin", ".html", ".css", ".md",
             ".txt", ".bat", ".xml", ".yml", ".yaml")

_found_media, _found_dev, _found_secret = [], [], []
for _dp, _dn, _fn in os.walk(PKG):
    for _f in _fn:
        _full = os.path.join(_dp, _f)
        _rel = "/" + os.path.relpath(_full, PKG).replace("\\", "/")
        _low = _rel.lower()
        if _low.endswith(_MEDIA_EXT):
            _found_media.append("%s（%.1f MB）" % (_rel, os.path.getsize(_full) / 1048576))
        for _m in _DEV_MARKERS:
            if _m in _low:
                _found_dev.append(_rel)
                break
        if _low.endswith(_TEXT_EXT):
            try:
                _data = open(_full, "rb").read()
            except OSError:
                continue
            for _label, _rx in _SECRET_RX:
                for _mt in _rx.finditer(_data):
                    if _BENIGN_RX.search(_mt.group(0)):
                        continue
                    _found_secret.append("%s → %s：%s" % (_rel, _label, _mt.group(0)[:40]))

_problems = list(_MISSING)
if _found_media:
    _problems.append("混进了素材/模型/字体文件（%d 个）：%s"
                     % (len(_found_media), "；".join(_found_media[:5])))
if _found_dev:
    _problems.append("混进了开发物料（%d 个）：%s"
                     % (len(_found_dev), "；".join(_found_dev[:5])))
if _found_secret:
    _problems.append("发现疑似密钥（%d 处）：%s"
                     % (len(_found_secret), "；".join(_found_secret[:5])))
for _need in ("node-runtime/node.exe", "node-runtime/LICENSE", "LICENSE",
              "THIRD-PARTY-NOTICES.md", "index.html", "js/main.js",
              "support.html", "assets/zanshang-code.png",     # 「支持作者」页（♥ 打开的就是它）
              "pipeline/cli.js", "pipeline/vendor/ffmpeg/ffmpeg.exe",
              "pipeline/vendor/ffmpeg/LICENSE.txt"):
    if not os.path.isfile(os.path.join(PKG, _need)):
        _problems.append("缺少随包文件：" + _need
                         + ("（许可类文件缺失 = 合规缺口）" if "LICENSE" in _need or "NOTICES" in _need else ""))

if _problems:
    say("  ✗ 未通过，共 %d 项 —— 已删除产物，不许出厂：" % len(_problems))
    for _p in _problems:
        say("     · " + _p)
    shutil.rmtree(PKG, ignore_errors=True)
    raise SystemExit(1)
say("  ✓ 无素材/模型/字体、无开发物料、无密钥字面量（%d 个文本文件已扫）" % sum(
    1 for _dp, _dn, _fn in os.walk(PKG) for _f in _fn if _f.lower().endswith(_TEXT_EXT)))
say("  ✓ 许可文件齐全：LICENSE / THIRD-PARTY-NOTICES.md / ffmpeg LICENSE.txt / Node.js LICENSE")

# ---------- 7. 打 zip ----------
zip_path = os.path.join(OUT, "Noniika-v%s.zip" % VERSION)
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in ["安装说明.md", "一键安装.bat", "一键卸载.bat"]:
        z.write(os.path.join(OUT, name), name)
    for dp, dn, fn in os.walk(PKG):
        for f in fn:
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, OUT).replace("\\", "/")
            z.write(full, rel)
say("  打包 zip：" + os.path.basename(zip_path))

# ---------- 8. 体积报告 ----------
say("")
say("=== 分发包体积 ===")
say("  插件目录 %-14s %s" % ("", mb(size_of(PKG))))
for name in sorted(os.listdir(PKG)):
    p = os.path.join(PKG, name)
    if os.path.isdir(p):
        say("    %-22s %10s" % (name + "/", mb(size_of(p))))
    elif os.path.getsize(p) > 10240:
        say("    %-22s %10s" % (name, mb(os.path.getsize(p))))
say("  zip 压缩包            %s" % mb(size_of(zip_path)))
say("")
say("  对照：打包前项目本体（cep + pipeline，含随包 ffmpeg、不含模型/环境）≈ %s"
    % mb(size_of(os.path.join(ROOT, "cep")) + size_of(os.path.join(ROOT, "pipeline"))))

io.open(os.path.join(ROOT, "tools", "last-build-report.txt"), "w", encoding="utf-8").write(
    "\n".join(log))
print("done")
