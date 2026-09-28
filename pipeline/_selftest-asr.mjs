/**
 * _selftest-asr.mjs —— 识别链路的离线端到端自测
 * ==================================================================
 * 为什么需要它：改造后最复杂、最容易错的一条路是
 *   「服务商只回文字不回时间戳」→ 按静音切块 → 块边界当时间轴
 * 这条路没法靠"看一眼代码"确认对不对，也没法用真接口测（要密钥、要联网、要花钱）。
 * 所以这里造一段**结构已知**的合成音频，用**假的识别函数**跑通整条链路，
 * 再用断言核对时间轴是否真的落在该落的地方。
 *
 * 覆盖：
 *   ① align.js 的纯函数（切块合并 / 文本切分 / 块内按字数分配 / 权重）
 *   ② 真实 ffmpeg 静音检测 → 真切块 → 逐块"识别" → 时间轴拼回全局
 *   ③ 两条降级路径：禁切块（单次调用 + 语音区间近似分配）、分块失败时的如实汇报
 *
 * 用法：node pipeline/_selftest-asr.mjs
 * 退出码 0 = 全过；1 = 有断言失败（会打印失败项）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { transcribeAudio } from "./lib/asr.js";
import {
  alignPlainText, distributePieces, groupIntervals, splitText, weightOf, MIN_PIECE_MS,
} from "./lib/align.js";
import { detectSpeechIntervals } from "./lib/speech.js";
import { getFfmpegPath } from "./lib/paths.js";
import {
  CONTENT_TYPE_VALUE, SIGNED_HEADERS,
  buildAuthorization, buildCanonicalRequest, buildHeaders, parseResultDetail,
} from "./lib/providers/tencent.js";
import { filterAsrModels } from "./lib/providers/openai-compat.js";
import { removePunctuation, stripPunct, normalizeSegments, markSuspectSegments, toSrt } from "./lib/postprocess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra !== undefined ? `  →  ${extra}` : ""));
}
function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= tol, `实际 ${actual}，期望 ${expected}±${tol}`);
}

/* ---------------------------------------------------------------- 合成音频 */

const SR = 16000;

/**
 * 手写一个 16kHz / 单声道 / 16bit WAV。
 * @param {string} file 输出路径
 * @param {{startSec:number,endSec:number,freq:number}[]} bursts 有声音的区间
 * @param {number} totalSec 总时长
 */
function writeWav(file, bursts, totalSec) {
  const n = Math.round(totalSec * SR);
  const pcm = Buffer.alloc(n * 2);          // 全 0 = 数字静音
  for (const b of bursts) {
    const i0 = Math.round(b.startSec * SR);
    const i1 = Math.min(n, Math.round(b.endSec * SR));
    for (let i = i0; i < i1; i++) {
      // 0.5 幅度 ≈ -6dBFS，远高于 -32dB 的静音阈值
      const v = Math.round(Math.sin((2 * Math.PI * b.freq * i) / SR) * 0.5 * 32767);
      pcm.writeInt16LE(v, i * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // 单声道
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

/* ---------------------------------------------------------------- 纯函数断言 */

function testPure() {
  // groupIntervals：间隔 200ms（< 700ms）且不太长 → 并成一块
  const g1 = groupIntervals([{ startMs: 0, endMs: 1000 }, { startMs: 1200, endMs: 2000 }]);
  ok("groupIntervals 小间隔合并成 1 块", g1.length === 1, `实际 ${g1.length} 块`);

  // 间隔 3 秒（> 700ms）→ 分成两块
  const g2 = groupIntervals([{ startMs: 0, endMs: 1000 }, { startMs: 4000, endMs: 5000 }]);
  ok("groupIntervals 大间隔切成 2 块", g2.length === 2, `实际 ${g2.length} 块`);

  // 超长区间段会被 maxChunkMs 切开（每块不超过 24s + 余量）
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ startMs: i * 3000, endMs: i * 3000 + 2900 });
  const g3 = groupIntervals(many);
  const maxLen = Math.max(...g3.map((c) => c.endMs - c.startMs));
  ok("groupIntervals 每块不超过 24s 余量内", maxLen <= 24000 + 400, `最长块 ${maxLen}ms`);

  // groupIntervals 会向静音里补余量（起止各外扩）
  ok("groupIntervals 首块起点被前推（留余量）", g3[0].startMs === 0, `实际 ${g3[0].startMs}`);

  // splitText：按句末标点切开
  const st = splitText("你好世界。第二句话！第三句？", { maxChars: 16 });
  ok("splitText 按句末标点切成 3 段", st.length === 3, JSON.stringify(st));

  // splitText：超长句按次级标点再切
  const st2 = splitText("这是一个很长很长的句子，长到我必须被切开来，否则一行字幕根本放不下。", { maxChars: 16, hardLimit: 20 });
  ok("splitText 长句被继续切分（>1 段）", st2.length > 1, JSON.stringify(st2));
  ok("splitText 每段不超过 hardLimit", st2.every((x) => x.length <= 20), JSON.stringify(st2));

  // weightOf：标点不计入权重，且至少为 1
  ok("weightOf 忽略标点", weightOf("你好，世界！") === 4, String(weightOf("你好，世界！")));
  ok("weightOf 全标点也至少为 1", weightOf("，。！") === 1, String(weightOf("，。！")));

  // distributePieces：总时长按字长比例分配
  const dp = distributePieces(["四个字啊", "两字"], 0, 6000, [{ startMs: 0, endMs: 6000 }]);
  ok("distributePieces 返回 2 段", dp.length === 2, JSON.stringify(dp));
  ok("distributePieces 首段更长（4字 vs 2字）",
    dp.length === 2 && (dp[0].endMs - dp[0].startMs) > (dp[1].endMs - dp[1].startMs),
    JSON.stringify(dp));
  ok("distributePieces 不重叠", dp.length === 2 && dp[0].endMs <= dp[1].startMs, JSON.stringify(dp));
  ok("distributePieces 末段不越界", dp.length === 2 && dp[1].endMs <= 6000, JSON.stringify(dp));

  // distributePieces：有空隙时不应把字幕盖到静音上（吸附到区间末尾）
  const dp2 = distributePieces(["第一段", "第二段"], 0, 10000, [
    { startMs: 0, endMs: 2000 }, { startMs: 8000, endMs: 10000 },
  ]);
  ok("distributePieces 有静音间隙时仍分 2 段", dp2.length === 2, JSON.stringify(dp2));
  ok("distributePieces 第二段落在第二段语音上", dp2.length === 2 && dp2[1].startMs >= 6000, JSON.stringify(dp2));

  // alignPlainText：整段文本铺在语音区间上
  const ap = alignPlainText("第一句话。第二句话。", [{ startMs: 1000, endMs: 5000 }], { maxChars: 16 });
  ok("alignPlainText 产出 2 段", ap.length === 2, JSON.stringify(ap));
  ok("alignPlainText 起点不早于首个语音区间", ap.length > 0 && ap[0].startMs >= 1000, JSON.stringify(ap));

  // 最短时长下限被遵守（窗口足够大时应当满足 MIN_PIECE_MS）
  const dpWide = distributePieces(["一", "二"], 0, 5000, [{ startMs: 0, endMs: 5000 }]);
  ok("distributePieces 窗口充足时每段不短于 MIN_PIECE_MS",
    dpWide.length === 2 && dpWide.every((s) => (s.endMs - s.startMs) >= MIN_PIECE_MS),
    JSON.stringify(dpWide));

  // 窗口装不下时（900ms 分 3 段），要"均匀铺满且没有零长段"，而不是出现 1ms 的退化段
  const dp3 = distributePieces(["一", "二", "三"], 0, 900, [{ startMs: 0, endMs: 900 }]);
  ok("distributePieces 窗口紧张时仍分 3 段", dp3.length === 3, JSON.stringify(dp3));
  ok("distributePieces 窗口紧张时无零长段",
    dp3.every((s) => s.endMs - s.startMs >= 1), JSON.stringify(dp3));
  ok("distributePieces 窗口紧张时铺满窗口",
    dp3.length === 3 && dp3[2].endMs === 900 && dp3[0].startMs === 0, JSON.stringify(dp3));
  ok("distributePieces 窗口紧张时各段时长接近均匀",
    dp3.length === 3 && Math.max(...dp3.map((s) => s.endMs - s.startMs)) - Math.min(...dp3.map((s) => s.endMs - s.startMs)) <= 2,
    JSON.stringify(dp3));
}

/* ---------------------------------------------------------------- 端到端 */

async function testChunked() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aesub-selftest-"));
  const wav = path.join(tmp, "synth.wav");

  // 结构：静音 0~1s ｜ 说话 1~3s ｜ 静音 3~5s ｜ 说话 5~7s ｜ 静音 7~8s
  // 两段说话之间有 2 秒静音（> 700ms），所以应当被切成 **2 块**
  writeWav(wav, [{ startSec: 1, endSec: 3, freq: 440 }, { startSec: 5, endSec: 7, freq: 660 }], 8);

  // ---- 先验：静音检测给出的语音区间是否就是这两段 ----
  const det = await detectSpeechIntervals(wav, {});
  ok("静音检测找到 2 处语音", det.intervals.length === 2,
    JSON.stringify(det.intervals.map((i) => [i.startMs, i.endMs])));

  if (det.intervals.length === 2) {
    near("第 1 处语音起点 ≈1000ms", det.intervals[0].startMs, 1000, 250);
    near("第 1 处语音终点 ≈3000ms", det.intervals[0].endMs, 3000, 250);
    near("第 2 处语音起点 ≈5000ms", det.intervals[1].startMs, 5000, 250);
    near("第 2 处语音终点 ≈7000ms", det.intervals[1].endMs, 7000, 250);
  }

  // ---- 端到端：模拟"只回文字、不回时间戳"的免费档 ----
  let calls = 0;
  const sliceLens = [];
  const res = await transcribeAudio(wav, {
    providerId: "openai-compat",
    profileId: "siliconflow",
    chunkMode: "auto",
    tempDir: tmp,
    transcribeOne: async ({ file }) => {
      calls++;
      sliceLens.push(fs.statSync(file).size);
      // 假识别：第 1 块回"第一句话。"，第 2 块回"第二句话。"
      return { text: calls === 1 ? "第一句话。" : "第二句话。", segments: null, raw: {} };
    },
  });

  ok("E2E 走的是切块路径", res.meta.mode === "chunk" && res.meta.timing === "reconstructed-by-chunk",
    JSON.stringify({ mode: res.meta.mode, timing: res.meta.timing }));
  ok("E2E 切成 2 块", res.meta.chunkCount === 2, String(res.meta.chunkCount));
  ok("E2E 调用了 2 次识别", calls === 2, String(calls));
  ok("E2E 切片文件都是非空 wav", sliceLens.length === 2 && sliceLens.every((n) => n > 44), JSON.stringify(sliceLens));
  ok("E2E 得到 2 段字幕", res.segments.length === 2, JSON.stringify(res.segments));

  if (res.segments.length === 2) {
    near("第 1 段起点 ≈1000ms", res.segments[0].startMs, 1000, 350);
    near("第 1 段终点 ≈3000ms", res.segments[0].endMs, 3000, 350);
    near("第 2 段起点 ≈5000ms", res.segments[1].startMs, 5000, 350);
    near("第 2 段终点 ≈7000ms", res.segments[1].endMs, 7000, 350);
    ok("两段不重叠", res.segments[0].endMs <= res.segments[1].startMs, JSON.stringify(res.segments));
    ok("文字被正确带回", res.segments[0].text.includes("第一") && res.segments[1].text.includes("第二"),
      JSON.stringify(res.segments.map((s) => s.text)));
  }

  // 切片文件应被清理干净（keepTemp 未开）
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes("__chunk"));
  ok("E2E 切块临时文件已清理", leftovers.length === 0, JSON.stringify(leftovers));

  // ---- 降级路径 1：禁切块 → 单次调用 + 语音区间近似分配 ----
  let calls2 = 0;
  const res2 = await transcribeAudio(wav, {
    providerId: "openai-compat",
    profileId: "siliconflow",
    chunkMode: "never",
    tempDir: tmp,
    transcribeOne: async () => { calls2++; return { text: "第一句话。第二句话。", segments: null, raw: {} }; },
  });
  ok("降级路径只调用 1 次", calls2 === 1, String(calls2));
  ok("降级路径标记为近似分配", res2.meta.timing === "reconstructed" || res2.meta.mode === "single-realign",
    JSON.stringify({ mode: res2.meta.mode, timing: res2.meta.timing }));
  ok("降级路径仍产出 2 段", res2.segments.length === 2, JSON.stringify(res2.segments));

  // ---- 让"块内有多句"也能验证：单块里回三句 ----
  const single = path.join(tmp, "single.wav");
  writeWav(single, [{ startSec: 0.5, endSec: 6.5, freq: 500 }], 7);
  let calls3 = 0;
  const res3 = await transcribeAudio(single, {
    providerId: "openai-compat", profileId: "siliconflow",
    chunkMode: "auto", tempDir: tmp,
    transcribeOne: async () => { calls3++; return { text: "第一句。第二句。第三句。", segments: null, raw: {} }; },
  });
  ok("连续说话只切 1 块", res3.meta.chunkCount === 1, String(res3.meta.chunkCount));
  ok("块内按字数分出 3 段", res3.segments.length === 3, JSON.stringify(res3.segments.map((s) => s.text)));
  ok("块内 3 段顺序正确",
    res3.segments.length === 3 && res3.segments[0].startMs < res3.segments[1].startMs &&
    res3.segments[1].startMs < res3.segments[2].startMs, JSON.stringify(res3.segments));

  // ---- 降级路径 2：某一块失败，要如实汇报而不是静默丢 ----
  let calls4 = 0;
  const res4 = await transcribeAudio(wav, {
    providerId: "openai-compat", profileId: "siliconflow",
    chunkMode: "auto", tempDir: tmp,
    transcribeOne: async () => {
      calls4++;
      if (calls4 === 1) throw new Error("假装这一块网络挂了");
      return { text: "第二句话。", segments: null, raw: {} };
    },
  });
  ok("单块失败被如实记录", res4.meta.failedChunks === 1, String(res4.meta.failedChunks));
  ok("单块失败不影响另一块的结果", res4.segments.length >= 1, JSON.stringify(res4.segments));

  // ---- 无时间戳 + 有时戳字段：服务商给了 segments 就直接用 ----
  const res5 = await transcribeAudio(wav, {
    providerId: "openai-compat", profileId: "siliconflow",
    chunkMode: "auto", tempDir: tmp,
    transcribeOne: async () => ({
      text: "x",
      segments: [{ text: "服务商给的句子", startMs: 100, endMs: 900 }],   // 块内相对时间
      raw: {},
    }),
  });
  ok("服务商给块内时间戳时被加上块起点",
    res5.segments.length === 2 && res5.segments[0].startMs >= 900,
    JSON.stringify(res5.segments));

  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

/* ---------------------------------------------------------------- 签名断言 */

function testSignature() {
  // ① 文档公布的常量：空串的 SHA256
  //    （TC3 签名链所有中间值都由它派生，先证明散列原语没问题）
  ok("sha256('') 等于文档常量",
    crypto.createHash("sha256").update("").digest("hex") ===
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  const payload = '{"TaskId":1}';
  const canonical = buildCanonicalRequest(payload);
  const lines = canonical.split("\n");

  // ② 规范请求串的结构：POST \n / \n (空query) \n 头 \n SignedHeaders \n 正文哈希
  ok("规范请求串第 1 行是 POST", lines[0] === "POST", lines[0]);
  ok("规范请求串第 2 行是 /", lines[1] === "/", lines[1]);
  ok("规范请求串第 3 行是空 query", lines[2] === "", JSON.stringify(lines[2]));
  ok("规范请求串含 content-type 头", canonical.includes(`content-type:${CONTENT_TYPE_VALUE}`),
    CONTENT_TYPE_VALUE);
  ok("规范请求串含 host 头", canonical.includes("host:asr.tencentcloudapi.com"));
  ok("SignedHeaders 行等于导出的常量", lines.includes(SIGNED_HEADERS), SIGNED_HEADERS);

  // ③ **最关键的一致性**：SignedHeaders 里列出的每个头，都必须真的出现在规范头里。
  //    腾讯云会用收到的头重拼一遍再比对，列了却没签、或签了却没列，都会报签名失败。
  const signedList = lines.find((l) => l === SIGNED_HEADERS).split(";");
  const headerKeys = lines.filter((l) => /^[a-z0-9-]+:/.test(l)).map((l) => l.split(":")[0]);
  ok("SignedHeaders 与规范头一一对应",
    signedList.length === headerKeys.length && signedList.every((k) => headerKeys.includes(k)),
    JSON.stringify({ signedList, headerKeys }));
  ok("规范头按 ASCII 升序（content-type 在 host 之前）",
    headerKeys.join(",") === "content-type,host", headerKeys.join(","));
  ok("规范头全部小写（腾讯云要求小写化）",
    headerKeys.every((k) => k === k.toLowerCase()), headerKeys.join(","));

  // ④ 最后一行是正文哈希
  ok("规范请求串末行是正文的 sha256",
    lines[lines.length - 1] === crypto.createHash("sha256").update(payload).digest("hex"));

  // ⑤ Authorization 头形状 + 凭证范围（UTC 日期/服务/tc3_request）
  const auth = buildAuthorization({
    secretId: "AKIDTEST", secretKey: "SKTEST", action: "CreateRecTask",
    timestamp: 1551113065, payload,
  });
  ok("凭证范围是 <UTC日期>/asr/tc3_request",
    auth.credentialScope === "2019-02-25/asr/tc3_request", auth.credentialScope);
  ok("Authorization 头格式正确",
    /^TC3-HMAC-SHA256 Credential=AKIDTEST\/2019-02-25\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/
      .test(auth.authorization), auth.authorization);
  ok("签名字段是 64 位十六进制", /^[0-9a-f]{64}$/.test(auth.signature), auth.signature);

  // ⑥ 确定性 + 敏感性：同输入同签名；改一个字节就变
  const auth2 = buildAuthorization({
    secretId: "AKIDTEST", secretKey: "SKTEST", action: "CreateRecTask",
    timestamp: 1551113065, payload,
  });
  ok("相同输入签名可复现", auth2.signature === auth.signature);
  const auth3 = buildAuthorization({
    secretId: "AKIDTEST", secretKey: "SKTEST", action: "CreateRecTask",
    timestamp: 1551113065, payload: payload + " ",
  });
  ok("正文变一个字节签名就变", auth3.signature !== auth.signature);

  // ⑦ 实际发送的头必须与签名一致（这条能抓住"发的头和签的头不一致"这类难查的失败）
  const h = buildHeaders({
    secretId: "AKIDTEST", secretKey: "SKTEST", action: "CreateRecTask", payload,
  });
  ok("发送的 Content-Type 与签名用的完全一致", h["Content-Type"] === CONTENT_TYPE_VALUE, h["Content-Type"]);
  ok("发送的 Host 与签名用的完全一致", h["Host"] === "asr.tencentcloudapi.com", h["Host"]);
  ok("X-TC-Action 已带上", h["X-TC-Action"] === "CreateRecTask");
  ok("X-TC-Version 已带上", h["X-TC-Version"] === "2019-06-14");
  ok("未配 region 时不带 X-TC-Region（避免带错被拒）", h["X-TC-Region"] === undefined);
  ok("传了 region 才带 X-TC-Region",
    buildHeaders({ secretId: "a", secretKey: "b", action: "X", region: "ap-guangzhou", payload })["X-TC-Region"] === "ap-guangzhou");

  // ⑧ 腾讯云结果解析：把 ResultDetail 正确转成统一格式（含词级时间戳）
  const parsed = parseResultDetail([{
    FinalSentence: "你好世界。", StartMs: 20, EndMs: 2380,
    Words: [
      { Word: "你好", OffsetStartMs: 120, OffsetEndMs: 780 },
      { Word: "世界", OffsetStartMs: 780, OffsetEndMs: 1530 },
    ],
  }]);
  ok("ResultDetail 解析出 1 句", parsed && parsed.length === 1, JSON.stringify(parsed));
  ok("句级时间被正确换算", parsed && parsed[0].startMs === 20 && parsed[0].endMs === 2380, JSON.stringify(parsed));
  ok("词级时间戳被保留", parsed && parsed[0].words && parsed[0].words.length === 2, JSON.stringify(parsed && parsed[0].words));
  ok("空的 ResultDetail 返回 null（交给上层重构时间轴）", parseResultDetail([], "x") === null);
}

/* ---------------------------------------------------------------- 模型清单筛选 */

function testModelFilter() {
  // 模拟硅基流动 /v1/models 的真实返回：绝大多数是语言模型，语音相关的只占几个
  const all = [
    "deepseek-ai/DeepSeek-V3",
    "Qwen/Qwen3-8B",
    "THUDM/GLM-4-9B-0414",
    "FunAudioLLM/SenseVoiceSmall",     // ← 要
    "Qwen/Qwen3-ASR-1.7B",             // ← 要
    "TeleAI/TeleSpeechASR",            // ← 要
    "XingChenAGI/XingChenASR-V3.2-Ultra", // ← 要
    "FunAudioLLM/CosyVoice2-0.5B",     // ← 不要：这是**语音合成**，方向反了
    "some-org/voice-clone-v2",         // ← 不要：声音克隆
    "openai/whisper-large-v3",         // ← 要
    "bge-m3",
  ];
  const kept = filterAsrModels(all);
  ok("筛选后应保留 5 个语音识别模型", kept.length === 5, JSON.stringify(kept));
  ok("保留 SenseVoiceSmall", kept.includes("FunAudioLLM/SenseVoiceSmall"), JSON.stringify(kept));
  ok("保留 Qwen3-ASR", kept.includes("Qwen/Qwen3-ASR-1.7B"), JSON.stringify(kept));
  ok("保留 TeleSpeechASR", kept.includes("TeleAI/TeleSpeechASR"), JSON.stringify(kept));
  ok("保留 whisper", kept.includes("openai/whisper-large-v3"), JSON.stringify(kept));
  ok("**排除语音合成 CosyVoice**（选了它会报错且看不出原因）",
    !kept.includes("FunAudioLLM/CosyVoice2-0.5B"), JSON.stringify(kept));
  ok("排除声音克隆", !kept.some((x) => /clone/i.test(x)), JSON.stringify(kept));
  ok("排除语言模型 DeepSeek/Qwen3-8B/GLM", !kept.some((x) => /deepseek|Qwen3-8B|GLM-4-9B/i.test(x)), JSON.stringify(kept));
  ok("结果按字母序稳定排序", JSON.stringify(kept) === JSON.stringify([...kept].sort()), JSON.stringify(kept));

  // 边界：空清单 / 全是语言模型 —— 不能抛错，要返回空数组
  ok("空清单返回空数组", filterAsrModels([]).length === 0);
  ok("全语言模型时返回空数组", filterAsrModels(["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-8B"]).length === 0);
  ok("undefined 输入不抛错", filterAsrModels(undefined).length === 0);
}

/* ------------------------------------------------- 去标点（字幕文字处理）*/

function testPunctuation() {
  ok("removePunctuation：中文标点全删", removePunctuation("你好，世界！") === "你好世界");
  ok("removePunctuation：英文逗号句号删掉、但保留词间空格",
    removePunctuation("Hello, world.") === "Hello world",
    removePunctuation("Hello, world."));
  ok("removePunctuation：小数点不能删",
    removePunctuation("圆周率是 3.14。") === "圆周率是 3.14",
    removePunctuation("圆周率是 3.14。"));
  ok("removePunctuation：千分位的逗号不能删",
    removePunctuation("约 1,000 元。") === "约 1,000 元",
    removePunctuation("约 1,000 元。"));
  ok("removePunctuation：书名号/引号/破折号一并删除",
    removePunctuation("《流浪地球》——“好看”") === "流浪地球好看",
    removePunctuation("《流浪地球》——“好看”"));
  ok("removePunctuation：全是标点 → 空串（调用方据此丢弃该段）",
    removePunctuation("。。。！？") === "");
  ok("removePunctuation：没有标点时原样返回",
    removePunctuation("今天天气不错") === "今天天气不错");
  ok("removePunctuation：删完不留下连续空格",
    removePunctuation("你好 ， 世界") === "你好 世界",
    removePunctuation("你好 ， 世界"));

  // 这两个函数的职责必须泾渭分明，混用就会出英文粘连的 bug
  ok("stripPunct 与 removePunctuation 职责不同（前者连空格一起删）",
    stripPunct("Hello world") === "Helloworld" &&
    removePunctuation("Hello world") === "Hello world");

  // 链式：照搬 cli.js 里那段真实顺序（规整 → 标记 → 去标点并丢空段）
  // 目的是证明"带标点的识别结果"走完全链后，产物里确实没有标点。
  const raw = [
    { text: "你好，世界！", startMs: 0, endMs: 1000 },
    { text: "圆周率是 3.14，请记住。", startMs: 1000, endMs: 2500 },
    { text: "。。。", startMs: 2500, endMs: 2600 },
  ];
  let seg = markSuspectSegments(normalizeSegments(raw));
  seg = seg.map((s) => ({ ...s, text: removePunctuation(s.text) })).filter((s) => s.text !== "");
  ok("链式：去标点后文本正确", seg.map((s) => s.text).join("|") === "你好世界|圆周率是 3.14请记住",
    seg.map((s) => s.text).join("|"));
  ok("链式：只剩标点的那段被丢弃（不会建出空图层）", seg.length === 2, String(seg.length));
  ok("链式：时间戳一个没动", seg[0].startMs === 0 && seg[1].endMs === 2500);
  // ⚠ 只检查 SRT 的**正文行**：时间戳行天然含 ":" 和 ","（00:00:01,000 --> ），
  //   连它一起匹配会误报成"还有标点"。
  // ⚠ 还要先抹掉"数字里的小数点/千分位"——那是**有意保留**的，不属于该删的标点。
  const srtBody = toSrt(seg, { maxChars: 16 })
    .split("\n")
    .filter((l) => l && !/^\d+$/.test(l) && l.indexOf("-->") < 0);
  const dropNumericPunct = (l) => l.replace(/(\d)[.,](?=\d)/g, "$1");
  ok("链式：SRT 正文里不含标点（数字里的小数点/千分位除外）",
    srtBody.length > 0 && srtBody.every((l) => !/[，。！？；：、,.!?]/.test(dropNumericPunct(l))),
    srtBody.join(" | "));
}

/* ---------------------------------------------------------------- 主流程 */

(async () => {
  const ff = getFfmpegPath();
  console.log("ffmpeg:", ff || "(未找到)");
  if (!ff) {
    console.error("× 找不到 ffmpeg，无法做端到端自测。请先准备 ffmpeg（见 pipeline/lib/paths.js）。");
    process.exit(1);
  }

  console.log("\n== ① align.js 纯函数 ==");
  testPure();

  console.log("== ② 腾讯云签名与结果解析（结构与常量级校验）==");
  testSignature();

  console.log("== ③ 服务商模型清单的筛选 ==");
  testModelFilter();

  console.log("== ④ 去标点（字幕文字处理）==");
  testPunctuation();

  console.log("== ⑤ 端到端（合成音频 + 真实静音检测 + 假识别）==");
  await testChunked();

  console.log(`\n断言通过 ${pass} 条，失败 ${fails.length} 条`);
  if (fails.length) {
    console.log("\n失败明细：");
    for (const f of fails) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("✓ 全部通过");
})().catch((e) => {
  console.error("\n× 自测异常终止：", e);
  process.exit(1);
});
