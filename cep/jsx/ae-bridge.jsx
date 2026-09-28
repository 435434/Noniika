/**
 * ae-bridge.jsx —— Noniika · ExtendScript 桥接层
 * ==========================================================
 * 职责：与 After Effects 交互的两个动作
 *   ① 从合成导出音频（含"直取原素材"快路径 + 渲染降级链）
 *   ④ 按时间戳在合成里创建字幕文本图层
 *
 * 重要约束（均已实测确认，勿随意改动）：
 *   - ExtendScript 是 ES3：不能使用 let/const/箭头函数/模板字符串，且没有原生 JSON
 *   - AE 脚本【无法设置】输出模块的 Format（只读）。必须靠 applyTemplate() 换模板
 *   - 输出模块设置被修改后，OutputModule 对象会失效，必须重新 outputModule(1) 获取
 *   - renderQueue.render() 是同步阻塞的，且会渲染队列中所有 render=true 的项，
 *     因此渲染前必须快照并关闭用户已有队列项，结束后还原
 *   - 所有对外函数统一返回 JSON 字符串（evalScript 只能回传字符串）
 *
 * 所有对外函数命名前缀：AESub_
 */

var AESUB_VERSION = "0.1.0";

/** 能输出音频的 OutputFormat 标签（其余格式只有画面，导不出声音） */
var AESUB_AUDIO_FORMATS = { "QuickTime": 1, "WAV": 1, "AIFF": 1, "MP3": 1 };

/** 各格式对应的文件扩展名 */
var AESUB_EXT_BY_FORMAT = { "QuickTime": "mov", "WAV": "wav", "AIFF": "aif", "MP3": "mp3" };

/** 识别服务可直接接受上传的音频扩展名；其余需先经 ffmpeg 转码 */
var AESUB_DIRECT_UPLOAD_EXTS = { "mp3": 1, "wav": 1, "flac": 1, "m4a": 1 };

/* ============================================================
 * 一、基础工具（JSON 序列化 / 错误包装）
 * ============================================================ */

/** 转义 JSON 字符串（保留中文原样，中文无需转义） */
function AESub_esc_(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32) out += '\\u' + ('000' + code.toString(16)).slice(-4);
    else out += c;
  }
  return out;
}

/** 极简 JSON 序列化器（ExtendScript 无原生 JSON.stringify） */
function AESub_toJSON_(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return '"' + AESub_esc_(v) + '"';
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(AESub_toJSON_(v[i]));
    return "[" + a.join(",") + "]";
  }
  if (t === "object") {
    var p = [];
    for (var k in v) {
      if (v.hasOwnProperty(k)) p.push('"' + AESub_esc_(String(k)) + '":' + AESub_toJSON_(v[k]));
    }
    return "{" + p.join(",") + "}";
  }
  return "null";
}

function AESub_ok_(data) { return AESub_toJSON_({ ok: true, data: data }); }
function AESub_err_(msg) { return AESub_toJSON_({ ok: false, error: String(msg) }); }

/** 把 JSON 文件的绝对路径统一成 File 可用的形式（Windows 反斜杠 → 正斜杠） */
function AESub_normPath_(p) {
  return String(p).replace(/\\/g, "/");
}

/** ES3 没有 String.prototype.trim —— ExtendScript 里一律用这个（踩过：.trim() 直接"函数未定义"） */
function AESub_trim_(s) {
  return String(s).replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

/** 读取 UTF-8 文本文件（注意：必须显式设置 encoding，否则中文会乱码） */
function AESub_readText_(path) {
  var f = new File(AESub_normPath_(path));
  if (!f.exists) throw new Error("文件不存在：" + path);
  f.encoding = "UTF-8";
  if (!f.open("r")) throw new Error("无法读取文件：" + path);
  var txt = f.read();
  f.close();
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.substring(1); // 去 BOM
  return txt;
}

/** 读取并解析 JSON 文件（ExtendScript 用 eval 解析，ES3 对象字面量即为合法 JSON） */
function AESub_readJSON_(path) {
  var txt = AESub_readText_(path);
  if (txt === "") return [];
  return eval("(" + txt + ")");
}

/* ============================================================
 * 二、合成定位与音频体检
 * ============================================================ */

function AESub_findComp_(compName) {
  if (!app.project) throw new Error("没有打开的项目");
  var i, it;
  if (compName) {
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      if (it instanceof CompItem && it.name === compName) return it;
    }
    throw new Error("找不到合成：" + compName);
  }
  // 未指定名称时取当前选中的合成
  var sel = app.project.selection;
  for (i = 0; i < sel.length; i++) {
    if (sel[i] instanceof CompItem) return sel[i];
  }
  throw new Error("请先在项目面板中选中一个合成");
}

/** 该合成是否真的能产出声音 */
function AESub_hasAudio_(comp) {
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L.hasAudio && L.audioEnabled) return true;
  }
  return false;
}

/** 安全读取属性：属性名在当前 AE 版本不存在时返回 null，避免拿到 undefined 造成误判 */
function AESub_readProp_(obj, name) {
  try {
    var v = obj[name];
    if (typeof v === "undefined" || v === null) return null;
    if (typeof v === "number" && !isFinite(v)) return null;
    return v;
  } catch (e) { return null; }
}

/**
 * 判断 stretch 是否处于"未变速"状态。
 * 单位在文档与不同版本间存在「百分比 100 = 正常」与「倍率 1.0 = 正常」两种说法，两者都认。
 */
function AESub_isNormalStretch_(v) {
  if (typeof v !== "number") return true;
  return Math.abs(v - 100) <= 0.01 || Math.abs(v - 1) <= 0.000001;
}

/**
 * 音频体检：判断能否走"直取原素材"快路径（零导出）。
 *
 * 快路径成立的条件（全部满足才算数）：
 *   1. 合成里恰好只有 1 个开启音频的图层
 *   2. 该图层是 AVLayer，且来源是磁盘上的真实文件（不是纯色/占位/合成）
 *   3. 未变速（timeStretch === 1）、未启用时间重映射
 *   4. 未添加任何效果（保守策略：无法可靠区分音频/视频效果，宁可不走快路径）
 *   5. 该图层完整覆盖整个合成（startTime=0、inPoint=0、outPoint >= 合成时长）
 *      —— 这样音频文件的时间轴才与合成时间轴 1:1 对应，字幕无需补偏移
 */
function AESub_analyzeAudio_(comp) {
  var info = {
    compName: comp.name,
    compDuration: comp.duration,
    compWidth: comp.width,
    compHeight: comp.height,
    frameRate: comp.frameRate,
    audioLayerCount: 0,
    directUsable: false,
    sourceFile: null,
    sourceExt: null,
    needFfmpeg: false,
    reason: ""
  };

  var audioLayers = [];
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L.hasAudio && L.audioEnabled) { audioLayers.push(L); info.audioLayerCount++; }
  }

  if (audioLayers.length === 0) { info.reason = "合成里没有开启音频的图层"; return info; }
  if (audioLayers.length > 1) { info.reason = "有 " + audioLayers.length + " 个音频图层，需渲染混合后的音频"; return info; }

  var L = audioLayers[0];
  if (!(L instanceof AVLayer)) { info.reason = "音频不来自普通视频图层"; return info; }
  if (!L.source || !(L.source instanceof FootageItem)) { info.reason = "音频来源不是素材文件"; return info; }
  if (!(L.source.mainSource instanceof FileSource)) { info.reason = "音频来源是纯色/占位符等非文件素材"; return info; }
  // 变速检测。注意：正确属性名是 stretch，不是 timeStretch
  // 实测 AE 25.6 下 L.timeStretch 恒为 undefined，直接用 `!== 1` 会误判成"已变速"。
  var st = AESub_readProp_(L, "stretch");
  if (st === null) st = AESub_readProp_(L, "timeStretch");
  if (st !== null && !AESub_isNormalStretch_(st)) {
    info.reason = "音频图层做了变速（stretch=" + st + "）";
    return info;
  }
  if (L.timeRemapEnabled) { info.reason = "音频图层启用了时间重映射"; return info; }

  // 效果数量 > 0 就放弃快路径（保守）
  try {
    var fx = L.property("ADBE Effect Parade");
    if (fx && fx.numProperties > 0) { info.reason = "音频图层上挂了效果（" + fx.numProperties + " 个）"; return info; }
  } catch (e) { /* 取不到就当作无效果 */ }

  if (L.startTime !== 0 || L.inPoint !== 0) { info.reason = "音频图层未从 0 秒开始，时间轴对不齐"; return info; }
  if (L.outPoint < comp.duration - 0.001) { info.reason = "音频图层没有覆盖整个合成时长"; return info; }

  var srcFile = L.source.mainSource.file;
  if (!srcFile || !srcFile.exists) { info.reason = "找不到音频的原始文件"; return info; }

  var ext = "";
  var nameParts = String(srcFile.name).split(".");
  if (nameParts.length > 1) ext = nameParts[nameParts.length - 1].toLowerCase();

  info.directUsable = true;
  info.sourceFile = srcFile.fsName;
  info.sourceExt = ext;
  info.needFfmpeg = !AESUB_DIRECT_UPLOAD_EXTS[ext]; // 非 mp3/wav/flac/m4a → 需要 ffmpeg 抽音轨
  info.reason = "可直接使用原始素材，无需导出";
  return info;
}

/* ============================================================
 * 三、输出模块模板探测（核心绕行逻辑）
 * ============================================================ */

/**
 * 读取输出模块当前的 Format。
 * Format 虽然【不可写】，但是【可读】—— 这是唯一可靠的校验手段。
 * 每次都必须重新 outputModule(1)：修改设置会让旧对象失效（AE 已知 bug）。
 */
function AESub_getFormat_(item) {
  try {
    var all = item.outputModule(1).getSettings(GetSettingsFormat.STRING);
    if (all && all.Format) return String(all.Format);
  } catch (e) { /* 落到下面的备用路径 */ }
  try {
    var v = item.outputModule(1).getSetting("Format");
    if (typeof v === "string" && v !== "") return v;
  } catch (e2) { }
  return null;
}

/** 写输出模块设置（每次写完都要重新取对象，否则后续读取会拿到失效数据） */
function AESub_set_(item, key, value) {
  try {
    item.outputModule(1).setSetting(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

/** 音频格式优先级：数值越小越优先。AIFF 是纯 PCM 音频容器，比 QuickTime 更干净可靠 */
var AESUB_AUDIO_PRIORITY = { "WAV": 1, "AIFF": 2, "MP3": 3, "QuickTime": 4 };

/** 找不到可用模板时的统一提示 */
var AESUB_TPL_HINT = "请在 AE 中打开【编辑 > 模板 > 输出模块】，新建一个格式为 WAV 或 AIFF 的模板后重试。";

/** 模板 → 格式 映射缓存：同一 AE 会话内只探测一次，避免每次导出都白白试一遍全部模板 */
var AESUB_TPL_MAP = null;

/** 清空模板缓存（用户在 AE 里新建了输出模板后调用） */
function AESub_clearTemplateCache() {
  AESUB_TPL_MAP = null;
  return AESub_ok_({ cleared: true });
}

/**
 * 建立「输出模板 → 实际格式」映射表。
 *
 * 为什么必须实测、绝不能按模板名猜（这是实测踩出来的坑）：
 *   本机名为「无损」的模板对应的其实是 AVI，「使用 Alpha 无损耗」也是 AVI，
 *   名字里带"无损"却完全不是音频格式。模板名与实际格式没有任何可靠对应关系
 *   （中文版还会本地化），唯一靠谱的办法是逐个 applyTemplate() 后用 Format 读回校验。
 */
function AESub_buildTemplateMap_(item) {
  if (AESUB_TPL_MAP) return AESUB_TPL_MAP;

  var names = null;
  try {
    var tpls = item.outputModule(1).templates;
    names = [];
    for (var i = 0; i < tpls.length; i++) names.push(tpls[i]);
  } catch (e) { }
  if (!names || names.length === 0) return null;

  var map = [];
  for (var k = 0; k < names.length; k++) {
    var f = null;
    try {
      item.outputModule(1).applyTemplate(names[k]);
      f = AESub_getFormat_(item);
    } catch (e2) { f = null; }
    map.push({ template: names[k], format: f });
  }
  AESUB_TPL_MAP = map;
  return map;
}

/**
 * 把渲染项切到"能输出音频"的输出模板。
 *
 * 背景：AE 脚本不能设置 Format（官方文档明确其为只读），所以只能靠套用模板。
 * 策略：当前格式已支持音频就直接用；否则按【格式优先级】挑最合适的模板，
 *       而不是按模板名去猜（见 AESub_buildTemplateMap_ 注释说明的坑）。
 */
function AESub_probeAudioTemplate_(item) {
  var fmt = AESub_getFormat_(item);
  if (fmt && AESUB_AUDIO_FORMATS[fmt]) {
    return { ok: true, format: fmt, template: null, switched: false };
  }

  var map = AESub_buildTemplateMap_(item);
  if (!map) {
    return {
      ok: false,
      error: "当前输出格式是「" + fmt + "」，导不出音频；且读取不到任何输出模板。" + AESUB_TPL_HINT
    };
  }

  var best = null;
  for (var i = 0; i < map.length; i++) {
    var f = map[i].format;
    if (!f || !AESUB_AUDIO_FORMATS[f]) continue;
    var pri = AESUB_AUDIO_PRIORITY[f] || 99;
    if (!best || pri < best.pri) best = { pri: pri, template: map[i].template, format: f };
  }

  if (!best) {
    var avail = [];
    for (i = 0; i < map.length; i++) avail.push(map[i].template + "(" + map[i].format + ")");
    return {
      ok: false,
      error: "本机 " + map.length + " 个输出模板里没有一个能输出音频。现有：" +
             avail.join("、") + "。" + AESUB_TPL_HINT
    };
  }

  try { item.outputModule(1).applyTemplate(best.template); } catch (e) { }
  return { ok: true, format: best.format, template: best.template, switched: true };
}

/* ============================================================
 * 四、对外接口 ①：导出音频
 * ============================================================ */

/**
 * 把合成中【指定时间范围】的音频导出到磁盘。
 *
 * 为什么不导出整段合成：合成时长常常远大于有声音的区间（实测遇到 10800 秒的合成里
 * 只有十几秒有人声），按整段导出会产出近 2GB 的静音，既费磁盘又必然撞上云端 200MB 上限。
 * 所以范围由调用方（面板根据选中图层算出）显式传入。
 *
 * 关键不变量：**导出文件的时间 0 秒 == 合成时间 startSec**。
 * 因此字幕时间戳 = 文件内时间 + startSec，这个偏移量由返回值 offsetSec 给出。
 *
 * @param {String} compName   合成名；传空字符串则用当前激活的合成
 * @param {Number} startSec   起始时间（合成时间，秒）
 * @param {Number} endSec     结束时间（合成时间，秒）
 * @param {String} outPathNoExt 输出路径（不含扩展名），扩展名按探测到的格式自动追加
 * @return {String} JSON 字符串
 *        { ok, data:{ file, format, template, offsetSec, durationSec, compDuration, bytes, elapsedSec } }
 */
function AESub_exportAudio(compName, startSec, endSec, outPathNoExt) {
  var t0 = new Date().getTime();
  var rq = null, snapshot = [], ourItem = null, wasDirty = null;

  try {
    if (!app.project) throw new Error("没有打开的项目");
    var comp = AESub_findComp_(compName || "");

    if (!AESub_hasAudio_(comp)) throw new Error("合成「" + comp.name + "」里没有开启音频的图层，无法导出音频");

    rq = app.project.renderQueue;
    try { wasDirty = app.project.dirty; } catch (e) { wasDirty = null; }

    // ---- 1. 快照并关闭用户已有的队列项（否则 render() 会把它们一起渲染掉）----
    var i;
    for (i = 1; i <= rq.numItems; i++) snapshot.push(rq.item(i).render);
    for (i = 1; i <= rq.numItems; i++) rq.item(i).render = false;

    // ---- 2. 计算并对齐要渲染的时间范围 ----
    // 对齐到帧边界：AE 对非整帧的时间点有已知的取整怪异行为（社区实测会差一帧）
    var fr = comp.frameRate > 0 ? comp.frameRate : 24;
    var rStart = Number(startSec);
    var rEnd = Number(endSec);
    if (isNaN(rStart) || rStart < 0) rStart = 0;
    if (isNaN(rEnd) || rEnd <= 0) rEnd = comp.duration;
    rStart = Math.floor(rStart * fr) / fr;
    rEnd = Math.ceil(rEnd * fr) / fr;
    if (rEnd > comp.duration) rEnd = comp.duration;
    if (rEnd - rStart <= 0) {
      throw new Error("要导出的时间范围为空（" + rStart.toFixed(3) + " ~ " + rEnd.toFixed(3) +
        " 秒）。请确认选中的图层在时间线上确实有内容。");
    }

    ourItem = rq.items.add(comp);
    ourItem.render = true;
    ourItem.skipFrames = 0;
    ourItem.timeSpanStart = rStart;
    ourItem.timeSpanDuration = rEnd - rStart;

    // 回读实际生效的范围：AE 可能对时间点做取整，
    // 用回读值当偏移量能自动纠正，而不是盲目相信我传进去的数值。
    var effStart = ourItem.timeSpanStart;
    var effDur = ourItem.timeSpanDuration;
    if (typeof effStart !== "number" || isNaN(effStart)) effStart = rStart;
    if (typeof effDur !== "number" || isNaN(effDur) || effDur <= 0) effDur = rEnd - rStart;

    // ---- 3. 探测可用模板 ----
    var probe = AESub_probeAudioTemplate_(ourItem);
    if (!probe.ok) throw new Error(probe.error);

    // ---- 4. 关掉画面输出、开启音频（这几个键是可写的）----
    AESub_set_(ourItem, "Video Output", false);
    AESub_set_(ourItem, "Output Audio", "On");
    AESub_set_(ourItem, "Audio Sample Rate", 48000);
    AESub_set_(ourItem, "Audio Bit Depth", "16 bit");

    // 改完设置后再确认一次格式没被带跑
    var finalFmt = AESub_getFormat_(ourItem);
    if (!finalFmt || !AESUB_AUDIO_FORMATS[finalFmt]) {
      throw new Error("设置仅音频输出后格式变成了「" + finalFmt + "」，已中止（避免产出无声音的文件）");
    }

    // ---- 5. 指定输出路径 ----
    var ext = AESUB_EXT_BY_FORMAT[finalFmt] || "mov";
    var outFile = new File(AESub_normPath_(outPathNoExt) + "." + ext);
    if (outFile.parent && !outFile.parent.exists) outFile.parent.create();
    if (outFile.exists) outFile.remove();
    ourItem.outputModule(1).file = outFile;

    // ---- 6. 渲染（同步阻塞，AE 界面会短暂卡住；纯音频通常几秒内完成）----
    rq.render();

    if (!outFile.exists) throw new Error("渲染结束但没找到产物：" + outFile.fsName);
    if (outFile.length <= 44) throw new Error("产物文件为空（" + outFile.length + " 字节），可能是合成内没有声音");

    return AESub_ok_({
      file: outFile.fsName,
      format: finalFmt,
      template: probe.template,
      ext: ext,
      // offsetSec 是字幕时间戳唯一需要补的偏移量：文件 0 秒对应合成 offsetSec 秒
      offsetSec: effStart,
      durationSec: effDur,
      compDuration: comp.duration,
      requestedStart: rStart,
      requestedDuration: rEnd - rStart,
      alignDriftSec: Math.round((effStart - rStart) * 10000) / 10000,
      bytes: outFile.length,
      elapsedSec: Math.round((new Date().getTime() - t0) / 100) / 10
    });

  } catch (err) {
    return AESub_err_(err.message || err.toString());
  } finally {
    // ---- 7. 无论成败，清理队列并还原用户状态 ----
    try { if (ourItem) ourItem.remove(); } catch (e1) { }
    try {
      if (rq) for (var j = 0; j < snapshot.length; j++) rq.item(j + 1).render = snapshot[j];
    } catch (e2) { }
    try { if (wasDirty !== null) app.project.dirty = wasDirty; } catch (e3) { }
  }
}

/* ============================================================
 * 五、对外接口 ②：创建字幕图层
 * ============================================================ */

/* ------------------------------------------------------------
 * 字体检索与拾取（AE 24.0+ 提供 app.fonts 接口）
 * ------------------------------------------------------------ */

/**
 * 安全读一个字体属性。
 * Font 对象是"软引用"——字体代理被移除后访问属性会**抛异常**，
 * 替代字体（isSubstitute）的引用更是不保证可读，所以一律包起来。
 */
function AESub_fontProp_(f, name) {
  try {
    var v = f[name];
    if (v === undefined || v === null) return "";
    return String(v);
  } catch (e) { return ""; }
}

/** 判断字体条目是不是"替代字体"。读不到时按不可用处理（宁可不显示） */
function AESub_fontIsSub_(f) {
  try { return f.isSubstitute === true; } catch (e) { return true; }
}

/** 常见中文字体的特征词：空查询时用它们挑出"值得优先展示"的字体 */
var AESUB_CJK_FONT_HINTS = new RegExp(
  "微软雅黑|苹方|黑体|宋体|楷体|仿宋|思源|等线|幼圆|隶书|方正|汉仪|华文|新宋|中易|" +
  "Microsoft ?YaHei|SimHei|SimSun|SimKai|FangSong|PingFang|Source ?Han|Noto ?Sans ?(SC|CJK)|" +
  "Hiragino|Yu ?Gothic|Meiryo|Malgun|SourceHan|Alibaba|HarmonyOS|MiSans",
  "i"
);

/**
 * 字体家族缓存。
 *
 * 为什么要缓存：`app.fonts.allFonts` 每次都返回上千个 Font 对象，
 * 而 Font 对象的属性访问要跨 AE 内部代理，在 ExtendScript 里同步遍历很慢。
 * 搜索框是"边打字边查"的，如果每次按键都重扫一遍，面板会明显卡顿。
 * 所以第一次调用时把家族列表摊平成普通数组存起来，之后只在内存里过滤。
 */
var AESUB_FONT_CACHE = null;

/** 缓存构建时刻（毫秒）。用来判断"缓存可能过旧、漏了刚装的字体" */
var AESUB_FONT_CACHE_AT = 0;

/** 低于这个家族数就认为缓存不可信。正常机器（含系统字体）至少几十个家族 */
var AESUB_FONT_MIN_SANE = 20;

/** 缓存被认为是"旧"的阈值（毫秒）。命中 0 时会拿它决定要不要重建一次 */
var AESUB_FONT_STALE_MS = 60000;

function AESub_nowMs_() { return (new Date()).getTime(); }

/**
 * 摊平并缓存字体家族列表。
 *
 * ⚠ 这里有一条**必须守住的约束**（踩过大坑，现象极隐蔽）：
 *   只有拿到"看起来完整"的结果才允许写缓存。
 *
 * 为什么：AE 刚启动（或字体服务尚未就绪）时 `app.fonts.allFonts` 可能返回**空数组**，
 * 也可能直接抛异常。旧实现把空数组存进了 AESUB_FONT_CACHE，
 * 而"要不要重建"的判断是 `AESUB_FONT_CACHE === null` —— 空数组不是 null，
 * 于是这个残缺缓存被**永久固化**，面板再也搜不到系统里明明装着的字体，
 * 只能重启 AE 才恢复。
 *
 * 所以：拿不到 / 空 / 异常 → 一律返回 null 且**不写缓存**，留待下次重建。
 */
function AESub_buildFontCache_() {
  var groups;
  try {
    groups = app.fonts && app.fonts.allFonts;
  } catch (eGroups) {
    return null;                       // 字体服务没就绪：不写缓存，下次再来
  }
  if (!groups || !groups.length) return null;

  var list = [];

  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g || g.length === 0) continue;
    var rep = g[0];
    if (!rep || AESub_fontIsSub_(rep)) continue;

    var famEn = AESub_fontProp_(rep, "familyName");
    var famNat = AESub_fontProp_(rep, "nativeFamilyName");
    if (!famEn && !famNat) continue;

    // 同一家族内的样式（上限 8 个，避免某个家族有 20 个字重把列表撑爆）
    var styles = [];
    for (var k = 0; k < g.length && styles.length < 8; k++) {
      var f = g[k];
      if (!f || AESub_fontIsSub_(f)) continue;
      var ps = AESub_fontProp_(f, "postScriptName");
      if (!ps) continue;
      styles.push({
        style: AESub_fontProp_(f, "styleName"),
        nativeStyle: AESub_fontProp_(f, "nativeStyleName"),
        ps: ps
      });
    }
    if (styles.length === 0) continue;

    list.push({
      family: famEn,
      nativeName: famNat,
      styles: styles,
      // 下面两个只用于搜索，不对外输出
      hay: (famEn + " " + famNat).toLowerCase(),
      psRep: AESub_fontProp_(rep, "postScriptName").toLowerCase()
    });
  }

  // 同样：构建出来是空也不写缓存（说明这一轮枚举不出东西，不能当作既定事实）
  if (!list.length) return null;

  AESUB_FONT_CACHE = list;
  AESUB_FONT_CACHE_AT = AESub_nowMs_();
  return list;
}

/**
 * 按关键词搜索字体家族（在 ExtendScript 侧过滤，只回传命中的少量结果）。
 *
 * 为什么不把 app.fonts.allFonts 整个传给面板：
 *   系统字体常有上千个家族，序列化成 JSON 有好几百 KB，
 *   经 evalScript 传输既慢又可能被截断。搜索式接口每次只回几十条，稳定得多。
 *
 * @param {String} query 关键词（英文家族名 / 中文名 / PostScript 名都能匹配）；空字符串表示"给我常用的"
 * @param {Number} limit 最多返回多少个家族，默认 40，上限 200
 * @param {Boolean} refresh 传 true 强制重建缓存（用户中途装了新字体时用）
 * @return {String} JSON 字符串
 */
function AESub_searchFonts(query, limit, refresh) {
  try {
    if (!app.fonts || !app.fonts.allFonts) {
      return AESub_ok_({
        available: false,
        families: [],
        hint: "当前 AE 版本没有字体列表接口（需要 AE 24.0 及以上）。" +
              "可以改成：先在 AE 里手动给一个字幕图层调好字体，再用「拾取」按钮读过来。"
      });
    }

    var lim = Number(limit);
    if (isNaN(lim) || lim <= 0) lim = 40;
    // 上限从 200 放到 4000：面板做「拼音搜索」时要一次拿全清单（在面板侧过滤），
    // 字体多的机器上 200 会被截断，拼音就搜不全了。正常搜索仍只取 120 个。
    if (lim > 4000) lim = 4000;

    var q = (query === undefined || query === null) ? "" : String(query);
    q = q.replace(/^\s+|\s+$/g, "").toLowerCase();

    // 最近使用的家族名：只用来排序，不做过滤
    var mruMap = {};
    try {
      var mru = app.fonts.mruFontFamilyList || [];
      for (var m = 0; m < mru.length; m++) {
        mruMap[String(mru[m]).toLowerCase()] = m;
      }
    } catch (eMru) { /* 24.6 以下没有这个属性，忽略 */ }

    // ---- 取缓存：不完整就重建（三层自愈，任何一层都不允许留下残缺缓存）----
    var cacheState = "hit";
    var cache = AESUB_FONT_CACHE;
    if (refresh === true || cache === null || !cache.length) {
      cache = AESub_buildFontCache_();
      cacheState = "rebuilt";
    } else if (cache.length < AESUB_FONT_MIN_SANE) {
      // 家族数少得离谱 → 多半是上一次在"字体服务未就绪"时建起来的，重建一次
      var again = AESub_buildFontCache_();
      if (again && again.length > cache.length) { cache = again; cacheState = "rebuilt-small"; }
    }

    if (!cache || !cache.length) {
      // 实在拿不到：如实告诉面板"还没准备好"，并给出可操作的替代路径
      return AESub_ok_({
        available: true,
        ready: false,
        families: [],
        totalFamilies: 0,
        matched: 0,
        returned: 0,
        query: q,
        cacheState: cacheState,
        note: "AE 的字体列表还没准备好（刚启动 AE 后很常见，字体服务是异步加载的）。" +
              "等几秒点一次「刷新字体列表」即可；也可以先给任意文本图层设好字体，再用「拾取」读过来。"
      });
    }

    var cacheAgeSec = AESUB_FONT_CACHE_AT
      ? Math.round((AESub_nowMs_() - AESUB_FONT_CACHE_AT) / 1000)
      : -1;

    /** 在给定缓存上跑一遍评分过滤（抽成函数是为了"命中 0 时能换新缓存重跑"） */
    function pick(list) {
      var hs = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        var famEn = e.family;
        var famNat = e.nativeName;
        var mruIdx = mruMap[famEn.toLowerCase()];
        var score = -1;

        if (q === "") {
          // 空查询：最近使用的排最前 → 常见中文字体 → 其余按序补足
          // （旧版把"其余"直接丢掉，只回 28 个，用户装的字体根本看不到）
          if (mruIdx !== undefined) score = mruIdx;
          else if (AESUB_CJK_FONT_HINTS.test(famEn + " " + famNat)) score = 100;
          else score = 200;
        } else if (e.hay.indexOf(q) >= 0 || e.psRep.indexOf(q) >= 0) {
          // 命中的排前面；"以关键词开头"的再靠前；最近用过的排最前
          score = (e.hay.indexOf(q) === 0 || e.psRep.indexOf(q) === 0) ? 0 : 1;
          if (mruIdx !== undefined) score = -1 - (1 - Math.min(mruIdx, 99) / 100);
        }
        if (score < 0) continue;
        hs.push({ score: score, ref: e });
      }
      hs.sort(function (a, b) { return a.score - b.score; });
      return hs;
    }

    var hits = pick(cache);

    // 命中 0 且缓存不新 → 可能用户在 AE 运行期间装了字体，重建一次再搜
    if (q !== "" && hits.length === 0 && (cacheAgeSec < 0 || cacheAgeSec * 1000 > AESUB_FONT_STALE_MS)) {
      var fresh = AESub_buildFontCache_();
      if (fresh && fresh.length) {
        cache = fresh;
        cacheAgeSec = 0;
        cacheState = "rebuilt-on-miss";
        hits = pick(cache);
      }
    }

    var out = [];
    for (var n = 0; n < hits.length && out.length < lim; n++) {
      var r = hits[n].ref;
      // ⚠ 字段名必须叫 nativeName（缓存里就是这个名字）。
      //    旧代码写的是 r.native —— 不存在的字段 → 中文家族名永远是 null，
      //    面板只能拿英文名显示，用户搜到了也认不出是自己的字体。
      out.push({ family: r.family, nativeName: r.nativeName, styles: r.styles });
    }

    return AESub_ok_({
      available: true,
      ready: true,
      totalFamilies: cache.length,
      matched: hits.length,
      returned: out.length,
      query: q,
      cacheState: cacheState,
      cacheAgeSec: cacheAgeSec,
      families: out
    });

  } catch (err) {
    return AESub_err_("读取字体列表失败：" + (err.message || err.toString()));
  }
}

/**
 * 从时间线上选中的文本图层里，把字体/字号/颜色读出来。
 * 这是最省事的用法：用户只要在时间线上点一下自己惯用的字幕层即可。
 */
function AESub_pickTextStyleFromSelection() {
  try {
    if (!app.project) throw new Error("没有打开的项目");
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) throw new Error("请先双击进入一个合成的时间线");

    var sel = comp.selectedLayers;
    if (!sel || sel.length === 0) throw new Error("请先在时间线上选中一个文本图层");

    var L = sel[0];
    if (!(L instanceof TextLayer)) {
      throw new Error("选中的图层「" + L.name + "」不是文本图层，无法拾取字体");
    }

    var textProp = L.property("ADBE Text Properties").property("ADBE Text Document");
    var td = textProp.value;

    var out = {
      layerName: L.name,
      font: "", family: "", style: "",
      fontSize: null, color: null, tracking: null
    };
    try { out.font = String(td.font || ""); } catch (e1) { }
    try { out.family = String(td.fontFamily || ""); } catch (e2) { }
    try { out.style = String(td.fontStyle || ""); } catch (e3) { }
    try { out.fontSize = Number(td.fontSize); } catch (e4) { }
    try { if (td.applyFill) { var c = td.fillColor; out.color = [c[0], c[1], c[2]]; } } catch (e5) { }
    try { out.tracking = Number(td.tracking); } catch (e6) { }

    if (!out.font) throw new Error("读不到这个文本图层的字体（可能不是文字图层）");
    return AESub_ok_(out);

  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

/** 按 PostScript 名取 Font 对象；取不到返回 null（AE 24.0 以下没有这个接口） */
function AESub_resolveFont_(psName) {
  try {
    if (!app.fonts || !app.fonts.getFontsByPostScriptName) return null;
    var list = app.fonts.getFontsByPostScriptName(String(psName));
    if (list && list.length > 0) return list[0];
  } catch (e) { }
  return null;
}

/**
 * 给文本图层套用样式。opts 里没给的项目一律不动，避免把 AE 默认字体改坏。
 *
 * 字体这里有个必须防的坑：**AE 找不到指定字体时不会报错，而是静默替换成替代字体**。
 * 所以写完一定要回读校验，把"想要的 vs 实际生效的"如实报给用户。
 *
 * @return {Object} { fontRequested, fontApplied, fontNote }
 */
function AESub_styleText_(layer, opts, comp) {
  var status = { fontRequested: "", fontApplied: "", fontNote: "" };

  var textProp;
  try { textProp = layer.property("ADBE Text Properties").property("ADBE Text Document"); }
  catch (e) { return status; }

  var td = textProp.value;

  // 字体：优先 fontObject（精确），拿不到再退回 font 字符串
  var wanted = opts.fontPostScriptName || opts.font || "";
  if (wanted) {
    status.fontRequested = wanted;
    var applied = false;
    var fobj = AESub_resolveFont_(wanted);
    if (fobj) {
      try { td.fontObject = fobj; applied = true; } catch (eF1) { applied = false; }
    }
    if (!applied) {
      try { td.font = wanted; applied = true; } catch (eF2) { }
    }
    if (!applied) {
      status.fontNote = "字体名无效，已保持 AE 默认字体：" + wanted;
    } else {
      var readBack = "";
      try { readBack = String(td.font || ""); } catch (eF3) { }
      status.fontApplied = readBack || wanted;
      if (readBack && readBack !== wanted) {
        status.fontNote = "字体被 AE 替换：想要「" + wanted + "」，实际生效「" + readBack + "」" +
                          "（可能是该字体未安装或名称已变化）";
      }
    }
  }

  if (opts.fontSize) td.fontSize = opts.fontSize;
  if (opts.color) { td.applyFill = true; td.fillColor = opts.color; }

  // 段落居中：多行字幕每行都对齐到中线，否则两行长短不一时看着是歪的
  if (opts.justification !== undefined) {
    try { td.justification = opts.justification; } catch (eJ0) { }
  } else {
    try { td.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (eJ1) { }
  }

  td.applyStroke = false;
  textProp.setValue(td);

  // 注意：居中**不在这里做**。动画预设可能给"位置"加关键帧，
  // 那么"谁说了算"必须等预设应用完之后才能决定，所以交给调用方处理。
  return status;
}

/**
 * 找出图层上**最早的一个关键帧时间**（没有关键帧就返回 null）。
 *
 * 为什么要它：套预设后要把整段动画平移到本句起点，而 AE 是把预设的关键帧写在
 * **当前时间（CTI）**上的 —— 早先代码假设"预设一定从 0 秒开始"、直接平移 shift，
 * 播放头不在 0 时就会**平移过头**，动画窗口整个落到句子之外。
 * 对"范围选择器 + 不透明度"这类预设（打字机/飞入），后果就是**整句文字全透明**：
 * 图层不透明度还是 100%、文字内容也在，就是看不见（实测踩过）。
 *
 * 正确做法：拿真实最早关键帧算偏移 —— 不管 AE 把动画写在哪，都能对齐到目标时间。
 */
function AESub_firstKeyTime_(group, budget) {
  var best = null;
  if (!group || !budget || budget.left <= 0) return null;
  budget.left--;
  var n = 0;
  try { n = group.numProperties; } catch (e) { return null; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e2) { continue; }
    if (!p) continue;
    var nk = 0;
    try { nk = p.numKeys; } catch (e3) { nk = 0; }
    if (nk && nk > 0) {
      var t = null;
      try { t = p.keyTime(1); } catch (e4) { t = null; }
      if (t !== null && (best === null || t < best)) best = t;
    } else {
      var sub = AESub_firstKeyTime_(p, budget);
      if (sub !== null && (best === null || sub < best)) best = sub;
    }
  }
  return best;
}

/**
 * 把动画预设应用到指定图层。
 *
 * ⚠ 最反直觉的一点：`applyPreset` 作用的是**当前选中的图层**，
 *   不是你调用它的那个图层对象。所以逐个给几百个字幕层套预设时，
 *   必须先把选中状态收拾干净（全不选 → 只选中目标层），
 *   否则预设会全打到同一批层上，甚至凭空多出一个纯色层。
 */
function AESub_applyPreset_(comp, layer, presetFile) {
  for (var i = 1; i <= comp.numLayers; i++) {
    try { comp.layer(i).selected = false; } catch (e) { }
  }
  try { layer.selected = true; } catch (e2) { }
  layer.applyPreset(presetFile);
  try { layer.selected = false; } catch (e3) { }
}

/** 位置属性是否被加了关键帧（带位移动画的预设会，此时不能再强制居中） */
function AESub_positionIsKeyed_(layer) {
  try {
    var pos = layer.property("ADBE Transform Group").property("ADBE Position");
    return !!(pos && pos.numKeys > 0);
  } catch (e) { return false; }
}

/**
 * ExtendScript 的 `File.name` 遇到非 ASCII 文件名会返回**百分号编码**
 * （"下雨字符入.ffx" → "%E4%B8%8B%E9%9B%A8...ffx"），直接显示给用户就是乱码。
 * 这里解回可读名字；解不开就原样返回，绝不因此抛错。
 */
function AESub_readableName_(f) {
  var n = "";
  try { n = String(f.name || ""); } catch (e) { return ""; }
  try { return decodeURIComponent(n); } catch (e2) { }
  try { return decodeURI(n); } catch (e3) { }
  return n;
}

/**
 * 这一句要不要**完全跳过预设**？
 *
 * 背景：预设动画的长度是固定的（例如 2 秒），而每句字幕长短差很多。
 * 句子比动画还短时，无论怎么压缩都只能"闪一下"或"只演半个动画" ——
 * 与其勉强演，不如干脆不套预设：这正是这个开关的用途（面板上「短句不加动画预设」）。
 *
 * 判据（三个条件同时成立才跳过）：
 *   ① 开关打开
 *   ② 句子短于最小动画时长（默认 0.6 秒）
 *   ③ 预设动画本身比句子还长（否则动画能装下，没必要跳）
 *
 * 抽成独立函数是为了能在沙箱里直接测 —— 不必启动 AE。
 *
 * @param {Number} dur      这句的时长（秒）
 * @param {Number} span     预设动画的跨度（秒）；null/undefined 表示量不到
 * @param {Number} minSec   最小动画时长阈值（秒）
 * @param {Boolean} enabled 开关
 * @returns {Boolean}
 */
function AESub_shouldSkipPreset_(dur, span, minSec, enabled) {
  if (!enabled) return false;
  var d = Number(dur);
  if (!(d > 0)) return false;
  if (span === null || span === undefined) return false;
  var sp = Number(span);
  if (!(sp > 0.01)) return false;
  return (d < Number(minSec)) && (sp > d);
}

/**
 * 找出图层上关键帧的**时间范围**（最早与最晚，没有关键帧返回 null）。
 * 用途：把整段预设动画"铺满这一句"之前，先量出动画本身有多长。
 */
function AESub_keyTimeRange_(group, budget) {
  if (!group || !budget || budget.left <= 0) return null;
  budget.left--;
  var out = null;
  var n = 0;
  try { n = group.numProperties; } catch (e) { return null; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e2) { continue; }
    if (!p) continue;
    var nk = 0;
    try { nk = p.numKeys; } catch (e3) { nk = 0; }
    var got = null;
    if (nk && nk > 0) {
      try { got = { min: p.keyTime(1), max: p.keyTime(nk) }; } catch (e4) { got = null; }
    } else {
      got = AESub_keyTimeRange_(p, budget);
    }
    if (got) {
      if (!out) out = { min: got.min, max: got.max };
      else {
        if (got.min < out.min) out.min = got.min;
        if (got.max > out.max) out.max = got.max;
      }
    }
  }
  return out;
}

/**
 * 把单个属性上的关键帧时间**线性重映射**（值本身不变）：
 * 源区间 [srcMin, srcMax] → 目标区间 [dstMin, dstMax]。
 * 用来把预设动画铺满整句 —— 入场的结束、出场的开始都跟着句子时长走，
 * 这样才不会出现"句子比动画长 → 出场演完还剩一大截"或"动画演到一半图层就结束"。
 */
function AESub_scalePropertyKeys_(prop, srcMin, srcMax, dstMin, dstMax) {
  if (!prop || !prop.numKeys) return 0;
  var span = srcMax - srcMin;
  if (!(span > 0.0001)) return 0;
  var times = [], values = [], i;
  for (i = 1; i <= prop.numKeys; i++) {
    try { times.push(prop.keyTime(i)); values.push(prop.keyValue(i)); } catch (e) { return 0; }
  }
  for (i = prop.numKeys; i >= 1; i--) {
    try { prop.removeKey(i); } catch (e2) { return 0; }
  }
  var k = (dstMax - dstMin) / span;
  var n = 0;
  for (i = 0; i < times.length; i++) {
    try { prop.setValueAtTime(dstMin + (times[i] - srcMin) * k, values[i]); n++; } catch (e3) { }
  }
  return n;
}

/** 递归把图层上所有关键帧做同样的线性重映射 */
function AESub_scaleAllKeys_(group, srcMin, srcMax, dstMin, dstMax, budget) {
  var moved = 0;
  if (!group || !budget || budget.left <= 0) return 0;
  budget.left--;
  var n = 0;
  try { n = group.numProperties; } catch (e) { return 0; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = group.property(i); } catch (e2) { continue; }
    if (!p) continue;
    var nk = 0;
    try { nk = p.numKeys; } catch (e3) { nk = 0; }
    if (nk && nk > 0) moved += AESub_scalePropertyKeys_(p, srcMin, srcMax, dstMin, dstMax);
    else if (p.numProperties) moved += AESub_scaleAllKeys_(p, srcMin, srcMax, dstMin, dstMax, budget);
  }
  return moved;
}


/** 把单个属性上的所有关键帧整体平移（按时间先后写回，避免顺序错乱） */
function AESub_shiftPropertyKeys_(prop, shift) {
  if (!prop || !prop.numKeys || !shift) return 0;
  var times = [], values = [], i;
  for (i = 1; i <= prop.numKeys; i++) {
    try { times.push(prop.keyTime(i)); values.push(prop.keyValue(i)); } catch (e) { return 0; }
  }
  for (i = prop.numKeys; i >= 1; i--) {
    try { prop.removeKey(i); } catch (e2) { return 0; }
  }
  var n = 0;
  for (i = 0; i < times.length; i++) {
    try { prop.setValueAtTime(times[i] + shift, values[i]); n++; } catch (e3) { }
  }
  return n;
}

/**
 * 递归平移图层上的所有关键帧。
 *
 * 为什么需要：AE 的预设把关键帧按它自己的时间轴写进去（通常从 0 秒开始）。
 * 而"每句一层"模式下，字幕_005 可能 12 秒才出场 —— 不平移的话，
 * 它的入场动画全落在 0~1 秒（出场之前），看起来就是"动画没生效"。
 */
function AESub_shiftAllKeys_(propGroup, shift, budget) {
  var moved = 0;
  if (!propGroup || budget.left <= 0) return 0;
  budget.left--;
  var n = 0;
  try { n = propGroup.numProperties; } catch (e) { return 0; }
  for (var i = 1; i <= n; i++) {
    var p = null;
    try { p = propGroup.property(i); } catch (e2) { continue; }
    if (!p) continue;
    if (p.numKeys) {
      moved += AESub_shiftPropertyKeys_(p, shift);
    } else if (p.numProperties) {
      moved += AESub_shiftAllKeys_(p, shift, budget);
    }
  }
  return moved;
}

/**
 * 把文本图层的锚点搬到"文本块的中心"，再把 Position 摆到画面中线 —— 这才是真的居中。
 *
 * 为什么不能只设 Position：
 *   `addText` 生成的图层，**锚点落在哪儿由 AE 内部决定**（不同文本内容还是动态的）。
 *   单纯设 Position，只是把那个锚点挪到目标坐标，文本块本身很可能是偏的。
 *   所以先用 `sourceRectAtTime` 量出文本块的包围盒，把锚点移到包围盒中心，
 *   再把 Position 设到画面中线。这样无论文本多长多短、几行，落点都是正中央。
 *
 * 任何一步取不到数据都**退化成只设 Position**，绝不因为定位失败而中断建图层。
 *
 * @param {Object} opts 支持 yPercent（0.5 = 画面正中央，默认值）
 */
function AESub_centerLayer_(layer, comp, opts) {
  var yPct = (opts && opts.yPercent !== undefined) ? opts.yPercent : 0.5;
  var targetX = comp.width / 2;
  var targetY = comp.height * yPct;

  var pos = null, anc = null;
  try {
    var tg = layer.property("ADBE Transform Group");
    pos = tg.property("ADBE Position");
    anc = tg.property("ADBE Anchor Point");
  } catch (e) { return; }

  // 量包围盒。优先用图层自己的入点：单图层+关键帧模式下，0 秒处可能还是空文本。
  var rect = null;
  var probes = [];
  try { probes.push(layer.inPoint); } catch (eT) { }
  probes.push(0);
  for (var i = 0; i < probes.length && !rect; i++) {
    try {
      var r = layer.sourceRectAtTime(probes[i], false);
      if (r && r.width > 0 && r.height > 0) rect = r;
    } catch (eR) { }
  }

  if (rect && anc) {
    try { anc.setValue([rect.left + rect.width / 2, rect.top + rect.height / 2]); } catch (eA) { }
  }
  if (pos) {
    try { pos.setValue([targetX, targetY]); } catch (eP) { }
  }
}

/**
 * 按 JSON 里的时间戳创建字幕文本图层。
 *
 * @param {String} compName 合成名；空字符串则用当前选中的合成
 * @param {String} jsonPath 字幕 JSON 路径，格式：[{text, startMs, endMs}, ...]
 * @param {String} optsJson 可选，JSON 字符串，支持：
 *        { mode:"layers"|"single", fontSize:72, fontPostScriptName:"字体PostScript名",
 *          color:[1,1,1], yPercent:0.5, prefix:"字幕", presetPath:"动画预设.ffx 的绝对路径" }
 *        yPercent 是垂直位置（0.5 = 画面正中央），面板固定传 0.5。
 *        presetPath 给了就套用该预设；若预设带位移动画（位置被加关键帧），
 *        该层不再强制居中，落点由预设决定，并在 presetNote 里说明。
 * @return {String} JSON 字符串
 */
function AESub_createSubtitleLayers(compName, jsonPath, optsJson) {
  try {
    var comp = AESub_findComp_(compName || "");
    var segs = AESub_readJSON_(jsonPath);
    if (!(segs instanceof Array)) throw new Error("字幕 JSON 格式不对，应为数组");
    if (segs.length === 0) throw new Error("字幕 JSON 是空的（可能是音频里没识别到人声）");

    var opts = optsJson ? eval("(" + optsJson + ")") : {};
    var mode = opts.mode || "layers";
    var prefix = opts.prefix || "字幕";
    var created = 0, skipped = 0;
    var fontNote = "", fontApplied = "";
    var presetNote = "", presetApplied = "";
    var presetKeyedCount = 0, shiftedKeys = 0;
    var presetFirstKey = null, presetShiftBy = 0, presetShiftNote = "";
    var presetAnimMode = null, scaledLayers = 0, staticLayers = 0, scaledKeys = 0;
    var presetSpan = null, presetSkippedShort = 0, presetSkipNote = "";
    var PRESET_MIN_ANIM_SEC = 0.6;   // 句子短于这个值且动画比它长 → 改为静止显示（不演动画）

    // ---- 预设文件先验存在性，免得每一层都白试一次 ----
    var presetFile = null;
    if (opts.presetPath) {
      try {
        var pf = new File(String(opts.presetPath));
        if (pf.exists) presetFile = pf;
        else presetNote = "预设文件不存在：" + opts.presetPath;
      } catch (eP) {
        presetNote = "预设路径无法读取：" + opts.presetPath;
      }
    }

    /**
     * 每层收尾：套预设 → 平移关键帧 → 决定要不要强制居中。
     * 用函数表达式而不是在 try 块里声明函数 —— ES3 下块级函数声明不可靠。
     */
    var finishLayer = function (layer, startT, endT, doShift) {
      var keyed = false;

      // 短句：按设置**完全不套预设** —— 图层留着干净的身子（没有多余的关键帧与动画器），
      // 直接居中显示到句尾。判定用探测层量出的 presetSpan（见上面）。
      if (AESub_shouldSkipPreset_(endT - startT, presetSpan, PRESET_MIN_ANIM_SEC,
                                  opts.skipPresetOnShort)) {
        presetSkippedShort++;
        presetAnimMode = "skip";
        if (presetSkipNote === "") {
          presetSkipNote = "本句 " + (Math.round((endT - startT) * 100) / 100) +
            " 秒、比预设动画（" + (Math.round(presetSpan * 100) / 100) +
            " 秒）还短 → 按设置不套预设，静止显示";
        }
        AESub_centerLayer_(layer, comp, opts);
        return false;
      }

      if (presetFile) {
        try {
          AESub_applyPreset_(comp, layer, presetFile);
          presetApplied = AESub_readableName_(presetFile);

          // ⚠ 两道坑都在这里：
          //   ① 预设关键帧的落点由 AE 决定（写在当前时间 CTI 上）→ 不能假设"从 0 开始"，
          //      否则播放头不在 0 时平移过头，动画跑到句子之外（范围选择器类预设 = 整句透明）。
          //   ② 动画本身的长度是固定的，而每句长短不同 → 只对齐起点会让"出场"落在句子中间
          //      （说话没完字幕先没）或让动画被句子末尾截断（动画只演一半）。
          //   所以这里量出动画的真实时间范围，再按下面的策略处理。
          var rng = AESub_keyTimeRange_(layer, { left: 600 });
          presetFirstKey = rng ? rng.min : -1;
          var dur = endT - startT;

          if (rng && doShift && dur > 0.01) {
            var span = rng.max - rng.min;

            if (dur < PRESET_MIN_ANIM_SEC && span > dur) {
              // 句子太短、而动画比句子还长 → 不做动画：把整段动画挪到句子之前，
              // 这样整句都停在动画的"最终状态"（对入场/打字机类预设就是完全可见），
              // 避免"闪一下"或"只演半个动画"。
              var dStatic = (startT - 0.05) - rng.max;
              if (Math.abs(dStatic) > 0.0005) {
                shiftedKeys += AESub_shiftAllKeys_(layer, dStatic, { left: 600 });
                presetShiftBy = dStatic;
              }
              presetAnimMode = "static";
              staticLayers++;
              if (presetShiftNote === "") {
                presetShiftNote = "本句只有 " + (Math.round(dur * 100) / 100) +
                  " 秒、比预设动画（" + (Math.round(span * 100) / 100) +
                  " 秒）还短 → 改为静止显示（不演动画）";
              }
            } else if (span > 0.01) {
              // 把动画铺满整句：入场结束、出场开始都跟着句子走
              var moved = AESub_scaleAllKeys_(layer, rng.min, rng.max, startT, endT, { left: 600 });
              if (moved > 0) {
                scaledKeys += moved;
                scaledLayers++;
                presetAnimMode = "scale";
                if (presetShiftNote === "") {
                  presetShiftNote = "预设动画跨度 " + (Math.round(span * 100) / 100) +
                    " 秒 → 已铺满本句 " + (Math.round(dur * 100) / 100) + " 秒（" +
                    (span > dur ? "压缩" : "拉伸") + " " +
                    (Math.round((dur / span) * 100) / 100) + "×）";
                }
              }
            } else {
              // 只有单个关键帧（没有跨度）：整体平移到句子起点
              var dOne = startT - rng.min;
              if (Math.abs(dOne) > 0.0005) {
                shiftedKeys += AESub_shiftAllKeys_(layer, dOne, { left: 600 });
                presetShiftBy = dOne;
              }
              presetAnimMode = "shift";
              if (presetShiftNote === "") {
                presetShiftNote = "预设只有一个关键帧 → 已平移到本句起点";
              }
            }
          }

          keyed = AESub_positionIsKeyed_(layer);
          if (keyed) presetKeyedCount++;
        } catch (eA) {
          presetNote = "预设应用失败：" + (eA.message || eA.toString());
        }
      }
      // 预设没接管位置，才强制居中；否则落点由预设决定
      if (!keyed) AESub_centerLayer_(layer, comp, opts);
      return keyed;
    };

    // —— 预过滤：纯空白段落不是可用字幕 ——
    // 旧实现只挡真空串（!s.text），ASR 偶尔返回的纯空格/全空白段会溜过去，
    // 建出"看起来没文字"的图层；单层模式更糟：层先建、关键帧后填，
    // 所有段都无效时会留下一个永远空白的层。
    // 所以这里统一按 trim 过滤，且**有效段为 0 直接报错**，绝不留空层。
    var valid = [], emptyCount = 0;
    for (var v = 0; v < segs.length; v++) {
      if (!AESub_trim_(String(segs[v].text || ""))) { emptyCount++; continue; }
      valid.push(segs[v]);
    }
    if (!valid.length) {
      throw new Error("识别结果里没有可用文字（" + segs.length +
        " 段全是空文本），已取消建层 —— 请检查音频或换素材重试");
    }
    if (emptyCount) {
      skipped += emptyCount;   // 让面板日志能说出"跳过 N 段（其中空文本 X 段）"
    }
    segs = valid;

    app.beginUndoGroup("Noniika：创建字幕图层");

    // —— 预设动画跨度探测 ——
    // 「句子比动画还短就不套预设」这个判定，必须先知道**预设动画本身有多长**。
    // 但跨度只有套上预设之后才量得出来，所以这里先拿一个临时文本层试套一次
    // （同一预设的跨度是固定的，量一次就够），随后立刻删掉它。
    if (presetFile && opts.skipPresetOnShort) {
      var probeLayer = null;
      try {
        probeLayer = comp.layers.addText("测");
        AESub_applyPreset_(comp, probeLayer, presetFile);
        var probeRng = AESub_keyTimeRange_(probeLayer, { left: 600 });
        if (probeRng) presetSpan = probeRng.max - probeRng.min;
      } catch (eProbe) {
        presetSpan = null;
      }
      if (probeLayer) { try { probeLayer.remove(); } catch (eProbe2) { } }
    }

    if (mode === "single") {
      /* ---- 单图层 + Source Text 关键帧：时间轴干净，但改单句要翻关键帧 ---- */
      var layer = comp.layers.addText("");
      var st1 = AESub_styleText_(layer, opts, comp);
      if (st1) { if (st1.fontNote) fontNote = st1.fontNote; fontApplied = st1.fontApplied || fontApplied; }
      layer.name = AESub_uniqueLayerName_(comp, prefix + "_全部", layer);

      var textProp = layer.property("ADBE Text Properties").property("ADBE Text Document");

      // 第一句若不是从 0 秒开始，先补一个空字关键帧，否则 0 秒处会显示第一句
      var firstIn = Math.max(0, segs[0].startMs / 1000);
      if (firstIn > 0.001) {
        var td0 = textProp.value; td0.text = "";
        textProp.setValueAtTime(0, td0);
      }
      for (var i = 0; i < segs.length; i++) {
        if (!segs[i].text) { skipped++; continue; }
        var inS = Math.max(0, segs[i].startMs / 1000);
        var outS = Math.min(comp.duration, segs[i].endMs / 1000);
        if (outS <= inS) { skipped++; continue; }
        var tdA = textProp.value; tdA.text = segs[i].text;
        textProp.setValueAtTime(inS, tdA);
        var tdB = textProp.value; tdB.text = "";
        textProp.setValueAtTime(outS, tdB);
        created++;
      }
      layer.inPoint = 0;
      layer.outPoint = comp.duration;
      // 单层模式：整层覆盖时间轴，**不能平移也不能缩放** —— 层上有 Source Text 关键帧，
      // 动一下就会把每句的时间一起搬走。只记录预设关键帧位置，不碰它。
      finishLayer(layer, 0, comp.duration, false);

    } else {
      /* ---- 逐句一层：倒序创建，让第一句落在图层栈最上面 ---- */
      for (var k = segs.length - 1; k >= 0; k--) {
        var s = segs[k];
        if (!s.text) { skipped++; continue; }
        var a = Math.max(0, s.startMs / 1000);
        var b = Math.min(comp.duration, s.endMs / 1000);
        if (b <= a) { skipped++; continue; }

        var tLayer = comp.layers.addText(String(s.text));
        var stK = AESub_styleText_(tLayer, opts, comp);
        if (stK) { if (stK.fontNote) fontNote = stK.fontNote; fontApplied = stK.fontApplied || fontApplied; }
        // 顺序很重要：先设 inPoint（此时 outPoint 还是合成时长，必然合法），再设 outPoint
        tLayer.inPoint = a;
        tLayer.outPoint = b;
        // 图层名两种方式（opts.nameMode）：默认 seq = 前缀_序号（字幕_001）；
        // text = 用识别到的文字命名 —— 时间线上一眼找到要改的那句。
        // ⚠ addText(文字) 时 AE 会自动把图层名设成文字内容，查重必须排除新层自己
        //   （excludeLayer），否则每一层都撞上自己、全部退让成「xx 2」（AE 实测踩过）。
        // 重复句由退让兜底（对对对 / 对对对 2 / 对对对 3）。
        tLayer.name = (opts.nameMode === "text")
          ? AESub_uniqueLayerName_(comp, AESub_textLayerName_(s.text, 20), tLayer)
          : AESub_uniqueLayerName_(comp, prefix + "_" + AESub_pad_(k + 1, 3), tLayer);
        // 把预设动画铺满这一句 [a, b]（策略见 finishLayer 注释）
        finishLayer(tLayer, a, b, true);
        created++;
      }
    }

    app.endUndoGroup();

    if (!presetApplied && presetFile) presetNote = presetNote || "预设未能应用";
    if (presetKeyedCount > 0 && !presetNote) {
      presetNote = "该预设带位移动画，已接管「位置」—— 共 " + presetKeyedCount +
        " 层不再强制居中（落点由预设决定）";
    }

    return AESub_ok_({
      mode: mode,
      created: created,
      skipped: skipped,
      skippedEmpty: emptyCount,
      compName: comp.name,
      fontRequested: opts.fontPostScriptName || opts.font || null,
      fontApplied: fontApplied || null,
      fontNote: fontNote,
      presetRequested: opts.presetPath || null,
      presetApplied: presetApplied || null,
      presetNote: presetNote || null,
      presetPositionKeyed: presetKeyedCount,
      presetKeysShifted: shiftedKeys,
      presetFirstKey: presetFirstKey,
      presetShiftBy: presetShiftBy,
      presetShiftNote: presetShiftNote || null,
      presetAnimMode: presetAnimMode,
      presetScaledLayers: scaledLayers,
      presetStaticLayers: staticLayers,
      presetScaledKeys: scaledKeys,
      presetSpan: presetSpan,
      presetSkippedShort: presetSkippedShort,
      presetSkipNote: presetSkipNote || null
    });

  } catch (err) {
    try { app.endUndoGroup(); } catch (e) { }
    return AESub_err_(err.message || err.toString());
  }
}

/**
 * 字幕体检 —— 检查合成里的字幕图层**是不是真的能被看见**。
 *
 * 动机：实测遇到过"图层建好了、图层名也对（识别没问题），但画面就是空的"。
 * 逐项报出成因，比让用户自己翻图层快得多：
 *   ① 被上方图层整片盖住（素材后放进合成时最常见）
 *   ② 文字落在画面外（位置 / 锚点异常 —— 只报属性看不出来，必须算包围盒）
 *   ③ 没有填充也没有描边 → AE 渲染出空（属性一切"正常"，就是不画东西）
 *   ④ 文本内容其实是空白（ASR 幻觉段）
 *   ⑤ 图层被关闭 / 不透明度为 0
 *   ⑥ 出入点零长（时间轴上只有一瞬）
 *
 * 只读：不改动任何图层。真正的"渲染验证"在 AESub_probeSubtitleRender 里。
 *
 * @param {String} compName 合成名；空字符串用当前选中的合成
 * @return {String} JSON
 */
function AESub_checkSubtitleLayers(compName) {
  try {
    var comp = AESub_findComp_(compName || "");
    var textLayers = 0, emptyText = 0, hidden = 0, transparent = 0, zeroLength = 0;
    var occluded = 0, offscreen = 0, noFill = 0, zeroAlpha = 0;
    var occluders = [], samples = [];
    var fontUnavailable = 0, exprCount = 0;
    var soloNames = [], shyCount = 0, guideCount = 0;
    var i, j;

    // ⚡ 全局可见性开关：独奏 / 羞怯 / 导引层
    // 这三个都会造成"每个字幕层的属性都完美，但画面上一个字都没有"。
    // 尤其是「独奏」：一开，**其他所有图层都会被隐藏**，而字幕自己的属性毫无异常。
    for (i = 1; i <= comp.numLayers; i++) {
      var AL = null;
      try { AL = comp.layer(i); } catch (es0) { continue; }
      try { if (AL.solo && soloNames.length < 5) soloNames.push({ name: AL.name, index: i }); } catch (es1) { }
      try { if (AL.shy) shyCount++; } catch (es2) { }
      try { if (AL.guideLayer) guideCount++; } catch (es3) { }
    }

    for (i = 1; i <= comp.numLayers; i++) {
      var L = null;
      try { L = comp.layer(i); } catch (e0) { continue; }
      if (!(L instanceof TextLayer)) continue;
      textLayers++;

      var txt = "";
      try {
        txt = String(L.property("ADBE Text Properties").property("ADBE Text Document").value.text || "");
      } catch (eT) { }
      if (!AESub_trim_(txt)) emptyText++;

      var isOn = true, op = 100, dur = 0;
      try { isOn = L.enabled; } catch (e1) { }
      try { op = L.property("ADBE Transform Group").property("ADBE Opacity").value; } catch (e2) { }
      try { dur = L.outPoint - L.inPoint; } catch (e3) { }
      if (!isOn) hidden++;
      if (op <= 0.001) transparent++;
      if (dur <= 0.0001) zeroLength++;

      // 样式与变换：这三样"看着都对但不显示"的元凶都在这里
      var posv = null, ancv = null, tbl = null;
      try {
        var tg = L.property("ADBE Transform Group");
        posv = tg.property("ADBE Position").value;
        ancv = tg.property("ADBE Anchor Point").value;
      } catch (e4) { }

      var fontName = "", fontSize = 0, fillOn = null, strokeOn = null, fillRGB = null, strokeWidth = null;
    var fontAvailable = null;
      try {
        var td = L.property("ADBE Text Properties").property("ADBE Text Document").value;
        fontName = String(td.font || "");
        fontSize = td.fontSize;
        try { fillOn = td.applyFill; } catch (e5) { }
        try { strokeOn = td.applyStroke; } catch (e6) { }
        try {
          // fillColor 可能带第 4 位 alpha：只取前三位会漏掉"填充透明"这个元凶
          var fc = td.fillColor;
          fillRGB = [];
          for (var fi = 0; fi < fc.length; fi++) fillRGB.push(fc[fi]);
        } catch (e7) { }
        try { strokeWidth = td.strokeWidth; } catch (e7b) { }
      } catch (e8) { }
      if (fillOn === false && strokeOn === false) noFill++;
      if (fillOn !== false && fillRGB && fillRGB.length >= 4 && fillRGB[3] <= 0.001) zeroAlpha++;
      if (!fontAvailable && fontName) { }   // 字体可用性在下面单独判定

      // 文字的包围盒 + 换算到画面坐标（pos - anchor + 块内偏移）
      var box = null, cx = null, cy = null, off = false;
      try {
        var r = L.sourceRectAtTime(L.inPoint, false);
        tbl = [r.left, r.top, r.width, r.height];
        if (posv && ancv) {
          var bx = posv[0] - ancv[0] + r.left;
          var by = posv[1] - ancv[1] + r.top;
          box = [bx, by, r.width, r.height];
          cx = bx + r.width / 2;
          cy = by + r.height / 2;
          // 与画框完全不相交 = 落在画面外
          off = (bx + r.width < 0) || (by + r.height < 0) ||
                (bx > comp.width) || (by > comp.height);
          if (off) offscreen++;
        }
      } catch (e9) { }

      // 遮挡判定：上方（索引更小）有"开着 + 不透明 + 带视频"的层，字幕就完全被盖住
      var occ = null;
      for (j = 1; j < i && !occ; j++) {
        var A = null;
        try { A = comp.layer(j); } catch (ea) { continue; }
        var hasVid = false;
        try { hasVid = (A instanceof AVLayer) && A.hasVideo; } catch (eb) { }
        if (!hasVid) continue;
        var aOn = true, aOp = 100;
        try { aOn = A.enabled; } catch (ec) { }
        try { aOp = A.property("ADBE Transform Group").property("ADBE Opacity").value; } catch (ed) { }
        if (aOn && aOp > 0.001) occ = { name: A.name, index: j };
      }
      if (occ) {
        occluded++;
        if (occluders.length < 4) {
          var dup = false;
          for (j = 0; j < occluders.length; j++) {
            if (occluders[j].name === occ.name) dup = true;
          }
          if (!dup) occluders.push(occ);
        }
      }

      if (samples.length < 3) {
        // 字体到底能不能用？—— app.fonts 里按 PostScript 名解析一次
        if (fontName) {
          try { fontAvailable = !!AESub_resolveFont_(fontName); } catch (ef) { fontAvailable = null; }
          if (fontAvailable === false) fontUnavailable++;
        }

        // 混合模式 / 保留基础透明度 / 父级 / 轨道遮罩 —— 都会让"不透明度 100"却看不见
        var blend = null, preserve = null, parentName = null, matteInfo = null;
        // 注意：这里返回的是 BlendingMode 的**数值**（NORMAL=5212），不是名字 ——
        // 早先用字符串去比 "BlendingMode.NORMAL" 导致每次体检都误报"混合模式异常"（已修）
        try { blend = Number(L.blendingMode); } catch (eb1) { }
        try { preserve = L.preserveTransparency; } catch (eb2) { }
        try { parentName = L.parent ? L.parent.name : null; } catch (eb3) { }
        try { if (L.hasTrackMatte) matteInfo = String(L.trackMatteType); } catch (eb4) { }

        // 不透明度上挂了表达式？（求值结果可能是 0）
        var opExpr = null;
        try {
          var opP = L.property("ADBE Transform Group").property("ADBE Opacity");
          if (opP.expressionEnabled && opP.expression) {
            opExpr = String(opP.expression).substring(0, 60);
            exprCount++;
          }
        } catch (eb5) { }

        // 图层上的效果（某些效果/预设会把画面吃掉）
        var fxCount = 0, fxNames = [];
        try {
          fxCount = L.effects.numProperties;
          for (var fe = 1; fe <= fxCount && fe <= 6; fe++) {
            try { fxNames.push(String(L.effects.property(fe).name)); } catch (eb6) { }
          }
          if (fxCount) { if (fxCount > 6) fxNames.push("…共 " + fxCount + " 个"); }
        } catch (eb7) { }

        // 动画关键帧跨度 vs 本句时长：两者差太多就说明动画没铺满句子
        // （比"属性看着都对"更早暴露问题的一行诊断）
        var kr = AESub_keyTimeRange_(L, { left: 600 });
        var keySpan = kr ? (kr.max - kr.min) : null;
        var keyFirst = kr ? kr.min : null;

        // 文字动画器：预设留下的不透明度动画器会让文字整段不可见
        var animCount = 0, animInfo = [], animOpacityLow = 0, animVals = [];
        // ⚠ 只读动画器第一层（"选择器"/"属性"）看不出任何东西 ——
        //   真正把文字压成透明的"不透明度"值藏在「属性」组里面，必须往下钻。
        var walkAnim = function (group, depth, path, out) {
          if (!group || depth > 3 || out.length > 16) return;
          var n = 0;
          try { n = group.numProperties; } catch (ew) { return; }
          for (var k = 1; k <= n && out.length <= 16; k++) {
            var ch = null;
            try { ch = group.property(k); } catch (ew2) { continue; }
            var nm = "";
            try { nm = String(ch.name || ""); } catch (ew3) { }
            var v = null;
            try { v = ch.value; } catch (ew4) { }
            var isOpacity = (nm.indexOf("不透明度") >= 0) || (nm.indexOf("Opacity") >= 0);
            if (typeof v === "number") {
              out.push(path + nm + "=" + (Math.round(v * 100) / 100));
              if (isOpacity) {
                // AE 的属性值：不透明度一律 0~100，这里兼容 0~1 的写法
                var low = (v <= 1) ? (v < 0.5) : (v < 50);
                animVals.push(nm + "=" + v);
                if (low) animOpacityLow++;
              }
            } else if (v && typeof v.length === "number") {
              var parts = [];
              for (var vi = 0; vi < v.length && vi < 3; vi++) parts.push(Math.round(v[vi] * 100) / 100);
              out.push(path + nm + "=[" + parts.join(",") + "]");
            } else {
              out.push(path + nm);
              walkAnim(ch, depth + 1, path + nm + "/", out);
            }
          }
        };
        try {
          var tas = L.property("ADBE Text Properties").property("ADBE Text Animators");
          animCount = tas.numProperties;
          for (var ai = 1; ai <= animCount && ai <= 3; ai++) {
            var an = tas.property(ai);
            var entry = { name: String(an.name || ""), props: [] };
            var raw = [];
            walkAnim(an, 0, "", raw);
            entry.props = raw;
            entry.opacityVals = animVals.slice(0);
            animInfo.push(entry);
          }
        } catch (eba) { }

        samples.push({
          index: i,
          name: L.name,
          text: txt.substring(0, 24),
          opacity: op,
          inPoint: L.inPoint,
          outPoint: L.outPoint,
          pos: posv ? [posv[0], posv[1]] : null,
          anchor: ancv ? [ancv[0], ancv[1]] : null,
          textBox: tbl,
          frameBox: box,
          centerX: cx,
          centerY: cy,
          offscreen: off,
          font: fontName,
          fontSize: fontSize,
          fillEnabled: fillOn,
          strokeEnabled: strokeOn,
          fill: fillRGB,
          strokeWidth: strokeWidth,
          fontAvailable: fontAvailable,
          blend: blend,
          preserveTransparency: preserve,
          parent: parentName,
          trackMatte: matteInfo,
          opacityExpression: opExpr,
          effects: fxCount,
          effectNames: fxNames,
          animators: animCount,
          keySpan: keySpan,
          keyFirst: keyFirst,
          keyLast: kr ? kr.max : null,
          layerDur: dur,
          animatorDetail: animInfo,
          animOpacityLow: animOpacityLow,
          animOpacityVals: animVals,
          solo: (function () { try { return L.solo; } catch (e) { return null; } })(),
          shy: (function () { try { return L.shy; } catch (e) { return null; } })(),
          guide: (function () { try { return L.guideLayer; } catch (e) { return null; } })(),
          occludedBy: occ ? occ.name : null
        });
      }
    }

    return AESub_ok_({
      compName: comp.name,
      compWidth: comp.width,
      compHeight: comp.height,
      totalLayers: comp.numLayers,
      textLayers: textLayers,
      emptyText: emptyText,
      hidden: hidden,
      transparent: transparent,
      zeroLength: zeroLength,
      occluded: occluded,
      offscreen: offscreen,
      noFill: noFill,
      zeroAlpha: zeroAlpha,
      soloLayers: soloNames.length,
      soloNames: soloNames,
      shyCount: shyCount,
      guideCount: guideCount,
      fontUnavailable: fontUnavailable,
      opacityExpressions: exprCount,
      occluders: occluders,
      samples: samples
    });
  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

/**
 * 修复「预设动画关键帧错位」—— 把各字幕层的动画窗口搬回它自己的时间范围。
 *
 * 背景：早先套预设时假设关键帧从 0 秒开始，而 AE 实际把它写在当前时间(CTI)上，
 * 于是关键帧被平移过头、动画窗口整个落到句子之外 —— 对"范围选择器 + 不透明度"
 * 这类预设（打字机等）就表现为**整句透明**（图层不透明度仍是 100%）。
 * 这个函数把这类图层的所有关键帧整体平移回它的入点。
 *
 * 安全策略（只动"明显错位"的层）：
 *   - 只有「最早关键帧晚于出点」或「早于入点 1 秒以上」才判定为错位，其余不动
 *   - 只做整体平移，不新增/删除任何关键帧
 *   - 全程包在一个撤销组里，Ctrl+Z 可整体撤回
 *
 * @param {String} compName 合成名；空字符串用当前选中的合成
 * @return {String} JSON —— { scanned, fixed, skipped, movedKeys, samples:[{name,from,to}] }
 */
function AESub_fixPresetKeyTimes(compName) {
  var done = false;
  try {
    var comp = AESub_findComp_(compName || "");
    var scanned = 0, fixed = 0, skipped = 0, movedKeys = 0;
    var samples = [];
    var i;

    app.beginUndoGroup("Noniika：修复动画关键帧错位");
    try {
      for (i = 1; i <= comp.numLayers; i++) {
        var L = null;
        try { L = comp.layer(i); } catch (e0) { continue; }
        if (!(L instanceof TextLayer)) continue;
        scanned++;

        var tMin = AESub_firstKeyTime_(L, { left: 600 });
        if (tMin === null) { skipped++; continue; }

        var inP = 0, outP = 0;
        try { inP = L.inPoint; outP = L.outPoint; } catch (e1) { skipped++; continue; }

        var misaligned = (tMin > outP + 0.05) || (tMin < inP - 1.0);
        if (!misaligned) { skipped++; continue; }

        var delta = inP - tMin;
        if (Math.abs(delta) < 0.0005) { skipped++; continue; }

        movedKeys += AESub_shiftAllKeys_(L, delta, { left: 600 });
        fixed++;
        if (samples.length < 5) samples.push({ name: L.name, from: tMin, to: inP });
      }
    } finally {
      app.endUndoGroup();
      done = true;
    }

    return AESub_ok_({
      compName: comp.name, scanned: scanned, fixed: fixed,
      skipped: skipped, movedKeys: movedKeys, samples: samples
    });
  } catch (err) {
    if (!done) { try { app.endUndoGroup(); } catch (e) { } }
    return AESub_err_(err.message || err.toString());
  }
}

/**
 * 渲染验证 —— 真渲染一帧，看这个文本图层到底有没有往画面上画东西。
 *
 * 做法：在**该层的时间中点**渲染两帧 PNG，一帧图层开着、一帧关掉它，
 * 交给面板比较两张图是否逐字节相同：
 *   相同 ⇒ 这个图层对画面**零贡献**（属性都对，就是没渲染出像素）
 *   不同 ⇒ 它确实在画面上画了东西
 *
 * ⚠ 为了做这个对比，会**瞬间关一下再打开**该图层（然后恢复原状）。
 *   除此之外不做任何改动，也不写工程。
 *
 * @return {String} JSON —— { ok, data:{ layer, time, pngOn, pngOff, sizeOn, sizeOff } }
 */
function AESub_probeSubtitleRender(compName, layerName, outDir) {
  var target = null, wasOn = true;
  try {
    var comp = AESub_findComp_(compName || "");
    var i;
    for (i = 1; i <= comp.numLayers; i++) {
      var L = null;
      try { L = comp.layer(i); } catch (e0) { continue; }
      if (L instanceof TextLayer && (!layerName || L.name === layerName)) { target = L; break; }
    }
    if (!target) {
      return AESub_err_("合成里找不到文本图层" + (layerName ? "：" + layerName : ""));
    }

    var t = (target.inPoint + target.outPoint) / 2;
    if (!(t > target.inPoint)) t = target.inPoint + 0.02;
    if (!(t < target.outPoint)) t = target.outPoint - 0.02;

    try { comp.openInViewer(); } catch (e1) { }

    // 给了 outDir 就把两帧**留在用户能看到的目录**（体检要给人眼看/发回），
    // 没给就写临时目录、由面板比对完删掉。
    // ⚠ 临时文件名必须每次都不同：同一个路径连渲两帧会互相覆盖，比对就永远"相同"（实测踩过）
    var keep = outDir ? String(outDir) : "";
    var pathOn, pathOff;
    if (keep) {
      var kd = new Folder(keep);
      if (!kd.exists) { try { kd.create(); } catch (eD) { } }
      pathOn = keep + "/体检帧_有字幕.png";
      pathOff = keep + "/体检帧_关掉该层.png";
    } else {
      var stamp = String((new Date()).getTime());
      pathOn = Folder.temp.fsName + "/aesub-probe-" + stamp + "-on.png";
      pathOff = Folder.temp.fsName + "/aesub-probe-" + stamp + "-off.png";
    }

    var t0 = (new Date()).getTime();
    comp.saveFrameToPng(t, new File(pathOn));

    try { wasOn = target.enabled; } catch (e2) { }
    target.enabled = false;
    try {
      comp.saveFrameToPng(t, new File(pathOff));
      // 实测 AE 偶尔只写出第一帧（第二帧文件根本没落盘）→ 差一点就重试一次
      var probeOff = new File(pathOff);
      if (!probeOff.exists) {
        $.sleep(400);
        comp.saveFrameToPng(t, new File(pathOff));
      }
    } finally {
      target.enabled = wasOn;   // 无论如何都要恢复
    }
    var elapsed = (new Date()).getTime() - t0;

    // ⚠ 读大小必须重新 new File：写入前创建的对象上 exists/length 是缓存值（实测返回 -1）
    var sOn = -1, sOff = -1;
    var chkOn = new File(pathOn);
    var chkOff = new File(pathOff);
    try { if (chkOn.exists) sOn = chkOn.length; } catch (e3) { }
    try { if (chkOff.exists) sOff = chkOff.length; } catch (e4) { }

    return AESub_ok_({
      layer: target.name,
      time: t,
      pngOn: pathOn,
      pngOff: pathOff,
      sizeOn: sOn,
      sizeOff: sOff,
      kept: !!keep,
      ms: elapsed
    });
  } catch (err) {
    try { if (target) target.enabled = wasOn; } catch (e3) { }
    return AESub_err_(err.message || err.toString());
  }
}


/** 左侧补零，让图层名排序整齐 */
function AESub_pad_(n, width) {
  var s = String(n);
  while (s.length < width) s = "0" + s;
  return s;
}

/* ============================================================
 * 五之二、对外接口 ②b：把分离出的人声落成时间线图层
 * ============================================================ */

/** 路径比较用：统一分隔符 + 小写（Windows 大小写不敏感） */
function AESub_samePath_(a, b) {
  if (!a || !b) return false;
  var f = function (s) { return String(s).replace(/\\/g, "/").toLowerCase(); };
  return f(a) === f(b);
}

/**
 * 在工程里找一个已经导入过的同路径素材项（没有就返回 null）。
 * 为什么要找：脚本反复运行时若每次都 importFile，工程里会堆一沓同名素材，
 * 用户的项目面板会变成垃圾场，而且它们指向的是同一个文件。
 */
function AESub_findFootageByPath_(fsPath) {
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (!(it instanceof FootageItem)) continue;
    try {
      if (it.mainSource instanceof FileSource && it.mainSource.file &&
          AESub_samePath_(it.mainSource.file.fsName, fsPath)) {
        return it;
      }
    } catch (e) { }
  }
  return null;
}

/** 找同名的图层（用于避免重名，返回第一个命中） */
function AESub_findLayerByName_(comp, name) {
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = null;
    try { L = comp.layer(i); } catch (e) { continue; }
    if (L && L.name === name) return L;
  }
  return null;
}

/**
 * 图层重名退让：want 已存在就依次尝试 "want 2"、"want 3"…
 *
 * 为什么必须有：同一合成里跑第二轮字幕时，旧实现会再建一套一模一样名字的
 * 字幕_001…字幕_030，时间线上两套重名层根本分不清哪套是哪轮的。
 * 与落轨（AESub_placeSeparatedAudio）的退让规则保持一致 —— 全面板一个规矩：
 * **重名只让位，绝不覆盖用户可能已精修过的层**。
 */
function AESub_uniqueLayerName_(comp, want, excludeLayer) {
  var finalName = want, n = 1;
  while (true) {
    var hit = AESub_findLayerByName_(comp, finalName);
    if (!hit || hit === excludeLayer) break;   // excludeLayer：刚建的层自己也叫这个名字，不算冲突
    n++;
    finalName = want + " " + n;
    if (n > 20) break;
  }
  return finalName;
}

/**
 * 文字命名：把这一句的文字变成图层名。
 * 单行化（换行/制表 → 空格）→ trim → 超 maxLen 截断加省略号。
 * 重复句（"对对对"出现 3 次）由外层的 AESub_uniqueLayerName_ 退让成 " 2"/" 3"。
 */
function AESub_textLayerName_(text, maxLen) {
  var t = String(text).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
  if (t.length > maxLen) t = t.slice(0, maxLen) + "…";
  return t;
}

/**
 * 把分离出的人声音频落成时间线图层。
 *
 * 三种落位模式（mode）：
 *   "video"   —— 源层是视频：给源层关掉声音开关（audioEnabled=false），人声层紧贴其下方。
 *                注意这是【静音】不是删除：原声（含 BGM）还在那条层上，随时可拨回开关。
 *   "replace" —— 源层是音频且用户选择"替换"：删掉源层，人声层占据它原来的图层位。
 *   "below"   —— 源层是音频且用户选择"不替换"：人声层紧贴源层下方，源层照旧发声。
 *
 * 时间对齐：人声文件的 0 秒 == 合成时间 offsetSec 秒（offsetSec 就是导出音频时的区间起点），
 *          所以 startTime 设成 offsetSec，再把出入点收拢到源层的可见范围。
 *
 * @param {String} compName      合成名（空 = 当前活动合成）
 * @param {String} srcLayerName  源图层名（要静音/替换的那条）
 * @param {String} audioPath     人声音频文件绝对路径
 * @param {String} optsJson      JSON：{ mode, offsetSec, nameSuffix }
 * @return {String} JSON 字符串
 */
function AESub_placeSeparatedAudio(compName, srcLayerName, audioPath, optsJson) {
  var item = null, imported = false, srcLayer = null, aboveLayer = null;
  var srcIndex = 0, srcHasVideo = false, mutedSource = false, removedSource = false;

  try {
    if (!app.project) throw new Error("没有打开的项目");

    var opts = optsJson ? eval("(" + optsJson + ")") : {};
    var mode = opts.mode || "below";
    if (mode !== "video" && mode !== "replace" && mode !== "below") mode = "below";
    var offsetSec = Number(opts.offsetSec);
    if (isNaN(offsetSec) || offsetSec < 0) offsetSec = 0;
    var suffix = opts.nameSuffix || "_人声";

    var comp = AESub_findComp_(compName || "");
    if (!(comp instanceof CompItem)) throw new Error("找不到目标合成");

    // ---- 1. 文件得先在磁盘上（AE 图层引用的是路径，文件没了图层会变红离线）----
    if (!audioPath) throw new Error("没有拿到人声音频文件路径");
    var af = new File(String(audioPath));
    if (!af.exists) {
      throw new Error("人声音频文件不存在：" + audioPath + "（可能被移动或删除了）");
    }

    // ---- 2. 源图层必须在（跑流水线期间用户可能改了名字或删了层）----
    srcLayer = AESub_findLayerByName_(comp, String(srcLayerName || ""));
    if (!srcLayer) {
      throw new Error("源图层「" + srcLayerName + "」已不存在（可能被改名或删除）。" +
        "人声文件已生成，可用「用已有字幕建图层」之外的方式手动拖入。");
    }
    srcIndex = srcLayer.index;
    srcHasVideo = !!srcLayer.hasVideo;
    // 替换模式要"删掉源层后让新层占据它原来的位置"，而 AE 没有 moveToIndex，
    // 只能靠相对移动。索引账要提前算清（务必在 layers.add 之前抓引用）：
    //   加新层 → 它跑到 index 1，其余全部 +1，源层变成 srcIndex+1
    //   删源层 → 源层下方的层索引 -1，"源层上方那条"停在 srcIndex
    //   所以：moveAfter(源层上方那条) 就能落到 srcIndex；源层本来就在最上面就 moveToBeginning
    if (srcIndex > 1) {
      try { aboveLayer = comp.layer(srcIndex - 1); } catch (eA2) { aboveLayer = null; }
    }

    app.beginUndoGroup("Noniika：放置分离人声");

    // ---- 3. 导入素材（能复用就复用，避免工程面板堆垃圾）----
    item = AESub_findFootageByPath_(af.fsName);
    if (!item) {
      var io = new ImportOptions(af);
      try { io.importAs = ImportAsType.FOOTAGE; } catch (eImp) { }
      item = app.project.importFile(io);
      imported = true;
    }
    if (!item) throw new Error("导入音频失败：" + audioPath);

    // ---- 4. 加成图层 ----
    var newLayer = comp.layers.add(item);
    if (!newLayer) throw new Error("图层创建失败");

    // ---- 5. 命名（重名就加序号，绝不覆盖用户可能已精修过的同名层）----
    // 图层名跟**人声文件名**走（opts.layerBase，面板把"无上光荣 2_人声"这样的 stem 传进来）：
    // 文件另存成第几轮，图层就叫第几轮 —— 文件和图层永远对得上，不会被同名的另一轮偷换内容。
    // 不传 layerBase 时保持旧行为（源层名 + "_人声"），老回归脚本不受影响。
    var wantName = opts.layerBase || (String(srcLayerName || "素材") + suffix);
    var finalName = wantName, dupNote = null, n = 1;
    while (AESub_findLayerByName_(comp, finalName) && AESub_findLayerByName_(comp, finalName) !== newLayer) {
      n++;
      finalName = wantName + " " + n;
      if (n > 20) break;
    }
    if (finalName !== wantName) dupNote = "已存在同名图层，本次命名为「" + finalName + "」";
    newLayer.name = finalName;

    // ---- 6. 时间对齐 ----
    // 先设 startTime：让文件的 0 秒落在合成的 offsetSec 处
    try { newLayer.startTime = offsetSec; } catch (eSt) { }
    var fileDur = 0;
    try { fileDur = item.duration || 0; } catch (eD) { }
    var a = offsetSec, b = offsetSec + fileDur;
    // 收拢到源层的可见范围（两者都按合成时间算，直接交集即可）
    if (srcLayer.inPoint > a) a = srcLayer.inPoint;
    if (srcLayer.outPoint < b) b = srcLayer.outPoint;
    if (b <= a + 0.001) {   // 交集为空（理论上不该发生）→ 退回文件自身范围
      a = offsetSec;
      b = offsetSec + (fileDur > 0.001 ? fileDur : 0.001);
    }
    // 顺序要紧：先把 outPoint 放到最大合法值，再收 inPoint，最后收 outPoint
    // （AE 里 outPoint 不能小于 inPoint，顺序错会抛错）
    try { newLayer.outPoint = comp.duration; } catch (eO1) { }
    try { newLayer.inPoint = a; } catch (eI1) { }
    try { newLayer.outPoint = b; } catch (eO2) { }

    // ---- 7. 落位 ----
    if (mode === "video") {
      // 关掉源层的声音开关（非破坏：原声还在，随时能打开）
      try { srcLayer.audioEnabled = false; mutedSource = true; } catch (eM) { }
      newLayer.moveAfter(srcLayer);
    } else if (mode === "replace") {
      var hasAbove = !!aboveLayer;
      srcLayer.remove();            // 此刻起 srcLayer 引用失效，别再碰它
      removedSource = true;
      // 落到源层原来的位置：贴在"原本在源层上方那条"的后面
      if (hasAbove) newLayer.moveAfter(aboveLayer);
      else newLayer.moveToBeginning();
    } else {
      newLayer.moveAfter(srcLayer);
    }

    app.endUndoGroup();

    return AESub_ok_({
      mode: mode,
      compName: comp.name,
      layerName: finalName,
      layerIndex: newLayer.index,
      sourceLayerName: srcLayerName,
      sourceLayerHasVideo: srcHasVideo,
      mutedSource: mutedSource,
      removedSource: removedSource,
      footageImported: imported,
      footageItemName: item.name,
      fileDurationSec: Math.round(fileDur * 1000) / 1000,
      startTime: newLayer.startTime,
      inPoint: newLayer.inPoint,
      outPoint: newLayer.outPoint,
      dupNote: dupNote,
      compLayersAfter: comp.numLayers
    });

  } catch (err) {
    try { app.endUndoGroup(); } catch (e2) { }
    return AESub_err_(err.message || err.toString());
  }
}

/* ============================================================
 * 六、对外接口 ③：面板用的查询接口
 * ============================================================ */

/** 项目基本信息：面板据此决定字幕产物放哪 */
function AESub_projectInfo_() {
  var saved = false, projFile = null, projDir = null;
  try {
    if (app.project && app.project.file) {
      saved = true;
      projFile = app.project.file.fsName;
      projDir = app.project.file.parent.fsName;
    }
  } catch (e) { }
  return {
    saved: saved,
    file: projFile,
    dir: projDir,
    name: app.project ? app.project.name : ""
  };
}

/** 列出选中的合成 + 音频体检结果，面板启动时调用 */
function AESub_getSelectionInfo() {
  try {
    if (!app.project) throw new Error("没有打开的项目");
    var list = [];
    var sel = app.project.selection;
    for (var i = 0; i < sel.length; i++) {
      if (sel[i] instanceof CompItem) list.push(AESub_analyzeAudio_(sel[i]));
    }
    return AESub_ok_({
      comps: list,
      selectedCount: list.length,
      project: AESub_projectInfo_()
    });
  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

/* ============================================================
 * 七、时间线选中图层（面板的主入口）
 * ============================================================ */

/**
 * 算出若干音频图层在合成时间轴上覆盖的并集区间。
 *
 * 注意：layer.inPoint / layer.outPoint 用的就是【合成时间】（实测确认），
 * 不需要再叠加 startTime —— 叠加会导致偏移量翻倍。
 *
 * @return {Object|null} { start, end, duration, layerNames }；没有任何有效区间时返回 null
 */
function AESub_audioRange_(comp, layers) {
  var start = null, end = 0, names = [];
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i];
    var s = L.inPoint, e = L.outPoint;
    if (typeof s !== "number" || typeof e !== "number") continue;
    if (s < 0) s = 0;
    if (e > comp.duration) e = comp.duration;
    if (e <= s) continue;                       // 出点早于入点（被裁没了）跳过
    if (start === null || s < start) start = s;
    if (e > end) end = e;
    names.push(L.name);
  }
  if (start === null || end <= start) return null;
  return { start: start, end: end, duration: end - start, layerNames: names };
}

/** 收集一个图层里可用的音频信息 */
function AESub_layerAudioInfo_(L) {
  var o = {
    name: L.name,
    index: L.index,
    hasAudio: !!(L.hasAudio && L.audioEnabled),
    hasVideo: !!L.hasVideo,          // 有画面 = 视频素材；没有 = 纯音频素材
    inPoint: L.inPoint,
    outPoint: L.outPoint,
    stretch: null,
    isFootage: false,
    sourceFile: null
  };
  try {
    var st = AESub_readProp_(L, "stretch");
    if (st !== null) o.stretch = st;
  } catch (e) { }
  try {
    if (L instanceof AVLayer && L.source instanceof FootageItem &&
        L.source.mainSource instanceof FileSource) {
      o.isFootage = true;
      if (L.source.mainSource.file) o.sourceFile = L.source.mainSource.file.fsName;
    }
  } catch (e2) { }
  return o;
}

/**
 * 面板主入口：读取【时间线上选中的图层】，给出处理计划。
 *
 * 选择策略：
 *   1. 时间线上选中了开启音频的图层 → 就用选中的这些
 *   2. 一个音频图层都没选中 → 退化为"当前合成里所有开启音频的图层"（省得用户空选时卡住）
 *   3. 合成里也没有音频图层 → 明确报错，不猜
 *
 * @param {Number} limitSec 可选。视频总时长上限（秒），超过时只处理前 limitSec 秒。
 *                          用于兜住"选中了整段超长素材"的情况，默认不限制（传 0 或省略）。
 */
function AESub_getTimelineSelection(limitSec) {
  try {
    if (!app.project) throw new Error("没有打开的项目");

    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
      return AESub_ok_({
        ready: false,
        hasComp: false,
        hint: "请先双击进入一个合成的时间线，然后在时间线上选中要处理的素材图层。"
      });
    }

    var selected = [];
    var sel = comp.selectedLayers;
    for (var i = 0; i < sel.length; i++) selected.push(sel[i]);

    var picks = [], autoPicked = false;
    for (i = 0; i < selected.length; i++) {
      if (selected[i].hasAudio && selected[i].audioEnabled) picks.push(selected[i]);
    }
    if (picks.length === 0) {
      for (i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (L.hasAudio && L.audioEnabled) picks.push(L);
      }
      autoPicked = true;
    }

    var base = {
      ready: false,
      hasComp: true,
      compName: comp.name,
      compDuration: comp.duration,
      compWidth: comp.width,
      compHeight: comp.height,
      frameRate: comp.frameRate,
      selectedLayerCount: selected.length,
      autoPicked: autoPicked,
      project: AESub_projectInfo_()
    };

    if (picks.length === 0) {
      base.hint = selected.length > 0
        ? "选中的图层没有开启音频（可能是纯画面或已静音），且当前合成里也找不到音频图层。"
        : "当前合成里没有开启音频的图层。请把音频素材拖进时间线再试。";
      base.layers = [];
      return AESub_ok_(base);
    }

    // 逐个体检（给面板显示用）
    var infos = [];
    for (i = 0; i < picks.length; i++) infos.push(AESub_layerAudioInfo_(picks[i]));
    base.layers = infos;
    base.audioLayerCount = picks.length;

    // 承载音频的"主层"：面板要静音/替换的就是它。
    // 选中多条带音频的层时取最上面那条 —— 与 AE 时间线上"最上面那条决定你看到什么"的直觉一致。
    base.sourceLayer = infos[0];
    base.sourceLayerName = infos[0].name;
    base.sourceLayerIsVideo = !!infos[0].hasVideo;
    // 认出"这是我们自己上一轮生成的人声层"：再对它做分离只会得到垃圾，面板要拦一下
    base.sourceLayerIsSeparatedVocals = /_人声(\s\d+)?$/.test(String(infos[0].name));

    // 计算并集区间，并按需截断
    var range = AESub_audioRange_(comp, picks);
    if (!range) {
      base.hint = "选中的音频图层在时间线上没有有效长度（可能出点早于入点）。";
      return AESub_ok_(base);
    }

    var lim = Number(limitSec);
    if (!isNaN(lim) && lim > 0 && range.duration > lim) {
      range.end = range.start + lim;
      range.truncated = true;
      range.truncatedFrom = range.duration;
      range.duration = lim;
    }

    base.ready = true;
    base.rangeStart = range.start;
    base.rangeEnd = range.end;
    base.rangeDuration = range.duration;
    base.truncated = !!range.truncated;
    base.truncatedFrom = range.truncatedFrom || null;
    base.layerNames = range.layerNames;
    // 预计的 AIFF 体积（48kHz / 16bit / 立体声 = 192000 字节/秒），用于提前提示用户
    base.estimatedExportBytes = Math.round(range.duration * 192000);
    base.hint = "";
    return AESub_ok_(base);

  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

/** 按名字做音频体检（面板用，避免把 CompItem 对象跨 evalScript 传递） */
function AESub_analyzeByName(compName) {
  try {
    var comp = AESub_findComp_(compName || "");
    return AESub_ok_(AESub_analyzeAudio_(comp));
  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

function AESub_getProjectInfo() {
  try {
    if (!app.project) throw new Error("没有打开的项目");
    return AESub_ok_(AESub_projectInfo_());
  } catch (err) {
    return AESub_err_(err.message || err.toString());
  }
}

/**
 * 探测输出模板与格式，供面板显示与排障。
 * 没有选中合成时也能工作（临时建一个极短的空合成来探测，用完删掉）。
 */
function AESub_probeEnvironment(compName) {
  var rq = null, snapshot = [], item = null, tempComp = null;
  try {
    if (!app.project) throw new Error("没有打开的项目");

    var comp = null;
    try { comp = AESub_findComp_(compName || ""); } catch (e) { comp = null; }
    if (!comp) {
      // 0.04 秒 / 24fps = 1 帧，建完立刻删，对用户工程无影响
      tempComp = app.project.items.addComp("AESub_临时探测", 64, 64, 1, 0.04, 24);
      comp = tempComp;
    }

    rq = app.project.renderQueue;
    for (var i = 1; i <= rq.numItems; i++) snapshot.push(rq.item(i).render);
    for (i = 1; i <= rq.numItems; i++) rq.item(i).render = false;

    item = rq.items.add(comp);
    var names = [], probe = null;
    try {
      var tpls = item.outputModule(1).templates;
      for (var k = 0; k < tpls.length; k++) names.push(tpls[k]);
    } catch (e2) { }
    try { probe = AESub_probeAudioTemplate_(item); } catch (e3) { }

    return AESub_ok_({
      aeVersion: app.version,
      compName: comp.name,
      usedTempComp: tempComp !== null,
      templates: names,
      templateCount: names.length,
      canExportAudio: probe ? probe.ok : false,
      resolvedFormat: (probe && probe.ok) ? probe.format : null,
      resolvedTemplate: (probe && probe.ok) ? probe.template : null,
      hint: (probe && !probe.ok) ? probe.error : ""
    });

  } catch (err) {
    return AESub_err_(err.message || err.toString());
  } finally {
    try { if (item) item.remove(); } catch (e4) { }
    try {
      for (var j = 0; j < snapshot.length; j++) rq.item(j + 1).render = snapshot[j];
    } catch (e5) { }
    try { if (tempComp) tempComp.remove(); } catch (e6) { }
  }
}

/* ============================================================
 * 八、一键自检（面板「跑自检」按钮调用）
 * ============================================================ */

/**
 * 在当前工程里**安全地**验证三条关键路径，并把完整报告写成 JSON。
 *
 * 为什么要有这个：`-r` 命令行注入会卡在 AE 的脚本对话框上（实测），
 * 面板通道则不受影响 —— 所以把自检做进面板，任何机器、任何 AE 版本都能一键跑。
 *
 * 安全原则（用户很可能开着真实工程，必须零残留）：
 *   - 不导入任何素材、不新建合成、不改动任何已有图层
 *   - 居中测试会临时建 3 个文本图层，量完**立即删除**（并包在 undo 组里）
 *   - 全程不动 app.project.dirty（结束后还原）
 *   - 每一项失败都记录下来继续跑，不中断整体自检
 *
 * 验证内容：
 *   1. 字体检索（app.fonts 可用性、家族数、缓存前后耗时）
 *   2. 范围探测（当前选中图层能算出什么区间）
 *   3. 居中几何（★ 用数学验证，不靠肉眼）：建长/中/短三种文本，
 *      算「文本块中心」在合成里的实际落点，与画面中线比对
 *
 * @param {String} outPath 报告 JSON 的落盘路径
 * @return {String} JSON 字符串（同时回传，面板不必读文件）
 */
function AESub_selfTest(outPath) {
  var t0 = new Date().getTime();
  var rep = { ok: false, aeVersion: app.version, errors: [], notes: [] };

  var wasDirty = null;
  try { wasDirty = app.project.dirty; } catch (e0) { }

  // ---------- 1. 字体检索 ----------
  try {
    var tFont = new Date().getTime();
    var raw = AESub_searchFonts("黑体", 20, true);
    var sf = eval("(" + raw + ")");
    rep.font = { ok: !!sf.ok };
    if (sf.ok) {
      rep.font.available = sf.data.available;
      rep.font.totalFamilies = sf.data.totalFamilies;
      rep.font.matched = sf.data.matched;
      rep.font.returned = sf.data.returned;
      rep.font.payloadChars = raw.length;
      rep.font.firstSearchMs = new Date().getTime() - tFont;

      rep.font.sample = [];
      var fams = sf.data.families || [];
      for (var i = 0; i < fams.length && i < 3; i++) {
        rep.font.sample.push({
          family: fams[i].family,
          nativeName: fams[i].native,
          styleCount: fams[i].styles.length,
          firstPs: fams[i].styles[0].ps
        });
      }

      // 第二次走缓存，应该明显更快 —— 这验证了性能优化是否真的生效
      var tCached = new Date().getTime();
      AESub_searchFonts("", 20, false);
      rep.font.cachedSearchMs = new Date().getTime() - tCached;
    } else {
      rep.errors.push("字体检索失败：" + sf.error);
    }
  } catch (eF) {
    rep.errors.push("字体检索异常：" + (eF.message || eF.toString()));
  }

  // ---------- 2. 范围探测 ----------
  try {
    var sd = eval("(" + AESub_getTimelineSelection(0) + ")");
    if (sd.ok) {
      rep.range = {
        hasComp: sd.data.hasComp,
        compName: sd.data.compName || null,
        compDuration: sd.data.compDuration || null,
        ready: sd.data.ready,
        autoPicked: sd.data.autoPicked,
        audioLayerCount: sd.data.audioLayerCount || 0,
        rangeStart: sd.data.ready ? sd.data.rangeStart : null,
        rangeEnd: sd.data.ready ? sd.data.rangeEnd : null,
        rangeDuration: sd.data.ready ? sd.data.rangeDuration : null
      };
      if (!sd.data.hasComp) {
        rep.notes.push("当前不在合成时间线上，范围探测与居中测试都会跳过。双击进入一个合成再跑一次。");
      }
    } else {
      rep.errors.push("范围探测失败：" + sd.error);
    }
  } catch (eS) {
    rep.errors.push("范围探测异常：" + (eS.message || eS.toString()));
  }

  // ---------- 3. 居中几何（★ 核心：数学验证，不靠肉眼）----------
  try {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
      rep.center = { available: false, reason: "当前不在合成时间线上" };
    } else {
      var bestPs = (rep.font && rep.font.sample && rep.font.sample.length)
        ? rep.font.sample[0].firstPs : "";

      // 三种长度都测：居中的关键就在"与文本长度无关"
      var samples = [
        { label: "短", text: "短" },
        { label: "中", text: "这是一句中等长度的字幕" },
        { label: "长", text: "这是一句相当长的字幕文本用来检验居中是否与长度无关" }
      ];

      rep.center = {
        available: true,
        compWidth: comp.width,
        compHeight: comp.height,
        fontUsed: bestPs,
        results: []
      };

      var made = [];
      app.beginUndoGroup("Noniika：自检（不会留下任何内容）");
      try {
        for (var si = 0; si < samples.length; si++) {
          try {
            var L = comp.layers.addText(samples[si].text);
            made.push(L);

            AESub_styleText_(L, {
              fontSize: 72, yPercent: 0.5,
              fontPostScriptName: bestPs, color: [1, 1, 1]
            }, comp);

            var tg = L.property("ADBE Transform Group");
            var pos = tg.property("ADBE Position").value;
            var anc = tg.property("ADBE Anchor Point").value;
            var r = L.sourceRectAtTime(L.inPoint, false);
            var tdv = L.property("ADBE Text Properties").property("ADBE Text Document").value;

            // 图层空间点 p 映射到合成：pos + (p - anc)
            var cx = pos[0] + ((r.left + r.width / 2) - anc[0]);
            var cy = pos[1] + ((r.top + r.height / 2) - anc[1]);

            rep.center.results.push({
              label: samples[si].label,
              rectWidth: Math.round(r.width * 100) / 100,
              rectHeight: Math.round(r.height * 100) / 100,
              position: [Math.round(pos[0] * 100) / 100, Math.round(pos[1] * 100) / 100],
              anchorPoint: [Math.round(anc[0] * 100) / 100, Math.round(anc[1] * 100) / 100],
              textCenterInComp: [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100],
              dx: Math.round((cx - comp.width / 2) * 100) / 100,
              dy: Math.round((cy - comp.height / 2) * 100) / 100,
              fontReadBack: String(tdv.font || ""),
              justificationIsCenter: (tdv.justification === ParagraphJustification.CENTER_JUSTIFY)
            });
          } catch (eOne) {
            rep.errors.push("居中测试（" + samples[si].label + "）异常：" +
              (eOne.message || eOne.toString()));
          }
        }
      } finally {
        // 无论成功失败，临时图层必须删干净
        for (var di = 0; di < made.length; di++) {
          try { if (made[di]) made[di].remove(); } catch (eRm) { }
        }
        try { app.endUndoGroup(); } catch (eUg) { }
      }

      // 判定：误差 ≤1 像素算居中
      var maxAbsDx = 0, maxAbsDy = 0;
      for (var ri = 0; ri < rep.center.results.length; ri++) {
        var rr = rep.center.results[ri];
        if (Math.abs(rr.dx) > maxAbsDx) maxAbsDx = Math.abs(rr.dx);
        if (Math.abs(rr.dy) > maxAbsDy) maxAbsDy = Math.abs(rr.dy);
      }
      rep.center.maxAbsDx = Math.round(maxAbsDx * 100) / 100;
      rep.center.maxAbsDy = Math.round(maxAbsDy * 100) / 100;
      rep.center.allCentered = (rep.center.results.length > 0 && maxAbsDx <= 1 && maxAbsDy <= 1);
      rep.center.layerCountAfterCleanup = comp.numLayers;
    }
  } catch (eC) {
    try { app.endUndoGroup(); } catch (eC2) { }
    rep.errors.push("居中几何测试异常：" + (eC.message || eC.toString()));
  }

  // ---------- 收尾：还原 dirty、写报告 ----------
  try { if (wasDirty !== null) app.project.dirty = wasDirty; } catch (eD) { }

  rep.elapsedMs = new Date().getTime() - t0;
  rep.ok = rep.errors.length === 0;
  rep.reportPath = outPath;

  try {
    var f = new File(AESub_normPath_(outPath));
    if (f.parent && !f.parent.exists) f.parent.create();
    f.encoding = "UTF-8";
    if (f.open("w")) {
      f.write(AESub_toJSON_(rep));
      f.close();
    } else {
      rep.errors.push("报告写不进去（权限或路径问题）：" + outPath);
    }
  } catch (eW) {
    rep.errors.push("写报告异常：" + (eW.message || eW.toString()));
  }

  return AESub_ok_(rep);
}
