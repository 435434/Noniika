/**
 * 生成 cep/js/pinyin-table.js —— 汉字 → 拼音（无声调）数据表
 * ==================================================================
 * 为什么需要它：
 *   CEP 12 的面板里中文输入法有已知缺陷（候选浮窗卡在屏幕左上角，Adobe 记为
 *   CEP-3029）。所以面板的字体 / 预设搜索必须**能不打汉字就用**——
 *   打拼音（ruizi / rz）就能搜到中文名，这条链路靠这张表实现。
 *
 * 依赖：pinyin-pro（只在这个生成脚本里用，不进分发包）
 *   装在沙箱里的方式：
 *     npm install pinyin-pro --prefix <你的 node 工作目录>
 *
 * 用法：
 *     node tools/make-pinyin-table.js
 *   或指定模块位置：
 *     node tools/make-pinyin-table.js --mod <path-to-node_modules>
 *
 * 产出格式（两个平行字符串，比 JSON 小一半，加载时拼成 Map）：
 *     var AESUB_PY_CHARS = "一丁七…";       // 按码位升序
 *     var AESUB_PY_DATA  = "yi,ding,qi,…";  // 一一对应，逗号分隔
 *
 * 范围：CJK 基本区 U+4E00–U+9FA5（20902 字）。
 *   不含扩展 A/B 区（生僻字，字体名里几乎不会出现）。
 *   多音字只取 pinyin-pro 给出的**常用读音**（如 行→xing）——够用且省一半体积。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* ---------- 找到 pinyin-pro ---------- */
function loadPinyin() {
  const tries = [];
  tries.push(() => require("pinyin-pro"));
  const argIdx = process.argv.indexOf("--mod");
  if (argIdx > 0 && process.argv[argIdx + 1]) {
    const p = path.join(process.argv[argIdx + 1], "pinyin-pro");
    tries.push(() => require(p));
  }
  tries.push(() => require(path.join(
    "C:\\Users\\kunku\\.workbuddy\\binaries\\node\\workspace", "node_modules", "pinyin-pro")));
  for (const t of tries) {
    try { return t().pinyin; } catch (e) { /* 下一个 */ }
  }
  console.error("× 找不到 pinyin-pro。先装它，或用 --mod 指定 node_modules 路径。");
  process.exit(1);
}

const pinyin = loadPinyin();
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "cep", "js", "pinyin-table.js");

/* ---------- 逐字取音 ---------- */
const START = 0x4e00, END = 0x9fa5;
const chars = [], data = [];
let skipped = 0;

for (let cp = START; cp <= END; cp++) {
  const c = String.fromCodePoint(cp);
  let py = "";
  try {
    const r = pinyin(c, { toneType: "none", type: "array" });
    py = (r && r[0]) ? String(r[0]).toLowerCase() : "";
  } catch (e) { py = ""; }
  if (!/^[a-z]{1,7}$/.test(py)) { skipped++; continue; }   // 生僻字取不到音 → 跳过
  chars.push(c);
  data.push(py);
}

const body =
  "/* 汉字→拼音（无声调）数据表 —— 由 tools/make-pinyin-table.js 生成，请勿手改。\n" +
  "   用途：面板里用拼音搜中文字体 / 预设，避开 CEP 12 的中文输入法缺陷（CEP-3029）。\n" +
  "   覆盖 CJK 基本区 U+4E00–U+9FA5，共 " + chars.length + " 字；多音字只取常用读音。 */\n" +
  "var AESUB_PY_CHARS = " + JSON.stringify(chars.join("")) + ";\n" +
  "var AESUB_PY_DATA = " + JSON.stringify(data.join(",")) + ";\n";

fs.writeFileSync(OUT, body, "utf8");

const kb = (Buffer.byteLength(body, "utf8") / 1024).toFixed(1);
console.log("  写入 " + path.relative(ROOT, OUT));
console.log("  收字 " + chars.length + " 个（跳过取不到音的 " + skipped + " 个）");
console.log("  体积 " + kb + " KB");
