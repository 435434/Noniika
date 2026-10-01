/*
 * 定稿验证：分离人声落成时间线图层的三种模式 + 素材复用 + 错误路径。
 *
 * 两个必须遵守的约束（都踩过）：
 *   1) ExtendScript **没有 JSON** —— 参数一律手工拼，禁止 JSON.stringify
 *   2) 每个用例用**独立的源层**，避免前一个用例把源层删了导致后一个找不到
 */
var OUT = "E:/项目文件/agent/ae字幕插件/test/output/ae-place2-result.json";
var LOG = "E:/项目文件/agent/ae字幕插件/test/output/ae-place2-progress.txt";

var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var VIDEO  = "E:/项目文件/agent/ae字幕插件/test/input/无上光荣.mp4";
var VOCALS = "E:/项目文件/agent/ae字幕插件/test/output/_人声分离/混剪测试_人声.wav";
var VOCALS2 = "E:/项目文件/agent/ae字幕插件/test/output/_人声分离/保留伴奏测试_伴奏.wav";

var marks = [], rep = { ok: false, cases: [], errors: [] };

function mark(m) {
  var t = "";
  try {
    var d = new Date();
    t = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
  } catch (e) { }
  marks.push(t + "  " + m);
  try {
    var f = new File(LOG); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(marks.join("\n")); f.close(); }
  } catch (e2) { }
}
function flush() {
  try {
    var s = (typeof AESub_toJSON_ === "function") ? AESub_toJSON_(rep) : "{}";
    var f = new File(OUT); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(s); f.close(); }
  } catch (e) { }
}
function esc(v) {
  if (v === null || v === undefined) return "null";
  var s = String(v), out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (code < 32) out += "\\u" + ("000" + code.toString(16)).slice(-4);
    else out += c;
  }
  return out + '"';
}
function callPlace(compName, srcName, audioPath, mode, offsetSec) {
  var opts = '{"mode":' + esc(mode) + ',"offsetSec":' + Number(offsetSec) + '}';
  var src = "AESub_placeSeparatedAudio(" + esc(compName) + "," + esc(srcName) + "," +
    esc(audioPath) + "," + esc(opts) + ")";
  return eval("(" + String(eval(src)) + ")");
}
function stack(comp) {
  var a = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    a.push(i + ":" + L.name + (L.audioEnabled && L.hasAudio ? "[audio-on]" : "[audio-off]"));
  }
  return a.join(" | ");
}
function layerIndexByName(comp, name) {
  for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).name === name) return i; }
  return -1;
}
function layerByName(comp, name) {
  for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).name === name) return comp.layer(i); }
  return null;
}
/** 统一的断言收集 */
function C(label, checks) {
  var c = { label: label, pass: true, fails: [], checks: checks || {} };
  for (var k in checks) {
    if (checks.hasOwnProperty(k) && checks[k] === false) { c.pass = false; c.fails.push(k); }
  }
  rep.cases.push(c);
  mark((c.pass ? "PASS " : "FAIL ") + label + (c.pass ? "" : " → " + c.fails.join(",")));
  return c;
}

mark("0 entered");
rep.jsonType = (typeof JSON);

var bridgeOk = false;
try { $.evalFile(new File(BRIDGE)); bridgeOk = true; mark("1 bridge-loaded"); }
catch (e1) { rep.errors.push("桥接层加载失败：" + (e1.message || e1.toString())); mark("1 FAILED"); }
rep.bridgeOk = bridgeOk;

var comp = null;
if (bridgeOk) {
  try {
    app.beginUndoGroup("setup");
    comp = app.project.items.addComp("落轨定稿测试", 1920, 1080, 1, 8, 25);
    comp.openInViewer();
    var vItem = app.project.importFile(new ImportOptions(new File(VIDEO)));
    comp.layers.add(vItem).name = "视频源";
    app.endUndoGroup();
    mark("2 setup: " + stack(comp));
  } catch (e2) { rep.errors.push("建合成失败：" + (e2.message || e2.toString())); mark("2 FAILED"); }
}

if (comp) {
  rep.itemsBaseline = app.project.numItems;

  /* ---------- 用例 1：视频源 → 关声音开关 + 人声紧贴其下方 ---------- */
  try {
    var vIdxBefore = layerIndexByName(comp, "视频源");
    var r1 = callPlace(comp.name, "视频源", VOCALS, "video", 0);
    var v = layerByName(comp, "视频源");
    var n1 = layerByName(comp, "视频源_人声");
    C("1 视频源·关声音+落下方", {
      "桥接返回 ok": r1.ok === true,
      "源层声音已关": v && v.audioEnabled === false,
      "源层仍在时间线": !!v,
      "人声层已建": !!n1,
      "命名正确": !!(n1 && n1.name === "视频源_人声"),
      "紧贴源层下方": !!(v && n1 && n1.index === v.index + 1),
      "返回的索引一致": !!(n1 && r1.data && r1.data.layerIndex === n1.index),
      "报告 mutedSource": !!(r1.data && r1.data.mutedSource === true),
      "未删源层": !!(r1.data && r1.data.removedSource === false),
      "outPoint 收拢到源层范围": !!(n1 && n1.outPoint > 6.0 && n1.outPoint <= comp.duration)
    });
    rep.case1Data = r1.data || null;
    rep.stackAfter1 = stack(comp);
  } catch (e3) { rep.errors.push("用例1异常：" + (e3.message || e3.toString())); }

  /* ---------- 用例 2：音频源 + 不替换 → 两者并存，人声在其下方 ---------- */
  try {
    var aItem = app.project.importFile(new ImportOptions(new File(VOCALS2)));
    var aL = comp.layers.add(aItem); aL.name = "音频源";
    var aIdx = aL.index;
    var r2 = callPlace(comp.name, "音频源", VOCALS, "below", 0);
    var aSrc = layerByName(comp, "音频源");
    var n2 = layerByName(comp, "音频源_人声");
    C("2 音频源·不替换落下方", {
      "桥接返回 ok": r2.ok === true,
      "源层保留": !!aSrc,
      "源层仍发声(未被静音)": aSrc && aSrc.audioEnabled === true,
      "人声层已建": !!n2,
      "紧贴源层下方": !!(aSrc && n2 && n2.index === aSrc.index + 1),
      "未删源层": !!(r2.data && r2.data.removedSource === false),
      "未静音源层": !!(r2.data && r2.data.mutedSource === false)
    });
    rep.stackAfter2 = stack(comp);
  } catch (e4) { rep.errors.push("用例2异常：" + (e4.message || e4.toString())); }

  /* ---------- 用例 3：音频源 + 替换 → 源层消失，人声占据其原位 ---------- */
  try {
    var cItem = app.project.importFile(new ImportOptions(new File(VOCALS2)));
    var cL = comp.layers.add(cItem); cL.name = "被替换源";
    var cOldIdx = cL.index;
    var layersBefore = comp.numLayers;
    var r3 = callPlace(comp.name, "被替换源", VOCALS, "replace", 0);
    var gone = (layerIndexByName(comp, "被替换源") === -1);
    var n3 = layerByName(comp, "被替换源_人声");
    C("3 音频源·替换（人声顶原位）", {
      "桥接返回 ok": r3.ok === true,
      "源层已删除": gone,
      "人声层已建": !!n3,
      "命名正确": !!(n3 && n3.name === "被替换源_人声"),
      "占据源层原索引": !!(n3 && n3.index === cOldIdx),
      "图层总数未变(删一加一)": comp.numLayers === layersBefore,
      "报告 removedSource": !!(r3.data && r3.data.removedSource === true),
      "未静音任何层": !!(r3.data && r3.data.mutedSource === false)
    });
    rep.case3OldIndex = cOldIdx;
    rep.case3NewIndex = n3 ? n3.index : null;
    rep.stackAfter3 = stack(comp);
  } catch (e5) { rep.errors.push("用例3异常：" + (e5.message || e5.toString())); }

  /* ---------- 用例 4：素材复用 + 重名处理 ---------- */
  try {
    var itemsBefore4 = app.project.numItems;
    var r4 = callPlace(comp.name, "视频源", VOCALS, "below", 0);
    var n4 = layerByName(comp, "视频源_人声 2");
    C("4 素材复用与重名退让", {
      "桥接返回 ok": r4.ok === true,
      "复用了已有素材(未重复导入)": !!(r4.data && r4.data.footageImported === false),
      "工程素材数未增长": app.project.numItems === itemsBefore4,
      "重名自动退让为 人声 2": !!n4,
      "给出重名说明": !!(r4.data && r4.data.dupNote)
    });
    rep.stackAfter4 = stack(comp);
  } catch (e6) { rep.errors.push("用例4异常：" + (e6.message || e6.toString())); }

  /* ---------- 用例 5：错误路径必须明确报错 ---------- */
  try {
    var r5a = callPlace(comp.name, "根本没这层", VOCALS, "below", 0);
    var r5b = callPlace(comp.name, "视频源", "C:/no/such/file.wav", "below", 0);
    C("5 错误路径防护", {
      "源层不存在时明确报错": r5a.ok === false && !!r5a.error,
      "文件不存在时明确报错": r5b.ok === false && !!r5b.error,
      "源层错误信息含层名": !!(r5a.error && String(r5a.error).indexOf("根本没这层") >= 0),
      "文件错误信息含路径": !!(r5b.error && String(r5b.error).indexOf("no/such/file.wav") >= 0)
    });
    rep.errMsgs = { layer: r5a.error, file: r5b.error };
  } catch (e7) { rep.errors.push("用例5异常：" + (e7.message || e7.toString())); }

  rep.itemsAfterWork = app.project.numItems;
  rep.finalStack = stack(comp);
}

/* ---------- 收尾：删合成与临时素材，验证零残留 ---------- */
try {
  if (comp) comp.remove();
  for (var m = app.project.numItems; m >= 1; m--) {
    var it = app.project.item(m);
    if (it instanceof FootageItem) {
      try {
        var p = "";
        if (it.mainSource instanceof FileSource && it.mainSource.file) {
          p = String(it.mainSource.file.fsName).replace(/\\/g, "/");
        }
        if (p === VIDEO || p === VOCALS || p === VOCALS2 || p.indexOf("/test/output/_人声分离/") >= 0) it.remove();
      } catch (e8) { }
    }
  }
  mark("9 cleanup, items=" + app.project.numItems);
} catch (e9) { }

rep.itemsLeft = app.project.numItems;
var passCount = 0;
for (var q = 0; q < rep.cases.length; q++) { if (rep.cases[q].pass) passCount++; }
rep.passCount = passCount;
rep.totalCases = rep.cases.length;
rep.ok = (rep.errors.length === 0) && (passCount === rep.cases.length) && rep.cases.length === 5;
flush();
mark("10 done: " + passCount + "/" + rep.cases.length + " cases passed");
