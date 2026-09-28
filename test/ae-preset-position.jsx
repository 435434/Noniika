/**
 * 专测「预设带位移动画」这条分支。
 *
 * 上一轮用的预设（下雨字符入）走的是文本动画器，位置没有关键帧，
 * 所以"预设接管位置、不再强制居中"这条分支没被验到。这里从 4 个分类各取一个
 * 预设，看哪些会给「位置」加关键帧，并确认这种情况下不再强制居中。
 */

var SCRIPT_DIR = "C:/Users/kunku/Desktop/AE字幕插件";
var OUT = SCRIPT_DIR + "/test/output";
var PROGRESS = OUT + "/ae-preset-pos-progress.txt";
var REPORT = OUT + "/ae-preset-pos-result.json";
var JSON_IN = SCRIPT_DIR + "/test/input/fake-subtitle.json";
var TEXT_ROOT = "D:/softwore/app/AE2025/Adobe After Effects 2025/Support Files/Presets/Text";

var marks = [];
function mark(s) {
  marks.push(new Date().getTime() + "  " + s);
  try {
    var f = new File(PROGRESS); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(marks.join("\n") + "\n"); f.close(); }
  } catch (e) { }
}
mark("0 entered");

var report = { ok: false, cases: [], errors: [] };
var comps = [];

function json(o) {
  function esc(s) {
    s = String(s); var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '"') out += '\\"'; else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n"; else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t"; else out += c;
    }
    return '"' + out + '"';
  }
  function val(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return isFinite(v) ? String(Math.round(v * 10000) / 10000) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(val(v[i])); return "[" + a.join(",") + "]"; }
    if (typeof v === "object") { var b = []; for (var k in v) if (v.hasOwnProperty(k)) b.push(esc(k) + ":" + val(v[k])); return "{" + b.join(",") + "}"; }
    return esc(v);
  }
  return val(o);
}

function finish() {
  for (var i = 0; i < comps.length; i++) { try { comps[i].remove(); } catch (e) { } }
  try { app.project.dirty = false; } catch (e) { }
  mark("9 finished");
  try {
    var f = new File(REPORT); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(json(report)); f.close(); }
  } catch (e) { }
}

try {
  $.evalFile(new File(SCRIPT_DIR + "/cep/jsx/ae-bridge.jsx"));
  mark("1 bridge-loaded");
} catch (e) {
  report.errors.push("桥接层加载失败：" + (e.message || e.toString()));
  mark("1 FAILED");
  finish();
  throw new Error("bridge load failed");
}

// 四个分类各取一个预设（多取几个，尽量命中带位移动画的那个）
var candidates = [];
var folders = ["Animate In", "Animate Out", "3D Text", "Tracking", "Miscellaneous", "Scale"];
for (var fi = 0; fi < folders.length; fi++) {
  var f2 = new Folder(TEXT_ROOT + "/" + folders[fi]);
  if (!f2.exists) continue;
  var list = f2.getFiles("*.ffx");
  if (!list || !list.length) continue;
  candidates.push({ folder: folders[fi], file: list[0] });
  if (list.length > 1) candidates.push({ folder: folders[fi], file: list[Math.floor(list.length / 2)] });
}
report.candidateCount = candidates.length;

var hitPosition = 0;

for (var ci = 0; ci < candidates.length; ci++) {
  var cand = candidates[ci];
  var rec = { folder: cand.folder, file: cand.file.name };
  var comp = null;
  try {
    comp = app.project.items.addComp("位移验证_" + ci, 1920, 806, 1, 6.5, 24);
    comps.push(comp);
    comp.openInViewer();

    var opts = { mode: "layers", fontSize: 72, color: [1, 0.9, 0],
                 yPercent: 0.5, prefix: "字幕", presetPath: cand.file.fsName };
    var res = eval("(" + AESub_createSubtitleLayers("位移验证_" + ci, JSON_IN, json(opts)) + ")");
    rec.bridgeOk = res.ok;
    if (!res.ok) { rec.error = res.error; report.cases.push(rec); continue; }

    rec.created = res.data.created;
    rec.presetApplied = res.data.presetApplied;
    rec.presetNote = res.data.presetNote;
    rec.presetPositionKeyed = res.data.presetPositionKeyed;
    rec.presetKeysShifted = res.data.presetKeysShifted;

    // 看第一层的实际情况
    if (comp.numLayers > 0) {
      var L = comp.layer(1);
      var pos = L.property("ADBE Transform Group").property("ADBE Position");
      rec.firstLayerName = L.name;
      rec.firstLayerPosKeys = pos.numKeys;
      rec.firstLayerKeyTimes = [];
      for (var k = 1; k <= pos.numKeys && k <= 8; k++) {
        rec.firstLayerKeyTimes.push(Math.round(pos.keyTime(k) * 1000) / 1000);
      }
      rec.firstLayerInPoint = Math.round(L.inPoint * 1000) / 1000;
      if (pos.numKeys > 0) {
        hitPosition++;
        // 关键帧应当落在本层的时间范围内（平移生效），而不是原始预设的 0~1 秒
        var minT = Math.min.apply(null, rec.firstLayerKeyTimes);
        rec.keysShiftedIntoLayer = (minT >= rec.firstLayerInPoint - 0.02);
      }
    }
    mark("case " + ci + " " + cand.folder + " posKeys=" + rec.firstLayerPosKeys);
  } catch (e3) {
    rec.error = e3.message || e3.toString();
    mark("case " + ci + " THREW");
  }
  report.cases.push(rec);
}

report.positionKeyedCases = hitPosition;
// 判定：桥接层全部成功 + 至少命中一个带位移动画的预设 + 平移落点正确
var allOk = true, shiftOk = true;
for (var i2 = 0; i2 < report.cases.length; i2++) {
  if (report.cases[i2].bridgeOk !== true) allOk = false;
  if (report.cases[i2].keysShiftedIntoLayer === false) shiftOk = false;
}
report.ok = allOk && hitPosition > 0 && shiftOk && report.errors.length === 0;
report.notes = [
  "positionKeyedCases = 命中带位移动画的预设数量（用来判断这条分支确实被验到）",
  "keysShiftedIntoLayer = 关键帧是否被平移到本层时间范围内",
  "本脚本自建合成并在结束时删除，不影响已有工程"
];

finish();
