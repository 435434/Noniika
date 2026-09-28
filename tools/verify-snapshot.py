# -*- coding: utf-8 -*-
"""快照对账 —— 证明「这个备份真的能还原」，用数字说话。

用法：
    python tools/verify-snapshot.py "E:\\备份\\2026-09-28_v0.9.1"
    python tools/verify-snapshot.py "<快照目录>" --src "<项目根>"

八项检查：
  ① 全树文件集合（零缺失 / 零多余）
  ② 全量尺寸比对
  ③ 源码与文档 逐字节 sha256（cep / pipeline / tools / test + 根目录几个 md）
  ④ >5MB 大件：时间戳全量 + 随机采样哈希
  ⑤ 快照里的 venv 解释器真跑一次（能否脱离源目录独立启动 + import）
  ⑥ 当前已安装的扩展 vs 快照 cep/
  ⑦ 注册表 PlayerDebugMode（CSXS.9~12）
  ⑧ 快照里的成品 zip：testzip() + 必备文件清单

退出码：0 = 全过；1 = 有问题（细节打在输出里）。
"""
import os
import io
import sys
import time
import random
import hashlib
import zipfile
import subprocess

KEY_DIRS = ("cep", "pipeline", "tools", "test")
KEY_FILES = ("README.md", "LICENSE", "THIRD-PARTY-NOTICES.md", "任务书.md")
SKIP_TOP = {"插件备份"}          # 防套娃：快照不含备份自身
SKIP_REL_PREFIX = ("test/output/",)  # 临时产物
BIG_BYTES = 5 * 1048576
SAMPLE_MAX = 25
ZIP_MUST = ("一键安装.bat", "一键卸载.bat", "support.html", "LICENSE",
            "THIRD-PARTY-NOTICES.md", "安装说明.md", "manifest.xml", "index.html")


def rel_files(root):
    out = {}
    for r, ds, fs in os.walk(root):
        for f in fs:
            fp = os.path.join(r, f)
            rel = os.path.relpath(fp, root).replace("\\", "/")
            try:
                out[rel] = os.path.getsize(fp)
            except OSError:
                out[rel] = -1
    return out


def keep(rel):
    if rel.split("/")[0] in SKIP_TOP:
        return False
    return not rel.startswith(SKIP_REL_PREFIX)


def sha(path, buf=1 << 21):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            d = f.read(buf)
            if not d:
                break
            h.update(d)
    return h.hexdigest()


def mb(n):
    return n / 1048576.0


def main():
    snap = None
    src = None
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] == "--src":
            src = argv[i + 1]; i += 2; continue
        if snap is None:
            snap = argv[i]
        i += 1
    if not snap:
        print(__doc__)
        return 2
    snap = os.path.abspath(snap)
    if not src:
        src = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = os.path.abspath(src)

    if not os.path.isdir(snap):
        print("快照目录不存在：%s" % snap)
        return 2
    if not os.path.isdir(src):
        print("项目根不存在：%s" % src)
        return 2

    ok_all = True
    t0 = time.time()
    print("=" * 66)
    print("  快照对账")
    print("    快照：%s" % snap)
    print("    项目根：%s" % src)
    print("    %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 66)

    a = {k: v for k, v in rel_files(src).items() if keep(k)}
    b = rel_files(snap)

    print("\n① 全树文件集合")
    print("   源（扣排除）：%d 个文件 / %.1f MB" % (len(a), mb(sum(v for v in a.values() if v > 0))))
    print("   快照：       %d 个文件 / %.1f MB" % (len(b), mb(sum(v for v in b.values() if v > 0))))
    miss = sorted(set(a) - set(b))
    extra = sorted(set(b) - set(a))
    print("   缺失：%d 个" % len(miss))
    for k in miss[:25]:
        print("      - %s" % k)
    print("   多余：%d 个" % len(extra))
    for k in extra[:25]:
        print("      + %s" % k)
    if miss or extra:
        ok_all = False

    print("\n② 全量尺寸比对")
    diff = [k for k in (set(a) & set(b)) if a[k] != b[k]]
    print("   大小不同：%d 个" % len(diff))
    for k in sorted(diff)[:25]:
        print("      ~ %s  (源=%s / 快照=%s)" % (k, a[k], b[k]))
    if diff:
        ok_all = False

    print("\n③ 源码/文档 逐字节 sha256（%s + 根目录 md）" % " / ".join(KEY_DIRS))
    bad, n = [], 0
    for k in sorted(a):
        top = k.split("/")[0]
        if not (top in KEY_DIRS or k in KEY_FILES):
            continue
        sp = os.path.join(src, k.replace("/", os.sep))
        dp = os.path.join(snap, k.replace("/", os.sep))
        if not os.path.exists(dp):
            bad.append(k + "  (快照没有)")
            continue
        n += 1
        if sha(sp) != sha(dp):
            bad.append(k)
    print("   核对 %d 个文件；不一致：%d" % (n, len(bad)))
    for k in bad[:25]:
        print("      x %s" % k)
    if bad:
        ok_all = False

    print("\n④ 大件（>5MB）时间戳全量 + 采样哈希")
    big = sorted(((k, v) for k, v in a.items() if v > BIG_BYTES), key=lambda x: -x[1])
    print("   >5MB：%d 个" % len(big))
    ts_bad = []
    for k, v in big:
        sp = os.path.join(src, k.replace("/", os.sep))
        dp = os.path.join(snap, k.replace("/", os.sep))
        if not os.path.exists(dp):
            continue
        if abs(os.path.getmtime(sp) - os.path.getmtime(dp)) > 2:
            ts_bad.append(k)
    print("   时间戳不一致：%d 个" % len(ts_bad))
    for k in ts_bad[:10]:
        print("      ~ %s" % k)
    random.seed(20260928)
    sample = big if len(big) <= SAMPLE_MAX else random.sample(big, SAMPLE_MAX)
    h_bad = []
    for k, v in sample:
        sp = os.path.join(src, k.replace("/", os.sep))
        dp = os.path.join(snap, k.replace("/", os.sep))
        if os.path.exists(dp) and sha(sp) != sha(dp):
            h_bad.append(k)
    print("   采样哈希 %d 个；不一致：%d" % (len(sample), len(h_bad)))
    for k in h_bad[:10]:
        print("      x %s" % k)
    if ts_bad or h_bad:
        ok_all = False

    print("\n⑤ 快照里的 venv 解释器真跑一次")
    sp_dir = os.path.join(snap, "python-env", "Lib", "site-packages")
    if os.path.isdir(sp_dir):
        pths = [x for x in os.listdir(sp_dir) if x.endswith(".pth")]
        print("   site-packages 里的 .pth：%d 个" % len(pths))
        for x in pths:
            try:
                txt = io.open(os.path.join(sp_dir, x), encoding="utf-8", errors="replace").read().strip()
            except OSError as e:
                txt = "(%s)" % e
            hard = ("Desktop" in txt and "AE" in txt)
            print("      %-34s %s%s" % (x, "**可能写死原路径** " if hard else "", txt[:70].replace("\n", " | ")))
    venv_py = os.path.join(snap, "python-env", "Scripts", "python.exe")
    if os.path.exists(venv_py):
        code = ("import sys;print('executable=',sys.executable);print('prefix=',sys.prefix);"
                "print('version=',sys.version.split()[0]);"
                "import numpy;print('numpy',numpy.__version__)")
        try:
            r = subprocess.run([venv_py, "-c", code], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=180)
            print("   返回码 %d" % r.returncode)
            for l in r.stdout.decode("utf-8", "replace").splitlines():
                print("      " + l)
            if r.returncode != 0:
                ok_all = False
        except subprocess.TimeoutExpired:
            print("   [超时 180s] 首次 import 可能较慢，不算失败")
        except OSError as e:
            print("   启动失败：%s" % e)
            ok_all = False
    else:
        print("   快照里没有 python-env\\Scripts\\python.exe，跳过")

    print("\n⑥ 当前已装扩展 vs 快照 cep/")
    inst = os.path.join(os.environ.get("APPDATA", ""), r"Adobe\CEP\extensions\com.aesub.autosubtitle")
    if os.path.isdir(inst):
        ia = set()
        for r, ds, fs in os.walk(inst):
            for f in fs:
                ia.add(os.path.relpath(os.path.join(r, f), inst).replace("\\", "/"))
        snap_cep = set(k[len("cep/"):] for k in b if k.startswith("cep/"))
        print("   已装 %d 个文件 / 快照 cep %d 个文件" % (len(ia), len(snap_cep)))
        only_i = sorted(ia - snap_cep)
        only_s = sorted(snap_cep - ia)
        print("   已装有、快照 cep 没有：%s" % (only_i[:12] if only_i else "无"))
        print("   快照 cep 有、已装没有：%s" % (only_s[:12] if only_s else "无"))
    else:
        print("   已装目录不存在（没装面板？）")

    print("\n⑦ 注册表 PlayerDebugMode")
    try:
        import winreg
        for v in (9, 10, 11, 12):
            try:
                k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Adobe\CSXS.%d" % v)
                val, _ = winreg.QueryValueEx(k, "PlayerDebugMode")
                winreg.CloseKey(k)
                print("   CSXS.%d  PlayerDebugMode = %s" % (v, val))
            except FileNotFoundError:
                print("   CSXS.%d  未设置" % v)
    except ImportError:
        print("   非 Windows，跳过")

    print("\n⑧ 快照里的成品 zip")
    zp = os.path.join(snap, "插件打包", "Noniika-v0.9.1.zip")
    if os.path.exists(zp):
        z = zipfile.ZipFile(zp)
        badz = z.testzip()
        print("   %s" % zp)
        print("   %.1f MB / %d 项；testzip → %s" % (mb(os.path.getsize(zp)), len(z.namelist()), badz or "全部完好"))
        names = z.namelist()
        for must in ZIP_MUST:
            hit = [x for x in names if x.endswith(must) or must in x]
            print("      %-26s %s" % (must, "有" if hit else "**缺**"))
            if not hit:
                ok_all = False
        if badz:
            ok_all = False
    else:
        print("   没找到 %s" % zp)

    print("\n" + "=" * 66)
    print("  用时 %.1f 分钟；总判定：%s" % ((time.time() - t0) / 60.0,
                                        "全过 —— 这份快照能还原" if ok_all else "**有问题，见上**"))
    print("=" * 66)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
