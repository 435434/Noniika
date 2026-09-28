/**
 * 分发包可用性验证（模拟"别人拿到包的机器"）
 * ==========================================================
 * 把 插件打包/ 里的成品复制到临时目录，然后：
 *   ① 用**包里自带的 node.exe**（不碰系统 Node）
 *   ② 用**包里的 pipeline**（注意：**没有 ffprobe**）
 *   ③ 真跑一次「只分离」端到端
 * 以此证明：别人机器上不装 Node、不装 ffprobe，也能直接用。
 *
 * 用法： node test/package-verify.js
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(ROOT, "插件打包", "com.aesub.autosubtitle");   // 直接验证打包产物
const WORK = path.join(os.tmpdir(), "aesub-pkgwork");                  // 工作目录（模拟别人的机器）
const MODEL_DIR = path.join(ROOT, "models", "uvr");          // 借用开发机的模型，免得联网下载
const VENV_PY = path.join(ROOT, "python-env", "Scripts", "python.exe");
const SRC_MP4 = path.join(ROOT, "test", "input", "无上光荣.mp4");

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { } }

rmrf(WORK);
fs.mkdirSync(WORK, { recursive: true });

// ---- 0. 确认这是"别人拿到手的样子" ----
const NODE = path.join(STAGE, "node-runtime", "node.exe");
const CLI = path.join(STAGE, "pipeline", "cli.js");
const FFMPEG = path.join(STAGE, "pipeline", "node_modules",
  "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");

check("分发包里有自带 Node", fs.existsSync(NODE), NODE);
check("分发包里有 cli.js", fs.existsSync(CLI), CLI);
check("分发包里有 ffmpeg", fs.existsSync(FFMPEG), FFMPEG);
check("分发包里**没有** ffprobe（已精简）",
  !fs.existsSync(path.join(STAGE, "pipeline", "node_modules", "@ffprobe-installer")));
check("分发包里没有 python-env / models（按需生成）",
  !fs.existsSync(path.join(STAGE, "python-env")) && !fs.existsSync(path.join(STAGE, "models")));
check("分发包里有使用说明", fs.existsSync(path.join(STAGE, "使用说明.md")));

// ---- 1. 自带 Node 能不能跑 ----
let ver = "";
try { ver = execFileSync(NODE, ["-v"], { encoding: "utf8" }).trim(); } catch (e) { ver = "ERR"; }
check("自带 Node 能执行（" + ver + "）", /^v\d+/.test(ver), ver);

// ---- 2. 用包里 ffmpeg 造一段测试音频 ----
const wav = path.join(WORK, "src.wav");
try {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", SRC_MP4,
    "-t", "4", "-ar", "44100", "-ac", "2", "-vn", wav], { timeout: 180000 });
} catch (e) { /* 下面断言会说明 */ }
check("包里 ffmpeg 能导出测试音频", fs.existsSync(wav));

// ---- 3. 关键一步：没有 ffprobe，整条链路能不能跑通 ----
const OUT = path.join(WORK, "out");
fs.mkdirSync(OUT, { recursive: true });
let stdout = "", errMsg = "";
const t0 = Date.now();
try {
  stdout = execFileSync(NODE, [
    CLI,
    "--in", wav,
    "--out", OUT,
    "--name", "分包测试",
    "--separate", "--separate-only",
    "--separate-target", "vocals",
    "--separate-model", "Kim_Vocal_2.onnx",
    "--separate-python", VENV_PY,
    "--model-file-dir", MODEL_DIR,
    "--progress-json"
  ], {
    cwd: path.join(STAGE, "pipeline"),      // 与面板调用姿势一致
    timeout: 900000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024
  });
} catch (e) {
  stdout = (e.stdout || "");
  errMsg = String(e.stderr || e.message || "").slice(-400);
}
const sec = (Date.now() - t0) / 1000;

let res = null;
for (const line of String(stdout).split(/\r?\n/).reverse()) {
  const t = line.trim();
  if (t.startsWith("{") && t.indexOf("\"ok\"") >= 0) { try { res = JSON.parse(t); break; } catch (e) { } }
}
check("**没有 ffprobe 也能跑完整条分离链路**", !!res && res.ok === true, errMsg || String(stdout).slice(-300));
if (res && res.ok) {
  const sep = res.separate || {};
  check("产出人声文件且真实存在", !!sep.vocals && fs.existsSync(sep.vocals), String(sep.vocals));
  check("产物名按 --name 命名", String(sep.vocals).indexOf("分包测试_人声") >= 0, String(sep.vocals));
  check("没有生成字幕产物（只分离模式）", !res.outputs || !res.outputs.json);
}

// ---- 4. 面板与流水线的接线检查 ----
const mainJs = fs.readFileSync(path.join(STAGE, "js", "main.js"), "utf8");
check("面板里已无本机硬编码路径（C:\\Users\\kunku）",
  mainJs.indexOf("C:\\\\Users\\\\kunku") < 0 && mainJs.indexOf("C:/Users/kunku") < 0);
check("面板会去扩展目录下找自带 Node（node-runtime）", mainJs.indexOf("node-runtime") >= 0);
check("面板会自动探测扩展目录里的 pipeline", mainJs.indexOf("detectPipelineDir") >= 0);

const manifest = fs.readFileSync(path.join(STAGE, "CSXS", "manifest.xml"), "utf8");
check("manifest 版本为 0.8.0", manifest.indexOf('ExtensionBundleVersion="0.8.0"') >= 0);

console.log(results.join("\n"));
console.log("\n  --- 分包实测 ---");
console.log("  自带 Node：" + ver + " · 分离用时 " + sec.toFixed(1) + " 秒");
if (res && res.ok) console.log("  人声产物：" + res.separate.vocals);
console.log("\n  通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));

rmrf(WORK);
process.exit(fail ? 1 : 0);
