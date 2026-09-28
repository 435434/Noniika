/* AE 空白字幕复现诊断：同一合成连续两轮建层，逐层 dump 可见性全量数据 */
(function () {
  var OUT = "C:/Users/kunku/Desktop/AE字幕插件/test/output";
  var PROG = OUT + "/ae-blank-progress.txt";
  var RESULT = OUT + "/ae-blank-result.json";
  var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";

  function log(m) {
    var f = new File(PROG); f.encoding = "UTF-8"; f.open("a"); f.writeln(m); f.close();
  }
  function q(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
  }
  function J(v) {
    var t = typeof v, k, o = [], i;
    if (v === null || v === undefined) return "null";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return q(v);
    if (v instanceof Array) { for (i = 0; i < v.length; i++) o.push(J(v[i])); return "[" + o.join(",") + "]"; }
    for (k in v) { if (v.hasOwnProperty(k)) o.push(q(k) + ":" + J(v[k])); }
    return "{" + o.join(",") + "}";
  }
  function wfile(p, s) { var f = new File(p); f.encoding = "UTF-8"; f.open("w"); f.write(s); f.close(); }

  /* 逐层 dump：可见性相关的全部属性 */
  function dumpLayer(L) {
    var d = {};
    try { d.name = L.name; } catch (e) { d.name = "?"; }
    try { d.type = L.typename; } catch (e) {}
    try { d.enabled = L.enabled; } catch (e) {}
    try { d.guide = L.guideLayer; } catch (e) {}
    try { d.solo = L.solo; } catch (e) {}
    try { d.shy = L.shy; } catch (e) {}
    try { d.inPoint = L.inPoint; d.outPoint = L.outPoint; d.startTime = L.startTime; } catch (e) {}
    try { d.stretch = L.stretch; } catch (e) {}
    try {
      var tg = L.property("ADBE Transform Group");
      d.pos = tg.property("ADBE Position").value;
      d.anchor = tg.property("ADBE Anchor Point").value;
      d.opacity = tg.property("ADBE Opacity").value;
    } catch (e) { d.tfErr = String(e); }
    try {
      var tp = L.property("ADBE Text Properties").property("ADBE Text Document");
      d.srcKeys = tp.numKeys;
      var td = tp.value;
      d.text = td.text;
      d.font = String(td.font || "");
      d.fontSize = td.fontSize;
      try { d.fill = [td.fillColor[0], td.fillColor[1], td.fillColor[2]]; } catch (e2) { d.fill = null; }
      try { d.just = String(td.justification); } catch (e3) {}
    } catch (e) { d.textErr = String(e); }
    try {
      d.animators = L.property("ADBE Text Properties").property("ADBE Text Animators").numProperties;
    } catch (e) {}
    try {
      var r = L.sourceRectAtTime(L.inPoint, false);
      d.rect = [r.left, r.top, r.width, r.height];
    } catch (e) { d.rectErr = String(e); }
    return d;
  }
  function dumpTextLayers(comp, tag, arr) {
    var i;
    for (i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      if (L instanceof TextLayer) arr.push(dumpLayer(L));
    }
    log(tag + ": dumped " + arr.length + " text layers (comp total " + comp.numLayers + ")");
  }

  function writeSegJson(segs) {
    var p = Folder.temp.fsName + "/aesub-blank-segs.json";
    wfile(p, J(segs));
    return p;
  }

  function main() {
    log("start, AE " + app.version);
    $.evalFile(BRIDGE);
    log("bridge loaded");

    /* 清掉上次残留的同名测试合成 */
    var i;
    for (i = app.project.numItems; i >= 1; i--) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === "aesub-blank-repro") { it.remove(); break; }
    }

    var comp = app.project.items.addComp("aesub-blank-repro", 1920, 1080, 1, 10, 30);
    comp.layers.addSolid([0.15, 0.15, 0.15], "素材一", 1920, 1080, 1, 10);
    log("comp ready");

    var OPTS = J({ mode: "layers", fontSize: 72, color: [1, 1, 1], yPercent: 0.5,
                   prefix: "字幕", nameMode: "text" });

    /* ---------- 第一轮：素材一 ---------- */
    var jA = writeSegJson([
      { text: "你好世界啊这是测试", startMs: 500, endMs: 3000 },
      { text: "第二句字幕", startMs: 3000, endMs: 6000 }
    ]);
    var r1raw = AESub_createSubtitleLayers("aesub-blank-repro", jA, OPTS);
    log("run1 returned, ok-prefixed=" + String(r1raw).substring(0, 40));
    var run1 = [];
    dumpTextLayers(comp, "run1", run1);

    /* ---------- 轮间状态模拟：指针移到中段 + 选中素材层 ---------- */
    comp.time = 4.2;
    comp.layer(1).selected = false;
    try { comp.layer(comp.numLayers).selected = true; } catch (eSel) { log("sel err " + eSel); }
    log("between-runs state set (time=4.2, bottom layer selected)");

    /* ---------- 第二轮：新素材（不同文字）同一合成 ---------- */
    var jB = writeSegJson([
      { text: "完全不同的新歌词第一句", startMs: 800, endMs: 3200 },
      { text: "第二句也不一样哦", startMs: 3600, endMs: 7200 }
    ]);
    var r2raw = AESub_createSubtitleLayers("aesub-blank-repro", jB, OPTS);
    log("run2 returned, ok-prefixed=" + String(r2raw).substring(0, 40));
    var run2 = [];
    dumpTextLayers(comp, "run2", run2);

    /* 追加探针：第二轮第一层在多个时间点的包围盒（判断文字是否真的渲染） */
    var probes = [];
    try {
      var L2 = null;
      for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i) instanceof TextLayer && comp.layer(i).name.indexOf("完全不同") === 0) { L2 = comp.layer(i); break; }
      }
      if (L2) {
        var ts = [0, L2.inPoint, (L2.inPoint + L2.outPoint) / 2, comp.time];
        for (i = 0; i < ts.length; i++) {
          var r = L2.sourceRectAtTime(ts[i], false);
          probes.push({ t: ts[i], left: r.left, top: r.top, w: r.width, h: r.height });
        }
      }
    } catch (eP) { probes.push({ err: String(eP) }); }
    log("probes done");

    var out = { aeVersion: app.version, r1: null, r2: null, run1: run1, run2: run2, probes: probes };
    try { out.r1 = eval("(" + r1raw + ")"); } catch (e1) { out.r1 = String(r1raw).substring(0, 200); }
    try { out.r2 = eval("(" + r2raw + ")"); } catch (e2) { out.r2 = String(r2raw).substring(0, 200); }
    wfile(RESULT, J(out));

    /* 测试合成移除，不污染项目（数据已全部落在结果文件里） */
    comp.remove();
    log("done");
  }

  try { main(); }
  catch (e) { log("OUTER: line " + e.line + " :: " + e.message); wfile(RESULT, J({ fatal: String(e.message), line: e.line })); }
})();
