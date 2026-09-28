/**
 * ae-test.jsx —— ExtendScript 桥接层的独立验证脚本（不依赖 CEP 面板）
 * ==========================================================
 * 用法（二选一）：
 *   1. 在 AE 中：文件 > 脚本 > 运行脚本文件 → 选中本文件
 *   2. 命令行：  AfterFX.exe -r "本文件绝对路径"
 *
 * 它会自动完成：
 *   建临时项目 → 导入测试音频 → 建合成 → 音频体检 → 导出音频 → 创建字幕图层
 * 结果写入：test/output/ae-test-result.json
 *
 * 安全设计：只在"未保存且为空的项目"上运行。若当前项目有内容，直接中止并提示，
 *          绝不改动你正在做的工程。
 */

(function () {

  var LOG_FILE = null; // 运行时确定
  var lines = [];
  var result = { steps: [] };

  // 从命令行（-r）静默运行时，用 $.writeln 代替弹窗，避免卡在模态对话框上
  var notifyImpl = alert;
  function notify(msg) {
    if (typeof AESUB_TEST_SILENT !== "undefined" && AESUB_TEST_SILENT) {
      try { $.writeln(msg); } catch (e) { }
      return;
    }
    notifyImpl(msg);
  }

  function log(msg) { lines.push(msg); }

  function step(name, ok, detail) {
    result.steps.push({ name: name, ok: !!ok, detail: detail || "" });
    log((ok ? "[通过] " : "[失败] ") + name + (detail ? "  ->  " + detail : ""));
  }

  function flushResult(scriptRoot) {
    try {
      var outDir = new Folder(scriptRoot.fsName + "/test/output");
      if (!outDir.exists) outDir.create();
      var f = new File(outDir.fsName + "/ae-test-result.json");
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AESub_toJSON_(result));
      f.close();
      f = new File(outDir.fsName + "/ae-test-log.txt");
      f.encoding = "UTF-8";
      f.open("w");
      f.write(lines.join("\n"));
      f.close();
    } catch (e) { }
  }

  // ---- 定位脚本根目录（test/ 的上一级）----
  var selfFile = new File($.fileName);
  var scriptRoot = selfFile.parent.parent;

  try {
    // ---- 载入桥接层 ----
    var bridgePath = scriptRoot.fsName + "/cep/jsx/ae-bridge.jsx";
    var bridgeFile = new File(bridgePath);
    if (!bridgeFile.exists) {
      notify("找不到桥接层文件：\n" + bridgePath);
      return;
    }
    $.evalFile(bridgeFile);
    log("已载入桥接层，版本 " + AESUB_VERSION);

    // ---- 安全检查：绝不在有内容的项目上跑测试 ----
    var unsafe = (app.project.file !== null) || (app.project.numItems > 0);
    if (unsafe) {
      notify("为安全起见已中止。\n\n" +
            "当前 AE 里打开着有内容的项目，测试会新建项目并覆盖它。\n" +
            "请先执行【文件 > 新建 > 新建项目】（或关掉当前项目），再运行本测试。");
      return;
    }

    app.beginUndoGroup("Noniika · 环境验证");

    // ---- 1. 导入测试音频 ----
    var wavPath = scriptRoot.fsName + "/test/input/tone_6s.wav";
    var wavFile = new File(wavPath);
    if (!wavFile.exists) { notify("找不到测试音频：\n" + wavPath); return; }
    var footage = app.project.importFile(new ImportOptions(wavFile));
    step("导入测试音频", footage !== null, footage ? footage.name : "");

    // ---- 2. 建合成并放入音频 ----
    var comp = app.project.items.addComp("AESub_验证合成", 1920, 1080, 1, 6, 25);
    var audioLayer = comp.layers.add(footage);
    step("创建合成并放入音频", comp.numLayers === 1,
         "合成 " + comp.width + "x" + comp.height + " / " + comp.duration + "秒 / 图层 " + audioLayer.name);

    // ---- 3. 音频体检（应判定为可直取原素材）----
    var info = AESub_analyzeAudio_(comp);
    step("音频体检 → 可直取原素材", info.directUsable === true,
         "音频图层数=" + info.audioLayerCount + "，原始文件=" + info.sourceFile +
         "，需 ffmpeg=" + info.needFfmpeg + "，理由=" + info.reason);

    // 附带 dump 变速属性，确认属性名与单位（历史上 timeStretch 恒为 undefined 导致误判）
    step("变速属性实测", true,
         "stretch=" + AESub_readProp_(audioLayer, "stretch") +
         " (typeof=" + (typeof audioLayer.stretch) + ")" +
         "，timeStretch=" + AESub_readProp_(audioLayer, "timeStretch") +
         "，timeRemapEnabled=" + audioLayer.timeRemapEnabled +
         "，outPoint=" + audioLayer.outPoint + " / 合成时长=" + comp.duration);

    // ---- 4. 探测输出模板（验证"格式只读"绕行方案是否成立）----
    var env = AESub_probeEnvironment("AESub_验证合成");
    var envObj = eval("(" + env + ")");
    step("探测输出模板", envObj.ok === true && envObj.data.canExportAudio === true,
         "AE " + (envObj.ok ? envObj.data.aeVersion : "?") +
         "，模板共 " + (envObj.ok ? envObj.data.templates.length : 0) + " 个" +
         "，命中格式=" + (envObj.ok ? envObj.data.resolvedFormat : "?") +
         "，命中模板=" + (envObj.ok ? envObj.data.resolvedTemplate : "?") +
         (envObj.ok && envObj.data.hint ? "，提示=" + envObj.data.hint : ""));

    // ---- 5. 导出音频 ----
    var outNoExt = scriptRoot.fsName + "/test/output/ae_export";
    var expRes = eval("(" + AESub_exportAudio("AESub_验证合成", outNoExt) + ")");
    step("导出音频", expRes.ok === true,
         expRes.ok
           ? ("产物=" + expRes.data.file + "，格式=" + expRes.data.format +
              "，模板=" + expRes.data.template + "，大小=" + expRes.data.bytes +
              " 字节，耗时=" + expRes.data.elapsedSec + " 秒")
           : ("错误：" + expRes.error));

    // ---- 6. 验证渲染后队列已还原 ----
    step("渲染后队列项已清理", app.project.renderQueue.numItems === 0,
         "当前队列项数=" + app.project.renderQueue.numItems);

    // ---- 7. 创建字幕图层（逐句一层）----
    var jsonPath = scriptRoot.fsName + "/test/input/fake-subtitle.json";
    if (new File(jsonPath).exists) {
      var before = comp.numLayers;
      var subRes = eval("(" + AESub_createSubtitleLayers(
        "AESub_验证合成", jsonPath,
        '{"mode":"layers","fontSize":72,"color":[1,0.9,0.2],"yPercent":0.85,"prefix":"字幕"}'
      ) + ")");
      step("创建字幕图层（逐句一层）", subRes.ok === true,
           subRes.ok
             ? ("新建 " + subRes.data.created + " 层，跳过 " + subRes.data.skipped + " 条，图层从 " + before + " 变为 " + comp.numLayers)
             : ("错误：" + subRes.error));

      // 打印前两层的实际入出点，确认时间戳对齐
      if (subRes.ok && subRes.data.created > 0) {
        var sample = [];
        for (var q = 1; q <= Math.min(3, comp.numLayers); q++) {
          var L = comp.layer(q);
          sample.push(L.name + "[" + L.inPoint.toFixed(2) + "~" + L.outPoint.toFixed(2) + "]");
        }
        step("抽查图层入出点", true, sample.join("  "));
      }
    } else {
      step("创建字幕图层（逐句一层）", false, "缺少 " + jsonPath);
    }

    // ---- 8. 创建字幕图层（单图层 + 关键帧）----
    if (new File(jsonPath).exists) {
      // 先清掉上一步建的图层，换个干净的方式验证
      var testComp2 = app.project.items.addComp("AESub_验证合成2", 1920, 1080, 1, 6, 25);
      testComp2.layers.add(footage);
      var subRes2 = eval("(" + AESub_createSubtitleLayers(
        "AESub_验证合成2", jsonPath,
        '{"mode":"single","fontSize":72,"color":[1,1,1],"yPercent":0.85,"prefix":"字幕"}'
      ) + ")");
      step("创建字幕图层（单图层+关键帧）", subRes2.ok === true,
           subRes2.ok
             ? ("关键帧 " + subRes2.data.created + " 组，图层数=" + testComp2.numLayers)
             : ("错误：" + subRes2.error));
    }

    app.endUndoGroup();

    result.scriptRoot = scriptRoot.fsName;
    result.allPassed = true;
    for (var s = 0; s < result.steps.length; s++) {
      if (!result.steps[s].ok) { result.allPassed = false; break; }
    }

    flushResult(scriptRoot);

    var summary = "";
    for (s = 0; s < result.steps.length; s++) {
      summary += (result.steps[s].ok ? "√ " : "× ") + result.steps[s].name + "\n";
    }
    notify("Noniika · 环境验证结束\n\n" + summary +
          "\n结果已写入：\ntest/output/ae-test-result.json");

  } catch (err) {
    try { app.endUndoGroup(); } catch (e) { }
    result.fatal = err.message || err.toString();
    result.allPassed = false;
    flushResult(scriptRoot);
    notify("验证脚本发生异常：\n" + (err.message || err.toString()) +
          "\n\n详情见 test/output/ae-test-log.txt");
  }

})();
