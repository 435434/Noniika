/**
 * integration-2-create.jsx —— 集成测试第二步：用【流水线产出的真实字幕 JSON】建图层并逐层核对
 * ==========================================================
 * 被 test/run-integration.js 调用。与第一步分开运行，是因为 AE 每次 -r 启动
 * 都是空项目，无法在同一个会话里跨两个 AE 进程保持状态。
 *
 * 这一步验证的是整条链路里最后一个未验证的衔接点：
 *   「Node 流水线产出的 JSON」 → 「ExtendScript 消费它并建出正确时间戳的图层」
 */

(function () {
  var self = new File($.fileName);
  var root = self.parent.parent;
  var outDir = root.fsName + "/test/output";
  var jsonPath = outDir + "/无上光荣.json";
  var out = { steps: [] };

  function step(name, ok, detail) {
    out.steps.push({ name: name, ok: !!ok, detail: detail || "" });
  }

  function flush() {
    try {
      var f = new File(outDir + "/int-create-result.json");
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

    var jsonFile = new File(jsonPath);
    if (!jsonFile.exists) { out.fatal = "找不到流水线产出的字幕 JSON：" + jsonPath; flush(); return; }

    var segs = AESub_readJSON_(jsonPath);
    step("读取流水线产出的 JSON", segs instanceof Array && segs.length > 0,
         "共 " + segs.length + " 段字幕");

    // ---- 重建与第一步相同的合成 ----
    var media = new File(root.fsName + "/test/input/无上光荣.mp4");
    var footage = app.project.importFile(new ImportOptions(media));
    var comp = app.project.items.addComp("集成测试合成", 1920, 1080, 1, footage.duration, 25);
    comp.layers.add(footage);

    // ---- 调用桥接层建字幕图层 ----
    var res = eval("(" + AESub_createSubtitleLayers(
      "集成测试合成", jsonPath,
      '{"mode":"layers","fontSize":72,"color":[1,0.9,0.2],"yPercent":0.85,"prefix":"字幕"}'
    ) + ")");

    step("用真实 JSON 创建字幕图层", res.ok,
         res.ok ? ("新建 " + res.data.created + " 层，跳过 " + res.data.skipped + " 条")
                : res.error);
    if (!res.ok) { flush(); return; }

    // ---- 逐层核对：时间戳、文本、命名 ----
    var checked = 0;
    var problems = [];
    for (var i = 0; i < segs.length; i++) {
      var expectName = "字幕_" + AESub_pad_(i + 1, 3);
      var found = null;
      for (var j = 1; j <= comp.numLayers; j++) {
        if (comp.layer(j).name === expectName) { found = comp.layer(j); break; }
      }
      if (!found) { problems.push(expectName + " 没找到"); continue; }

      var expIn = Math.max(0, segs[i].startMs / 1000);
      var expOut = Math.min(comp.duration, segs[i].endMs / 1000);
      if (Math.abs(found.inPoint - expIn) > 0.002 || Math.abs(found.outPoint - expOut) > 0.002) {
        problems.push(expectName + " 时间不符：实际[" + found.inPoint + "~" + found.outPoint +
                      "] 期望[" + expIn.toFixed(3) + "~" + expOut.toFixed(3) + "]");
        continue;
      }

      var text = "";
      try {
        text = found.property("ADBE Text Properties").property("ADBE Text Document").value.text;
      } catch (e) { text = ""; }
      if (String(text) !== String(segs[i].text)) {
        problems.push(expectName + " 文本不符：" + text + " ≠ " + segs[i].text);
        continue;
      }
      checked++;
    }

    step("逐层核对时间戳与文本", problems.length === 0 && checked === segs.length,
         "通过 " + checked + "/" + segs.length + " 层" + (problems.length ? ("；异常：" + problems.join("；")) : ""));

    // ---- 图层顺序：第一句应在最上层 ----
    step("图层顺序（第一句在最上层）", comp.layer(1).name === "字幕_001",
         "最上层是 " + comp.layer(1).name + "，共 " + comp.numLayers + " 层");

    // ---- 样式是否生效 ----
    var styleInfo = [];
    try {
      var first = comp.layer(1);
      var td = first.property("ADBE Text Properties").property("ADBE Text Document").value;
      var pos = first.property("ADBE Transform Group").property("ADBE Position").value;
      styleInfo.push("字号 " + td.fontSize);
      styleInfo.push("颜色 [" + td.fillColor.join(", ") + "]");
      styleInfo.push("位置 [" + Math.round(pos[0]) + ", " + Math.round(pos[1]) + "]");
      step("样式已生效", td.fontSize > 0 && pos.length === 2, styleInfo.join(" · "));
    } catch (e) {
      step("样式已生效", false, e.message);
    }

    // ---- 单图层模式也跑一遍（换个干净合成）----
    var comp2 = app.project.items.addComp("集成测试合成2", 1920, 1080, 1, footage.duration, 25);
    comp2.layers.add(footage);
    var res2 = eval("(" + AESub_createSubtitleLayers(
      "集成测试合成2", jsonPath,
      '{"mode":"single","fontSize":72,"color":[1,1,1],"yPercent":0.85,"prefix":"字幕"}'
    ) + ")");
    step("单图层+关键帧模式", res2.ok,
         res2.ok ? ("写入 " + res2.data.created + " 组关键帧，图层数 " + comp2.numLayers)
                 : res2.error);

  } catch (err) {
    out.fatal = err.message || String(err);
  }

  flush();
})();
