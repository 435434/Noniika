/**
 * providers/local.js —— 本地 Whisper（whisper.cpp）适配器
 * ==================================================================
 * 为什么要有这一家：
 *   云端 ASR 走"音频上传 → 结果回来"这条路，对**隐私敏感**或**离线环境**就不成立；
 *   而且免费云端接口随时可能改口径。本地这条路把"识别"彻底搬回本机：
 *   音频不出硬盘、断网也能跑。
 *
 * 代价（面板里必须如实告诉用户，别只讲好处）：
 *   · 模型要占磁盘（small 466 MB / medium 1.5 GB / large-v3-turbo 1.6 GB）；
 *   · 纯 CPU 跑很慢（10 分钟素材可能十几到几十分钟），有 N 卡会快十几倍；
 *   · 中文精度上，medium 与免费云端基本同一档，别指望"本地方案更准"——
 *     它换来的是隐私与稳定，不是准确率。
 *
 * 权重**不随插件打包**（合规与体积双重考虑），由用户在面板里按需下载。
 * whisper.cpp 本体是 MIT，可以随包或让用户自取。
 *
 * 目录约定（都挂在「数据目录」下，跟 python-env / models 同级）：
 *   数据目录/whisper.cpp/whisper-cli.exe      ← 可执行文件（也认 main.exe）
 *   数据目录/models/whisper/ggml-<档位>.bin   ← 模型权重
 * 两个位置都可以用环境变量覆盖：AESUB_WHISPER_EXE / AESUB_WHISPER_MODEL。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { toAsrAudio, tempPathIn } from "../ffmpeg.js";
import { detectSpeechIntervals, regroupTokensBySpeech } from "../speech.js";
import { download, downloadGithubAsset, downloadRanged, githubAsset, remoteSize } from "../fetch.js";

export const id = "local";
export const label = "本地模型（离线）";

/** 三个档位。数值取 ggml 官方发布的实际体积，给用户一个"多久能下完"的心理预期。 */
export const MODELS = [
  { id: "small", ggml: "ggml-small.bin", sizeMB: 466, note: "快，适合快速出稿" },
  { id: "medium", ggml: "ggml-medium.bin", sizeMB: 1530, note: "中文够用（推荐）" },
  { id: "large-v3-q5_0", ggml: "ggml-large-v3-q5_0.bin", sizeMB: 1100, note: "量化 · 质量高于 medium，比 turbo 小 1/3" },
  { id: "large-v3-turbo", ggml: "ggml-large-v3-turbo.bin", sizeMB: 1620, note: "最准，最慢" },
];

export const DEFAULT_MODEL = "medium";

export const profiles = [
  {
    id: "whisper-cpp",
    label: "本地 Whisper",
    engine: "whisper.cpp",
    model: DEFAULT_MODEL,
    // 不需要密钥 —— 面板见到 needsKey:false + keyMode:"none" 会自动收起密钥行
    needsKey: false,
    keyMode: "none",
    // whisper.cpp 的 -oj 会给句级时间戳，所以不像免费云端档那样要重建时间轴
    timestamps: "segments",
    freeNote: "完全离线，音频不出本机",
    reachableInCn: true,
    // 本地没有上传上限，也不该被压缩（压缩只会损精度）
    maxFileBytes: 0,
    maxDurationSec: 0,
    preferCompressed: false,
    altModels: MODELS.map((m) => ({ id: m.id, note: `${m.sizeMB} MB · ${m.note}` })),
  },
];

export function getProfile(profileId) {
  return profiles.find((p) => p.id === profileId) || profiles[0];
}

/* ------------------------------------------------------------------ 环境探测 */

/** 可执行文件候选（相对「数据目录」；也支持 AESUB_WHISPER_EXE 直接指定） */
const EXE_CANDIDATES = [
  path.join("whisper.cpp", "whisper-cli.exe"),
  path.join("whisper.cpp", "main.exe"),
  // ⚠ 官方 Windows 包解出来在 **Release/ 子目录**里（实测 zip 内就是 Release\main.exe + ggml*.dll），
  //   所以这两个候选必须有，否则"下完了解压了却找不到 exe"。
  path.join("whisper.cpp", "Release", "whisper-cli.exe"),
  path.join("whisper.cpp", "Release", "main.exe"),
  path.join("whisper.cpp", "build", "bin", "Release", "whisper-cli.exe"),
  path.join("whisper.cpp", "build", "bin", "Release", "main.exe"),
  path.join("whisper.cpp", "build", "bin", "whisper-cli.exe"),
  path.join("whisper.cpp", "build", "bin", "main"),
  path.join("whisper", "whisper-cli.exe"),
  path.join("whisper", "main.exe"),
];

/**
 * 数据目录的兜底来源。
 *
 * 为什么不从函数参数拿就算了：`lib/asr.js` 派发转写时只传
 * {providerId, profileId, credentials, model, baseUrl, language, prompt, file, …}，
 * **没有数据目录**。而数据目录在面板里是可配置的，provider 不该去猜。
 * 于是统一走环境变量 AESUB_DATA_DIR（面板起子进程时注入）——
 * 这与「密钥只走环境变量」是同一条约定，不另外开口子。
 */
function defaultDataDir() {
  const env = (process.env.AESUB_DATA_DIR || "").trim();
  return env || process.cwd();
}

/** 找 whisper.cpp 的可执行文件；找不到返回空串（调用方负责给出人话提示） */
export function resolveExe(dataDir) {
  const env = (process.env.AESUB_WHISPER_EXE || "").trim();
  if (env && fs.existsSync(env)) return env;
  const roots = [dataDir || defaultDataDir(), process.cwd()].filter(Boolean);
  for (const r of roots) {
    for (const rel of EXE_CANDIDATES) {
      const p = path.join(r, rel);
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* 权限之类的问题直接跳过这个候选 */ }
    }
  }
  return "";
}

/** 模型存放目录：<数据目录>/models/whisper */
export function modelDir(dataDir) {
  return path.join(dataDir || defaultDataDir(), "models", "whisper");
}

/** 找某个档位的模型文件；找不到返回空串 */
export function resolveModel(dataDir, modelId) {
  const env = (process.env.AESUB_WHISPER_MODEL || "").trim();
  const mid = MODELS.some((m) => m.id === modelId) ? modelId : DEFAULT_MODEL;
  if (env && fs.existsSync(env)) {
    // 环境变量只覆盖"默认档"；换档位时仍按文件名找，避免张冠李戴
    const want = MODELS.find((m) => m.id === mid);
    if (want && path.basename(env) === want.ggml) return env;
    if (mid === DEFAULT_MODEL) return env;
  }
  const d = modelDir(dataDir);
  const hit = path.join(d, MODELS.find((m) => m.id === mid).ggml);
  try {
    return fs.existsSync(hit) ? hit : "";
  } catch {
    return "";
  }
}

/** 数据目录里已经下过哪些档位 */
export function downloadedModels(dataDir) {
  const d = modelDir(dataDir);
  const out = [];
  for (const m of MODELS) {
    try {
      const p = path.join(d, m.ggml);
      if (fs.existsSync(p)) out.push({ id: m.id, path: p, sizeMB: +((fs.statSync(p).size / 1048576).toFixed(0)) });
    } catch { /* 忽略 */ }
  }
  return out;
}

/** 是不是 CUDA 构建 —— 只做"同目录有没有 CUDA 运行库"这种保守判断，绝不假装知道 */
function probeCuda(exe) {
  if (!exe) return { ok: false, detail: "还没找到 whisper.cpp" };
  const dir = path.dirname(exe);
  let names = [];
  try {
    names = fs.readdirSync(dir).map((x) => x.toLowerCase());
  } catch {
    return { ok: false, detail: "读不到 whisper.cpp 所在目录" };
  }
  const hit = names.find((n) => /^(ggml-cuda|cudart64_|cublas64_|cudnn)/.test(n));
  return hit
    ? { ok: true, detail: "检测到 CUDA 运行库（" + hit + "）" }
    : { ok: false, detail: "同目录没有 CUDA 运行库，可能是 CPU 构建" };
}

/** 本地环境快照 —— 面板的「本地状态网格」用的就是这份 */
export function status({ dataDir } = {}) {
  const dir = dataDir || defaultDataDir();
  const exe = resolveExe(dir);
  const models = downloadedModels(dir);
  const def = resolveModel(dir, DEFAULT_MODEL);
  const cuda = probeCuda(exe);
  const ready = !!(exe && def);
  return {
    ok: ready,
    dataDir: dir,
    exe: { path: exe, ok: !!exe },
    modelDir: modelDir(dir),
    downloaded: models,
    current: { id: DEFAULT_MODEL, path: def, ok: !!def },
    cuda,
    models: MODELS.map((m) => ({ id: m.id, sizeMB: m.sizeMB, note: m.note, ggml: m.ggml })),
    detail: ready
      ? "本地引擎已就绪（" + path.basename(exe) + " + ggml-" + DEFAULT_MODEL + ".bin）"
      : (!exe
        ? "还没装 whisper.cpp 可执行文件 —— 见「本地版本」说明里的放置路径"
        : "还没下载模型权重（" + path.basename(def || MODELS.find((m) => m.id === DEFAULT_MODEL).ggml) + "）"),
  };
}

/** 面板「测试」按钮走这条：只做本地检查，不联网、不花钱 */
export async function ping({ dataDir } = {}) {
  const st = status({ dataDir });
  return { ok: st.ok, detail: st.detail };
}

/** 「可用模型清单」= 本地三个档位（不走网络） */
export async function listModels() {
  return {
    ok: true,
    models: MODELS.map((m) => m.id),
    total: MODELS.length,
    filteredOut: 0,
    source: "builtin",
    detail: "本地引擎的档位是固定的三个；在「本地版本」里选，没下载的会先提示下载。",
  };
}

/* ------------------------------------------------------------------ 转写 */

function run(exe, args, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      cwd: cwd || undefined,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || "");
        err.stderr = String(stderr || "");
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    child.on("error", reject);
  });
}

/**
 * ⚠⚠ Windows 上跑 whisper.cpp 的**头号坑：argv 里的中文会被打烂**。
 *
 * 实测（2026-09-29）：数据目录是 `…\Desktop\AE字幕插件\models\whisper\ggml-large-v3-turbo.bin` 时，
 * 传 `-m <那个绝对路径>` 过去，whisper.cpp 打印出来的是
 *   `loading model from 'C:\Users\kunku\Desktop\AE??Ļ???\models\whisper\…'`
 * 因为它是 C++ 的 `main(int, char**)`，在 Windows 上按 **ANSI 代码页（GBK）** 解 argv，
 * 而 Node 传的是 UTF-8 字节 ⇒ 路径对不上 ⇒ 直接"加载模型失败"。
 * （可执行文件路径本身没事：那是 CreateProcessW 的宽字符 API 处理的。）
 *
 * 所以两条规矩：
 *  1. **模型**：把 cwd 切到模型所在目录（cwd 走 CreateProcessW，Unicode 安全），
 *     参数里只给**文件名**；
 *  2. **音频与输出**：一律放纯 ASCII 的临时目录（默认的 %TEMP% 就是 ASCII；
 *     用户名是中文的机器才需要退路，见 asciiWorkDir()）。
 */
function hasNonAscii(s) {
  return /[^\x00-\x7F]/.test(String(s || ""));
}

/** 找一个**纯 ASCII 且可写**的工作目录（给 whisper.cpp 的 -f / -of 用） */
function asciiWorkDir() {
  const cands = [
    process.env.TEMP,
    process.env.TMP,
    os.tmpdir(),
    path.join(process.env.SystemDrive || "C:", "Windows", "Temp"),
    path.join(process.env.SystemDrive || "C:", "aesub-tmp"),
  ].filter(Boolean);
  for (const d of cands) {
    if (hasNonAscii(d)) continue;
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch { /* 换下一个 */ }
  }
  return os.tmpdir();   // 实在没有纯 ASCII 目录 —— 只能硬上，失败时下面的报错会点明原因
}

/**
 * 转写单个音频文件（**不联网**）。
 *
 * @param {object} p
 * @param {string} p.file        输入音频（任意 ffmpeg 认的格式）
 * @param {string} p.dataDir     数据目录（找 exe 与模型）
 * @param {string} [p.model]     档位 id：small / medium / large-v3-turbo
 * @param {string} [p.language]  语言，默认 zh
 * @param {boolean} [p.gpu]      是否用显卡（false ⇒ 加 -ng 强制 CPU）
 * @returns {Promise<{text:string, segments:Array|null, raw:object}>}
 */
export async function transcribeFile(p) {
  const {
    file, dataDir, model, language = "zh",
    timeoutMs = 4 * 60 * 60 * 1000, onProgress,
  } = p;

  // 「用显卡跑」开关也走环境变量（面板起子进程时注入 AESUB_WHISPER_NO_GPU=1 表示强制 CPU）——
  // 与密钥同一条约定，避免为它单独在 asr.js / cli.js 上加参数链。
  const gpu = p.gpu === undefined ? process.env.AESUB_WHISPER_NO_GPU !== "1" : !!p.gpu;

  if (!file || !fs.existsSync(file)) throw new Error(`音频文件不存在：${file}`);

  const exe = resolveExe(dataDir);
  if (!exe) {
    throw new Error(
      "没找到 whisper.cpp 可执行文件。请把 whisper.cpp 放在数据目录下的 whisper.cpp\\ 里" +
      "（认 whisper-cli.exe 与 main.exe），或用环境变量 AESUB_WHISPER_EXE 指定完整路径。"
    );
  }

  const mid = MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
  const mf = resolveModel(dataDir, mid);
  if (!mf) {
    const want = MODELS.find((m) => m.id === mid);
    throw new Error(
      `本地模型还没下载：${want.ggml}（约 ${want.sizeMB} MB）。` +
      `放到 ${modelDir(dataDir)} 下即可，或用环境变量 AESUB_WHISPER_MODEL 指定。`
    );
  }

  // whisper.cpp 吃 16 kHz 单声道 wav —— 复用流水线现成的转码（同一套 ffmpeg 解析逻辑）
  // ⚠ 工作目录必须纯 ASCII（见文件上方那段注释：whisper.cpp 在 Windows 上按 GBK 解 argv）
  const work = asciiWorkDir();
  const stem = "aesub-local-" + Date.now();
  const wav = tempPathIn(work, stem, ".wav");
  const outPrefix = path.join(work, stem);
  if (onProgress) onProgress({ stage: "decode", percent: 0 });

  try {
    await toAsrAudio(file, wav, {});
  } catch (e) {
    throw new Error("转 16 kHz 音频失败（本地引擎需要它）：" + (e && e.message ? e.message : e));
  }

  // 模型：cwd 切到模型目录 + 只传文件名（这样 argv 里一个非 ASCII 字符都没有）
  let runCwd;
  let modelArg = mf;
  if (hasNonAscii(mf)) {
    runCwd = path.dirname(mf);
    modelArg = path.basename(mf);
  }
  if (hasNonAscii(wav) || hasNonAscii(outPrefix)) {
    throw new Error(
      "临时目录路径里有中文/非 ASCII 字符（" + work + "），whisper.cpp 在 Windows 上认不了。" +
      "把系统 TEMP 指到一个纯英文路径（或设 AESUB_TMP 环境变量）再试。"
    );
  }

  // ⚠⚠ 千万**不要**加 `-nt`（--no-timestamps）！
  //    实测（2026-09-29，34 秒 / 5 句的测试音频）：
  //      · 带 -nt  ⇒ **2 句**，每句横跨 30 秒整（等于整段挤成一条字幕图层）
  //      · 不带 -nt ⇒ **16 句**，逐句带真实时间戳 ✅
  //    原因：-nt 关掉时间戳 token 后，whisper 每个 30 秒窗口只吐一段。
  const args = ["-m", modelArg, "-f", wav, "-l", language, "-ojf", "-of", outPrefix];
  if (gpu === false) args.push("-ng");   // 强制走 CPU

  // ⚠ 「提示词」（whisper `--prompt`）曾经接过，2026-09-30 **按用户实测撤掉**：
  //   同一素材 11.6 秒中文，加上提示词后**分离人声**（本插件的主线用法）错误率反而上升
  //   （CER 2.9% → 5.9%；换成"人名表"式提示词更差：2.9% → 11.8%~14.7%）。
  //   原因：whisper 的 prompt 是"**上文延续**"语义，不是词汇表。
  //   ⇒ 要再接，先在**你自己的素材批次**上量一遍错误率再决定，别凭直觉开。

  if (onProgress) onProgress({ stage: "transcribe", percent: 5 });
  try {
    await run(exe, args, timeoutMs, runCwd);
  } catch (e) {
    const tail = String((e && (e.stderr || e.stdout)) || "").trim().split(/\r?\n/).slice(-3).join(" / ");
    const hint = /load(ing)? (the )?model|failed to (load|open)|no such file/i.test(tail)
      ? "（提示：模型文件没被正确读到 —— 数据目录里若有中文，路径已自动规避；再不行请把数据目录放到纯英文路径）"
      : "";
    throw new Error("whisper.cpp 执行失败：" + (tail || (e && e.message) || "未知错误") + hint);
  }

  const jsonPath = outPrefix + ".json";
  let raw = null;
  try {
    // ⚠⚠ **必须按 latin1（逐字节）读，不能用 utf8** —— 实测踩过：
    //    whisper 的中文 token 是**按字节切的**，一个汉字常被劈成两个 token：
    //      「优」= E4 BC 98  →  token1 = b'\xe4\xbc'（2 字节）+ token2 = b'\x98'（1 字节）
    //    每个 token 的 text 单独看都是**半截 UTF-8 序列**。若按 utf8 读文件，这些半截字节
    //    会在读入时就被替换成 U+FFFD（显示即 `?`），于是 `-ojf` 拼出来的字幕里
    //    **有的字好好的、有的变成问号**（位置随机 —— 取决于模型怎么切 token）。
    //    按 latin1 读 = 每个字符对应一个原始字节，之后自己攒齐再解码，一个字都不会丢。
    raw = JSON.parse(fs.readFileSync(jsonPath, "latin1"));
  } catch (e) {
    throw new Error("whisper.cpp 没有产出 JSON（" + path.basename(jsonPath) + "）—— 该版本的 -ojf 参数可能不同，请换较新的 whisper.cpp");
  }

  // 把 latin1 的字节串还原成正常文本；若本来就是正常 Unicode（个别版本会写 \uXXXX 转义），原样返回
  const dec = (s) => {
    const str = String(s == null ? "" : s);
    return /[\u0100-\uffff\ufffd]/.test(str) ? str : Buffer.from(str, "latin1").toString("utf8");
  };
  /** buffer 末尾若停在"半截 UTF-8 序列"上，返回该序列的起始位置；完整则返回 -1 */
  const incompleteTail = (buf) => {
    const n = buf.length;
    for (let k = 1; k <= 3 && k <= n; k++) {
      const b = buf[n - k];
      if ((b & 0x80) === 0) return -1;                    // ASCII → 完整
      if ((b & 0xc0) === 0xc0) {                          // 多字节序列的首字节
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        return k < need ? n - k : -1;
      }
    }
    return -1;
  };

  const tr = Array.isArray(raw.transcription) ? raw.transcription : [];

  // 引擎自己给的段落 —— **只当兜底**：它会跨过停顿把两句并成一段，边界能差 2~3 秒（实测）。
  const engineSegments = [];
  const tokens = [];
  // ⚠ seg（段落序号）必须带上：speech.js 的切分**以引擎段落为语义单位**
  //   —— 详见 speech.js 里 regroupTokensBySpeech 的「第二课」。
  for (let si = 0; si < tr.length; si++) {
    const s = tr[si];
    const off = s.offsets || {};
    const text = dec(s.text).trim();
    if (text) {
      engineSegments.push({
        text,
        startMs: Number(off.from == null ? 0 : off.from),
        endMs: Number(off.to == null ? 0 : off.to),
      });
    }

    // -ojf 才会带 tokens：每个词都有毫秒级 offsets —— 时间精度全靠它。
    // 文字则要"攒齐一个完整字符再收"：半截字节先攥在手里，等下一个 token 凑完整。
    let pend = Buffer.alloc(0);
    let pendFrom = null;
    for (const tk of Array.isArray(s.tokens) ? s.tokens : []) {
      const bt = String(tk.text == null ? "" : tk.text);
      if (!bt || bt.indexOf("[_") === 0 || bt.indexOf("<|") === 0) continue;   // 滤掉 [_BEG_] / <|...|>
      const to = tk.offsets || {};
      if (to.from == null || to.to == null) continue;
      const from = Number(to.from);
      const toMs = Number(to.to);

      // 已经是正常 Unicode（不吃 latin1 那一套）就直接用
      if (/[\u0100-\uffff\ufffd]/.test(bt)) {
        tokens.push({ text: bt, startMs: from, endMs: toMs, seg: si });
        continue;
      }

      if (pendFrom === null) pendFrom = from;
      pend = Buffer.concat([pend, Buffer.from(bt, "latin1")]);
      const cut = incompleteTail(pend);
      if (cut >= 0) {
        const head = pend.slice(0, cut).toString("utf8");
        pend = pend.slice(cut);
        if (head) tokens.push({ text: head, startMs: pendFrom, endMs: toMs, seg: si });
        // 半截部分还没有文字，但起点时间先留着：下一个 token 凑齐时用它当起点
      } else {
        tokens.push({ text: pend.toString("utf8"), startMs: pendFrom, endMs: toMs, seg: si });
        pend = Buffer.alloc(0);
        pendFrom = null;
      }
    }
    if (pend.length) {
      const tail = pend.toString("utf8").replace(/\ufffd/g, "");
      if (tail) tokens.push({ text: tail, startMs: pendFrom == null ? 0 : pendFrom, endMs: 0, seg: si });
    }
  }

  // ⭐ 时间轴对齐：用「逐词时间戳 ＋ 静音检测出的讲话区间」重新切 —— 让字幕出入点贴住说话出入点。
  //    实测（真语音 + 1.5 秒停顿）：引擎段落平均偏 起点 2.5s / 终点 3.2s，对齐后 0.02s / 0.00s。
  //    ⚠ 任何一步失败都**必须退回引擎段落** —— 对齐是锦上添花，不能让"能不能出字幕"被它拖累。
  let segments = engineSegments;
  let timing = "engine";
  let zones = 0;
  try {
    if (tokens.length) {
      if (onProgress) onProgress({ stage: "align", percent: 0 });
      // 16 kHz 单声道 16 bit → 每秒 32000 字节，直接算时长，省一次 ffprobe
      const wavSec = Math.round((fs.statSync(wav).size / 32000) * 100) / 100;
      const sp = await detectSpeechIntervals(wav, {
        durationSec: wavSec,
        silenceDb: -35,        // 分离后的人声比原音轨干净，-35dB 比默认 -32dB 更贴
        minSilenceSec: 0.35,   // 0.35 秒以上才算"句间停顿"；再短会把换气也切开
      });
      zones = sp && sp.intervals ? sp.intervals.length : 0;
      const regrouped = regroupTokensBySpeech(tokens, sp && sp.intervals, { maxChars: 16 });
      if (regrouped.length) {
        segments = regrouped;
        timing = "speech";
      }
    }
  } catch (e) {
    if (onProgress) {
      onProgress({ stage: "align", percent: 100, message: "时间轴对齐跳过（用引擎段落）：" + ((e && e.message) || e) });
    }
  }
  if (onProgress) onProgress({ stage: "align", percent: 100 });

  // 清掉自己的临时文件（wav 可能几百 MB，别留着）
  for (const f of [wav, jsonPath]) {
    try { fs.unlinkSync(f); } catch { /* 删不掉就算了，系统临时目录会自己清 */ }
  }

  if (onProgress) onProgress({ stage: "transcribe", percent: 100 });

  return {
    text: segments.map((s) => s.text).join(""),
    segments: segments.length ? segments : null,
    raw: {
      engine: "whisper.cpp",
      model: mid,
      gpu,
      language: (raw && raw.result && raw.result.language) || language,
      // 时间轴来源：speech = 已按"讲话区间 + 逐词"对齐（出入点贴住说话）；engine = 退回引擎段落
      timing,
      speechZones: zones,
      tokens: tokens.length,
    },
  };
}

/* ------------------------------------------------------------------ 下载（二进制 + 权重） */

/** whisper.cpp 官方仓库。⚠ 走 api.github.com，见 lib/fetch.js 顶部那两条实测约束 */
export const GH_REPO = "ggml-org/whisper.cpp";

/**
 * 二进制变体。
 *
 * ⚠ tag 固定用 v1.8.0：实测**新版 v1.9.x 的 release 里一个二进制资产都没有**（只有源码包），
 *   而 v1.8.0 / v1.7.6 有完整的 Windows x64 资产（含 CUDA 12.4 版）。
 *   b5130 那种滚动 tag 也有，但资产命名会变 —— 固定 tag 更稳。
 */
export const VARIANTS = [
  {
    id: "cuda", label: "CUDA 12.4（N 卡推荐）", tag: "v1.8.0",
    asset: "whisper-cublas-12.4.0-bin-x64.zip", sizeMB: 429,
    note: "解压后约 1 GB；需 NVIDIA 驱动（本机 4060 合适）",
  },
  {
    id: "blas", label: "CPU · BLAS（通用，快一些）", tag: "v1.8.0",
    asset: "whisper-blas-bin-x64.zip", sizeMB: 16,
    note: "不挑硬件，速度中等",
  },
  {
    id: "cpu", label: "CPU · 纯（最小）", tag: "v1.8.0",
    asset: "whisper-bin-x64.zip", sizeMB: 4,
    note: "体积最小、速度最慢，适合先试通链路",
  },
];
/**
 * 默认变体 = blas（不是 cuda）。
 *
 * 理由不是"blas 更好"，而是**当前网络现实**：实测本机到 GitHub CDN 约 43 KB/s，
 * CUDA 包 429 MB 要 1~2 小时；blas 只有 16 MB（约几分钟）。默认值要给"第一次就能成功"
 * 的那个 —— 想要 GPU 的用户在面板里换成 cuda 即可（我们支持断点续传，可以慢慢下）。
 */
export const DEFAULT_VARIANT = "blas";

/**
 * 模型源：**hf-mirror 优先**（HuggingFace 官方在国内直连不通）。
 * 302 会跳到 S3 预签名 URL（1 小时有效）⇒ 每次都重新解析，不要缓存直链。
 *
 * 实测（2026-09-29，1.5 GB 权重）：两个镜像速度**互相追赶**（309 KB/s vs 444 KB/s 来回换），
 * 换源解决不了慢的问题 —— 真正有效的是**多连接并发 + 两个源分摊块**。
 * 两源同一区间的 sha256 已核对一致，所以可以混着下、也可以跨源续传。
 */
export const HF_MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"];
const HF_REPO = "ggerganov/whisper.cpp";
/** 魔搭（阿里云）镜像 —— 有人在国内分发过同一批 ggml 文件，字节与 hf-mirror 一致 */
const MS_BASE = "https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master";

/** 一个模型文件的所有可用源（按优先级） */
export function modelUrls(file) {
  return [
    HF_MIRRORS[0] + "/" + HF_REPO + "/resolve/main/" + file,
    MS_BASE + "/" + file,
    HF_MIRRORS[1] + "/" + HF_REPO + "/resolve/main/" + file,
  ];
}

function variantBy(id) {
  return VARIANTS.find((v) => v.id === id) || VARIANTS[VARIANTS.length - 1];
}

/** Windows 自带的 bsdtar（支持 zip）。⚠ 不能依赖 PATH 里的 `tar` —— 见下面注释 */
const SYS_TAR = "C:\\Windows\\System32\\tar.exe";

/**
 * 解 zip。两级尝试：① 系统自带 bsdtar ② PowerShell 的 Expand-Archive。
 *
 * ⚠⚠ 两个实测坑，别改回去：
 *  1. **不能用 PATH 里的 `tar`**：Git Bash 带的是 **GNU tar，不认 zip**
 *     （报 `This does not look like a tar archive`）—— 必须用绝对路径调 System32 的 bsdtar。
 *  2. **不能用 `tar -xf <zip> -C <目标>`**：bsdtar 会把 `-C C:\...` 的盘符当成远程主机
 *     （报 `Cannot connect to C: resolve failed`）。
 *     ⇒ 改成"zip 放进目标目录 + 相对文件名 + cwd 切过去"。
 */
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const name = path.basename(zipPath);
  const local = path.join(destDir, name);
  if (path.resolve(zipPath) !== path.resolve(local)) fs.copyFileSync(zipPath, local);

  let err = null;
  if (fs.existsSync(SYS_TAR)) {
    try {
      await run(SYS_TAR, ["-xf", name], 15 * 60 * 1000, destDir);
    } catch (e) {
      err = e;
    }
  } else {
    err = new Error("系统里没有 " + SYS_TAR);
  }

  if (err) {   // 退路：PowerShell（命名参数没有盘符歧义）
    try {
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
         "Expand-Archive -LiteralPath " + q(local) + " -DestinationPath " + q(destDir) + " -Force"],
        15 * 60 * 1000
      );
      err = null;
    } catch (e2) {
      err = e2;
    }
  }

  if (err) {
    throw new Error(
      "解压失败（系统 tar 与 PowerShell 都试过）：" + (err && err.message ? err.message : err) +
      "。也可以手动把 " + local + " 解到 " + destDir
    );
  }
  // 只有成功才清 zip（失败时留着，方便手动处理或重试）
  try { fs.unlinkSync(local); } catch { /* 删不掉留着也无妨 */ }
}

/**
 * 下 whisper.cpp 的 Windows 二进制并解压到 `<数据目录>/whisper.cpp/`。
 * 下完会**真的找一遍 exe** —— 找不到就报错，不假装装好了。
 */
export async function fetchWhisper({ variant, dataDir, onProgress } = {}) {
  const v = variantBy(variant);
  const root = dataDir || defaultDataDir();
  const dir = path.join(root, "whisper.cpp");
  const zip = path.join(dir, "_" + v.asset);
  fs.mkdirSync(dir, { recursive: true });

  if (onProgress) onProgress({ stage: "download", what: "whisper", percent: 0, message: "开始下载 " + v.asset });
  // 先多连接分段下（CUDA 包 429 MB，单连接要几小时）；万一这个源不吃 Range 就退回单连接
  const meta = await githubAsset(GH_REPO, v.tag, v.asset);
  let r;
  try {
    r = await downloadRanged({
      urls: [meta.apiUrl],
      dest: zip,
      headers: { Accept: "application/octet-stream" },
      expectBytes: meta.size,
      connections: 8,
      chunkBytes: 16 * 1048576,
      onProgress: (p) => {
        if (onProgress) onProgress({ stage: "download", what: "whisper", ...p, message: "下载 " + v.asset });
      },
    });
  } catch (e) {
    if (onProgress) {
      onProgress({
        stage: "download", what: "whisper", percent: 0,
        message: "分段下载不可用，改用单连接（" + ((e && e.message) || e).slice(0, 60) + "）",
      });
    }
    r = await download({
      url: meta.apiUrl,
      dest: zip,
      headers: { Accept: "application/octet-stream" },
      expectBytes: meta.size,
      onProgress: (p) => {
        if (onProgress) onProgress({ stage: "download", what: "whisper", ...p, message: "下载 " + v.asset });
      },
    });
  }

  if (onProgress) onProgress({ stage: "extract", what: "whisper", percent: 0, message: "解压中…" });
  await extractZip(zip, dir);
  try { fs.unlinkSync(zip); } catch { /* 删不掉留着也无妨 */ }

  const exe = resolveExe(root);
  if (!exe) {
    throw new Error(
      "解压完成但没找到可执行文件 —— 看看 " + dir + " 里有没有 whisper-cli.exe / main.exe，" +
      "有些版本解出来在子目录里，把它连同 dll 一起挪到 whisper.cpp\\ 下即可"
    );
  }
  if (onProgress) onProgress({ stage: "done", what: "whisper", percent: 100, message: "已就位：" + path.basename(exe) });
  return { ok: true, exe, dir, variant: v.id, bytes: r.bytes, skipped: !!r.skipped };
}

/**
 * 下某个档位的模型权重。
 *
 * 策略（实测驱动，别改回单连接）：**先探测各源体积 → 只保留字节数一致的源 → 多连接分段并发下**。
 * 单连接实测 60~450 KB/s（波动剧烈），8 连接并发 1.4~3.5×；断块只重下那一块，且能接管
 * 之前单连接下了一半的文件（用户已经下过几百 MB 的情况不浪费）。
 */
export async function fetchModel({ model, dataDir, onProgress, connections } = {}) {
  const mid = MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
  const meta = MODELS.find((m) => m.id === mid);
  const root = dataDir || defaultDataDir();
  const dir = modelDir(root);
  const dest = path.join(dir, meta.ggml);
  fs.mkdirSync(dir, { recursive: true });

  // ① 探测各源：既要"能拿到体积"，又要"体积与第一个可用源一致"（防止拼出坏文件）
  const alive = [];
  let expect = 0;
  for (const url of modelUrls(meta.ggml)) {
    const sz = await remoteSize(url);
    if (!sz) continue;
    if (!expect) { expect = sz; alive.push(url); }
    else if (sz === expect) alive.push(url);
  }
  if (!alive.length) {
    throw new Error(
      "拿不到模型体积：所有镜像都不通（hf-mirror / 魔搭 / huggingface 都试过了）。" +
      "检查一下网络，或手动把 " + meta.ggml + " 放到 " + dir
    );
  }

  if (onProgress) {
    onProgress({
      stage: "download", what: "model", percent: 0, total: expect, got: 0,
      message: "下载 " + meta.ggml + "（" + (expect / 1048576).toFixed(0) + " MB · " +
        alive.length + " 个源 · 8 连接并发）",
    });
  }

  const r = await downloadRanged({
    urls: alive,
    dest,
    expectBytes: expect,
    connections: connections || 8,
    chunkBytes: 16 * 1048576,
    onProgress: (p) => {
      if (onProgress) onProgress({ stage: "download", what: "model", ...p, message: "下载 " + meta.ggml });
    },
  });
  if (onProgress) {
    onProgress({ stage: "done", what: "model", percent: 100, message: "已下载：" + meta.ggml });
  }
  return { ok: true, path: dest, model: mid, bytes: r.bytes, skipped: !!r.skipped, sources: alive };
}
