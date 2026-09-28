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
  parseSilenceLog, silencesToSpeechMs, snapSegmentsToSpeech, detectSpeechIntervals
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

/* ---------------------------------------------------------- 汇总 */
const bad = results.filter((r) => !r.pass);
console.log("\n=== speech.js 测试 ===");
results.forEach((r) => console.log((r.pass ? "  ✅ " : "  ❌ ") + r.label + (r.pass ? "" : "  → " + r.err)));
console.log("\n  通过 " + (results.length - bad.length) + " / " + results.length);
process.exit(bad.length ? 1 : 0);
