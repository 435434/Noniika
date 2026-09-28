/**
 * 媒体探测的两条路一致性测试
 * ==========================================================
 * 分发包刻意不带 ffprobe（省 77MB），改由 ffmpeg 自己解析媒体信息。
 * 这里把两条路都跑一遍、逐字段比对，确保「没有 ffprobe」时结果不变：
 *
 *   ① 有 ffprobe（开发机常态）→ 记下各素材的探测结果
 *   ② 临时把 ffprobe.exe 改名（模拟分发包）→ 再探测一次
 *   ③ 两批结果逐字段比对；最后**务必把文件名改回来**
 *
 * 用法： node test/probe-both-ways.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FFMPEG = path.join(ROOT, "pipeline", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const FFPROBE_EXE = path.join(ROOT, "pipeline", "node_modules", "@ffprobe-installer", "win32-x64", "ffprobe.exe");
const TMP = path.join(ROOT, "test", "output", "_probe");
const PROBE_SCRIPT = path.join(__dirname, "probe-both-ways.mjs");   // 子进程模式就是本文件

/* ---------- 子进程模式：只探测并打印 JSON ---------- */
if (process.argv[2] === "--probe-many") {
  const { probeMedia } = await import(
    "file://" + path.join(ROOT, "pipeline", "lib", "ffmpeg.js").replace(/\\/g, "/")
  );
  const files = JSON.parse(process.argv[3]);
  const out = [];
  for (const f of files) {
    try {
      const r = await probeMedia(f.file);
      out.push({
        name: f.name, ok: true,
        duration: Math.round(r.duration * 100) / 100,
        hasAudio: r.hasAudio, hasVideo: r.hasVideo,
        audioCodec: r.audioCodec, sampleRate: r.sampleRate, channels: r.channels,
        audioChannelsCount: r.audioChannelsCount
      });
    } catch (e) {
      out.push({ name: f.name, ok: false, error: String(e.message).slice(0, 120) });
    }
  }
  process.stdout.write("RESULT|" + JSON.stringify(out));
  process.exit(0);
}

/* ---------- 主流程 ---------- */
let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}

function runProbe(files) {
  const raw = execFileSync(process.execPath, [PROBE_SCRIPT, "--probe-many", JSON.stringify(files)],
    { encoding: "utf8", timeout: 300000 });
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("RESULT|"));
  if (!line) throw new Error("子进程没有输出结果：" + raw.slice(-300));
  return JSON.parse(line.slice("RESULT|".length));
}

fs.mkdirSync(TMP, { recursive: true });

// 造四种典型素材
const src = path.join(ROOT, "test", "input", "无上光荣.mp4");
const files = [
  { name: "视频+音频 mp4", file: src },
  { name: "纯音频 wav", file: path.join(TMP, "a.wav") },
  { name: "纯音频 mp3", file: path.join(TMP, "a.mp3") },
  { name: "无音轨视频 mp4", file: path.join(TMP, "novideo.mp4") }
];

const ff = (args) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { timeout: 300000 });
if (fs.existsSync(src)) {
  ff(["-i", src, "-t", "3", "-vn", "-ar", "44100", "-ac", "2", path.join(TMP, "a.wav")]);
  ff(["-i", src, "-t", "3", "-vn", "-b:a", "128k", path.join(TMP, "a.mp3")]);
  ff(["-i", src, "-t", "2", "-an", "-c:v", "copy", path.join(TMP, "novideo.mp4")]);
}
check("素材齐备（4 种）", files.every((f) => fs.existsSync(f.file)),
  files.filter((f) => !fs.existsSync(f.file)).map((f) => f.name).join(","));

// ① 有 ffprobe
const hasProbe = fs.existsSync(FFPROBE_EXE);
check("初始状态：ffprobe 存在（开发机常态）", hasProbe, FFPROBE_EXE);
const withProbe = runProbe(files);

// ② 模拟分发包：改名
let renamed = null;
let withoutProbe = null;
if (hasProbe) {
  renamed = FFPROBE_EXE + ".bak";
  fs.renameSync(FFPROBE_EXE, renamed);
}
try {
  withoutProbe = runProbe(files);
} finally {
  if (renamed && fs.existsSync(renamed)) fs.renameSync(renamed, FFPROBE_EXE);
  check("测试后 ffprobe 已还原", fs.existsSync(FFPROBE_EXE) || !hasProbe,
    "还原失败！请手动把 ffprobe.exe.bak 改回 ffprobe.exe");
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ③ 逐字段比对
check("两种方式条数一致", withProbe.length === withoutProbe.length,
  withProbe.length + " vs " + withoutProbe.length);

const fields = ["ok", "duration", "hasAudio", "hasVideo", "audioCodec", "sampleRate", "channels", "audioChannelsCount"];
const diffs = [];
for (let i = 0; i < withProbe.length; i++) {
  const a = withProbe[i], b = withoutProbe[i];
  for (const k of fields) {
    const va = a[k], vb = b[k];
    if (k === "duration") {
      if (Math.abs((va || 0) - (vb || 0)) > 0.05) diffs.push(a.name + "." + k + ": " + va + " vs " + vb);
    } else if (va !== vb) {
      diffs.push(a.name + "." + k + ": " + JSON.stringify(va) + " vs " + JSON.stringify(vb));
    }
  }
}
check("**没有 ffprobe 时，探测结果逐字段一致**", diffs.length === 0, diffs.join(" ; "));

// 关键字段单独确认（避免"两边都错"）
const byName = {};
withoutProbe.forEach((r) => { byName[r.name] = r; });
const vid = byName["视频+音频 mp4"];
check("（无 ffprobe）视频素材：有音频、时长对", !!vid && vid.ok && vid.hasAudio && vid.duration > 5,
  JSON.stringify(vid));
check("（无 ffprobe）视频素材：识别出 44100Hz 立体声",
  !!vid && vid.sampleRate === 44100 && vid.channels === 2, JSON.stringify(vid));
const nov = byName["无音轨视频 mp4"];
check("（无 ffprobe）无音轨视频：hasAudio=false", !!nov && nov.ok && nov.hasAudio === false,
  JSON.stringify(nov));
const wav = byName["纯音频 wav"];
check("（无 ffprobe）纯音频 wav：无视频、有音频",
  !!wav && wav.ok && wav.hasVideo === false && wav.hasAudio, JSON.stringify(wav));
const mp3 = byName["纯音频 mp3"];
check("（无 ffprobe）纯音频 mp3：识别出 mp3 编码", !!mp3 && mp3.ok && mp3.audioCodec === "mp3",
  JSON.stringify(mp3));

console.log(results.join("\n"));
console.log("\n  --- 探测结果（无 ffprobe 那条路）---");
withoutProbe.forEach((r) => {
  console.log("  " + String(r.name).padEnd(16) + " 时长 " + r.duration + "s · 音频 " + r.hasAudio +
    " · 视频 " + r.hasVideo + " · " + r.audioCodec + " " + r.sampleRate + "Hz " + r.channels + "ch" +
    (r.ok ? "" : "  ⚠ " + r.error));
});

console.log("\n  通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));
process.exit(fail ? 1 : 0);
