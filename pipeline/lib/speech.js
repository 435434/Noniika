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

/* ============================================================================
 *  用「逐词时间戳 + 讲话区间」重新切字幕 —— 让字幕出入点贴住说话出入点
 * ============================================================================
 *
 * ⚠ 为什么需要它（2026-09-29 实测，真语音 + 已知停顿的素材）：
 *   whisper（以及多数 ASR）给的是**段落级**时间戳，它会**跨过停顿把两句并成一段**：
 *     真值 讲话 [0,4] [5.5,9.5] [11,14]  →  whisper 段落 [0,9] [9,14]
 *   用它的段落边界做字幕，平均偏差 **起点 2.5 秒 / 终点 3.2 秒** —— 表现为
 *   「有的字幕早了、有的晚了」，且一头扎进静音里。
 *
 *   但它的**逐词**时间戳是准的（`whisper-cli -ojf` 里每个 token 都带毫秒偏移）。
 *   所以正确做法是：**别再信它的段落边界** ——
 *     ① 用 ffmpeg silencedetect 找出真正的讲话区间；
 *     ② 把每个 token 归到它所在的那段讲话里；
 *     ③ 每段讲话 = 一到多条字幕，出入点取「讲话区间边缘」与「词首/词尾 ± 微余量」的交集。
 *
 *   实测同一素材：平均偏差 **起点 0.02 秒 / 终点 0.00 秒**（≈逐帧对齐）。
 */

/** ⚠⚠ 字幕切分**不许**交给静音检测 —— 这些常量的来历见下面 regroupTokensBySpeech 的说明 */
/** 词与词之间的空隙达到这个值，才算"人在换气/断句"的真停顿（毫秒） */
export const SPLIT_GAP_MS = 600;
/** 只有与"讲话区间边界"的偏差**超过**这个值，才认为是引擎词级时间戳漂了、并用区间边界纠正（毫秒） */
export const ZONE_SNAP_MIN_MS = 1000;
/** 词首往前多留一点点（避免起音被切） */
export const TOKEN_LEAD_MS = 60;
/** 词尾往后多留一点点（避免尾音被切） */
export const TOKEN_TAIL_MS = 100;
/** 一条字幕短于这个时长就**并进邻条**（⚠ 不再丢弃 —— 丢字比"两条挤一起"严重得多） */
export const TOKEN_MIN_SEG_MS = 220;

/**
 * 一个 token 的"长度权重"。
 *
 * ⚠ 不能直接数字符：同样 16 个字符，中文是一句完整的话，英文只有两三个单词。
 *   所以按「汉字 1 / 拉丁字母数字 0.4 / 标点 0.2」折算 —— 16 的预算下
 *   中文约 16 字、英文约 40 字符，两边都落在正常字幕的长度上。
 */
export function tokenWeight(plain) {
  let w = 0;
  for (const ch of String(plain || "")) {
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch)) w += 1;
    else if (/[A-Za-z0-9]/.test(ch)) w += 0.4;
    else if (!/\s/.test(ch)) w += 0.2;
  }
  return w || 0.4;
}

/** 只剩标点/空白（没有实际内容）的碎片不该单独成条 */
function hasContent(text) {
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(String(text || ""));
}

/**
 * 按"长度预算"把一串词切成多条字幕（断点优先落在句读标点之后，更贴近人的阅读节奏）。
 *
 * @param {{text:string,startMs:number,endMs:number}[]} tokens
 * @param {number} budget 预算（按 tokenWeight 折算）
 */
function splitTokensByBudget(tokens, budget) {
  const pieces = [];
  let buf = [];
  let used = 0;
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((x) => x.text).join("").trim();
    if (text) {
      pieces.push({
        text,
        startMs: buf[0].startMs,
        endMs: buf[buf.length - 1].endMs,
      });
    }
    buf = [];
    used = 0;
  };

  for (const tk of tokens) {
    const plain = String(tk.text).replace(/\s+/g, "");
    const w = tokenWeight(plain);
    if (buf.length && used + w > budget) flush();
    buf.push(tk);
    used += w;
    // 落在强断句标点上，且已经用了过半预算 → 收一条
    if (buf.length && /[。！？!?…]$/.test(plain) && used >= budget * 0.5) flush();
  }
  flush();
  return pieces;
}

/**
 * 收尾整理：① 纯标点碎片并进邻条 ② 太短的条并进邻条 ③ 相邻条不重叠。
 *
 * ⚠ 这里**一条都不许丢**：旧版把"纯标点"和"短于 220ms"的条直接扔掉，
 *   那正是"字幕少字"的一个出口。现在一律**并入邻条**。
 */
function tidyPieces(pieces) {
  // ① 纯标点碎片并进邻条（没有上一条就并进下一条）
  for (let k = pieces.length - 1; k >= 0; k--) {
    if (hasContent(pieces[k].text)) continue;
    if (k > 0) {
      pieces[k - 1].text = (pieces[k - 1].text + pieces[k].text).trim();
      pieces[k - 1].endMs = Math.max(pieces[k - 1].endMs, pieces[k].endMs);
    } else if (pieces.length > 1) {
      pieces[1].text = (pieces[k].text + pieces[1].text).trim();
      pieces[1].startMs = Math.min(pieces[1].startMs, pieces[k].startMs);
    }
    pieces.splice(k, 1);
  }

  // ② 太短的一条并进邻条（宁可挤一点，也不许缺字）
  for (let k = pieces.length - 1; k >= 0; k--) {
    if (pieces[k].endMs - pieces[k].startMs >= TOKEN_MIN_SEG_MS) continue;
    if (k > 0) {
      pieces[k - 1].text = (pieces[k - 1].text + pieces[k].text).trim();
      pieces[k - 1].endMs = Math.max(pieces[k - 1].endMs, pieces[k].endMs);
    } else if (pieces.length > 1) {
      pieces[1].text = (pieces[0].text + pieces[1].text).trim();
      pieces[1].startMs = Math.min(pieces[1].startMs, pieces[0].startMs);
    }
    pieces.splice(k, 1);
  }

  // ③ 相邻条不重叠（前一条的尾巴不许压到后一条的头上）
  for (let k = 0; k < pieces.length - 1; k++) {
    if (pieces[k].endMs > pieces[k + 1].startMs) {
      pieces[k].endMs = Math.max(pieces[k].startMs + 120, pieces[k + 1].startMs);
    }
  }
  return pieces;
}

/** 离 ms 最近的"区间起点" */
function nearestZoneStart(zones, ms) {
  let best = null;
  for (const z of zones) {
    const d = Math.abs(z.startMs - ms);
    if (!best || d < best.d) best = { d, v: z.startMs };
  }
  return best;
}
/** 离 ms 最近的"区间终点" */
function nearestZoneEnd(zones, ms) {
  let best = null;
  for (const z of zones) {
    const d = Math.abs(z.endMs - ms);
    if (!best || d < best.d) best = { d, v: z.endMs };
  }
  return best;
}

/**
 * 按「引擎段落 ＋ 真停顿」切字幕，再用「讲话区间」只纠正**明显漂移**的时间。
 *
 * ============================================================================
 * ⚠⚠⚠ 这一节是本项目最贵的一课，动它之前请把下面三段都读完。
 * ============================================================================
 *
 * 【第一课】不要用引擎的**段落边界**直接当字幕时间（2026-09-29 实测）
 *   whisper 会跨过停顿把两句并成一段：真值讲话 [0,4][5.5,9.5][11,14]，它给 [0→9][9→14]，
 *   平均偏差 起点 2.5s / 终点 3.2s。⇒ 必须用它的**逐词**时间戳（`-ojf`）来定时间。
 *
 * 【第二课】但也**不要**用静音检测的区间去决定"切在哪"（2026-09-30 实测，踩结实了）
 *   用户真实素材 + 分离后的人声，ffmpeg silencedetect(-35dB/0.35s) 会把**同一个词的
 *   字与字之间**的低音量低谷（实测 0.43 / 0.49 / 0.68 / 0.75 / 0.94 秒）全当成停顿：
 *     whisper 自己的段落：  同志们 | 这几天我们孤军奋战 | 牺牲了很多战友 | …
 *     按区间切（错）：      同志 | 们这几天我们孤军奋 | 战牺牲了很多战 | 友面对死去的弟兄 | …
 *   一个字都没丢，但**每个词都被从中间切开** —— 用户看到的就是"字幕前面少一两个字"。
 *   原因：人声分离后字间能量本来就低，阈值一刀下去切进了词里。
 *   ⇒ **字幕切分必须以引擎自己的段落为准**（它才是"语义"单位），
 *      只在**词与词之间出现 ≥ SPLIT_GAP_MS 的真空隙**时才切开（跨停顿并被合并的段就靠这条拆开）。
 *      讲话区间**只**用来纠正"引擎漂了很大一截"（> ZONE_SNAP_MIN_MS）的边界，小的偏差一律信引擎。
 *
 * 【第三课】无论怎么切，**一个字都不许丢**（丢字比"切得不好"严重得多）
 *   过短的条、纯标点的条都**并进邻条**，绝不丢弃。
 *
 * @param {{text:string,startMs:number,endMs:number,seg?:number}[]} tokens
 *        逐词（来自 whisper -ojf）；`seg` = 它所属的引擎段落序号（local.js 会带上）
 * @param {{startMs:number,endMs:number}[]} speech 讲话区间（用于纠正漂移，可留空）
 * @param {object} [opts]
 * @param {number} [opts.maxChars]      单条字幕的"长度预算"（默认 16，按 tokenWeight 折算）
 * @param {number} [opts.splitGapMs]    "真停顿"阈值（默认 600ms）
 * @param {number} [opts.snapMinMs]     多大的偏差才允许用讲话区间纠正（默认 1000ms）
 * @returns {{text:string,startMs:number,endMs:number}[]} 为空表示"没用上"，调用方应退回原段落
 */
export function regroupTokensBySpeech(tokens, speech, opts = {}) {
  const budget = Math.max(6, Number(opts.maxChars) || 16);
  const splitGap = opts.splitGapMs ?? SPLIT_GAP_MS;
  const snapMin = opts.snapMinMs ?? ZONE_SNAP_MIN_MS;
  const lead = opts.leadMs ?? TOKEN_LEAD_MS;
  const tail = opts.tailMs ?? TOKEN_TAIL_MS;

  const list = (tokens || [])
    .filter((x) => x && x.text && String(x.text).replace(/\s+/g, ""))
    .map((x) => ({
      text: x.text,
      startMs: Math.round(x.startMs),
      endMs: Math.round(Math.max(x.endMs, x.startMs)),
      seg: x.seg === undefined || x.seg === null ? null : Number(x.seg),
    }))
    .sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
  const zones = (speech || [])
    .map((s) => ({ startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (!list.length) return [];

  // ── ① 切成语义组 ──
  //    a) **先按引擎段落分** —— 段落是"语义"单位，最可信；
  //    b) 段落**太长**（超过预算）时，才在内部的"真停顿"处继续切。
  //    ⚠⚠ 反面教训（2026-09-30 实测）：如果"看到 ≥600ms 的空隙就切"，会把
  //       "我朱德 / 心中有愧" 这种**被分离后音量低谷切出来的假停顿**也当成分句
  //       （实测假停顿 0.43~0.94 秒，比真停顿还长）。所以：
  //       **切不切由"长度"决定，停顿只用来决定"切在哪"。**
  const weightOf = (arr) =>
    arr.reduce((a, t) => a + tokenWeight(String(t.text).replace(/\s+/g, "")), 0);

  const blocks = [];
  let blk = [];
  for (const tk of list) {
    const prev = blk.length ? blk[blk.length - 1] : null;
    if (prev && tk.seg !== null && prev.seg !== null && tk.seg !== prev.seg) {
      blocks.push(blk);
      blk = [];
    }
    blk.push(tk);
  }
  if (blk.length) blocks.push(blk);

  const groups = [];
  for (const b of blocks) {
    if (weightOf(b) <= budget) {          // 整段不长 ⇒ 一条字幕，绝不在内部切
      groups.push(b);
      continue;
    }
    // 太长 ⇒ 在真停顿处切（"跨停顿被合并成一段"就靠这里拆开）
    let cur = [];
    for (const tk of b) {
      const prev = cur.length ? cur[cur.length - 1] : null;
      if (prev && tk.startMs - prev.endMs >= splitGap) {
        groups.push(cur);
        cur = [];
      }
      cur.push(tk);
    }
    if (cur.length) groups.push(cur);
  }

  // ── ② 每组定时间；偏差太大的边界用讲话区间纠正（第三课：小的偏差信引擎） ──
  const out = [];
  for (const g of groups) {
    let start = Math.max(0, g[0].startMs - lead);
    let end = g[g.length - 1].endMs + tail;

    if (zones.length) {
      const ns = nearestZoneStart(zones, start);
      if (ns && ns.d > snapMin && ns.v > start) start = ns.v;      // 引擎把起点算早了 ⇒ 拉回来
      const ne = nearestZoneEnd(zones, end);
      if (ne && ne.d > snapMin && ne.v > end) end = ne.v;          // 引擎把终点算早了 ⇒ 推出去
    }
    if (!(end > start)) end = start + 200;

    // ── ③ 组内按预算切条（长句才切，短句就一条） ──
    const pieces = splitTokensByBudget(g, budget);
    let prevEnd = start;
    for (let i = 0; i < pieces.length; i++) {
      const first = i === 0;
      const last = i === pieces.length - 1;
      let s = first ? start : Math.max(pieces[i].startMs - lead, prevEnd + 20);
      let e = last ? end : Math.min(pieces[i].endMs + tail, end);
      if (e < s + 120) e = s + 120;
      pieces[i].startMs = Math.round(s);
      pieces[i].endMs = Math.round(e);
      prevEnd = e;
    }
    out.push(...tidyPieces(pieces));
  }

  // ── ④ 全局兜底：相邻条不重叠；只滤掉"整条没有任何实际内容"的（纯标点幻觉） ──
  for (let k = 0; k < out.length - 1; k++) {
    if (out[k].endMs > out[k + 1].startMs) {
      out[k].endMs = Math.max(out[k].startMs + 120, out[k + 1].startMs);
    }
  }
  return out.filter((pc) => hasContent(pc.text) && pc.endMs > pc.startMs);
}
