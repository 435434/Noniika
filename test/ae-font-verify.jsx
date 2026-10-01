/* ============================================================
 * 字体搜索回归验证
 *
 * 要证的三件事：
 *   ① 中文家族名能正确回到面板（旧 bug：返回时读 r.native，永远是 null）
 *   ② 缓存被"固化"成空/残缺后，下一次搜索能自愈重建（用户报的"搜不到装着的中文字体"）
 *   ③ 三层自愈的每一层真的会触发（空缓存 / 家族数过少 / 命中0且缓存旧）
 *
 * ExtendScript 无 JSON —— 手工拼参；每个用例都记录实测值便于对照
 * ============================================================ */

var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var OUT = "E:/项目文件/agent/ae字幕插件/test/output/ae-font-verify-result.json";
var PROG = "E:/项目文件/agent/ae字幕插件/test/output/ae-font-verify-progress.txt";

function log(s) {
  var f = new File(PROG); f.encoding = "UTF-8";
  if (f.open("a")) { f.write(s + "\n"); f.close(); }
}
function q(s) {
  if (s === null || s === undefined) return '""';
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ") + '"';
}
function jarr(a) {
  var o = [], i;
  for (i = 0; i < a.length; i++) o.push(a[i]);
  return "[" + o.join(",") + "]";
}
function jstrarr(a) {
  var o = [], i;
  for (i = 0; i < a.length; i++) o.push(q(a[i]));
  return "[" + o.join(",") + "]";
}
function obj(kv) {
  var o = [], k;
  for (k in kv) o.push(q(k) + ":" + kv[k]);
  return "{" + o.join(",") + "}";
}

try { $.evalFile(new File(BRIDGE)); log("bridge loaded"); }
catch (e) { log("bridge FAIL: " + (e.message || e)); }

var cases = [];
var errs = [];

/** 调一次搜索，返回解析后的对象 */
function search(kw, lim, refresh) {
  var src = "AESub_searchFonts(" + q(kw) + "," + lim + "," + (refresh ? "true" : "false") + ")";
  return eval("(" + String(eval(src)) + ")");
}

function names(fams) {
  var out = [], i;
  for (i = 0; i < fams.length; i++) out.push(fams[i].nativeName + "/" + fams[i].family);
  return out;
}

/* ---------- 用例 A：正常搜索，中文名必须回得来 ---------- */
function caseNormal() {
  AESUB_FONT_CACHE = null;                 // 从零开始
  var r = search("华文", 40, true);
  var d = r.data;
  var fams = d.families;
  var nullNative = 0, i;
  for (i = 0; i < fams.length; i++) {
    if (fams[i].nativeName === null || fams[i].nativeName === undefined ||
        fams[i].nativeName === "") nullNative++;
  }
  var chk = {};
  chk.ok = r.ok === true;
  chk.ready = d.ready === true;
  chk.matchedGt0 = d.matched > 0;
  chk.returnedGt0 = d.returned > 0;
  chk.totalSane = d.totalFamilies >= 50;      // 真机应远多于 50 个家族
  chk.noNullNativeName = (nullNative === 0);  // ★ 旧 bug 就会挂在这里
  chk.hasChineseName = false;
  for (i = 0; i < fams.length; i++) {
    if (/[\u4e00-\u9fa5]/.test(String(fams[i].nativeName))) chk.hasChineseName = true;
  }
  cases.push(obj({ label: q("A: 搜「华文」正常返回"), chk: obj(chk),
    total: d.totalFamilies, matched: d.matched, cacheState: q(d.cacheState),
    nullNative: nullNative, names: jstrarr(names(fams).slice(0, 6)) }));
  return chk;
}

/* ---------- 用例 B：缓存被固化成空数组 → 必须自愈 ---------- */
function caseEmptyCache() {
  AESUB_FONT_CACHE = [];                   // 模拟旧版把空结果写进了缓存
  var r = search("锐字", 40, false);
  var d = r.data;
  var chk = {};
  chk.ok = r.ok === true;
  chk.matchedGt0 = d.matched > 0;          // 自愈成功才可能命中
  chk.rebuilt = (d.cacheState === "rebuilt");
  chk.totalRestored = d.totalFamilies >= 50;
  cases.push(obj({ label: q("B: 缓存=空数组（被固化的场景）→ 搜「锐字」"), chk: obj(chk),
    cacheState: q(d.cacheState), total: d.totalFamilies, matched: d.matched,
    names: jstrarr(names(d.families).slice(0, 4)) }));
  return chk;
}

/* ---------- 用例 C：缓存只剩几个家族（残缺）→ 必须自愈 ---------- */
function caseTinyCache() {
  var full = AESUB_FONT_CACHE;
  AESUB_FONT_CACHE = full.slice(0, 5);     // 模拟"字体服务早期只加载了一小部分"
  var r = search("印品", 40, false);
  var d = r.data;
  var chk = {};
  chk.ok = r.ok === true;
  chk.rebuilt = (d.cacheState === "rebuilt-small");
  chk.totalRestored = d.totalFamilies >= 50;
  chk.matchedGt0 = d.matched > 0;
  cases.push(obj({ label: q("C: 缓存只剩 5 个家族 → 搜「印品」"), chk: obj(chk),
    cacheState: q(d.cacheState), total: d.totalFamilies, matched: d.matched,
    names: jstrarr(names(d.families).slice(0, 4)) }));
  return chk;
}

/* ---------- 用例 D：空查询要能列出大批字体（旧版只给 28 个）---------- */
function caseEmptyQuery() {
  AESUB_FONT_CACHE = null;
  var r = search("", 120, true);
  var d = r.data;
  var chk = {};
  chk.ok = r.ok === true;
  chk.returnedMany = d.returned >= 60;     // 旧实现只有 28
  chk.hasChinese = false;
  var i;
  for (i = 0; i < d.families.length; i++) {
    if (/[\u4e00-\u9fa5]/.test(String(d.families[i].nativeName))) { chk.hasChinese = true; break; }
  }
  cases.push(obj({ label: q("D: 空查询（浏览全部）"), chk: obj(chk),
    total: d.totalFamilies, returned: d.returned }));
  return chk;
}

/* ---------- 用例 E：中文名 + 英文名 + PostScript 名都能搜到 ---------- */
function caseMultiKeyword() {
  var kws = ["微软雅黑", "yahei", "microsoftyahei", "宋体", "simsun", "黑体", "华文楷体",
             "kaiti", "幼圆", "隶书", "方正", "南征北战", "奥运"];
  var lines = [], okCount = 0;
  for (var i = 0; i < kws.length; i++) {
    var r = search(kws[i], 20, false);
    var hit = r.data.matched;
    if (hit > 0) okCount++;
    lines.push(q(kws[i] + "→" + hit));
  }
  var chk = {};
  chk.allHit = (okCount === kws.length);
  chk.okCount = okCount;
  chk.total = kws.length;
  cases.push(obj({ label: q("E: 中英文关键词全部能命中"), chk: obj(chk),
    hits: jarr(lines) }));
  return chk;
}

/* ---------- 用例 F：搜不存在的词不应报错，且如实说 0 ---------- */
function caseMiss() {
  var r = search("zzz_不存在的字体_qqq", 20, false);
  var d = r.data;
  var chk = {};
  chk.ok = r.ok === true;                  // 不能变成 err
  chk.ready = d.ready === true;
  chk.zero = d.matched === 0;
  chk.returnedZero = d.returned === 0;
  cases.push(obj({ label: q("F: 搜不存在的词"), chk: obj(chk),
    cacheState: q(d.cacheState), total: d.totalFamilies }));
  return chk;
}

/* ---------- 用例 G：关键词带空格/大小写要容错 ---------- */
function caseTrimCase() {
  var r1 = search("  YaHei  ", 20, false);
  var r2 = search("yahei", 20, false);
  var chk = {};
  chk.trimWorks = r1.data.matched > 0;
  chk.caseInsensitive = (r1.data.matched === r2.data.matched);
  cases.push(obj({ label: q("G: 空格与大小写容错"), chk: obj(chk),
    trimmed: r1.data.matched, lower: r2.data.matched }));
  return chk;
}

/* ---------- 逐个跑，单点出错不拖垮全局 ---------- */
var results = {};
var FNS = [["A", caseNormal], ["B", caseEmptyCache], ["C", caseTinyCache],
           ["D", caseEmptyQuery], ["E", caseMultiKeyword], ["F", caseMiss],
           ["G", caseTrimCase]];
for (var fi = 0; fi < FNS.length; fi++) {
  (function (key, fn) {
    try {
      results[key] = fn();
      log("case " + key + " done");
    } catch (e) {
      errs.push(key + " → " + (e.message || e.toString()));
      log("case " + key + " ERROR: " + (e.message || e));
    }
  })(FNS[fi][0], FNS[fi][1]);
}

/* 收尾：把缓存恢复成正常状态，不留怪状态 */
try { AESUB_FONT_CACHE = null; AESub_searchFonts("", 1, true); } catch (e) { }

var f = new File(OUT); f.encoding = "UTF-8";
if (f.open("w")) {
  f.write(obj({
    ok: q(errs.length === 0 ? "true" : "false"),
    aeVersion: q(app.version),
    errors: jstrarr(errs),
    cases: "[" + cases.join(",") + "]"
  }));
  f.close();
}
log("done errors=" + errs.length);
