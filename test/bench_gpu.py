"""GPU 加速实测：同一素材、同一模型，强制 CPU 与 CUDA 各跑一次，给出准确倍率。

为什么要"强制"而不是各跑一次 CLI：
  audio-separator 会自动选设备，环境里装好 CUDA 后就没法再用 CLI 复现纯 CPU 基线了。
  这里直接操纵 Separator 的 torch_device / onnx_execution_provider，把变量控制住，
  两次跑的是同一份代码、同一素材、同一模型 —— 差异只来自运算设备。

用法：
    python test/bench_gpu.py <音频路径> [模型文件名]
"""
import json
import os
import sys
import time

# ── 注入运行环境：CUDA 库目录 + ffmpeg ──
# 产品代码里这些是 separate.js 的 envWithRuntimeDirs 干的，
# 直接跑 Python 脚本就得自己补，否则 audio-separator 会死在启动检查上。
_extra = []

# ① pip 装的 CUDA 库（否则 ORT 静默降级到 CPU —— 本项目头号坑）
base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
if os.path.isdir(base):
    for root, dirs, files in os.walk(base):
        if any(f.lower().endswith(".dll") for f in files):
            _extra.append(root)

# ② ffmpeg / ffprobe（在 pipeline 的 node_modules 里）
for pkg in ("@ffmpeg-installer/win32-x64", "@ffprobe-installer/win32-x64"):
    d = os.path.join("pipeline", "node_modules", *pkg.split("/"))
    if os.path.isdir(d):
        _extra.append(os.path.abspath(d))

if _extra:
    os.environ["PATH"] = os.pathsep.join(_extra) + os.pathsep + os.environ.get("PATH", "")
print("已注入路径：", len(_extra), "个")

import torch  # noqa: E402
from audio_separator.separator import Separator  # noqa: E402

audio = sys.argv[1] if len(sys.argv) > 1 else "test/output/bench-input.wav"
model = sys.argv[2] if len(sys.argv) > 2 else "Kim_Vocal_2.onnx"
# 第三个参数可选：只跑某一侧（大模型在 CPU 上要跑很久，没必要陪着等）
only = sys.argv[3] if len(sys.argv) > 3 else "both"

os.makedirs("test/output/bench", exist_ok=True)

print("=" * 62)
print("环境")
print("=" * 62)
print("  torch          :", torch.__version__)
print("  CUDA 可用       :", torch.cuda.is_available())
if torch.cuda.is_available():
    print("  显卡           :", torch.cuda.get_device_name(0))
    print("  显存           : %.1f GB" % (torch.cuda.get_device_properties(0).total_memory / 1024 ** 3))
import onnxruntime as ort  # noqa: E402
print("  onnxruntime    :", ort.__version__)
print("  ORT providers  :", ort.get_available_providers())
dur = None
try:
    import wave
    with wave.open(audio) as w:
        dur = w.getnframes() / float(w.getframerate())
except Exception:
    pass
print("  素材           :", audio, ("(%.2f 秒)" % dur) if dur else "")
print("  模型           :", model)


def run(dev):
    """dev: 'cpu' | 'cuda'"""
    sep = Separator(
        model_file_dir="models/uvr",
        output_dir="test/output/bench",
        output_format="WAV",
        log_level=40,
    )
    sep.torch_device = torch.device(dev)
    sep.torch_device_cpu = torch.device("cpu")
    if dev == "cpu":
        sep.onnx_execution_provider = ["CPUExecutionProvider"]
    else:
        sep.onnx_execution_provider = ["CUDAExecutionProvider"]

    sep.load_model(model_filename=model)
    t0 = time.time()
    files = sep.separate(audio)
    dt = time.time() - t0

    # 确认真的走了预期的 provider
    used = None
    for attr in ("onnx_execution_provider", "onnx_exec_provider"):
        v = getattr(sep, attr, None)
        if v:
            used = v
            break
    return dt, files, used


res = {}
for dev in ("cpu", "cuda"):
    if only != "both" and dev != only:
        continue
    print()
    print("-" * 62)
    print("跑 %s …" % dev.upper())
    print("-" * 62)
    try:
        dt, files, used = run(dev)
        res[dev] = {"sec": round(dt, 2), "ok": True, "provider": used, "files": files}
        print("  用时 %.2f 秒  (%.2fx 素材时长)" % (dt, (dt / dur) if dur else 0))
        print("  provider:", used)
        print("  产物:", files)
    except Exception as e:
        res[dev] = {"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300])}
        print("  失败:", res[dev]["error"])

print()
print("=" * 62)
print("结论")
print("=" * 62)
c, g = res.get("cpu"), res.get("cuda")
if c and c.get("ok") and g and g.get("ok"):
    a, b = c["sec"], g["sec"]
    print("  CPU : %.2f 秒" % a)
    print("  CUDA: %.2f 秒" % b)
    print("  → GPU 快 %.1f 倍" % (a / b if b else 0))
    if dur:
        print("  → CPU %.2fx 素材时长 / GPU %.2fx 素材时长" % (a / dur, b / dur))
elif g and not g.get("ok"):
    print("  ⚠ GPU 那一次失败：", g.get("error"))
elif c and not c.get("ok"):
    print("  ⚠ CPU 那一次失败：", c.get("error"))
else:
    for k, v in res.items():
        if v.get("ok"):
            print("  %-5s 用时 %.2f 秒%s" % (k.upper(), v["sec"],
                  ("  (%.2fx 素材时长)" % (v["sec"] / dur)) if dur else ""))

with open("test/output/bench/result.json", "w", encoding="utf-8") as f:
    json.dump({"audio": audio, "model": model, "durationSec": dur, "result": res}, f,
              ensure_ascii=False, indent=2)
print()
print("  报告: test/output/bench/result.json")
