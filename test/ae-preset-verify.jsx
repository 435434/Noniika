/**
 * 验证「文字动画预设」以及「居中没被改坏」。
 *
 * 两件事一起测：
 *   A. 回归：不传 presetPath 时，字幕是否仍然精确居中（居中调用点刚从 styleText 里挪出来）
 *   B. 新功能：传 presetPath 时，预设是否真的套上、位置是否被预设接管、关键帧有没有平移
 *
 * 自建合成、自建 JSON，跑完删干净，不碰已有工程。
 */

var SCRIPT_DIR = "E:/项目文件/agent/ae字幕插件";
var OUT = SCRIPT_DIR + "/test/output";
var PROGRESS = OUT + "/ae-preset-progress.txt";
var REPORT = OUT + "/ae-preset-result.json";
var JSON_IN = SCRIPT_DIR + "/test/input/fake-subtitle.json";
var PRESET_ROOT = "D:/softwore/app/AE2025/Adobe After Effects 2025/Support Files/Presets/Text";

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
var madeComps = [];

function json(o) {
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

function finish() {
  for (var i = 0; i < madeComps.length; i++) {
    try { madeComps[i].remove(); } catch (e) { }
  }
  try { app.project.dirty = false; } catch (e) { }
  mark("9 finished");
  try {
    var f = new File(REPORT);
    f.encoding = "UTF-8";
    if (f.open("w")) { f.write(json(report)); f.close(); }
  } catch (e) { }
}

// ---------- 载入桥接层 ----------
try {
  $.evalFile(new File(SCRIPT_DIR + "/cep/jsx/ae-bridge.jsx"));
  mark("1 bridge-loaded");
} catch (e) {
  report.errors.push("桥接层加载失败：" + (e.message || e.toString()));
  mark("1 bridge-FAILED: " + (e.message || e.toString()));
  finish();
  throw new Error("bridge load failed");
}

// ---------- 找一个真实的预设文件 ----------
var presetFile = null;
try {
  var root = new Folder(PRESET_ROOT + "/Animate In");
  if (!root.exists) root = new Folder(PRESET_ROOT);
  var list = root.getFiles("*.ffx");
  if (list && list.length) {
    presetFile = list[0];
    report.presetUsed = list[0].fsName;
    report.presetCountInFolder = list.length;
  } else {
    report.errors.push("在 " + root.fsName + " 里没找到 .ffx");
  }
  mark("2 preset found: " + (presetFile ? presetFile.name : "NONE"));
} catch (e2) {
  report.errors.push("查找预设失败：" + (e2.message || e2.toString()));
}

/**
 * 跑一轮：建合成 → 建字幕层 → 逐层量几何/关键帧
 */
function runCase(label, presetPath) {
  var out = { label: label, presetPath: presetPath || null };
  var comp = null;
  try {
    comp = app.project.items.addComp("预设验证_" + label, 1920, 806, 1, 6.5, 24);
    madeComps.push(comp);
    comp.openInViewer();

    var opts = { mode: "layers", fontSize: 72, color: [1, 0.9, 0],
                 yPercent: 0.5, prefix: "字幕" };
    if (presetPath) opts.presetPath = presetPath;

    var raw = AESub_createSubtitleLayers("预设验证_" + label, JSON_IN, json(opts));
    var res = eval("(" + raw + ")");
    out.bridgeOk = res.ok;
    if (!res.ok) { out.error = res.error; return out; }

    out.created = res.data.created;
    out.skipped = res.data.skipped;
    out.presetApplied = res.data.presetApplied || null;
    out.presetNote = res.data.presetNote || null;
    out.presetPositionKeyed = res.data.presetPositionKeyed;
    out.presetKeysShifted = res.data.presetKeysShifted;

    // 逐层核对
    var layers = [];
    var maxDx = 0, maxDy = 0, keyedLayers = 0, totalKeys = 0;
    var cx = comp.width / 2, cy = comp.height / 2;
    for (var i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      var rec = { name: L.name, inPoint: L.inPoint, outPoint: L.outPoint };
      try {
        var tg = L.property("ADBE Transform Group");
        var pos = tg.property("ADBE Position");
        var anc = tg.property("ADBE Anchor Point");
        rec.positionKeys = pos.numKeys;
        rec.anchorKeys = anc.numKeys;
        totalKeys += pos.numKeys;
        if (pos.numKeys > 0) {
          keyedLayers++;
          rec.keyTimes = [];
          for (var k = 1; k <= pos.numKeys && k <= 6; k++) {
            rec.keyTimes.push(Math.round(pos.keyTime(k) * 1000) / 1000);
          }
        }
        var pv = pos.value;
        var av = anc.value;
        var bb = L.sourceRectAtTime(L.inPoint, false);
        // 只有"没有位置关键帧"的层才谈得上居中
        if (pos.numKeys === 0) {
          var tx = pv[0] + (bb.left + bb.width / 2 - av[0]);
          var ty = pv[1] + (bb.top + bb.height / 2 - av[1]);
          rec.dx = Math.round((tx - cx) * 100) / 100;
          rec.dy = Math.round((ty - cy) * 100) / 100;
          if (Math.abs(rec.dx) > maxDx) maxDx = Math.abs(rec.dx);
          if (Math.abs(rec.dy) > maxDy) maxDy = Math.abs(rec.dy);
        }
      } catch (eL) { rec.readError = eL.message || eL.toString(); }
      layers.push(rec);
    }
    out.layers = layers;
    out.layerCount = comp.numLayers;
    out.maxAbsDx = maxDx;
    out.maxAbsDy = maxDy;
    out.keyedLayerCount = keyedLayers;
    out.totalPositionKeys = totalKeys;
    out.allCentered = (maxDx <= 1 && maxDy <= 1);
    out.expectedCenter = [cx, cy];
  } catch (e3) {
    out.error = e3.message || e3.toString();
  }
  return out;
}

// ---------- A. 回归：不用预设，必须仍然精确居中 ----------
try {
  report.caseNoPreset = runCase("A_无预设", null);
  mark("A done, centered=" + report.caseNoPreset.allCentered +
       " maxDx=" + report.caseNoPreset.maxAbsDx + " maxDy=" + report.caseNoPreset.maxAbsDy);
} catch (eA) {
  report.errors.push("A 抛异常：" + (eA.message || eA.toString()));
}

// ---------- B. 新功能：套预设 ----------
try {
  if (presetFile) {
    report.caseWithPreset = runCase("B_带预设", presetFile.fsName);
    mark("B done, applied=" + report.caseWithPreset.presetApplied +
         " keyedLayers=" + report.caseWithPreset.keyedLayerCount +
         " shifted=" + report.caseWithPreset.presetKeysShifted);
  }
} catch (eB) {
  report.errors.push("B 抛异常：" + (eB.message || eB.toString()));
}

// ---------- 判定 ----------
var A = report.caseNoPreset || {};
var B = report.caseWithPreset || {};
report.ok = (A.bridgeOk === true) && (A.allCentered === true) &&
  (!presetFile || (B.bridgeOk === true && B.created > 0 && B.presetApplied)) &&
  report.errors.length === 0;

report.notes.push("本脚本自建合成并在结束时删除，不影响已有工程");

finish();
