/**
 * ffmpeg.js —— 用绝对路径调用 ffmpeg / ffprobe
 * ==========================================================
 * 统一约束：**所有交给 ASR 的音频，一律先转成 16kHz / 单声道 / 16bit PCM WAV**。
 *
 * 这么做的三个理由：
 *   1. 只把"干净、标准、小体积"的一份音频交出去，各家服务商的格式差异就被抹平了
 *      （见 paths.js 注释：外部服务自己 spawn ffmpeg 依赖 PATH 的坑，我们不再踩）
 *   2. 上传体积小一个数量级（44.1k 立体声 → 16k 单声道约省 5.5 倍），传得快、云端暴露少
 *   3. 16kHz 是这类 ASR 的理想输入，识别率不会下降
 *
 * 把"多大算超限"这件事交给**服务商档位**声明（providers 里的 maxFileBytes），
 * 本文件只提供纯计算与转码工具，不再写死任何一家的上限。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { getFfmpegPath, getFfprobePath } from "./paths.js";

/** ASR 输入标准：16kHz / 单声道 / 16bit PCM */
export const ASR_SAMPLE_RATE = 16000;
export const ASR_CHANNELS = 1;

/** 无损 WAV 的体积推算：16bit × 1 声道 × 16000Hz */
export const WAV_BYTES_PER_SEC = ASR_SAMPLE_RATE * ASR_CHANNELS * 2;   // 32000
/** 压缩格式：libmp3lame 48kbps 单声道（实测可上传且识别结果与 WAV 一致） */
export const MP3_BITRATE_KBPS = 48;
export const MP3_BYTES_PER_SEC = Math.round((MP3_BITRATE_KBPS * 1000) / 8); // 6000

/**
 * 上传体积上限的**兜底默认值**（真正的上限由服务商档位给）。
 *
 * 为什么留一个默认：不是每家服务商都在文档里写清上限。给一个保守的 50MB，
 * 配合下面的安全余量，能让"没配上限"的服务商也不至于一上传就被拒。
 */
export const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
/** 留出安全余量，别贴着红线走（base64 编码还会再涨约 1/3） */
export const UPLOAD_SAFE_RATIO = 0.9;

/**
 * 按音频时长与**服务商上限**挑选上传格式。
 *
 * 策略：**能走 WAV 就走 WAV**（无损，识别效果最稳），只有预估体积会超限时才降级到 MP3。
 * 这样短素材（用户的实际场景，通常 ≤1 分钟）走的是完全无损的路径，
 * 而超长素材也不会直接失败。
 *
 * @param {number} durationSec 音频时长（秒）
 * @param {object} [opts]
 * @param {number} [opts.limitBytes]   服务商单文件上限（字节）
 * @param {boolean} [opts.preferCompressed] 强制走压缩（例如腾讯云 base64 上限很小，
 *                                          哪怕 2 分钟的 WAV 也会超，直接上 MP3 更省事）
 * @returns {{codec:"wav"|"mp3", ext:string, estBytes:number, compressed:boolean, overLimit:boolean, limitBytes:number}}
 */
export function pickUploadFormat(durationSec, opts = {}) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const limitBytes = Math.max(1024, Number(opts.limitBytes) || UPLOAD_LIMIT_BYTES);
  const safeBytes = Math.round(limitBytes * UPLOAD_SAFE_RATIO);

  const estWav = Math.round(dur * WAV_BYTES_PER_SEC);
  if (!opts.preferCompressed && estWav <= safeBytes) {
    return { codec: "wav", ext: "wav", estBytes: estWav, compressed: false, overLimit: false, limitBytes };
  }
  const estMp3 = Math.round(dur * MP3_BYTES_PER_SEC);
  return {
    codec: "mp3",
    ext: "mp3",
    estBytes: estMp3,
    compressed: true,
    overLimit: estMp3 > limitBytes,
    limitBytes,
  };
}

/**
 * 执行外部命令并收集输出。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(exe, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new Error(`无法启动 ${exe}：${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* 忽略 */ }
        reject(new Error(`执行超时（${Math.round(timeoutMs / 1000)} 秒）：${exe}`));
      }, timeoutMs);
    }

    proc.stdout.on("data", (c) => { stdout += c.toString(); });
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`无法执行 ${exe}：${err.message}`));
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 探测媒体文件的时长与音频参数。
 * @param {string} file 媒体文件绝对路径
 * @returns {Promise<{duration:number, hasVideo:boolean, hasAudio:boolean,
 *                    audioCodec:string|null, sampleRate:number|null,
 *                    channels:number|null, audioChannelsCount:number}>}
 */
export async function probeMedia(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const ffprobe = getFfprobePath();
  // 有 ffprobe 就用它（开发机、老环境走这条，行为与从前完全一致）；
  // 分发包里刻意没带它 —— 走下面的 ffmpeg 解析，省掉 77 MB。
  if (!ffprobe) return probeMediaViaFfmpeg(file);

  const { code, stdout, stderr } = await run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels",
    "-of", "json",
    file,
  ], { timeoutMs: 60 * 1000 });

  if (code !== 0) throw new Error(`ffprobe 读取失败（exit ${code}）：${stderr.slice(-300).trim()}`);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe 输出无法解析：${stdout.slice(0, 200)}`);
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const first = audioStreams[0] || null;

  return {
    duration: Number(parsed.format?.duration || 0),
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: audioStreams.length > 0,
    audioCodec: first ? first.codec_name : null,
    sampleRate: first && first.sample_rate ? Number(first.sample_rate) : null,
    channels: first && first.channels ? Number(first.channels) : null,
    audioChannelsCount: audioStreams.length,
  };
}

/**
 * 不依赖 ffprobe 的媒体探测：让 ffmpeg 把媒体信息打到 stderr，再从里面解析。
 *
 * 解析的三类行（ffmpeg 各版本格式一致、且这几项最稳）：
 *   Duration: 00:00:06.40, start: 0.000000, bitrate: 1234 kb/s
 *   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 ...
 *   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s
 *
 * ⚠ `ffmpeg -i <file>` 在没有输出目标时会以非 0 退出 —— 这是**正常现象**，
 *  信息已经写在 stderr 里了，所以这里不看退出码，只看有没有 "Input #0"。
 *
 * @param {string} file 媒体文件绝对路径
 * @returns {Promise<object>} 与 ffprobe 那条路完全相同的字段
 */
async function probeMediaViaFfmpeg(file) {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) throw new Error("找不到 ffmpeg，无法探测媒体信息（见 pipeline/lib/paths.js）");

  const { stdout, stderr } = await run(ffmpeg, ["-hide_banner", "-i", file], { timeoutMs: 60 * 1000 });
  const text = String(stderr || "") + "\n" + String(stdout || "");
  if (!/Input #0/i.test(text)) {
    throw new Error("读不出媒体信息（文件可能不是有效媒体，或缺少对应解码器）：" +
      text.trim().slice(-240));
  }

  let duration = 0;
  const md = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (md) duration = Number(md[1]) * 3600 + Number(md[2]) * 60 + Number(md[3]);

  let hasVideo = false, hasAudio = false, audioCount = 0;
  let audioCodec = null, sampleRate = null, channels = null;

  for (const line of text.split(/\r?\n/)) {
    const ms = line.match(/Stream #\d+:\d+[^:]*:\s*(Video|Audio):\s*([A-Za-z0-9_]+)/);
    if (!ms) continue;
    if (ms[1] === "Video") { hasVideo = true; continue; }
    audioCount++;
    hasAudio = true;
    if (audioCodec !== null) continue;          // 只取第一条音轨，与 ffprobe 那条路一致
    audioCodec = ms[2];
    const mq = line.match(/(\d+)\s*Hz/);
    if (mq) sampleRate = Number(mq[1]);
    const mc = line.match(/\d+\s*Hz,\s*([^,\n]+)/);
    if (mc) {
      const word = mc[1].trim().toLowerCase();
      if (word === "mono") channels = 1;
      else if (word === "stereo") channels = 2;
      else {
        const mn = word.match(/^(\d+)\s*channels?/);
        if (mn) channels = Number(mn[1]);
      }
    }
  }

  return {
    duration,
    hasVideo,
    hasAudio,
    audioCodec,
    sampleRate,
    channels,
    audioChannelsCount: audioCount,
  };
}

/**
 * 把任意媒体（视频/音频）转成 ASR 标准输入。
 *
 * 参数说明：
 *   -vn              丢掉画面，只要声音
 *   -map 0:a:0       只取第一条音轨（多音轨时避免混在一起）
 *   -ar / -ac        重采样与声道数（16kHz 单声道）
 *   wav 走 pcm_s16le（无损）；mp3 走 libmp3lame 48kbps（体积约为 WAV 的 1/5.3）
 *
 * 为什么要有 mp3 这条分支：各家的单文件上限差异很大 —— 免费档常是 25~50MB，
 * 而腾讯云"直接传数据"这条路上限只有约 5MB。16kHz 单声道 WAV 约 32KB/秒，
 * 几十分钟就超标了；MP3(48kbps，约 6KB/秒) 能把可用时长拉长约 5.3 倍。
 * 实测 MP3(48kbps) 的识别结果与 WAV 逐字一致，所以压缩这一步不牺牲质量。
 *
 * @param {string} input  输入文件
 * @param {string} output 输出路径（扩展名必须与 codec 匹配）
 * @param {{codec?:"wav"|"mp3"}} [opts]
 * @returns {Promise<{file:string, bytes:number, codec:string, elapsedSec:number}>}
 */
export async function toAsrAudio(input, output, opts = {}) {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) throw new Error("找不到 ffmpeg，无法转码（见 pipeline/lib/paths.js）");
  if (!fs.existsSync(input)) throw new Error(`文件不存在：${input}`);

  const codec = opts.codec === "mp3" ? "mp3" : "wav";
  const codecArgs = codec === "mp3"
    ? ["-acodec", "libmp3lame", "-b:a", `${MP3_BITRATE_KBPS}k`]
    : ["-acodec", "pcm_s16le"];

  const t0 = Date.now();
  const { code, stderr } = await run(ffmpeg, [
    "-y",
    "-i", input,
    "-map", "0:a:0",
    "-vn",
    ...codecArgs,
    "-ar", String(ASR_SAMPLE_RATE),
    "-ac", String(ASR_CHANNELS),
    output,
  ]);

  if (code !== 0) {
    // ffmpeg 把关键信息放在最后几行，取出来给用户看
    throw new Error(`ffmpeg 转码失败（exit ${code}）：${stderr.slice(-300).trim()}`);
  }
  // WAV 有 44 字节头，MP3 的空文件判断用更小的阈值
  const minBytes = codec === "mp3" ? 128 : 44;
  if (!fs.existsSync(output) || fs.statSync(output).size <= minBytes) {
    throw new Error(`转码产物为空：${output}（输入可能没有声音）`);
  }

  return {
    file: output,
    bytes: fs.statSync(output).size,
    codec,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/**
 * 生成一个随机的临时文件路径。
 * 注意：刻意放在输出目录旁边而非系统临时目录，便于排障时找得到；
 * 由调用方负责清理（传入 --keep-wav 时保留）。
 */
export function tempPathIn(dir, stem, ext) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${dir}/${stem}__${rand}.${ext}`;
}

/**
 * 从音频里**切出一个时间片段**，单独存成一个文件。
 *
 * 用途：给"不回时间戳"的 ASR 服务重建时间轴 —— 把音频按静音切成若干块，
 * 逐块送识别，"这一块的起止时间"就成了这块文字的真实时间范围（见 lib/align.js）。
 *
 * 参数选择说明：
 *   -ss 放在 -i **之前**：输入定位（快），配合默认的 accurate_seek 在转码时仍会精确到帧，
 *                          不用把整个文件先解码一遍 —— 一个 10 分钟的音频切 20 块会快很多。
 *   输出统一 pcm_s16le / 16kHz / 单声道：与 toAsrAudio 的标准一致，服务商那边不用再适配。
 *
 * @param {string} input
 * @param {string} output
 * @param {number} startMs 起点（毫秒）
 * @param {number} durationMs 时长（毫秒）
 * @returns {Promise<{file:string, bytes:number}>}
 */
export async function sliceAudio(input, output, startMs, durationMs) {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) throw new Error("找不到 ffmpeg，无法切分音频（见 pipeline/lib/paths.js）");
  if (!fs.existsSync(input)) throw new Error(`文件不存在：${input}`);

  const ss = Math.max(0, Number(startMs) || 0) / 1000;
  const t = Math.max(0.01, Number(durationMs) || 0) / 1000;

  const { code, stderr } = await run(ffmpeg, [
    "-y",
    "-ss", ss.toFixed(3),
    "-i", input,
    "-t", t.toFixed(3),
    "-map", "0:a:0",
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", String(ASR_SAMPLE_RATE),
    "-ac", String(ASR_CHANNELS),
    output,
  ], { timeoutMs: 5 * 60 * 1000 });

  if (code !== 0) {
    throw new Error(`ffmpeg 切片失败（exit ${code}，${ss.toFixed(2)}s 起 ${t.toFixed(2)}s）：${stderr.slice(-240).trim()}`);
  }
  if (!fs.existsSync(output) || fs.statSync(output).size <= 44) {
    throw new Error(`切片产物为空：${output}（片段可能全是静音）`);
  }
  return { file: output, bytes: fs.statSync(output).size };
}

/**
 * 转成"人声分离的输入"：44.1kHz / 立体声 / 16bit PCM WAV。
 *
 * 为什么不直接把原文件丢给 audio-separator：
 *   UVR 系模型是按 44.1kHz 立体声训练的，而交给识别服务的那份 16kHz 单声道会把高频和
 *   立体声信息先丢掉 —— 拿 16k 单声道去做分离，效果明显打折。
 *   所以分离前单独出一份 44.1k 立体声给它，分离完再把结果转成 16k 单声道喂识别。
 */
export async function toSeparateInput(input, output) {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) throw new Error("找不到 ffmpeg，无法转码（见 pipeline/lib/paths.js）");
  if (!fs.existsSync(input)) throw new Error(`文件不存在：${input}`);

  const t0 = Date.now();
  const { code, stderr } = await run(ffmpeg, [
    "-y",
    "-i", input,
    "-map", "0:a:0",
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "44100",
    "-ac", "2",
    output,
  ]);

  if (code !== 0) {
    throw new Error(`分离前转码失败（exit ${code}）：${stderr.slice(-300).trim()}`);
  }
  if (!fs.existsSync(output) || fs.statSync(output).size <= 44) {
    throw new Error(`分离前转码产物为空：${output}（输入可能没有声音）`);
  }

  return {
    file: output,
    bytes: fs.statSync(output).size,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
  };
}
