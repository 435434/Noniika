"""
独立核验一个分发包（zip）
==========================================================
用法： python tools/audit-package.py [zip路径]
      不给路径就自动找 插件打包/ 里最新的那个 zip

和 build-package.py 里的"出厂自检"是**两个视角**：
  · 出厂自检 = 打包脚本在复制完、打 zip 之前自己查一遍（防止打进去不该有的东西）
  · 本脚本   = 对**已经生成好的 zip** 从外部再查一遍（防止打包脚本本身有盲区，
               或者你拿到别人给的包想先验一验）
两者都通过，才算真的干净。

退出码：0 = 通过；1 = 有问题（可接进自动化）
"""
import os
import re
import sys
import zipfile

DEFAULT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "插件打包")

MEDIA_EXT = (".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".webm", ".m4v", ".mpg", ".mpeg",
             ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".aiff", ".aif",
             ".onnx", ".ckpt", ".pth", ".pt", ".safetensors",
             ".ttf", ".otf", ".ttc", ".woff", ".woff2")
DEV_MARKERS = ("/.workbuddy/", "/test/", "/design/", "/tools/", "/node_modules/",
               "/models/", "/python-env/", "/插件备份/", "/.git/")
TEXT_EXT = (".js", ".mjs", ".json", ".jsx", ".jsxbin", ".html", ".css", ".md",
            ".txt", ".bat", ".xml", ".yml", ".yaml")
SECRET_RX = [
    ("sk- 风格密钥", re.compile(rb"sk-[A-Za-z0-9]{20,}")),
    ("腾讯云 SecretId", re.compile(rb"AKID[A-Za-z0-9]{16,}")),
    ("Bearer 令牌", re.compile(rb"Bearer\s+[A-Za-z0-9\-_.]{24,}")),
    ("写成字面量的密钥", re.compile(
        rb"(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*[\"'][A-Za-z0-9\-_]{16,}[\"']", re.I)),
]
BENIGN = re.compile(
    rb"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    rb"|sk-fake|your[_-]?key|placeholder|<[^>]*key[^>]*>|xxx", re.I)
MUST_HAVE = ("index.html", "css/style.css", "js/main.js", "jsx/ae-bridge.jsxbin",
             "pipeline/cli.js", "pipeline/vendor/ffmpeg/ffmpeg.exe",
             "pipeline/vendor/ffmpeg/LICENSE.txt", "node-runtime/node.exe",
             "node-runtime/LICENSE", "LICENSE", "THIRD-PARTY-NOTICES.md")


def pick_zip():
    if not os.path.isdir(DEFAULT_DIR):
        return None
    zs = [os.path.join(DEFAULT_DIR, f) for f in os.listdir(DEFAULT_DIR)
          if f.lower().endswith(".zip")]
    return max(zs, key=os.path.getmtime) if zs else None


def main():
    zp = sys.argv[1] if len(sys.argv) > 1 else pick_zip()
    if not zp or not os.path.isfile(zp):
        print("找不到 zip（可传路径：python tools/audit-package.py <zip>）")
        return 1

    z = zipfile.ZipFile(zp)
    ns = [n.replace("\\", "/") for n in z.namelist()]
    print("核验对象：%s" % os.path.basename(zp))
    print("压缩包 %.1f MB ／ 解包后 %d 个条目" % (os.path.getsize(zp) / 1048576, len(ns)))
    print()

    problems = []

    media = [(n, z.getinfo(n).file_size) for n in ns if n.lower().endswith(MEDIA_EXT)]
    print("① 素材 / 模型 / 字体：%d 个" % len(media))
    for n, s in media:
        print("     ⚠ %s  %.2f MB" % (n, s / 1048576))
        problems.append("含素材/模型/字体：" + n)
    if not media:
        print("     ✓ 一个都没有（测试视频、音频、模型权重、字体都没有）")

    dev = [n for n in ns if any(m in "/" + n for m in DEV_MARKERS)]
    print("② 开发物料：%d 个" % len(dev))
    for n in dev[:10]:
        print("     ⚠", n)
        problems.append("含开发物料：" + n)
    if not dev:
        print("     ✓ 一个都没有（.workbuddy / test / design / tools / node_modules / models 等都不在）")

    print("③ 密钥字面量（只扫文本文件；二进制里的随机匹配是噪音，不在此判）：")
    ntext = nfound = 0
    for n in ns:
        if not n.lower().endswith(TEXT_EXT):
            continue
        ntext += 1
        data = z.read(n)
        for label, rx in SECRET_RX:
            for m in rx.finditer(data):
                if BENIGN.search(m.group(0)):
                    continue
                nfound += 1
                print("     ⚠ %s → %s：%s" % (n, label, m.group(0)[:50]))
                problems.append("疑似密钥：" + n)
    if not nfound:
        print("     ✓ 未发现（已扫 %d 个文本文件）" % ntext)

    print("④ 该有的文件：")
    for need in MUST_HAVE:
        ok = any(n == need or n.endswith("/" + need) for n in ns)
        if not ok:
            print("     ✗ 缺 " + need)
            problems.append("缺文件：" + need)
        else:
            print("     ✓ " + need)
    if any(n.endswith("jsx/ae-bridge.jsx") for n in ns):
        print("     ⚠ 包里出现了**明文** ae-bridge.jsx（应只保留 .jsxbin）")
        problems.append("明文 jsx 未剔除")
    else:
        print("     ✓ 明文 jsx 已剔除")

    print()
    print("=" * 56)
    if problems:
        print("核验未通过，共 %d 项：" % len(problems))
        for p in problems:
            print("   · " + p)
        return 1
    print("核验通过：素材/模型/字体 0、开发物料 0、密钥 0、许可文件齐全。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
