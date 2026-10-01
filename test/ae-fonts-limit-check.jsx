/*
 * 真机校验：AE 一次能给多少字体家族
 * ====================================================
 * 背景：拼音搜索在面板侧过滤，前提是能一次拿到**全量**清单。
 *      桥接层原本把 limit 上限压在 200（字体多的机器会被截断），
 *      本次放开到 4000。这个脚本就是验证这件事真的成立：
 *        · limit=4000 能拿到 totalFamilies 那么多个
 *        · limit=200  确实会少（证明原来的上限是真的会截断）
 *        · 顺带把全量清单落盘，供面板侧拼音匹配做端到端回归
 *
 * 用法：AfterFX.exe -r test/ae-fonts-limit-check.jsx
 * 产出：test/output/font-limit.json
 */
(function () {
  var ROOT = "E:/项目文件/agent/ae字幕插件";
  var BRIDGE = ROOT + "/cep/jsx/ae-bridge.jsx";
  var OUT = ROOT + "/test/output/font-limit.json";

  var res = { at: String(new Date()) };
  try {
    $.evalFile(BRIDGE);

    var full = JSON.parse(AESub_searchFonts("", 4000, true));
    res.available = full.data.available;
    res.ready = full.data.ready;
    res.totalFamilies = full.data.totalFamilies;
    res.fullReturned = (full.data.families || []).length;
    res.cacheState = full.data.cacheState;

    // 上限对比：老上限 200 会拿到几个
    var capped = JSON.parse(AESub_searchFonts("", 200, false));
    res.capReturned = (capped.data.families || []).length;

    // 落盘全量清单（只留面板匹配要用的字段，别把 styles 全塞进来 —— 太占体积）
    var slim = [];
    var fams = full.data.families || [];
    for (var i = 0; i < fams.length; i++) {
      var f = fams[i];
      var first = (f.styles && f.styles.length) ? f.styles[0] : {};
      slim.push({
        family: f.family,
        nativeName: f.nativeName,
        ps: first.ps,
        style: first.style,
        nativeStyle: first.nativeStyle
      });
    }
    res.families = slim;
    res.ok = true;
  } catch (e) {
    res.ok = false;
    res.error = String(e);
    res.line = e && e.line ? String(e.line) : "";
  }

  var f = new File(OUT);
  f.encoding = "UTF-8";
  if (f.open("w")) {
    f.write(JSON.stringify(res));
    f.close();
  }

  // 独立收尾脚本：跑完就退，别把 AE 留在前台
  var done = new File(ROOT + "/test/output/_font-limit.done");
  done.encoding = "UTF-8";
  if (done.open("w")) { done.write(res.ok ? "ok" : "fail"); done.close(); }
})();
