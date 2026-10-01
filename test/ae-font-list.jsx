/* ============================================================
 * 字体清单取证：把 AE 能枚举到的字体家族完整导成纯文本
 *
 * 为什么用纯文本逐行写：上一版探针把 400 条记录拼成一个字符串写盘时卡死了。
 * 逐行追加写最稳，也方便事后 diff。
 *
 * ExtendScript 无 JSON —— 参数一律手工拼，禁止 JSON.stringify
 * ============================================================ */

var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";
var OUTDIR = "E:/项目文件/agent/ae字幕插件/test/output/";

try { $.evalFile(new File(BRIDGE)); } catch (e) { }

function openOut(name) {
  var f = new File(OUTDIR + name);
  f.encoding = "UTF-8";
  f.open("w");
  return f;
}
function line(f, s) { f.write(s + "\n"); }

/* ---------------- ① 全部家族清单 ---------------- */
var f1 = openOut("fonts-all.txt");
var groups = app.fonts.allFonts;
var cache = AESUB_FONT_CACHE;
if (!cache) cache = AESub_buildFontCache_();

line(f1, "# AE 版本 " + app.version + "  allFonts groups=" + groups.length + "  缓存家族=" + cache.length);

/* ---------------- ② 原始 allFonts 逐 group（不过滤）---------------- */
line(f1, "");
line(f1, "== 原始 allFonts（未经任何过滤）==");
for (var i = 0; i < groups.length; i++) {
  var g = groups[i];
  if (!g || g.length === 0) continue;
  var rep = g[0];
  var famEn = AESub_fontProp_(rep, "familyName");
  var famNat = AESub_fontProp_(rep, "nativeFamilyName");
  var psRep = AESub_fontProp_(rep, "postScriptName");
  var isSub = (rep.isSubstitute === undefined) ? "undef" : String(rep.isSubstitute);
  var cn = /[\u4e00-\u9fa5]/.test(famEn + famNat) ? "中文" : "  ";
  line(f1, i + "\t" + cn + " | " + famEn + " | nat=" + famNat + " | ps=" + psRep +
    " | styles=" + g.length + " | isSub=" + isSub);
}
f1.close();

/* ---------------- ③ 面板实际能搜到的（复刻 searchFonts）---------------- */
var f2 = openOut("fonts-panel-view.txt");
line(f2, "# 面板 searchFonts 实际返回（limit=40，与面板一致）");
line(f2, "");

function dumpSearch(kw) {
  var raw = AESub_searchFonts(kw, 40, false);
  var r = eval("(" + String(raw) + ")");
  line(f2, "== 查询 " + (kw === "" ? "（空）" : "「" + kw + "」") +
    "  → totalFamilies=" + r.data.totalFamilies + " matched=" + r.data.matched +
    " returned=" + r.data.returned + " ==");
  var fs = r.data.families;
  for (var j = 0; j < fs.length; j++) {
    var fam = fs[j];
    var stl = [];
    for (var k = 0; k < fam.styles.length; k++) stl.push(fam.styles[k].ps);
    line(f2, "   " + fam.family + " | nat=" + fam.nativeName + " | " + stl.join(", "));
  }
  line(f2, "");
}

dumpSearch("");
dumpSearch("华文");
dumpSearch("锐字");
dumpSearch("印品");
dumpSearch("南征北战");
dumpSearch("奥运");
dumpSearch("思源");
dumpSearch("黑");
dumpSearch("宋");
dumpSearch("楷");
dumpSearch("方正");
dumpSearch("幼圆");
dumpSearch("隶书");


/* ---------------- ④ 中文家族的 nativeFamilyName 是否为空 ---------------- */
line(f2, "== 缓存里所有含中文的家族（诊断中文名匹配）==");
var noNat = 0;
for (var m = 0; m < cache.length; m++) {
  var e = cache[m];
  if (!/[\u4e00-\u9fa5]/.test(e.family + e.nativeName)) continue;
  if (!e.nativeName) noNat++;
  line(f2, "   family=" + e.family + " | nativeName=" + (e.nativeName || "(空)") +
    " | psRep=" + e.psRep + " | styles=" + e.styles.length);
}
line(f2, "   （nativeName 为空的： " + noNat + " 个）");
f2.close();

/* ---------------- ⑤ 完成标记 ---------------- */
var f3 = openOut("fonts-probe-done.txt");
line(f3, "done families=" + cache.length + " groups=" + groups.length);
f3.close();
