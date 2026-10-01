/*
 * 专项验证：源层不从 0 秒开始时的落轨对齐（offsetSec ≠ 0）
 *
 * 这是真实场景的常态：源层可能是被裁过的，在合成里从 3 秒才开始。
 * 导出音频时区间起点 = 3 秒，于是"导出文件的 0 秒"对应"合成第 3 秒"，
 * 分离出的人声必须按这个偏移落回去 —— 否则人声整体错位。
 */
var OUT = "E:/项目文件/agent/ae字幕插件/test/output/ae-offset-result.json";
var LOG = "E:/项目文件/agent/ae字幕插件/test/output/ae-offset-progress.txt";
var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var VIDEO = "E:/项目文件/agent/ae字幕插件/test/input/无上光荣.mp4";
var VOCALS = "E:/项目文件/agent/ae字幕插件/test/output/_人声分离/混剪测试_人声.wav";

var marks = [], rep = { ok: false, errors: [], cases: [] };
function mark(m) {
  marks.push(m);
  try {
    var f = new File(LOG); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(marks.join("\n")); f.close(); }
  } catch (e) { }
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
function r3(v) { return Math.round(v * 1000) / 1000; }
function layerByName(comp, name) {
  for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).name === name) return comp.layer(i); }
  return null;
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 0.02 : tol); }
function C(label, checks) {
  var c = { label: label, pass: true, fails: [], checks: checks };
  for (var k in checks) { if (checks.hasOwnProperty(k) && checks[k] === false) { c.pass = false; c.fails.push(k); } }
  rep.cases.push(c);
  mark((c.pass ? "PASS " : "FAIL ") + label + (c.pass ? "" : " → " + c.fails.join(",")));
}

mark("0 entered");
var bridgeOk = false;
try { $.evalFile(new File(BRIDGE)); bridgeOk = true; mark("1 bridge-loaded"); }
catch (e1) { rep.errors.push("桥接层加载失败：" + (e1.message || e1.toString())); }
rep.bridgeOk = bridgeOk;

var comp = null;
if (bridgeOk) {
  try {
    app.beginUndoGroup("s");
    comp = app.project.items.addComp("偏移对齐测试", 1920, 1080, 1, 20, 25);
    comp.openInViewer();
    var vItem = app.project.importFile(new ImportOptions(new File(VIDEO)));
    var vL = comp.layers.add(vItem);
    vL.name = "裁过的源";
    vL.startTime = 0;        // 素材从 0 开始
    vL.inPoint = 3.0;        // 但在合成里只从第 3 秒才可见
    vL.outPoint = 5.0;       // 到第 5 秒截止（2 秒长）
    app.endUndoGroup();
    rep.srcIn = r3(vL.inPoint); rep.srcOut = r3(vL.outPoint);
    mark("2 setup: src " + rep.srcIn + "~" + rep.srcOut);
  } catch (e2) { rep.errors.push("建合成失败：" + (e2.message || e2.toString())); }
}

if (comp) {
  var fDur = null;
  try {
    var iItem = app.project.importFile(new ImportOptions(new File(VOCALS)));
    fDur = iItem.duration;
  } catch (e3) { rep.errors.push("读人声文件时长失败"); }
  rep.audioFileDuration = fDur ? r3(fDur) : null;

  /* ---------- 用例 1：源层 3.0~5.0（比音频文件短）→ 应精确落在 3.0~5.0 ---------- */
  try {
    var r1 = callPlace(comp.name, "裁过的源", VOCALS, "video", 3.0);
    var n1 = layerByName(comp, "裁过的源_人声");
    rep.case1 = r1.data;
    C("1 源层 3.0~5.0 且偏移 3.0（源比音频短）", {
      "桥接返回 ok": r1.ok === true,
      "人声层已建": !!n1,
      "startTime = 3.0（音频0秒对合成第3秒）": !!(n1 && near(n1.startTime, 3.0)),
      "inPoint = 3.0": !!(n1 && near(n1.inPoint, 3.0)),
      "outPoint = 5.0（收到源层出点）": !!(n1 && near(n1.outPoint, 5.0)),
      "时长约 2 秒": !!(n1 && near(n1.outPoint - n1.inPoint, 2.0)),
      "源层被静音": !!(layerByName(comp, "裁过的源") && layerByName(comp, "裁过的源").audioEnabled === false)
    });
  } catch (e4) { rep.errors.push("用例1异常：" + (e4.message || e4.toString())); }

  /* ---------- 用例 2：源层比音频长 → 出点应被音频长度截住，不产生静音尾巴 ---------- */
  try {
    var aItem = app.project.importFile(new ImportOptions(new File(VOCALS)));
    var aL = comp.layers.add(aItem);
    aL.name = "很长的源";
    aL.inPoint = 8.0;
    aL.outPoint = 19.0;      // 11 秒，远长于音频文件的 6.4 秒
    var r2 = callPlace(comp.name, "很长的源", VOCALS, "below", 8.0);
    var n2 = layerByName(comp, "很长的源_人声");
    rep.case2 = r2.data;
    var expectOut = 8.0 + (fDur || 0);
    C("2 源层 8.0~19.0 且偏移 8.0（源比音频长）", {
      "桥接返回 ok": r2.ok === true,
      "人声层已建": !!n2,
      "startTime = 8.0": !!(n2 && near(n2.startTime, 8.0)),
      "inPoint = 8.0": !!(n2 && near(n2.inPoint, 8.0)),
      "outPoint 被音频长度截住": !!(n2 && near(n2.outPoint, expectOut, 0.05)),
      "没有拖到源层出点 19.0": !!(n2 && n2.outPoint < 15.0),
      "源层未被静音(below 模式)": !!(layerByName(comp, "很长的源") && layerByName(comp, "很长的源").audioEnabled === true)
    });
    rep.expectOut2 = r3(expectOut);
  } catch (e5) { rep.errors.push("用例2异常：" + (e5.message || e5.toString())); }

  /* ---------- 用例 3：偏移为 0 时（回归）不该被算歪 ---------- */
  try {
    var bItem = app.project.importFile(new ImportOptions(new File(VOCALS)));
    var bL = comp.layers.add(bItem);
    bL.name = "从头开始的源";
    bL.inPoint = 0;
    bL.outPoint = 6.0;
    var r3v = callPlace(comp.name, "从头开始的源", VOCALS, "video", 0);
    var n3 = layerByName(comp, "从头开始的源_人声");
    C("3 偏移 0 的回归", {
      "桥接返回 ok": r3v.ok === true,
      "startTime = 0": !!(n3 && near(n3.startTime, 0)),
      "inPoint = 0": !!(n3 && near(n3.inPoint, 0)),
      "outPoint = 6.0": !!(n3 && near(n3.outPoint, 6.0))
    });
  } catch (e6) { rep.errors.push("用例3异常：" + (e6.message || e6.toString())); }
}

/* 收尾 */
try {
  if (comp) comp.remove();
  for (var m = app.project.numItems; m >= 1; m--) {
    var it = app.project.item(m);
    if (it instanceof FootageItem) {
      try {
        var p = "";
        if (it.mainSource instanceof FileSource && it.mainSource.file) p = String(it.mainSource.file.fsName).replace(/\\/g, "/");
        if (p === VIDEO || p === VOCALS || p.indexOf("/test/output/_人声分离/") >= 0) it.remove();
      } catch (e7) { }
    }
  }
  mark("9 cleanup items=" + app.project.numItems);
} catch (e8) { }

rep.itemsLeft = app.project.numItems;
var pc = 0;
for (var q = 0; q < rep.cases.length; q++) { if (rep.cases[q].pass) pc++; }
rep.passCount = pc; rep.totalCases = rep.cases.length;
rep.ok = rep.errors.length === 0 && pc === rep.cases.length && rep.cases.length === 3;
flush();
mark("10 done " + pc + "/" + rep.cases.length);
