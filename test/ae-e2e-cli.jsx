/**
 * ae-e2e-cli.jsx —— AE 侧代码的端到端验证（用 `-r` 驱动，无需人工点击）
 * ==========================================================
 * 造一个和当初压垮用户那类场景一致的合成：
 *   合成 5 秒，音频图层只覆盖 1~4 秒 → 验证"按范围导出"而不是导出整段。
 *
 * 验证四件事：
 *   1. 范围探测：AESub_getTimelineSelection 是否算出 1~4 秒
 *   2. 按范围导出：offsetSec 是否 = 1.0、产物真实时长是否 = 3.0 秒
 *   3. 建字幕图层：走真实业务函数 AESub_createSubtitleLayers，核对时间戳
 *   4. 几何居中：算出"文本块中心在画面里的落点"，与中线比对
 *
 * 安全：在**空工程**里跑，自建自删（临时合成 + 临时素材全部移除）。
 * 用法：AfterFX.exe -r ae-e2e-cli.jsx
 */

var ROOT   = "E:/项目文件/agent/ae字幕插件";
var OUT    = ROOT + "/test/output/ae-e2e-result.json";
var PROG   = ROOT + "/test/output/ae-e2e-progress.txt";
var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var MP4    = ROOT + "/test/input/无上光荣.mp4";
var SUBS   = ROOT + "/test/input/fake-subtitle.json";

/** 最基础落盘：不依赖桥接层。注意必须用 "w" 起头 —— 
 *  ExtendScript 里对不存在的文件用 "a"（append）会静默失败，
 *  这正是之前"脚本看着没跑"的元凶之一。 */
function mark(line, append) {
  try {
    var f = new File(PROG);
    f.encoding = "UTF-8";
    if (f.open(append ? "a" : "w")) {
      f.write(new Date().toLocaleTimeString() + "  " + line + "\n");
      f.close();
      return true;
    }
  } catch (e) { }
  return false;
}

mark("0 entered", false);

var rep = { ok: false, aeVersion: app.version, errors: [], notes: [] };

/* ---------- 加载桥接层 ---------- */
try {
  $.evalFile(new File(BRIDGE));
  mark("1 bridge-loaded", true);
} catch (e1) {
  mark("1 bridge-load-FAILED: " + (e1.message || e1.toString()), true);
  rep.errors.push("桥接层加载失败：" + (e1.message || e1.toString()));
  try {
    var f0 = new File(OUT); f0.encoding = "UTF-8";
    if (f0.open("w")) { f0.write('{"ok":false,"errors":["bridge load failed"]}'); f0.close(); }
  } catch (e0) { }
  mark("9 aborted", true);
}

if (rep.errors.length === 0) {
  try {
    rep.projectItemsBefore = app.project.numItems;
    rep.comp = {};

    /* ---------- 1. 建临时合成 ---------- */
    var comp = app.project.items.addComp("AESubE2E", 1920, 1080, 1, 5, 25);
    rep.comp.name = comp.name;
    rep.comp.width = comp.width;
    rep.comp.height = comp.height;
    rep.comp.duration = comp.duration;
    rep.comp.frameRate = comp.frameRate;
    mark("2 comp-created 1920x1080 5s", true);

    /* ---------- 2. 导入素材，摆成"只覆盖 1~4 秒" ---------- */
    var mp4 = new File(MP4);
    rep.mp4Exists = mp4.exists;
    var ftg = app.project.importFile(new ImportOptions(mp4));
    var aud = comp.layers.add(ftg);
    aud.name = "audiotest";
    aud.startTime = 0;
    aud.inPoint = 1.0;
    aud.outPoint = 4.0;
    rep.audioLayer = {
      inPoint: aud.inPoint, outPoint: aud.outPoint,
      hasAudio: aud.hasAudio, audioEnabled: aud.audioEnabled
    };
    mark("3 audio-layer 1~4s ready", true);

    /* ---------- 3. 尝试让它成为活动合成（失败不致命）---------- */
    try { comp.openInViewer(); rep.notes.push("openInViewer() 可用"); }
    catch (eA) { rep.notes.push("openInViewer() 不可用：" + (eA.message || eA.toString())); }
    rep.activeItemIsComp = (app.project.activeItem === comp || (app.project.activeItem && app.project.activeItem.name === "AESubE2E"));

    /* ---------- 4. 范围探测 ---------- */
    var sd = eval("(" + AESub_getTimelineSelection(0) + ")");
    if (sd.ok) {
      rep.rangeDetect = {
        hasComp: sd.data.hasComp, ready: sd.data.ready, autoPicked: sd.data.autoPicked,
        audioLayerCount: sd.data.audioLayerCount,
        rangeStart: sd.data.ready ? sd.data.rangeStart : null,
        rangeEnd: sd.data.ready ? sd.data.rangeEnd : null,
        rangeDuration: sd.data.ready ? sd.data.rangeDuration : null,
        hint: sd.data.hint || ""
      };
      rep.rangeDetect.startOk = (typeof sd.data.rangeStart === "number" && Math.abs(sd.data.rangeStart - 1.0) <= 0.05);
      rep.rangeDetect.endOk = (typeof sd.data.rangeEnd === "number" && Math.abs(sd.data.rangeEnd - 4.0) <= 0.05);
    } else {
      rep.errors.push("范围探测失败：" + sd.error);
    }
    mark("4 range-detect done", true);

    /* ---------- 5. 按范围导出 1~4 秒 ---------- */
    var ex = eval("(" + AESub_exportAudio("AESubE2E", 1.0, 4.0, ROOT + "/test/output/ae-e2e-audio") + ")");
    if (ex.ok) {
      rep.export = {
        format: ex.data.format,
        template: ex.data.template,
        offsetSec: ex.data.offsetSec,
        durationSec: ex.data.durationSec,
        bytes: ex.data.bytes,
        elapsedSec: ex.data.elapsedSec,
        alignDriftSec: ex.data.alignDriftSec,
        // 48kHz/16bit/立体声 = 192000 字节/秒，反推文件真实时长
        fileDurationSec: Math.round(((ex.data.bytes - 468) / 192000) * 1000) / 1000
      };
      rep.export.offsetOk = Math.abs(ex.data.offsetSec - 1.0) <= 0.05;
      rep.export.durationOk = Math.abs(rep.export.fileDurationSec - 3.0) <= 0.1;
      rep.export.notWholeComp = rep.export.fileDurationSec < 4.0;   // 关键：不能是整段 5 秒
    } else {
      rep.errors.push("按范围导出失败：" + ex.error);
    }
    mark("5 export done", true);

    /* ---------- 6. 建字幕图层（走真实业务函数）---------- */
    var opts = AESub_toJSON_({
      mode: "layers", fontSize: 72, color: [1, 0.9, 0.2],
      yPercent: 0.5, prefix: "SUB"
    });
    var cr = eval("(" + AESub_createSubtitleLayers("AESubE2E", SUBS, opts) + ")");
    if (cr.ok) {
      rep.create = {
        created: cr.data.created, skipped: cr.data.skipped,
        fontRequested: cr.data.fontRequested, fontApplied: cr.data.fontApplied,
        fontNote: cr.data.fontNote
      };
    } else {
      rep.errors.push("建字幕图层失败：" + cr.error);
    }
    mark("6 subtitle-layers created", true);

    /* ---------- 7. 逐层核对几何 + 时间戳 ---------- */
    var list = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      if (L.name.indexOf("SUB_") !== 0) continue;
      var tg = L.property("ADBE Transform Group");
      var pos = tg.property("ADBE Position").value;
      var anc = tg.property("ADBE Anchor Point").value;
      var r = L.sourceRectAtTime(L.inPoint, false);
      var tdv = L.property("ADBE Text Properties").property("ADBE Text Document").value;
      var cx = pos[0] + ((r.left + r.width / 2) - anc[0]);
      var cy = pos[1] + ((r.top + r.height / 2) - anc[1]);
      list.push({
        name: L.name, text: tdv.text,
        inPoint: Math.round(L.inPoint * 1000) / 1000,
        outPoint: Math.round(L.outPoint * 1000) / 1000,
        rectWidth: Math.round(r.width * 100) / 100,
        rectHeight: Math.round(r.height * 100) / 100,
        position: [Math.round(pos[0] * 100) / 100, Math.round(pos[1] * 100) / 100],
        anchorPoint: [Math.round(anc[0] * 100) / 100, Math.round(anc[1] * 100) / 100],
        textCenterInComp: [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100],
        dx: Math.round((cx - comp.width / 2) * 100) / 100,
        dy: Math.round((cy - comp.height / 2) * 100) / 100,
        font: String(tdv.font || ""),
        justificationIsCenter: (tdv.justification === ParagraphJustification.CENTER_JUSTIFY)
      });
    }
    rep.layers = list;
    rep.subLayerCount = list.length;
    rep.expectedCenter = [comp.width / 2, comp.height / 2];

    var maxDx = 0, maxDy = 0;
    for (var k = 0; k < list.length; k++) {
      if (Math.abs(list[k].dx) > maxDx) maxDx = Math.abs(list[k].dx);
      if (Math.abs(list[k].dy) > maxDy) maxDy = Math.abs(list[k].dy);
    }
    rep.maxAbsDx = Math.round(maxDx * 100) / 100;
    rep.maxAbsDy = Math.round(maxDy * 100) / 100;
    rep.allCentered = (list.length > 0 && maxDx <= 1 && maxDy <= 1);
    mark("7 geometry done", true);

    /* ---------- 8. 清理（自建自删）---------- */
    try { comp.remove(); } catch (eC1) { }
    try { ftg.remove(); } catch (eC2) { }
    // 顺手删掉测试产物音频
    try {
      var dir = new Folder(ROOT + "/test/output");
      var files = dir.getFiles("ae-e2e-audio.*");
      for (var q = 0; q < files.length; q++) { try { files[q].remove(); } catch (eR) { } }
    } catch (eD) { }
    rep.projectItemsAfter = app.project.numItems;
    mark("8 cleanup done, items=" + rep.projectItemsAfter, true);

  } catch (eMain) {
    rep.errors.push("主流程异常：" + (eMain.message || eMain.toString()));
    mark("X exception: " + (eMain.message || eMain), true);
  }

  rep.ok = (rep.errors.length === 0) &&
           rep.allCentered === true &&
           rep.export && rep.export.offsetOk && rep.export.durationOk && rep.export.notWholeComp &&
           rep.rangeDetect && rep.rangeDetect.startOk && rep.rangeDetect.endOk;

  try { app.project.dirty = false; } catch (eDirty) { }

  try {
    var fw = new File(OUT);
    fw.encoding = "UTF-8";
    if (fw.open("w")) { fw.write(AESub_toJSON_(rep)); fw.close(); }
  } catch (eW) { mark("报告写入失败: " + (eW.message || eW), true); }
  mark("9 report-written, ok=" + rep.ok, true);
}
