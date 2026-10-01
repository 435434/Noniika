/**
 * speech.js 单元 + 集成测试
 * ==========================================================
 * ① 纯函数：解析静音日志、翻转成语音区间、按语音校正句子边界
 * ② 集成：自己合成一段"有声-静音-有声"的 WAV，真跑一次 ffmpeg 静音检测
 *
 * 用法： node pipeline/test/speech-test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import {
  parseSilenceLog, silencesToSpeechMs, snapSegmentsToSpeech, detectSpeechIntervals,
  regroupTokensBySpeech
} from "../lib/speech.js";

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, pass: true });
  } catch (e) {
    results.push({ label, pass: false, err: e.message });
  }
}

/* ---------------------------------------------------------- ① 解析静音日志 */

check("① 解析 silencedetect 输出", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 1.001",
    "[silencedetect @ 0x1] silence_end: 1.601 | silence_duration: 0.600",
    "[silencedetect @ 0x1] silence_start: 2.602",
    "[silencedetect @ 0x1] silence_end: 3.202 | silence_duration: 0.600"
  ].join("\n");
  const s = parseSilenceLog(stderr);
  assert.strictEqual(s.length, 2);
  assert.ok(Math.abs(s[0].startSec - 1.001) < 1e-6);
  assert.ok(Math.abs(s[1].endSec - 3.202) < 1e-6);
});

check("① 末尾未闭合的静音补到片尾", () => {
  const s = parseSilenceLog("silence_start: 4.0");
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].endSec, null);
});

check("① 静音区间翻转成语音区间（含片尾）", () => {
  const speech = silencesToSpeechMs(
    [{ startSec: 1.0, endSec: 1.6 }, { startSec: 2.6, endSec: 3.2 }], 4.2);
  assert.strictEqual(speech.length, 3);
  assert.deepStrictEqual(speech[0], { startMs: 0, endMs: 1000 });
  assert.deepStrictEqual(speech[1], { startMs: 1600, endMs: 2600 });
  assert.deepStrictEqual(speech[2], { startMs: 3200, endMs: 4200 });
});

/* ---------------------------------------------------------- ② 校正句子边界 */

const S = (text, a, b) => ({ text, startMs: a, endMs: b });

check("② 句子比语音短 → 延长到语音结束", () => {
  const r = snapSegmentsToSpeech([S("你好", 500, 1200)], [{ startMs: 480, endMs: 1900 }]);
  assert.strictEqual(r.changes.length, 1);
  assert.deepStrictEqual([r.segments[0].startMs, r.segments[0].endMs], [480, 1900]);
});

check("② 句子比语音长 → 收缩到语音范围", () => {
  const r = snapSegmentsToSpeech([S("你好", 200, 2600)], [{ startMs: 480, endMs: 1900 }]);
  assert.deepStrictEqual([r.segments[0].startMs, r.segments[0].endMs], [480, 1900]);
});

check("② 超过 ±800ms 的调整不动它", () => {
  const r = snapSegmentsToSpeech([S("你好", 5000, 6200)], [{ startMs: 480, endMs: 1900 }]);
  assert.strictEqual(r.changes.length, 0);
  assert.deepStrictEqual([r.segments[0].startMs, r.segments[0].endMs], [5000, 6200]);
});

check("② 单侧调整量超限时保持该侧原值", () => {
  // 起点差 20ms（在 ±800ms 内）→ 校正；终点要动 1400ms（超限）→ 保持原值
  const segs = [S("第一句", 500, 1200), S("第二句", 1500, 2400)];
  const r = snapSegmentsToSpeech(segs, [{ startMs: 480, endMs: 2600 }], { gapMs: 50 });
  const a = r.segments[0];
  assert.strictEqual(a.startMs, 480, "起点应被校正到语音起点");
  assert.strictEqual(a.endMs, 1200, "终点超出 ±800ms → 应保持原值");
});

check("② 延长若压到下一句会被夹住（不重叠）", () => {
  const segs = [S("第一句", 1000, 1400), S("第二句", 1700, 2400)];
  // 语音到 1690，会压到第二句（1700）→ 必须被夹在 1650（留 50ms 缝隙）
  const r = snapSegmentsToSpeech(segs, [{ startMs: 980, endMs: 1690 }], { gapMs: 50 });
  const a = r.segments[0];
  const b = r.segments[1];
  assert.strictEqual(a.endMs, 1650, `第一句终点应被夹到 1650，实际 ${a.endMs}`);
  assert.ok(b.startMs - a.endMs >= 50, `间隙只有 ${b.startMs - a.endMs}ms`);
});

check("② 极短句被撑到最短显示时长", () => {
  const r = snapSegmentsToSpeech([S("嗯", 1000, 1120)], [{ startMs: 980, endMs: 1150 }], { minDurMs: 350 });
  const s = r.segments[0];
  assert.ok(s.endMs - s.startMs >= 350, `时长只有 ${s.endMs - s.startMs}ms`);
});

check("② 与任何语音都不重叠的句子保持原样", () => {
  const r = snapSegmentsToSpeech([S("幻觉段", 8000, 8400)], [{ startMs: 480, endMs: 1900 }]);
  assert.strictEqual(r.changes.length, 0);
  assert.deepStrictEqual([r.segments[0].startMs, r.segments[0].endMs], [8000, 8400]);
});

check("② 空语音区间时原样返回", () => {
  const segs = [S("你好", 500, 1200)];
  const r = snapSegmentsToSpeech(segs, []);
  assert.strictEqual(r.changes.length, 0);
  assert.strictEqual(r.segments.length, 1);
});

check("② 不修改入参（纯函数）", () => {
  const segs = [S("你好", 500, 1200)];
  snapSegmentsToSpeech(segs, [{ startMs: 480, endMs: 1900 }]);
  assert.deepStrictEqual([segs[0].startMs, segs[0].endMs], [500, 1200]);
});

/* ---------------------------------------------------------- ③ 真跑 ffmpeg */

/** 手写一段 WAV：有声 1s / 静音 0.6s / 有声 1s / 静音 0.6s / 有声 1s */
function writeTestWav(file) {
  const rate = 44100;
  const parts = [1, 0.6, 1, 0.6, 1];
  const chunks = [];
  for (let p = 0; p < parts.length; p++) {
    const n = Math.round(rate * parts[p]);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (p % 2 === 0) v = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate));
      buf.writeInt16LE(v, i * 2);
    }
    chunks.push(buf);
  }
  const pcm = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
  return (1 + 0.6 + 1 + 0.6 + 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aesub-speech-"));
const wav = path.join(tmp, "bursts.wav");
const dur = writeTestWav(wav);

let detectErr = null;
let detected = null;
try {
  detected = await detectSpeechIntervals(wav, { durationSec: dur, timeoutMs: 60000 });
} catch (e) {
  detectErr = e;
}

check("③ 真跑 ffmpeg 静音检测（不报错）", () => {
  if (detectErr) throw new Error(detectErr.message);
  assert.ok(detected && detected.intervals.length >= 3,
    "期望至少 3 段语音，实际 " + (detected ? detected.intervals.length : 0));
});

check("③ 检测出的语音区间与合成音频吻合（±150ms）", () => {
  if (detectErr) throw new Error(detectErr.message);
  const want = [[0, 1000], [1600, 2600], [3200, 4200]];
  const got = detected.intervals.slice(0, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(got[i].startMs - want[i][0]) < 150,
      `第 ${i + 1} 段起点 ${got[i].startMs} 与期望 ${want[i][0]} 差太多`);
    assert.ok(Math.abs(got[i].endMs - want[i][1]) < 150,
      `第 ${i + 1} 段终点 ${got[i].endMs} 与期望 ${want[i][1]} 差太多`);
  }
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }

/* ------------------------ ④ 字幕切分（以引擎段落为准，不许丢字、不许把词切开） */

/**
 * ⚠ 下面第一组数据**逐字来自 2026-09-30 的真机实测**：
 *   素材 = 用户的 `lv_0_20260614134554.mp4`，走「UVR 分离人声 → whisper.cpp large-v3-turbo」。
 *   引擎自己的段落（正确的语义单位）：
 *     同志们 | 这几天我们孤军奋战 | 牺牲了很多战友 | 面对死去的弟兄们 | 我朱德心中有亏
 *   而 silencedetect(-35dB/0.35s) 在**分离后的人声**上把字与字之间的音量低谷也算成了停顿
 *   （实测 0.43 / 0.49 / 0.68 / 0.75 / 0.94 秒的"假停顿"），当时按区间切出来的结果是：
 *     同志 | 们这几天我们孤军奋 | 战牺牲了很多战 | 友面对死去的弟兄 | 们我朱 | 德心中有 | 亏
 *   —— 一个字没丢，但每个词都被从中间切开，用户看到的就是「字幕前面少一两个字」。
 *   这组断言就是把这个坑钉死。
 */
const T = (text, a, b, seg) => ({ text, startMs: a, endMs: b, seg });
const VOCAL_TOKENS = [
  T("同", 880, 1080, 0), T("志", 1080, 1300, 0), T("们", 1300, 1580, 0),
  T("这", 1640, 1910, 1), T("几", 1910, 2180, 1), T("天", 2180, 2450, 1),
  T("我们", 2610, 2920, 1), T("孤", 3170, 3260, 1), T("军", 3260, 3530, 1),
  T("奋", 3710, 3800, 1), T("战", 3840, 4080, 1),
  T("牺", 4080, 4330, 2), T("牲", 4330, 4580, 2), T("了", 4580, 4840, 2),
  T("很多", 5050, 5360, 2), T("战", 5360, 5600, 2), T("友", 5600, 5900, 2),
  T("面", 5960, 6200, 3), T("对", 6200, 6430, 3), T("死", 6430, 6660, 3),
  T("去", 6660, 6900, 3), T("的", 6900, 7130, 3), T("弟", 7130, 7360, 3),
  T("兄", 7360, 7590, 3), T("们", 7590, 7780, 3),
  T("我", 7840, 8100, 4), T("朱", 8100, 8300, 4), T("德", 8300, 8560, 4),
  T("心", 9290, 9600, 4), T("中", 9600, 9800, 4), T("有", 9900, 10150, 4),
  T("亏", 10150, 10420, 4),
];
/** 与人声素材上实测到的"假停顿"完全一致的讲话区间 */
const VOCAL_ZONES = [
  { startMs: 990, endMs: 1260 }, { startMs: 2210, endMs: 3910 },
  { startMs: 4340, endMs: 5610 }, { startMs: 6370, endMs: 7660 },
  { startMs: 8150, endMs: 8610 }, { startMs: 9290, endMs: 10120 },
];

check("④ 分离人声上的假停顿，不许把词切开（真机数据）", () => {
  const got = regroupTokensBySpeech(VOCAL_TOKENS, VOCAL_ZONES, { maxChars: 16 });
  const texts = got.map((s) => s.text);
  assert.deepStrictEqual(texts, [
    "同志们", "这几天我们孤军奋战", "牺牲了很多战友", "面对死去的弟兄们", "我朱德心中有亏",
  ], "切分与引擎段落不一致：" + JSON.stringify(texts));
});

check("④ 一个字都不许丢（总文字必须与输入相同）", () => {
  const got = regroupTokensBySpeech(VOCAL_TOKENS, VOCAL_ZONES, { maxChars: 16 });
  assert.strictEqual(got.map((s) => s.text).join(""),
    VOCAL_TOKENS.map((t) => t.text).join(""), "少字或多字了");
});

check("④ 相邻两条不重叠，且时间递增", () => {
  const got = regroupTokensBySpeech(VOCAL_TOKENS, VOCAL_ZONES, { maxChars: 16 });
  for (let i = 0; i < got.length - 1; i++) {
    assert.ok(got[i].endMs <= got[i + 1].startMs, `第 ${i + 1} 条与第 ${i + 2} 条重叠了`);
    assert.ok(got[i].startMs < got[i + 1].startMs, "时间没有递增");
  }
});

check("④ 跨停顿被合并成一段时，仍按停顿切开（英文 JFK 场景）", () => {
  // whisper 会把两句并成一段（真值 [0,4][5.5,9.5]）；这段文字远超 16 的预算 ⇒ 该在 1.5s 停顿处切开
  const tks = [
    T("And", 0, 400, 0), T("so,", 400, 700, 0), T("my", 700, 900, 0), T("fellow", 900, 1400, 0),
    T("Americans,", 1400, 2000, 0), T("ask", 2000, 2400, 0), T("not", 2400, 2800, 0),
    T("what", 2800, 3200, 0), T("your", 3200, 3600, 0), T("country", 3600, 4000, 0),
    // ↓ 1.5 秒真停顿
    T("can", 5500, 5900, 0), T("do", 5900, 6200, 0), T("for", 6200, 6500, 0), T("you,", 6500, 7000, 0),
    T("ask", 7000, 7400, 0), T("what", 7400, 7800, 0), T("you", 7800, 8100, 0),
    T("can", 8100, 8400, 0), T("do", 8400, 8700, 0), T("for", 8700, 9000, 0),
    T("your", 9000, 9300, 0), T("country.", 9300, 9500, 0),
  ];
  const zs = [{ startMs: 0, endMs: 4000 }, { startMs: 5500, endMs: 9490 }];
  const got = regroupTokensBySpeech(tks, zs, { maxChars: 16 });
  assert.ok(got.length >= 2, "应当切开，实际 " + got.length + " 条");
  assert.ok(got[0].endMs <= 5500, "第一条第 " + got[0].endMs + "ms 就跨过了停顿");
  // ⚠ 相邻条各自会把首尾空白 trim 掉（它们本来就是 AE 里独立的图层），所以比对时忽略空白
  const want = "And so, my fellow Americans, ask not what your country can do for you, "
    + "ask what you can do for your country.";
  assert.strictEqual(got.map((s) => s.text).join("").replace(/\s+/g, ""),
    want.replace(/\s+/g, ""), "文字被改坏了");
});

check("④ 引擎把段首词算早了 1.5 秒 ⇒ 用讲话区间把起点拉回来", () => {
  // 模拟实测中的漂移：整段的词级时间戳被往前甩进上一句的静音
  const tks = [
    T("我們", 2000, 2770, 0), T("今天", 2770, 3530, 0), T("所", 3530, 3920, 0),
    T("做", 3920, 4200, 0), T("的", 4680, 4680, 0), T("一", 4680, 5060, 0), T("切", 5500, 5500, 0),
  ];
  const zs = [{ startMs: 3500, endMs: 5700 }];
  const got = regroupTokensBySpeech(tks, zs, { maxChars: 16 });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].startMs, 3500, "起点没被拉回讲话区间起点，实际 " + got[0].startMs);
  assert.strictEqual(got[0].text, "我們今天所做的一切");
});

check("④ 没有讲话区间时也能工作（只按段落+停顿切）", () => {
  const got = regroupTokensBySpeech(VOCAL_TOKENS, [], { maxChars: 16 });
  assert.strictEqual(got.length, 5);
  assert.strictEqual(got.map((s) => s.text).join(""), VOCAL_TOKENS.map((t) => t.text).join(""));
});

/* ---------------------------------------------------------- 汇总 */
const bad = results.filter((r) => !r.pass);
console.log("\n=== speech.js 测试 ===");
results.forEach((r) => console.log((r.pass ? "  ✅ " : "  ❌ ") + r.label + (r.pass ? "" : "  → " + r.err)));
console.log("\n  通过 " + (results.length - bad.length) + " / " + results.length);
process.exit(bad.length ? 1 : 0);
