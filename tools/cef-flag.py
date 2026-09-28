# -*- coding: utf-8 -*-
"""CEF 参数开关（给面板试参数用，一条命令搞定 + 自动同步到安装目录）

用法：
    python tools/cef-flag.py                    # 看当前有哪些参数
    python tools/cef-flag.py --add  A B C       # 加上（已存在的会跳过）
    python tools/cef-flag.py --remove A B       # 去掉
    python tools/cef-flag.py --set  A B         # 只保留这几个（清空后重设，nodejs 那几个会自动保留）
    python tools/cef-flag.py --reset            # 回到项目基线

为什么要这个脚本：每换一次参数都要"改 manifest → 同步到 CEP 目录 → 重启 AE"，
手改容易漏掉某一份；这里一次做完，并且改完立刻用 XML 解析器验合法性
（注释里的 ASCII `--` 会让 AE 直接加载不了扩展）。
"""
import io, os, re, shutil, sys
import xml.etree.ElementTree as ET

R = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MANIFEST = os.path.join(R, "cep", "CSXS", "manifest.xml")
DEST = os.path.join(os.environ["APPDATA"], "Adobe", "CEP", "extensions",
                    "com.aesub.autosubtitle", "CSXS", "manifest.xml")

# 项目基线：这几个是功能必需的，别动
BASELINE = ["--enable-nodejs", "--mixed-context",
            "--allow-file-access-from-files", "--allow-file-access"]


def read():
    return io.open(MANIFEST, encoding="utf-8").read()


def params_of(raw):
    return re.findall(r"<Parameter>([^<]+)</Parameter>", raw)


def rewrite(extra):
    """把 CEFCommandLine 里的参数改成 BASELINE + extra。

    ⚠️ 只**逐行替换 <Parameter> 行**，块里的注释原样保留。
    （早先版本是"整块重写"，副作用是把两行解释性注释吃掉了 —— 实测踩到，
      所以这里改成原地改写；注释在 XML 里是有价值的文档，不能丢。）
    """
    raw = read()
    m = re.search(r"[ \t]*<CEFCommandLine>.*?</CEFCommandLine>", raw, flags=re.S)
    if not m:
        print("× 没找到 CEFCommandLine 段，未改动")
        sys.exit(1)

    want = BASELINE + [p for p in extra if p not in BASELINE]   # 目标参数（按序）
    lines = m.group(0).split("\n")
    out_lines = []
    indent = None
    wi = 0
    for ln in lines:
        if "<Parameter>" in ln:
            if indent is None:
                indent = ln[:len(ln) - len(ln.lstrip())]
            if wi < len(want):                       # 还有目标参数 → 就地替换
                out_lines.append("%s<Parameter>%s</Parameter>" % (indent, want[wi]))
                wi += 1
            # 目标参数已经用完（这是在删参数）→ 这一行直接丢掉
        else:
            out_lines.append(ln)

    if wi < len(want):                                # 目标参数比原有的多 → 补在结尾标签前
        if indent is None:
            indent = "\t\t\t\t\t\t"
        close = (indent[:-1] if len(indent) > 1 else indent) + "</CEFCommandLine>"
        for k in range(len(out_lines) - 1, -1, -1):
            if "</CEFCommandLine>" in out_lines[k]:
                out_lines[k] = close
                for p in reversed(want[wi:]):
                    out_lines.insert(k, "%s<Parameter>%s</Parameter>" % (indent, p))
                break

    out = raw[:m.start()] + "\n".join(out_lines) + raw[m.end():]
    io.open(MANIFEST, "w", encoding="utf-8", newline="").write(out)

    # 立刻验 XML 合法性 —— 这地方出错 AE 会整个扩展加载不了
    try:
        ET.parse(MANIFEST)
    except Exception as e:
        print("× 改完 XML 不合法，正在回滚：%s" % e)
        io.open(MANIFEST, "w", encoding="utf-8", newline="").write(raw)
        sys.exit(1)

    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    shutil.copyfile(MANIFEST, DEST)
    same = open(MANIFEST, "rb").read() == open(DEST, "rb").read()
    print("  同步到 CEP 安装目录：%s" % ("一致" if same else "**不一致**"))


def main():
    argv = sys.argv[1:]
    raw = read()
    cur = params_of(raw)

    if not argv:
        print("当前 CEF 参数：")
        for p in cur:
            print("   %s%s" % (p, "   （基线）" if p in BASELINE else "   ← 试验用"))
        print("\n基线：%s" % ", ".join(BASELINE))
        return

    mode = argv[0]
    # 注意：参数名本身就以 `--` 开头，所以只能把 argv[0] 当模式，其余全是参数值
    # （早先版本的 bug：用 startswith("--") 过滤，结果 --disable-gpu 这类参数被当成模式吃掉了）
    args = argv[1:]

    if mode == "--reset":
        rewrite([]); print("  已回到基线")
    elif mode == "--add":
        rewrite([p for p in cur if p not in BASELINE] + args); print("  已加上：%s" % " ".join(args))
    elif mode == "--remove":
        rewrite([p for p in cur if p not in BASELINE and p not in args])
        print("  已去掉：%s" % " ".join(args))
    elif mode == "--set":
        rewrite(args); print("  已设为：%s" % " ".join(args))
    else:
        print("用法见文件头注释"); return

    print("改完的参数：")
    for p in params_of(read()):
        print("   %s" % p)
    print("\n提醒：参数只在 **AE 启动时** 生效 —— 要关掉 AE 再重开（不是重载面板）。")


if __name__ == "__main__":
    main()
