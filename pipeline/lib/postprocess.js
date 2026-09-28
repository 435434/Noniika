/**
 * postprocess.js —— 字幕后处理与导出
 * ==========================================================
 * 做四件事：
 *   1. 规整化：清空白、纠正非法时间区间、按时间排序
 *   2. 疑似误识别标记：只打标记、不自动删（删不删由用户决定）
 *   3. 断行：中文按字数断行，优先在标点后断
 *   4. 导出：SRT / 纯文本 / 交给 AE 的 JSON
 *
 * 为什么"标记"而不是"自动删"：
 *   实测带 BGM 的片段里，识别服务会把音乐或噪声识别成孤立的「是」这种单字段。
 *   但合法的口语回答（"好""对""是"）同样是单字。自动删会误杀真内容，
 *   所以默认只标记，由面板高亮给用户，用户勾选后再删。
 */

/** 常见中英文标点，用于判断"去标点后还剩几个字"以及断行位置 */
const PUNCT = "，。！？；：、（）《》【】“”‘’—…·,.!?;:()[]<>\"'`~ ";
const PUNCT_SET = new Set(PUNCT.split(""));
/** 同一批标点、但剔掉空白 —— 改字幕文本时不能把英文词间空格也吃掉 */
const PUNCT_NO_SPACE = new Set(PUNCT.split("").filter((c) => !/\s/.test(c)));

/**
 * 去掉所有标点与空白，只留下实质内容。
 * ⚠ 这是**计数用**的（判断"单字孤立段"、算总字数），不是用来改字幕文本的。
 *   要改字幕文本请用下面的 removePunctuation()。
 */
export function stripPunct(text) {
  let out = "";
  for (const ch of String(text || "")) {
    if (!PUNCT_SET.has(ch) && !/\s/.test(ch)) out += ch;
  }
  return out;
}

/**
 * 去掉标点符号，但**保留词间空格** —— 用于「取消标点符号」开关，改的是字幕文本本身。
 *
 * 为什么不复用上面的 stripPunct()：它连空白一起删。英文句子被删掉空格会粘成一片
 * （"Hello world" → "Helloworld"），那种字幕比带标点还难读。两者用途不同，必须分开。
 *
 * 两个**不删**的例外：
 *   1. 数字之间的 . 和 , —— "3.14"、"1,000" 是数字的一部分，不是标点
 *   2. 其余标点一律删除（含书名号、引号、破折号、省略号）
 *
 * 全部是标点的文本会得到空串，由调用方决定丢弃（见 cli.js）。
 *
 * @param {string} text
 * @returns {string}
 */
export function removePunctuation(text) {
  const s = String(text || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!PUNCT_NO_SPACE.has(ch)) { out += ch; continue; }
    if (ch === "." || ch === ",") {
      const prev = s[i - 1], next = s[i + 1];
      if (prev && next && /\d/.test(prev) && /\d/.test(next)) out += ch;
    }
  }
  // 标点被删掉后可能留下连续空格（"你好 ，世界"），压缩掉再收尾
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 规整化字幕段。
 * @param {Array} segments 原始段
 * @returns {Array} 新数组（不修改入参）
 */
export function normalizeSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    if (!s) continue;
    const text = String(s.text || "").replace(/[ \t]+/g, " ").trim();
    if (text === "") continue;

    let startMs = Math.max(0, Math.round(Number(s.startMs) || 0));
    let endMs = Math.max(0, Math.round(Number(s.endMs) || 0));
    if (endMs <= startMs) continue; // 时间区间非法，直接丢弃

    const words = Array.isArray(s.words)
      ? s.words
          .map((w) => ({
            text: String(w.text || "").trim(),
            startMs: Math.max(0, Math.round(Number(w.startMs) || 0)),
            endMs: Math.max(0, Math.round(Number(w.endMs) || 0)),
          }))
          .filter((w) => w.text !== "" && w.endMs > w.startMs)
      : undefined;

    out.push({ text, startMs, endMs, ...(words && words.length ? { words } : {}) });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/**
 * 给疑似误识别的段打标记（只加 suspectReasons，不删除）。
 *
 * 规则：
 *   R1 去标点后为空            → 只有标点，几乎必然是噪声
 *   R2 去标点后字数 ≤ minChars → 单字孤立段，疑似音乐/噪声误识别
 *   R3 时长 < minDurationMs    → 时长过短，来不及说完整内容
 *   R4 与前一段文字完全相同     → 重复段
 *
 * @param {Array} segments 已规整化的段
 * @param {{minChars?:number, minDurationMs?:number}} [opts]
 */
export function markSuspectSegments(segments, opts = {}) {
  const { minChars = 1, minDurationMs = 200 } = opts;
  let prevText = null;

  return segments.map((s) => {
    const reasons = [];
    const core = stripPunct(s.text);
    const dur = s.endMs - s.startMs;

    if (core.length === 0) reasons.push("只有标点符号");
    else if (core.length <= minChars) reasons.push("单字孤立段，疑似音乐或噪声被误识别");
    if (dur < minDurationMs) reasons.push(`时长过短（${dur}ms）`);
    if (prevText !== null && s.text === prevText) reasons.push("与前一句内容完全相同");

    prevText = s.text;
    return reasons.length ? { ...s, suspect: true, suspectReasons: reasons } : s;
  });
}

/**
 * 按字数断行。中文单行建议 ≤ 16 字，最多 2 行。
 * 断点优先选在标点之后，避免把词从中间劈开。
 * @returns {string} 含 \n 的多行文本
 */
export function wrapText(text, maxChars = 16) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;

  const lines = [];
  let rest = t;
  while (rest.length > maxChars) {
    // 在 [mid-half, mid+half] 范围内找最靠中间的标点断点
    const mid = Math.ceil(rest.length / 2);
    const lo = Math.max(1, mid - 4);
    const hi = Math.min(rest.length - 1, mid + 4);
    let cut = -1;
    for (let offset = 0; offset <= hi - lo; offset++) {
      for (const i of [mid + offset, mid - offset]) {
        if (i < lo || i > hi) continue;
        if (PUNCT_SET.has(rest[i - 1])) { cut = i; break; }
      }
      if (cut > 0) break;
    }
    if (cut <= 0) cut = mid; // 附近没有标点，从中间硬断
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    if (lines.length >= 3) break; // 兜底：最多断到 4 行，防止死循环
  }
  if (rest) lines.push(rest);
  return lines.filter((l) => l !== "").join("\n");
}

/** 毫秒 → SRT 时间戳，形如 00:00:04,000 */
export function toSrtTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msRem = total % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(msRem, 3)}`;
}

/**
 * 生成 SRT 文本。
 * @param {Array} segments 已规整化（可含 suspect 标记）的段
 * @param {{maxChars?:number}} [opts]
 */
export function toSrt(segments, opts = {}) {
  const { maxChars = 16 } = opts;
  const blocks = [];
  let index = 1;
  for (const s of segments) {
    const body = wrapText(s.text, maxChars);
    if (!body) continue;
    blocks.push(`${index}\n${toSrtTime(s.startMs)} --> ${toSrtTime(s.endMs)}\n${body}`);
    index++;
  }
  // SRT 规范要求块之间空行，且文件以换行结尾
  return blocks.join("\n\n") + "\n";
}

/** 生成纯文本（每句一行，用于快速目检识别效果） */
export function toPlainText(segments) {
  return segments.map((s) => s.text).join("\n") + "\n";
}

/**
 * 把句子级段拆成词级段（面板里做"逐词字幕"时才用）。
 * 没有 words 的段原样保留。
 */
export function splitToWordSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (!Array.isArray(s.words) || s.words.length === 0) { out.push(s); continue; }
    for (const w of s.words) {
      if (w.text && w.endMs > w.startMs) out.push({ text: w.text, startMs: w.startMs, endMs: w.endMs });
    }
  }
  return out;
}

/**
 * 把整条时间轴平移 offsetMs 毫秒。
 *
 * 用途：ASR 的时间戳是相对【送进去的音频文件】的，而面板是按图层的 in/out 点导出音频的。
 * 导出文件的时间 0 秒对应合成时间 offsetSec 秒，所以字幕要整体加上这个偏移，
 * 才能落在合成时间轴上正确的位置。
 *
 * @param {Array} segments 已规整化的段（改造前会先复制，不修改入参）
 * @param {number} offsetMs 偏移量，正数表示往时间轴后面挪
 * @returns {Array} 新数组
 */
export function shiftSegments(segments, offsetMs) {
  const off = Math.round(Number(offsetMs) || 0);
  if (off === 0) return segments;
  const shift = (ms) => Math.max(0, Math.round(ms) + off);
  return segments.map((s) => ({
    ...s,
    startMs: shift(s.startMs),
    endMs: shift(s.endMs),
    ...(Array.isArray(s.words)
      ? { words: s.words.map((w) => ({ ...w, startMs: shift(w.startMs), endMs: shift(w.endMs) })) }
      : {}),
  }));
}

/**
 * 统计摘要，用于日志与面板展示。
 */
export function summarize(segments, mediaDurationSec = 0) {
  const total = segments.length;
  const suspect = segments.filter((s) => s.suspect).length;
  const chars = segments.reduce((n, s) => n + stripPunct(s.text).length, 0);
  const speechMs = segments.reduce((n, s) => n + (s.endMs - s.startMs), 0);
  return {
    segments: total,
    suspectSegments: suspect,
    totalChars: chars,
    speechSeconds: Math.round(speechMs / 100) / 10,
    mediaDurationSeconds: Math.round(mediaDurationSec * 1000) / 1000,
    coveragePercent: mediaDurationSec > 0
      ? Math.round((speechMs / 1000 / mediaDurationSec) * 1000) / 10
      : null,
  };
}
