/**
 * separate.js —— 人声分离（调用本地 audio-separator）
 * ==========================================================
 * 为什么用 audio-separator 而不是直接调 Ultimate Vocal Remover：
 *   - UVR 官方**没有在维护的命令行入口**（仓库里的 inference.py 属于 2021 年的 v5-beta 分支，
 *     不兼容新模型包），做界面自动化又脆弱又版本敏感。
 *   - audio-separator 用的是同一批 UVR / MDX / Demucs 模型和同一套推理引擎，
 *     但有正经的 CLI、持续维护、纯命令行可脚本化。这才是"本地跑 UVR"的正确姿势。
 *
 * 关键事实（2026-09 从官方 README 核实，别按记忆写）：
 *   - 模型参数是 `-m` / `--model_filename`（**不是** --model_name）
 *   - 默认输出格式是 FLAC，所以要显式传 `--output_format WAV`
 *   - 输出文件名形如 `<原名>_(Vocals)_<模型名>.wav`
 *   - 只下模型不分离：`--download_model_only`
 *   - pip extras 是 cpu / gpu / dml（CUDA 走 gpu）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { getFfmpegPath } from "./paths.js";

/** 允许的分离目标 */
export const TARGETS = ["vocals", "instrumental", "both"];

/**
 * 组装子进程环境变量：把 ffmpeg 与 CUDA 运行库的目录都前置进 PATH。
 *
 * ① ffmpeg：audio-separator 启动时会跑 `subprocess.check_output(["ffmpeg", "-version"])`，
 *    实测 Windows 的子进程搜索**不包含**调用者 exe 所在目录（只有 PATH 兜底），
 *    而我们的 ffmpeg 在 pipeline/node_modules 里 —— 不注入它就死在启动检查上。
 *
 * ② CUDA 运行库：**GPU 加速能否生效，全看这一步。**
 *    onnxruntime-gpu 加载 onnxruntime_providers_cuda.dll 时依赖 cublasLt64_13.dll /
 *    cudnn64_9.dll 等，而 pip 把这些库放在 <venv>/Lib/site-packages/nvidia 下，
 *    Windows 的 DLL 搜索路径**不含**那里。后果极其隐蔽：
 *    ORT 不抛异常，只是**静默降级到 CPU** —— 看起来就是"GPU 加速没起作用"。
 *    实测：注入前 provider 是 ['CPUExecutionProvider']，注入后才是
 *    ['CUDAExecutionProvider', 'CPUExecutionProvider']。
 */
function envWithRuntimeDirs(exe, extraEnv) {
  const env = { ...process.env, ...(extraEnv || {}) };
  const dirs = [];

  try {
    const ff = getFfmpegPath();
    if (ff && fs.existsSync(ff)) dirs.push(path.dirname(ff));
  } catch { /* 没有 ffmpeg 时让它自然报错，信息更全 */ }

  for (const d of findCudaLibDirs(exe)) dirs.push(d);

  if (dirs.length) {
    env.PATH = dirs.join(path.delimiter) + path.delimiter + (env.PATH || "");
  }
  return env;
}

/** PIP 装的 CUDA 库目录缓存（每个 exe 问一次就够） */
const _cudaDirCache = new Map();

/**
 * 找出 pip 装的 CUDA 运行库目录。
 *
 * ⚠ 不要写死 `<pkg>/bin`：新版 nvidia 包的布局是
 *     nvidia/cu13/bin/x86_64/   ← cublas64_13 / cublasLt64_13 / cudart64_13 / cufft64_12
 *     nvidia/cudnn/bin/         ← cudnn64_9 / cudnn_adv64_9 …
 *   所以这里递归扫描"含 dll 的目录"，布局变了也不用改。
 */
function findCudaLibDirs(exe) {
  const key = String(exe || "");
  if (_cudaDirCache.has(key)) return _cudaDirCache.get(key);

  const found = [];
  const bases = [];
  try {
    const scriptDir = path.dirname(exe);                    // <venv>/Scripts
    bases.push(path.join(path.dirname(scriptDir), "Lib", "site-packages", "nvidia"));
  } catch { /* ignore */ }
  try {
    // 兼容"非 venv 的全局安装"：python.exe 就在安装根下
    bases.push(path.join(path.dirname(exe), "Lib", "site-packages", "nvidia"));
  } catch { /* ignore */ }

  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      if (entries.some((e) => e.isFile() && /\.dll$/i.test(e.name))) found.push(cur);
      for (const e of entries) {
        if (e.isDirectory()) stack.push(path.join(cur, e.name));
      }
    }
  }

  _cudaDirCache.set(key, found);
  return found;
}

/* ------------------------------------------------------------------ 小工具 */

function run(exe, args, opts = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      // opts.env 由调用方显式给时就以它为基底；无论如何都要把 ffmpeg 与 CUDA 库目录并进 PATH
      const { env: userEnv, ...rest } = opts;
      p = spawn(exe, args, { windowsHide: true, env: envWithRuntimeDirs(exe, userEnv), ...rest });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e.message || e) });
      return;
    }
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString("utf8"); });
    p.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      err += s;
      if (typeof opts.onLine === "function") {
        s.split(/\r?\n/).forEach((line) => { if (line.trim()) opts.onLine(line.trim()); });
      }
    });
    p.on("error", (e) => resolve({ code: -1, out, err: String(e.message || e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** 把 Windows 路径里的反斜杠统一成正斜杠，避免拼进 JSON 后再转义出错 */
function norm(p) {
  return String(p || "").replace(/\\/g, "/");
}

/* ------------------------------------------------------------------ 环境探测 */

/**
 * 找一个可用的 Python。
 * 顺序：用户指定 → 项目内 venv → PATH 上的 python / py
 */
export function candidatePythons(hint, pipelineDir) {
  const list = [];
  if (hint) list.push(path.resolve(hint));

  // 项目根目录下的独立环境（面板的"一键安装环境"就装在这儿）
  const root = path.resolve(pipelineDir || ".", "..");
  list.push(path.join(root, "python-env", "Scripts", "python.exe"));
  list.push(path.join(root, "python-env", "bin", "python"));

  if (process.platform === "win32") {
    list.push("python.exe");
    list.push("python");
    list.push("py");
  } else {
    list.push("python3");
    list.push("python");
  }
  return list;
}

async function probePython(exe) {
  const r = await run(exe, ["-c", "import sys;print(sys.version.split()[0])"]);
  if (r.code !== 0) return null;
  const v = String(r.out).trim().split(/\r?\n/).pop().trim();
  return v || "?";
}

async function probePackage(exe) {
  // 一次拿版本 + 可执行文件位置，省一次进程往返
  const code =
    "import json,shutil\n" +
    "info={'ok':True,'version':'','cli':''}\n" +
    "try:\n" +
    "    import audio_separator as a\n" +
    "    info['version']=str(getattr(a,'__version__','') or getattr(a,'VERSION','') or 'unknown')\n" +
    "except Exception as e:\n" +
    "    info={'ok':False,'error':str(e)}\n" +
    "info['cli']=shutil.which('audio-separator') or ''\n" +
    "print(json.dumps(info))\n";
  const r = await run(exe, ["-c", code]);
  if (r.code !== 0) return { ok: false, error: String(r.err || "").slice(-300) };
  const line = String(r.out).trim().split(/\r?\n/).pop().trim();
  try { return JSON.parse(line); } catch { return { ok: false, error: "无法解析探测输出" }; }
}

/**
 * 探测运算设备。
 *
 * ⚠ 两个后端必须**分开看**，只报一个 "device" 会误导：
 *     torch  —— Roformer / Demucs 这些 .ckpt 模型走它
 *     onnx   —— MDX-Net 那些 .onnx 模型走 onnxruntime（**与 torch 完全独立**）
 *
 * 而 `get_available_providers()` 只说明"编译时带了 CUDA"，**不代表运行时能加载**：
 * Windows 上缺 cublasLt64_13.dll（pip 把 CUDA 库放在 site-packages/nvidia 下，
 * 不在系统 DLL 搜索路径里）时，ORT 会**不报错、直接降级到 CPU**。
 *
 * 所以这里**真的建一个会话**去问它最终用了哪个 provider —— 这是唯一能抓到
 * "静默降级"的办法。模型用内联的 65 字节最小 ONNX（Identity），零体积零依赖。
 * （别用 ctypes 加载 provider dll 来判断：实测它会在 ORT 明明可用时报失败，
 *   因为 ctypes 的依赖解析路径和 ORT 内部不一致，会得出相反的结论。）
 *
 * @returns {Promise<null|{device:string, torch:string, onnx:string, onnxRuntime:string[], gpuName:string, torchVersion:string}>}
 */
async function probeDevice(exe) {
  // 一个最小的 ONNX 模型（单 Identity 节点，65 字节），只用来试探 provider。
  // ⚠ IR 版本必须是 9：新版本 onnx 默认生成 IR 14，而 ORT 1.30 最高只支持 13，
  //   会直接报 Unsupported model IR version，从而把好好的 GPU 误判成 CPU。
  const MINI_ONNX_B64 =
    "CAk6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCBAoAEA0=";

  const code = [
    "import json, base64",
    "r = {'torch':'cpu','onnx':'cpu','onnxProviders':[],'onnxRuntime':[]," +
      "'gpuName':'','torchVersion':''}",
    "try:",
    "    import torch",
    "    r['torchVersion'] = torch.__version__",
    "    if torch.cuda.is_available():",
    "        r['torch'] = 'cuda'",
    "        try: r['gpuName'] = torch.cuda.get_device_name(0)",
    "        except Exception: pass",
    "except Exception: pass",
    "try:",
    "    import onnxruntime as ort",
    "    ps = [str(p) for p in ort.get_available_providers()]",
    "    r['onnxProviders'] = ps",
    "    if 'CUDAExecutionProvider' in ps:",
    "        try:",
    "            so = ort.SessionOptions()",
    "            so.log_severity_level = 3",
    "            s = ort.InferenceSession(base64.b64decode('" + MINI_ONNX_B64 + "'),",
    "                                     sess_options=so," +
      " providers=['CUDAExecutionProvider'])",
    "            used = [str(x) for x in s.get_providers()]",
    "            r['onnxRuntime'] = used",
    "            r['onnx'] = 'cuda' if (used and used[0] == 'CUDAExecutionProvider') else 'cpu'",
    "        except Exception as e:",
    "            r['onnx'] = 'cpu'",
    "            r['onnxError'] = str(e)[:200]",
    "except Exception: pass",
    "print(json.dumps(r))",
  ].join("\n");

  const r = await run(exe, ["-c", code]);
  if (r.code !== 0) return null;
  try {
    const o = JSON.parse(String(r.out).trim().split(/\r?\n/).pop().trim());
    // 兼容旧字段：只要有一侧能上 GPU 就算 cuda
    o.device = (o.torch === "cuda" || o.onnx === "cuda") ? "cuda" : "cpu";
    return o;
  } catch { return null; }
}

/**
 * 检测人声分离的本地依赖。
 * @returns {Promise<object>} 面板直接拿去渲染状态灯
 */
export async function detectUvr({ pythonHint, pipelineDir, modelFileDir, model } = {}) {
  const tried = [];
  let python = null, pyVer = null;

  for (const exe of candidatePythons(pythonHint, pipelineDir)) {
    tried.push(exe);
    const v = await probePython(exe);
    if (v) { python = exe; pyVer = v; break; }
  }

  if (!python) {
    return {
      found: false,
      tried: tried,
      hint: pythonHint
        ? `指定的 Python 跑不起来：${pythonHint}`
        : "没在 PATH 上找到 python。装一个 Python 3.9+，或在面板「Python」格里填上 python.exe 的完整路径。",
    };
  }

  const pkg = await probePackage(python);
  const result = {
    found: true,
    python: norm(python),
    pythonVersion: pyVer,
    installed: !!pkg.ok,
    version: pkg.version || null,
    cliPath: pkg.cli ? norm(pkg.cli) : "",
    modelsDir: norm(modelFileDir || defaultModelDir(pipelineDir)),
    model: model || null,
    device: null,
    error: pkg.ok ? null : String(pkg.error || "").slice(0, 300) || null,
  };

  if (result.installed) {
    result.device = await probeDevice(python);
    if (!result.cliPath) {
      // 退一步：console script 就在 python 旁边
      const guess = python.replace(/python(\.exe)?$/i, "audio-separator.exe");
      if (guess !== python && exists(guess)) result.cliPath = norm(guess);
    }
  }
  return result;
}

/** 模型放在项目里，看得见、好清理、卸载时不会留下散落文件 */
export function defaultModelDir(pipelineDir) {
  const root = path.resolve(pipelineDir || ".", "..");
  return path.join(root, "models", "uvr");
}

/* ------------------------------------------------------------------ 分离 */

/** 从 audio-separator 的输出里按 stem 名找出实际文件 */
function pickStem(files, stem) {
  const re = new RegExp(`\\(${stem}\\)`, "i");
  return files.find((f) => re.test(path.basename(f))) || null;
}

/**
 * 跑一次人声分离。
 *
 * @param {object} o
 * @param {string} o.input      输入媒体（视频/音频都行）
 * @param {string} o.outDir     输出目录（分离产物写这里）
 * @param {string} o.workDir    临时目录
 * @param {string} o.python     python 可执行文件
 * @param {string} [o.cliPath]  audio-separator 可执行文件（优先用）
 * @param {string} o.model      模型文件名
 * @param {string} o.format     输出格式 WAV/FLAC/MP3
 * @param {string} [o.modelFileDir] 模型目录
 * @param {"vocals"|"instrumental"|"both"} o.target 要哪一轨
 * @param {Function} [o.onLine] 日志行回调
 * @returns {Promise<object>} { ok, chosen, vocals, instrumental, files, elapsedSec, cmd }
 */
export async function separate(o) {
  const target = TARGETS.includes(o.target) ? o.target : "vocals";
  const modelDir = o.modelFileDir || defaultModelDir(o.pipelineDir);
  try { fs.mkdirSync(o.workDir, { recursive: true }); } catch { }
  try { fs.mkdirSync(modelDir, { recursive: true }); } catch { }

  const exe = o.cliPath && exists(o.cliPath) ? o.cliPath : o.python;
  const pre = exe === o.python ? ["-m", "audio_separator"] : [];

  const args = [
    ...pre,
    path.resolve(o.input),
    "-m", o.model,
    "--output_dir", path.resolve(o.workDir),
    "--output_format", o.format || "WAV",
    "--model_file_dir", path.resolve(modelDir),
  ];

  const t0 = Date.now();
  const r = await run(exe, args, { onLine: o.onLine });

  // 无论成功失败，都把产物扫一遍（audio-separator 有时报错但文件已写出）
  let files = [];
  try {
    files = fs.readdirSync(o.workDir)
      .map((f) => path.join(o.workDir, f))
      .filter((f) => fs.statSync(f).isFile());
  } catch { }

  const vocals = pickStem(files, "Vocals");
  const instrumental = pickStem(files, "Instrumental") || pickStem(files, "Instrumental_");

  if (!vocals && !instrumental) {
    const tail = String(r.err || "").trim().split(/\r?\n/).slice(-6).join(" | ").slice(-500);
    return {
      ok: false,
      error: `人声分离失败（退出码 ${r.code}）。${tail || "没有产出任何文件"}`,
      cmd: [exe, ...args].join(" "),
    };
  }

  let chosen = null;
  if (target === "vocals") chosen = vocals || instrumental;
  else if (target === "instrumental") chosen = instrumental || vocals;
  else chosen = vocals || instrumental;

  // MP3 之类的有损格式也允许，但识别效果逊于无损
  return {
    ok: true,
    target,
    chosen,
    vocals,
    instrumental,
    files,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    cmd: [exe, ...args].join(" "),
  };
}

/** 只下载模型（不分离），给面板的「下载模型」按钮用 */
export async function downloadModel(o) {
  const modelDir = o.modelFileDir || defaultModelDir(o.pipelineDir);
  try { fs.mkdirSync(modelDir, { recursive: true }); } catch { }
  const exe = o.cliPath && exists(o.cliPath) ? o.cliPath : o.python;
  const pre = exe === o.python ? ["-m", "audio_separator"] : [];
  const args = [...pre, "-m", o.model, "--download_model_only", "--model_file_dir", path.resolve(modelDir)];
  const r = await run(exe, args, { onLine: o.onLine });
  return { ok: r.code === 0, code: r.code, modelDir: norm(modelDir), cmd: [exe, ...args].join(" ") };
}

/* 注意：这里**没有**"清理分离产物"的函数。
   人声是交付产物（面板要把它加进 AE 时间线，图层引用的是磁盘文件），必须长期保留；
   伴奏的去留由 cli.js 按 --separate-keep 决定。 */
