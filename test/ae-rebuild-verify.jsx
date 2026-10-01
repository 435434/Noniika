/**
 * 验证「用已有字幕建图层」这条路径。
 *
 * 目的：面板刚才那次跑完了却没建图层，现在要证明 —— 拿它产出的真实 JSON，
 *       点「用已有字幕建图层」能真的在 AE 里建出图层（不重新识别、不上传）。
 *
 * 用 -r 启动时 AE 是空工程，脚本自建一个和用户工程同名同尺寸的合成来跑，
 * 跑完把自建的东西删干净。
 */

var SCRIPT_DIR = "E:/项目文件/agent/ae字幕插件";
var OUT_DIR    = SCRIPT_DIR + "/test/output";
var PROGRESS   = OUT_DIR + "/ae-rebuild-progress.txt";
var REPORT     = OUT_DIR + "/ae-rebuild-result.json";

// 面板实际用的输入（面板日志里写的那个产物）
var REAL_JSON  = "C:/Users/kunku/AppData/Local/Temp/_AE字幕输出/合成 1.json";
var COMP_NAME  = "合成 1";
var COMP_W = 1920, COMP_H = 806, COMP_DUR = 6.38;

var marks = [];
function mark(s) {
  marks.push(new Date().getTime() + "  " + s);
  try {
    var f = new File(PROGRESS);
    f.encoding = "UTF-8";
    if (f.open("w")) { f.write(marks.join("\n") + "\n"); f.close(); }
  } catch (e) { }
}
mark("0 script-entered");

var report = { ok: false, errors: [], notes: [] };
var madeComp = null;

function finish() {
  try { if (madeComp) madeComp.remove(); } catch (e) { }
  try { app.project.dirty = false; } catch (e) { }
  mark("9 finished");
  try {
    var f = new File(REPORT);
    f.encoding = "UTF-8";
    if (f.open("w")) { f.write(reportJson(report)); f.close(); }
  } catch (e) { }
}

// 极简 JSON 序列化（ExtendScript 没有 JSON 对象）
function reportJson(o) {
  function esc(s) {
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    }
    return '"' + out + '"';
  }
  function val(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return isFinite(v) ? String(Math.round(v * 10000) / 10000) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(val(v[i]));
      return "[" + a.join(",") + "]";
    }
    if (typeof v === "object") {
      var b = [];
      for (var k in v) if (v.hasOwnProperty(k)) b.push(esc(k) + ":" + val(v[k]));
      return "{" + b.join(",") + "}";
    }
    return esc(v);
  }
  return val(o);
}

// ---------- 1. 载入桥接层 ----------
try {
  $.evalFile(new File(SCRIPT_DIR + "/cep/jsx/ae-bridge.jsx"));
  mark("1 bridge-loaded");
} catch (e) {
  report.errors.push("桥接层加载失败：" + (e.message || e.toString()));
  mark("1 bridge-load-FAILED: " + (e.message || e.toString()));
  finish();
  throw new Error("bridge load failed");
}

// ---------- 2. 确认真实 JSON 存在且内容对 ----------
try {
  var jf = new File(REAL_JSON);
  report.jsonPath = REAL_JSON;
  report.jsonExists = jf.exists;
  report.jsonBytes = jf.exists ? jf.length : 0;
  if (jf.exists) {
    var rc = jf.open("r");
    var raw = rc ? jf.read() : "";
    if (rc) jf.close();
    jf.encoding = "UTF-8";
    report.jsonHead = String(raw).substring(0, 160);
    // 数一下有几个 text 字段 = 几句话
    var n = 0, idx = -1;
    while ((idx = String(raw).indexOf('"text"', idx + 1)) >= 0) n++;
    report.segmentCountInJson = n;
  }
  mark("2 json checked, exists=" + report.jsonExists + " segments=" + report.segmentCountInJson);
} catch (e2) {
  report.errors.push("读 JSON 失败：" + (e2.message || e2.toString()));
  mark("2 json-check-FAILED");
}

// ---------- 3. 自建一个同尺寸合成 ----------
try {
  madeComp = app.project.items.addComp(COMP_NAME, COMP_W, COMP_H, 1, COMP_DUR, 24);
  madeComp.openInViewer();
  report.compCreated = madeComp.name;
  report.compSize = madeComp.width + "x" + madeComp.height;
  report.compDuration = madeComp.duration;
  mark("3 comp created " + madeComp.name);
} catch (e3) {
  report.errors.push("建合成失败：" + (e3.message || e3.toString()));
  mark("3 comp-FAILED");
  finish();
  throw new Error("comp create failed");
}

// ---------- 4. 调桥接层建图层（与面板按钮完全同一条调用） ----------
try {
  var rawRes = AESub_createSubtitleLayers(
    COMP_NAME,
    REAL_JSON,
    '{"mode":"layers","fontSize":72,"color":[1,0.9019607843137255,0],' +
    '"yPercent":0.5,"prefix":"字幕"}'
  );
  mark("4 createSubtitleLayers returned, len=" + String(rawRes).length);
  var res = eval("(" + rawRes + ")");
  report.bridgeOk = res.ok;
  if (res.ok) {
    report.created = res.data.created;
    report.skipped = res.data.skipped;
    report.fontApplied = res.data.fontApplied || null;
    report.fontNote = res.data.fontNote || null;
  } else {
    report.errors.push("桥接层返回失败：" + res.error);
  }
} catch (e4) {
  report.errors.push("建图层抛异常：" + (e4.message || e4.toString()));
  mark("4 create-THREW: " + (e4.message || e4.toString()));
}

// ---------- 5. 逐层核对 ----------
try {
  var layers = [];
  var expectedCenterY = madeComp.height / 2;
  var expectedCenterX = madeComp.width / 2;
  var maxDx = 0, maxDy = 0;
  for (var i = 1; i <= madeComp.numLayers; i++) {
    var L = madeComp.layer(i);
    var rec = { name: L.name, index: i, inPoint: L.inPoint, outPoint: L.outPoint };
    try {
      var tp = L.property("ADBE Text Properties").property("ADBE Text Document");
      var td = tp.value;
      rec.text = td.text;
      rec.font = td.font;
      rec.fontSize = td.fontSize;
      rec.justification = td.justification;
      var bb = L.sourceRectAtTime(L.inPoint, false);
      rec.rectWidth = bb.width;
      var pos = L.property("ADBE Transform Group").property("ADBE Position").value;
      var anc = L.property("ADBE Transform Group").property("ADBE Anchor Point").value;
      rec.position = [pos[0], pos[1]];
      rec.anchorPoint = [anc[0], anc[1]];
      var cx = pos[0] + (bb.left + bb.width / 2 - anc[0]);
      var cy = pos[1] + (bb.top + bb.height / 2 - anc[1]);
      rec.textCenter = [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100];
      var dx = Math.round((cx - expectedCenterX) * 100) / 100;
      var dy = Math.round((cy - expectedCenterY) * 100) / 100;
      rec.dx = dx; rec.dy = dy;
      if (Math.abs(dx) > maxDx) maxDx = Math.abs(dx);
      if (Math.abs(dy) > maxDy) maxDy = Math.abs(dy);
    } catch (eT) { rec.readError = eT.message || eT.toString(); }
    layers.push(rec);
  }
  report.expectedCenter = [expectedCenterX, expectedCenterY];
  report.layers = layers;
  report.layerCount = madeComp.numLayers;
  report.maxAbsDx = maxDx;
  report.maxAbsDy = maxDy;
  report.allCentered = (maxDx <= 1 && maxDy <= 1 && layers.length > 0);
  mark("5 inspected " + layers.length + " layers, maxDx=" + maxDx + " maxDy=" + maxDy);
} catch (e5) {
  report.errors.push("核对图层失败：" + (e5.message || e5.toString()));
  mark("5 inspect-FAILED");
}

// ---------- 6. 判定 ----------
report.ok = (report.bridgeOk === true) &&
  (report.layerCount > 0) &&
  (report.allCentered === true) &&
  (report.errors.length === 0);
report.notes.push("本脚本自建合成并在结束时删除，不影响已有工程");

finish();
