/* ============================================================
 * 图层命名（文字命名）+ 空段过滤 回归验证
 *
 * 要证的六件事：
 *   ① 全是空文本段 → 报错且不建任何层（旧版会留下空白图层 —— 用户报的 bug）
 *   ② 混合段（正常 + 纯空格 + 空串）→ 只建正常层，空段计数进 skipped/skippedEmpty
 *   ③ 同一句话重复出现 → 文字命名 + 重名退让（对对对 / 对对对 2 / 对对对 3）
 *   ④ 超 20 字 → 截断加 …
 *   ⑤ nameMode=seq 回归 → 字幕_001/002/003（老习惯不受影响）
 *   ⑥ 单层模式全空段 → 同样报错
 *
 * ExtendScript 无 JSON —— 参数手工拼；每个用例独立合成，跑完删除。
 * ============================================================ */

var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var OUT = "E:/项目文件/agent/ae字幕插件/test/output/ae-naming-result.json";
var PROG = "E:/项目文件/agent/ae字幕插件/test/output/ae-naming-progress.txt";

function log(s) {
  var f = new File(PROG); f.encoding = "UTF-8";
  if (f.open("a")) { f.write(s + "\n"); f.close(); }
}
function q(s) {
  if (s === null || s === undefined) return '""';
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ") + '"';
}
function jstrarr(a) {
  var o = [], i;
  for (i = 0; i < a.length; i++) o.push(q(a[i]));
  return "[" + o.join(",") + "]";
}
function obj(kv) {
  var o = [], k;
  for (k in kv) o.push(q(k) + ":" + kv[k]);
  return "{" + o.join(",") + "}";
}

/* 空项目保护：-r 启动的工程是空的才继续，绝不碰用户工程 */
if (app.project.file !== null || app.project.numItems > 0) {
  log("ABORT: 项目非空，拒绝运行");
} else {
  try { $.evalFile(new File(BRIDGE)); log("bridge loaded"); }
  catch (e) { log("bridge FAIL: " + (e.message || e)); }

  var cases = [];
  try {   // 顶层兜底：任何未捕获错误落盘（带行号），不再弹窗中断
  var tmpJson = Folder.temp.fsName + "/aesub-naming-test.json";

  /** 写段落 JSON（手工拼，无 JSON.stringify） */
  function writeSegs(segs) {
    var parts = [], i;
    for (i = 0; i < segs.length; i++) {
      parts.push('{"text":' + q(segs[i].text) +
        ',"startMs":' + segs[i].startMs +
        ',"endMs":' + segs[i].endMs + '}');
    }
    var f = new File(tmpJson); f.encoding = "UTF-8";
    if (!f.open("w")) throw new Error("写临时 JSON 失败");
    f.write("[" + parts.join(",") + "]");
    f.close();
  }

  /** 建一个一次性合成 */
  function makeComp(name) {
    return app.project.items.addComp(name, 1920, 1080, 1, 10, 30);
  }
  /** 收集图层名（按图层栈顺序）。带防御日志：AE 对逐层 .name 访问曾报"未定义值"，这里落盘定位 */
  function layerNames(comp) {
    var names = [], i;
    log("ln: numLayers=" + comp.numLayers);
    for (i = 1; i <= comp.numLayers; i++) {
      var L = null;
      try { L = comp.layer(i); } catch (eL) { log("ln: layer(" + i + ") throw " + (eL.message || eL)); continue; }
      var nm = "";
      try { nm = L.name; } catch (eN) { log("ln: layer(" + i + ").name throw " + (eN.message || eN)); }
      log("ln: layer(" + i + ") = " + nm);
      names.push(nm);
    }
    return names;
  }
  /** ExtendScript 里 (""+array).indexOf(含中文参数) 会抛"数字结果无效"，一律用循环比较 */
  function hasName(arr, want) {
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i]) === want) return true;
    }
    return false;
  }
  var BASE_OPTS = '{mode:"layers",fontSize:72,color:[1,1,1],yPercent:0.5,prefix:"字幕",nameMode:';

  /* ---------- ① 全空段 → 报错不建层 ---------- */
  (function () {
    var comp = makeComp("命名测试①全空段");
    var before = comp.numLayers;
    writeSegs([{ text: "", startMs: 1000, endMs: 3000 }, { text: "   ", startMs: 4000, endMs: 6000 }]);
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"text"}') + ')')) + ")");
    var chk = {};
    chk.rejected = r.ok === false;
    chk.noLayerCreated = comp.numLayers === before;
    cases.push(obj({ label: q("① 全空段 → 报错不建层"), chk: obj(chk), error: q(r.error || "") }));
    comp.remove();
    log("case 1 done");
  })();

  /* ---------- ②a 正常段 + seq 模式（回归旧行为：定位崩溃用） ---------- */
  (function () {
    var comp = makeComp("命名测试②a");
    log("case 2a: comp created");
    writeSegs([
      { text: "你好世界啊这是测试", startMs: 500, endMs: 3000 },
      { text: "第二句字幕", startMs: 6500, endMs: 9000 }
    ]);
    log("case 2a: json written, calling create (seq)");
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"seq"}') + ')')) + ")");
    log("case 2a: create returned");
    log("2a: r.ok=" + String(r.ok) + " err=" + String(r.error || "") +
      " created=" + String(r.data ? r.data.created : "null") +
      " skipped=" + String(r.data ? r.data.skipped : "null"));
    log("2a: project.numItems=" + app.project.numItems +
      " comp.numLayers=" + comp.numLayers + " comp.name=" + comp.name);
    var d = r.data || {};
    var chk = {};
    chk.ok = r.ok === true;
    chk.created2 = d.created === 2;
    log("2a: reading layer names");
    var namesA = layerNames(comp);
    log("2a: namesA=" + namesA.join("|"));
    var seqOk = false, si;
    for (si = 0; si < namesA.length; si++) {
      if (String(namesA[si]) === "字幕_001") { seqOk = true; break; }
    }
    chk.seqNames = seqOk;
    log("2a: seqNames done = " + seqOk);
    chk.created2 = d.created === 2;
    chk.ok = r.ok === true;
    log("2a: pushing case");
    cases.push(obj({ label: q("②a 正常段 seq 回归"), chk: obj(chk),
      names: jstrarr(namesA) }));
    log("2a: pushed, before comp.remove");
    comp.remove();
    log("2a: comp removed, done");
  })();

  /* ---------- ②b 正常段 + text 模式 ---------- */
  (function () {
    var comp = makeComp("命名测试②b");
    log("case 2b: comp created");
    writeSegs([
      { text: "你好世界啊这是测试", startMs: 500, endMs: 3000 },
      { text: "第二句字幕", startMs: 6500, endMs: 9000 }
    ]);
    log("case 2b: json written, calling create (text)");
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"text"}') + ')')) + ")");
    log("case 2b: create returned");
    var d = r.data || {};
    var chk = {};
    chk.ok = r.ok === true;
    chk.created2 = d.created === 2;
    var names = layerNames(comp);
    chk.nameHasText1 = hasName(names, "你好世界啊这是测试");
    chk.nameHasText2 = hasName(names, "第二句字幕");
    cases.push(obj({ label: q("②b 正常段文字命名"), chk: obj(chk), names: jstrarr(names) }));
    comp.remove();
    log("case 2b done");
  })();

  /* ---------- ②c 混合段：正常 + 纯空格 + 空串 ---------- */
  (function () {
    var comp = makeComp("命名测试②c");
    log("case 2c: comp created");
    writeSegs([
      { text: "你好世界啊这是测试", startMs: 500, endMs: 3000 },
      { text: "   ", startMs: 3000, endMs: 5000 },
      { text: "", startMs: 5000, endMs: 6500 },
      { text: "第二句字幕", startMs: 6500, endMs: 9000 }
    ]);
    log("case 2c: json written, calling create (text)");
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"text"}') + ')')) + ")");
    log("case 2c: create returned");
    var d = r.data || {};
    var chk = {};
    chk.ok = r.ok === true;
    chk.created2 = d.created === 2;
    chk.skipped2 = d.skipped === 2;
    chk.skippedEmpty2 = d.skippedEmpty === 2;
    chk.layerCount2 = comp.numLayers === 2;
    cases.push(obj({ label: q("②c 混合段 → 空段过滤"), chk: obj(chk),
      created: d.created, skipped: d.skipped, skippedEmpty: d.skippedEmpty,
      names: jstrarr(layerNames(comp)) }));
    comp.remove();
    log("case 2c done");
  })();

  /* ---------- ③ 重复句退让 ---------- */
  (function () {
    var comp = makeComp("命名测试③重复句");
    writeSegs([
      { text: "对对对", startMs: 500, endMs: 2500 },
      { text: "对对对", startMs: 3000, endMs: 5000 },
      { text: "对对对", startMs: 5500, endMs: 7500 }
    ]);
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"text"}') + ')')) + ")");
    var d = r.data || {};
    var names = layerNames(comp).sort();
    var chk = {};
    chk.ok = r.ok === true;
    chk.created3 = d.created === 3;
    chk.hasPlain = hasName(names, "对对对");
    chk.has2 = hasName(names, "对对对 2");
    chk.has3 = hasName(names, "对对对 3");
    cases.push(obj({ label: q("③ 重复句 → 退让 对对对/2/3"), chk: obj(chk), names: jstrarr(names) }));
    comp.remove();
    log("case 3 done");
  })();

  /* ---------- ④ 超 20 字截断 ---------- */
  (function () {
    var comp = makeComp("命名测试④截断");
    var longText = "这是一句特别特别长的字幕内容用来验证图层名截断逻辑是否正确执行完毕";
    writeSegs([{ text: longText, startMs: 500, endMs: 5000 }]);
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"text"}') + ')')) + ")");
    var want = longText.slice(0, 20) + "…";
    var names = layerNames(comp);
    var chk = {};
    chk.ok = r.ok === true;
    chk.truncated = hasName(names, want);
    chk.notFullName = !hasName(names, longText);
    cases.push(obj({ label: q("④ 超 20 字 → 截断加省略号"), chk: obj(chk),
      want: q(want), names: jstrarr(names) }));
    comp.remove();
    log("case 4 done");
  })();

  /* ---------- ⑤ seq 回归：前缀_序号 ---------- */
  (function () {
    var comp = makeComp("命名测试⑤seq回归");
    writeSegs([
      { text: "甲", startMs: 500, endMs: 2500 },
      { text: "乙", startMs: 3000, endMs: 5000 },
      { text: "丙", startMs: 5500, endMs: 7500 }
    ]);
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q(BASE_OPTS + '"seq"}') + ')')) + ")");
    var d = r.data || {};
    var names = layerNames(comp).sort();
    var chk = {};
    chk.ok = r.ok === true;
    chk.created3 = d.created === 3;
    chk.seqNames = hasName(names, "字幕_001") && hasName(names, "字幕_002") && hasName(names, "字幕_003");
    cases.push(obj({ label: q("⑤ seq 模式回归 字幕_001/002/003"), chk: obj(chk), names: jstrarr(names) }));
    comp.remove();
    log("case 5 done");
  })();

  /* ---------- ⑥ 单层模式全空段 → 报错 ---------- */
  (function () {
    var comp = makeComp("命名测试⑥单层全空");
    var before = comp.numLayers;
    writeSegs([{ text: "  ", startMs: 1000, endMs: 3000 }]);
    var r = eval("(" + String(eval('AESub_createSubtitleLayers(' + q(comp.name) + ',' + q(tmpJson) +
      ',' + q('{mode:"single",fontSize:72,color:[1,1,1],yPercent:0.5,prefix:"字幕",nameMode:"text"}') + ')')) + ")");
    var chk = {};
    chk.rejected = r.ok === false;
    chk.noLayerCreated = comp.numLayers === before;
    cases.push(obj({ label: q("⑥ 单层模式全空段 → 报错不建层"), chk: obj(chk), error: q(r.error || "") }));
    comp.remove();
    log("case 6 done");
  })();

  /* ---------- 汇总 ---------- */
  var f = new File(OUT); f.encoding = "UTF-8";
  if (f.open("w")) {
    f.write(obj({
      aeVersion: q(app.version),
      cases: "[" + cases.join(",") + "]"
    }));
    f.close();
  }
  log("done");
  } catch (eOuter) {
    log("OUTER ERROR line=" + (eOuter.line || "?") + " msg=" + (eOuter.message || eOuter));
  }
}
