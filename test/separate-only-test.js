/**
 * 「只分离」模式（--separate-only）的端到端真跑测试
 * ==========================================================
 * 真的调一次流水线：导出测试音频 → 本地分离 → 检查产物与"没有识别"的证据。
 * 需要 python-env 已装好（GPU 或 CPU 都行）。
 *
 * 用法： node test/separate-only-test.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
const FFMPEG = path.join(ROOT, "pipeline", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
const VENV_PY = path.join(ROOT, "python-env", "Scripts", "python.exe");
const OUT = path.join(ROOT, "test", "output", "_septest");
const SRC_MP4 = path.join(ROOT, "test", "input", "无上光荣.mp4");

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { } }

function main() {
  check("测试素材存在", fs.existsSync(SRC_MP4), SRC_MP4);
  check("分离环境存在（python-env）", fs.existsSync(VENV_PY), VENV_PY);
  check("ffmpeg 存在", fs.existsSync(FFMPEG), FFMPEG);
  if (fail) { report(); return; }

  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 造一段 4 秒测试音频（真实素材，不是合成音）
  const wav = path.join(OUT, "src.wav");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", SRC_MP4,
    "-t", "4", "-ar", "44100", "-ac", "2", "-vn", wav], { timeout: 120000 });
  check("测试音频已生成", fs.existsSync(wav), wav);

  // 2) 跑「只分离」——注意**不给**任何识别相关参数，且要求不上传
  // ⚠ 工作目录必须是 pipeline/：cli.js 默认按「启动目录的上一级」找 models/uvr，
  //    面板调用时 cwd 就是 pipeline 目录（这里刻意与面板保持一致）。
  const t0 = Date.now();
  let stdout = "";
  try {
    stdout = execFileSync(NODE, [
      path.join(ROOT, "pipeline", "cli.js"),
      "--in", wav,
      "--out", OUT,
      "--name", "分离测试",
      "--separate",
      "--separate-only",
      "--separate-target", "vocals",
      "--separate-model", "Kim_Vocal_2.onnx",
      "--separate-python", VENV_PY,
      "--progress-json"
    ], {
      cwd: path.join(ROOT, "pipeline"),
      timeout: 900000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (e) {
    stdout = (e.stdout || "") + "\n" + (e.stderr || "");
    check("流水线正常退出", false, String(e.message).slice(0, 160));
  }
  const sec = (Date.now() - t0) / 1000;

  // 3) 解析结果（progress-json 模式下结果在 stdout 的最后一行）
  let res = null;
  for (const line of String(stdout).split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (t.startsWith("{") && t.indexOf("\"ok\"") >= 0) {
      try { res = JSON.parse(t); break; } catch (e) { /* 继续找 */ }
    }
  }

  check("拿到结果 JSON", !!res, String(stdout).slice(-300));
  if (!res) { report(); return; }

  check("结果 ok=true", res.ok === true, JSON.stringify(res).slice(0, 200));
  check("模式标记为 separate-only", res.mode === "separate-only", String(res.mode));

  const sep = res.separate || {};
  check("返回了人声路径", !!sep.vocals && fs.existsSync(sep.vocals), String(sep.vocals));
  check("返回了 chosen（面板落轨用它）", !!sep.chosen && fs.existsSync(sep.chosen), String(sep.chosen));
  check("报告了分离耗时", typeof sep.elapsedSec === "number" && sep.elapsedSec > 0, String(sep.elapsedSec));
  check("产物落在 <输出目录>/_人声分离/ 下",
    String(sep.vocals || "").indexOf("_人声分离") >= 0, String(sep.vocals));

  // 4) 关键证据：**没有识别相关的产物**
  check("outputs 里没有 json/srt/txt",
    !res.outputs || (!res.outputs.json && !res.outputs.srt && !res.outputs.txt),
    JSON.stringify(res.outputs));
  const rootFiles = fs.readdirSync(OUT);
  check("输出目录里没有 .srt", !rootFiles.some((f) => /\.srt$/i.test(f)), rootFiles.join(","));
  check("输出目录里没有字幕 .json", !rootFiles.some((f) => /\.json$/i.test(f) && /分离测试/.test(f)),
    rootFiles.join(","));
  check("outputs.json 不是「写了个空文件」（路径为 null）",
    !res.outputs || res.outputs.json === null || res.outputs.json === undefined,
    JSON.stringify(res.outputs));

  console.log(results.join("\n"));
  console.log("\n  --- 实测 ---");
  console.log("  分离用时 " + sec.toFixed(1) + " 秒（含模型加载）");
  console.log("  人声产物：" + sep.vocals);
  console.log("  输出目录内容：" + rootFiles.join(" · "));
  console.log("\n  通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));

  rmrf(OUT);
  process.exit(fail ? 1 : 0);
}

function report() {
  console.log(results.join("\n"));
  console.log("\n  通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));
  rmrf(OUT);
  process.exit(fail ? 1 : 0);
}

main();
