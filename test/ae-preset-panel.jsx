/*
 * 严格模拟【面板】的调用路径，验证"选了预设后重新建图层"是否真的生效。
 *
 * 与之前的测试不同，这里刻意用 eval() 拼出与 evalScript 完全相同的源码，
 * 从而覆盖"面板 → evalScript → ExtendScript"这层的字符串转义。
 *
 * 用的都是真实数据：
 *   JSON   : 用户面板实际产出的 _AE字幕输出\合成 1.json
 *   PRESET : 用户在面板里选过的「按单词飞入」
 */
var OUT = "C:/Users/kunku/Desktop/AE字幕插件/test/output/ae-preset-panel-result.json";
var LOG = "C:/Users/kunku/Desktop/AE字幕插件/test/output/ae-preset-panel-progress.txt";

var JSPATH   = "C:/Users/kunku/AppData/Local/Temp/_AE字幕输出/合成 1.json";
var PRESET   = "D:/softwore/app/AE2025/Adobe After Effects 2025/Support Files/Presets/Text/Multi-Line/按单词飞入.ffx";
var BRIDGE   = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var COMPNAME = "合成 1";

var marks = [], rep = { ok: false, errors: [] };

/* 第一条就用 "w" —— 用 "a" 写不存在的文件会静默失败（踩过） */
function mark(msg) {
  var t = "";
  try {
    var d = new Date();
    t = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) +
        ":" + ("0" + d.getSeconds()).slice(-2);
  } catch (e) { }
  marks.push(t + "  " + msg);
  try {
    var f = new File(LOG); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(marks.join("\n")); f.close(); }
  } catch (e2) { }
}
/* ExtendScript 是 ES3：没有 JSON 对象，所以用桥接层自带的序列化器 */
function flush() {
  try {
    var s = (typeof AESub_toJSON_ === "function") ? AESub_toJSON_(rep) : "{}";
    var f = new File(OUT); f.encoding = "UTF-8";
    if (f.open("w")) { f.write(s); f.close(); }
  } catch (e) { }
}

/* 把 JS 值转成可嵌进源码的字符串字面量（等价于面板 CepBridge.arg） */
function esc(v) {
  if (v === null || v === undefined) return "null";
  var s = String(v);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (code < 32) out += "\\u" + ("000" + code.toString(16)).slice(-4);
    else out += c;
  }
  return out + '"';
}

mark("0 entered");

/* ---------- 加载桥接层 ---------- */
var bridgeOk = false, bridgeErr = "";
try { $.evalFile(new File(BRIDGE)); bridgeOk = true; mark("1 bridge-loaded"); }
catch (e) { bridgeErr = e.message || e.toString(); rep.errors.push("桥接层加载失败：" + bridgeErr); mark("1 bridge-FAILED: " + bridgeErr); }

/* ---------- 建一个同名合成（时长 7 秒，覆盖全部字幕时间戳）---------- */
var comp = null;
if (bridgeOk) {
  try {
    app.beginUndoGroup("test");
    comp = app.project.items.addComp(COMPNAME, 1920, 1080, 1, 7, 25);
    comp.openInViewer();
    mark("2 comp-created " + comp.name + " dur=" + comp.duration);
  } catch (e2) { rep.errors.push("建合成失败：" + (e2.message || e2.toString())); mark("2 comp-FAILED"); }
}

/* ---------- 关键：用面板完全相同的参数结构 ---------- */
if (comp) {
  try {
    // 面板 collectParams() 传给桥接层的就是这一段 JSON 文本（用面板同样的 key 顺序）
    var optsStr =
      '{"mode":"layers","fontSize":72,"color":[1,0.9,0],"yPercent":0.5,' +
      '"fontPostScriptName":"","presetPath":' + esc(PRESET) + ',"prefix":"字幕"}';

    // 用 eval 拼出 evalScript 实际收到的源码（含 CepBridge.arg 的双重转义）
    var src = "AESub_createSubtitleLayers(" +
      esc(COMPNAME) + "," +
      esc(JSPATH) + "," +
      esc(optsStr) + ")";
    mark("3 calling with preset, srcLen=" + src.length);

    var raw = eval(src);
    mark("3 returned, len=" + String(raw).length);

    var res = null;
    try { res = eval("(" + String(raw) + ")"); } catch (e3) { rep.errors.push("返回不是合法 JSON：" + String(raw).slice(0, 200)); }

    rep.raw = String(raw).slice(0, 900);
    if (res) {
      rep.bridgeOk = res.ok === true;
      rep.errorFromBridge = res.error || null;
      rep.created = res.data ? res.data.created : null;
      rep.skipped = res.data ? res.data.skipped : null;
      rep.presetRequested = res.data ? res.data.presetRequested : null;
      rep.presetApplied = res.data ? res.data.presetApplied : null;
      rep.presetNote = res.data ? res.data.presetNote : null;
      rep.fontApplied = res.data ? res.data.fontApplied : null;
      if (!res.ok) rep.errors.push("桥接层报错：" + res.error);
    }
  } catch (e4) {
    rep.errors.push("调用失败：" + (e4.message || e4.toString()));
    mark("3 THREW: " + (e4.message || e4.toString()));
  }
}

/* ---------- 逐层体检：动画器 / 关键帧 ---------- */
function walkKeys(group, path, out) {
  var n = 0;
  try { n = group.numProperties; } catch (e) { return; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e2) { continue; }
    if (!p) continue;
    var pt = -1;
    try { pt = p.propertyType; } catch (e3) { continue; }
    if (pt === PropertyType.PROPERTY) {
      var nk = 0;
      try { nk = p.numKeys; } catch (e4) { continue; }
      if (nk > 0) {
        var ts = [];
        for (var k = 1; k <= nk; k++) {
          try { ts.push(Math.round(p.keyTime(k) * 1000) / 1000); } catch (e5) { }
        }
        out.push({ path: path + "/" + p.name, times: ts, keys: nk });
      }
    } else if (pt === PropertyType.INDEXED_GROUP || pt === PropertyType.NAMED_GROUP) {
      walkKeys(p, path + "/" + p.name, out);
    }
  }
}

rep.layers = [];
if (comp) {
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    var info = {
      index: i, name: L.name, inPoint: 0, outPoint: 0,
      text: null, animators: 0, positionKeys: 0,
      keyedProps: [], animationKeySpan: null, rectWidth: null, textCenter: null
    };
    try { info.inPoint = Math.round(L.inPoint * 1000) / 1000; } catch (e) { }
    try { info.outPoint = Math.round(L.outPoint * 1000) / 1000; } catch (e) { }
    try {
      var td = L.property("ADBE Text Properties").property("ADBE Text Document").value;
      info.text = td.text;
      info.fontSize = td.fontSize;
      info.font = td.font;
      info.justification = td.justification;
    } catch (e) { }
    try {
      var anims = L.property("ADBE Text Properties").property("ADBE Text Animators");
      info.animators = anims.numProperties;
    } catch (e) { }
    try {
      var pos = L.property("ADBE Transform Group").property("ADBE Position");
      info.positionKeys = pos.numKeys;
      info.position = [pos.value[0], pos.value[1]];
    } catch (e) { }

    // 所有关键帧
    var keys = [];
    try { walkKeys(L, "", keys); } catch (e) { }
    info.keyedProps = keys;

    // 全部关键帧时间的跨度（用来判断是否被平移到本层时间）
    var lo = null, hi = null;
    for (var ki = 0; ki < keys.length; ki++) {
      for (var kj = 0; kj < keys[ki].times.length; kj++) {
        var t = keys[ki].times[kj];
        if (lo === null || t < lo) lo = t;
        if (hi === null || t > hi) hi = t;
      }
    }
    info.animationKeySpan = (lo === null) ? null : [lo, hi];
    info.keyTotal = 0;
    for (var kk = 0; kk < keys.length; kk++) info.keyTotal += keys[kk].keys;

    // 居中偏差
    try {
      var r = L.sourceRectAtTime(L.inPoint, false);
      var anc = L.property("ADBE Transform Group").property("ADBE Anchor Point").value;
      var pv = L.property("ADBE Transform Group").property("ADBE Position").value;
      var cx = pv[0] + (r.left + r.width / 2 - anc[0]);
      var cy = pv[1] + (r.top + r.height / 2 - anc[1]);
      info.rectWidth = Math.round(r.width * 10) / 10;
      info.textCenter = [Math.round(cx), Math.round(cy)];
      info.dx = Math.round(cx - comp.width / 2);
      info.dy = Math.round(cy - comp.height / 2);
    } catch (e) { }

    rep.layers.push(info);
  }
  rep.layerCount = comp.numLayers;
  mark("4 inspected " + comp.numLayers + " layers");
}

/* ---------- 判定：预设是否真的落到层上 ---------- */
var withAnimators = 0, withKeys = 0, shiftedOk = 0;
for (var i2 = 0; i2 < rep.layers.length; i2++) {
  var L2 = rep.layers[i2];
  if (L2.animators > 0) withAnimators++;
  if (L2.keyTotal > 0) withKeys++;
  // 关键帧起点应当落在本层 inPoint 附近（说明平移生效）
  if (L2.animationKeySpan && L2.animationKeySpan[0] >= L2.inPoint - 0.05) shiftedOk++;
}
rep.layersWithAnimators = withAnimators;
rep.layersWithKeys = withKeys;
rep.layersWhoseKeysShifted = shiftedOk;
rep.presetReachedLayers = (withAnimators > 0) && (rep.created > 0);
rep.ok = (rep.errors.length === 0) && (rep.created > 0) && withAnimators > 0;
mark("5 done, animators=" + withAnimators + " keys=" + withKeys);

/* ---------- 收尾：删掉临时合成，不留痕迹 ---------- */
try { if (comp) comp.remove(); mark("6 temp comp removed"); } catch (e6) { mark("6 remove-failed"); }
try { app.endUndoGroup(); } catch (e7) { }
try { app.project.dirty = false; } catch (e8) { }
rep.projectItems = app.project.numItems;
flush();
mark("7 report written");
