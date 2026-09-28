/**
 * asr.js —— 语音识别总入口（**服务商无关**）
 * ==========================================================
 * 这一层只做编排，不碰任何一家的私有协议（那些在 lib/providers/ 里）。
 *
 * 对外只暴露两件事：
 *   transcribeAudio(audioFile, opts) → { segments, meta }
 *   listAsrProfiles()                → 给面板渲染引擎下拉框
 *
 * 它要解决的核心矛盾是：**字幕必须有时间轴，但不是每个 ASR 都回时间戳。**
 * 于是这里按"能力"分三条路：
 *
 *   A. 档位声明 timestamps="segments" 且文件塞得进单次上限
 *      → 一次调用，直接用服务商给的时间戳。**最准，优先走这条。**
 *
 *   B. 档位只回纯文本（典型：免费的 SenseVoice）
 *      → 先做 ffmpeg 静音检测，把音频切成"呼吸块"（块边界落在静音里，不会切断词），
 *        逐块识别；块起止就是真时间范围，块内再按字数把时间分给各句。
 *        （见 lib/align.js 顶部关于精度的诚实说明）
 *
 *   C. 文件超过单次上限（如腾讯云 base64 约 5MB）
 *      → 即使档位支持时间戳，也必须切块；切完把每块的局部时间戳加上块起点。
 *
 * 三条路的产物是同一种东西：`[{ text, startMs, endMs, words? }]`，
 * 所以下游的后处理、SRT 导出、AE 建图层一行都不用改。
 *
 * 隐私：音频会上传到所选服务商云端。调用方（面板）必须明确告知用户，禁止处理机密内容。
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROFILE, DEFAULT_PROVIDER,
  listProfiles, resolve,
  transcribeFile as dispatchTranscribe,
} from "./providers/index.js";
import { detectSpeechIntervals } from "./speech.js";
import { sliceAudio, tempPathIn } from "./ffmpeg.js";
import {
  MAX_CHUNK_MS, alignPlainText, distributePieces, groupIntervals, splitText,
} from "./align.js";

export { listProfiles as listAsrProfiles };
// 把默认引擎常量、"密钥自检"、"可用模型清单"一并转出，让 cli / 面板只需要 import 这一个模块
export {
  DEFAULT_PROFILE, DEFAULT_PROVIDER,
  listModels as listAsrModels,
  ping as pingAsr,
} from "./providers/index.js";

/** 给面板用的默认值（改这里就能改默认引擎） */
export const DEFAULTS = { providerId: DEFAULT_PROVIDER, profileId: DEFAULT_PROFILE };

/** 各档位的体积/时长上限与默认模型速查（面板提示 + cli 启动日志用） */
export function providerLimits(providerId, profileId) {
  const { profile } = resolve(providerId, profileId);
  return {
    maxFileBytes: profile.maxFileBytes || 0,
    maxDurationSec: profile.maxDurationSec || 0,
    preferCompressed: !!profile.preferCompressed,
    timestamps: profile.timestamps,
    freeNote: profile.freeNote || "",
    reachableInCn: profile.reachableInCn !== false,
    // 让调用方在"还没开始识别"时就能把"将要用哪家、哪个模型"打出来
    label: profile.label || profileId,
    defaultModel: profile.model || profile.engine || "",
    defaultBaseUrl: profile.baseUrl || "",
  };
}

/**
 * 主入口。
 *
 * @param {string} audioFile 已转好的 ASR 标准音频（16kHz 单声道）
 * @param {object} opts
 * @param {string} [opts.providerId]  "openai-compat" | "tencent"
 * @param {string} [opts.profileId]   档位 id（如 siliconflow / groq / tencent）
 * @param {object} [opts.credentials] { apiKey } 或 { secretId, secretKey }
 * @param {string} [opts.model]       覆盖档位默认模型
 * @param {string} [opts.baseUrl]     覆盖档位默认地址
 * @param {string} [opts.language]    语言提示，默认 zh
 * @param {string} [opts.prompt]      上下文提示词（提升专有名词准确率）
 * @param {"auto"|"always"|"never"} [opts.chunkMode] 切块策略
 * @param {number} [opts.maxChunkMs]
 * @param {number} [opts.durationSec] 音频时长；不给则现算
 * @param {Array}  [opts.speechIntervals] 已有的语音区间（复用可省一次静音检测）
 * @param {function} [opts.ensureSpeech] 懒加载语音区间：async () => ({intervals, durationSec})
 *        给这个函数时，静音检测**只在真正需要时才跑**，而且算完的结果由调用方缓存，
 *        下游（cli 的句子边界校正）可以复用同一次结果 —— 长音频能省掉一次全量解码。
 * @param {string} [opts.tempDir]     切块临时文件目录
 * @param {boolean} [opts.keepTemp]   保留切块文件（排障）
 * @param {function} [opts.transcribeOne] 自定义"单文件转写"实现，**用于自测与离线验证**：
 *        签名同 providers 的 transcribeFile({file, ...})，返回 {text, segments|null}。
 *        给这个参数时完全不碰网络与密钥，可以拿假音频把切块/时间轴重构整条链路跑通。
 * @param {number} [opts.queryTimeoutMs]
 * @param {function} [opts.onProgress] (percent0to100, message)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{segments:Array, meta:object}>}
 */
export async function transcribeAudio(audioFile, opts = {}) {
  const {
    providerId = DEFAULT_PROVIDER,
    profileId = DEFAULT_PROFILE,
    credentials = {}, model, baseUrl, language = "zh", prompt,
    chunkMode = "auto", maxChunkMs = MAX_CHUNK_MS,
    speechIntervals = null, ensureSpeech = null, tempDir = null, keepTemp = false,
    transcribeOne = null,
    queryTimeoutMs = 15 * 60 * 1000,
    onProgress, signal,
  } = opts;

  if (!fs.existsSync(audioFile)) throw new Error(`音频文件不存在：${audioFile}`);

  /**
   * 单文件转写入口。默认走服务商适配器（providers/）；
   * 传了 transcribeOne 就用它 —— 自测时完全不联网，也能验证切块与时间轴重构。
   */
  const callOnce = (args) => (transcribeOne
    ? transcribeOne(args)
    : dispatchTranscribe(args));

  /** 自适应探测到的时长（懒加载路径下用来给"均切"兜底） */
  let probedDurationFallback = 0;
  /** 语音区间缓存。注意：不能直接写回解构出来的参数（那是只读绑定），用独立变量存 */
  let speechCache = speechIntervals;

  /** 语音区间解析器：优先用调用方给的，其次用懒加载回调，最后自己跑一次 */
  const resolveSpeech = async () => {
    if (speechCache) return speechCache;
    if (ensureSpeech) {
      const d = await ensureSpeech();
      speechCache = d.intervals || [];
      probedDurationFallback = probedDurationFallback || Number(d.durationSec) || 0;
      return speechCache;
    }
    const det = await detectSpeechIntervals(audioFile);
    speechCache = det.intervals || [];
    probedDurationFallback = Number(det.durationSec) || 0;
    return speechCache;
  };

  const { profile } = resolve(providerId, profileId);
  const fileBytes = fs.statSync(audioFile).size;
  const cap = profile.timestamps || "auto";

  /**
   * **实际生效的模型名**。这一项必须如实上报，不能让用户只知道"用了哪家"却不知道"用了哪个模型"：
   *   用户没手填 model 时，走的是档位默认值 —— 这在日志里如果留空，排查质量问题时完全没法定位。
   * 三种档位的默认值来源不同，这里统一成一个字段：
   *   openai-compat / custom → profile.model
   *   tencent               → profile.engine（如 16k_zh）
   */
  const effectiveModel = String(model || profile.model || profile.engine || "").trim();
  const effectiveBaseUrl = String(baseUrl || profile.baseUrl || "").trim();

  // 单次上限能不能装下？
  const limitBytes = profile.maxFileBytes || 0;
  const fitsOneCall = !limitBytes || fileBytes <= limitBytes;

  // ---- 决定走哪条路 ----
  let mode;
  if (chunkMode === "always") mode = "chunk";
  else if (chunkMode === "never") mode = "single";
  else if (!fitsOneCall) mode = "chunk";          // C：体积逼着切
  else if (cap === "none") mode = "chunk";        // B：没时间戳，靠切块重建
  else mode = "single";                           // A：一次调用，真时间戳

  const baseMeta = {
    provider: providerId,
    profile: profileId,
    profileLabel: profile.label || profileId,
    // 实际生效的模型与服务地址（含档位默认值），日志与结果里都要能看到
    model: effectiveModel,
    modelIsDefault: !String(model || "").trim(),
    baseUrl: effectiveBaseUrl,
    capability: cap,
    mode,
    fileBytes,
    limitBytes,
  };

  // ---- A：一次调用 ----
  if (mode === "single") {
    if (onProgress) onProgress(10, "上传并等待识别结果");
    const r = await callOnce({
      providerId, profileId, credentials,
      // 传**已解析**的模型与地址：保证"日志里报的"和"实际请求用的"是同一个值
      model: effectiveModel, baseUrl: effectiveBaseUrl,
      language, prompt,
      file: audioFile, timeoutMs: queryTimeoutMs, signal, onProgress,
    });

    if (r.segments && r.segments.length) {
      if (onProgress) onProgress(100, `识别完成：${r.segments.length} 句（服务商时间戳）`);
      return {
        segments: r.segments,
        meta: { ...baseMeta, timing: "upstream", chunkCount: 1, textChars: (r.text || "").length },
      };
    }

    // 档位号称有时间戳，实际没给（服务商忽略了这个参数）→ 退回重构时间轴
    if (!r.text) throw new Error("识别结果为空：服务商既没回文字也没回时间戳，请确认音频里有人声");
    const intervals = await resolveSpeech();
    const segments = alignPlainText(r.text, intervals, { maxChars: 16 });
    if (!segments.length) {
      throw new Error("识别到了文字，但没能重构出时间轴（没检测到语音区间，音频可能全程静音）");
    }
    if (onProgress) onProgress(100, `识别完成：${segments.length} 句（按语音区间重构时间轴）`);
    return {
      segments,
      meta: { ...baseMeta, mode: "single-realign", timing: "reconstructed", chunkCount: 1, textChars: r.text.length },
    };
  }

  // ---- B / C：切块 ----
  if (onProgress) onProgress(5, "按语音停顿切分音频");

  // 语音区间：优先用调用方给的（cli 后面还要拿它做句子边界校正，别重复算一次静音检测）
  const intervals = await resolveSpeech();
  const probedDuration = Number(opts.durationSec) || probedDurationFallback;

  const chunks = groupIntervals(intervals, { maxChunkMs });

  // 静音检测没给出区间（全程连续说话、或阈值不合适）时，退化成"按固定时长均切"，
  // 保证还能出字幕 —— 精度差一点，但比直接失败强。
  if (!chunks.length) {
    if (!probedDuration) {
      throw new Error(
        "既没检测到语音停顿，也读不到音频时长，无法切块识别。" +
        "请改用返回时间戳的引擎（腾讯云 / Groq），或检查音频是否全程静音。"
      );
    }
    const total = Math.round(probedDuration * 1000);
    for (let s = 0; s < total; s += maxChunkMs) {
      chunks.push({ startMs: s, endMs: Math.min(total, s + maxChunkMs), intervals: [] });
    }
    if (onProgress) onProgress(6, `未检测到明显停顿，改为按时长均切 ${chunks.length} 块`);
  }

  const workDir = tempDir || path.dirname(audioFile);
  const stem = path.basename(audioFile, path.extname(audioFile));
  const tempFiles = [];
  const allSegments = [];
  const perChunk = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) throw new Error("已取消");

    const c = chunks[i];
    const pctBase = 10 + Math.round((i / chunks.length) * 80);
    if (onProgress) onProgress(pctBase, `识别第 ${i + 1}/${chunks.length} 块`);

    const slicePath = tempPathIn(workDir, `${stem}__chunk${String(i + 1).padStart(3, "0")}`, "wav");
    await sliceAudio(audioFile, slicePath, c.startMs, c.endMs - c.startMs);
    tempFiles.push(slicePath);

    let r;
    try {
      r = await callOnce({
        providerId, profileId, credentials,
        model: effectiveModel, baseUrl: effectiveBaseUrl,
        language, prompt,
        file: slicePath, timeoutMs: queryTimeoutMs, signal,
      });
    } catch (err) {
      // 单块失败不让整件事白做：记下来继续，最后如实汇报缺了几块
      perChunk.push({
        index: i, startMs: c.startMs, endMs: c.endMs, ok: false,
        error: String((err && err.message) || err),
      });
      continue;
    }

    let segs;
    if (r.segments && r.segments.length) {
      // 服务商给了块内时间戳 → 加块起点，并夹到块范围内
      segs = r.segments.map((s) => ({
        text: s.text,
        startMs: Math.min(c.endMs, c.startMs + s.startMs),
        endMs: Math.min(c.endMs, c.startMs + s.endMs),
        ...(Array.isArray(s.words)
          ? { words: s.words.map((w) => ({ text: w.text, startMs: c.startMs + w.startMs, endMs: c.startMs + w.endMs })) }
          : {}),
      })).filter((s) => s.endMs > s.startMs);
    } else if (r.text) {
      // 只有文字 → 块内按字数分配（这就是 align.js 的 ②）
      segs = distributePieces(splitText(r.text, { maxChars: 16 }), c.startMs, c.endMs, c.intervals);
    } else {
      segs = [];
    }

    allSegments.push(...segs);
    perChunk.push({
      index: i, startMs: c.startMs, endMs: c.endMs, ok: true,
      segments: segs.length, chars: (r.text || "").length,
    });
  }

  // 清理切片文件（除非要求保留）
  if (!keepTemp) {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* 尽力而为 */ }
    }
  }

  allSegments.sort((a, b) => a.startMs - b.startMs);

  const failed = perChunk.filter((c) => !c.ok);
  if (failed.length && !allSegments.length) {
    throw new Error(`全部 ${chunks.length} 块都识别失败。第一块的原因：${failed[0].error}`);
  }

  if (onProgress) onProgress(100, `识别完成：${allSegments.length} 句（切 ${chunks.length} 块）`);

  return {
    segments: allSegments,
    meta: {
      ...baseMeta,
      timing: "reconstructed-by-chunk",
      chunkCount: chunks.length,
      failedChunks: failed.length,
      chunks: perChunk,
      textChars: perChunk.reduce((n, c) => n + (c.chars || 0), 0),
      tempKept: keepTemp ? tempFiles : null,
      speechIntervals: intervals.length,
    },
  };
}
