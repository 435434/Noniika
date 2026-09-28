/**
 * ae-diag.jsx —— AE 环境诊断脚本
 * ==========================================================
 * 用途：查清两件事
 *   1. 为什么"直取原素材"误判为「音频图层做了变速」—— 直接 dump 图层全部时间属性
 *   2. 本机 18 个输出模板分别对应什么格式 —— 找出有没有原生 WAV 模板
 *
 * 结果写入：test/output/ae-diag-result.json
 */

(function () {

  var diag = { templates: [], formats: [], layer: {}, comp: {}, errors: [] };

  var selfFile = new File($.fileName);
  var scriptRoot = selfFile.parent.parent;

  function writeOut() {
    try {
      var outDir = new Folder(scriptRoot.fsName + "/test/output");
      if (!outDir.exists) outDir.create();
      var f = new File(outDir.fsName + "/ae-diag-result.json");
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AESub_toJSON_(diag));
      f.close();
    } catch (e) { }
  }

  try {
    var bridgeFile = new File(scriptRoot.fsName + "/cep/jsx/ae-bridge.jsx");
    $.evalFile(bridgeFile);

    if ((app.project.file !== null) || (app.project.numItems > 0)) {
      diag.errors.push("当前项目有内容，为安全起见未运行。请新建空项目后重试。");
      writeOut();
      return;
    }

    // ---------- 1. 造一个"最干净的"音频图层，dump 它的全部时间属性 ----------
    var wavFile = new File(scriptRoot.fsName + "/test/input/tone_6s.wav");
    var footage = app.project.importFile(new ImportOptions(wavFile));
    var comp = app.project.items.addComp("AESub_诊断合成", 1920, 1080, 1, 6, 25);
    var layer = comp.layers.add(footage);

    diag.comp = {
      name: comp.name, duration: comp.duration, frameRate: comp.frameRate,
      width: comp.width, height: comp.height, numLayers: comp.numLayers
    };
    diag.footage = {
      name: footage.name, duration: footage.duration,
      hasAudio: footage.hasAudio, hasVideo: footage.hasVideo,
      mainSourceType: (footage.mainSource ? footage.mainSource.toString() : "null"),
      file: footage.mainSource && footage.mainSource.file ? footage.mainSource.file.fsName : null
    };
    diag.layer = {
      name: layer.name,
      layerType: layer.toString(),
      timeStretch: layer.timeStretch,
      timeStretchType: typeof layer.timeStretch,
      timeStretchIsExactlyOne: (layer.timeStretch === 1),
      timeStretchMinusOne: (layer.timeStretch - 1),
      timeRemapEnabled: layer.timeRemapEnabled,
      startTime: layer.startTime,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      duration: layer.duration,
      hasAudio: layer.hasAudio,
      audioEnabled: layer.audioEnabled,
      effectsCount: layer.property("ADBE Effect Parade").numProperties,
      isFileSource: (layer.source && layer.source.mainSource instanceof FileSource)
    };

    // 再测一次：用 addComp 之后手动 setStartTime 的对照组
    var comp2 = app.project.items.addComp("AESub_诊断合成2", 1920, 1080, 1, 6, 25);
    var layer2 = comp2.layers.add(footage);
    diag.layer2 = {
      timeStretch: layer2.timeStretch,
      startTime: layer2.startTime,
      inPoint: layer2.inPoint,
      outPoint: layer2.outPoint
    };

    // ---------- 2. 列出全部输出模板及其对应格式 ----------
    var rq = app.project.renderQueue;
    var item = rq.items.add(comp);
    var tpls = null;
    try {
      var raw = item.outputModule(1).templates;
      tpls = [];
      for (var i = 0; i < raw.length; i++) tpls.push(raw[i]);
    } catch (e) { diag.errors.push("读取模板列表失败: " + e.message); }
    diag.templates = tpls || [];
    diag.defaultFormat = AESub_getFormat_(item);

    if (tpls) {
      for (var t = 0; t < tpls.length; t++) {
        var rec = { template: tpls[t], format: null, error: null };
        try {
          item.outputModule(1).applyTemplate(tpls[t]);
          rec.format = AESub_getFormat_(item);
        } catch (e2) { rec.error = e2.message; }
        diag.formats.push(rec);
      }
    }

    // 找出所有能输出音频的模板
    diag.audioTemplates = [];
    for (var k = 0; k < diag.formats.length; k++) {
      var fmt = diag.formats[k].format;
      if (fmt && AESUB_AUDIO_FORMATS[fmt]) diag.audioTemplates.push(diag.formats[k].template + " → " + fmt);
    }
    diag.hasWavTemplate = false;
    for (k = 0; k < diag.formats.length; k++) {
      if (diag.formats[k].format === "WAV") diag.hasWavTemplate = true;
    }

    try { item.remove(); } catch (e3) { }

    diag.ok = true;

  } catch (err) {
    diag.errors.push(err.message || err.toString());
    diag.ok = false;
  }

  writeOut();
})();
