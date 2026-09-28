/**
 * integration-1-export.jsx —— 集成测试第一步：导入真实素材并导出音频
 * ==========================================================
 * 被 test/run-integration.js 调用（通过 AfterFX.exe -r 静默执行）。
 * 产物：test/output/int-export-result.json（含导出音频的绝对路径，供第二步的 Node 流水线使用）
 */

(function () {
  var self = new File($.fileName);
  var root = self.parent.parent;                 // test/ → 项目根目录
  var outDir = root.fsName + "/test/output";
  var out = { steps: [], audioFile: null, compDuration: null };

  function step(name, ok, detail) {
    out.steps.push({ name: name, ok: !!ok, detail: detail || "" });
  }

  function flush() {
    try {
      var dir = new Folder(outDir);
      if (!dir.exists) dir.create();
      var f = new File(outDir + "/int-export-result.json");
      f.encoding = "UTF-8";
      f.open("w");
      f.write(AESub_toJSON_(out));
      f.close();
    } catch (e) { }
  }

  try {
    $.evalFile(new File(root.fsName + "/cep/jsx/ae-bridge.jsx"));

    if (app.project.file !== null || app.project.numItems > 0) {
      out.fatal = "当前 AE 项目非空，为安全起见未运行。请先新建空项目。";
      flush();
      return;
    }

    // ---- 导入真实素材（用户提供的 MP4）----
    var media = new File(root.fsName + "/test/input/无上光荣.mp4");
    if (!media.exists) { out.fatal = "找不到测试素材 " + media.fsName; flush(); return; }

    var footage = app.project.importFile(new ImportOptions(media));
    var comp = app.project.items.addComp("集成测试合成", 1920, 1080, 1, footage.duration, 25);
    comp.layers.add(footage);
    step("导入真实素材并建合成", true,
         "素材 " + footage.name + " / 合成时长 " + footage.duration + " 秒");

    // ---- 音频体检 ----
    var info = AESub_analyzeAudio_(comp);
    step("音频体检", true,
         "音频图层 " + info.audioLayerCount + " 个，可直取=" + info.directUsable + "，理由=" + info.reason);

    // ---- 导出音频（走模板探测降级链）----
    var res = eval("(" + AESub_exportAudio("集成测试合成", outDir + "/int_audio") + ")");
    if (res.ok) {
      out.audioFile = res.data.file;
      out.compDuration = comp.duration;
      step("导出音频（模板探测）", true,
           res.data.file + " / 格式 " + res.data.format +
           " / 模板 " + res.data.template + " / " + res.data.bytes + " 字节 / " +
           res.data.elapsedSec + " 秒");
    } else {
      step("导出音频（模板探测）", false, res.error);
    }

    // ---- 队列必须还原 ----
    step("渲染后队列已还原", app.project.renderQueue.numItems === 0,
         "队列项数 " + app.project.renderQueue.numItems);

  } catch (err) {
    out.fatal = err.message || String(err);
  }

  flush();
})();
