/* AE 实测：验证「渲染验证」法是否可靠 + 新体检字段（画面外 / 无填充）能否抓出 */
(function () {
  var OUT = "E:/项目文件/agent/ae字幕插件/test/output";
  var PROBE = OUT + "/probe";
  var PROG = OUT + "/ae-probe-progress.txt";
  var RESULT = OUT + "/ae-probe-result.json";
  var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
  BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";

  function log(m) {
    var f = new File(PROG); f.encoding = "UTF-8"; f.open("a"); f.writeln(m); f.close();
  }
  function q(s) {
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
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
  function dec(r) { return eval("(" + r + ")"); }

  function setupDir() {
    var d = new Folder(PROBE);
    if (!d.exists) d.create();
  }

  function main() {
    log("start, AE " + app.version);
    setupDir();
    $.evalFile(BRIDGE);
    log("bridge loaded");

    var i;
    for (i = app.project.numItems; i >= 1; i--) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name.indexOf("aesub-probe") === 0) it.remove();
    }

    var cases = [];

    /* ============ ① 确定性对照：同一状态渲两次，必须逐字节相同 ============ */
    var c1 = app.project.items.addComp("aesub-probe-det", 640, 360, 1, 5, 30);
    c1.layers.addSolid([0.1, 0.1, 0.2], "底", 640, 360, 1, 5);
    var t1 = c1.layers.addText("确定性对照");
    try {
      var tp1 = t1.property("ADBE Text Properties").property("ADBE Text Document");
      var td1 = tp1.value; td1.fontSize = 48; td1.applyFill = true;
      td1.fillColor = [1, 1, 1]; tp1.setValue(td1);
    } catch (eT1) { log("style err " + eT1); }
    c1.openInViewer();
    var fA = new File(PROBE + "/det-a.png");
    var fB = new File(PROBE + "/det-b.png");
    c1.saveFrameToPng(1, fA);
    c1.saveFrameToPng(1, fB);
    cases.push({ label: q("① 确定性对照（同状态渲两次）"),
      chk: { rendered: fA.exists && fB.exists,
             sameSize: fA.length === fB.length },
      got: { a: fA.length, b: fB.length } });
    log("case 1 done");

    /* ============ ② 正常字幕层：渲染验证 + 体检字段 ============ */
    var d2 = dec(AESub_checkSubtitleLayers(c1.name)).data || {};
    var p2 = dec(AESub_probeSubtitleRender(c1.name, "确定性对照")).data || {};
    var backOn = true;
    try { backOn = t1.enabled; } catch (e2) { }
    cases.push({ label: q("② 正常字幕层"),
      chk: { textLayers: d2.textLayers === 1, offscreen: d2.offscreen === 0,
             noFill: d2.noFill === 0,
             fillEnabled: (d2.samples && d2.samples[0]) ? d2.samples[0].fillEnabled === true : false,
             centerInside: !!(d2.samples && d2.samples[0] && d2.samples[0].centerX !== null &&
                              d2.samples[0].centerX > 0 && d2.samples[0].centerX < 640 &&
                              d2.samples[0].centerY > 0 && d2.samples[0].centerY < 360),
             enabledRestored: backOn === true },
      got: { samples: d2.samples, probe: p2 } });
    log("case 2 done");

    /* ============ ③ 无填充也无描边：体检 noFill + 渲染验证应判"零贡献" ============ */
    var c3 = app.project.items.addComp("aesub-probe-nofill", 640, 360, 1, 5, 30);
    c3.layers.addSolid([0.1, 0.1, 0.2], "底", 640, 360, 1, 5);
    var t3 = c3.layers.addText("没有填充的字");
    try {
      var tp3 = t3.property("ADBE Text Properties").property("ADBE Text Document");
      var td3 = tp3.value; td3.fontSize = 48; td3.applyFill = false; td3.applyStroke = false;
      tp3.setValue(td3);
    } catch (eT3) { log("nofill style err " + eT3); }
    var d3 = dec(AESub_checkSubtitleLayers(c3.name)).data || {};
    var p3 = dec(AESub_probeSubtitleRender(c3.name, "没有填充的字")).data || {};
    cases.push({ label: q("③ 无填充无描边的层"),
      chk: { noFill: d3.noFill === 1,
             fillFlagFalse: (d3.samples && d3.samples[0]) ? d3.samples[0].fillEnabled === false : false,
             probeDone: !!p3.pngOn },
      got: { noFill: d3.noFill, sample: d3.samples && d3.samples[0],
             pngOn: p3.pngOn, pngOff: p3.pngOff } });
    log("case 3 done");

    /* ============ ④ 文字移到画面外：体检 offscreen 应命中 ============ */
    var c4 = app.project.items.addComp("aesub-probe-offscreen", 640, 360, 1, 5, 30);
    c4.layers.addSolid([0.1, 0.1, 0.2], "底", 640, 360, 1, 5);
    var t4 = c4.layers.addText("跑到画面外去了");
    try {
      t4.property("ADBE Transform Group").property("ADBE Position").setValue([8000, 8000]);
    } catch (e4) { log("pos err " + e4); }
    var d4 = dec(AESub_checkSubtitleLayers(c4.name)).data || {};
    var p4 = dec(AESub_probeSubtitleRender(c4.name, "跑到画面外去了")).data || {};
    cases.push({ label: q("④ 文字被移到画面外"),
      chk: { offscreen: d4.offscreen === 1,
             sampleFlag: (d4.samples && d4.samples[0]) ? d4.samples[0].offscreen === true : false },
      got: { offscreen: d4.offscreen, sample: d4.samples && d4.samples[0],
             pngOn: p4.pngOn, pngOff: p4.pngOff } });
    log("case 4 done");

    /* ============ ⑤ 清场 + 落结果 ============ */
    var names = ["aesub-probe-det", "aesub-probe-nofill", "aesub-probe-offscreen"];
    for (i = 0; i < names.length; i++) {
      for (var k = app.project.numItems; k >= 1; k--) {
        var it2 = app.project.item(k);
        if (it2 instanceof CompItem && it2.name === names[i]) { it2.remove(); break; }
      }
    }
    wfile(RESULT, J({
      aeVersion: app.version,
      cases: cases,
      pngs: {
        detA: fA.fsName, detB: fB.fsName,
        visOn: p2.pngOn || "", visOff: p2.pngOff || "",
        noFillOn: p3.pngOn || "", noFillOff: p3.pngOff || "",
        offOn: p4.pngOn || "", offOff: p4.pngOff || ""
      }
    }));
    log("done");
  }

  try { main(); }
  catch (e) {
    log("OUTER: line " + e.line + " :: " + e.message);
    wfile(RESULT, J({ fatal: String(e.message), line: e.line }));
  }
})();
