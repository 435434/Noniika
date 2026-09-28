/**
 * 拼音搜索的纯逻辑测试（不碰 DOM、不需要 AE）
 * ==========================================================
 * 被测对象：
 *   cep/js/pinyin-table.js   汉字 → 拼音数据表
 *   cep/js/pinyin-search.js  AesubPy：判断/索引/打分
 *
 * 存在意义：CEP 12 面板里中文输入法有已知缺陷（候选浮窗卡屏幕左上角，
 * Adobe 记 CEP-3029），所以「打拼音搜中文字体/预设」是主要用法，
 * 这条匹配规则必须钉死 —— 它错了用户会以为"字体没装"。
 *
 * 用法： node test/pinyin-search-test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = ["cep/js/pinyin-table.js", "cep/js/pinyin-search.js"]
  .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);
const PY = sandbox.AesubPy;

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}

/* ================================================= ① 数据表本身 */
check("① pinyin-search.js 已定义 AesubPy", !!PY && typeof PY.score === "function");
check("① 数据表可用（usable）", PY.usable() === true, "size=" + (PY ? PY.size() : "?"));
check("① 收字量 ≥ 20000", PY.size() >= 20000, String(PY.size()));
{
  const chars = sandbox.AESUB_PY_CHARS || "";
  const data = (sandbox.AESUB_PY_DATA || "").split(",");
  check("① 两个平行字符串长度一致（防生成脚本出错）", chars.length === data.length,
    chars.length + " vs " + data.length);
  check("① 常用字读音正确（一→yi 丁→ding）",
    PY.index("一").full === "yi" && PY.index("丁").full === "ding",
    PY.index("一").full + "/" + PY.index("丁").full);
  check("① 多音字取常用读音（行→xing，甲）", PY.index("行").full === "xing",
    PY.index("行").full);
}

/* ================================================= ② 怎么判断"拼音模式" */
check("② ruizi 是拼音模式", PY.isAsciiQuery("ruizi") === true);
check("② rz 是拼音模式", PY.isAsciiQuery("rz") === true);
check("② SIMHEI 是拼音模式（大小写不敏感）", PY.isAsciiQuery("SIMHEI") === true);
check("② 华文 不是拼音模式（走原来的搜索路径）", PY.isAsciiQuery("华文") === false);
check("② 空串不是拼音模式", PY.isAsciiQuery("") === false && PY.isAsciiQuery(null) === false);
check("② 中文夹字母不是拼音模式", PY.isAsciiQuery("华文hw") === false);
check("② 超长串不当拼音（防止误判）", PY.isAsciiQuery("a".repeat(30)) === false);

/* ================================================= ③ 索引：全拼与首字母 */
{
  const ix = PY.index("锐字奥运精神拼搏简");
  check("③ 全拼正确", ix.full === "ruiziaoyunjingshenpinbojian", ix.full);
  check("③ 首字母正确（锐r字z奥a运y精j神s拼p搏b简j）", ix.init === "rzayjspbj", ix.init);
  const ix2 = PY.index("SimHei · Regular");
  check("③ 英文名保留原样（空格与标点丢掉，便于连续输入）",
    ix2.full === "simheiregular" && ix2.init === "simheiregular",
    ix2.full + " / " + ix2.init);
  const ix3 = PY.index("Animate In / 飞入");
  check("③ 中英混合：ASCII 照留、汉字转拼音",
    // 分隔符（/ 空格）只留在 raw 里，full / init 里丢掉 —— 用户不会打分隔符
    ix3.full === "animateinfeiru" && ix3.init === "animateinfr",
    ix3.full + " / " + ix3.init);
  const ix4 = PY.index("ㅁㅁ！！");
  check("③ 表里没有的字符不崩、也不误转", ix4.full === "" && ix4.raw === "ㅁㅁ！！",
    JSON.stringify(ix4));
}

/* ================================================= ④ 打分规则与优先级 */
check("④ 字面前缀最高分（simhei → SimHei · Regular）",
  PY.score("SimHei · Regular", "simhei") === 100, String(PY.score("SimHei · Regular", "simhei")));
check("④ 大小写不敏感", PY.score("SimHei", "SIMHEI") === 100);
check("④ 首字母前缀（rz → 锐字…）",
  PY.score("锐字奥运精神拼搏简", "rz") === 85, String(PY.score("锐字奥运精神拼搏简", "rz")));
check("④ 全拼前缀（ruizi → 锐字…）",
  PY.score("锐字奥运精神拼搏简", "ruizi") === 75);
check("④ 字面包含（华文 出现在中间）",
  PY.score("Adobe 华文行楷", "华文") === 65, String(PY.score("Adobe 华文行楷", "华文")));
check("④ 全拼包含（aoyun → 锐字奥运…）",
  PY.score("锐字奥运精神拼搏简", "aoyun") === 45);
check("④ 首字母包含（zayj → 锐字奥运…）",
  PY.score("锐字奥运精神拼搏简", "zayj") === 35);
check("④ 排序关系正确：首字母前缀 > 全拼前缀 > 全拼包含",
  PY.score("锐字简", "rz") > PY.score("锐字简", "ruizi") &&
  PY.score("锐字简", "ruizi") > PY.score("锐字简", "jian"),
  [PY.score("锐字简", "rz"), PY.score("锐字简", "ruizi"), PY.score("锐字简", "jian")].join(" / "));
check("④ 不命中返回 -1",
  PY.score("飞入", "xyz") === -1 && PY.score("飞入", "") === -1 &&
  PY.score("飞入", null) === -1);
check("④ hit() 与 score() 一致",
  PY.hit("打字机", "dzj") === true && PY.hit("打字机", "zzz") === false);

/* ================================================= ⑤ 真实场景：按拼音在一堆字体里挑 */
{
  const fonts = [
    "锐字奥运精神拼搏简",
    "思源黑体",
    "华文行楷",
    "SimHei",
    "Source Han Sans SC",
    "方正兰亭黑"
  ];
  function pick(q) {
    return fonts.filter((f) => PY.hit(f, q));
  }
  check("⑤ rz → 锐字…", JSON.stringify(pick("rz")) === JSON.stringify(["锐字奥运精神拼搏简"]),
    JSON.stringify(pick("rz")));
  check("⑤ ruizi → 锐字…", pick("ruizi").length === 1 && pick("ruizi")[0] === "锐字奥运精神拼搏简");
  check("⑤ siyuan → 思源黑体", JSON.stringify(pick("siyuan")) === JSON.stringify(["思源黑体"]),
    JSON.stringify(pick("siyuan")));
  check("⑤ hei → 思源黑体 / SimHei（字面包含）/ 方正兰亭黑",
    pick("hei").length === 3, JSON.stringify(pick("hei")));
  check("⑤ hw → 华文行楷", JSON.stringify(pick("hw")) === JSON.stringify(["华文行楷"]),
    JSON.stringify(pick("hw")));
  check("⑤ xingkai → 华文行楷", JSON.stringify(pick("xingkai")) === JSON.stringify(["华文行楷"]),
    JSON.stringify(pick("xingkai")));
  check("⑤ simhei → SimHei", JSON.stringify(pick("simhei")) === JSON.stringify(["SimHei"]),
    JSON.stringify(pick("simhei")));
  check("⑤ 纯英文名照旧可搜（sourcehan）", pick("sourcehan").length === 1);
  check("⑤ 打错不命中（不会乱给结果）", pick("qqqq").length === 0);
}

/* ================================================= ⑥ 缓存一致性 */
{
  const a = PY.index("思源黑体");
  const b = PY.index("思源黑体");
  check("⑥ 同一显示名两次索引结果一致（缓存没串味）", a.full === b.full && a.init === b.init);
  check("⑥ 缓存不影响不同名字", PY.index("思源宋体").full === "siyuansongti",
    PY.index("思源宋体").full);
}

/* ------------------------------------------------------------ 汇总 */
console.log(results.join("\n"));
console.log("\n  通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));
process.exit(fail ? 1 : 0);
