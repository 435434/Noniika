/**
 * speech.js —— 用「真实语音区间」校正 ASR 给出的句子边界
 * ==========================================================
 * 为什么需要：云端 ASR 给的句子起止有抖动 —— 有时话音已经停了字幕还挂着，
 * 有时话还没说完字幕就消失了。我们手上有**分离好的人声**（音乐已被去掉），
 * 拿它做静音检测得到的语音区间，比 ASR 的句子边界更贴近真实说话时间。
 *
 * 依赖：只用项目里已经带上的 ffmpeg（silencedetect 滤镜），不引入任何新包。
 *
 * 设计原则：**保守**。宁可不改，也不要把好句子改坏：
 *   - 每句只允许在 ±maxAdjustMs 内调整，超出就保持 ASR 原值
 *   - 调整后不得短于 minDurMs
 *   - 调整后不得与相邻句重叠（留 gapMs 空隙）
 *   - 与任何语音区间都没有重叠的句子（疑似幻觉段）原样保留
 */

/** 低于这个音量算静音（人声分离后音乐已被去掉，阈值可以比较激进） */
export const SILENCE_NOISE_DB = -32;
/** 静音至少持续这么久才算一处停顿（太短会把字与字之间也切开） */
export const SILENCE_MIN_SEC = 0.12;

/** 单句最大调整量（毫秒）：超过就认为"不是边界抖动，而是别的问题"，不动它 */
export const MAX_ADJUST_MS = 800;
/** 单句最短显示时长（毫秒） */
export const MIN_DUR_MS = 350;
/** 相邻句之间保留的最小空隙（毫秒） */
export const GAP_MS = 50;
/** 与语音区间的重叠低于这个比例时，认为这句在语音上找不到对应（保留原值） */
export const MIN_OVERLAP_RATIO = 0.15;

/**
 * 解析 ffmpeg silencedetect 的输出，得到静音区间。
 * 输出形如：
 *   [silencedetect @ 0x...] silence_start: 1.234
 *   [silencedetect @ 0x...] silence_end: 2.345 | silence_duration: 1.111
 */
export function parseSilenceLog(stderr) {
  const silences = [];
  let open = null;
  const re = /silence_(start|end):\s*([0-9.]+)/g;
  let m;
  while ((m = re.exec(String(stderr || ""))) !== null) {
    const t = Number(m[2]);
    if (!isFinite(t)) continue;
    if (m[1] === "start") {
      open = t;
    } else if (open !== null) {
      silences.push({ startSec: open, endSec: t });
      open = null;
    }
  }
  // 末尾若还开着一个静音（视频以静音结束），补到片尾
  if (open !== null) silences.push({ startSec: open, endSec: null });
  return silences;
}

/**
 * 把静音区间翻转成语音区间（毫秒）。
 * @param {{startSec:number,endSec:number|null}[]} silences
 * @param {number} durationSec
 */
export function silencesToSpeechMs(silences, durationSec) {
  const dur = Number(durationSec) || 0;
  const list = (silences || [])
    .map((s) => ({
      startSec: Math.max(0, s.startSec),
      endSec: (s.endSec === null || s.endSec === undefined) ? dur : s.endSec
    }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  const speech = [];
  let cursor = 0;
  for (const s of list) {
    if (s.startSec > cursor) {
      speech.push({ startMs: Math.round(cursor * 1000), endMs: Math.round(s.startSec * 1000) });
    }
    cursor = Math.max(cursor, s.endSec);
  }
  if (dur > cursor) {
    speech.push({ startMs: Math.round(cursor * 1000), endMs: Math.round(dur * 1000) });
  }
  return speech.filter((iv) => iv.endMs - iv.startMs >= 60);   // 丢掉 60ms 以下的碎块
}

/**
 * 按语音区间校正句子边界（纯函数，便于单测）。
 *
 * @param {{text:string,startMs:number,endMs:number}[]} segments
 * @param {{startMs:number,endMs:number}[]} speech
 * @param {object} opts 见文件顶部的常量
 * @returns {{segments:Array, changes:Array, unchanged:number}}
 */
export function snapSegmentsToSpeech(segments, speech, opts = {}) {
  const maxAdjustMs = opts.maxAdjustMs ?? MAX_ADJUST_MS;
  const minDurMs = opts.minDurMs ?? MIN_DUR_MS;
  const gapMs = opts.gapMs ?? GAP_MS;
  const minOverlapRatio = opts.minOverlapRatio ?? MIN_OVERLAP_RATIO;

  const out = (segments || []).map((s) => ({ ...s }));
  const changes = [];
  if (!speech || !speech.length) return { segments: out, changes, unchanged: out.length };

  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    const dur = s.endMs - s.startMs;
    if (!(dur > 0)) continue;

    // 找重叠最多的语音区间
    let best = null;
    let bestOverlap = 0;
    for (const iv of speech) {
      const ov = Math.min(s.endMs, iv.endMs) - Math.max(s.startMs, iv.startMs);
      if (ov > bestOverlap) { bestOverlap = ov; best = iv; }
    }
    // 几乎没有重叠 ⇒ 这句在语音里找不到对应（可能是幻觉段），保持原样
    if (!best || bestOverlap < dur * minOverlapRatio) continue;

    let start = s.startMs;
    let end = s.endMs;
    if (Math.abs(best.startMs - start) <= maxAdjustMs) start = best.startMs;
    if (Math.abs(best.endMs - end) <= maxAdjustMs) end = best.endMs;

    // 不短于最短显示时长：先试原始时长，再试以中心向两侧撑开
    if (end - start < minDurMs) {
      if (dur >= minDurMs) { start = s.startMs; end = s.endMs; }
      else {
        const c = Math.round((start + end) / 2);
        start = c - Math.round(minDurMs / 2);
        end = start + minDurMs;
      }
    }

    // 不与前一句重叠
    const prev = out[i - 1];
    if (prev && start < prev.endMs + gapMs) start = prev.endMs + gapMs;
    // 不与后一句重叠（后一句还是原值）
    const next = out[i + 1];
    if (next && end > next.startMs - gapMs) end = next.startMs - gapMs;

    if (!(end - start > 0)) { continue; }          // 撞废了就保留原句
    if (start === s.startMs && end === s.endMs) { continue; }

    const deltaStart = start - s.startMs;
    const deltaEnd = end - s.endMs;
    s.startMs = start;
    s.endMs = end;
    changes.push({
      index: i,
      text: String(s.text || "").slice(0, 12),
      fromMs: [out[i].startMs - deltaStart, out[i].endMs - deltaEnd],
      toMs: [start, end],
      deltaMs: Math.round((deltaStart + deltaEnd) / 2)
    });
  }

  return { segments: out, changes, unchanged: out.length - changes.length };
}

/**
 * 跑一次 ffmpeg 静音检测，拿到语音区间（毫秒）。
 *
 * @param {string} audioPath 建议传**分离后的人声**；没有分离时传原音轨（效果会差些）
 * @param {object} opts { durationSec, silenceDb, minSilenceSec, ffmpegPath, timeoutMs }
 */
export async function detectSpeechIntervals(audioPath, opts = {}) {
  const { getFfmpegPath } = await import("./paths.js");
  const { probeMedia } = await import("./ffmpeg.js");
  const { spawn } = await import("node:child_process");

  let durationSec = Number(opts.durationSec) || 0;
  if (!durationSec) {
    const media = await probeMedia(audioPath);
    durationSec = Number(media && media.duration) || 0;
  }

  const db = opts.silenceDb ?? SILENCE_NOISE_DB;
  const minSec = opts.minSilenceSec ?? SILENCE_MIN_SEC;
  const exe = opts.ffmpegPath || getFfmpegPath();

  const args = [
    "-hide_banner", "-nostdin",
    "-i", audioPath,
    "-af", `silencedetect=noise=${db}dB:d=${minSec}`,
    "-f", "null", "-"
  ];

  const stderr = await new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => {
      try { p.kill(); } catch (e) { }
      reject(new Error("静音检测超时"));
    }, opts.timeoutMs || 10 * 60 * 1000);
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      // silencedetect 的结论都写在 stderr 上，退出码 0 即可
      if (code === 0) resolve(err);
      else reject(new Error("ffmpeg 退出码 " + code + "：" + err.slice(-300)));
    });
  });

  const silences = parseSilenceLog(stderr);
  const intervals = silencesToSpeechMs(silences, durationSec);
  return { durationSec, silences, intervals };
}
