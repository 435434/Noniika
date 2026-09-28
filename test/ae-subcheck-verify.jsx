/* AE 实测：验证「字幕体检」能准确抓出"建了层但看不见"的各种成因 */
(function () {
  var OUT = "C:/Users/kunku/Desktop/AE字幕插件/test/output";
  var PROG = OUT + "/ae-subcheck-progress.txt";
  var RESULT = OUT + "/ae-subcheck-result.json";
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
  function chk(r) {   // 把桥接层返回的 JSON 字符串解成对象
    return eval("(" + r + ")");
  }

  var cases = [];

  function main() {
    log("start, AE " + app.version);
    $.evalFile(BRIDGE);
    log("bridge loaded");

    var i;
    for (i = app.project.numItems; i >= 1; i--) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name.indexOf("aesub-subcheck") === 0) it.remove();
    }

    /* ---------- ① 干净场景：素材在下、字幕在上 → 不该报遮挡 ---------- */
    var c1 = app.project.items.addComp("aesub-subcheck-干净", 1920, 1080, 1, 8, 30);
    c1.layers.addSolid([0.2, 0.2, 0.2], "素材一", 1920, 1080, 1, 8);   // 底层素材
    c1.layers.addText("第一句正常字幕");
    c1.layers.addText("第二句正常字幕");
    var d1 = chk(AESub_checkSubtitleLayers(c1.name)).data || {};
    cases.push({ label: q("① 干净：素材在下、字幕在上"),
      chk: { textLayers: d1.textLayers === 2, occluded: d1.occluded === 0,
             emptyText: d1.emptyText === 0, hidden: d1.hidden === 0,
             transparent: d1.transparent === 0 },
      got: { textLayers: d1.textLayers, occluded: d1.occluded, occluders: d1.occluders } });
    log("case 1 done");

    /* ---------- ② 遮挡场景：素材压在字幕上方（用户报的现象） ---------- */
    var c2 = app.project.items.addComp("aesub-subcheck-遮挡", 1920, 1080, 1, 8, 30);
    c2.layers.addText("被盖住的第一句");
    c2.layers.addText("被盖住的第二句");
    var cover = c2.layers.addSolid([0.1, 0.1, 0.1], "后放进去的素材", 1920, 1080, 1, 8);  // 落在最上方
    var d2 = chk(AESub_checkSubtitleLayers(c2.name)).data || {};
    var occName = (d2.occluders && d2.occluders.length) ? d2.occluders[0].name : "";
    var occIdx = (d2.occluders && d2.occluders.length) ? d2.occluders[0].index : -1;
    cases.push({ label: q("② 遮挡：素材压在字幕上方"),
      chk: { textLayers: d2.textLayers === 2, occluded: d2.occluded === 2,
             occluderName: occName === "后放进去的素材", occluderIndex: occIdx === 1,
             sampleMarked: !!(d2.samples && d2.samples[0] && d2.samples[0].occludedBy) },
      got: { textLayers: d2.textLayers, occluded: d2.occluded, occluders: d2.occluders,
             sample: d2.samples && d2.samples[0] } });
    log("case 2 done");

    /* ---------- ③ 各种"看不见"的成因 ---------- */
    var c3 = app.project.items.addComp("aesub-subcheck-异常", 1920, 1080, 1, 8, 30);
    var blank = c3.layers.addText("   ");            // 纯空白文字
    var off = c3.layers.addText("被关了眼睛的层");
    var clear = c3.layers.addText("不透明度为 0 的层");
    var fine = c3.layers.addText("正常的层");
    try { off.enabled = false; } catch (eA) { log("enabled set err " + eA); }
    try { clear.property("ADBE Transform Group").property("ADBE Opacity").setValue(0); } catch (eB) { log("opacity err " + eB); }
    var d3 = chk(AESub_checkSubtitleLayers(c3.name)).data || {};
    cases.push({ label: q("③ 异常：空文本 / 关掉 / 透明度 0"),
      chk: { textLayers: d3.textLayers === 4, emptyText: d3.emptyText === 1,
             hidden: d3.hidden === 1, transparent: d3.transparent === 1,
             occluded: d3.occluded === 0 },
      got: { textLayers: d3.textLayers, emptyText: d3.emptyText, hidden: d3.hidden,
             transparent: d3.transparent, occluded: d3.occluded } });
    log("case 3 done");

    /* ---------- ④ 遮挡消失：把素材移到最下方 → 报 0 ---------- */
    cover.moveToEnd();      // 移到图层栈末尾（最下）
    var d4 = chk(AESub_checkSubtitleLayers(c2.name)).data || {};
    cases.push({ label: q("④ 遮挡消失：素材移到最下方后"),
      chk: { occluded: d4.occluded === 0 },
      got: { occluded: d4.occluded, textLayers: d4.textLayers } });
    log("case 4 done");

    /* ---------- ⑤ 没有文本层 / 不存在的合成 → 不崩 ---------- */
    var c5 = app.project.items.addComp("aesub-subcheck-无字幕", 1920, 1080, 1, 5, 30);
    c5.layers.addSolid([0.3, 0.3, 0.3], "只有素材", 1920, 1080, 1, 5);
    var d5 = chk(AESub_checkSubtitleLayers(c5.name)).data || {};
    var rBad = chk(AESub_checkSubtitleLayers("不存在的合成名"));
    cases.push({ label: q("⑤ 边界：没有文本层 / 合成名不存在"),
      chk: { noTextZero: d5.textLayers === 0, badCompOkFalse: rBad.ok === false,
             badCompHasMsg: !!rBad.error },
      got: { textLayers: d5.textLayers, badErr: rBad.error } });
    log("case 5 done");

    /* ---------- 清场 ---------- */
    var names = ["aesub-subcheck-干净", "aesub-subcheck-遮挡", "aesub-subcheck-异常",
                 "aesub-subcheck-无字幕"];
    for (i = 0; i < names.length; i++) {
      for (var k = app.project.numItems; k >= 1; k--) {
        var it2 = app.project.item(k);
        if (it2 instanceof CompItem && it2.name === names[i]) { it2.remove(); break; }
      }
    }
    wfile(RESULT, J({ aeVersion: app.version, cases: cases }));
    log("done");
  }

  try { main(); }
  catch (e) {
    log("OUTER: line " + e.line + " :: " + e.message);
    wfile(RESULT, J({ fatal: String(e.message), line: e.line }));
  }
})();
