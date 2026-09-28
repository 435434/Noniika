"""验证：把 pip 装的 nvidia 库目录全部注入 PATH 后，ORT 能否真正启用 CUDA。

背景：onnxruntime-gpu 在 Windows 上加载 onnxruntime_providers_cuda.dll 时依赖
cublasLt64_13.dll 等；pip 把它们放在 site-packages/nvidia 下，而 Windows 的
DLL 搜索路径不含那里 —— 结果是**静默降级到 CPU**（不抛异常，最难发现）。

注意路径布局（新版 nvidia 包不是 <pkg>/bin）：
    nvidia/cu13/bin/x86_64/   ← cublas64_13 / cublasLt64_13 / cudart64_13 / cufft64_12 ...
    nvidia/cudnn/bin/         ← cudnn64_9 / cudnn_adv64_9 ...
所以要用**递归扫描含 dll 的目录**，不能写死 <pkg>/bin。
"""
import os
import sys

base = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")

print("=== 扫描 nvidia 库目录 ===")
bin_dirs = []
if os.path.isdir(base):
    for root, dirs, files in os.walk(base):
        if any(f.lower().endswith(".dll") for f in files):
            bin_dirs.append(root)
            print("  %s  (%d 个 dll)" % (os.path.relpath(root, base), len([f for f in files if f.lower().endswith(".dll")])))
else:
    print("  没有", base)

if not bin_dirs:
    print("❌ 找不到 CUDA 库目录")
    sys.exit(1)

print()
print("=== 注入 PATH 后实测（%d 个目录）===" % len(bin_dirs))
os.environ["PATH"] = os.pathsep.join(bin_dirs) + os.pathsep + os.environ.get("PATH", "")

import onnxruntime as ort  # noqa: E402

print("  onnxruntime:", ort.__version__)
model = os.path.join("models", "uvr", "Kim_Vocal_2.onnx")
try:
    so = ort.SessionOptions()
    so.log_severity_level = 3
    s = ort.InferenceSession(model, sess_options=so, providers=["CUDAExecutionProvider"])
    used = s.get_providers()
    print("  实际 provider:", used)
    print("  " + ("✅ 真正跑在 GPU 上" if used and used[0] == "CUDAExecutionProvider" else "❌ 仍降级到 CPU"))
except Exception as e:
    print("  建会话失败:", type(e).__name__, str(e)[:200])

print()
print("=== torch 状态（决定 Roformer / Demucs 能否走 GPU）===")
try:
    import torch
    print("  torch:", torch.__version__, "| CUDA 可用:", torch.cuda.is_available())
except Exception as e:
    print("  读取失败:", e)
