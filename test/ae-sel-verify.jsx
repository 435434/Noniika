/*
 * 验证面板的"输入"：AESub_getTimelineSelection 返回的新字段
 *   sourceLayer / sourceLayerName / sourceLayerIsVideo / sourceLayerIsSeparatedVocals
 * 面板就是靠这几个字段决定"弹不弹询问框、要不要跳过分离"的。
 */
var OUT = "E:/项目文件/agent/ae字幕插件/test/output/ae-sel-result.json";
var LOG = "E:/项目文件/agent/ae字幕插件/test/output/ae-sel-progress.txt";
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
    comp = app.project.items.addComp("选区测试", 1920, 1080, 1, 8, 25);
    comp.openInViewer();
    var vItem = app.project.importFile(new ImportOptions(new File(VIDEO)));
    comp.layers.add(vItem).name = "视频素材";
    app.endUndoGroup();
    mark("2 setup ok");
  } catch (e2) { rep.errors.push("建合成失败：" + (e2.message || e2.toString())); }
}

if (comp) {
  /* --- 场景 1：选中视频层 → 应判定为"视频素材"、不弹框 --- */
  try {
    for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    comp.layer(1).selected = true;   // 视频素材
    var r1 = eval("(" + String(eval("AESub_getTimelineSelection(0)")) + ")");
    var d1 = r1.data || {};
    C("1 选中视频层", {
      "返回 ok": r1.ok === true,
      "ready": d1.ready === true,
      "源层名正确": d1.sourceLayerName === "视频素材",
      "判定为视频": d1.sourceLayerIsVideo === true,
      "未误判为人声层": d1.sourceLayerIsSeparatedVocals === false,
      "sourceLayer 对象在": !!(d1.sourceLayer && d1.sourceLayer.name === "视频素材"),
      "图层信息带 hasVideo": !!(d1.layers && d1.layers[0] && d1.layers[0].hasVideo === true)
    });
  } catch (e3) { rep.errors.push("场景1异常：" + (e3.message || e3.toString())); }

  /* --- 场景 2：选中音频层 → 应判定为"音频素材"（面板据此弹框问替换与否）--- */
  try {
    var aItem = app.project.importFile(new ImportOptions(new File(VOCALS)));
    var aL = comp.layers.add(aItem); aL.name = "纯音频素材";
    for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = false;
    aL.selected = true;
    var r2 = eval("(" + String(eval("AESub_getTimelineSelection(0)")) + ")");
    var d2 = r2.data || {};
    C("2 选中音频层", {
      "返回 ok": r2.ok === true,
      "源层名正确": d2.sourceLayerName === "纯音频素材",
      "判定为音频(非视频)": d2.sourceLayerIsVideo === false,
      "未误判为人声层": d2.sourceLayerIsSeparatedVocals === false
    });
  } catch (e4) { rep.errors.push("场景2异常：" + (e4.message || e4.toString())); }

  /* --- 场景 3：选中我们自己生成的人声层 → 面板应跳过分离 --- */
  try {
    var vItem2 = app.project.importFile(new ImportOptions(new File(VOCALS)));
    var vL = comp.layers.add(vItem2); vL.name = "视频素材_人声";
    for (var k = 1; k <= comp.numLayers; k++) comp.layer(k).selected = false;
    vL.selected = true;
    var r3 = eval("(" + String(eval("AESub_getTimelineSelection(0)")) + ")");
    var d3 = r3.data || {};
    C("3 选中已生成的人声层", {
      "返回 ok": r3.ok === true,
      "源层名正确": d3.sourceLayerName === "视频素材_人声",
      "被识别为人声层(将跳过分离)": d3.sourceLayerIsSeparatedVocals === true
    });
  } catch (e5) { rep.errors.push("场景3异常：" + (e5.message || e5.toString())); }
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
      } catch (e6) { }
    }
  }
  mark("9 cleanup items=" + app.project.numItems);
} catch (e7) { }

rep.itemsLeft = app.project.numItems;
var pc = 0;
for (var q = 0; q < rep.cases.length; q++) { if (rep.cases[q].pass) pc++; }
rep.passCount = pc; rep.totalCases = rep.cases.length;
rep.ok = rep.errors.length === 0 && pc === rep.cases.length && rep.cases.length === 3;
flush();
mark("10 done " + pc + "/" + rep.cases.length);
