#!/usr/bin/env node
/**
 * cli.js —— Noniika · 命令行流水线
 * ==========================================================
 * 职责单一：把「媒体文件」变成「带时间戳的字幕文件」。
 * 不碰 After Effects —— 导出音频由 ExtendScript 负责，建字幕图层也由 ExtendScript 负责。
 * 这样它就能完全脱离 AE 单独跑、单独测（符合"先命令行跑通"的开发习惯）。
 *
 * 用法：
 *   node cli.js --in <媒体文件> [选项]
 *
 * 选项：
 *   --in        <path>   必需。输入媒体文件（视频或音频均可）
 *   --out       <dir>    输出目录，默认与输入文件同目录
 *   --name      <stem>   产物文件名主干，默认取输入文件名
 *   --offset-ms <n>      字幕时间轴整体平移 n 毫秒（AE 按图层范围导出时用来补偏移）
 *   --max-chars <n>      字幕每行最大字数，默认 16
  --separate-only      只做人声分离就结束：不转码、不上传、不识别、不写字幕产物。
                       需要配合 --separate；产出路径在结果的 separate 字段里。
                       面板首页的「分离人声」按钮走的就是这条路。
  --no-snap-speech     关闭"按真实语音时长校正句子边界"（默认开启）。
                       开启时用 ffmpeg 对识别用的音频做静音检测，把每句起止校正到
                       真实语音区间（±0.8 秒内、不短于 0.35 秒、不与相邻句重叠）
 *   --drop-suspect       丢弃"疑似误识别"段（默认只标记不丢弃）
 *   --strip-punct        去掉字幕里的标点符号（默认保留）
 *   --words              输出词级字幕（默认句级）
 *   --keep-wav           保留中间转码的 WAV（排障用）
 *   --timeout-min <n>    等待识别结果的最长分钟数，默认 15
 *   --progress-json      进度以 JSON 行输出（供 CEP 面板解析）
 *   --quiet              不输出进度
 *   --help               显示帮助
 *
 * 识别引擎（**服务商无关**，实现在 lib/providers/）：
 *   --asr-provider <id>  openai-compat（默认）| tencent
 *   --asr-profile  <id>  档位：siliconflow（默认，免费）| groq | custom | tencent
 *   --api-key <key>      单密钥服务商的 API Key（也可用环境变量 AESUB_API_KEY）
 *   --secret-id <id>     ┐ 腾讯云这对密钥（也可用 AESUB_SECRET_ID / AESUB_SECRET_KEY）
 *   --secret-key <key>   ┘
 *   --asr-model <m>      覆盖档位默认模型
 *   --asr-base-url <u>   覆盖档位默认地址（自建服务用）
 *   --asr-language <l>   语言提示，默认 zh
 *   --no-chunk-asr       禁止切块（只调一次接口，时间轴靠语音区间近似分配）
 *   --keep-chunks        保留切块用的临时音频（排障）
 *   --list-asr           只列出所有可用引擎档位（JSON），然后退出 —— 面板用来渲染下拉框
 *
 * 输出约定：
 *   进度  → stderr（人可读，或 --progress-json 时的 JSON 行）
 *   结果  → stdout 单个 JSON 对象（面板直接 JSON.parse 即可）
 *   退出码 → 0 成功；1 失败（错误详情在 stderr 与 stdout 的 error 字段里）
 */

import fs from "node:fs";
import path from "node:path";
import { checkDependencies } from "./lib/paths.js";
import {
  probeMedia, toAsrAudio, toSeparateInput, pickUploadFormat, tempPathIn,
  UPLOAD_LIMIT_BYTES, MP3_BITRATE_KBPS,
} from "./lib/ffmpeg.js";
import {
  detectUvr, separate, downloadModel, defaultModelDir,
} from "./lib/separate.js";
import {
  DEFAULT_PROFILE, DEFAULT_PROVIDER,
  listAsrModels, listAsrProfiles, pingAsr, providerLimits, transcribeAudio,
} from "./lib/asr.js";
import {
  normalizeSegments,
  markSuspectSegments,
  splitToWordSegments,
  shiftSegments,
  removePunctuation,
  toSrt,
  toPlainText,
  summarize,
} from "./lib/postprocess.js";
import { detectSpeechIntervals, snapSegmentsToSpeech } from "./lib/speech.js";

/* ------------------------------------------------------------------ 参数解析 */

function parseArgs(argv) {
  const o = {
    input: null, outDir: null, maxChars: 16, dropSuspect: false, words: false,
    stripPunct: false,
    keepWav: false, timeoutMin: 15, progressJson: false, quiet: false, help: false,
    separate: false, name: null, offsetMs: 0,
    // 人声分离相关
    separateTarget: "vocals", separateModel: "Kim_Vocal_2.onnx", separateFormat: "WAV",
    separatePython: null, separateKeep: false, checkUvr: false, downloadModel: null,
    snapSpeech: true,          // 按真实语音时长校正句子边界（默认开）
    separateOnly: false,       // 只做分离：分离完就收工，不上传、不识别、不写字幕产物
    modelFileDir: null, uvrGpu: false,
    // ---- 识别引擎（服务商无关）----
    // 密钥优先取命令行，其次取环境变量 —— 面板会把用户在界面上填的值通过命令行传进来，
    // 而命令行/CI 场景可以直接用环境变量，避免把密钥写进日志或进程列表。
    asrProvider: process.env.AESUB_ASR_PROVIDER || DEFAULT_PROVIDER,
    asrProfile: process.env.AESUB_ASR_PROFILE || DEFAULT_PROFILE,
    apiKey: process.env.AESUB_API_KEY || null,
    secretId: process.env.AESUB_SECRET_ID || null,
    secretKey: process.env.AESUB_SECRET_KEY || null,
    asrModel: process.env.AESUB_ASR_MODEL || null,
    asrBaseUrl: process.env.AESUB_ASR_BASE_URL || null,
    asrLanguage: process.env.AESUB_ASR_LANGUAGE || "zh",
    asrPrompt: null,
    chunkAsr: true,            // 允许按静音切块（免费档没有时间戳时靠它重建时间轴）
    keepChunks: false,
    listAsr: false,
    asrPing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数`);
      return v;
    };
    switch (a) {
      case "--in": case "-i": o.input = next(); break;
      case "--out": case "-o": o.outDir = next(); break;
      case "--name": o.name = next(); break;
      case "--offset-ms": o.offsetMs = Math.round(Number(next())) || 0; break;
      case "--max-chars": o.maxChars = Number(next()); break;
      case "--timeout-min": o.timeoutMin = Number(next()); break;
      case "--drop-suspect": o.dropSuspect = true; break;
      case "--strip-punct": o.stripPunct = true; break;
      case "--words": o.words = true; break;
      case "--keep-wav": o.keepWav = true; break;
      case "--progress-json": o.progressJson = true; break;
      case "--quiet": o.quiet = true; break;
      case "--separate": o.separate = true; break;
      case "--snap-speech": o.snapSpeech = true; break;
      case "--no-snap-speech": o.snapSpeech = false; break;
      case "--separate-target": o.separateTarget = next(); break;
      case "--separate-model": o.separateModel = next(); break;
      case "--separate-format": o.separateFormat = next(); break;
      case "--separate-python": o.separatePython = next(); break;
      case "--separate-keep": o.separateKeep = true; break;
      case "--separate-only": o.separateOnly = true; break;
      case "--model-file-dir": o.modelFileDir = next(); break;
      case "--uvr-gpu": o.uvrGpu = true; break;
      case "--check-uvr": o.checkUvr = true; break;
      case "--download-model": o.downloadModel = next(); break;
      // ---- 识别引擎 ----
      case "--asr-provider": o.asrProvider = next(); break;
      case "--asr-profile": o.asrProfile = next(); break;
      case "--api-key": o.apiKey = next(); break;
      case "--secret-id": o.secretId = next(); break;
      case "--secret-key": o.secretKey = next(); break;
      case "--asr-model": o.asrModel = next(); break;
      case "--asr-base-url": o.asrBaseUrl = next(); break;
      case "--asr-language": o.asrLanguage = next(); break;
      case "--asr-prompt": o.asrPrompt = next(); break;
      case "--no-chunk-asr": o.chunkAsr = false; break;
      case "--keep-chunks": o.keepChunks = true; break;
      case "--list-asr": o.listAsr = true; break;
      case "--asr-ping": o.asrPing = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`未知选项：${a}（用 --help 查看用法）`);
    }
  }
  return o;
}

const HELP = `Noniika · 命令行流水线

用法：
  node cli.js --in <媒体文件> [选项]

选项：
  --in        <path>   必需。输入媒体文件（视频或音频均可）
  --out       <dir>    输出目录，默认与输入文件同目录
  --name      <stem>   产物文件名主干，默认取输入文件名
  --offset-ms <n>      把字幕时间轴整体平移 n 毫秒（默认 0）。
                       AE 按图层范围导出音频时，音频文件的时间 0 秒对应合成的时间 offsetSec 秒；
                       面板会把 offsetSec×1000 传进来，让字幕落在合成时间轴的正确位置上。
  --max-chars <n>      字幕每行最大字数，默认 16
  --drop-suspect       丢弃"疑似误识别"段（默认只标记不丢弃）
  --strip-punct        去掉字幕里的标点符号（默认保留；数字里的小数点、千分位不受影响）
  --words              输出词级字幕（默认句级）
  --keep-wav           保留中间转码的 WAV（排障用）
  --timeout-min <n>    等待识别结果的最长分钟数，默认 15
  --progress-json      进度以 JSON 行输出
  --quiet              不输出进度
  --help               显示本帮助

识别引擎（服务商无关；默认用免费的硅基流动档）：
  --list-asr                     列出全部可用档位（JSON）后退出
  --asr-ping                     **只测密钥**并顺带拉取"当前可用模型清单"：
                                 不消耗识别额度、不需要 --in。返回里含 models[]
  --asr-provider <id>            openai-compat（默认）/ tencent
  --asr-profile <id>             siliconflow（默认·免费）/ groq / custom / tencent
  --api-key <key>                单密钥服务商的 API Key（或环境变量 AESUB_API_KEY）
  --secret-id / --secret-key     腾讯云那一对密钥（或 AESUB_SECRET_ID / AESUB_SECRET_KEY）
  --asr-model <m>                覆盖档位默认模型
  --asr-base-url <u>             覆盖档位默认地址（自建 OpenAI 兼容服务用）
  --asr-language <l>             语言提示，默认 zh
  --asr-prompt <text>            上下文提示词，能明显改善人名/术语的识别
  --no-chunk-asr                 禁止切块：只调一次接口，时间轴用语音区间近似分配
  --keep-chunks                  保留切块临时音频（排障）

  说明：免费档（SenseVoice）只回文字、不回时间戳，流水线会自动把音频按
        "静音停顿"切成块逐块识别，用块边界重建时间轴（见 lib/align.js）。
        想要一句一句精确对齐，就选回时间戳的档位（tencent / groq）。

人声分离（本地运算，需先装 audio-separator）：
  --separate                     开启：识别前先把人声从背景音乐里分离出来
  --separate-target <t>          vocals（默认，仅人声）/ instrumental（仅伴奏）/ both
  --separate-model <file>        模型文件名，默认 Kim_Vocal_2.onnx
  --separate-format <fmt>        分离输出格式 WAV（默认）/ FLAC / MP3
  --separate-python <path>       指定 python.exe（默认自动找项目内 python-env 或 PATH）
  --separate-keep                连伴奏也保留（人声默认就会保留在 <输出目录>/_人声分离/）
  --model-file-dir <dir>         模型存放目录，默认 <项目根>/models/uvr
  --check-uvr                    只做依赖检测，输出 JSON 后退出（不需要 --in）
  --download-model <file>        只下载指定模型，不分离（不需要 --in）

产物（默认与输入同目录，同名不同后缀）：
  <name>.json   交给 AE 的字幕数据：[{ text, startMs, endMs, suspect? }]
  <name>.srt    通用字幕文件（已按字数断行）
  <name>.txt    纯文本，便于快速目检识别效果
`;

/* ------------------------------------------------------------------ 进度上报 */

function makeReporter(opts) {
  const emit = (type, payload) => {
    if (opts.quiet && type === "progress") return;
    if (opts.progressJson) {
      process.stderr.write(JSON.stringify({ type, ...payload }) + "\n");
    } else if (type === "progress") {
      const pct = typeof payload.percent === "number" ? ` ${String(payload.percent).padStart(3)}%` : "";
      process.stderr.write(`[${payload.step}]${pct} ${payload.message || ""}\n`);
    }
  };
  return {
    step: (step, message, percent) => emit("progress", { step, message, percent }),
    result: (obj) => process.stdout.write(JSON.stringify(obj) + "\n"),
  };
}

/** 统一成正斜杠：JSON 里少一层转义，面板/ExtendScript 都更好处理 */
const norm = (p) => String(p || "").replace(/\\/g, "/");

/**
 * 把"这次到底用哪家、哪个模型"说清楚。
 *
 * 为什么必须带上模型名：用户往往只填了服务商、没填模型（走档位默认），
 * 一旦识别质量不对，光看"用了 siliconflow"根本没法定位 —— 得知道是
 * SenseVoiceSmall 还是 Qwen3-ASR。默认值也要显式标出来，别让人误以为是自己填的。
 */
function describeEngine(meta) {
  if (!meta) return "未知引擎";
  const label = meta.profileLabel || meta.profile || "?";
  const model = meta.model || "(档位未指定模型)";
  return `${label} · 模型 ${model}${meta.modelIsDefault ? "（档位默认）" : ""}`;
}

/**
 * 把识别层返回的 meta 翻译成一句人话，让用户知道**时间轴是怎么来的**。
 * 这件事必须说清楚：用真时间戳和用重构时间轴，精度不是一个量级。
 */
function describeTiming(meta) {
  if (!meta) return "未知来源";
  const n = meta.chunkCount || 1;
  switch (meta.timing) {
    case "upstream":
      return "服务商原始时间戳";
    case "reconstructed-by-chunk":
      return `${n} 块 · 按静音边界重建` + (meta.failedChunks ? `（${meta.failedChunks} 块失败）` : "");
    case "reconstructed":
      return "按语音区间近似分配（无原始时间戳）";
    default:
      return String(meta.timing || "未知来源");
  }
}

/**
 * 把分离产物搬进固定目录并改成可读名字，返回新路径。
 * 改名失败（占用、权限等）时原样返回旧路径 —— 功能不受影响，只是名字丑一点。
 */
function moveArtifact(src, destDir, newBase) {
  if (!src || !fs.existsSync(src)) return src || null;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dst = path.join(destDir, newBase + (path.extname(src) || ".wav"));
    if (path.resolve(src) === path.resolve(dst)) return dst;
    if (fs.existsSync(dst)) fs.unlinkSync(dst);   // 同一素材重跑时覆盖上一轮的
    fs.renameSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.help) { process.stdout.write(HELP); return; }

  // ---- 列出识别引擎档位：面板拿它渲染下拉框，不需要 --in ----
  if (opts.listAsr) {
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: "list-asr",
      default: { provider: DEFAULT_PROVIDER, profile: DEFAULT_PROFILE },
      profiles: listAsrProfiles(),
    }) + "\n");
    return;
  }

  // ---- 密钥自检 + 拉可用模型清单：都不消耗识别额度，也不需要 --in ----
  if (opts.asrPing) {
    const pl = providerLimits(opts.asrProvider, opts.asrProfile);
    const creds = { apiKey: opts.apiKey, secretId: opts.secretId, secretKey: opts.secretKey };
    pingAsr({
      providerId: opts.asrProvider,
      profileId: opts.asrProfile,
      credentials: creds,
      baseUrl: opts.asrBaseUrl,
    }).then(async (r) => {
      // 鉴权通过才顺手去要模型清单：密钥都不对时再问一次只会多一条报错，没有信息量
      let ml = null;
      if (r.ok) {
        try {
          ml = await listAsrModels({
            providerId: opts.asrProvider, profileId: opts.asrProfile,
            credentials: creds, baseUrl: opts.asrBaseUrl,
          });
        } catch (e) {
          ml = { ok: false, models: [], detail: String((e && e.message) || e) };
        }
      }
      process.stdout.write(JSON.stringify({
        ok: !!r.ok, mode: "asr-ping",
        profile: opts.asrProfile,
        profileLabel: pl.label,
        // 顺手把"将会用哪个模型"一并回报，省得用户再问一次
        model: opts.asrModel || pl.defaultModel,
        modelIsDefault: !opts.asrModel,
        baseUrl: opts.asrBaseUrl || pl.defaultBaseUrl,
        detail: r.detail,
        // 可用模型清单（向服务商实时获取；不支持该能力的档位回退到内置清单）
        models: (ml && ml.ok) ? ml.models : [],
        modelsDetail: ml ? ml.detail : "",
        modelsSource: (ml && ml.source) || "provider",
      }) + "\n");
      if (!r.ok) process.exitCode = 1;
    }).catch((e) => {
      process.stdout.write(JSON.stringify({
        ok: false, mode: "asr-ping", profile: opts.asrProfile,
        model: opts.asrModel || pl.defaultModel,
        detail: String((e && e.message) || e),
      }) + "\n");
      process.exitCode = 1;
    });
    return;
  }

  // ---- 依赖检测 / 只下模型：不需要 --in，命中最先处理 ----
  if (opts.checkUvr || opts.downloadModel) {
    const pipelineDir = path.resolve(".");
    const common = {
      pythonHint: opts.separatePython || null,
      pipelineDir,
      modelFileDir: opts.modelFileDir ? path.resolve(opts.modelFileDir) : defaultModelDir(pipelineDir),
    };
    try {
      if (opts.checkUvr) {
        const uvr = await detectUvr({ ...common, model: opts.separateModel });
        process.stdout.write(JSON.stringify({ ok: true, mode: "check-uvr", uvr }) + "\n");
        return;
      }
      const det = await detectUvr({ ...common, model: opts.downloadModel });
      if (!det.installed) {
        process.stdout.write(JSON.stringify({
          ok: false, mode: "download-model", uvr: det,
          error: "人声分离环境还没装好，请先在面板点「一键安装环境」",
        }) + "\n");
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`下载模型 ${opts.downloadModel} …\n`);
      const r = await downloadModel({
        python: det.python, cliPath: det.cliPath, model: opts.downloadModel,
        modelFileDir: common.modelFileDir,
        onLine: (l) => process.stderr.write(`  ${l}\n`),
      });
      process.stdout.write(JSON.stringify({
        ok: r.ok, mode: "download-model", modelDir: r.modelDir,
        error: r.ok ? null : `模型下载失败（退出码 ${r.code}）`,
      }) + "\n");
      if (!r.ok) process.exitCode = 1;
      return;
    } catch (e) {
      process.stdout.write(JSON.stringify({
        ok: false, error: String((e && e.message) || e),
      }) + "\n");
      process.exitCode = 1;
      return;
    }
  }

  if (!opts.input) {
    process.stderr.write("缺少 --in 参数。用 --help 查看用法。\n");
    process.exitCode = 1;
    return;
  }

  const report = makeReporter(opts);
  const t0 = Date.now();
  const inputPath = path.resolve(opts.input);

  if (!fs.existsSync(inputPath)) {
    report.result({ ok: false, error: `输入文件不存在：${inputPath}` });
    process.stderr.write(`输入文件不存在：${inputPath}\n`);
    process.exitCode = 1;
    return;
  }

  const outDir = path.resolve(opts.outDir || path.dirname(inputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 产物名：优先用 --name（面板会传合成名，比 "xxx_audio.aif" 直观得多）
  const stem = opts.name
    ? String(opts.name).replace(/[\\/:*?"<>|]/g, "_")
    : path.basename(inputPath, path.extname(inputPath));
  let tempWav = null;
  let sepWorkDir = null;
  let sepKeepDir = null;
  let sepResult = null;

  try {
    // ---- 依赖体检 ----
    report.step("deps", "检查 ffmpeg / ffprobe", 0);
    const deps = checkDependencies();
    if (!deps.ok) throw new Error(deps.error);

    // ---- 探测媒体 ----
    report.step("probe", "读取媒体信息", 2);
    const media = await probeMedia(inputPath);
    if (!media.hasAudio) throw new Error("该文件里没有音频轨道，无法识别");

    // ---- 人声分离（可选，本地运算）----
    // 放在最前面：先把背景音乐去掉，后面识别拿到的就是干净人声。
    // 输入刻意用 44.1kHz 立体声 WAV —— UVR 系模型是按这个规格训练的，
    // 直接喂 16kHz 单声道会先丢掉高频和立体声信息，分离质量明显打折。
    let asrSource = inputPath;
    let asrCodecHint = media.audioCodec;
    if (opts.separate) {
      report.step("separate-deps", "人声分离：检查本地环境", 4);
      const det = await detectUvr({
        pythonHint: opts.separatePython || null,
        pipelineDir: path.resolve("."),
        modelFileDir: opts.modelFileDir ? path.resolve(opts.modelFileDir) : defaultModelDir(path.resolve(".")),
        model: opts.separateModel,
      });
      if (!det.found) throw new Error(`人声分离不可用：${det.hint || "没找到 Python"}`);
      if (!det.installed) {
        throw new Error(
          "人声分离环境还没装好（缺少 audio-separator）。请到面板「人声分离」页点「一键安装环境」，" +
          "或改成不加 --separate 先跑通识别。"
        );
      }

      report.step("separate-prep", "人声分离：准备 44.1kHz 立体声输入", 6);
      // 分离产物要长期保留（AE 会把它加进时间线，图层引用的是文件路径），
      // 所以给它一个固定、可见的目录；中间输入副本放 _tmp 里，用完连目录一起删。
      sepKeepDir = path.join(outDir, "_人声分离");
      sepWorkDir = path.join(sepKeepDir, "_tmp");
      fs.mkdirSync(sepWorkDir, { recursive: true });
      const sepInput = tempPathIn(sepWorkDir, stem, "sepsrc.wav");
      const sepIn = await toSeparateInput(inputPath, sepInput);

      report.step("separate", `人声分离中（${opts.separateModel}，本地运算，可能较慢）…`, 10);
      sepResult = await separate({
        input: sepIn.file,
        workDir: sepWorkDir,
        python: det.python,
        cliPath: det.cliPath,
        model: opts.separateModel,
        format: opts.separateFormat,
        modelFileDir: det.modelsDir,
        target: opts.separateTarget,
        onLine: (l) => process.stderr.write(`  ${l}\n`),
      });
      try { fs.unlinkSync(sepIn.file); } catch { }
      if (!sepResult.ok) throw new Error(sepResult.error);

      // audio-separator 用「输入文件名」做产物前缀，而我们的输入是带随机后缀的临时名，
      // 产物会是「合成 1__q8k25r_(Vocals)_Kim_Vocal_2.wav」这种。搬到固定目录时顺手改成
      // 「合成 1_人声.wav」，既好认，也方便面板按名字防重（认出自己生成的人声层）。
      const oldVocals = sepResult.vocals, oldInstrumental = sepResult.instrumental;
      sepResult.vocals = moveArtifact(oldVocals, sepKeepDir, `${stem}_人声`);
      sepResult.instrumental = moveArtifact(oldInstrumental, sepKeepDir, `${stem}_伴奏`);
      sepResult.chosen = (sepResult.chosen === oldVocals) ? sepResult.vocals
        : (sepResult.chosen === oldInstrumental) ? sepResult.instrumental
          : sepResult.chosen;
      sepResult.files = [sepResult.vocals, sepResult.instrumental].filter(Boolean);
      try { fs.rmSync(sepWorkDir, { recursive: true, force: true }); } catch { }
      sepWorkDir = sepKeepDir;

      // 伴奏的去留**必须在这里定**：结果 JSON 稍后就发出去了，等 finally 再删就会
      // 出现"JSON 里报了个已被删掉的路径"。用户选了"只入人声"，所以默认删伴奏。
      if (!opts.separateKeep && sepResult.instrumental) {
        try { fs.unlinkSync(sepResult.instrumental); } catch { /* 尽力而为 */ }
        sepResult.instrumental = null;
        sepResult.files = [sepResult.vocals].filter(Boolean);
      }

      asrSource = sepResult.chosen;
      asrCodecHint = "separated";
      report.step("separate",
        `人声分离完成：${path.basename(sepResult.chosen)}（用时 ${sepResult.elapsedSec} 秒）`, 14);
    }

    // ---- 只分离模式：分离完就收工 ----
    // 面板上的「分离人声」按钮走这条路：**不上传云端、不识别、不写字幕产物**，
    // 所以音频全程不离开本机。产物路径放在 separate 字段里，面板拿去落轨。
    if (opts.separateOnly) {
      if (!sepResult) {
        throw new Error("只分离模式需要同时给 --separate（分离目标 / 模型从对应参数取）");
      }
      const sepOut = {
        ok: true,
        mode: "separate-only",
        input: inputPath,
        outputs: { json: null, srt: null, txt: null },
        stats: null,
        separate: {
          dir: sepKeepDir ? norm(sepKeepDir) : null,
          vocals: sepResult.vocals ? norm(sepResult.vocals) : null,
          instrumental: sepResult.instrumental ? norm(sepResult.instrumental) : null,
          // 面板按 target 落轨，用 chosen 最稳妥（只有伴奏时 vocals 是 null）
          chosen: sepResult.chosen ? norm(sepResult.chosen) : null,
          target: opts.separateTarget,
          model: opts.separateModel,
          elapsedSec: sepResult.elapsedSec,
        },
        elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
      };
      report.step("done", "分离完成（未上传、未识别）", 100);
      report.result(sepOut);

      if (!opts.quiet && !opts.progressJson) {
        process.stderr.write(
          `\n分离完成（未上传、未识别）：${opts.separateTarget} · ${opts.separateModel}` +
          `\n  人声 → ${sepOut.separate.vocals || "（本次未产出）"}` +
          (sepOut.separate.instrumental
            ? `\n  伴奏 → ${sepOut.separate.instrumental}` : "") +
          `\n总耗时 ${sepOut.elapsedSec} 秒\n`
        );
      }
      return;
    }

    // ---- 挑选上传格式（体积守卫）----
    // 上限由**服务商档位**声明（providers 里的 maxFileBytes），不再写死某一家的数值。
    // 16kHz 单声道 WAV 约 32KB/秒，多数档位几十分钟就超标，所以先按估算挑好格式，
    // 而不是等上传到一半被对方拒收 —— 那种报错最难查。
    const lim = providerLimits(opts.asrProvider, opts.asrProfile);
    const plan = pickUploadFormat(media.duration, {
      limitBytes: lim.maxFileBytes || UPLOAD_LIMIT_BYTES,
      preferCompressed: lim.preferCompressed,
    });
    if (plan.overLimit) {
      throw new Error(
        `音频时长 ${Math.round(media.duration)} 秒，即使压成 ${MP3_BITRATE_KBPS}kbps 单声道，` +
        `预估仍有 ${(plan.estBytes / 1024 / 1024).toFixed(0)}MB，超过当前引擎的单文件上限 ` +
        `${(plan.limitBytes / 1024 / 1024).toFixed(0)}MB。\n` +
        `请缩短处理范围（在面板里选中更短的素材区间），或换一个上限更大的引擎。`
      );
    }
    if (plan.compressed) {
      report.step("transcode",
        `音频较长（${Math.round(media.duration)} 秒）：预估无损 WAV 约 ` +
        `${Math.round((media.duration * 32000) / 1024 / 1024)}MB，超过该引擎 ` +
        `${Math.round(plan.limitBytes / 1024 / 1024)}MB 的单次上限，` +
        `自动改用 ${MP3_BITRATE_KBPS}kbps 单声道 MP3（约 ` +
        `${(plan.estBytes / 1024 / 1024).toFixed(1)}MB）`, 8);
    } else {
      report.step("transcode", `转码为 16000Hz 单声道 WAV（来源 ${asrCodecHint || "?"}${
        opts.separate ? " · 已分离" : ""}）`, 8);
    }
    const asrPath = tempPathIn(outDir, stem, plan.ext);
    const wav = await toAsrAudio(asrSource, asrPath, { codec: plan.codec });
    tempWav = wav.file;

    // ---- 语音区间（懒加载）----
    // 切块识别要用它，后面的"按语音校正句子边界"也要用它。
    // 做成懒加载 + 缓存：只在真需要时跑一次静音检测，长音频能省掉一次全量解码。
    let speechDet = null;
    const ensureSpeech = async () => {
      if (!speechDet) {
        report.step("speech", "检测语音区间（ffmpeg 静音检测，本地不上传）", 12);
        speechDet = await detectSpeechIntervals(wav.file, {});
      }
      return speechDet;
    };

    // ---- 识别（服务商无关；切块/时间轴重构在 lib/asr.js 里）----
    // 开跑前先把"到底用哪家、哪个模型、哪个地址"打清楚：
    // 用户常常只选了服务商没选模型（走档位默认），质量不对时光靠"用了哪家"没法定位。
    report.step("asr-config",
      `识别引擎：${lim.label}｜模型：${opts.asrModel || (lim.defaultModel + "（档位默认）")}` +
      `｜服务地址：${opts.asrBaseUrl || lim.defaultBaseUrl || "（档位默认）"}`, 14);
    report.step("transcribe", "上传并等待识别结果", 15);
    const asrResult = await transcribeAudio(wav.file, {
      providerId: opts.asrProvider,
      profileId: opts.asrProfile,
      credentials: { apiKey: opts.apiKey, secretId: opts.secretId, secretKey: opts.secretKey },
      model: opts.asrModel,
      baseUrl: opts.asrBaseUrl,
      language: opts.asrLanguage,
      prompt: opts.asrPrompt,
      chunkMode: opts.chunkAsr ? "auto" : "never",
      tempDir: outDir,
      keepTemp: opts.keepChunks,
      ensureSpeech,
      queryTimeoutMs: Math.max(1, opts.timeoutMin) * 60 * 1000,
      onProgress: (percent, message) => {
        // 识别层给的是 0-100，映射到整体 15-88 区间，让总进度看起来连贯
        const overall = 15 + Math.round((percent / 100) * 73);
        report.step("transcribe", message || "识别中", Math.min(88, overall));
      },
    });
    const raw = asrResult.segments;
    const asrMeta = asrResult.meta;
    report.step("transcribe",
      `识别完成：${raw.length} 段（${describeTiming(asrMeta)}）`, 88);

    // ---- 后处理 ----
    report.step("postprocess", "规整时间轴并标记可疑段", 90);
    let segments = normalizeSegments(raw);
    segments = markSuspectSegments(segments);
    const suspectKept = segments.filter((s) => s.suspect).length;
    if (opts.dropSuspect) segments = segments.filter((s) => !s.suspect);
    if (opts.words) segments = splitToWordSegments(segments);

    // ---- 按真实语音时长校正句子边界（默认开，--no-snap-speech 关闭）----
    // 用"识别时听到的那份音频"做静音检测：开了人声分离时它已经是纯人声（音乐被去掉），
    // 语音区间非常干净；没分离时退回原音轨，效果差些但仍然有用。
    // 校正规则很保守（±0.8 秒内、不短于 0.35 秒、不与相邻句重叠），见 lib/speech.js 顶部说明。
    let snapInfo = null;
    if (opts.snapSpeech && segments.length) {
      try {
        report.step("snap", "按真实语音时长校正句子边界", 90);
        const det = await ensureSpeech();
        const snapped = snapSegmentsToSpeech(segments, det.intervals, {});
        segments = snapped.segments;
        snapInfo = {
          applied: true,
          speechIntervals: det.intervals.length,
          adjusted: snapped.changes.length,
          unchanged: snapped.unchanged,
          sample: snapped.changes.slice(0, 5)
        };
        report.step("snap",
          `按语音校正了 ${snapped.changes.length} 句（检测到 ${det.intervals.length} 处语音），` +
          `另有 ${snapped.unchanged} 句保持原样`, 91);
        for (const c of snapInfo.sample) {
          report.step("snap",
            `  · 第 ${c.index + 1} 句「${c.text}」` +
            `${(c.fromMs[0] / 1000).toFixed(2)}~${(c.fromMs[1] / 1000).toFixed(2)} 秒 → ` +
            `${(c.toMs[0] / 1000).toFixed(2)}~${(c.toMs[1] / 1000).toFixed(2)} 秒` +
            `（${c.deltaMs > 0 ? "+" : ""}${c.deltaMs} 毫秒）`, 91);
        }
      } catch (e) {
        const msg = String((e && e.message) ? e.message : e).slice(0, 200);
        report.step("snap", `语音校正已跳过：${msg}`, 91);
        snapInfo = { applied: false, error: msg };
      }
    } else if (!opts.snapSpeech) {
      report.step("snap", "按语音时长校正已关闭（用 ASR 原始时间）", 90);
    }

    // ---- 去掉字幕里的标点符号（可选开关）----
    // 有些模型（Qwen3-ASR 一类）会给文本带上标点，字幕上不想要就打开这个开关。
    // 位置很讲究，三处都对得上：
    //   · 在 markSuspectSegments 之后 —— 可疑段判定依据的是**原始文本**，不被改写影响
    //   · 在 summarize 之前         —— 统计的是最终呈现出来的字数
    //   · 在 shiftSegments 之前     —— 只改文字，不碰时间戳
    // 全部是标点的段（"。。。"）会变空串，直接丢弃，免得建出没有文字的空图层。
    if (opts.stripPunct && segments.length) {
      const before = segments.length;
      segments = segments
        .map((s) => ({ ...s, text: removePunctuation(s.text) }))
        .filter((s) => s.text !== "");
      const dropped = before - segments.length;
      report.step("punct",
        `已去掉字幕里的标点符号${dropped ? `（${dropped} 段只剩标点，已丢弃）` : ""}`, 92);
    }

    // 统计必须用"文件内相对时间"来算：平移之后覆盖率会失真，所以先算再移
    const stats = summarize(segments, media.duration);

    if (segments.length === 0) {
      report.step("postprocess", "没有识别到任何语音内容", 92);
    }

    // ---- 平移到合成时间轴（AE 按图层范围导出时才需要）----
    if (opts.offsetMs) {
      segments = shiftSegments(segments, opts.offsetMs);
      report.step("offset", `字幕时间轴整体平移 ${opts.offsetMs} 毫秒，对齐到合成时间轴`, 93);
    }

    // ---- 写产物 ----
    report.step("write", "写出字幕文件", 95);
    const jsonPath = path.join(outDir, `${stem}.json`);
    const srtPath = path.join(outDir, `${stem}.srt`);
    const txtPath = path.join(outDir, `${stem}.txt`);

    fs.writeFileSync(jsonPath, JSON.stringify(segments, null, 1), "utf8");
    fs.writeFileSync(srtPath, toSrt(segments, { maxChars: opts.maxChars }), "utf8");
    fs.writeFileSync(txtPath, toPlainText(segments), "utf8");

    const result = {
      ok: true,
      input: inputPath,
      outputs: { json: jsonPath, srt: srtPath, txt: txtPath },
      stats: {
        ...stats,
        suspectKeptIfNotDropped: suspectKept,
        droppedSuspect: opts.dropSuspect,
        wordLevel: opts.words,
        stripPunct: !!opts.stripPunct,
        mediaCodec: media.audioCodec,
        mediaSampleRate: media.sampleRate,
        mediaChannels: media.channels,
        uploadCodec: wav.codec,
        uploadBytes: wav.bytes,
        uploadCompressed: plan.compressed,
        // 识别层：用哪个档位、**哪个模型**、时间轴是怎么来的 —— 面板要显示，用户要知情
        asrProvider: asrMeta.provider,
        asrProfile: asrMeta.profile,
        asrProfileLabel: asrMeta.profileLabel,
        asrModel: asrMeta.model || null,            // 实际生效的模型（含档位默认值）
        asrModelIsDefault: !!asrMeta.modelIsDefault, // true = 用户没填，走的是档位默认
        asrBaseUrl: asrMeta.baseUrl || null,
        asrMode: asrMeta.mode,
        asrTiming: asrMeta.timing,
        asrChunks: asrMeta.chunkCount,
        asrFailedChunks: asrMeta.failedChunks || 0,
        asrLimitBytes: lim.maxFileBytes || null,
        offsetMs: opts.offsetMs,
        snapSpeech: snapInfo,
        transcodeSec: wav.elapsedSec,
        separated: !!opts.separate,
        separateTarget: opts.separate ? opts.separateTarget : null,
        separateModel: opts.separate ? opts.separateModel : null,
        separateSec: sepResult ? sepResult.elapsedSec : null,
      },
      // 分离产物清单：面板拿 vocals 的绝对路径去 AE 里建图层
      separate: sepResult ? {
        dir: sepKeepDir ? norm(sepKeepDir) : null,
        vocals: sepResult.vocals ? norm(sepResult.vocals) : null,
        instrumental: sepResult.instrumental ? norm(sepResult.instrumental) : null,
        chosen: sepResult.chosen ? norm(sepResult.chosen) : null,
        target: opts.separateTarget,
        model: opts.separateModel,
        elapsedSec: sepResult.elapsedSec,
      } : null,
      elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    };
    report.step("done", "完成", 100);
    report.result(result);

    if (!opts.quiet && !opts.progressJson) {
      process.stderr.write(
        `\n完成：共 ${stats.segments} 段字幕，${stats.totalChars} 字，` +
        `语音覆盖 ${stats.coveragePercent}%` +
        (stats.suspectSegments ? `，其中 ${stats.suspectSegments} 段疑似误识别` : "") +
        (opts.separate && sepResult
          ? `\n  已做人声分离（${opts.separateTarget} · ${opts.separateModel}，用时 ${sepResult.elapsedSec} 秒）`
          : "") +
        (snapInfo && snapInfo.applied
          ? `\n  按语音时长校正 ${snapInfo.adjusted} 句（共检测 ${snapInfo.speechIntervals} 处语音）`
          : "") +
        `\n  识别引擎：${describeEngine(asrMeta)}` +
        `\n  时间轴来源：${describeTiming(asrMeta)}` +
        (asrMeta.failedChunks ? `\n  ⚠ 有 ${asrMeta.failedChunks} 块识别失败，该处字幕会缺` : "") +
        `\n  上传格式 ${wav.codec.toUpperCase()}（${(wav.bytes / 1024).toFixed(0)}KB）` +
        (opts.offsetMs ? `，时间轴已平移 ${opts.offsetMs}ms` : "") +
        (opts.stripPunct ? `\n  文字处理：已去掉标点符号` : "") +
        `\n  JSON → ${jsonPath}\n  SRT  → ${srtPath}\n  TXT  → ${txtPath}\n` +
        `总耗时 ${result.elapsedSec} 秒\n`
      );
    }

  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    report.step("error", message, 100);
    report.result({ ok: false, error: message, input: inputPath });
    process.stderr.write(`\n失败：${message}\n`);
    process.exitCode = 1;
  } finally {
    // 清理中间 WAV：默认删掉，--keep-wav 时保留
    if (tempWav && !opts.keepWav) {
      try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); } catch { /* 尽力而为 */ }
    } else if (tempWav) {
      process.stderr.write(`（已按 --keep-wav 保留中间文件：${tempWav}）\n`);
    }

    // 人声是交付产物（面板要把它加进 AE 时间线，图层引用的是磁盘文件），永久保留。
    // 伴奏的去留已在主流程里处理完（那一步必须早于结果 JSON 输出）。
    if (sepResult && sepResult.vocals) {
      process.stderr.write(`（人声保留在：${sepKeepDir}）\n`);
    }
  }
}

main();
