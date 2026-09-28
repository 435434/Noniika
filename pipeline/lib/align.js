/**
 * align.js —— 给"没有时间戳的识别结果"重建时间轴
 * ==================================================================
 * 问题：有些 ASR 服务（典型是免费的 SenseVoice）只回 **一整段纯文本**，没有句子边界。
 *      而字幕的本质就是"哪句话在什么时候出现"，没有时间轴等于没用。
 *
 * 解法分两层，都在这里：
 *
 *  ① **切块识别**（首选，得到真时间戳）
 *     用 ffmpeg 静音检测找出说话区间 → 把相邻区间合并成 ≤ maxChunkMs 的"块"
 *     → 逐块切成小音频送给 ASR → **每块的起止就是该块文字的真实时间范围**。
 *     这块是"物理真实"的：块边界落在静音里，所以不会把词切断。
 *     代价是多次请求；对免费档无所谓，对按量计费的档要留意。
 *
 *  ② **块内按字数分配**（结构上必须有的一步）
 *     一块里往往有好几句话。块内没有更多信息可用，就按**去标点后的字数**比例
 *     把块时长分给各句，并把切分点吸附到块内的子区间边界上（优先落在停顿处）。
 *     这是**近似**，不是对齐 —— 但它保证：顺序正确、不重叠、总时长正确、
 *     优先级落在真实停顿上。对"一句话说完到下一句"这种节奏，观感是对的。
 *
 * ⚠ 诚实的边界：如果说话人**全程不停顿**地说 1 分钟，② 只能按字数平均分，
 *   观感会有偏差。这不是 bug，是"服务商不给时间戳"这件事的物理上限。
 *   想要逐字精准，就选返回时间戳的档位（腾讯云 / Whisper 系）。
 *
 * 纯函数（groupIntervals / splitText / distributePieces）都单独导出，便于测试。
 */

/** 单个块的最长时长：太长会让块内分配变粗，太短会让请求数暴涨 */
export const MAX_CHUNK_MS = 24000;
/** 相邻语音区间间隔小于这个值就并进同一块（把人说话中间的换气也算连读） */
export const MERGE_GAP_MS = 700;
/** 切块时向静音里各留一点余量，避免切掉起音/尾音 */
export const LEAD_MS = 120;
export const TAIL_MS = 240;
/** 块内分配到的最短句时长 */
export const MIN_PIECE_MS = 320;

/**
 * 把语音区间合并成"块"。
 *
 * @param {{startMs:number,endMs:number}[]} intervals 说话区间（来自静音检测）
 * @param {object} [opts]
 * @returns {{startMs:number,endMs:number,intervals:Array}[]}
 */
export function groupIntervals(intervals, opts = {}) {
  const maxChunkMs = opts.maxChunkMs ?? MAX_CHUNK_MS;
  const mergeGapMs = opts.mergeGapMs ?? MERGE_GAP_MS;
  const leadMs = opts.leadMs ?? LEAD_MS;
  const tailMs = opts.tailMs ?? TAIL_MS;

  const list = (intervals || [])
    .map((iv) => ({ startMs: Math.max(0, Math.round(iv.startMs)), endMs: Math.max(0, Math.round(iv.endMs)) }))
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const chunks = [];
  let cur = null;

  for (const iv of list) {
    if (!cur) { cur = { startMs: iv.startMs, endMs: iv.endMs, intervals: [iv] }; continue; }

    const gap = iv.startMs - cur.endMs;
    const mergedLen = iv.endMs - cur.startMs;

    // 并进去的条件：中间几乎没停顿 **且** 并完还不超长
    if (gap <= mergeGapMs && mergedLen <= maxChunkMs) {
      cur.endMs = iv.endMs;
      cur.intervals.push(iv);
    } else {
      chunks.push(cur);
      cur = { startMs: iv.startMs, endMs: iv.endMs, intervals: [iv] };
    }
  }
  if (cur) chunks.push(cur);

  // 向静音里补余量（首尾不外扩到 0 以下）
  return chunks.map((c) => ({
    startMs: Math.max(0, c.startMs - leadMs),
    endMs: c.endMs + tailMs,
    intervals: c.intervals,
  }));
}

/**
 * 把一整段文本切成"字幕级"的片段。
 *
 * 先按句末标点切成句子；句子若还太长，再按逗号之类的次级标点切；
 * 仍太长就按字数硬切（避免出现一行字幕撑满整屏）。
 *
 * @param {string} text
 * @param {{maxChars?:number, hardLimit?:number}} [opts]
 * @returns {string[]}
 */
export function splitText(text, opts = {}) {
  const maxChars = opts.maxChars ?? 16;
  const hardLimit = opts.hardLimit ?? Math.max(28, maxChars * 2);
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  // ① 句末标点 + 换行 → 粗切
  const rough = s.split(/(?<=[。！？!?；;…]|\n)/u).map((x) => x.trim()).filter(Boolean);

  // ② 太长的句子按次级标点再切
  const mid = [];
  for (const r of rough) {
    if (r.length <= hardLimit) { mid.push(r); continue; }
    const parts = r.split(/(?<=[，,、：:）)])/u).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) mid.push(...parts);
    else mid.push(r);
  }

  // ③ 仍然太长的按字数硬切
  const out = [];
  for (const m of mid) {
    if (m.length <= hardLimit) { out.push(m); continue; }
    for (let i = 0; i < m.length; i += hardLimit) out.push(m.slice(i, i + hardLimit));
  }
  return out.filter((x) => x.trim() !== "");
}

/** 去标点后的字数 —— 分配时长用的"权重"。标点不占时间，所以不计入。 */
export function weightOf(text) {
  const core = String(text || "").replace(/[\s，。！？；：、（）《》【】“”‘’—…·,.!?;:()\[\]<>"'`~]/gu, "");
  return Math.max(1, core.length);
}

/**
 * 把若干文字片段铺在给定时间窗内。
 *
 * 分配规则：
 *   1. 按权重比例算出每段的时长
 *   2. 顺序落位，并且**不跨过静音间隙**：映射时若某个点的虚拟位置落在间隙里，
 *      就吸附到前一个语音区间的末尾（宁可早结束，也不要盖住静音）
 *   3. 保证不重叠、不低于 MIN_PIECE_MS
 *
 * @param {string[]} pieces
 * @param {number} startMs 时间窗起点（绝对毫秒）
 * @param {number} endMs   时间窗终点
 * @param {{startMs:number,endMs:number}[]} [subIntervals] 时间窗内的语音区间（用于吸附）
 * @returns {Array<{text:string,startMs:number,endMs:number}>}
 */
export function distributePieces(pieces, startMs, endMs, subIntervals) {
  const list = (pieces || []).filter((t) => String(t || "").trim() !== "");
  if (!list.length) return [];
  const winStart = Math.max(0, Math.round(startMs));
  const winEnd = Math.max(winStart + 1, Math.round(endMs));

  // 用语音区间构造"虚拟时间轴"：只累计真正在说话的部分，指向真实的毫秒位置
  const spans = (subIntervals || [])
    .map((iv) => ({ s: Math.max(winStart, Math.round(iv.startMs)), e: Math.min(winEnd, Math.round(iv.endMs)) }))
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);

  const useSpans = spans.length > 0;
  let cum = 0;
  const marks = [];
  if (useSpans) {
    for (const sp of spans) {
      marks.push({ vStart: cum, vEnd: cum + (sp.e - sp.s), s: sp.s, e: sp.e });
      cum += sp.e - sp.s;
    }
  }
  const virtualTotal = useSpans ? cum : (winEnd - winStart);

  /**
   * 虚拟位置 → 真实毫秒。
   *
   * ⚠ 这里必须分成"取起点"和"取终点"两个函数，不能合二为一。
   *   原因：区间的虚拟边界点是**双关的** —— 它既是上一段的尾部，又是下一段的头部。
   *   v=2000 在 [{0,2000},{8000,10000}] 上：
   *     作为**终点**应当回 2000（第一段语音的结束）
   *     作为**起点**应当回 8000（第二段语音的开始）
   *   早先只写了一个 mapV，两边都返回 2000，结果第二段字幕从 2000 一路盖到 10000，
   *   把中间 6 秒静音全吃掉了（自测抓到的真实缺陷）。
   */
  const linearOrSpan = (v, mode) => {
    if (!useSpans) {
      const t = winStart + Math.max(0, Math.min(virtualTotal, v));
      return Math.max(winStart, Math.min(winEnd, t));
    }
    if (mode === "start") {
      for (const m of marks) {
        if (v < m.vEnd) return Math.max(m.s, Math.min(m.e, m.s + (v - m.vStart)));
      }
      return marks[marks.length - 1].e;
    }
    // mode === "end"：若正好落在某段的虚拟起点上，取上一段的末尾（宁可早结束）
    let prevEnd = null;
    for (const m of marks) {
      if (v <= m.vStart) return prevEnd !== null ? prevEnd : m.s;
      if (v <= m.vEnd) return Math.max(m.s, Math.min(m.e, m.s + (v - m.vStart)));
      prevEnd = m.e;
    }
    return marks[marks.length - 1].e;
  };
  const mapStart = (v) => linearOrSpan(v, "start");
  const mapEnd = (v) => linearOrSpan(v, "end");

  const weights = list.map(weightOf);
  const totalW = weights.reduce((a, b) => a + b, 0);

  // 每段能分到的"保底时长"：窗口装不下 MIN_PIECE_MS×段数 时，退而求其次均匀铺满。
  // 这样保证不会出现零长或 1ms 的退化段（宁可都短一点，也不能有段被挤没）。
  const floorMs = Math.max(1, Math.min(MIN_PIECE_MS, Math.floor((winEnd - winStart) / list.length)));

  const out = [];
  let vCursor = 0;
  for (let i = 0; i < list.length; i++) {
    const share = (weights[i] / totalW) * virtualTotal;
    const vStart = vCursor;
    const vEnd = Math.min(virtualTotal, vCursor + share);
    vCursor = vEnd;

    let s = Math.round(mapStart(vStart));
    let e = Math.round(mapEnd(vEnd));

    // 保底时长（但仍不越过窗口）
    if (e - s < floorMs) e = Math.min(winEnd, s + floorMs);

    // 不与上一段重叠
    const prev = out[out.length - 1];
    if (prev && s < prev.endMs) s = prev.endMs;
    if (e - s <= 0) e = Math.min(winEnd, s + floorMs);

    if (e > s) out.push({ text: list[i].trim(), startMs: s, endMs: e });
  }

  // 最后一段至少留够保底时长（如果窗口允许）
  const last = out[out.length - 1];
  if (last && last.endMs - last.startMs < floorMs) {
    last.endMs = Math.min(winEnd, last.startMs + floorMs);
  }
  return out;
}

/**
 * 只有纯文本、又不想多花请求时用的**整体**近似分配：
 * 把整段文本铺在全部语音区间上。
 *
 * 什么时候用：服务商按时长计费、或用户显式关掉切块模式（--no-chunk-asr）。
 * 精度明显低于切块，但零额外请求。
 */
export function alignPlainText(text, intervals, opts = {}) {
  const pieces = splitText(text, opts);
  if (!pieces.length) return [];
  const list = (intervals || []).filter((iv) => iv.endMs > iv.startMs);
  if (!list.length) return [];
  const startMs = list[0].startMs;
  const endMs = list[list.length - 1].endMs;
  return distributePieces(pieces, startMs, endMs, list);
}
