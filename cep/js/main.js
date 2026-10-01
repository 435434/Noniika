/**
 * main.js —— 面板控制器
 * ==========================================================
 * 工作流（按用户实际使用方式设计）：
 *   1. 在 AE 的时间线上**选中要处理的素材图层**
 *   2. 面板读取选中图层，算出它们在时间轴上的区间 [rangeStart, rangeEnd]
 *   3. 只把这**一段**音频导出为中间文件（不再导出整段合成，
 *      否则 3 小时的合成会产出近 2GB 静音，必然撞上云端 200MB 上限）
 *   4. 跑 Node 流水线识别，并把字幕时间轴整体平移 offsetSec（= rangeStart）
 *      因为导出文件的时间 0 秒对应合成时间 rangeStart 秒
 *   5. 回到 AE，在同一个合成里创建字幕图层
 *   6. 删除中间音频（可关）
 *
 * 关于 Node 的两层概念（容易搞混，这里说清楚）：
 *   - CEP 面板自己跑在 AE 内置的 Node 上，版本是 17.7.1，**太旧，带不动流水线**
 *   - 所以面板的 Node 只做一件事：spawn 一个**外部 Node（≥18）**去跑 pipeline/cli.js
 *   面板里不引入任何第三方库，只用 child_process / fs / path 这些内置模块。
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------- 常量与状态 */

  // 流水线默认位置（开发期路径；打包后可以改到扩展目录内）
  /** 流水线目录：留空表示「自动探测」（见 detectPipelineDir） */
  var DEFAULT_PIPELINE_DIR = "";
  var MIN_NODE_MAJOR = 18;
  var REFRESH_MS = 2500;          // 时间线选中状态的轮询间隔

  // 字幕位置：垂直 0.5 = 画面正中央（水平恒为画面中线）。
  // 刻意不做成可调项 —— 位置滑杆已按需求移除，这里就是唯一的事实来源。
  var SUBTITLE_Y_PERCENT = 0.5;

  var LS = {
    nodePath: "aesub.nodePath",
    pipelineDir: "aesub.pipelineDir",
    dataDir: "aesub.dataDir",
    outDir: "aesub.outDir",
    maxChars: "aesub.maxChars",
    dropSuspect: "aesub.dropSuspect",
    limitOn: "aesub.limitOn",
    limitMin: "aesub.limitMin",
    keepAudio: "aesub.keepAudio",
    mode: "aesub.mode",
    fontSize: "aesub.fontSize",
    color: "aesub.color",
    createLayers: "aesub.createLayers",
    fontPs: "aesub.fontPs",
    fontLabel: "aesub.fontLabel",
    fontQuery: "aesub.fontQuery",
    favFonts: "aesub.favFonts",
    favPresets: "aesub.favPresets",
    uvrOn: "aesub.uvrOn",
    uvrTarget: "aesub.uvrTarget",
    uvrModel: "aesub.uvrModel",
    uvrFormat: "aesub.uvrFormat",
    uvrKeep: "aesub.uvrKeep",
    uvrPython: "aesub.uvrPython",
    uvrGpu: "aesub.uvrGpu",
    subPrefix: "aesub.subPrefix",
    nameMode: "aesub.nameMode",
    snapSpeech: "aesub.snapSpeech",
    stripPunct: "aesub.stripPunct",
    skipPresetShort: "aesub.skipPresetShort",
    presetPath: "aesub.presetPath",
    presetLabel: "aesub.presetLabel",
    // ---- 识别引擎（服务商无关）----
    // ⚠ 密钥存在面板的 localStorage 里（CEP 的存档，明文）。
    //   这是"免登录、开箱即用"与"密钥安全"之间的取舍：不做系统级加密存储，
    //   界面上会明确告知用户；介意的话可以用环境变量 AESUB_API_KEY 代替填面板。
    asrProfile: "aesub.asrProfile",
    // ---- 本地引擎（whisper.cpp）----
    localModel: "aesub.localModel",
    localRuntime: "aesub.localRuntime",
    localGpu: "aesub.localGpu",
    asrApiKey: "aesub.asrApiKey",
    asrSecretId: "aesub.asrSecretId",
    asrSecretKey: "aesub.asrSecretKey",
    asrModel: "aesub.asrModel",
    asrBaseUrl: "aesub.asrBaseUrl",
    asrPrompt: "aesub.asrPrompt",
    asrChunk: "aesub.asrChunk",
    settingsVersion: "aesub.settingsVersion"
  };

  var SETTINGS_VERSION = "0.4.0";
  var MIGRATE_NOTE = null;     // 存档迁移时要说给用户听的话

  /** 默认分离模型：速度快、体积小，任何设备都能跑（下拉里按质量排序，它不在第一位） */
  var MODEL_DEFAULT = "Kim_Vocal_2.onnx";

  /** 字体搜索一次最多回多少个家族（AE 侧上限 200）。给足量，避免"搜到了但被截断" */
  var FONT_LIMIT = 120;
  // 拼音搜索要一次拿全字体清单（面板侧过滤）。AE 侧原来的上限是 200，
  // 字体多的机器会被截断 —— 所以这里显式要大值，桥接层也同步放开了上限。
  var FONT_INDEX_LIMIT = 4000;

  /**
   * 预设分类的中文别名。
   *
   * 为什么需要：AE 中文版里**预设名是中文**（"从底部飞入"），但**分类名仍是英文**
   * （"Animate In"）。用户搜"入场""退出"这类词时，光靠分类英文名匹配不到，
   * 于是明明有 40 个入场预设却搜出 0 个 —— 这里把分类的中文说法补上。
   */
  var PRESET_CAT_ALIASES = {
    "3D Text": "3D 文字 立体",
    "Animate In": "入场 进入 出现 引入",
    "Animate Out": "出场 退出 离开 消失",
    "Blurs": "模糊",
    "Curves and Spins": "曲线 旋转 回旋 螺旋",
    "Expressions": "表达式 脚本",
    "Fill and Stroke": "填充 描边 颜色",
    "Graphical": "图形 形状",
    "Lights and Optical": "灯光 光效 光学",
    "Mechanical": "机械 仪表",
    "Miscellaneous": "杂项 其他 综合",
    "Multi-Line": "多行 整段",
    "Number Counters": "计数器 数字 计时",
    "Organic": "自然 有机 生长",
    "Paths": "路径 轨迹",
    "Rotation": "旋转 转动",
    "Scale": "缩放 放大 缩小",
    "Tracking": "字距 间距 字符"
  };

  var PAGE_TITLES = { home: "首页", uvr: "人声分离", style: "字幕样式", set: "设置" };

  /**
   * 分离模型走哪个推理后端 —— 决定它能不能吃到 GPU 加速。
   *   .onnx（MDX-Net）→ onnxruntime
   *   .ckpt / .yaml（Roformer / Demucs）→ torch
   * 两个后端相互独立，装了一个不代表另一个也能加速（实测过）。
   */
  function modelBackend(name) {
    var n = String(name || "").toLowerCase();
    if (/\.onnx$/.test(n)) return "onnx";
    if (/\.(ckpt|yaml|yml|pth|th)$/.test(n)) return "torch";
    return "unknown";
  }

  /** 大模型（Roformer / Demucs）：质量高、体积大、CPU 上几乎跑不动 */
  function isHeavyModel(name) {
    return /roformer|demucs/i.test(String(name || ""));
  }

  var el = {};                 // DOM 引用
  var node = null;             // { child_process, fs, path, os } 或 null
  var state = {
    env: null,                 // 环境探测结果
    sel: null,                 // 时间线选中素材的体检结果
    project: null,             // 项目信息
    running: false,
    lastOutDir: null,
    midAudio: null,            // 本次导出的中间音频路径（用于清理）
    selSig: "",                // 选中状态的指纹，避免无意义的 DOM 重绘
    fontPs: "",                // 选中的字体 PostScript 名（空 = 跟随 AE 默认）
    fontLabel: "",             // 字体的显示名，如 "Source Han Sans SC Bold"
    fontTimer: null,           // 字体搜索的防抖定时器
    page: "home",              // 当前页
    presetPath: "",            // 选中的 .ffx 绝对路径（空 = 不用预设）
    presetLabel: "",
    presetQuery: "",           // 预设搜索关键词（纯前端过滤，不往返 AE）
    presets: null,             // { builtin: {dir, cats:[]}, user: {...} }
    uvr: null,                 // 人声分离依赖检测结果
    uvrBusy: false,
    busyClean: false,      // 清理任务进行中（内存/文件/模型互斥）
    lastPlaced: null,          // 本次落轨结果（给结果卡片显示用）
    asrProfiles: null,         // 从 cli.js --list-asr 拿到的引擎档位清单
    asrModelList: null,        // 从服务商实时拉到的模型清单（优先于档位内置清单）
    asrLoaded: false,          // 档位是否已加载（避免重复拉起子进程）
    asrLocalStatus: null,      // 本地引擎环境快照（cli.js --local-status 的返回）
    localBusy: false           // 本地引擎的下载/清理进行中
  };

  /* ---------------------------------------------------------- 基础工具 */

  function getNodeBuiltins() {
    try {
      if (typeof require === "function") {
        return {
          child_process: require("node:child_process"),
          fs: require("node:fs"),
          path: require("node:path"),
          os: require("node:os"),
          crypto: require("node:crypto"),
          process: require("node:process")
        };
      }
    } catch (e) { /* 未开启 nodejs，下面会给出明确提示 */ }
    return null;
  }

  /** 用正斜杠拼路径：Windows 完全接受，且省掉处理反斜杠转义的麻烦 */
  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = arguments[i];
      if (p === undefined || p === null || p === "") continue;
      parts.push(String(p).replace(/[\\/]+$/, ""));
    }
    return parts.join("/").replace(/([^:])\/{2,}/g, "$1/");
  }

  /** 把合成名等转成安全的文件名 */
  function safeName(s) {
    return String(s || "subtitle")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "subtitle";
  }

  var PANEL_LOG = null;   // 面板日志同时落盘：出问题时可直接读文件排障，不用截图

  function log(msg, cls) {
    var line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = msg;
    el.log.appendChild(line);
    el.log.scrollTop = el.log.scrollHeight;
    try {
      if (!node) return;
      if (!PANEL_LOG) PANEL_LOG = joinPath(node.os.tmpdir(), "ae-subtitle", "panel.log");
      var dir = node.path.dirname(PANEL_LOG);
      if (!node.fs.existsSync(dir)) node.fs.mkdirSync(dir, { recursive: true });
      node.fs.appendFileSync(
        PANEL_LOG,
        "[" + new Date().toLocaleTimeString() + "]" + (cls ? "[" + cls + "]" : "") + " " + msg + "\r\n",
        "utf8"
      );
    } catch (e) { /* 落盘失败绝不能影响面板本身 */ }
  }

  function clearLog() { el.log.innerHTML = ""; }

  function setStatus(text, cls) {
    el.status.textContent = text || "";
    el.status.style.color = cls === "err" ? "#f09a9a" : cls === "ok" ? "#7ddba3" : "#a8a8a8";
  }

  function setProgress(pct) {
    el.bar.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
  }

  function setBadge(text, cls) {
    el.envBadge.textContent = text;
    el.envBadge.className = "badge" + (cls ? " " + cls : "");
  }

  /* ---------------------------------------------------------- v0.9.1 新组件 */

  /** 密钥是否已配置（与 collectParams 的拦截规则严格同源，别处不许再抄一份） */
  function engineKeyReady() {
    var p = currentAsrProfile();
    if (!p) return true;                       // 清单没加载时不吓人
    var envKey = "";
    try {
      envKey = (typeof process !== "undefined" && process.env && process.env.AESUB_API_KEY) || "";
    } catch (e) { /* 取不到就当没有 */ }
    if (p.keyMode === "pair") {
      return !!(el.asrSecretId.value.trim() && el.asrSecretKey.value.trim());
    }
    if (p.needsKey === false) return true;
    return !!(el.asrApiKey.value.trim() || envKey);
  }

  /** 识别引擎状态条（首页）：引擎 / 模型（标出档位默认）/ 密钥状态 */
  function syncEngineBar() {
    if (!el.engBar || !el.engBarText) return;   // 老版 HTML 没有该组件时静默退出
    var opt = el.asrProfile.options[el.asrProfile.selectedIndex];
    var pname = opt ? String(opt.textContent).split("（")[0].trim() : "识别引擎";
    var p = currentAsrProfile();
    var chosen = el.asrModel.value.trim();
    var modelTxt = chosen || (p && p.model ? p.model + "（档位默认）" : "（未指定）");
    var keyOk = engineKeyReady();
    el.engBar.classList.toggle("bad", !keyOk);
    if (el.engBarDot) el.engBarDot.className = "dot" + (keyOk ? " ok" : " bad");
    el.engBarText.innerHTML = pname + " <b>/ " + modelTxt + "</b> · " +
      (keyOk ? "密钥已配置"
             : "<span class='errText'>未配置密钥 —— 点「更改」去设置页填写</span>");
  }

  /** 流程步骤条：idx 之前的格全 done、idx 当前 on、之后 pending；4 = 全 done；-1 = 全待办 */
  function setStepCells(idx) {
    if (!el.steps) return;
    var cells = ["stExport", "stSep", "stAsr", "stLayer"];
    for (var i = 0; i < cells.length; i++) {
      var c = el[cells[i]];
      if (!c) continue;
      var st = "";
      if (idx === 4 || i < idx) st = " done";
      else if (i === idx) st = " on";
      c.className = "st" + st;
    }
  }

  /** 流水线 step 名 → 步骤格序号；limit 封顶（只分离流程到「分离」为止） */
  function markPipelineStep(step, limit) {
    if (!el.steps) return;
    var map = {
      deps: 0, probe: 0, transcode: 0, speech: 0,
      "separate-deps": 1, "separate-prep": 1, separate: 1,
      "asr-config": 2, transcribe: 2, postprocess: 2, snap: 2, punct: 2, offset: 2, write: 2,
      done: 4
    };
    if (!(step in map)) return;
    var lim = (limit === undefined) ? 3 : limit;
    setStepCells(Math.min(map[step], lim));
  }

  /** 设置页环境状态网格（数据与 envDetail 同源，只是换一种扫一眼的形态） */
  function renderEnvGridSet(ae, n) {
    if (!el.envGridSet) return;
    var ok = ae && ae.ok;
    el.envGridSet.innerHTML =
      '<div class="er ' + (n ? "" : "off") + '"><span class="dot"></span>外部 Node<b>' +
      ((n && n.version) ? n.version : "未找到") + "</b></div>" +
      '<div class="er ' + (ok ? "" : "bad") + '"><span class="dot"></span>AE 探测<b>' +
      (ok ? "AE " + ae.data.aeVersion : "失败") + "</b></div>" +
      '<div class="er ' + (ok && ae.data.canExportAudio ? "" : "bad") + '"><span class="dot"></span>音频导出<b>' +
      (ok ? (ae.data.canExportAudio ? "可用" : "不可用") : "未知") + "</b></div>" +
      '<div class="er ' + (node ? "" : "off") + '"><span class="dot"></span>面板内 Node<b>' +
      (node ? "已启用" : "未启用") + "</b></div>";
  }

  /** 用系统默认程序打开单个产物文件 */
  function openFilePath(p) {
    if (!p || !node) return;
    try {
      node.child_process.exec('start "" "' + String(p).replace(/\\/g, "\\\\") + '"');
      setStatus("已打开：" + p);
    } catch (e) { setStatus("打开文件失败：" + e.message, "err"); }
  }

  /** 把 [960,540,0] 这类数组写成 "(960,540)"（日志里读着舒服） */
  function json2(a) {
    if (!a || typeof a.length !== "number") return "?";
    var out = [];
    for (var i = 0; i < Math.min(a.length, 2); i++) out.push(Math.round(Number(a[i])));
    return "(" + out.join(",") + ")";
  }

  function fmtSec(n, digits) {
    var d = (digits === undefined) ? 2 : digits;
    return (Math.round(Number(n || 0) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
  }

  /** 把秒数说成"3 分 12 秒"这样人一眼能读懂的形式 */
  function humanSec(n) {
    var s = Math.max(0, Number(n) || 0);
    if (s < 60) return fmtSec(s) + " 秒";
    var m = Math.floor(s / 60);
    var rest = Math.round(s - m * 60);
    return m + " 分 " + rest + " 秒";
  }

  function fmtBytes(b) {
    var n = Number(b) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  /* ---------------------------------------------------------- 设置读写 */

  function lsGet(k, dflt) {
    try {
      var v = window.localStorage.getItem(k);
      return v === null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, String(v)); } catch (e) { }
  }
  function lsGetBool(k, dflt) {
    var v = lsGet(k, null);
    return v === null ? dflt : v === "true";
  }

  /* ---------------------------------------------------------- 收藏夹（字体 / 预设） */

  /**
   * 收藏存成 [{v: 下拉里的 value, t: 显示名}]。
   * v 对字体是 PostScript 名、对预设是 .ffx 的完整路径 —— 都是稳定标识，
   * 所以下次开面板、甚至换台机器，只要字体/预设还在，收藏就依然点得到
   * （不在机器上的自然不会出现在列表里，也不会报错）。
   */
  function favGet(key) {
    var raw = lsGet(key, "");
    if (!raw) return [];
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { return []; }   // 存档损坏就当空，不能让面板起不来
    if (!arr || typeof arr.length !== "number") return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (it && typeof it.v === "string" && it.v) {
        out.push({ v: it.v, t: String(it.t || it.v) });
      }
    }
    return out;
  }

  function favSave(key, arr) {
    try { window.localStorage.setItem(key, JSON.stringify(arr)); } catch (e) { }
  }

  function favIndexOf(list, v) {
    for (var i = 0; i < list.length; i++) { if (list[i].v === v) return i; }
    return -1;
  }

  function favHas(key, v) { return favIndexOf(favGet(key), v) >= 0; }

  /** 切换收藏，返回切换后是否「已收藏」。新收藏放最前面（最近收的优先看到） */
  function favToggle(key, v, t) {
    var list = favGet(key);
    var i = favIndexOf(list, v);
    if (i >= 0) { list.splice(i, 1); favSave(key, list); return false; }
    list.unshift({ v: v, t: t });
    favSave(key, list);
    return true;
  }

  /** 收藏项按关键词过滤（显示名和值都参与匹配）；空关键词返回全部 */
  function favFilter(key, query) {
    var list = favGet(key);
    var q = String(query || "").toLowerCase();
    if (!q) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if ((it.t + " " + it.v).toLowerCase().indexOf(q) >= 0) out.push(it);
    }
    return out;
  }

  /** 值的查找表，用来在普通搜索结果里跳过已收藏的项（免得同一个字体列两遍） */
  function favValueMap(list) {
    var m = {};
    for (var i = 0; i < list.length; i++) m[list[i].v] = 1;
    return m;
  }

  /** 星标状态跟随「当前选中的字体」：实心 ★ = 已收藏，空心 ☆ = 未收藏 */
  function syncFavFont() {
    if (!el.btnFavFont) return;
    var v = el.fontSelect.value || "";
    var has = v ? favHas(LS.favFonts, v) : false;
    el.btnFavFont.textContent = has ? "★" : "☆";
    el.btnFavFont.classList.toggle("on", has);
    el.btnFavFont.disabled = !v;
    el.btnFavFont.title = !v ? "先在列表里选一个字体"
      : (has ? "已收藏（点一下取消收藏）" : "收藏这个字体 —— 下次它在列表顶部，一点即用");
  }

  /** 星标状态跟随「当前选中的预设」 */
  function syncFavPreset() {
    if (!el.btnFavPreset) return;
    var v = el.presetSelect.value || "";
    var has = v ? favHas(LS.favPresets, v) : false;
    el.btnFavPreset.textContent = has ? "★" : "☆";
    el.btnFavPreset.classList.toggle("on", has);
    el.btnFavPreset.disabled = !v;
    el.btnFavPreset.title = !v ? "先在列表里选一个预设"
      : (has ? "已收藏（点一下取消收藏）" : "收藏这个预设 —— 下次它在列表顶部，一点即用");
  }

  /** 当前下拉里选中项的显示名（收藏时一并记下来，用于在收藏组里显示） */
  function selectedLabel(sel) {
    var o = sel && sel.options ? sel.options[sel.selectedIndex] : null;
    var t = o ? String(o.textContent || "") : "";
    return t.replace(/^★\s*/, "").trim();
  }

  /**
   * 一次性存档迁移。
   *
   * 0.3.3 之前「在 AE 中创建字幕图层」这个总开关藏在折叠的「字幕样式」菜单里，
   * 很容易被误关；而关掉之后的表现是"面板说完成了、时间线上却什么都没有"，极难自查。
   * 所以老存档里若它是关的，这里恢复成默认开启，并在日志里明说（不偷偷改）。
   */
  function migrateSettings() {
    try {
      if (lsGet(LS.settingsVersion, "") === "") {
        if (lsGet(LS.createLayers, null) === "false") {
          lsSet(LS.createLayers, "true");
          MIGRATE_NOTE = "已把「在 AE 中创建字幕图层」恢复为开启 —— 它以前藏在折叠菜单里，容易被误关。";
        }
      }
      lsSet(LS.settingsVersion, SETTINGS_VERSION);
    } catch (e) { }
  }

  function loadSettings() {
    el.nodePath.value = lsGet(LS.nodePath, "");
    // 用户手填优先；没填就自动探测（分发包里 pipeline 就在扩展目录下）
    el.pipelineDir.value = lsGet(LS.pipelineDir, "") || detectPipelineDir();
    el.dataDir.value = lsGet(LS.dataDir, "");
    el.outDir.value = lsGet(LS.outDir, "");
    el.maxChars.value = lsGet(LS.maxChars, "16");
    el.dropSuspect.checked = lsGetBool(LS.dropSuspect, false);
    el.limitOn.checked = lsGetBool(LS.limitOn, true);
    el.limitMin.value = lsGet(LS.limitMin, "10");
    el.keepAudio.checked = lsGetBool(LS.keepAudio, false);
    el.mode.value = lsGet(LS.mode, "layers");
    el.fontSize.value = lsGet(LS.fontSize, "72");
    el.color.value = lsGet(LS.color, "#ffe600");
    el.createLayers.checked = lsGetBool(LS.createLayers, true);

    el.uvrOn.checked = lsGetBool(LS.uvrOn, false);
    el.uvrTarget.value = lsGet(LS.uvrTarget, "vocals");
    el.uvrModel.value = lsGet(LS.uvrModel, MODEL_DEFAULT);
    el.uvrFormat.value = lsGet(LS.uvrFormat, "WAV");
    el.uvrKeep.checked = lsGetBool(LS.uvrKeep, false);
    el.uvrPython.value = lsGet(LS.uvrPython, "");
    el.uvrGpu.checked = lsGetBool(LS.uvrGpu, true);
    el.subPrefix.value = lsGet(LS.subPrefix, "字幕");
    el.snapSpeech.checked = lsGetBool(LS.snapSpeech, true);
    el.stripPunct.checked = lsGetBool(LS.stripPunct, false);   // 默认关：保留标点
    el.skipPresetShort.checked = lsGetBool(LS.skipPresetShort, true);
    el.nameMode.value = lsGet(LS.nameMode, "text");

    // 识别引擎：档位下拉是异步从 cli.js 拉的，这里先恢复"用户填过的东西"
    el.asrApiKey.value = lsGet(LS.asrApiKey, "");
    el.asrSecretId.value = lsGet(LS.asrSecretId, "");
    el.asrSecretKey.value = lsGet(LS.asrSecretKey, "");
    el.asrModel.value = lsGet(LS.asrModel, "");
    el.asrBaseUrl.value = lsGet(LS.asrBaseUrl, "");
    el.asrPrompt.value = lsGet(LS.asrPrompt, "");
    el.asrChunk.checked = lsGetBool(LS.asrChunk, true);

    // 本地引擎：档位下拉的选项由 --local-status 铺（这里先把用户选过的档位恢复出来）
    el.localModel.value = lsGet(LS.localModel, "medium");
    el.localRuntime.value = lsGet(LS.localRuntime, "blas");   // 默认 BLAS：小、下得动
    el.localGpu.checked = lsGetBool(LS.localGpu, true);

    // 下拉里没有这个值时（比如换了模型版本）就退回第一项，避免 value 变成空串
    if (el.uvrTarget.selectedIndex < 0) el.uvrTarget.selectedIndex = 0;
    if (el.uvrFormat.selectedIndex < 0) el.uvrFormat.selectedIndex = 0;
    if (el.uvrModel.selectedIndex < 0) {
      // ⚠ 模型这里必须退到"默认项"而不是"第 0 项"：
      //   下拉是按质量排序的，第 0 项现在是 871 MB 的大模型，
      //   让用户莫名其妙跑上最慢的模型是最糟糕的兜底。
      var di = -1;
      for (var mi = 0; mi < el.uvrModel.options.length; mi++) {
        if (el.uvrModel.options[mi].value === MODEL_DEFAULT) { di = mi; break; }
      }
      el.uvrModel.selectedIndex = di >= 0 ? di : 0;
    }

    state.presetPath = lsGet(LS.presetPath, "");
    state.presetLabel = lsGet(LS.presetLabel, "");

    // 清掉旧版本留下的"垂直位置"存档（滑杆已移除，留着是没人读的死数据）
    try { window.localStorage.removeItem("aesub.yPercent"); } catch (e) { }
  }

  function saveSettings() {
    lsSet(LS.nodePath, el.nodePath.value.trim());
    lsSet(LS.pipelineDir, el.pipelineDir.value.trim());
    lsSet(LS.dataDir, el.dataDir.value.trim());
    lsSet(LS.outDir, el.outDir.value.trim());
    lsSet(LS.maxChars, el.maxChars.value);
    lsSet(LS.dropSuspect, el.dropSuspect.checked);
    lsSet(LS.limitOn, el.limitOn.checked);
    lsSet(LS.limitMin, el.limitMin.value);
    lsSet(LS.keepAudio, el.keepAudio.checked);
    lsSet(LS.mode, el.mode.value);
    lsSet(LS.fontSize, el.fontSize.value);
    lsSet(LS.color, el.color.value);
    lsSet(LS.createLayers, el.createLayers.checked);
    lsSet(LS.uvrOn, el.uvrOn.checked);
    lsSet(LS.uvrTarget, el.uvrTarget.value);
    lsSet(LS.uvrModel, el.uvrModel.value);
    lsSet(LS.uvrFormat, el.uvrFormat.value);
    lsSet(LS.uvrKeep, el.uvrKeep.checked);
    lsSet(LS.uvrPython, el.uvrPython.value.trim());
    lsSet(LS.uvrGpu, el.uvrGpu.checked);
    lsSet(LS.subPrefix, (el.subPrefix.value.trim() || "字幕"));
    lsSet(LS.snapSpeech, el.snapSpeech.checked);
    lsSet(LS.stripPunct, el.stripPunct.checked);
    lsSet(LS.skipPresetShort, el.skipPresetShort.checked);
    lsSet(LS.nameMode, el.nameMode.value);
    lsSet(LS.presetPath, state.presetPath || "");
    lsSet(LS.presetLabel, state.presetLabel || "");
    // 识别引擎
    lsSet(LS.asrProfile, el.asrProfile.value || "siliconflow");
    lsSet(LS.localModel, el.localModel.value);
    lsSet(LS.localRuntime, el.localRuntime.value);
    lsSet(LS.localGpu, el.localGpu.checked);
    lsSet(LS.asrApiKey, el.asrApiKey.value.trim());
    lsSet(LS.asrSecretId, el.asrSecretId.value.trim());
    lsSet(LS.asrSecretKey, el.asrSecretKey.value.trim());
    lsSet(LS.asrModel, el.asrModel.value.trim());
    lsSet(LS.asrBaseUrl, el.asrBaseUrl.value.trim());
    lsSet(LS.asrPrompt, el.asrPrompt.value.trim());
    lsSet(LS.asrChunk, el.asrChunk.checked);
  }

  /* ---------------------------------------------------------- Node 定位 */

  function probeNodeVersion(exe) {
    try {
      var out = node.child_process.execFileSync(exe, ["-v"], {
        encoding: "utf8", windowsHide: true, timeout: 8000
      });
      return String(out).trim();
    } catch (e) { return null; }
  }

  function findNode() {
    var manual = el.nodePath.value.trim();
    if (manual) {
      var v = probeNodeVersion(manual);
      if (!v) return { error: "指定的 Node 路径无法执行：" + manual };
      var maj = parseInt(v.replace(/^v/, "").split(".")[0], 10);
      if (!(maj >= MIN_NODE_MAJOR)) return { error: "指定 Node 版本过低（" + v + "），需要 " + MIN_NODE_MAJOR + " 及以上" };
      return { path: manual, version: v };
    }

    var cands = [];
    // ① 随插件分发的 Node 运行时**优先** —— 保证别人机器上没装 Node 也能直接用，
    //    而且版本是打包时验证过的那个（不随用户环境漂移）。
    try {
      var extDir = CepBridge.extensionPath();
      if (extDir) cands.push(joinPath(extDir, "node-runtime", "node.exe"));
    } catch (eExt) { }
    // ② 系统装的 Node
    try {
      var out = node.child_process.execSync("where node", { encoding: "utf8", windowsHide: true, timeout: 8000 });
      String(out).split(/\r?\n/).forEach(function (l) { if (l.trim()) cands.push(l.trim()); });
    } catch (e) { /* where 失败就继续用候选列表 */ }
    cands.push("C:\\Program Files\\nodejs\\node.exe");
    cands.push("C:\\Program Files (x86)\\nodejs\\node.exe");

    var seen = {};
    for (var i = 0; i < cands.length; i++) {
      if (seen[cands[i]]) continue;
      seen[cands[i]] = 1;
      var ver = probeNodeVersion(cands[i]);
      if (!ver) continue;
      var major = parseInt(ver.replace(/^v/, "").split(".")[0], 10);
      if (major >= MIN_NODE_MAJOR) return { path: cands[i], version: ver };
    }
    return { error: "没找到 Node " + MIN_NODE_MAJOR + " 或更高版本。" +
      "本插件通常会自带一份运行时（node-runtime 文件夹）—— 若被你删掉了，" +
      "可到 nodejs.org 装一个 LTS 版，或在「环境与诊断」里手动指定 node.exe 路径。" };
  }

  /* ---------------------------------------------------------- 环境检测 */

  function probeEnvironment() {
    setBadge("检测中…", "");
    var problems = [];

    if (!node) {
      problems.push("面板内的 Node 未启用（检查 manifest 里的 --enable-nodejs）");
    }

    var n = null;
    if (node) {
      n = findNode();
      if (n.error) problems.push(n.error);
    } else {
      problems.push("无法检测外部 Node");
    }

    var cliPath = joinPath(el.pipelineDir.value.trim(), "cli.js");
    var hasCli = false;
    if (node) {
      try { hasCli = node.fs.existsSync(cliPath); } catch (e) { }
    }
    if (!hasCli) problems.push("找不到流水线入口：" + cliPath);

    if (hasCli && node) {
      // 新架构下识别不再依赖任何 npm 包（走 lib/providers/ 的纯 HTTP 适配器），
      // 所以这里检查的是"流水线是不是新版"，而不是"装了哪个第三方库"。
      var provDir = joinPath(el.pipelineDir.value.trim(), "lib/providers");
      try {
        if (!node.fs.existsSync(provDir)) {
          problems.push("流水线版本过旧（缺少 lib/providers/），请更新到 v0.9.0 或更高版本");
        }
      } catch (e) { }
      // ffmpeg 是硬依赖：随包 vendor 里有就用它，否则要能从 PATH 找到
      var vendFf = joinPath(el.pipelineDir.value.trim(), "vendor/ffmpeg/ffmpeg.exe");
      try {
        if (!node.fs.existsSync(vendFf)) {
          log("提示：随包 ffmpeg 不存在（" + vendFf + "），将尝试用系统 PATH 里的 ffmpeg。", "warn");
        }
      } catch (e) { }
    }

    AeApi.probeEnvironment().then(function (res) {
      var detail = [];
      if (res.ok) {
        detail.push("AE " + res.data.aeVersion);
        detail.push("输出模板 " + res.data.templateCount + " 个");
        detail.push("音频导出：" + (res.data.canExportAudio
          ? ("可用 → " + res.data.resolvedTemplate + "（" + res.data.resolvedFormat + "）")
          : "不可用"));
        if (!res.data.canExportAudio) problems.push(res.data.hint || "AE 侧无法导出音频");
      } else {
        problems.push("AE 探测失败：" + res.error);
      }

      state.env = {
        node: n && n.path ? n : null,
        problems: problems,
        ae: res.ok ? res.data : null
      };
      el.envDetail.textContent = detail.join(" · ");
      renderEnvGridSet(res, n);

      if (problems.length) {
        setBadge("环境有问题", "bad");
        problems.forEach(function (p) { log("× " + p, "err"); });
        setStatus("环境未就绪，请按上面的提示处理后点「重新检测环境」", "err");
      } else {
        setBadge("就绪", "ok");
        log("√ 环境就绪：外部 Node " + n.version +
          " · 音频导出走 " + res.data.resolvedTemplate + "（" + res.data.resolvedFormat + "）", "ok");
      }
      updateRunButton();
      // 环境确定后顺手把识别引擎清单拉一遍（下拉框要它才能填满）
      if (!state.asrLoaded) loadAsrProfiles();
    });
  }

  /* ---------------------------------------------------------- 读取时间线选中的素材 */

  function refreshSelection() {
    var limitSec = currentLimitSec();
    return AeApi.getTimelineSelection(limitSec).then(function (res) {
      if (!res.ok) {
        state.sel = null;
        el.selInfo.innerHTML = '<span class="errText">读取失败：' + res.error + "</span>";
        el.selHint.textContent = "";
        updateRunButton();
        return;
      }
      var d = res.data;
      state.sel = d;
      state.project = d.project;

      var sig = [
        d.hasComp, d.compName, d.compDuration, d.selectedLayerCount,
        d.autoPicked, d.ready, d.rangeStart, d.rangeEnd, limitSec, d.hint
      ].join("|");
      if (sig === state.selSig) { updateRunButton(); return; }   // 没变化就不重绘，避免闪烁
      state.selSig = sig;

      renderSelection(d);
      updateRunButton();
    });
  }

  function renderSelection(d) {
    if (!d.hasComp) {
      el.selInfo.textContent = "未检测到合成时间线";
      el.selHint.textContent = d.hint || "请双击进入一个合成，然后在时间线上选中要处理的素材。";
      return;
    }

    var rows = [];
    rows.push('<span class="k">合成</span>' + d.compName +
      "（" + d.compWidth + "×" + d.compHeight + "，" + humanSec(d.compDuration) + "）");

    if (!d.ready) {
      rows.push('<span class="k">素材</span><span class="errText">没有可用的音频</span>');
      el.selInfo.innerHTML = rows.join("<br>");
      el.selHint.innerHTML = '<span class="errText">' + (d.hint || "未知原因") + "</span>";
      return;
    }

    if (d.autoPicked) {
      rows.push('<span class="k">素材</span>未选中图层，将处理合成内全部 ' + d.audioLayerCount + " 个音频图层");
    } else {
      var names = (d.layerNames || []).join("、");
      rows.push('<span class="k">素材</span>' + d.selectedLayerCount + " 个图层已选中，其中 " +
        d.audioLayerCount + " 个带音频");
      rows.push('<span class="k">名称</span>' + (names.length > 60 ? names.slice(0, 60) + "…" : names));
    }

    rows.push('<span class="k">区间</span>' + fmtSec(d.rangeStart) + " ~ " + fmtSec(d.rangeEnd) +
      " 秒（" + humanSec(d.rangeDuration) + "）");
    el.selInfo.innerHTML = rows.join("<br>");

    var hints = [];
    if (d.truncated) {
      hints.push('<span class="warnText">⚠ 素材长 ' + humanSec(d.truncatedFrom) +
        "，已按设置截断为前 " + humanSec(d.rangeDuration) + "</span>");
    } else {
      hints.push("预计导出约 " + fmtBytes(d.estimatedExportBytes) +
        " 的无损音频，之后转 16kHz 单声道上传。");
    }
    if (d.rangeStart > 0.001) {
      hints.push("字幕会自动平移到合成时间轴的 " + fmtSec(d.rangeStart) + " 秒处。");
    }
    el.selHint.innerHTML = hints.join("<br>");
  }

  function currentLimitSec() {
    if (!el.limitOn || !el.limitOn.checked) return 0;
    var m = parseInt(el.limitMin.value, 10);
    if (!(m >= 1 && m <= 120)) return 0;   // 填了非法值就当不限制，由流水线的体积守卫兜底
    return m * 60;
  }

  function updateRunButton() {
    var envOk = state.env && state.env.problems.length === 0;
    var selOk = state.sel && state.sel.ready;
    el.btnRun.disabled = state.running || !envOk || !selOk;
    el.btnSeparate.disabled = state.running || !envOk || !selOk;
    el.btnTest.disabled = state.running || !selOk;
    el.btnRefresh.disabled = state.running;
    if (el.btnRebuild) el.btnRebuild.disabled = state.running || !selOk;
    syncEngineBar();
  }

  /* ---------------------------------------------------------- 字体（搜索 + 拾取） */

  /** 0~1 的 RGB 数组 → #rrggbb，用于回填颜色选择器 */
  function rgbToHex(c) {
    function h(v) {
      var n = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
      var s = n.toString(16);
      return s.length === 1 ? "0" + s : s;
    }
    return "#" + h(c[0]) + h(c[1]) + h(c[2]);
  }

  /**
   * 保证"当前已选字体"一定出现在下拉里。
   * 否则搜索结果里恰好没有它时，下拉会显示成别的字体，而实际用的还是旧字体——
   * 这种"看到的和生效的不一致"最难排查，必须堵掉。
   */
  function ensureCurrentFontOption() {
    if (!state.fontPs) return;
    for (var k = 0; k < el.fontSelect.options.length; k++) {
      if (el.fontSelect.options[k].value === state.fontPs) {
        el.fontSelect.selectedIndex = k;
        return;
      }
    }
    var cur = document.createElement("option");
    cur.value = state.fontPs;
    cur.textContent = "（当前）" + (state.fontLabel || state.fontPs);
    el.fontSelect.insertBefore(cur, el.fontSelect.firstChild);
    el.fontSelect.selectedIndex = 0;
  }

  /** 把搜索结果填进下拉框 */
  function renderFontOptions(res) {
    var d = (res && res.data) ? res.data : {};
    el.fontSelect.innerHTML = "";

    function only(text, disabledInput) {
      var o = document.createElement("option");
      o.value = "";
      o.textContent = text;
      el.fontSelect.appendChild(o);
      el.fontQuery.disabled = !!disabledInput;
    }

    if (d.available === false) {
      only("（当前 AE 版本不支持字体列表，请用「拾取」）", true);
      el.fontNow.textContent = d.hint || "当前 AE 版本不支持字体列表";
      el.fontNow.className = "hint";
      return;
    }

    // AE 的字体服务还没就绪（刚启动 AE 后很常见）——说清楚，别让用户以为"系统里没字体"
    if (d.ready === false) {
      only("（AE 字体列表还没准备好，点上面的「刷新字体列表」）", false);
      el.fontCount.textContent = "";
      el.fontNow.textContent = d.note || "AE 的字体列表还没准备好";
      el.fontNow.className = "hint warnText";
      log("⚠ 字体列表尚未就绪：" + (d.note || ""), "warn");
      return;
    }

    var fams = d.families || [];
    var total = d.totalFamilies || 0;
    var q = d.query || "";

    // 收藏的字体置顶。收藏项**不依赖 AE 的搜索结果**（显示名本地就有），
    // 所以哪怕当前关键词筛不到它，也照样一点即用 —— 这正是收藏的意义。
    var favAll = favGet(LS.favFonts);
    var favShown = favFilter(LS.favFonts, q);
    if (favShown.length) {
      var fgrp = document.createElement("optgroup");
      fgrp.label = "★ 收藏的字体";
      el.fontSelect.appendChild(fgrp);
      for (var fi = 0; fi < favShown.length; fi++) {
        var fopt = document.createElement("option");
        fopt.value = favShown[fi].v;
        fopt.textContent = "★ " + favShown[fi].t;
        fgrp.appendChild(fopt);
      }
    }
    var favMap = favValueMap(favAll);   // 搜索结果里跳过已收藏的，免得同一个字体列两遍

    if (fams.length === 0) {
      only(favShown.length ? "（除收藏之外没有其他匹配）" : "（没有匹配的字体，换个关键词试试）", false);
      el.fontCount.textContent = "AE 里共 " + total + " 个字体家族，0 个匹配" +
        (favShown.length ? "（另有 " + favShown.length + " 个收藏）" : "");
      el.fontCount.className = "hint warnText";
      ensureCurrentFontOption();
      log("字体搜索「" + q + "」无命中（AE 里共 " + total + " 个家族）——" +
        "换更短的词试试，或直接用拼音 / 首字母（如 ruizi、rz）；" +
        "若确定系统里装了该字体，点「刷新字体列表」重扫一次", "warn");
      return;
    }

    for (var i = 0; i < fams.length; i++) {
      var fam = fams[i];
      var famLabel = fam.nativeName || fam.family;
      for (var j = 0; j < fam.styles.length; j++) {
        var st = fam.styles[j];
        if (favMap[st.ps]) continue;      // 已在上面的收藏组里
        var opt = document.createElement("option");
        opt.value = st.ps;
        // 样式名优先用本地化的（桥接层给的字段是 nativeStyle；旧代码写成 nativeNameStyle，
        // 拼错导致永远取不到，下拉里只能显示英文样式名）
        opt.textContent = famLabel + " · " + (st.nativeStyle || st.style || "Regular");
        el.fontSelect.appendChild(opt);
      }
    }

    el.fontCount.textContent = "AE 里共 " + total + " 个家族；" +
      (q ? "匹配 " + d.matched + " 个，已列出 " + fams.length + " 个" +
           (d.pinyin ? "（按拼音匹配）" : "")
         : "已列出前 " + fams.length + " 个（可输入名称、拼音或首字母）") +
      (favAll.length ? "；已收藏 " + favAll.length + " 个" : "");
    el.fontCount.className = "hint";

    ensureCurrentFontOption();
  }

  /**
   * 搜索字体（带 250ms 防抖，避免每敲一个字都往返一次 AE）。
   * @param {string}  query   关键词
   * @param {boolean} refresh 让 AE 丢掉字体缓存重新扫描（装了新字体 / 列表疑似不全时用）
   */
  function searchFonts(query, refresh) {
    // 纯 ASCII 关键词走「拼音模式」：中文名也能不打汉字就搜到。
    // （CEP 12 面板里中文输入法的候选浮窗有已知缺陷，见 README）
    if (!refresh && typeof AesubPy !== "undefined" && AesubPy.usable() &&
        AesubPy.isAsciiQuery(query)) {
      return searchFontsPinyin(query);
    }
    return AeApi.searchFonts(query, FONT_LIMIT, refresh).then(applyFontRes);
  }

  /** 把返回结果画进下拉（远程搜索与拼音搜索共用，避免两套错误处理各自漂移） */
  function applyFontRes(res) {
    if (!res.ok) {
      el.fontSelect.innerHTML = "";
      var o = document.createElement("option");
      o.value = "";
      o.textContent = "（字体读取失败）";
      el.fontSelect.appendChild(o);
      el.fontNow.textContent = "字体读取失败：" + res.error;
      el.fontCount.textContent = "";
      log("× 字体列表读取失败：" + res.error, "err");
      syncFavFont();
      return res;
    }
    renderFontOptions(res);
    state.lastFontRes = res;      // 收藏变化后要重画列表，靠它还原
    syncFavFont();
    return res;
  }

  /** 字体家族在下拉里的显示名（拼音搜索按它打分） */
  function fontLabelOf(fam) {
    return (fam && (fam.nativeName || fam.family)) || "";
  }

  /**
   * 按拼音 / 首字母挑字体。纯函数，便于单测。
   * 同分时保持 AE 给的顺序（最近使用 + 常见中文字体排在前面，这个顺序有价值）。
   * @returns {{list: Array, matched: number}}
   */
  function pickFontsByQuery(families, q, limit) {
    var hits = [];
    var src = families || [];
    for (var i = 0; i < src.length; i++) {
      var s = AesubPy.score(fontLabelOf(src[i]), q);
      if (s < 0) continue;
      hits.push({ f: src[i], s: s, i: i });
    }
    hits.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
    var lim = (typeof limit === "number" && limit > 0) ? limit : FONT_LIMIT;
    var list = [];
    for (var k = 0; k < hits.length && k < lim; k++) list.push(hits[k].f);
    return { list: list, matched: hits.length };
  }

  /**
   * 拼音搜索：字体清单只从 AE 拉一次（全量，之后缓存在 state.fontIndex），
   * 后续每次输入都在面板里过滤 —— 不往返 AE，打字手感跟手。
   * 全量拿不到时（AE 字体服务还没就绪等）退回按名称搜索，别让用户输了个寂寞。
   */
  function searchFontsPinyin(q) {
    function renderFromIndex() {
      var r = pickFontsByQuery(state.fontIndex, q, FONT_LIMIT);
      return applyFontRes({
        ok: true,
        data: {
          available: true,
          ready: true,
          families: r.list,
          totalFamilies: state.fontIndex.length,
          matched: r.matched,
          returned: r.list.length,
          query: q,
          pinyin: true
        }
      });
    }

    if (state.fontIndex && state.fontIndex.length) {
      return Promise.resolve(renderFromIndex());
    }

    return AeApi.searchFonts("", FONT_INDEX_LIMIT, false).then(function (res) {
      var d = res && res.data;
      if (!res.ok || !d || d.available === false || d.ready === false ||
          !d.families || !d.families.length) {
        return AeApi.searchFonts(q, FONT_LIMIT, false).then(applyFontRes);
      }
      state.fontIndex = d.families;
      return renderFromIndex();
    });
  }

  /**
   * 强制 AE 重新扫描字体列表。
   * 用途：AE 刚启动时字体服务是异步加载的，早期建立的缓存可能是残缺的；
   * 用户中途装了字体也需要它。这是"搜不到装着的中文字体"的直接解药。
   */
  function refreshFonts() {
    state.fontIndex = null;   // 面板侧那份全量清单也作废，下次拼音搜索重新拉
    return searchFonts(el.fontQuery.value.trim(), true).then(function (res) {
      if (!res || !res.ok) return res;
      var d = res.data || {};
      if (d.ready === false) {
        var note = d.note || "AE 的字体列表还没准备好，等几秒再点一次刷新。";
        setStatus("字体列表尚未就绪", "warn");
        log("⚠ " + note, "warn");
      } else {
        setStatus("字体列表已刷新：共 " + (d.totalFamilies || 0) + " 个字体家族", "ok");
        log("字体列表已刷新：共 " + (d.totalFamilies || 0) + " 个字体家族" +
          "（缓存状态 " + (d.cacheState || "?") + "）", "ok");
      }
      return res;
    });
  }

  function scheduleFontSearch() {
    if (state.fontTimer) clearTimeout(state.fontTimer);
    state.fontTimer = setTimeout(function () {
      state.fontTimer = null;
      searchFonts(el.fontQuery.value.trim());
    }, 250);
  }

  function setFontChoice(ps, label, query) {
    state.fontPs = ps || "";
    state.fontLabel = label || "";
    lsSet(LS.fontPs, state.fontPs);
    lsSet(LS.fontLabel, state.fontLabel);
    lsSet(LS.fontQuery, query || "");
    if (state.fontPs) {
      el.fontNow.textContent = "字体：" + state.fontLabel;
      el.fontNow.className = "hint okText";
    } else {
      el.fontNow.textContent = "字体：跟随 AE 默认";
      el.fontNow.className = "hint";
    }
  }

  /** 下拉里选了一个字体 → 记为本次要用的字体 */
  function onFontPicked() {
    var ps = el.fontSelect.value;
    if (!ps) return;
    var label = el.fontSelect.options[el.fontSelect.selectedIndex].textContent;
    setFontChoice(ps, label, el.fontQuery.value.trim());
    log("已选定字体：" + label + "（" + ps + "，下次生成字幕时生效）", "ok");
  }

  /** 从时间线上选中的文本图层拾取字体 / 字号 / 颜色 —— 最省事的用法 */
  function pickFontFromSelection() {
    if (state.running) return;
    setStatus("正在从选中的图层拾取样式…");
    return AeApi.pickTextStyleFromSelection().then(function (res) {
      if (!res.ok) {
        setStatus("拾取失败：" + res.error, "err");
        log("× 拾取失败：" + res.error, "err");
        return;
      }
      var d = res.data;
      var label = ((d.family || "") + " · " + (d.style || "")).replace(/\s*·\s*$/, "").trim() || d.font;
      setFontChoice(d.font, label, d.family || d.font);
      el.fontQuery.value = d.family || d.font;
      el.fontNow.textContent = "字体：" + label + "（拾取自 " + d.layerName + "）";

      if (d.fontSize && d.fontSize >= 8 && d.fontSize <= 400) el.fontSize.value = Math.round(d.fontSize);
      if (d.color) el.color.value = rgbToHex(d.color);
      saveSettings();

      setStatus("已拾取样式（来自图层「" + d.layerName + "」）", "ok");
      log("✓ 拾取成功：字体 " + d.font + " · 字号 " + (d.fontSize || "?") +
        " · 颜色 " + (d.color ? rgbToHex(d.color) : "?") +
        (d.tracking || d.tracking === 0 ? " · 字距 " + d.tracking : ""), "ok");
      scheduleFontSearch();
    });
  }

  /** 启动时恢复上次选的字体，并先把字体列表拉回来 */
  function restoreFont() {
    var ps = lsGet(LS.fontPs, "");
    var label = lsGet(LS.fontLabel, "");
    var query = lsGet(LS.fontQuery, "");
    if (query) el.fontQuery.value = query;
    if (ps) {
      setFontChoice(ps, label || ps, query);
    } else {
      el.fontNow.textContent = "字体：跟随 AE 默认";
    }

    // 启动这一次**强制重建** AE 侧缓存，并在"字体服务还没就绪"时自动重试。
    // 为什么必须这样做：面板一打开就搜字体，而 AE 的字体服务是异步加载的，
    // 早期建的缓存可能是残缺的；旧实现会把它固化，导致之后一直搜不到系统里的字体，
    // 非重启 AE 不可。这里主动重试几次，用户不用管。
    var tries = 0;
    (function attempt() {
      tries++;
      searchFonts(el.fontQuery.value.trim() || "", true).then(function (res) {
        if (res && res.ok && res.data && res.data.ready === false && tries < 4) {
          log("AE 字体列表还没就绪，2 秒后自动重试（第 " + (tries + 1) + " 次）…", "warn");
          setTimeout(attempt, 2000);
        }
      });
    })();
  }

  /* ---------------------------------------------------------- 一键自检 */

  function selfTestReportPath() {
    return joinPath(node.os.tmpdir(), "ae-subtitle", "selftest.json");
  }

  /**
   * 跑自检：验证字体检索 / 时间范围探测 / 字幕居中（数学计算，不靠肉眼）。
   * 走的是面板通道，不受 AE 那个"正在执行脚本…"对话框影响。
   */
  function runSelfTest() {
    if (state.running) return;
    if (!node) { setStatus("面板内 Node 未启用，无法写自检报告", "err"); return; }
    if (!CepBridge.available()) { setStatus("请从 AE 里打开面板后再跑自检", "err"); return; }

    try {
      var dir = joinPath(node.os.tmpdir(), "ae-subtitle");
      if (!node.fs.existsSync(dir)) node.fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* 目录建不了也让桥接层去试 */ }

    var path = selfTestReportPath();
    setStatus("正在自检（AE 可能卡 1~2 秒）…");
    if (el.logBox) el.logBox.open = true;
    log("=== 开始自检 ===");
    log("（不会导入素材、不会新建合成；居中测试的临时图层量完即删）");

    return AeApi.selfTest(path).then(function (res) {
      if (!res.ok) {
        setStatus("自检失败：" + res.error, "err");
        log("× " + res.error, "err");
        return;
      }
      var d = res.data || {};

      // ---- 字体 ----
      if (d.font && d.font.ok) {
        log("字体检索：" + (d.font.available ? "接口可用" : "接口不可用") +
          " · 家族 " + d.font.totalFamilies + " · 命中 " + d.font.matched +
          " · 返回 " + d.font.returned +
          "（首次 " + d.font.firstSearchMs + "ms / 走缓存 " + d.font.cachedSearchMs + "ms）", "ok");
        if (d.font.sample && d.font.sample.length) {
          var names = [];
          for (var i = 0; i < d.font.sample.length; i++) {
            names.push((d.font.sample[i].nativeName || d.font.sample[i].family) +
              " → " + d.font.sample[i].firstPs);
          }
          log("  样例：" + names.join(" ｜ "));
        }
      } else if (d.font) {
        log("× 字体检索接口不可用", "err");
      }

      // ---- 范围 ----
      if (d.range) {
        if (d.range.ready) {
          log("范围探测：OK · " + fmtSec(d.range.rangeStart) + " ~ " + fmtSec(d.range.rangeEnd) +
            " 秒（" + humanSec(d.range.rangeDuration) + "） · 合成总长 " +
            humanSec(d.range.compDuration), "ok");
        } else {
          log("范围探测：未就绪 · " + (d.range.compName
            ? "合成「" + d.range.compName + "」里没算出可用区间"
            : "当前不在合成时间线上"), "warn");
        }
      }

      // ---- 居中（核心）----
      if (d.center && d.center.available) {
        var rs = d.center.results || [];
        log("居中测试（合成 " + d.center.compWidth + "×" + d.center.compHeight +
          "，理论中心 " + (d.center.compWidth / 2) + ", " + (d.center.compHeight / 2) + "）：");
        for (var k = 0; k < rs.length; k++) {
          var r = rs[k];
          var oneOk = Math.abs(r.dx) <= 1 && Math.abs(r.dy) <= 1;
          log("  [" + r.label + "] 文本宽 " + r.rectWidth + "px · 文本块中心 [" +
            r.textCenterInComp[0] + ", " + r.textCenterInComp[1] + "] · 偏差 dx=" +
            r.dx + " dy=" + r.dy + " · 段落居中=" + r.justificationIsCenter,
            oneOk ? "ok" : "err");
        }
        log("居中结论：" + (d.center.allCentered
          ? "通过 —— 三种长度都精确居中（最大偏差 " + d.center.maxAbsDx + "/" + d.center.maxAbsDy + " px）"
          : "未通过 —— 最大偏差 " + d.center.maxAbsDx + "/" + d.center.maxAbsDy + " px"),
          d.center.allCentered ? "ok" : "err");
        log("  临时图层清理后，合成图层数 = " + d.center.layerCountAfterCleanup + "（应与自检前一致）");
        if (d.center.fontUsed) log("  测试用字体：" + d.center.fontUsed);
      } else if (d.center) {
        log("居中测试：跳过（" + d.center.reason + "）", "warn");
      }

      // ---- 报告与备注 ----
      if (d.notes && d.notes.length) {
        for (var n = 0; n < d.notes.length; n++) log("  注：" + d.notes[n], "warn");
      }
      if (d.errors && d.errors.length) {
        for (var e2 = 0; e2 < d.errors.length; e2++) log("  × " + d.errors[e2], "err");
      }
      if (d.reportPath) log("自检报告已写入：" + d.reportPath, "ok");
      log("=== 自检结束，用时 " + ((d.elapsedMs || 0) / 1000).toFixed(1) + " 秒 ===");

      var allGood = (!d.errors || d.errors.length === 0) &&
        d.center && d.center.available && d.center.allCentered;
      setStatus(allGood
        ? "自检通过：字体、范围、居中全部正常"
        : "自检完成，请查看日志里的红色行", allGood ? "ok" : "warn");
    }).catch(function (err) {
      setStatus("自检异常：" + err.message, "err");
      log("× " + err.message, "err");
    });
  }

  /* ---------------------------------------------------------- 跑流水线 */

  function runPipeline(nodeExe, args, onProgress, extraEnv) {
    return new Promise(function (resolve, reject) {
      var opts = {
        cwd: el.pipelineDir.value.trim(),
        windowsHide: true
      };
      if (extraEnv) {
        // ⚠ 密钥刻意走**环境变量**而不是命令行参数：
        //   命令行参数在系统里能看到（进程列表 / 日志），环境变量只在子进程内部可见。
        //   同一用户下环境变量依然可读，所以这不是加密，只是把暴露面收小。
        var base = {};
        try { base = Object.assign({}, process.env); } catch (e) { base = {}; }
        opts.env = Object.assign(base, extraEnv);
      }
      var p = node.child_process.spawn(nodeExe, args, opts);

      var stdout = "";
      var stderrBuf = "";

      p.stdout.on("data", function (d) { stdout += d.toString("utf8"); });

      p.stderr.on("data", function (d) {
        stderrBuf += d.toString("utf8");
        var idx;
        while ((idx = stderrBuf.indexOf("\n")) >= 0) {
          var line = stderrBuf.slice(0, idx).replace(/\r$/, "");
          stderrBuf = stderrBuf.slice(idx + 1);
          if (!line.trim()) continue;
          if (line.charAt(0) === "{") {
            try {
              var ev = JSON.parse(line);
              if (ev && ev.type === "progress") { onProgress(ev); continue; }
            } catch (e) { /* 不是 JSON，当普通日志 */ }
          }
          log("  " + line);
        }
      });

      p.on("error", function (e) {
        reject(new Error("无法启动 Node 进程：" + e.message));
      });

      p.on("close", function (code) {
        var text = stdout.trim();
        if (!text) {
          reject(new Error("流水线没有产出结果（退出码 " + code + "）。请检查日志。"));
          return;
        }
        var lastLine = text.split("\n").pop();
        try {
          resolve(JSON.parse(lastLine));
        } catch (e) {
          reject(new Error("无法解析流水线结果：" + lastLine.slice(0, 200)));
        }
      });
    });
  }

  /* ---------------------------------------------------------- 导出结果自检 */

  /**
   * 校验导出产物的体积是否与"指定区间"相符。
   *
   * 为什么需要这道检查：万一 AE 忽略了 timeSpanStart / timeSpanDuration
   * （这两个属性在部分版本上有取整怪异行为），它会退回去渲染整段合成，
   * 结果就是又产出几小时的静音。用体积反推能立刻发现，不必等到上传被云端拒绝。
   *
   * 48kHz / 16bit / 立体声 PCM ≈ 192000 字节/秒，留 30% 余量容纳容器开销。
   * @returns {boolean} true = 体积正常
   */
  function checkExportSize(d) {
    var expected = Number(d.durationSec) * 192000;
    if (!(expected > 0)) return true;
    if (Number(d.bytes) <= expected * 1.3 + 200000) return true;
    log("⚠ 导出文件比预期大很多：实际 " + fmtBytes(d.bytes) +
      "，按区间 " + fmtSec(d.durationSec) + " 秒推算应约 " + fmtBytes(expected) + "。", "err");
    log("  说明 AE 可能没有按指定区间渲染。请点「试导出」并把完整日志发给我。", "err");
    return false;
  }

  /* ---------------------------------------------------------- 中间音频的路径与清理 */

  function midAudioPath(outDir, compName) {
    return joinPath(outDir, "_中间音频", safeName(compName) + "_audio");
  }

  /** 删除中间音频；顺手把空目录也收掉，别在输出目录里留垃圾 */
  function removeMidAudio(file, quiet) {
    if (!file || !node) return;
    try {
      if (node.fs.existsSync(file)) {
        node.fs.unlinkSync(file);
        if (!quiet) log("已删除中间音频：" + file);
      }
      var dir = file.replace(/\/[^/]*$/, "");
      if (dir && node.fs.existsSync(dir)) {
        var left = node.fs.readdirSync(dir);
        if (left.length === 0) node.fs.rmdirSync(dir);
      }
    } catch (e) {
      log("（中间音频清理失败，可手动删除：" + file + "）", "warn");
    }
  }

  /* ---------------------------------------------------------- 页面切换 */

  var PAGE_IDS = { work: "pageHome", sep: "pageUvr", sub: "pageStyle", eng: "pageEng", set: "pageSet" };

  /** 每页的二级分组，顺序必须与 index.html 里 .lv2 的按钮顺序一致。
   *  写成函数而不是常量：面板测试按「function 名」抠代码来跑，常量抠不到。 */
  function groupsOf(page) {
    var M = {
      work: ["run", "check", "out"],
      sep: ["cfg", "env"],
      sub: ["text", "look", "pos", "fix"],
      eng: ["asr", "local"],
      set: ["path", "diag", "gen"]
    };
    return M[page] || [];
  }

  /** 切到某一页里的二级分组。不传 gname 就回到该页第一个分组 */
  function showGroup(page, gname) {
    var pg = document.getElementById(PAGE_IDS[page] || "");
    if (!pg) return;
    var list = groupsOf(page);
    if (!gname || list.indexOf(gname) < 0) gname = list[0];
    var gs = pg.querySelectorAll(".grp");
    for (var i = 0; i < gs.length; i++) {
      gs[i].classList.toggle("on", gs[i].getAttribute("data-g") === gname);
    }
    var bs = pg.querySelectorAll(".lv2 button[data-g]");
    for (var j = 0; j < bs.length; j++) {
      bs[j].classList.toggle("on", bs[j].getAttribute("data-g") === gname);
    }
    state.group = state.group || {};
    state.group[page] = gname;
  }

  function showPage(name, gname) {
    if (!PAGE_IDS[name]) name = "work";
    state.page = name;
    for (var k in PAGE_IDS) {
      if (!PAGE_IDS.hasOwnProperty(k)) continue;
      var p = document.getElementById(PAGE_IDS[k]);
      if (!p) continue;
      var on = (k === name);
      p.classList.toggle("on", on);
      if (on) {
        // 过渡动画：进二级页「从下浮起」、回首页「从上落回」。
        // 必须**先清空再设** —— 否则连续切换时浏览器认为 animation 没变，不会重播。
        p.style.animation = "none";
        void p.offsetWidth;                     // 强制 reflow，让上面的清空真正生效
        p.style.animation = (name === "work" ? "pgBack" : "pgIn") + " .19s ease";
      }
    }
    // 一级导航高亮（v1.0.0）：按 id 引用而不用 querySelectorAll ——
    // 面板测试用的是精简 DOM stub（只有 getElementById），选择器方法在那边不存在。
    var TAB_IDS = { work: "tabWork", sep: "tabSep", sub: "tabSub", eng: "tabEng", set: "tabSet" };
    for (var tk in TAB_IDS) {
      if (!TAB_IDS.hasOwnProperty(tk)) continue;
      var tb = el[TAB_IDS[tk]];
      if (tb) tb.classList.toggle("on", tk === name);
    }
    // 换页回到顶部：面板本来就窄，停在上次的滚动位置很容易看漏顶部那张卡片
    try { window.scrollTo(0, 0); } catch (eScroll) { }
    if (el.pageUvr && name === "sep" && !state.uvr) checkUvrDeps(true);
    if (el.pageStyle && name === "sub" && !state.presets) loadPresets();
    if (name === "sub") { syncFavFont(); syncFavPreset(); }   // 进字幕页时校准星标状态
    showGroup(name, gname);                                   // 二级分组（不传则回第一组）
  }

  /** 首页「人声分离设置」按钮上显示当前状态 —— 一眼看到开还是关 */
  function syncUvrUi() {
    var on = !!el.uvrOn.checked;
    el.uvrBody.classList.toggle("off", !on);
    var opt = el.uvrTarget.options[el.uvrTarget.selectedIndex];
    var tgt = opt ? String(opt.textContent).split("（")[0] : "";
    el.uvrBadge.textContent = on ? ("开 · " + tgt) : "关";
    el.uvrBadge.className = "badge" + (on ? " ok" : "");
    // v1.0.0：快捷入口按钮已删，副标题随之取消（顶部一级导航取代）
  }

  /** 首页「字幕样式」按钮上显示当前的排布 / 字号 / 预设 */
  function syncStyleUi() {
    var parts = [el.mode.value === "single" ? "单层+关键帧" : "每句一层"];
    if (el.fontSize.value) parts.push(el.fontSize.value + " 号");
    parts.push(state.presetLabel || "无预设");
    // v1.0.0：快捷入口按钮已删，副标题随之取消（顶部一级导航取代）
  }

  /* ---------------------------------------------------------- 人声分离：依赖检测与安装 */

  /** 项目内的独立 Python 环境（不污染系统 Python） */
  /**
   * 自动找流水线目录。
   *
   * 分发给别人时，pipeline 是**随插件一起放在扩展目录下**的 —— 所以先看那儿，
   * 命中就零配置可用；开发环境（扩展目录里没有 pipeline）再看工程目录。
   * 都找不到返回空串，由调用方提示用户手填。
   */
  function detectPipelineDir() {
    var cands = [];
    try {
      var ext = CepBridge.extensionPath();
      if (ext) cands.push(joinPath(ext, "pipeline"));
    } catch (e) { }
    try {
      var here = decodeURIComponent(String(location.href || "")).replace(/\\/g, "/");
      if (here) {
        var root = here.replace(/\/cep\/[^/]*$/, "").replace(/^file:\/+/i, "");
        if (root && root !== here) cands.push(joinPath(root, "pipeline"));
      }
    } catch (e2) { }
    for (var i = 0; i < cands.length; i++) {
      try {
        if (node && node.fs && node.fs.existsSync(joinPath(cands[i], "cli.js"))) return cands[i];
      } catch (e3) { }
    }
    return "";
  }

  /**
   * 数据目录：分离环境（python-env）与模型（models）的落脚点。
   *
   * 默认放「我的文档/AE自动字幕」—— 刻意**不塞进 CEP 扩展目录**：
   * 那份环境有 7 GB，放系统目录既难找也容易被清理工具误删，
   * 而且插件本体要保持小巧（方便分发）。用户可在设置里改到别的盘。
   */
  function dataDirPath() {
    var manual = (el.dataDir && el.dataDir.value) ? el.dataDir.value.trim() : "";
    if (manual) return manual;
    try {
      var docs = CepBridge.myDocuments();
      if (docs) return joinPath(docs, "AE自动字幕");
    } catch (e) { }
    var pd = el.pipelineDir.value.trim();
    return pd ? joinPath(pd, "..") : "";
  }

  /**
   * 模型目录：**面板显式传给流水线**，保证"下载的模型"与"分离时用的模型"是同一处。
   * 同样兼容老布局：老位置的 models/uvr 里已经有模型就用老位置（别让用户重下 900 MB）。
   */
  function uvrModelsDir() {
    var base = dataDirPath();
    var newer = base ? joinPath(base, "models", "uvr") : "";
    var older = joinPath(el.pipelineDir.value.trim(), "..", "models", "uvr");
    try {
      if (node && node.fs) {
        var hasOld = false;
        try { hasOld = node.fs.existsSync(older) && node.fs.readdirSync(older).length > 0; }
        catch (eOld) { hasOld = false; }
        if (hasOld) return older;
        if (newer && node.fs.existsSync(newer)) return newer;
      }
    } catch (e) { }
    return newer || older;
  }

  /**
   * 分离环境（venv）的位置。
   *
   * ⚠ **兼容老布局**：新设计把它放在「数据目录」下，但开发机与早期用户的环境
   * 是装在「流水线目录的上一级」的（那边有 7 GB，不能让它凭空"消失"）。
   * 所以：哪边**已经存在可用的 python.exe** 就用哪边；都没有才落到新位置。
   */
  function uvrVenvDir() {
    var base = dataDirPath();
    var newer = base ? joinPath(base, "python-env") : "";
    var older = joinPath(el.pipelineDir.value.trim(), "..", "python-env");
    try {
      if (node && node.fs) {
        if (newer && node.fs.existsSync(joinPath(newer, "Scripts", "python.exe"))) return newer;
        if (node.fs.existsSync(joinPath(older, "Scripts", "python.exe"))) return older;
      }
    } catch (e) { }
    return newer || older;
  }

  /** 装环境时用的目标位置：已有环境就沿用，否则用数据目录下的新位置 */
  function uvrVenvTargetDir() {
    var base = dataDirPath();
    return base ? joinPath(base, "python-env") : joinPath(el.pipelineDir.value.trim(), "..", "python-env");
  }

  /** 跑一个命令并把输出逐行打到日志（用于 pip 这类长任务） */
  function runStreaming(exe, args, cwd) {
    return new Promise(function (resolve, reject) {
      var p;
      try {
        p = node.child_process.spawn(exe, args, { cwd: cwd || undefined, windowsHide: true });
      } catch (e) {
        reject(new Error("无法启动 " + exe + "：" + e.message));
        return;
      }
      var buf = "";
      function eat(chunk) {
        buf += chunk.toString("utf8");
        var i;
        while ((i = buf.indexOf("\n")) >= 0) {
          var line = buf.slice(0, i).replace(/\r$/, "").trim();
          buf = buf.slice(i + 1);
          if (line) log("  " + line.slice(0, 300));
        }
      }
      p.stdout.on("data", eat);
      p.stderr.on("data", eat);
      p.on("error", function (e) { reject(new Error("无法启动进程：" + e.message)); });
      p.on("close", function (code) { resolve(code); });
    });
  }

  function renderUvrDeps(d) {
    var rows = [];
    function row(cls, html) {
      rows.push('<div class="stateRow"><span class="dot ' + cls + '"></span><span>' +
        html + "</span></div>");
    }
    if (!d || !d.found) {
      row("bad", "没有找到可用的 Python —— 点「一键安装环境」会建一个独立环境（需要系统里已装 Python 3.9+）");
      if (d && d.hint) row("warn", d.hint);
    } else {
      row("ok", "Python " + (d.pythonVersion || "?") + " · " + d.python);
      if (d.installed) {
        row("ok", "audio-separator " + (d.version || "已安装") +
          (d.cliPath ? " · " + d.cliPath : ""));
        row("ok", "分离在本地运行，音频不会因为这一步离开你的电脑");
        if (d.device && typeof d.device === "object") {
          // 两个加速后端要分开显示：torch 管 Roformer/Demucs，ONNX 管 MDX-Net
          var dev = d.device;
          var torchOk = dev.torch === "cuda";
          // dev.onnx 已由"真的建一次会话"得出，反映的是实际可用性（不是编译支持）
          var onnxOk = dev.onnx === "cuda";
          var anyGpu = torchOk || onnxOk;
          row(anyGpu ? "ok" : "warn",
            "运算设备 " + (anyGpu ? (dev.gpuName || "CUDA") : "CPU") +
            "（加速后端：torch " + (torchOk ? "√" : "×") + " · ONNX " + (onnxOk ? "√" : "×") + "）");
          if (!torchOk && !onnxOk) {
            row("warn", "纯 CPU 运算，明显偏慢。装 GPU 加速后 MDX-Net 与 Roformer 都能快很多。");
          } else if (!torchOk && onnxOk) {
            row("warn", "只有 ONNX 后端在加速：MDX-Net 类（如 Kim Vocal 2）已走 GPU，" +
              "但 Roformer 类（BS-Roformer / MelBand）还需要 CUDA 版 torch。");
          } else if (torchOk && !onnxOk) {
            row("warn", "只有 torch 后端在加速：Roformer / Demucs 已走 GPU，" +
              "MDX-Net 类（.onnx 模型）仍在 CPU 上。");
          } else {
            row("ok", "GPU 加速已全面启用 —— MDX-Net 与 Roformer 都走显卡。");
          }
        } else if (d.device) {
          // 兼容旧结构（device 是字符串）
          row(d.device === "cpu" ? "warn" : "ok",
            "运算设备 " + String(d.device).toUpperCase() +
            (d.device === "cpu" ? "（较慢）" : "（有显卡，快很多）"));
        }
      } else {
        row("bad", "audio-separator 未安装 —— 点「一键安装环境」（约 2~3 GB，一次性）");
      }
      if (d.modelsDir) row("ok", "模型目录：" + d.modelsDir);
    }
    // v0.9.1：顶部先给一格"扫一眼"的状态网格，详细行保留在下面（信息密度不降）
    var gpuOk = false, gpuTxt = "未检测";
    if (d && d.device && typeof d.device === "object") {
      gpuOk = d.device.torch === "cuda" || d.device.onnx === "cuda";
      gpuTxt = gpuOk ? (d.device.gpuName || "CUDA") : "CPU";
    } else if (d && d.device) {
      gpuOk = String(d.device).toLowerCase() !== "cpu";
      gpuTxt = String(d.device).toUpperCase();
    }
    var gpuCls = gpuOk ? "" : (d && d.found ? "warn" : "off");
    var grid = '<div class="envgrid" id="envGridUvr">' +
      '<div class="er ' + (d && d.found ? "" : "off") + '"><span class="dot"></span>分离环境<b>' +
      (d && d.installed ? "已装" : (d && d.found ? "未装 · 可安装" : "未检测")) + "</b></div>" +
      '<div class="er ' + (d && d.pythonVersion ? "" : "off") + '"><span class="dot"></span>Python<b>' +
      (d && d.pythonVersion ? d.pythonVersion : "未找到") + "</b></div>" +
      '<div class="er ' + gpuCls + '"><span class="dot"></span>GPU 加速<b>' + gpuTxt + "</b></div>" +
      '<div class="er ' + (d && d.modelsDir ? "" : "off") + '"><span class="dot"></span>模型目录<b>' +
      (d && d.modelsDir ? "已配置" : "未配置") + "</b></div>" +
      "</div>";
    el.uvrDeps.innerHTML = grid + rows.join("");
  }

  /**
   * 根据「所选模型走哪个后端」与「实际可用的加速后端」给出针对性提示。
   * 两边要配对：选了大模型却没 CUDA torch，跑起来会慢到没法用，必须提前说。
   */
  function syncModelHint() {
    if (!el.uvrModelHint) return;
    var name = el.uvrModel.value;
    var backend = modelBackend(name);
    var dev = state.uvr && state.uvr.device;
    var torchOk = !!(dev && dev.torch === "cuda");
    var onnxOk = !!(dev && dev.onnx === "cuda");
    var warn = false;

    var parts = [];
    if (isHeavyModel(name)) {
      parts.push("大模型（约 0.3~1.5 GB，首次使用会自动下载）—— 质量最高，算得也最慢。");
      if (!dev) {
        parts.push("点「检查依赖」可确认能否走 GPU。");
      } else if (torchOk) {
        parts.push("已启用 GPU 加速 √");
      } else {
        warn = true;
        parts.push("⚠ 当前 torch 未启用 CUDA，它会退回 CPU 跑 —— 1 分钟素材可能要几十分钟，" +
          "建议先用 Kim Vocal 2。");
      }
    } else if (backend === "onnx") {
      parts.push("MDX-Net 模型：体积小（约 60 MB）、速度快。");
      if (!dev) {
        parts.push("点「检查依赖」可确认能否走 GPU。");
      } else if (onnxOk) {
        parts.push("已启用 GPU 加速 √");
      } else {
        warn = true;
        parts.push("⚠ ONNX 后端未启用 CUDA，正在用 CPU 跑。");
      }
    }

    el.uvrModelHint.textContent = parts.join(" ");
    el.uvrModelHint.className = warn ? "hint warnText" : "hint";
  }

  /** 走流水线的 --check-uvr 模式做检测，不自己拼命令，保证两侧判断口径一致 */
  function checkUvrDeps(quiet) {
    if (!node) { setStatus("面板内 Node 未启用", "err"); return Promise.resolve(null); }
    if (!state.env || !state.env.node) { setStatus("外部 Node 不可用", "err"); return Promise.resolve(null); }

    var args = [
      joinPath(el.pipelineDir.value.trim(), "cli.js"),
      "--check-uvr", "--progress-json"
    ];
    var mdCheck = uvrModelsDir();
    if (mdCheck) args.push("--model-file-dir", mdCheck);
    // 检测对象：手填路径 > 标准 venv（环境装在那里，不带上会永远显示"未就绪"）> 留空给 cli 自己找
    var pyArg = el.uvrPython.value.trim();
    if (!pyArg) {
      var vpy = joinPath(uvrVenvDir(), "Scripts", "python.exe");
      if (node.fs.existsSync(vpy)) pyArg = vpy;
    }
    if (pyArg) args.push("--separate-python", pyArg);

    if (!quiet) { log("检测人声分离依赖…"); setStatus("正在检测人声分离依赖…"); }
    return runPipeline(state.env.node.path, args, function () { })
      .then(function (r) {
        state.uvr = (r && r.uvr) ? r.uvr : null;
        renderUvrDeps(state.uvr);
        syncModelHint();
        if (!quiet) {
          if (state.uvr && state.uvr.installed) {
            setStatus("人声分离环境就绪", "ok");
            log("√ 人声分离环境就绪：" + state.uvr.python, "ok");
          } else {
            setStatus("人声分离环境未就绪，可按提示安装", "warn");
            log("人声分离环境未就绪（点「一键安装环境」）", "warn");
          }
        }
        return state.uvr;
      })
      .catch(function (e) {
        state.uvr = null;
        renderUvrDeps(null);
        if (!quiet) { setStatus("依赖检测失败：" + e.message, "err"); log("× " + e.message, "err"); }
        return null;
      });
  }

  function updateUvrButtons() {
    var busy = state.uvrBusy;
    el.btnUvrCheck.disabled = busy;
    el.btnUvrInstall.disabled = busy || !node;
    el.btnUvrModel.disabled = busy || !node;
    el.btnUvrInstall.textContent = busy ? "处理中…" : "一键安装环境";
  }

  /** 依赖预编译包（wheel）的覆盖范围：diffq-fixed / torch 都只出到 3.10~3.13 */
  function pyVerAcceptable(major, minor) {
    return major === 3 && minor >= 10 && minor <= 13;
  }

  /**
   * 探测一个可用的 Python（优先用户填的路径，否则按 3.13→3.10 顺序试 py launcher / PATH）。
   * 关键：**不能用裸 python 撞运气** —— 本机实测 AE 的 PATH 命中了 Python 3.14，
   * 而 3.14 没有 diffq-fixed / torch 的预编译包，pip 会退回源码包编译，必然失败。
   * 返回 { exe, args, ver } 或 null。
   */
  function probePython() {
    var cands = [];
    var manual = el.uvrPython.value.trim();
    // 手填路径只是"优先候选"：失效（如 venv 被删）时继续走自动探测，而不是直接报错
    if (manual) cands.push([manual, []]);
    {
      // py launcher（官方安装器自带）按小版本精确指定
      cands.push(["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3.10"]], ["python", []]);
      // 官方安装器的常见安装位置（PATH 没勾选时也能找到）
      var local = "";
      try { local = (node.process && node.process.env && node.process.env.LOCALAPPDATA) || ""; } catch (e) { }
      var v3 = ["313", "312", "311", "310"];
      for (var i = 0; i < v3.length; i++) {
        if (local) cands.push([joinPath(local, "Programs", "Python", "Python" + v3[i], "python.exe"), []]);
        cands.push([joinPath("C:", "Python" + v3[i], "python.exe"), []]);
      }
    }
    for (var i = 0; i < cands.length; i++) {
      try {
        var out = node.child_process.execFileSync(cands[i][0],
          cands[i][1].concat(["--version"]),
          { timeout: 15000, encoding: "utf8", windowsHide: true });
        var m = String(out).match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
        if (m && pyVerAcceptable(parseInt(m[1], 10), parseInt(m[2], 10))) {
          return {
            exe: cands[i][0],
            args: cands[i][1],
            ver: m[1] + "." + m[2] + (m[3] ? "." + m[3] : "")
          };
        }
      } catch (e) { /* 试下一个候选 */ }
    }
    return null;
  }

  /** 读取 venv 里 Python 的版本，返回 {major, minor, text} 或 null */
  function venvPythonVer(vpy) {
    try {
      var out = node.child_process.execFileSync(vpy, ["--version"],
        { timeout: 15000, encoding: "utf8", windowsHide: true });
      var m = String(out).match(/Python\s+(\d+)\.(\d+)/);
      return m
        ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), text: m[1] + "." + m[2] }
        : null;
    } catch (e) { return null; }
  }

  /**
   * pip 安装。默认走清华镜像（实测本机直连官方源会 ConnectionReset 挂 3 分钟才超时），失败回退官方。
   * @param {string} [indexUrl] 指定专用源 —— PyTorch 的 CUDA 频道在清华镜像里没有，
   *                            必须走官方源，所以这种情况不套镜像也不回退。
   */
  function pipInstall(vpy, pkgs, indexUrl) {
    if (indexUrl) {
      return runStreaming(vpy, ["-m", "pip", "install",
        "--index-url", indexUrl, "--timeout", "120"].concat(pkgs), null);
    }
    var mirror = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
      "--trusted-host", "pypi.tuna.tsinghua.edu.cn",
      "--timeout", "30"];
    return runStreaming(vpy, ["-m", "pip", "install"].concat(mirror, pkgs), null)
      .then(function (code) {
        if (code === 0) return 0;
        log("镜像源失败，改用官方源重试…", "warn");
        return runStreaming(vpy, ["-m", "pip", "install", "--timeout", "30"].concat(pkgs), null);
      });
  }

  /** 本机有没有 NVIDIA 显卡（决定装 CPU 版还是 GPU 版） */
  function detectNvidiaGpu() {
    try {
      var r = node.child_process.spawnSync("nvidia-smi",
        ["--query-gpu=name", "--format=csv,noheader"],
        { encoding: "utf8", timeout: 10000, windowsHide: true });
      var line = String(r.stdout || "").trim().split(/\r?\n/)[0].trim();
      return line || null;
    } catch (e) { return null; }
  }

  /**
   * 从源图层名提取产物命名基底。
   * 规则（用户拍板的「素材_人声」方式）：
   *   "无上光荣.mp4"    → "无上光荣"      （去掉素材扩展名）
   *   "无上光荣_人声"    → "无上光荣"      （对上轮生成的人声层再加工时，别把尾巴带进来）
   *   "无上光荣_人声 2"  → "无上光荣"      （同上，含落轨退让的序号）
   */
  function baseStemFromLayer(layerName) {
    var s = String(layerName || "").replace(/\.[a-z0-9]{1,5}$/i, "");
    s = s.replace(/_人声( \d+)?$/i, "");
    return safeName(s);
  }

  /** 列出输出目录里「这个 stem」已有的产物（识别文件 + 人声文件） */
  function existingArtifacts(outDir, stem) {
    var hits = [];
    try {
      if (node.fs.existsSync(joinPath(outDir, stem + ".json"))) hits.push(stem + ".json");
      if (node.fs.existsSync(joinPath(outDir, "_人声分离", stem + "_人声.wav"))) {
        hits.push(stem + "_人声.wav");
      }
    } catch (e) { /* 目录读不了就当没有，流水线自己会报 */ }
    return hits;
  }

  /**
   * 找上一轮分离出来的人声文件 —— 「跳过分离，用已有的人声」那条路要用它当识别输入。
   *
   * 只认 `<stem>_人声.wav`：伴奏（`_伴奏.wav`）拿去识别没有意义（里面正是要去掉的音乐），
   * 宁可让用户老实重跑一次，也不要给他一个注定失败的选项。
   *
   * @returns {string|null} 绝对路径；没有则 null（调用方据此置灰按钮）
   */
  function reusableVocalsPath(outDir, stem) {
    try {
      return node.fs.existsSync(joinPath(joinPath(outDir, "_人声分离"), stem + "_人声.wav"))
        ? joinPath(joinPath(outDir, "_人声分离"), stem + "_人声.wav")
        : null;
    } catch (e) { return null; }
  }

  /**
   * 找一个还没被占用的 stem：原名空着就直接用；否则 "stem 2"、"stem 3"…（json 与人声都不存在为止）
   *
   * ⚠ 当前**没有调用方** —— 它是"另存（自动改名）"那个选项的实现，
   *   而该选项已按需求从弹窗里撤掉（三个位置给了：复用 / 覆盖 / 取消）。
   *   保留是为了万一要恢复"另存"，不必重写；真不要了可以整块删掉。
   */
  function nextFreeStem(outDir, stem) {
    if (!existingArtifacts(outDir, stem).length) return stem;
    var n = 2, cand;
    do {
      cand = stem + " " + n;
      n++;
    } while (existingArtifacts(outDir, cand).length && n < 50);
    return cand;
  }

  /**
   * 同名产物弹窗：三条路 —— 跳过分离用已有的人声 / 覆盖重跑 / 取消。
   *
   * 为什么把"复用"放在第一位：它省掉的是整条链上最贵的一步 —— 重新分离人声
   * （本机 CPU、几分钟）。识别结果不满意想换个模型重来、或上次分离完就关掉了 AE，
   * 这两种情况下都在白烧这几分钟。
   *
   * ⚠ 复用**只跳过导出与分离**，识别仍要跑一次（会上传云端、消耗一次额度）——
   *   这一点必须在 hint 里写明，否则用户会以为"复用 = 完全不花钱"。
   *
   * 判据是磁盘上有没有上一轮的人声音频：只有 .json（识别结果）时无法复用，
   * 此时按钮置灰并说明原因 —— 而不是让用户点下去才发现不行。
   *
   * @param {string} stem 产物名
   * @param {string[]} hits 已有的产物文件名清单
   * @param {{reuseFile?:string}} [opts] reuseFile = 可复用的人声音频绝对路径
   * @returns {Promise<"reuse"|"overwrite"|"cancel">}
   */
  function askOverwrite(stem, hits, opts) {
    var reuseFile = (opts && opts.reuseFile) || null;
    return new Promise(function (resolve) {
      el.owBody.textContent = "输出目录里已有「" + stem + "」的产物：" + hits.join("、") +
        "。这一轮要怎么处理？";

      el.owHint.innerHTML =
        "<b>跳过分离，用已有的人声</b>：" +
        (reuseFile
          ? "直接拿上一轮的「" + stem + "_人声.wav」去识别 —— 省下一次重分离（几分钟 CPU），" +
            "但仍会上传云端识别一次。旧的 .json / .srt 会被本轮结果替换，人声文件本身不动。<br>"
          : "<span class=\"warnText\">不可用</span> —— 上一轮只留下了识别结果，没留下音频文件，" +
            "没有可复用的输入。<br>") +
        "<b>覆盖旧产物</b>：从头重跑（重新导出 + 重新分离 + 重新识别），文件名不变，旧文件被替换 —— " +
        "已落轨的人声图层引用的就是那个文件，它的声音会跟着变成这一轮的。<br>" +
        "<b>取消</b>：什么都不做、不上传云端，结束本次任务。";

      el.owReuse.disabled = !reuseFile;
      el.owReuse.title = reuseFile
        ? ("将复用：" + reuseFile)
        : "上一轮没有留下可复用的音频文件（只有识别结果）";
      el.owOverlay.style.display = "flex";

      var onRe = null, onOw = null, onCe = null;
      function finish(v) {
        el.owOverlay.style.display = "none";
        el.owReuse.removeEventListener("click", onRe);
        el.owOverwrite.removeEventListener("click", onOw);
        el.owCancel.removeEventListener("click", onCe);
        resolve(v);
      }
      onRe = function () { if (reuseFile) finish("reuse"); };   // 置灰时兜底：点了也不生效
      onOw = function () { finish("overwrite"); };
      onCe = function () { finish("cancel"); };
      el.owReuse.addEventListener("click", onRe);
      el.owOverwrite.addEventListener("click", onOw);
      el.owCancel.addEventListener("click", onCe);
    });
  }

  /** 确保存在一个版本兼容的 venv：不存在、或版本出圈（如 3.14）就（重）建 */
  function ensureVenv(venv, vpy) {
    if (node.fs.existsSync(vpy)) {
      var v = venvPythonVer(vpy);
      if (v && pyVerAcceptable(v.major, v.minor)) {
        log("1/2 虚拟环境已存在（Python " + v.text + "），直接复用");
        return Promise.resolve();
      }
      log("1/2 已有环境是 Python " + (v ? v.text : "未知版本") +
        "，而依赖的预编译包只提供 3.10~3.13 —— 删除重建（这个环境是本插件生成的，删除无副作用）", "warn");
      try { node.fs.rmSync(venv, { recursive: true, force: true }); } catch (e) { }
    }

    var pick = probePython();
    if (!pick) {
      return Promise.reject(new Error(
        "没找到合适的 Python（需要 3.10 ~ 3.13）。请在「Python」格里填 python.exe 的完整路径，" +
        "或安装一个 3.13 以内的 Python。注意：Python 3.14 太新，audio-separator 的依赖还没有对应版本。"));
    }
    var label = (pick.exe === "py" ? "py " + pick.args.join(" ") : pick.exe);
    log("1/2 创建虚拟环境（Python " + pick.ver + "，用 " + label + "）…");
    return runStreaming(pick.exe, pick.args.concat(["-m", "venv", venv])).then(function (code) {
      if (code !== 0) {
        throw new Error("创建虚拟环境失败（退出码 " + code + "）。请检查「Python」格里的路径是否正确。");
      }
      if (!node.fs.existsSync(vpy)) throw new Error("虚拟环境建好了但找不到 " + vpy);
      log("  √ 虚拟环境已创建（Python " + pick.ver + "）", "ok");
    });
  }

  /** 一键安装：建独立 venv + pip 装 audio-separator（CPU 版或 GPU 加速版） */
  function installUvr() {
    if (state.uvrBusy || state.running) return;
    if (!node) { setStatus("面板内 Node 未启用", "err"); return; }

    var venv = uvrVenvDir();
    var vpy = joinPath(venv, "Scripts", "python.exe");
    var wantGpu = !!(el.uvrGpu && el.uvrGpu.checked);
    var gpuName = wantGpu ? detectNvidiaGpu() : null;
    var useGpu = wantGpu && !!gpuName;

    state.uvrBusy = true;
    updateUvrButtons();
    el.logBox.open = true;
    log("");
    log("=== 安装人声分离环境 ===");
    log("独立环境位置：" + venv + "（不污染系统 Python，删掉该目录即可完全卸载）");
    if (wantGpu && !gpuName) {
      log("⚠ 勾了「GPU 加速」但没检测到 NVIDIA 显卡（nvidia-smi 不可用）—— 改为装 CPU 版。", "warn");
    } else if (useGpu) {
      log("检测到显卡：" + gpuName + " —— 安装 GPU 加速版（总体积约 4 GB，比较久）");
    } else {
      log("安装 CPU 版（约 1.5 GB）。机器上有 NVIDIA 显卡的话，勾上「GPU 加速」能快很多倍。");
    }

    return ensureVenv(venv, vpy)
      .then(function () {
        // audioread 必须显式补：librosa 1.0 起不再是它的硬依赖，但 audio-separator 内嵌的
        // 旧版 UVR 代码仍 import 它 —— 不补的话「下载模型/分离」会在 import 链上炸
        log(useGpu
          ? "2/5 安装 audio-separator + 基础依赖（约 1 GB，几分钟到十几分钟）…"
          : "2/2 安装 audio-separator（含 torch 等依赖，约 1~2 GB，几分钟到十几分钟）…");
        return pipInstall(vpy, [useGpu ? "audio-separator[gpu]" : "audio-separator[cpu]", "audioread"]);
      })
      .then(function (code) {
        if (code !== 0) throw new Error("安装失败（退出码 " + code + "），请把上面的日志发给我");
        if (!useGpu) return 0;
        // CPU 版与 GPU 版的 onnxruntime 是**两个不同包、同名模块**，必须先卸掉 CPU 版
        log("3/5 移除 CPU 版 ONNX Runtime（与 GPU 版模块同名，不卸会冲突）…");
        return runStreaming(vpy, ["-m", "pip", "uninstall", "-y", "onnxruntime"], null);
      })
      .then(function (code) {
        if (!useGpu) return 0;
        if (code !== 0) log("（卸载 CPU 版 ONNX Runtime 时返回 " + code + "，继续）", "warn");
        log("4/5 安装 ONNX 的 CUDA 运行库（onnxruntime-gpu + cuDNN，约 1 GB）…");
        return pipInstall(vpy, ["onnxruntime-gpu[cuda,cudnn]"]);
      })
      .then(function (code) {
        if (!useGpu) return 0;
        if (code !== 0) {
          log("⚠ CUDA 运行库没装上：MDX-Net 类模型（如 Kim Vocal 2）仍会走 CPU。" +
            "分离功能不受影响，只是慢。可以稍后重试安装。", "warn");
          return -1;
        }
        log("5/5 安装 CUDA 版 PyTorch（约 2.5 GB，走 PyTorch 官方源，可能较慢）…");
        return pipInstall(vpy, ["torch"], "https://download.pytorch.org/whl/cu126");
      })
      .then(function (code) {
        if (useGpu && code !== 0) {
          log("⚠ CUDA 版 PyTorch 没装上：Roformer / Demucs 这类大模型仍会走 CPU。" +
            "MDX-Net 类不受影响（它走 ONNX）。", "warn");
        }
        el.uvrPython.value = vpy;
        saveSettings();
        log("√ 安装流程结束，开始复检…", "ok");
        setStatus("安装完成，正在复检…");
        return checkUvrDeps(true);
      })
      .then(function () {
        setStatus((state.uvr && state.uvr.installed)
          ? "人声分离环境已就绪" : "安装完成但复检未通过，请查看日志",
          (state.uvr && state.uvr.installed) ? "ok" : "warn");
      })
      .catch(function (e) {
        log("× " + e.message, "err");
        setStatus("安装失败：" + e.message, "err");
      })
      .then(function () {
        state.uvrBusy = false;
        updateUvrButtons();
      });
  }

  /** 只下载当前选的模型，不做分离 */
  function downloadUvrModel() {
    if (state.uvrBusy || state.running) return;
    if (!node) { setStatus("面板内 Node 未启用", "err"); return; }
    if (!state.uvr || !state.uvr.installed) {
      setStatus("先安装环境，再下载模型", "warn");
      log("人声分离环境还没装好，先点「一键安装环境」。", "warn");
      return;
    }

    var exe = uvrCliPath();
    if (!exe) { setStatus("找不到 audio-separator 可执行文件，请点「检查依赖」", "err"); return; }
    var model = el.uvrModel.value;

    state.uvrBusy = true;
    updateUvrButtons();
    el.logBox.open = true;
    log("");
    log("=== 下载模型 " + model + " ===");

    return runStreaming(exe, ["-m", model, "--download_model_only"], null)
      .then(function (code) {
        if (code === 0) {
          log("√ 模型已就绪：" + model, "ok");
          setStatus("模型已下载：" + model, "ok");
        } else {
          throw new Error("下载失败（退出码 " + code + "）");
        }
      })
      .catch(function (e) {
        log("× " + e.message, "err");
        setStatus("模型下载失败：" + e.message, "err");
      })
      .then(function () {
        state.uvrBusy = false;
        updateUvrButtons();
        return checkUvrDeps(true);
      });
  }

  /** 找到 audio-separator 的可执行文件 */
  function uvrCliPath() {
    if (state.uvr && state.uvr.cliPath) return state.uvr.cliPath;
    var py = (state.uvr && state.uvr.python) || el.uvrPython.value.trim();
    if (!py) return null;
    var exe = py.replace(/python(\.exe)?$/i, "audio-separator.exe");
    try { if (exe !== py && node.fs.existsSync(exe)) return exe; } catch (e) { }
    return null;
  }

  /* ---------------------------------------------------------- 文字动画预设 */

  /** 从注册表找 AE 的安装位置（App Paths 是最可靠的口径） */
  function findAeExe() {
    try {
      var out = node.child_process.execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe" /ve',
        { encoding: "utf8", windowsHide: true }
      );
      var m = out.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m) return m[1].trim();
    } catch (e) { /* 注册表没有就往下走 */ }
    return null;
  }

  /** AE 自带的文字预设目录：<AE>\Support Files\Presets\Text */
  function aeTextPresetsDir() {
    var exe = findAeExe();
    if (!exe) return null;
    var supportFiles = String(exe).replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    var dir = joinPath(supportFiles, "Presets", "Text");
    try { if (node.fs.existsSync(dir)) return dir; } catch (e) { }
    return null;
  }

  /** 用户自己另存的预设：<文档>\Adobe\After Effects <版本>\User Presets */
  function userPresetsDir() {
    var base;
    try { base = joinPath(node.os.homedir(), "Documents", "Adobe"); } catch (e) { return null; }
    try {
      if (!node.fs.existsSync(base)) return null;
      var subs = node.fs.readdirSync(base);
      for (var i = 0; i < subs.length; i++) {
        if (!/^After Effects/i.test(subs[i])) continue;
        var p = joinPath(base, subs[i], "User Presets");
        if (node.fs.existsSync(p)) return p;
      }
    } catch (e) { }
    return null;
  }

  /** 递归扫 .ffx；顶层子目录名当作分类 */
  function scanFfx(root, depth) {
    var out = [];
    if (!root || depth > 4) return out;
    var subs;
    try { subs = node.fs.readdirSync(root); } catch (e) { return out; }
    for (var i = 0; i < subs.length; i++) {
      var name = subs[i];
      var full = joinPath(root, name);
      var st;
      try { st = node.fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        var kids = scanFfx(full, depth + 1);
        for (var k = 0; k < kids.length; k++) {
          if (!kids[k].cat) kids[k].cat = name;
          out.push(kids[k]);
        }
      } else if (/\.ffx$/i.test(name)) {
        out.push({ name: name.replace(/\.ffx$/i, ""), file: name, path: full, cat: "" });
      }
    }
    return out;
  }

  function loadPresets() {
    if (!node) { el.presetHint.textContent = "面板内 Node 未启用，无法读取预设。"; return; }
    if (state.presets) { renderPresetOptions(); return; }

    var builtinDir = aeTextPresetsDir();
    var userDir = userPresetsDir();
    var builtin = builtinDir ? scanFfx(builtinDir, 0) : [];
    var user = userDir ? scanFfx(userDir, 0) : [];

    state.presets = {
      builtinDir: builtinDir,
      userDir: userDir,
      builtin: builtin,
      user: user
    };
    renderPresetOptions();
  }

  function renderPresetOptions() {
    var p = state.presets;
    el.presetSelect.innerHTML = "";
    var q = (state.presetQuery || "").toLowerCase();

    function add(value, text, parent) {
      var o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      (parent || el.presetSelect).appendChild(o);
      return o;
    }

    add("", "不使用预设");

    if (!p) { el.presetHint.textContent = "预设读取失败。"; syncFavPreset(); return; }

    // 收藏的预设置顶。收藏项是本地数据（连显示名一起存着），不依赖这次扫描的结果；
    // 有关键词时也参与过滤 —— 所以「收藏了就一点即用」。
    var favAll = favGet(LS.favPresets);
    var favShown = favFilter(LS.favPresets, q);
    if (favShown.length) {
      var fgrp = document.createElement("optgroup");
      fgrp.label = "★ 收藏的预设";
      el.presetSelect.appendChild(fgrp);
      for (var fp = 0; fp < favShown.length; fp++) {
        var fpo = document.createElement("option");
        fpo.value = favShown[fp].v;
        fpo.textContent = "★ " + favShown[fp].t;
        fgrp.appendChild(fpo);
      }
    }
    var favMap = favValueMap(favAll);   // 普通分组里跳过已收藏的，免得同一个预设列两遍

    var shown = 0;                 // 过滤后实际列出多少个

    function addGroup(label, list) {
      // 关键词过滤：预设名（AE 中文版是中文名）/ 分类英文名 / 分类中文别名 / 完整路径
      var picked = list;
      if (q) {
        picked = [];
        for (var t = 0; t < list.length; t++) {
          var it = list[t];
          var hay = (it.name + " " + (it.cat || "") + " " +
                     (PRESET_CAT_ALIASES[it.cat] || "") + " " + it.path).toLowerCase();
          // 字面命中之外，允许用拼音 / 首字母命中预设名：
          // 「打字机」打 dzj 或 daziji 都行（中文输入法在 CEP 12 面板里不好用）
          var pyHit = (typeof AesubPy !== "undefined") && AesubPy.hit(it.name, q);
          if (hay.indexOf(q) >= 0 || pyHit) picked.push(it);
        }
      }
      if (!picked.length) return;

      var g = document.createElement("optgroup");
      g.label = label;
      el.presetSelect.appendChild(g);

      // 按分类归拢
      var cats = {}, order = [];
      for (var i = 0; i < picked.length; i++) {
        var c = picked[i].cat || "（未分类）";
        if (!cats[c]) { cats[c] = []; order.push(c); }
        cats[c].push(picked[i]);
      }
      order.sort();
      for (var j = 0; j < order.length; j++) {
        var cname = order[j];
        var items = cats[cname];
        items.sort(function (a, b) { return a.name.localeCompare(b.name); });
        for (var k = 0; k < items.length; k++) {
          if (favMap[items[k].path]) continue;   // 已在上面的收藏组里
          var o = document.createElement("option");
          o.value = items[k].path;
          // 搜索时不再加 "分类 / " 前缀：用户输入的分类词本身就在眼前，
          // 每行重复一遍反而把预设名挤得看不清
          o.textContent = (q ? "" : (order.length > 1 ? cname + " / " : "")) + items[k].name;
          g.appendChild(o);
          shown++;
        }
      }
    }

    addGroup("AE 自带文字预设", p.builtin);
    addGroup("我的预设（User Presets）", p.user);

    var totalAll = p.builtin.length + p.user.length;

    // 搜索无命中：明确告诉用户，别让他以为"预设读丢了"
    if (q && shown === 0) {
      var oEmpty = document.createElement("option");
      oEmpty.value = "";
      oEmpty.textContent = favShown.length
        ? "（除收藏之外没有其他匹配）"
        : "（没有匹配的预设，换个词试试）";
      el.presetSelect.appendChild(oEmpty);
      el.presetHint.className = "hint warnText";
      el.presetHint.textContent = "「" + el.presetQuery.value.trim() + "」没有匹配的预设（共 " +
        totalAll + " 个）" + (favShown.length ? "，收藏里有 " + favShown.length + " 个" : "") +
        "。可以用拼音搜（打字机 → dzj / daziji），或按分类搜：入场 / 退出 / 模糊 / 缩放 / 旋转 / 路径 / 多行。";
      syncFavPreset();
      return;
    }

    // 有搜索词时不插"（当前）xx"占位，否则会混在搜索结果里干扰阅读
    if (!q) ensureCurrentPresetOption();

    var bits = [];
    if (q) {
      bits.push("「" + el.presetQuery.value.trim() + "」命中 " + shown + " 个 / 共 " + totalAll + " 个");
    } else {
      bits.push("自带 " + p.builtin.length + " 个" + (p.builtinDir ? "" : "（没找到 AE 安装目录）"));
      bits.push("我的预设 " + p.user.length + " 个" + (p.userDir ? "" : "（还没另存过）"));
    }
    if (favAll.length) bits.push("已收藏 " + favAll.length + " 个");
    el.presetHint.className = "hint";
    el.presetHint.textContent = bits.join(" · ") +
      (q ? "。搜索只按关键词过滤，不影响实际应用。"
         : "。「动画 > 保存动画预设」另存的会归到「我的预设」。") +
      "每句一层时，预设的关键帧会自动平移到该句的出场时刻 —— 否则动画会全落在 0 秒处、看起来像没生效。";

    syncFavPreset();
  }

  /** 保证当前已选预设一定在下拉里，避免"看到的和生效的不一致" */
  function ensureCurrentPresetOption() {
    if (!state.presetPath) return;
    for (var i = 0; i < el.presetSelect.options.length; i++) {
      if (el.presetSelect.options[i].value === state.presetPath) {
        el.presetSelect.selectedIndex = i;
        return;
      }
    }
    var o = document.createElement("option");
    o.value = state.presetPath;
    o.textContent = "（当前）" + (state.presetLabel || "已选预设");
    el.presetSelect.insertBefore(o, el.presetSelect.options[1] || null);
    el.presetSelect.selectedIndex = 0;
  }

  function onPresetPicked() {
    var v = el.presetSelect.value;
    if (!v) {
      state.presetPath = "";
      state.presetLabel = "";
      lsSet(LS.presetPath, "");
      lsSet(LS.presetLabel, "");
      el.presetWarn.style.display = "none";
      syncStyleUi();
      log("已取消文字动画预设");
      return;
    }
    state.presetPath = v;
    state.presetLabel = String(v).replace(/\\/g, "/").split("/").pop().replace(/\.ffx$/i, "");
    lsSet(LS.presetPath, state.presetPath);
    lsSet(LS.presetLabel, state.presetLabel);
    el.presetWarn.style.display = "";
    syncStyleUi();
    log("已选预设：" + state.presetLabel + "（下次生成字幕时生效，不会改动已存在的图层）", "ok");
  }

  function openPresetDir() {
    var p = state.presets || {};
    var dir = p.userDir || p.builtinDir;
    if (!dir) {
      // 用户预设目录可能还不存在，直接开 Documents\Adobe
      try {
        dir = joinPath(node.os.homedir(), "Documents", "Adobe");
        if (!node.fs.existsSync(dir)) dir = joinPath(node.os.homedir(), "Documents");
      } catch (e) { }
    }
    if (!dir) { setStatus("找不到预设目录", "err"); return; }
    try {
      node.child_process.spawn("explorer.exe", [dir.replace(/\//g, "\\")], { detached: true });
      setStatus("已打开：" + dir);
    } catch (e) {
      setStatus("打开目录失败：" + e.message, "err");
    }
  }

  /** 用 CEP 的原生文件对话框选一个 .ffx（比 <input type=file> 可靠，且能拿到真实路径） */
  function browsePresetFile() {
    var initial = (state.presets && (state.presets.userDir || state.presets.builtinDir)) || "";
    var res = null;
    try {
      if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
        res = window.cep.fs.showOpenDialog(false, false, "选择动画预设文件（.ffx）", initial, ["ffx"]);
      }
    } catch (e) { }
    if (!res) {
      log("打不开系统文件对话框。可以改用下拉列表选择，或把 .ffx 放到 User Presets 目录后点「打开预设文件夹」。", "warn");
      return;
    }
    if (res.err !== 0) return;                  // 用户取消
    var picked = res.data && res.data[0];
    if (!picked) return;

    state.presetPath = String(picked).replace(/\\/g, "/");
    state.presetLabel = state.presetPath.split("/").pop().replace(/\.ffx$/i, "");
    lsSet(LS.presetPath, state.presetPath);
    lsSet(LS.presetLabel, state.presetLabel);
    ensureCurrentPresetOption();
    el.presetWarn.style.display = "";
    syncStyleUi();
    log("已选预设文件：" + state.presetPath, "ok");
  }

  /* ---------------------------------------------------------- 结果摘要 */

  function showResult(st, compName, created, skipped, params) {
    el.resultCard.style.display = "";
    var rows = [];
    rows.push("<span class=\"k\">字幕</span>" + st.segments + " 段 · " + st.totalChars +
      " 字 · 语音覆盖 " + st.coveragePercent + "%");
    if (params.createLayers && created !== null && created !== undefined) {
      rows.push("<span class=\"k\">图层</span>已在「" + compName + "」中创建 " + created +
        " 个字幕图层" + (skipped ? "（跳过 " + skipped + " 段）" : ""));
    }
    if (params.doSeparate) {
      rows.push("<span class=\"k\">分离</span>已用 " + params.separateTargetLabel + " 送入识别");
    } else if (params.separateSkipped) {
      rows.push("<span class=\"k\">分离</span>源层已是人声，本次跳过分离");
    }
    if (state.lastPlaced) {
      rows.push("<span class=\"k\">落轨</span>人声图层「" + state.lastPlaced.layerName +
        "」第 " + state.lastPlaced.layerIndex + " 层" +
        (state.lastPlaced.mutedSource ? " · <b>原层已静音</b>"
          : (state.lastPlaced.removedSource ? " · <b>原层已被替换</b>" : "")));
    }
    if (state.presetLabel) rows.push("<span class=\"k\">预设</span>" + state.presetLabel);
    rows.push("<span class=\"k\">输出</span><span class=\"mono\">" + params.outDir + "</span>");
    el.resultInfo.innerHTML = rows.join("<br>");

    // v0.9.1：结果统计网格（与日志同一份数据，换一种扫一眼的形态）
    if (el.statGrid) {
      el.statSent.textContent = String(st.segments);
      el.statChars.textContent = String(st.totalChars);
      el.statEngine.textContent = String(st.asrProfileLabel || st.asrProfile || "?") +
        " · " + String(st.asrModel || "?") + (st.asrModelIsDefault ? "（档位默认）" : "");
      el.statTimeline.textContent = ({
        upstream: "服务商原始时间戳",
        "reconstructed-by-chunk": "按静音切块重建",
        reconstructed: "按语音区间近似分配"
      }[st.asrTiming] || st.asrTiming || "?");
    }

    // 疑似误识别段多、且没开人声分离 → 给出"可能是 BGM 干扰"的建议
    if (st.suspectSegments && !params.doSeparate && !params.separateSkipped) {
      el.resultTip.style.display = "";
      el.resultTip.innerHTML = "有 " + st.suspectSegments + " 段疑似误识别。" +
        "如果素材里有背景音乐，到首页点「人声分离设置」开启人声分离后重跑，通常能明显改善。";
    } else {
      el.resultTip.style.display = "none";
    }
  }

  /* ---------------------------------------------------------- 询问弹层 */

  /**
   * 问「分离出的人声怎么放」——只在源素材是【纯音频】时调用。
   * 视频素材不弹框（按既定规则：关掉视频层的声音开关，人声贴到它下方）。
   *
   * @param {string} srcLayerName 源图层名，用于文案里指名道姓
   * @return {Promise<string|null>} "replace"（删原层，人声顶位）/ "below"（放它下方）/ null（取消）
   */
  function askReplaceMode(srcLayerName) {
    return new Promise(function (resolve) {
      el.askBody.textContent = "选中的「" + srcLayerName + "」是音频素材。" +
        "分离出的人声要替换它，还是放到它下方？";
      el.askHint.innerHTML =
        "<b>替换原音频</b>：删掉原层，人声占据它原来的位置（原素材仍在项目面板里，可随时拖回）。<br>" +
        "<b>放到它下方</b>：原层保留并照旧发声，人声作为独立一条轨道，方便你在混剪里单独取用。";
      el.askOverlay.style.display = "flex";

      var onReplace = null, onBelow = null, onCancel = null;
      function finish(v) {
        el.askOverlay.style.display = "none";
        el.askReplace.removeEventListener("click", onReplace);
        el.askBelow.removeEventListener("click", onBelow);
        el.askCancel.removeEventListener("click", onCancel);
        resolve(v);
      }
      onReplace = function () { finish("replace"); };
      onBelow = function () { finish("below"); };
      onCancel = function () { finish(null); };
      el.askReplace.addEventListener("click", onReplace);
      el.askBelow.addEventListener("click", onBelow);
      el.askCancel.addEventListener("click", onCancel);
    });
  }

  /**
   * 把流水线分离出的人声落成时间线图层（混剪用）。
   * 刻意不抛错：字幕此时已经建好了，入轨出问题只提示、不把整轮判成失败。
   */
  function placeVocalsFromPipeline(result, params, sel) {
    state.lastPlaced = null;
    if (!params.doSeparate || !params.placeVocalsMode) return Promise.resolve(null);
    var sep = result && result.separate;
    // 用 chosen 最稳妥：只分离模式下"分离目标"可能选的是伴奏，那时 vocals 是 null
    var asrFile = sep ? (sep.chosen || sep.vocals || sep.instrumental) : null;
    if (!sep || !asrFile) {
      log("没拿到分离产物的路径，跳过入轨（字幕已正常生成）", "warn");
      return Promise.resolve(null);
    }
    setStatus("正在把人声落到时间线…");
    setProgress(99);
    log("落轨：文件 " + asrFile);
    // 图层名跟人声文件名走：文件另存成第几轮（"无上光荣 2_人声.wav"），
    // 时间线上的图层就叫第几轮 —— 文件和图层永远对得上，不会被另一轮偷换内容。
    var vocBase = String(asrFile).replace(/\\/g, "/").split("/").pop()
      .replace(/\.(wav|mp3|flac|aiff?|aif)$/i, "");
    return AeApi.placeSeparatedAudio(sel.compName, sel.sourceLayerName, asrFile, {
      mode: params.placeVocalsMode,
      offsetSec: params.offsetSec || 0,
      layerBase: vocBase
    }).then(function (res) {
      if (!res.ok) { log("× 人声入轨失败：" + res.error, "err"); return null; }
      var d = res.data;
      state.lastPlaced = d;      // 给结果卡片显示用
      log("已放置人声图层「" + d.layerName + "」（第 " + d.layerIndex + " 层）", "ok");
      if (d.mutedSource) {
        log("  源层「" + d.sourceLayerName + "」已关闭声音开关 —— 原声还在那条层上，随时能拨回来", "ok");
      }
      if (d.removedSource) {
        log("  源层「" + d.sourceLayerName + "」已删除，人声占据了它原来的位置", "ok");
      }
      log("  时间对齐：人声文件的 0 秒 = 合成第 " + fmtSec(d.startTime) + " 秒；" +
        "层区间 " + fmtSec(d.inPoint) + " ~ " + fmtSec(d.outPoint) +
        " 秒（音频文件本身 " + fmtSec(d.fileDurationSec) + " 秒）");
      if (!d.footageImported) log("  （复用了工程里已有的同名素材，没重复导入）");
      if (d.dupNote) log("  ⚠ " + d.dupNote, "warn");
    }).catch(function (e) {
      log("× 人声入轨异常：" + (e.message || String(e)), "err");
      return null;
    });
  }

  /* ---------------------------------------------------------- 主流程 */

  /**
   * 「分离人声」—— 只做本地分离，并把产物落到时间线。
   *
   * 为什么单独一条路：很多时候只想要干净人声（拿去混剪），并不需要字幕 —— 走完整流程
   * 会白传一次云端。这条路把「读选中 → 定产物名 → 定落轨 → 导出 → 分离 → 落轨」跑完就停，
   * 然后问一句要不要接着识别（默认不接着做）：**云端那一步始终由你点头**。
   *
   * 它**不看**「人声分离设置」页那个总开关 —— 你既然点了这个按钮就是要分离；
   * 那个开关只管"生成字幕时顺带分离吗"。
   */
  function runSeparateOnly() {
    if (state.running) return;
    if (!state.env || state.env.problems.length) { setStatus("环境未就绪", "err"); return; }

    saveSettings();
    var params = collectParams();
    if (params.error) { setStatus(params.error, "err"); return; }

    el.logBox.open = true;

    // 分离环境要可用 —— 提前说清楚，别等导完音频才失败
    var uvr = state.uvr;
    var uvrOk = uvr && uvr.installed && (uvr.pythonOk !== false);
    if (!uvrOk) {
      setStatus("人声分离环境还没装好", "err");
      log("");
      log("=== 分离人声 ===");
      log("× 本机的人声分离环境还没装好（需要 Python 3.10~3.13 + audio-separator）。", "err");
      log("  到「人声分离设置」页点「一键安装环境」，装完再回来点这个按钮。", "warn");
      return;
    }

    state.running = true;
    updateRunButton();
    el.btnProbe.disabled = true;
    clearLog();
    el.resultCard.style.display = "none";
    el.resultTip.style.display = "none";
    setProgress(0);

    var t0 = Date.now();
    var sel = null;
    var reuseVocals = null;   // 「跳过分离，用已有的人声」选中的那条已有音频（非 null 时跳过导出与分离）
    state.lastPlaced = null;

    log("");
    log("=== 分离人声（本地运算：不上传、不识别、不建字幕层）===");

    Promise.resolve()
      .then(function () {
        setStatus("正在读取时间线选中的素材…");
        setProgress(2);
        return AeApi.getTimelineSelection(params.limitSec);
      })
      .then(function (res) {
        if (!res.ok) throw new Error("读取所选素材失败：" + res.error);
        sel = res.data;
        if (!sel.ready) throw new Error(sel.hint || "时间线上没有可处理的音频素材");
        log("合成「" + sel.compName + "」 · 选中 " + sel.selectedLayerCount + " 个图层，其中 " +
          sel.audioLayerCount + " 个带音频 · 处理区间 " +
          fmtSec(sel.rangeStart) + " ~ " + fmtSec(sel.rangeEnd) + " 秒");

        if (sel.sourceLayerIsSeparatedVocals) {
          log("× 选中的是上次生成的人声层「" + sel.sourceLayerName + "」——" +
            "它本身就是干净人声，再分一次只会得到垃圾。已停下。", "err");
          var e0 = new Error("选中的已经是人声层，无需再分离");
          e0.userCancel = true;
          throw e0;
        }

        // 产物名：与「生成字幕」同一套规则（源素材名；同名时问 覆盖 / 另存 / 取消）
        params.stem = baseStemFromLayer(sel.sourceLayerName);
        log("本轮产物名：「" + params.stem + "」—— 分离产物按它命名（取自源素材名）");
        if (!node || !params.outDir) return null;
        var hits = existingArtifacts(params.outDir, params.stem);
        if (!hits.length) return null;
        var reuseFile = reusableVocalsPath(params.outDir, params.stem);
        log("输出目录里已有同名产物：" + hits.join("、") +
          (reuseFile ? "" : "（其中没有可复用的人声音频）"), "warn");
        setStatus("等待你选择同名产物的处理方式…");
        return askOverwrite(params.stem, hits, { reuseFile: reuseFile }).then(function (v) {
          if (v === "cancel") {
            var e1 = new Error("已取消（未做任何改动）");
            e1.userCancel = true;
            throw e1;
          }
          if (v === "reuse") {
            // 这条路只分离、不识别，所以"复用"在这里的含义是：
            // 跳过重新分离（本机 CPU 几分钟），直接把已有的人声拿去落轨。
            reuseVocals = reuseFile;
            // ⚠ offsetSec 平时是"导出时回读出来的落点偏移"，而复用路径不导出，
            //   没有回读值可拿。用本轮选中区间的起点补上 —— 按区间导出时它就等于
            //   offsetSec（见 ae-bridge.jsx 的 AESub_exportAudio），落轨才不会错位。
            params.offsetSec = Number(sel.rangeStart) || 0;
            log("跳过重新分离，直接用已有的人声：「" + reuseFile + "」", "ok");
            log("  时间对齐：人声文件的 0 秒 = 合成 " +
              (Number(sel.rangeStart) || 0).toFixed(3) + " 秒（按本轮选中区间的起点）");
            return;
          }
          log("按你的选择覆盖旧产物（已落轨的旧图层声音会跟着变）", "warn");
        });
      })

      // 落轨方式：与「生成字幕」完全一致（视频源自动关声音 + 放它下方；音频源弹窗问）
      .then(function () {
        params.doSeparate = true;
        params.placeVocalsMode = null;
        if (sel.sourceLayerIsVideo) {
          params.placeVocalsMode = "video";
          log("源层「" + sel.sourceLayerName + "」是视频素材 → 关掉它的声音开关" +
            "（原声还在，随时能拨回），分离结果紧贴其下方");
          return null;
        }
        setStatus("等待你选择分离结果的落轨方式…");
        return askReplaceMode(sel.sourceLayerName).then(function (mode) {
          if (!mode) {
            var e = new Error("已取消（未做任何改动）");
            e.userCancel = true;
            throw e;
          }
          params.placeVocalsMode = mode;
          log(mode === "replace"
            ? "源层是音频素材 → 替换：删掉原层，分离结果顶上（原素材仍在项目面板，可拖回）"
            : "源层是音频素材 → 不替换：分离结果紧贴原层下方，原层照旧发声");
        });
      })

      // 导出这一段音频
      .then(function () {
        if (reuseVocals) {           // 复用时不需要中间音频，导出这一步整段跳过
          setProgress(6);
          log("跳过导出（复用已有的人声，不需要中间音频）");
          return null;
        }
        setStatus("正在从 AE 导出音频…");
        setProgress(6);
        var outNoExt = midAudioPath(params.outDir, sel.compName);
        log("导出音频（区间 " + fmtSec(sel.rangeStart) + " ~ " + fmtSec(sel.rangeEnd) + " 秒）…");
        return AeApi.exportAudio(sel.compName, sel.rangeStart, sel.rangeEnd, outNoExt);
      })
      .then(function (res) {
        if (reuseVocals) return null;      // 上面跳过了导出，这里没有返回值可读
        if (!res.ok) throw new Error("导出音频失败：" + res.error);
        var d = res.data;
        state.midAudio = d.file;
        params.offsetSec = d.offsetSec;
        log("已导出：" + d.file, "ok");
        log("  格式 " + d.format + " · 时长 " + fmtSec(d.durationSec) + " 秒 · " + fmtBytes(d.bytes));
      })

      // 只分离：带 --separate-only，流水线分离完就收工（不上传、不识别）
      .then(function () {
        // 复用：不跑分离，直接拼一个与"分离成功"等价的结果交给下游落轨
        if (reuseVocals) {
          setProgress(60);
          log("跳过本地分离（沿用已有的人声文件）", "ok");
          return {
            ok: true,
            reused: true,
            separate: {
              dir: joinPath(params.outDir, "_人声分离"),
              vocals: reuseVocals,
              instrumental: null,      // 复用时不去猜伴奏在哪，免得落轨落错文件
              chosen: reuseVocals,
              target: params.separateTarget,
              model: params.separateModel,
              elapsedSec: 0
            }
          };
        }
        setStatus("正在本地分离（不上传）…");
        var args = [
          joinPath(params.pipelineDir, "cli.js"),
          "--in", state.midAudio,
          "--out", params.outDir,
          "--name", params.stem,
          "--separate",
          "--separate-only",
          "--separate-target", params.separateTarget,
          "--separate-model", params.separateModel,
          "--separate-format", params.separateFormat,
          "--progress-json"
        ];
        if (params.separatePython) args.push("--separate-python", params.separatePython);
        if (params.separateKeep) args.push("--separate-keep");
        var mdSep = uvrModelsDir();
        if (mdSep) args.push("--model-file-dir", mdSep);
        log("分离设置：" + params.separateTargetLabel + " · 模型 " + params.separateModel);
        return runPipeline(params.nodePath, args, function (ev) {
          setProgress(ev.percent);
          markPipelineStep(ev.step, 1);
          if (ev.message) setStatus(ev.step + " · " + ev.message);
          if (typeof ev.percent === "number") log("[" + ev.percent + "%] " + (ev.message || ev.step));
        });
      })

      .then(function (result) {
        if (!result.ok) throw new Error(result.error || "分离失败");
        var sep = result.separate || {};
        log(result.reused
          ? "复用完成（没有重新跑分离）"
          : ("分离完成（用时 " + fmtSec(sep.elapsedSec) + " 秒）"), "ok");
        log("  人声 → " + (sep.vocals || "（本次未产出）"));
        if (sep.instrumental) log("  伴奏 → " + sep.instrumental);
        state.lastOutDir = params.outDir;
        state.lastFiles = {};              // 只分离流程没有字幕产物
        el.btnOpenOut.disabled = false;
        setProgress(96);
        return placeVocalsFromPipeline(result, params, sel).then(function () { return result; });
      })

      // 结果卡片 + 追问
      .then(function (result) {
        var sep = (result && result.separate) || {};
        var asrFile = sep.vocals || sep.chosen || sep.instrumental || null;
        var placed = state.lastPlaced;
        var rows = [];
        rows.push('<span class="k">合成</span>' + sel.compName + "<br>");
        if (sep.vocals) rows.push('<span class="k">人声</span><span class="mono">' + sep.vocals + "</span><br>");
        if (sep.instrumental) rows.push('<span class="k">伴奏</span><span class="mono">' + sep.instrumental + "</span><br>");
        if (placed) {
          rows.push('<span class="k">落轨</span>图层「' + placed.layerName + "」在第 " +
            placed.layerIndex + " 层<br>");
        }
        rows.push('<span class="k">耗时</span>' + fmtSec((Date.now() - t0) / 1000) + " 秒");
        el.resultInfo.innerHTML = rows.join("");
        el.resultCard.style.display = "";
        setProgress(100);

        // 导出的中间音频用完就删；分离产物是给人用的，保留
        if (state.midAudio) { removeMidAudio(state.midAudio, true); state.midAudio = null; }

        if (!asrFile) {
          setStatus("分离完成，但没拿到产物路径", "warn");
          return null;
        }
        setStatus("分离完成（未上传）", "ok");

        // 追问：要不要接着识别？云端那一步始终由用户点头
        return confirmDialog({
          title: "分离完成" + (placed ? "，人声已落轨" : ""),
          bodyHtml: '<div class="cleanSub">' +
            (placed ? ("时间线上已生成图层「" + placed.layerName + "」。")
                    : "产物文件已生成。") +
            "到这里为止<b>没有上传任何音频</b>。<br><br>" +
            "要不要接着把这段人声识别成字幕？接着做会把这段人声上传到你所选识别引擎的云端。</div>",
          okText: "接着识别并生成字幕",
          cancelText: "先不用",
          hint: "选「先不用」就到此为止 —— 人声已经能用了，也不会消耗一次云端识别额度。"
        }).then(function (r) {
          if (!r.ok) {
            log("到此为止 —— 本次全程没有上传音频。", "ok");
            log("  以后再想生成字幕，点右边的「生成字幕」即可。", "warn");
            return null;
          }
          state.resume = {
            asrInput: asrFile,
            stem: params.stem,
            offsetSec: params.offsetSec || 0
          };
          state.running = false;      // run() 会自己再置位
          updateRunButton();
          log("");
          log("接着识别 —— 用刚分离出的人声作为输入（不会重复导出、重复分离）。");
          return run();
        });
      })
      .catch(function (err) {
        if (err && err.userCancel) {
          setStatus(err.message || "已取消", "warn");
          log("× " + (err.message || "已取消"), "warn");
        } else {
          setStatus("失败：" + err.message, "err");
          log("× " + err.message, "err");
          setProgress(0);
        }
      })
      .then(function () {
        el.btnProbe.disabled = false;
        state.running = false;
        state.selSig = "";
        updateRunButton();
      });
  }

  function run() {
    if (state.running) return;
    if (!state.env || state.env.problems.length) { setStatus("环境未就绪", "err"); return; }

    saveSettings();
    var params = collectParams();
    if (params.error) { setStatus(params.error, "err"); return; }

    state.running = true;
    updateRunButton();
    el.btnProbe.disabled = true;
    clearLog();
    if (el.logBox) el.logBox.open = true;   // 跑起来就展开日志，否则用户看不到进度
    log("设置：识别完成后" + (params.createLayers
      ? "自动在 AE 中创建字幕图层"
      : "不创建字幕图层（只输出 .srt / .json）"), params.createLayers ? null : "warn");
    setProgress(0);
    state.midAudio = null;

    // 「分离人声」跑完后点"接着识别"时走的就是这条路：复用刚分离出的人声，
    // 不再导出、不再分离，只做识别与建层。
    var resume = state.resume || null;
    state.resume = null;

    var t0 = Date.now();
    var sel = null;
    var created = null;        // 实际创建的字幕图层数（null = 没进这一步）
    var skippedCount = 0;      // 被跳过的字幕段数
    state.lastPlaced = null;   // 上一轮的落轨结果，先清掉

    // 结果卡片是上一轮的，先收起来，避免和这次混在一起
    el.resultCard.style.display = "none";
    el.resultTip.style.display = "none";

    // —— 第一步：重新读取选中素材（避免用轮询缓存里的过期数据）——
    Promise.resolve()
      .then(function () {
        setStatus("正在读取时间线选中的素材…");
        setProgress(1);
        return AeApi.getTimelineSelection(params.limitSec);
      })
      .then(function (res) {
        if (!res.ok) throw new Error("读取所选素材失败：" + res.error);
        sel = res.data;
        if (!sel.ready) throw new Error(sel.hint || "时间线上没有可处理的音频素材");
        if (sel.truncated) {
          log("注意：素材长 " + humanSec(sel.truncatedFrom) + "，按设置只处理前 " +
            humanSec(sel.rangeDuration), "warn");
        }
        log("合成「" + sel.compName + "」 · 选中 " + sel.selectedLayerCount + " 个图层，其中 " +
          sel.audioLayerCount + " 个带音频 · 处理区间 " +
          fmtSec(sel.rangeStart) + " ~ " + fmtSec(sel.rangeEnd) + " 秒");
      })

      // —— 第一步又 1/4：决定产物名（源素材名；同名时问覆盖 / 另存 / 取消）——
      // 之前所有产物都跟合成名走，合成都叫"合成 1"时第二轮会把第一轮的
      // json/srt 和人声文件**覆盖掉** —— 尤其人声：第一轮落轨的图层引用那个路径，
      // 文件被覆盖后图层不报错，但声音悄悄变成了第二轮的。这里在上传云端之前问清楚。
      .then(function () {
        if (resume) {
          params.stem = resume.stem;
          log("沿用上一轮的产物名「" + params.stem + "」（刚分离出的人声就是按它命名的）");
          return null;
        }
        params.stem = baseStemFromLayer(sel.sourceLayerName);
        log("本轮产物名：「" + params.stem + "」—— json/srt 与人声文件都按它命名（取自源素材名）");

        if (!node || !params.outDir) return null;
        var hits = existingArtifacts(params.outDir, params.stem);
        if (!hits.length) return null;

        var reuseFile = reusableVocalsPath(params.outDir, params.stem);
        log("输出目录里已有同名产物：" + hits.join("、") +
          (reuseFile ? "" : "（其中没有可复用的人声音频）"), "warn");
        setStatus("等待你选择同名产物的处理方式…");
        return askOverwrite(params.stem, hits, { reuseFile: reuseFile }).then(function (v) {
          if (v === "cancel") {
            var e = new Error("已取消（未做任何改动，也未上传云端）");
            e.userCancel = true;
            throw e;
          }
          if (v === "reuse") {
            // 挂到与「分离人声 → 接着识别」**完全相同**的那条通路上（resume）：
            // 后面的步骤会自动跳过导出与分离，只做识别 + 建层。
            // 差别仅在于：这次的人声是上一轮留在磁盘上的，不是刚分离出来的。
            resume = {
              asrInput: reuseFile,
              stem: params.stem,
              // 复用路径没有"导出回读"那一步，用本轮选中区间的起点当偏移
              // （按区间导出时 offsetSec 就等于它，见 ae-bridge.jsx 的 AESub_exportAudio）
              offsetSec: Number(sel.rangeStart) || 0,
              viaReuse: true
            };
            log("复用上一轮分离出的人声（不再导出、不再分离）：" + reuseFile, "ok");
            log("  时间对齐：人声文件的 0 秒 = 合成 " +
              (Number(sel.rangeStart) || 0).toFixed(3) + " 秒（按本轮选中区间的起点）");
            return;
          }
          log("按你的选择覆盖旧产物（第一轮落轨的人声图层声音会跟着变）", "warn");
        });
      })

      // —— 第一步半：决定分离出的人声怎么落轨 ——
      // 放在导出之前：万一用户点"取消"，音频还没上传云端，不浪费一次识别
      .then(function () {
        if (resume) {
          params.doSeparate = false;      // 已经分离过了，这一步只识别
          params.placeVocalsMode = null;  // 人声也落过轨了，不再重复落轨
          log(resume.viaReuse
            ? "跳过导出与分离（用已存在的人声文件），这一步只做识别与建层。"
            : "人声已分离并落轨，这一步只做识别与建层。");
          return null;
        }
        params.doSeparate = !!params.separate;
        params.placeVocalsMode = null;
        params.separateSkipped = false;
        if (!params.doSeparate) return null;

        // 源层就是上一轮生成的人声层 → 再分离只会得到垃圾。跳过分离，直接拿它去识别。
        if (sel.sourceLayerIsSeparatedVocals) {
          log("检测到选中的是上次生成的人声层「" + sel.sourceLayerName + "」——" +
            "它本身已经是干净人声，已自动跳过分离，直接识别。", "warn");
          params.doSeparate = false;
          params.separateSkipped = true;
          return null;
        }

        log("识别完成后会把分离出的人声落到时间线，源层「" + sel.sourceLayerName + "」" +
          (sel.sourceLayerIsVideo ? "是视频素材" : "是音频素材"));

        if (sel.sourceLayerIsVideo) {
          params.placeVocalsMode = "video";
          log("  视频源 → 关掉它的声音开关（原声还在，随时能拨回），人声紧贴其下方");
          return null;
        }

        setStatus("等待你选择人声的落轨方式…");
        return askReplaceMode(sel.sourceLayerName).then(function (mode) {
          if (!mode) {
            var e = new Error("已取消（未做任何改动，也未上传云端）");
            e.userCancel = true;
            throw e;
          }
          params.placeVocalsMode = mode;
          log(mode === "replace"
            ? "  音频源 → 替换：删掉原层，人声顶上（原素材仍在项目面板，可拖回）"
            : "  音频源 → 不替换：人声紧贴原层下方，原层照旧发声");
        });
      })

      // —— 第二步：只导出这一段音频 ——
      .then(function () {
        if (resume) {
          // 人声已经在本地，不必再导出一次
          state.midAudio = resume.asrInput;
          params.offsetSec = resume.offsetSec || 0;
          setProgress(4);
          log("识别输入：" + (resume.viaReuse ? "上一轮分离出的" : "刚分离出的") +
            "人声「" + resume.asrInput + "」（不再导出、不再分离）");
          return null;
        }
        setStatus("正在从 AE 导出音频…");
        setProgress(3);
        var outNoExt = midAudioPath(params.outDir, sel.compName);
        log("导出音频（区间 " + fmtSec(sel.rangeStart) + " ~ " + fmtSec(sel.rangeEnd) +
          " 秒，不是整段合成）…");
        return AeApi.exportAudio(sel.compName, sel.rangeStart, sel.rangeEnd, outNoExt);
      })
      .then(function (res) {
        if (resume) return;              // resume 时上一步没导出，没有结果要解析
        if (!res.ok) throw new Error("导出音频失败：" + res.error);
        var d = res.data;
        state.midAudio = d.file;
        params.offsetSec = d.offsetSec;
        log("已导出：" + d.file, "ok");
        log("  格式 " + d.format + " · 时长 " + fmtSec(d.durationSec) + " 秒 · " +
          fmtBytes(d.bytes) + " · 导出耗时 " + fmtSec(d.elapsedSec) + " 秒");
        log("  时间偏移 " + fmtSec(d.offsetSec) + " 秒（字幕会整体平移这么多）" +
          (Math.abs(d.alignDriftSec) > 0.0001 ? "，AE 取整修正 " + fmtSec(d.alignDriftSec, 4) + " 秒" : ""));
        checkExportSize(d);
      })

      // —— 第三步：跑 Node 流水线（可能先做本地人声分离）——
      .then(function () {
        setStatus(params.separate ? "正在本地分离人声，然后上传识别…" : "正在识别（音频会上传云端）…");
        var offsetMs = Math.round((params.offsetSec || 0) * 1000);
        var args = [
          joinPath(params.pipelineDir, "cli.js"),
          "--in", state.midAudio,
          "--out", params.outDir,
          "--name", params.stem || safeName(sel.compName),
          "--max-chars", String(params.maxChars),
          "--offset-ms", String(offsetMs),
          "--progress-json"
        ];
        var mdRun = uvrModelsDir();
        if (mdRun) args.push("--model-file-dir", mdRun);
        if (params.dropSuspect) args.push("--drop-suspect");
        if (!params.snapSpeech) args.push("--no-snap-speech");
        if (params.stripPunct) args.push("--strip-punct");
        // 识别引擎：非密钥部分走命令行，密钥走环境变量（见 runPipeline 的说明）
        args.push("--asr-provider", params.asrProvider);
        args.push("--asr-profile", params.asrProfile);
        if (params.asrModel) args.push("--asr-model", params.asrModel);
        if (params.asrBaseUrl) args.push("--asr-base-url", params.asrBaseUrl);
        if (params.asrPrompt) args.push("--asr-prompt", params.asrPrompt);
        if (!params.asrChunk) args.push("--no-chunk-asr");
        var asrEnv = {};
        if (params.asrApiKey) asrEnv.AESUB_API_KEY = params.asrApiKey;
        if (params.asrSecretId) asrEnv.AESUB_SECRET_ID = params.asrSecretId;
        if (params.asrSecretKey) asrEnv.AESUB_SECRET_KEY = params.asrSecretKey;
        // 本地引擎（whisper.cpp）：数据目录与"是否用显卡"也走环境变量 ——
        // 数据目录本来就在面板里可配，provider 不该去猜；NO_GPU=1 表示强制走 CPU。
        var ddLocal = el.dataDir.value.trim();
        if (ddLocal) asrEnv.AESUB_DATA_DIR = ddLocal;
        if (el.localGpu && !el.localGpu.checked) asrEnv.AESUB_WHISPER_NO_GPU = "1";
        // 把"用哪家 + 哪个模型"都打出来。用户常常只选了服务商没选模型（走档位默认），
        // 识别质量不对时，光看服务商是没法定位问题的。
        var asrP = currentAsrProfile();
        var modelTxt = params.asrModel
          || ((asrP && asrP.model) ? asrP.model + "（档位默认）" : "档位默认");
        log("识别引擎：" + params.asrLabel + " · 模型 " + modelTxt +
          (params.asrChunk ? "" : " · 已关闭切块"));
        // 用 doSeparate 而不是 separate：源层本来就是人声层时会跳过分离，但用户意图仍是"开了分离"
        if (params.doSeparate) {
          args.push("--separate");
          args.push("--separate-target", params.separateTarget);
          args.push("--separate-model", params.separateModel);
          args.push("--separate-format", params.separateFormat);
          if (params.separatePython) args.push("--separate-python", params.separatePython);
          if (params.separateKeep) args.push("--separate-keep");
          log("人声分离已开启：" + params.separateTargetLabel + " · 模型 " + params.separateModel);
        }
        log("启动流水线…");
        return runPipeline(params.nodePath, args, function (ev) {
          setProgress(ev.percent);
          markPipelineStep(ev.step, 3);
          if (ev.message) setStatus(ev.step + " · " + ev.message);
          if (typeof ev.percent === "number") log("[" + ev.percent + "%] " + (ev.message || ev.step));
        }, asrEnv);
      })

      .then(function (result) {
        if (!result.ok) throw new Error(result.error || "流水线执行失败");
        var st = result.stats || {};
        log("识别完成：共 " + st.segments + " 段、" + st.totalChars + " 字，语音覆盖 " +
          st.coveragePercent + "%" +
          (st.suspectSegments ? "，其中 " + st.suspectSegments + " 段疑似误识别（已标记）" : "") +
          " · 引擎 " + String(st.asrProfileLabel || st.asrProfile || "") +
          " / " + String(st.asrModel || "?") +
          (st.asrModelIsDefault ? "（档位默认）" : "") +
          " · 时间轴 " + ({
            upstream: "服务商原始时间戳",
            "reconstructed-by-chunk": "按静音切块重建",
            reconstructed: "按语音区间近似分配"
          }[st.asrTiming] || st.asrTiming || "?") +
          (st.asrFailedChunks ? "（" + st.asrFailedChunks + " 块失败）" : "") +
          " · 上传格式 " + String(st.uploadCodec || "").toUpperCase() +
          "（" + fmtBytes(st.uploadBytes) + "）", "ok");
        if (!st.segments) throw new Error("没有识别到任何语音内容，请确认选中的素材里确实有人在说话");

        state.lastOutDir = params.outDir;
        state.lastFiles = result.outputs || {};
        el.btnOpenOut.disabled = false;

        if (!params.createLayers) {
          // 没勾「自动落轨」⇒ 停下来让用户核对文字，确认后才建层（v1.0.0 的校对环节）
          created = null;
          skippedCount = 0;
          enterCheckMode(result, params, sel, st);
          // 总开关关着时不建字幕层，但人声入轨是独立的诉求，照做
          return placeVocalsFromPipeline(result, params, sel).then(function () {
            showResult(st, sel.compName, null, 0, params);
          });
        }
        setStatus("正在 AE 中创建字幕图层…");
        setProgress(97);
        setStepCells(3);
        return doCreateLayers(result.outputs.json, params, sel.compName).then(function (res) {
          if (!res.ok) throw new Error("创建字幕图层失败：" + res.error);
          created = res.data.created;
          skippedCount = res.data.skipped || 0;
          if (res.data.skippedEmpty) {
            log("  跳过的段落里有 " + res.data.skippedEmpty + " 段是纯空白文字（识别噪声），已过滤", "warn");
          }
          setStepCells(4);
          log("已在合成「" + sel.compName + "」中创建 " + res.data.created + " 个字幕图层" +
            (res.data.skipped ? "（跳过 " + res.data.skipped + " 段）" : ""), "ok");
          if (res.data.fontApplied) log("  字体已生效：" + res.data.fontApplied, "ok");
          // 字体被 AE 静默替换是常见坑，必须让用户看见
          if (res.data.fontNote) log("  ⚠ " + res.data.fontNote, "warn");
          if (res.data.presetApplied) log("  预设已应用：" + res.data.presetApplied, "ok");
      if (res.data.presetShiftNote) log("  " + res.data.presetShiftNote);
      if (res.data.presetScaledLayers || res.data.presetStaticLayers || res.data.presetSkippedShort) {
        log("  预设动画适配：" + (res.data.presetScaledLayers || 0) + " 层铺满句子" +
          (res.data.presetStaticLayers ? "、" + res.data.presetStaticLayers + " 层因句子过短改为静止显示" : "") +
          (res.data.presetSkippedShort ? "、" + res.data.presetSkippedShort + " 层按设置不套预设" : ""));
      }
          if (res.data.presetNote) log("  ⚠ " + res.data.presetNote, "warn");
        })
        // —— 第六步：把分离出的人声落成时间线图层（混剪用）——
        .then(function () {
          return placeVocalsFromPipeline(result, params, sel);
        })
        // 结果卡片放在最后画，这样它能带上"落轨"那一行
        .then(function () {
          showResult(st, sel.compName, created, skippedCount, params);
        });
      })

      .then(function () {
        if (!params.keepAudio) removeMidAudio(state.midAudio);
        setProgress(100);
        var secs = Math.round((Date.now() - t0) / 100) / 10;
        setStatus((params.createLayers ? "全部完成" : "已生成字幕文件（未建图层）") +
          "，用时 " + secs + " 秒", "ok");
        log("产物目录：" + params.outDir, "ok");
      })

      .catch(function (err) {
        // 用户在询问弹层点了"取消"：不是故障，别报成失败
        if (err && err.userCancel) {
          setStatus("已取消", "warn");
          log("已取消（未做任何改动，也未上传云端）", "warn");
          setProgress(0);
          return;
        }
        setStatus("失败：" + err.message, "err");
        log("× " + err.message, "err");
        if (state.midAudio) {
          log("中间音频已保留，便于排障：" + state.midAudio, "warn");
        }
        setProgress(0);
      })

      .then(function () {
        state.running = false;
        el.btnProbe.disabled = false;
        state.selSig = "";          // 强制下一次轮询重绘
        updateRunButton();
      });
  }

  /** 试导出：只做"选中素材 → 导出音频"，不上传云端。用来零成本验证导出环节 */
  function testExport() {
    if (state.running) return;
    saveSettings();
    var params = collectParams();
    if (params.error) { setStatus(params.error, "err"); return; }

    state.running = true;
    updateRunButton();
    clearLog();
    if (el.logBox) el.logBox.open = true;
    setProgress(0);
    var sel = null;

    Promise.resolve()
      .then(function () {
        setStatus("试导出：读取选中素材…");
        return AeApi.getTimelineSelection(params.limitSec);
      })
      .then(function (res) {
        if (!res.ok) throw new Error("读取所选素材失败：" + res.error);
        sel = res.data;
        if (!sel.ready) throw new Error(sel.hint || "时间线上没有可处理的音频素材");
        log("合成「" + sel.compName + "」 · 处理区间 " + fmtSec(sel.rangeStart) + " ~ " +
          fmtSec(sel.rangeEnd) + " 秒（" + humanSec(sel.rangeDuration) + "）");
        setProgress(20);
        return AeApi.exportAudio(sel.compName, sel.rangeStart, sel.rangeEnd,
          midAudioPath(params.outDir, sel.compName));
      })
      .then(function (res) {
        if (!res.ok) throw new Error("导出失败：" + res.error);
        var d = res.data;
        state.midAudio = d.file;
        setProgress(90);
        log("✓ 导出成功", "ok");
        log("  文件：" + d.file);
        log("  格式 " + d.format + "（模板：" + d.template + "）");
        log("  时长 " + fmtSec(d.durationSec) + " 秒 · " + fmtBytes(d.bytes));
        log("  时间偏移 offsetSec = " + fmtSec(d.offsetSec) + " 秒（应等于区间起点 " +
          fmtSec(sel.rangeStart) + "）");
        if (Math.abs(d.offsetSec - sel.rangeStart) > 0.05) {
          log("  ⚠ 偏移与区间起点不一致，字幕可能错位，请把这个日志发给我", "err");
        }
        log("  导出耗时 " + fmtSec(d.elapsedSec) + " 秒");
        var sizeOk = checkExportSize(d);
        if (sizeOk) {
          removeMidAudio(d.file, true);
          log("（试导出产物已删除，未上传云端）");
          setStatus("试导出通过，导出环节正常", "ok");
        } else {
          log("（为便于排障，这个异常产物已保留：" + d.file + "）", "warn");
          setStatus("试导出发现异常：导出体积远超预期", "err");
        }
        setProgress(100);
        el.btnOpenOut.disabled = false;
      })
      .catch(function (err) {
        setStatus("试导出失败：" + err.message, "err");
        log("× " + err.message, "err");
        setProgress(0);
      })
      .then(function () {
        state.running = false;
        updateRunButton();
      });
  }

  /** 收集并校验界面参数 */
  /* ---------------------------------------------------------- 识别引擎 */

  /**
   * 当前选中的引擎档位。
   * 刻意**不在前端硬编码任何服务商**：清单由 cli.js --list-asr 给，
   * 以后加一家新服务商只用改 pipeline，面板不用动。
   */
  function currentAsrProfile() {
    if (!state.asrProfiles || !state.asrProfiles.length) return null;
    var id = el.asrProfile.value;
    for (var i = 0; i < state.asrProfiles.length; i++) {
      if (state.asrProfiles[i].profile === id) return state.asrProfiles[i];
    }
    return state.asrProfiles[0];
  }

  /** 从流水线拉引擎清单（cli.js --list-asr） */
  function loadAsrProfiles(done) {
    if (!node || !state.env || !state.env.node || !el.pipelineDir.value.trim()) {
      if (done) done();
      return;
    }
    var pipe = el.pipelineDir.value.trim();
    var cli = joinPath(pipe, "cli.js");
    node.child_process.execFile(
      state.env.node.path, [cli, "--list-asr"],
      { cwd: pipe, windowsHide: true, timeout: 30000, maxBuffer: 1 << 22 },
      function (err, stdout) {
        if (err) {
          el.asrHint.textContent = "读取引擎清单失败：" + (err.message || err) +
            "（若流水线目录不对，请在「环境与诊断」里改正）";
          log("× 读取识别引擎清单失败：" + (err.message || err), "err");
          if (done) done();
          return;
        }
        try {
          var txt = String(stdout || "").trim();
          var lines = txt.split(/\r?\n/);
          var d = JSON.parse(lines[lines.length - 1]);
          state.asrProfiles = d.profiles || [];
          fillAsrSelect(d.default);
          syncAsrUi();
          log("识别引擎清单已加载：" + state.asrProfiles.length + " 个档位");
        } catch (e) {
          el.asrHint.textContent = "引擎清单解析失败：" + e.message;
          log("× 引擎清单解析失败：" + e.message, "err");
        }
        if (done) done();
      }
    );
  }

  /** 把档位灌进下拉框，并恢复用户上次的选择 */
  function fillAsrSelect(def) {
    var saved = lsGet(LS.asrProfile, (def && def.profile) || "");
    el.asrProfile.innerHTML = "";
    var found = -1;
    for (var i = 0; i < state.asrProfiles.length; i++) {
      var p = state.asrProfiles[i];
      var o = document.createElement("option");
      o.value = p.profile;
      o.textContent = p.label + (p.timestamps === "segments" ? "・有时间戳" : "");
      el.asrProfile.appendChild(o);
      if (p.profile === saved) found = i;
    }
    el.asrProfile.selectedIndex = found >= 0 ? found : 0;
  }

  /**
   * 灌「挑一个」下拉框。
   *
   * 为什么不用 `<datalist>`：Chromium 的 datalist **只在输入框开始打字之后才弹建议**，
   * 而且**没有可点的下拉箭头** —— 用户打开面板看到的是一片空白，会以为功能没做。
   * 换成真正的 `<select>`：点一下就能看到全部候选。这是实测踩过的坑。
   */
  function fillModelPick(list, note) {
    if (!el.asrModelPick) return;
    var cur = el.asrModel.value.trim();
    el.asrModelPick.innerHTML = "";
    var head = document.createElement("option");
    head.value = "";
    head.textContent = note || "（选一个填入上面的输入框）";
    el.asrModelPick.appendChild(head);
    (list || []).forEach(function (id) {
      var o = document.createElement("option");
      o.value = id;
      o.textContent = id + (id === cur ? "   ← 当前" : "");
      el.asrModelPick.appendChild(o);
    });
    el.asrModelPick.value = "";
  }

  /** 档位 → 界面联动：密钥形态、额度提示、模型清单 */
  function syncAsrUi() {
    var p = currentAsrProfile();
    if (!p) {
      el.asrHint.textContent = "还没读到引擎清单。点「环境与诊断 → 重新检测环境」可重试。";
      return;
    }
    var isPair = p.keyMode === "pair";
    el.asrKeyRow.style.display = isPair ? "none" : "";
    el.asrPairRow.style.display = isPair ? "" : "none";
    el.asrConsoleRow.style.display = p.consoleUrl ? "" : "none";

    var kind = p.timestamps === "segments"
      ? "服务商直接返回时间戳，对齐最准"
      : (p.timestamps === "none"
        ? "只回文字、不回时间戳 ⇒ 流水线会自动按静音切块重建时间轴"
        : "时间戳能力取决于你填的服务");
    var msg = (p.freeNote ? p.freeNote + "；" : "") + kind;
    if (!p.reachableInCn) msg += "（该服务在境外，国内网络通常要挂代理）";
    el.asrHint.textContent = msg;

    var limTxt = p.maxFileBytes ? "约 " + (p.maxFileBytes / 1048576).toFixed(0) + "MB" : "未声明";
    el.asrQuota.textContent = "单文件上限 " + limTxt +
      (p.maxDurationSec ? "，单次时长上限约 " + Math.round(p.maxDurationSec / 60) + " 分钟" : "") +
      "；超出会自动压缩或切块，不会硬撞上限。";

    // 当前将用哪个模型 —— 手填优先，否则档位默认。**必须显式标出"档位默认"**，
    // 否则用户会误以为是自己填的，排查质量问题时方向就错了。
    var chosen = el.asrModel.value.trim();
    var ms = (p.models || []).map(function (m) {
      return m.id + (m.note ? "（" + m.note + "）" : "");
    }).join("；");
    el.asrModelHint.textContent =
      "当前将使用：" + (chosen || (p.model ? p.model + "（档位默认）" : "（未指定）")) +
      (ms ? "｜该档位可选模型：" + ms : "");

    // 可选的模型清单：**服务商实时拉到的那份优先**（点「测试密钥」会拉），
    // 没拉过时才用档位内置清单。否则每次刷新界面都会把实时清单顶掉。
    if (state.asrModelList && state.asrModelList.length) {
      fillModelPick(state.asrModelList, "（服务商实时清单 · " + state.asrModelList.length + " 个）");
    } else {
      fillModelPick((p.models || []).map(function (m) { return m.id; }),
        "档位内置清单（点「测试密钥」可拉取服务商实时清单）");
    }
    // ---- 本地档位（whisper.cpp）：云端那套密钥 / 额度 / 模型清单对它都不适用 ----
    var isLocal = p.provider === "local";
    if (el.asrLocalBlock) el.asrLocalBlock.style.display = isLocal ? "" : "none";
    if (el.asrAdvBox) el.asrAdvBox.style.display = isLocal ? "none" : "";
    if (el.asrKeyNote) el.asrKeyNote.style.display = isLocal ? "none" : "";
    if (el.asrQuota) el.asrQuota.style.display = isLocal ? "none" : "";
    // 只在还没有快照时拉一次（避免每次刷新界面都起一个子进程）
    if (isLocal && !state.asrLocalStatus) refreshLocalStatus();

    syncEngineBar();
  }

  /* ---------------------------------------------------------- 字幕校对（v1.0.0） */

  /**
   * 识别完成但没勾「自动落轨」⇒ 停在校对页。
   * 面板直接读流水线产出的 .json（格式 [{text,startMs,endMs}]），逐条核对改字，
   * 确认后**写回 .json** 再走原来的建层链路。
   * 这样"改字"发生在建层之前，AE 里不会先冒出一堆需要手工改的图层。
   */
  function enterCheckMode(result, params, sel, st) {
    var jsonPath = result && result.outputs && result.outputs.json;
    if (!jsonPath) { log("× 拿不到识别结果路径，跳过校对。", "err"); return false; }
    var segs = [];
    try {
      var raw = String(node.fs.readFileSync(jsonPath, "utf8")).replace(/^\uFEFF/, "");
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = (arr && arr.segments) || [];
      segs = arr.map(function (s) {
        var tx = String((s && s.text) == null ? "" : s.text);
        return {
          text: tx, orig: tx,
          startMs: Number((s && s.startMs) || 0),
          endMs: Number((s && s.endMs) || 0),
          suspect: !!(s && s.suspect)
        };
      });
    } catch (e) {
      log("× 读不出识别结果（" + jsonPath + "）：" + (e && e.message ? e.message : e), "err");
      return false;
    }
    if (!segs.length) { log("× 识别结果里没有字幕段，跳过校对。", "err"); return false; }

    state.pending = { jsonPath: jsonPath, segs: segs, params: params, comp: sel.compName, st: st };
    renderCheckList();
    showPage("work", "check");
    setStatus("识别完成：共 " + segs.length + " 条 —— 核对文字后点「确认并落轨」", "warn");
    return true;
  }

  /** 把识别结果画成可编辑列表（时间码 + 输入框） */
  function renderCheckList() {
    if (!el.checkList || !state.pending) return;
    var segs = state.pending.segs;
    el.checkList.innerHTML = "";
    for (var i = 0; i < segs.length; i++) {
      (function (s) {
        var row = document.createElement("div");
        row.className = "cline" + (s.suspect ? " low" : "");
        var t = document.createElement("span");
        t.className = "t";
        t.textContent = (s.startMs / 1000).toFixed(1) + "s";
        var inp = document.createElement("input");
        inp.value = s.text;
        inp.addEventListener("input", function () {
          s.text = inp.value;
          row.classList.toggle("edited", s.text !== s.orig);
          updateCheckStats();
        });
        row.appendChild(t);
        row.appendChild(inp);
        el.checkList.appendChild(row);
      })(segs[i]);
    }
    if (el.checkEmpty) el.checkEmpty.style.display = segs.length ? "none" : "block";
    updateCheckStats();
  }

  /** 顶部三格：条数 / 已改 / 低置信 */
  function updateCheckStats() {
    var segs = (state.pending && state.pending.segs) || [];
    var ed = 0, lo = 0;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].text !== segs[i].orig) ed++;
      if (segs[i].suspect) lo++;
    }
    if (el.statSent2) el.statSent2.textContent = String(segs.length);
    if (el.statEdited) el.statEdited.textContent = String(ed);
    if (el.statLow) el.statLow.textContent = String(lo);
  }

  /** 「确认并落轨」：写回 .json，再走原来的建层链路 */
  function commitCheck() {
    var p = state.pending;
    if (!p) { log("还没有可落轨的识别结果，先点一次「生成字幕」。", "warn"); return; }
    var out = [];
    for (var i = 0; i < p.segs.length; i++) {
      out.push({ text: p.segs[i].text, startMs: p.segs[i].startMs, endMs: p.segs[i].endMs });
    }
    try {
      node.fs.writeFileSync(p.jsonPath, JSON.stringify(out), "utf8");
      log("已把核对后的 " + out.length + " 条写回：" + p.jsonPath, "ok");
    } catch (e) {
      log("× 写回识别结果失败：" + (e && e.message ? e.message : e), "err");
      return;
    }
    state.pending = null;
    setStatus("正在 AE 中创建字幕图层…");
    setProgress(97);
    showPage("work", "out");
    doCreateLayers(p.jsonPath, p.params, p.comp).then(function (res) {
      if (!res.ok) throw new Error(res.error);
      setStepCells(4);
      log("已在合成「" + p.comp + "」中创建 " + res.data.created + " 个字幕图层" +
        (res.data.skipped ? "（跳过 " + res.data.skipped + " 段）" : ""), "ok");
      if (res.data.fontApplied) log("  字体已生效：" + res.data.fontApplied, "ok");
      if (res.data.fontNote) log("  ⚠ " + res.data.fontNote, "warn");
      if (res.data.presetApplied) log("  预设已应用：" + res.data.presetApplied, "ok");
      setStatus("已落轨：" + res.data.created + " 个字幕图层", "ok");
      setProgress(100);
      if (p.st) showResult(p.st, p.comp, res.data.created, res.data.skipped || 0, p.params);
    }).catch(function (err) {
      setStatus("落轨失败：" + (err && err.message ? err.message : err), "err");
      log("× 落轨失败：" + (err && err.message ? err.message : err), "err");
    });
  }

  /** 建字幕层 —— 抽出来给「自动落轨」和「校对后落轨」共用 */
  function doCreateLayers(jsonPath, params, compName) {
    return AeApi.createSubtitleLayers(compName, jsonPath, {
      mode: params.mode,
      fontSize: params.fontSize,
      color: params.color,
      yPercent: params.yPercent,
      fontPostScriptName: params.fontPostScriptName,
      presetPath: params.presetPath,
      prefix: params.subPrefix || "字幕",
      nameMode: params.nameMode,
      skipPresetOnShort: params.skipPresetShort
    });
  }

  /* ---------------------------------------------------------- 本地引擎（whisper.cpp） */

  /**
   * 本地档位下拉：三个档位，并标出哪些已经下载。
   * 数据来自 cli.js --local-status（查本机文件，不联网）。
   */
  function fillLocalModelSelect(st) {
    if (!el.localModel) return;
    var saved = lsGet(LS.localModel, "medium");
    var list = (st && st.models && st.models.length) ? st.models : [
      { id: "small", sizeMB: 466, note: "快" },
      { id: "medium", sizeMB: 1530, note: "中文够用（推荐）" },
      { id: "large-v3-turbo", sizeMB: 1620, note: "最准，最慢" }
    ];
    var done = {};
    ((st && st.downloaded) || []).forEach(function (d) { done[d.id] = true; });
    el.localModel.innerHTML = "";
    list.forEach(function (mo) {
      var o = document.createElement("option");
      o.value = mo.id;
      o.textContent = mo.id + " · 约 " + mo.sizeMB + " MB · " + (mo.note || "") +
        (done[mo.id] ? "（已下载）" : "");
      el.localModel.appendChild(o);
    });
    el.localModel.value = saved;
    if (el.localModel.selectedIndex < 0) el.localModel.selectedIndex = 1;
    // ⚠ 关键：保存的档位没下载、而别的档位已经下载了 ⇒ 自动切到已下载的那个。
    //   否则用户会看到「未下载」，而他明明有模型 —— 只是档位与文件对不上（实测踩过：
    //   存档里是 medium，磁盘上只有 large-v3-turbo）。
    if (!done[el.localModel.value]) {
      for (var i = 0; i < list.length; i++) {
        if (done[list[i].id]) {
          el.localModel.value = list[i].id;
          try { lsSet(LS.localModel, list[i].id); } catch (ePick) { }
          break;
        }
      }
    }
  }

  /** 状态格：三态用现成的 .envgrid 变体类（off 灰 / warn 黄 / bad 红），不新增 CSS */
  function setLocalCell(id, cls, txt) {
    var c = el[id];
    if (!c) return;
    c.className = cls ? "er " + cls : "er";
    var b = c.querySelector("b");
    if (b) b.textContent = txt;
  }

  /** 本地环境四格：whisper.cpp / 模型 / GPU / 离线 */
  function renderLocalStatus(st) {
    if (!el.asrLocalBlock || !st) return;
    var cur = el.localModel ? el.localModel.value : "medium";
    var has = {};
    (st.downloaded || []).forEach(function (x) { has[x.id] = true; });
    var base = "";
    try { base = node && node.path ? node.path.basename(st.exe.path || "") : ""; } catch (e) { base = ""; }
    var gpuOn = !(el.localGpu && !el.localGpu.checked);

    setLocalCell("lgExe", st.exe.path ? "" : "bad", st.exe.path ? (base + " 已就位") : "未安装");
    setLocalCell("lgModel", has[cur] ? "" : (st.exe.path ? "warn" : "off"),
      has[cur] ? (cur + " · 已下载") : "未下载");
    setLocalCell("lgGpu", st.cuda.ok ? "" : (gpuOn ? "warn" : "off"),
      st.cuda.ok ? "可用 · 检测到 CUDA" : (gpuOn ? "未检测到 CUDA" : "已关闭 · 走 CPU"));
    setLocalCell("lgOffline", "", "断网也能跑");

    var hint = st.detail || "";
    var others = (st.downloaded || []).map(function (x) { return x.id; });
    if (st.exe.path && !has[cur]) {
      hint = "当前档位（" + cur + "）的模型还没下载。" +
        (others.length
          ? "你已下载：" + others.join("、") + "，把它选成档位就能用。"
          : "点「下载模型」装当前档位。");
    }
    if (el.localModelHint) {
      el.localModelHint.textContent = hint + "（模型目录：" + (st.modelDir || "?") + "）";
    }
    // 「模型与引擎 › 本地模型」那一页的说明也刷新成真实状态，别只写一句通用提示
    if (el.engLocalNote) {
      el.engLocalNote.textContent = has[cur]
        ? "当前档位 " + cur + " 的权重已就位。模型目录：" + (st.modelDir || "?")
        : ("当前档位 " + cur + " 的权重未下载" +
           (others.length ? "；已下载：" + others.join("、") + "。" : "。"));
    }
  }

  /** 拉一次本地环境状态（cli.js --local-status）—— 只查本机文件，不联网、不花钱 */
  function refreshLocalStatus() {
    if (!node || !state.env || !state.env.node || !el.pipelineDir.value.trim()) return;
    var pipe = el.pipelineDir.value.trim();
    var cli = joinPath(pipe, "cli.js");
    var env = {};
    try { env = Object.assign({}, process.env); } catch (e) { env = {}; }
    var dd = el.dataDir.value.trim();
    if (dd) env.AESUB_DATA_DIR = dd;
    if (el.localGpu && !el.localGpu.checked) env.AESUB_WHISPER_NO_GPU = "1";
    node.child_process.execFile(
      state.env.node.path, [cli, "--local-status"],
      { cwd: pipe, windowsHide: true, timeout: 20000, maxBuffer: 1 << 20, env: env },
      function (err, stdout) {
        if (err) {
          if (el.localModelHint) el.localModelHint.textContent = "本地环境检测失败：" + (err.message || err);
          return;
        }
        var lines = String(stdout || "").trim().split(/\r?\n/);
        var d = null;
        for (var i = lines.length - 1; i >= 0; i--) {
          try { d = JSON.parse(lines[i]); break; } catch (e2) { /* 不是 JSON 就往前找 */ }
        }
        if (!d) return;
        state.asrLocalStatus = d;
        fillLocalModelSelect(d);
        renderLocalStatus(d);
      }
    );
  }

  /**
   * 「下载模型」：**真下载**（whisper.cpp 二进制 + 当前档位权重），带进度与断点续传。
   *
   * 为什么是"一次装齐"而不是让用户自己找文件：这两个东西的来源都不好找
   * （二进制在 GitHub，权重在 HuggingFace），而且国内网络两个都要绕 ——
   * 流水线里已经把绕法写死了（走 api.github.com 与 hf-mirror），面板只要调它。
   */
  function fetchLocal() {
    if (state.localBusy || state.running) return;
    if (!node || !state.env || !state.env.node) {
      setStatus("外部 Node 不可用 —— 先点「重新检测环境」", "err");
      return;
    }
    var pipe = el.pipelineDir.value.trim();
    if (!pipe) { setStatus("流水线目录是空的，先在下面填好", "err"); return; }
    var cli = joinPath(pipe, "cli.js");
    var dd = el.dataDir.value.trim();
    var env = {};
    try { env = Object.assign({}, process.env); } catch (e) { env = {}; }
    if (dd) env.AESUB_DATA_DIR = dd;

    var which = (el.localRuntime && el.localRuntime.value) || "blas";
    var mo = (el.localModel && el.localModel.value) || "medium";

    state.localBusy = true;
    el.btnLocalModel.disabled = true;
    setProgress(0);
    log("");
    log("=== 下载本地引擎 ===");
    log("  运行时：" + which + " · 模型：" + mo);
    log("  （二进制来自 GitHub、权重来自 hf-mirror；断了会自动续传，慢但能下完）");
    setStatus("开始下载…");

    var args = [cli, "--local-fetch", "all",
                "--local-which", which,
                "--local-model", mo];
    if (dd) args.push("--data-dir", dd);

    runPipeline(state.env.node.path, args, function (ev) {
      if (ev && ev.percent != null) setProgress(ev.percent);
      if (ev && ev.message) setStatus(ev.message);
      if (ev && ev.retry) log("  " + ev.message, "warn");
      if (ev && ev.stage === "extract") log("  解压中…");
    }, env).then(function () {
      log("  下载流程结束，重新检测本地环境…");
    }).catch(function (err) {
      log("× 下载失败：" + (err && err.message ? err.message : err), "err");
      setStatus("下载失败 —— 详见下方日志", "err");
    }).then(function () {
      state.localBusy = false;
      el.btnLocalModel.disabled = false;
      setProgress(0);
      state.asrLocalStatus = null;   // 清掉快照，让 syncAsrUi 重新探一次
      refreshLocalStatus();
    });
  }

  /**
   * 「清理模型」：把已下载的**本地权重**删到回收站。
   * 刻意不动 whisper.cpp 二进制 —— 它才十几 MB，删了下次还得重下，没意义。
   */
  function doCleanLocalModels() {
    if (state.busyClean || state.localBusy || state.running) return;
    if (!AeClean.available()) { setStatus("面板里的 Node 未启用，无法清理", "err"); return; }
    var dd = el.dataDir.value.trim();
    if (!dd) { setStatus("先把「数据目录」填上 —— 本地权重就放在它下面", "err"); return; }
    var dir = joinPath(dd, "models", "whisper");

    var items = [];
    try {
      node.fs.readdirSync(dir).forEach(function (n) {
        if (!/\.bin$/i.test(n)) return;
        var p = joinPath(dir, n);
        items.push({ name: n, path: p, size: node.fs.statSync(p).size });
      });
    } catch (e) { items = []; }

    if (!items.length) {
      log("清理本地模型：目录里没有已下载的权重（" + dir + "）。", "ok");
      setStatus("没有已下载的本地模型", "ok");
      return;
    }

    var total = items.reduce(function (a, b) { return a + b.size; }, 0);
    var rows = ['<div class="cleanSub" style="margin-bottom:6px">以下权重将被删到<b>回收站</b>：</div>'];
    items.forEach(function (it) {
      rows.push('<div class="cleanGroup"><span class="cgBody"><span class="cgName">' +
        it.name + '</span><span class="cgSize">' + fmtBytes(it.size) + "</span></span></div>");
    });
    rows.push('<div class="cleanTotal">合计 <b>' + items.length + "</b> 个 · <b>" + fmtBytes(total) + "</b></div>");

    state.busyClean = true;
    el.btnCleanLocal.disabled = true;
    confirmDialog({
      title: "清理本地模型",
      bodyHtml: rows.join(""),
      showPerm: true,
      permDefault: true,
      okText: "确认清理",
      hint: "删掉后想再用就要重新下载（Medium 约 1.5 GB）。whisper.cpp 二进制<strong>不动</strong>。",
    }).then(function (r) {
      if (!r.ok) { setStatus("已取消"); return null; }
      log("");
      log("=== 清理本地模型 ===");
      return AeClean.recycle(items, { permanentFallback: r.perm }).then(function (rr) {
        var msg = "已删除 " + rr.recycled + " 个 · 释放 " + fmtBytes(rr.freedBytes);
        if (rr.permanent) msg += "（其中 " + rr.permanent + " 个已彻底删除）";
        if (rr.skipped) msg += " · 跳过 " + rr.skipped + " 个";
        log("  " + msg, rr.skipped ? "warn" : "ok");
        setStatus("本地模型已清理", "ok");
      });
    }).catch(function (err) {
      log("× 清理本地模型失败：" + (err && err.message ? err.message : err), "err");
      setStatus("清理失败", "err");
    }).then(function () {
      state.busyClean = false;
      el.btnCleanLocal.disabled = false;
      state.asrLocalStatus = null;
      refreshLocalStatus();
    });
  }

  /** 「打开模型目录」：自动清理还没接，至少让用户能看到文件该放哪儿 */
  function openLocalModelDir() {
    var st = state.asrLocalStatus;
    var dir = (st && st.modelDir) || "";
    if (!dir) { setStatus("还没拿到模型目录，先点「重新检测环境」", "warn"); return; }
    try {
      if (node && node.fs && !node.fs.existsSync(dir)) node.fs.mkdirSync(dir, { recursive: true });
      if (node && node.child_process) {
        node.child_process.spawn("explorer.exe", [dir.replace(/\//g, "\\")], { detached: true });
      }
      log("已打开模型目录：" + dir);
      setStatus("已打开模型目录", "ok");
    } catch (e) {
      log("× 打不开模型目录：" + (e && e.message ? e.message : e), "err");
    }
  }

  /** 在系统默认浏览器里打开链接（CEP 里普通的 <a> 点了没反应） */  function openExternal(url) {
    if (!url) return;
    try {
      if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
        return;
      }
    } catch (e) { /* 落到下面用命令行打开 */ }
    try { node.child_process.exec('start "" "' + url + '"'); } catch (e) { log("× 打不开链接：" + url, "err"); }
  }

  /** 爱发电主页（支持作者页里的链接，也是本页拿不到时的兜底） */
  var AFD_URL = "https://afdian.com/a/Noniika007";

  /**
   * 支持作者：打开**插件目录里**的 support.html（赞赏码 + 爱发电链接）。
   *
   * ⚠ 这里有一条踩过的坑，别改回去：
   *   CEP 的 `window.cep.util.openURLInDefaultBrowser` 对 **file:// 是静默失败** ——
   *   调用不抛错、日志照打、浏览器毫无动静（实测：日志留下"已在浏览器打开"，
   *   用户点了三次什么都没有）。所以**本地页面一律走系统命令行**：
   *   `explorer.exe <路径>` 交给 .html 的默认程序关联，且参数经 Unicode API 传递，
   *   换了中文用户名的机器也不会乱码。这与面板「打开产物文件」是同一条路。
   *
   * 拿不到插件目录、或页面不在（在浏览器里预览面板时就是这种）→ 直接开爱发电，
   * 保证"点了总有东西打开"，不留死按钮。
   */
  function openSupportPage() {
    var base = "";
    try {
      if (window.CepBridge && CepBridge.extensionPath) base = CepBridge.extensionPath() || "";
    } catch (e) { base = ""; }
    var pagePath = base ? (String(base).replace(/\\/g, "/") + "/support.html") : "";

    var hasPage = false;
    try { hasPage = !!(pagePath && node && node.fs && node.fs.existsSync(pagePath)); } catch (e2) { hasPage = false; }
    if (!hasPage) {
      log("支持页不在插件目录（" + (pagePath || "没拿到扩展目录") + "），改为打开爱发电主页", "warn");
      openExternal(AFD_URL);
      setStatus("已打开爱发电主页（插件目录里没有 support.html）", "ok");
      return;
    }

    var nativePath = pagePath.replace(/\//g, "\\");
    var opened = false;
    try {
      if (node && node.child_process) {
        node.child_process.execFile("explorer.exe", [nativePath]);
        opened = true;
      }
    } catch (e3) { opened = false; }
    if (!opened) {
      try {
        if (node && node.child_process) {
          node.child_process.exec('start "" "' + nativePath + '"');
          opened = true;
        }
      } catch (e4) { opened = false; }
    }
    if (!opened) openExternal("file:///" + pagePath.replace(/^\/+/, ""));   // 最后一道兜底
    log("已用默认程序打开支持页：" + pagePath);
    setStatus("已打开「支持作者」页 —— 若浏览器挡在 AE 后面，看下任务栏", "ok");
  }

  /**
   * 测试密钥：只验证"密钥 + 地址"是否配对，**不消耗识别额度**、不需要选素材。
   * 这比"跑一遍才发现密钥错"友好得多，也是腾讯云那套手写签名唯一能让用户自证的办法。
   */
  function testAsrKey() {
    var p = currentAsrProfile();
    if (!p) { log("× 引擎清单还没加载好", "err"); return; }
    if (!state.env || !state.env.node) { log("× 外部 Node 不可用，无法测试", "err"); return; }

    var pipe = el.pipelineDir.value.trim();
    var args = [joinPath(pipe, "cli.js"),
      "--asr-ping", "--asr-provider", p.provider, "--asr-profile", p.profile];
    if (el.asrBaseUrl.value.trim()) args.push("--asr-base-url", el.asrBaseUrl.value.trim());

    var asrEnv = {};
    if (el.asrApiKey.value.trim()) asrEnv.AESUB_API_KEY = el.asrApiKey.value.trim();
    if (el.asrSecretId.value.trim()) asrEnv.AESUB_SECRET_ID = el.asrSecretId.value.trim();
    if (el.asrSecretKey.value.trim()) asrEnv.AESUB_SECRET_KEY = el.asrSecretKey.value.trim();

    el.btnAsrTest.disabled = true;
    log("测试密钥中：" + p.label + " …");
    runPipeline(state.env.node.path, args, function () { /* ping 没有进度事件 */ }, asrEnv)
      .then(function (r) {
        var what = (r && r.profileLabel ? r.profileLabel : p.label) +
          " · 模型 " + ((r && r.model) || el.asrModel.value.trim() || "档位默认") +
          (r && r.modelIsDefault ? "（档位默认）" : "");
        if (r && r.ok) log("√ 密钥可用（" + what + "）：" + (r.detail || ""), "ok");
        else log("× 密钥不可用（" + what + "）：" + ((r && r.detail) || "未知原因"), "err");

        // 顺手把服务商**此刻真正可用**的模型灌进下拉框
        if (r && r.ok && r.models && r.models.length) {
          state.asrModelList = r.models;            // 缓存起来，刷新界面时不会被内置清单顶掉
          fillModelPick(r.models, "（服务商实时清单 · " + r.models.length + " 个）");
          log("可用模型 " + r.models.length + " 个 —— " + (r.modelsDetail || "") +
            "。已填进「挑一个」，选一个即可换模型。", "ok");
        } else if (r && r.ok) {
          state.asrModelList = null;
          fillModelPick([], "（此次没取到模型清单，可沿用档位内置清单）");
          log("未能取得模型清单：" + ((r && r.modelsDetail) || "服务商未返回"), "warn");
        }
      })
      .catch(function (e) {
        log("× 测试失败：" + (e.message || e), "err");
      })
      .then(function () { el.btnAsrTest.disabled = false; });
  }

  function collectParams() {
    var maxChars = parseInt(el.maxChars.value, 10);
    if (!(maxChars >= 4 && maxChars <= 60)) return { error: "每行字数需在 4~60 之间" };

    var fontSize = parseInt(el.fontSize.value, 10);
    if (!(fontSize >= 8 && fontSize <= 400)) return { error: "字号需在 8~400 之间" };

    var hex = String(el.color.value || "#ffffff").replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { error: "颜色格式不对" };
    var color = [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255
    ];

    // 先把 Node 可用性判掉，后面用到 node.os.tmpdir() 才安全
    if (!state.env || !state.env.node) return { error: "外部 Node 不可用，请点「重新检测环境」" };
    if (!node) return { error: "面板内 Node 未启用，请检查 manifest 里的 --enable-nodejs" };

    // 输出目录：用户填了就用，否则跟随工程目录，工程没保存就用临时目录
    var outDir = el.outDir.value.trim();
    if (!outDir) {
      var base = state.project && state.project.saved && state.project.dir
        ? state.project.dir
        : joinPath(node.os.tmpdir());
      outDir = joinPath(base, "_AE字幕输出");
    }

    // 识别引擎：先拦住"必然失败"的配置，别等导完音频、跑到一半才报错
    var asrSel = currentAsrProfile();
    if (!asrSel) return { error: "识别引擎清单还没加载好，请稍等一下，或点「重新检测环境」" };
    if (asrSel.needsBaseUrl && !el.asrBaseUrl.value.trim()) {
      return { error: "「" + asrSel.label + "」必须填「服务地址」（在高级里），例如 https://你的主机/v1" };
    }
    var envKey = "";
    try {
      envKey = (typeof process !== "undefined" && process.env && process.env.AESUB_API_KEY) || "";
    } catch (e) { /* 取不到就当没有 */ }
    if (asrSel.keyMode === "pair") {
      if (!el.asrSecretId.value.trim() || !el.asrSecretKey.value.trim()) {
        return { error: "「" + asrSel.label + "」用的是 SecretId + SecretKey 两个密钥，请在「识别选项」里补齐" };
      }
    } else if (asrSel.needsKey && !el.asrApiKey.value.trim() && !envKey) {
      return {
        error: "「" + asrSel.label + "」需要 API Key：请在「识别选项」里填写，" +
          "或改用环境变量 AESUB_API_KEY（重启 AE 后生效）"
      };
    }

    return {
      subPrefix: (el.subPrefix && el.subPrefix.value.trim()) || "字幕",
      nameMode: el.nameMode.value === "seq" ? "seq" : "text",
      snapSpeech: !!(el.snapSpeech && el.snapSpeech.checked),
      stripPunct: !!(el.stripPunct && el.stripPunct.checked),
      // 识别引擎
      asrProvider: asrSel.provider,
      asrProfile: asrSel.profile,
      asrLabel: asrSel.label,
      asrApiKey: el.asrApiKey.value.trim(),
      asrSecretId: el.asrSecretId.value.trim(),
      asrSecretKey: el.asrSecretKey.value.trim(),
      // 本地档位的"模型"是那三个档位（small / medium / …），不是云端那行手填框
    asrModel: asrSel.provider === "local"
      ? String(el.localModel ? el.localModel.value : "").trim()
      : el.asrModel.value.trim(),
      asrBaseUrl: el.asrBaseUrl.value.trim(),
      asrPrompt: el.asrPrompt.value.trim(),
      asrChunk: el.asrChunk.checked,
      skipPresetShort: !!(el.skipPresetShort && el.skipPresetShort.checked),
      nodePath: state.env.node.path,
      pipelineDir: el.pipelineDir.value.trim(),
      outDir: outDir,
      limitSec: currentLimitSec(),
      maxChars: maxChars,
      dropSuspect: el.dropSuspect.checked,
      keepAudio: el.keepAudio.checked,
      createLayers: el.createLayers.checked,
      mode: el.mode.value,
      fontSize: fontSize,
      color: color,
      yPercent: SUBTITLE_Y_PERCENT,
      fontPostScriptName: state.fontPs || "",
      presetPath: state.presetPath || "",
      separate: el.uvrOn.checked,
      separateTarget: el.uvrTarget.value,
      separateTargetLabel: el.uvrTarget.options[el.uvrTarget.selectedIndex]
        ? String(el.uvrTarget.options[el.uvrTarget.selectedIndex].textContent).split("（")[0] : "",
      separateModel: el.uvrModel.value,
      separateFormat: el.uvrFormat.value,
      separateKeep: el.uvrKeep.checked,
      separatePython: (state.uvr && state.uvr.python) || el.uvrPython.value.trim(),
      offsetSec: 0
    };
  }

  function openOutDir() {
    var dir = state.lastOutDir;
    if (!dir) {
      var outDirEl = el.outDir.value.trim();
      dir = outDirEl || (state.project && state.project.dir
        ? joinPath(state.project.dir, "_AE字幕输出")
        : null);
    }
    if (!dir) { setStatus("还没有确定输出目录", "err"); return; }
    try {
      node.child_process.spawn("explorer.exe", [dir.replace(/\//g, "\\")], { detached: true });
      setStatus("已打开：" + dir);
    } catch (e) {
      setStatus("打开目录失败：" + e.message, "err");
    }
  }

  /* ---------------------------------------------------------- 总开关与"复用已有字幕" */

  /**
   * 总开关联动。关掉时必须显眼，否则会出现"面板说完成了，时间线上却什么都没有"。
   * 顺手把主按钮文案也改掉 —— 让后果出现在你点下去的那一刻，而不是跑完之后。
   */
  function syncNoLayerWarn() {
    var off = !el.createLayers.checked;
    el.noLayerWarn.style.display = off ? "block" : "none";
    // v0.9.1 修复：主按钮是两行式（b + span），直接改 textContent 会把结构打平
    var runB = el.btnRun.querySelector("b"), runS = el.btnRun.querySelector("span");
    if (runB) runB.textContent = "▶　生成字幕";
    if (runS) runS.textContent = off ? "识别后停下来，先校对再落轨" : "分离 + 识别 + 自动落轨";
  }

  /** 输出目录：优先本会话真正用过的那个，保证"用已有字幕建图层"能找到上次的产物 */
  function resolveOutDir() {
    if (state.lastOutDir) return state.lastOutDir;
    var typed = el.outDir.value.trim();
    if (typed) return typed;
    if (!node) return null;
    var base = (state.project && state.project.saved && state.project.dir)
      ? state.project.dir
      : joinPath(node.os.tmpdir());
    return joinPath(base, "_AE字幕输出");
  }

  /**
   * 两张 PNG 是否逐字节相同（渲染验证用）。
   * 取不到 crypto / 文件读不了时返回 same:null，由调用方按"没做成"处理，不当成结论。
   */
  function sameFileBytes(a, b) {
    try {
      var ba = node.fs.readFileSync(a);
      var bb = node.fs.readFileSync(b);
      var ha = node.crypto.createHash("md5").update(ba).digest("hex");
      var hb = node.crypto.createHash("md5").update(bb).digest("hex");
      return { same: ha === hb, sizeA: ba.length, sizeB: bb.length, hashA: ha.slice(0, 8), hashB: hb.slice(0, 8) };
    } catch (e) {
      return { same: null, err: e.message };
    }
  }

  function cleanupProbeFiles(d) {
    try { if (d && d.pngOn) node.fs.unlinkSync(d.pngOn); } catch (e1) { }
    try { if (d && d.pngOff) node.fs.unlinkSync(d.pngOff); } catch (e2) { }
  }

  /**
   * 修复「预设动画关键帧错位」。
   *
   * 症状：套了动画预设（打字机一类）之后字幕整句看不见 —— 图层不透明度 100%、文字内容也在，
   *      时间线上能看到预设的「范围选择器」关键帧落在句子时间之外。
   * 做法：把这些图层的关键帧**整体平移**回它自己的入点（只动明显错位的层，进撤销组）。
   */
  function fixPresetKeys() {
    if (!CepBridge.available()) { setStatus("面板还没连上 AE，请重开面板", "err"); return; }
    var sel = state.sel;
    var compName = (sel && sel.ready) ? sel.compName : "";
    if (!compName) { setStatus("先在时间线上选中要处理的合成", "err"); return; }

    setStatus("正在修复动画关键帧…");
    el.logBox.open = true;
    log("");
    log("=== 修复动画关键帧错位 · 合成「" + compName + "」===");
    log("把「动画关键帧落在句子时间之外」的图层整体搬回来（只动明显错位的层）。");

    return AeApi.fixPresetKeyTimes(compName).then(function (res) {
      if (!res.ok) throw new Error(res.error);
      var d = res.data || {};
      log("扫描文本图层 " + d.scanned + " 个：修复 " + d.fixed + " 个、跳过 " + d.skipped +
        " 个（跳过的说明关键帧本来就在正确位置，或该层没有关键帧）", d.fixed ? "ok" : "warn");
      (d.samples || []).forEach(function (sm) {
        log("  · 「" + sm.name + "」动画从第 " + fmtSec(sm.from) + " 秒 → 搬到第 " + fmtSec(sm.to) + " 秒");
      });
      log("共移动 " + d.movedKeys + " 个关键帧。不满意就按 Ctrl+Z，整步一起撤回。", "warn");
      if (d.fixed) log("接着可以再点一次「检查字幕是否可见」确认。");
      setStatus(d.fixed ? ("已修复 " + d.fixed + " 个图层") : "没有需要修复的图层", "ok");
    }).catch(function (err) {
      log("× " + err.message, "err");
      setStatus("修复失败：" + err.message, "err");
    });
  }

  /* ------------------------------------------------------------ 清理（内存 / 文件 / 模型） */

  /** 把字节数写成好读的形式 */
  function fmtBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  }

  /** 清理要用到的各条路径（输出目录 / 项目根 / 模型 / 临时目录） */
  function cleanPaths() {
    var pipeline = el.pipelineDir.value.trim();
    var root = "";
    // 项目根 = 流水线目录的上一级。**一定要规范化**：直接拼 ".." 会得到
    // "C:/proj/pipeline/.." 这种带 .. 的路径 —— 能用但不干净，也容易在比较时踩坑。
    try {
      if (pipeline && node && node.path) {
        root = String(node.path.resolve(pipeline, "..")).replace(/\\/g, "/");
      }
    } catch (e) { root = ""; }
    return {
      outDir: el.outDir.value.trim().replace(/\\/g, "/"),
      projectRoot: root,
      modelsDir: uvrModelsDir(),
      tempDir: (node && node.os) ? String(node.os.tmpdir()).replace(/\\/g, "/") : ""
    };
  }

  /**
   * 通用二级确认弹层：把「将要发生什么」摆出来让用户过目。
   *
   * @param {Object} o { title, bodyHtml, hint, okText, showPerm, permDefault, onChange }
   * @returns {Promise<{ok:Boolean, picked:Array, perm:Boolean}>}
   */
  function confirmDialog(o) {
    var opt = o || {};
    return new Promise(function (resolve) {
      el.cfmTitle.textContent = opt.title || "确认";
      el.cfmBody.innerHTML = opt.bodyHtml || "";
      el.cfmHint.innerHTML = opt.hint || "";
      el.cfmOk.textContent = opt.okText || "确认";
      el.cfmCancel.textContent = opt.cancelText || "取消";
      el.cfmPermWrap.style.display = opt.showPerm ? "" : "none";
      el.cfmPerm.checked = !!opt.permDefault;
      el.cfmOverlay.style.display = "flex";

      function collect() {
        var picked = [];
        var boxes = el.cfmBody.querySelectorAll("input[type=checkbox][data-key]");
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].checked) picked.push(boxes[i].getAttribute("data-key"));
        }
        return picked;
      }
      function onBodyChange() {
        if (typeof opt.onChange === "function") opt.onChange(collect());
      }
      function off() {
        el.cfmOk.removeEventListener("click", onOk);
        el.cfmCancel.removeEventListener("click", onCancel);
        el.cfmBody.removeEventListener("change", onBodyChange);
      }
      function onOk() {
        var picked = collect(), perm = !!el.cfmPerm.checked;
        off();
        el.cfmOverlay.style.display = "none";
        resolve({ ok: true, picked: picked, perm: perm });
      }
      function onCancel() {
        off();
        el.cfmOverlay.style.display = "none";
        resolve({ ok: false, picked: [], perm: false });
      }
      el.cfmOk.addEventListener("click", onOk);
      el.cfmCancel.addEventListener("click", onCancel);
      el.cfmBody.addEventListener("change", onBodyChange);
      if (typeof opt.onChange === "function") opt.onChange(collect());
    });
  }

  /** 清理内存：把各程序占着不用的内存还给系统。不结束进程，也跳过 AE 本身。 */
  function doFreeMemory() {
    if (state.busyClean || state.running) return;
    if (!AeClean.available()) { setStatus("面板里的 Node 未启用，无法清理内存", "err"); return; }

    state.busyClean = true;
    el.btnFreeMem.disabled = true;
    setStatus("正在清理内存…");
    el.maintOut.innerHTML = '<span class="cleanSub">正在把各程序占着不用的内存还给系统…</span>';

    return AeClean.freeMemory().then(function (r) {
      var freed = Number(r.freedBytes) || 0;
      var msg = "已释放 " + fmtBytes(freed > 0 ? freed : 0) +
        " · 当前可用 " + fmtBytes(r.afterBytes) + " / 共 " + fmtBytes(r.totalBytes) +
        "（处理 " + r.trimmed + " 个进程）";
      el.maintOut.innerHTML = '<span class="okText">已释放 ' +
        fmtBytes(freed > 0 ? freed : 0) + " · 当前可用 " + fmtBytes(r.afterBytes) +
        " / 共 " + fmtBytes(r.totalBytes) + "</span>";

      log("");
      log("=== 清理内存 ===");
      log("  可用内存：" + fmtBytes(r.beforeBytes) + " → " + fmtBytes(r.afterBytes) +
        "（释放 " + fmtBytes(freed) + "）");
      log("  处理了 " + r.trimmed + " 个进程" + (r.failed ? ("，跳过 " + r.failed + " 个") : "") +
        "；没有结束任何进程，也跳过了 AE 本身。", "ok");
      if (freed <= 0) {
        log("  可用内存没有明显变化 —— 别的程序在同时占用，属正常现象。", "warn");
      }
      setStatus("内存已清理", "ok");
      return msg;
    }).catch(function (err) {
      el.maintOut.innerHTML = '<span class="errText">清理内存失败：' + err.message + "</span>";
      log("× 清理内存失败：" + err.message, "err");
      setStatus("清理内存失败", "err");
    }).then(function () {
      state.busyClean = false;
      el.btnFreeMem.disabled = false;
    });
  }

  /** 扫描 + 二级确认 + 清理插件产生的文件（不含模型） */
  function doCleanFiles() {
    if (state.busyClean || state.running) return;
    if (!AeClean.available()) { setStatus("面板里的 Node 未启用，无法清理", "err"); return; }

    state.busyClean = true;
    el.btnCleanFiles.disabled = true;
    setStatus("正在扫描插件产生的文件…");
    el.maintOut.innerHTML = '<span class="cleanSub">正在扫描…</span>';

    var paths = cleanPaths();
    var groups = null;

    function updateTotal(picked) {
      if (!groups) return;
      var bytes = 0, count = 0;
      groups.forEach(function (g) {
        if (picked.indexOf(g.key) < 0) return;
        bytes += g.bytes; count += g.count;
      });
      var pickedKeys = picked || [];
      // 逐行高亮：勾上的那条给个左侧亮条（点一下就有反馈）
      var rows = el.cfmBody.querySelectorAll("label.cleanGroup");
      for (var ri = 0; ri < rows.length; ri++) {
        var cb = rows[ri].querySelector("input[type=checkbox][data-key]");
        var on = cb ? pickedKeys.indexOf(cb.getAttribute("data-key")) >= 0 : false;
        rows[ri].className = "cleanGroup" + (rows[ri].classList.contains("locked") ? " locked" : "") + (on ? " on" : "");
      }
      // 顶部概览（不用滚到底才知道要删多少）
      if (el.cfmCount) el.cfmCount.textContent = String(count);
      if (el.cfmSize) el.cfmSize.textContent = fmtBytes(bytes);
      // 确认按钮直接写明将清理什么；一个都没勾就禁用，免得点了以为坏了
      if (el.cfmOk) {
        el.cfmOk.disabled = !count;
        el.cfmOk.textContent = count
          ? ("确认清理 · " + count + " 项 · " + fmtBytes(bytes))
          : "确认清理";
      }
      if (el.cfmHint) {
        el.cfmHint.textContent = count
          ? "删除的文件会进回收站，随时可以还原。"
          : "没有勾选任何项 —— 现在点确认什么也不会删。";
      }
    }

    return AeClean.scan(paths).then(function (res) {
      groups = res.groups || [];
      if (!groups.length) {
        el.maintOut.innerHTML = '<span class="cleanSub">没找到插件产生的文件（已经很干净）</span>';
        log("清理：没有找到插件产生的文件。", "ok");
        setStatus("没有可清理的文件", "ok");
        return null;
      }

      // 引导语与合计都在弹窗固定结构里（见 index.html 的 .cfmHead / .cfmTools），
      // 这里只生成清单本身 —— 两处都写会重复（旧版就是这么冒出两套清单的）
      var rows = [];
      groups.forEach(function (g) {
        var locked = !!g.locked;
        rows.push(
          '<label class="cleanGroup' + (locked ? " locked" : "") + '">' +
          (locked
            ? '<span style="width:13px;flex:0 0 13px"></span>'
            : '<input type="checkbox" data-key="' + g.key + '"' + (g.defaultOn ? " checked" : "") + '>') +
          '<span class="cgBody">' +
          '<span class="cgTop"><span class="cgName">' + g.label + "</span>" +
          '<span class="cgSize">' + g.count + " 个 · " + fmtBytes(g.bytes) + "</span></span>" +
          '<span class="cgNote">' + g.note + "</span>" +
          "</span></label>"
        );
      });

      return confirmDialog({
        title: "清理插件产生的文件",
        bodyHtml: rows.join(""),
        showPerm: true,
        permDefault: true,
        okText: "确认清理",
        hint: "放不进回收站的项（例如超过回收站容量）会跳过；勾了上面的选项才会改为彻底删除。",
        onChange: updateTotal
      }).then(function (r) {
        if (!r.ok) { setStatus("已取消"); return null; }

        var items = [];
        groups.forEach(function (g) {
          if (r.picked.indexOf(g.key) < 0) return;
          (g.items || []).forEach(function (it) { items.push(it); });
        });
        if (!items.length) {
          log("清理：你没有勾选任何内容，什么都没删。", "warn");
          setStatus("已取消", "ok");
          return null;
        }

        var totalBytes = 0;
        items.forEach(function (it) { totalBytes += Number(it.size) || 0; });

        setStatus("正在删除 " + items.length + " 项…");
        log("");
        log("=== 清理插件产生的文件 ===");
        log("  共 " + items.length + " 项 · 合计 " + fmtBytes(totalBytes));
        if (!paths.outDir) {
          log("  提示：面板里没填「输出目录」，所以只清了系统临时文件；" +
            "填上输出目录后能一并清掉中间音频与人声分离产物。", "warn");
        }

        return AeClean.recycle(items, { permanentFallback: r.perm }).then(function (rr) {
          var msg = "已删除 " + rr.recycled + " 项 · 释放 " + fmtBytes(rr.freedBytes);
          if (rr.permanent) msg += "（其中 " + rr.permanent + " 项放不进回收站、已彻底删除）";
          if (rr.skipped) msg += " · 跳过 " + rr.skipped + " 项";
          el.maintOut.innerHTML = '<span class="okText">' + msg + "</span>";
          log("  " + msg, rr.skipped ? "warn" : "ok");
          (rr.sample || []).slice(0, 4).forEach(function (p) {
            log("    跳过（正在使用或放不进回收站）：" + p, "warn");
          });
          setStatus("清理完成", "ok");
        });
      });
    }).catch(function (err) {
      el.maintOut.innerHTML = '<span class="errText">清理失败：' + err.message + "</span>";
      log("× 清理失败：" + err.message, "err");
      setStatus("清理失败", "err");
    }).then(function () {
      state.busyClean = false;
      el.btnCleanFiles.disabled = false;
    });
  }

  /** 清理模型：把已下载的模型文件删到回收站（列表元数据保留） */
  function doCleanModels() {
    if (state.busyClean || state.running) return;
    if (!AeClean.available()) { setStatus("面板里的 Node 未启用，无法清理", "err"); return; }

    var paths = cleanPaths();
    if (!paths.modelsDir) { setStatus("读不到模型目录（先检查「输出与日志」里的流水线目录）", "err"); return; }

    state.busyClean = true;
    el.btnCleanModels.disabled = true;
    setStatus("正在扫描模型…");

    return AeClean.scanModels(paths.modelsDir).then(function (res) {
      if (!res.count) {
        log("清理模型：模型目录里没有已下载的模型。", "ok");
        setStatus("没有已下载的模型", "ok");
        return null;
      }

      var rows = [];
      rows.push('<div class="cleanSub" style="margin-bottom:6px">以下模型文件将被删到<b>回收站</b>：</div>');
      (res.items || []).slice(0, 12).forEach(function (it) {
        rows.push('<div class="cleanGroup"><span class="cgBody">' +
          '<span class="cgName">' + (it.name || it.path) + "</span>" +
          '<span class="cgSize">' + fmtBytes(it.size) + "</span></span></div>");
      });
      if (res.items.length > 12) {
        rows.push('<div class="cleanGroup"><span class="cgBody"><span class="cgNote">…另有 ' +
          (res.items.length - 12) + " 个</span></span></div>");
      }
      rows.push('<div class="cleanTotal">合计 <b>' + res.count + "</b> 个模型 · <b>" +
        fmtBytes(res.bytes) + "</b></div>");

      return confirmDialog({
        title: "清理模型",
        bodyHtml: rows.join(""),
        showPerm: true,
        permDefault: true,
        okText: "确认清理",
        hint: "模型的<strong>列表元数据</strong>会保留，所以界面上仍能看到模型清单；" +
          "下次用到某个模型时会自动重新下载（60 MB ~ 900 MB/个，需要联网）。"
      }).then(function (r) {
        if (!r.ok) { setStatus("已取消"); return null; }
        setStatus("正在删除模型…");
        log("");
        log("=== 清理模型 ===");
        log("  共 " + res.count + " 个模型 · " + fmtBytes(res.bytes));

        return AeClean.recycle(res.items, { permanentFallback: r.perm }).then(function (rr) {
          var msg = "已删除 " + rr.recycled + " 个模型 · 释放 " + fmtBytes(rr.freedBytes);
          if (rr.permanent) msg += "（其中 " + rr.permanent + " 个已彻底删除）";
          if (rr.skipped) msg += " · 跳过 " + rr.skipped + " 个（可能正在被使用）";
          log("  " + msg, rr.skipped ? "warn" : "ok");
          log("  下次使用时会自动重新下载。", "warn");
          setStatus("模型已清理", "ok");
        });
      });
    }).catch(function (err) {
      log("× 清理模型失败：" + err.message, "err");
      setStatus("清理模型失败", "err");
    }).then(function () {
      state.busyClean = false;
      el.btnCleanModels.disabled = false;
    });
  }

  /**
   * 字幕体检：查"建了图层但画面是空的"到底卡在哪一环。
   *
   * 两步：
   *   ① 属性体检（只读）—— 遮挡 / 落在画面外 / 无填充 / 空文本 / 关闭 / 透明 / 零时长
   *   ② 渲染验证 —— 在同一时刻真渲染两帧（该层开 / 该层关）再逐字节比对：
   *      两帧相同 ⇒ 这层对画面零贡献（属性都对，就是没画东西）
   *      两帧不同 ⇒ 它确实画到了画面上
   *      为了做这个对比会**瞬间关一下该层再恢复**（日志里会明说）。
   */
  function checkSubLayers() {
    if (!CepBridge.available()) { setStatus("面板还没连上 AE，请重开面板", "err"); return; }
    var sel = state.sel;
    var compName = (sel && sel.ready) ? sel.compName : "";
    if (!compName) { setStatus("先在时间线上选中要检查的合成", "err"); return; }

    setStatus("正在检查字幕可见性…");
    el.logBox.open = true;
    log("");
    log("=== 字幕体检 · 合成「" + compName + "」===");
    el.subCheckOut.innerHTML = "";

    // 结论行自己攒：全局那个 row() 是别的函数的局部函数，这里用了会报 "row is not defined"
    var out = [];
    function addRow(cls, text) {
      out.push('<div class="stateRow"><span class="dot ' + cls + '"></span><span>' +
        text + "</span></div>");
    }

    return AeApi.checkSubtitleLayers(compName).then(function (res) {
      if (!res.ok) throw new Error(res.error);
      var d = res.data || {};
      var problems = 0;

      log("文本图层 " + d.textLayers + " 个（合成共 " + d.totalLayers + " 层 · " +
        d.compWidth + "×" + d.compHeight + "）");
      if (!d.textLayers) {
        addRow("warn", "这个合成里没有文本图层 —— 字幕可能建到了别的合成");
      }

      // —— 全局可见性开关：最"诡异"的一类（每个字幕层属性都完美，画面就是空的）——
      if (d.soloLayers) {
        problems++;
        var sn = (d.soloNames || []).map(function (o) {
          return "「" + o.name + "」(第 " + o.index + " 层)";
        }).join("、");
        addRow("bad", "有 " + d.soloLayers + " 个图层开了「独奏」—— 其余图层（含全部字幕）都会被隐藏");
        log("× 合成里有图层开了独奏：" + sn, "err");
        log("  开了独奏之后**只有这些层会被渲染**，其他所有图层都被隐藏 —— " +
          "字幕属性再正常也看不见。到时间线左侧把它的独奏按钮（实心圆）点掉即可。", "err");
      }
      if (d.shyCount) {
        addRow("warn", d.shyCount + " 个图层勾了「羞怯」；时间线上方的「隐藏羞怯图层」若开着，它们就不显示");
        log("⚠ " + d.shyCount + " 个图层勾了羞怯开关 —— 时间线顶部若开着「隐藏羞怯图层」，这些层会一起消失。", "warn");
      }
      if (d.guideCount) {
        addRow("warn", d.guideCount + " 个图层是「导引层」—— 导引层不参与渲染");
        log("⚠ " + d.guideCount + " 个图层是导引层，导引层不会出现在渲染结果里。", "warn");
      }

      if (d.occluded) {
        problems++;
        var names = (d.occluders || []).map(function (o) {
          return "「" + o.name + "」(第 " + o.index + " 层)";
        }).join("、");
        addRow("bad", d.occluded + " 层被上方图层盖住：" + names);
        log("× " + d.occluded + " 个字幕层被上方图层完全遮挡：" + names, "err");
        log("  把字幕图层拖到图层栈最上方即可 —— 字幕没坏，只是被压住了。", "warn");
      }
      if (d.offscreen) {
        problems++;
        addRow("bad", d.offscreen + " 层的文字落在画面外（位置 / 锚点异常）");
        log("× " + d.offscreen + " 层的文字落点跑到画框外面了（位置减锚点算出来的包围盒不与画面相交）。", "err");
      }
      if (d.noFill) {
        problems++;
        addRow("bad", d.noFill + " 层既没有填充也没有描边 —— AE 会渲染成空");
        log("× " + d.noFill + " 层没填充也没描边，AE 什么都不画（属性看着却全正常）。", "err");
      }
      if (d.emptyText) {
        problems++;
        addRow("warn", d.emptyText + " 层的文字内容是空白（识别噪声）");
        log("⚠ " + d.emptyText + " 层文本为空 —— 删掉即可，或重新识别一次。", "warn");
      }
      if (d.hidden) {
        problems++;
        addRow("warn", d.hidden + " 层被关闭了（眼睛图标）");
        log("⚠ " + d.hidden + " 层处于关闭状态。", "warn");
      }
      if (d.transparent) {
        problems++;
        addRow("warn", d.transparent + " 层不透明度为 0");
        log("⚠ " + d.transparent + " 层不透明度为 0，调到 100% 才看得见。", "warn");
      }
      if (d.zeroLength) {
        problems++;
        addRow("warn", d.zeroLength + " 层出入点零长（时间轴上只有一瞬）");
        log("⚠ " + d.zeroLength + " 层时长为 0 —— 时间戳异常，建议重新识别。", "warn");
      }

      var s0 = (d.samples || [])[0];
      if (s0) {
        var fillTxt = (s0.fillEnabled === false)
          ? "未填充"
          : ((s0.fill && s0.fill.length >= 3)
            ? ("rgb(" + Math.round(s0.fill[0] * 255) + "," + Math.round(s0.fill[1] * 255) +
               "," + Math.round(s0.fill[2] * 255) + ")" +
               (s0.fill.length >= 4 ? (" 透明度 " + s0.fill[3]) : ""))
            : "?");
        log("  抽样第 " + s0.index + " 层「" + s0.name + "」：文字=\"" + s0.text + "\"" +
          " · 不透明度 " + Math.round(s0.opacity) + "%" +
          " · " + fmtSec(s0.inPoint) + "~" + fmtSec(s0.outPoint) + " 秒");
        log("    位置 " + json2(s0.pos) + " · 锚点 " + json2(s0.anchor) +
          " · 文字块中心 " + (s0.centerX === null ? "?" :
            ("(" + Math.round(s0.centerX) + "," + Math.round(s0.centerY) + ")")) +
          (s0.offscreen ? " ← 落在画面外" : ""));
        if (s0.keySpan !== null && s0.keySpan !== undefined) {
          log("    动画关键帧跨度 " + fmtSec(s0.keySpan) + " 秒 / 本句时长 " +
            fmtSec(s0.layerDur) + " 秒" +
            (s0.keyFirst !== null ? ("（最早关键帧在第 " + fmtSec(s0.keyFirst) + " 秒）") : ""));
          if (s0.keyFirst !== null && s0.keyFirst !== undefined &&
              (s0.keyFirst > s0.outPoint + 0.05 || s0.keyFirst < s0.inPoint - 1.0)) {
            log("    ⚠ 动画关键帧不在本句时间范围内 —— 点「修复动画关键帧错位」可整体搬回来", "warn");
          }
        }
        log("    字体 " + (s0.font || "?") + " · 字号 " + s0.fontSize +
          " · 填充 " + fillTxt + (s0.occludedBy ? " · 被「" + s0.occludedBy + "」遮挡" : "") +
          (s0.solo ? " · ⚠ 该层开了独奏" : "") + (s0.shy ? " · ⚠ 该层勾了羞怯" : "") +
          (s0.guide ? " · ⚠ 该层是导引层" : ""));

        // —— "不透明度 100% 却看着像透明"的元凶，逐个点名 ——
        var causeFound = false;

        if (s0.fill && s0.fill.length >= 4 && s0.fill[3] <= 0.001) {
          problems++; causeFound = true;
          addRow("bad", "填充色的透明度是 0 —— 文字被渲染成全透明");
          log("× 填充带 alpha 且值为 0（rgba 第 4 位）—— 这就是「不透明度 100% 却看不见」的直接原因。", "err");
        }
        if (s0.fontAvailable === false) {
          problems++; causeFound = true;
          addRow("bad", "字体在 AE 里解析不到：" + s0.font);
          log("× 字体「" + s0.font + "」在 AE 字体列表里解析不到（可能已被卸载，或字体文件被移走）。" +
            "AE 找不到字形就画不出东西 —— 把面板里的字体改回「跟随 AE 默认」再建一次，文字若出现即是它。", "err");
        }
        if (s0.animOpacityLow) {
          problems++; causeFound = true;
          addRow("bad", "文字动画器把不透明度压到了 0");
          log("× 文字动画器里有 " + s0.animOpacityLow + " 个不透明度属性小于 0.5（等于把文字画成透明）。", "err");
          log("  动画器详情：" + JSON.stringify(s0.animatorDetail || []), "warn");
        } else if (s0.animators) {
          log("    文字动画器 " + s0.animators + " 个：" +
            JSON.stringify(s0.animatorDetail || []));
          if (s0.animOpacityVals && s0.animOpacityVals.length) {
            log("      动画器里的不透明度值：" + s0.animOpacityVals.join("、"), "warn");
          }
        }
        if (s0.effects) {
          log("    图层效果 " + s0.effects + " 个：" + (s0.effectNames || []).join("、"), "warn");
        }
        if (s0.opacityExpression) {
          problems++; causeFound = true;
          addRow("warn", "不透明度上挂着表达式，求值可能是 0");
          log("× 不透明度有表达式：" + s0.opacityExpression, "err");
        }
        if (s0.preserveTransparency === true) {
          log("    ⚠ 勾了「保留基础透明度」—— 下方图层透明处会把字幕一起吃掉。", "warn");
        }
        if (s0.trackMatte) {
          log("    ⚠ 该层带轨道遮罩：" + s0.trackMatte, "warn");
        }
        // BlendingMode 的数值：NORMAL = 5212（早先拿字符串比，导致每次都误报，已修）
        if (s0.blend !== null && s0.blend !== undefined && Number(s0.blend) !== 5212) {
          problems++; causeFound = true;
          addRow("warn", "图层混合模式不是「正常」（BlendingMode 值 " + s0.blend + "）");
          log("× 图层混合模式不是「正常」（值 " + s0.blend + "）—— 到图层列的「模式」栏看看，" +
            "像「模板 Alpha」「轮廓 Alpha」这类模式会把画面吃掉。", "err");
        }
        if (!causeFound && s0.fillEnabled !== false && !s0.offscreen && !s0.occludedBy) {
          log("    以上属性未发现异常 —— 继续看渲染验证的结果。");
        }
      }

      // —— 渲染验证（会瞬间开关一次抽样层）——
      if (!s0) { return null; }
      var probeDir = "";
      try { probeDir = resolveOutDir() || ""; } catch (eOD) { probeDir = ""; }
      log("渲染验证：在 " + fmtSec(s0.inPoint) + "~" + fmtSec(s0.outPoint) +
        " 秒之间真渲染两帧（该层开 / 该层关，随即恢复原状）…" +
        (probeDir ? "两帧会留档到输出目录，可直接打开看" : ""));
      return AeApi.probeSubtitleRender(compName, s0.name, probeDir).then(function (pr) {
        if (!pr.ok) { log("  ⚠ 渲染验证没做成：" + pr.error, "warn"); return; }
        var pd = pr.data || {};
        var cmp = sameFileBytes(pd.pngOn, pd.pngOff);
        if (pd.kept) {
          log("  两帧已留档（可直接双击打开）:", "ok");
          log("    有字幕：" + pd.pngOn);
          log("    关掉该层：" + pd.pngOff);
        } else {
          cleanupProbeFiles(pd);
        }
        if (cmp.same === null) {
          var miss = (pd.sizeOn < 0) ? "第一帧" : "第二帧";
          log("  ⚠ 渲染帧比对没做成：" + miss + "没落盘（" + cmp.err + "）。", "warn");
          log("    AE 偶尔只写出第一帧，这是已知小毛病 —— **再点一次体检**通常就正常。" +
            "上面属性层面的结论不受影响。", "warn");
          return;
        }
        log("  渲染时刻 " + fmtSec(pd.time) + " 秒 · 开=" + cmp.sizeA + " 字节 / 关=" +
          cmp.sizeB + " 字节 · " + cmp.hashA + " vs " + cmp.hashB +
          (pd.ms ? (" · 两帧共 " + (pd.ms / 1000).toFixed(1) + " 秒") : ""));
        if (cmp.same) {
          problems++;
          addRow("bad", "渲染验证：这一层对画面零贡献（属性都正常，却没画出任何像素）");
          log("× 两张渲染帧**完全相同** —— 这层根本没往画面画东西。", "err");
          log("  对照上面的抽样：若「填充 未填充」或字号为 0，就是它；" +
            "否则把这两行日志发我。", "warn");
        } else {
          addRow("ok", "渲染验证：这一层确实在画面上画了内容");
          log("√ 两张渲染帧不同 —— 字幕确实被渲染进了画面（开关它画面会变）。", "ok");
          log("  若画面看上去仍空：确认查看的就是这个合成、时间指针落在 " +
            fmtSec(s0.inPoint) + "~" + fmtSec(s0.outPoint) +
            " 秒之间，再按一下小键盘 0 或清一次缓存（AE 有时留着旧画面）。", "warn");
          if (pd.kept) {
            log("  最直接的办法：打开留档的「体检帧_有字幕.png」，看那上面到底有没有字幕。", "warn");
          }
        }
      });
    }).then(function () {
      if (!out.length) {
        addRow("ok", "属性全部正常，渲染验证也通过 —— 字幕应该能看见");
      }
      el.subCheckOut.innerHTML = out.join("");
      setStatus("体检完成", "ok");
    }).catch(function (err) {
      if (out.length) el.subCheckOut.innerHTML = out.join("");
      log("× " + err.message, "err");
      setStatus("体检失败：" + err.message, "err");
    });
  }

  function rebuildFromLastJson() {
    if (state.running) return;
    if (!CepBridge.available()) { setStatus("面板还没连上 AE，请重开面板", "err"); return; }

    var params = collectParams();
    if (params.error) { setStatus(params.error, "err"); return; }

    var sel = state.sel;
    if (!sel || !sel.ready) { setStatus("先在时间线上选中要建字幕的素材", "err"); return; }

    var outDir = resolveOutDir();
    if (!outDir) { setStatus("还确定不了输出目录", "err"); return; }
    // 产物命名分两代：v0.6.1 起按【源素材名】存（无上光荣.json，同名另存则是「无上光荣 2.json」），
    // 更早的版本按【合成名】存（合成 1.json）。两个都试，免得老用户点了报"找不到"。
    var stem = baseStemFromLayer(sel.sourceLayerName);
    var cands = [];
    if (stem) {
      var si = 1;
      while (si <= 20) {   // 上限防呆：最多找到「stem 20」那一代
        cands.push(joinPath(outDir, safeName(si === 1 ? stem : stem + " " + si) + ".json"));
        si++;
      }
    }
    cands.push(joinPath(outDir, safeName(sel.compName) + ".json"));

    var jsonPath = null;
    if (node) {
      for (var ci = 0; ci < cands.length; ci++) {
        if (node.fs.existsSync(cands[ci])) { jsonPath = cands[ci]; break; }
      }
    }
    if (!jsonPath) {
      setStatus("找不到字幕 JSON", "err");
      log("× 找不到字幕 JSON，素材名与合成名两种都试过了（共 " + cands.length + " 个候选）。", "err");
      log("  试过的头几个：" + cands.slice(0, 3).join("  |  "), "warn");
      log("  先点「开始生成字幕」跑一次识别，或把「输出目录」指到上次的产物目录。", "warn");
      return;
    }
    log("用已有字幕建图层：" + jsonPath);

    state.running = true;
    updateRunButton();
    el.logBox.open = true;
    log("");
    log("用已有字幕建图层（不重新识别、不上传）：" + jsonPath);
    setStatus("正在 AE 中创建字幕图层…");
    setProgress(90);

    return AeApi.createSubtitleLayers(sel.compName, jsonPath, {
      mode: params.mode,
      fontSize: params.fontSize,
      color: params.color,
      yPercent: params.yPercent,
      fontPostScriptName: params.fontPostScriptName,
      presetPath: params.presetPath,
      prefix: (el.subPrefix && el.subPrefix.value.trim()) || "字幕",
      nameMode: (el.nameMode && el.nameMode.value === "seq") ? "seq" : "text",
      skipPresetOnShort: !!(el.skipPresetShort && el.skipPresetShort.checked)
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error);
      log("已在合成「" + sel.compName + "」中创建 " + res.data.created + " 个字幕图层" +
        (res.data.skipped ? "（跳过 " + res.data.skipped + " 段）" : ""), "ok");
      if (res.data.presetApplied) log("  预设已应用：" + res.data.presetApplied, "ok");
      if (res.data.presetShiftNote) log("  " + res.data.presetShiftNote);
      if (res.data.presetNote) log("  ⚠ " + res.data.presetNote, "warn");
      if (res.data.fontApplied) log("  字体已生效：" + res.data.fontApplied, "ok");
      if (res.data.fontNote) log("  ⚠ " + res.data.fontNote, "warn");
      setProgress(100);
      setStatus("已创建 " + res.data.created + " 个字幕图层", "ok");
    }).catch(function (err) {
      log("× " + err.message, "err");
      setStatus("失败：" + err.message, "err");
      setProgress(0);
    }).then(function () {
      state.running = false;
      updateRunButton();
    });
  }

  /* ---------------------------------------------------------- 初始化 */

  function bindEvents() {
    var persistKeys = ["maxChars", "dropSuspect", "limitOn", "limitMin", "keepAudio",
      "mode", "fontSize", "color", "createLayers",
      "uvrOn", "uvrTarget", "uvrModel", "uvrFormat", "uvrKeep", "uvrPython", "uvrGpu",
      "subPrefix", "nameMode", "snapSpeech", "skipPresetShort", "dataDir", "stripPunct",
      // 识别引擎
      "asrProfile", "asrApiKey", "asrSecretId", "asrSecretKey",
      "asrModel", "asrBaseUrl", "asrPrompt", "asrChunk",
      // 本地引擎（whisper.cpp）
      "localModel", "localRuntime", "localGpu"];
    persistKeys.forEach(function (k) {
      el[k].addEventListener("change", function () {
        saveSettings();
        if (k === "createLayers") syncNoLayerWarn();
        if (k === "mode" || k === "fontSize") syncStyleUi();
        if (k === "uvrOn" || k === "uvrTarget") syncUvrUi();
        if (k === "asrProfile") {
          state.asrModelList = null;   // 模型清单是按服务商给的，换档位必须作废重拉
          state.asrLocalStatus = null; // 本地环境快照同理（换档位要重探）
          syncAsrUi();
        }
        // 本地档：换模型档位 / 开关显卡后，四格状态与提示要跟着重算
        if (k === "localModel" && state.asrLocalStatus) renderLocalStatus(state.asrLocalStatus);
        if (k === "localGpu") {
          if (state.asrLocalStatus) renderLocalStatus(state.asrLocalStatus);
          else refreshLocalStatus();
        }
        // 手改模型名时也要刷新"当前将使用"那行提示
        if (k === "asrModel") syncAsrUi();
        if (k === "limitOn" || k === "limitMin") {
          state.selSig = "";        // 强制重算区间（截断长度变了）
          refreshSelection();
        }
      });
    });

    // 去服务商控制台申请密钥（CEP 里普通链接点了没反应，得走系统浏览器）
    el.btnAsrConsole.addEventListener("click", function () {
      var p = currentAsrProfile();
      if (p && p.consoleUrl) openExternal(p.consoleUrl);
    });
    el.btnAsrTest.addEventListener("click", testAsrKey);
    // 本地档位：下载页 / 打开模型目录
    if (el.btnLocalModel) el.btnLocalModel.addEventListener("click", fetchLocal);
    if (el.btnLocalDir) el.btnLocalDir.addEventListener("click", openLocalModelDir);
    if (el.btnCleanLocal) el.btnCleanLocal.addEventListener("click", doCleanLocalModels);

    // 「挑一个」选中后写回输入框（输入框才是真正的参数来源，下拉只是方便挑）
    el.asrModelPick.addEventListener("change", function () {
      var v = el.asrModelPick.value;
      if (!v) return;
      el.asrModel.value = v;
      saveSettings();
      syncAsrUi();
      log("已选择模型：" + v + "（点是「测试密钥」可先验证该模型可用）");
    });

    el.btnRun.addEventListener("click", run);
    el.btnRebuild.addEventListener("click", rebuildFromLastJson);
    el.btnTest.addEventListener("click", testExport);
    el.btnRefresh.addEventListener("click", function () {
      state.selSig = "";
      refreshSelection();
    });
    el.btnOpenOut.addEventListener("click", openOutDir);

    // ---- 页面导航 ----
    el.btnGear.addEventListener("click", function () { showPage("set"); });
    // 支持作者：♥ → 系统浏览器打开插件目录里的 support.html
    if (el.btnSupport) el.btnSupport.addEventListener("click", openSupportPage);

    // 清理弹窗：全选 / 全不选（只作用于可勾选项，锁定项不参与）。
    // 改完派发一次 change，让 updateTotal 把概览与确认按钮文案一起刷新。
    function cfmToggleAll(on) {
      var boxes = el.cfmBody.querySelectorAll("input[type=checkbox][data-key]");
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = on;
      if (boxes.length) boxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (el.cfmAll) el.cfmAll.addEventListener("click", function () { cfmToggleAll(true); });
    if (el.cfmNone) el.cfmNone.addEventListener("click", function () { cfmToggleAll(false); });
    el.btnEngChange.addEventListener("click", function () { showPage("eng"); });
    // 密钥显示 / 隐藏：粘贴后核对再收起
    [["btnKeyEyeApi", "asrApiKey"], ["btnKeyEyeSecret", "asrSecretKey"]].forEach(function (pair) {
      var btn = el[pair[0]], inp = el[pair[1]];
      if (!btn || !inp) return;
      btn.addEventListener("click", function () {
        var show = inp.type === "password";
        inp.type = show ? "text" : "password";
        btn.textContent = show ? "隐藏" : "显示";
      });
    });
    // 产物 chips：点击直接打开对应文件（没有产物时明确说，不装死）
    [["chipSrt", "srt"], ["chipJson", "json"], ["chipTxt", "txt"]].forEach(function (pair) {
      var btn = el[pair[0]];
      if (!btn) return;
      btn.addEventListener("click", function () {
        var f = (state.lastFiles || {})[pair[1]];
        if (!f) { setStatus("本次运行没有生成 ." + pair[1] + " 产物", "warn"); return; }
        openFilePath(f);
      });
    });
    // 快捷入口按钮已删（v1.0.0）：顶部一级导航取代了它们，这里不再需要绑定
    // 一级导航
    Array.prototype.forEach.call(document.querySelectorAll("#lv1 button[data-page]"), function (b) {
      b.addEventListener("click", function () { showPage(b.getAttribute("data-page")); });
    });
    // 二级分段（每页各自一组）
    Array.prototype.forEach.call(document.querySelectorAll(".lv2 button[data-g]"), function (b) {
      b.addEventListener("click", function () {
        showGroup(state.page, b.getAttribute("data-g"));
      });
    });
    // 新页里的三个跳转按钮：复用原有逻辑，不复制实现
    if (el.btnLocalModelGo) el.btnLocalModelGo.addEventListener("click", function () {
      showPage("eng", "asr");
      if (el.btnLocalModel) el.btnLocalModel.scrollIntoView({ block: "center" });
    });
    if (el.btnLocalDirGo && el.btnLocalDir) el.btnLocalDirGo.addEventListener("click", function () {
      el.btnLocalDir.click();
    });
    if (el.btnResetGo && el.btnReset) el.btnResetGo.addEventListener("click", function () {
      el.btnReset.click();
    });
    // 校对：确认落轨 / 重新识别
    if (el.btnCommit) el.btnCommit.addEventListener("click", commitCheck);
    if (el.btnRedo) el.btnRedo.addEventListener("click", function () {
      showPage("work", "run");
      log("重新识别一遍 —— 回到执行页再跑一次。", "warn");
      if (el.btnRun) el.btnRun.click();
    });
    // 字幕位置九宫格：只切选中态与文字，落值逻辑随建层一起做
    if (el.posGrid) {
      var POS_NAME = { tl: "左上", tc: "上中", tr: "右上", ml: "左中", mc: "正中",
                       mr: "右中", bl: "左下", bc: "下居中", br: "右下" };
      el.posGrid.addEventListener("click", function (ev) {
        var bt = ev.target.closest ? ev.target.closest("button[data-pos]") : null;
        if (!bt) return;
        Array.prototype.forEach.call(el.posGrid.querySelectorAll("button"), function (x) {
          x.classList.remove("on");
        });
        bt.classList.add("on");
        if (el.posName) el.posName.textContent = POS_NAME[bt.getAttribute("data-pos")] || "";
      });
    }

    // ---- 人声分离依赖 ----
    el.btnUvrCheck.addEventListener("click", function () { saveSettings(); checkUvrDeps(false); });
    el.btnUvrInstall.addEventListener("click", function () { saveSettings(); installUvr(); });
    el.btnUvrModel.addEventListener("click", function () { saveSettings(); downloadUvrModel(); });
    el.uvrModel.addEventListener("change", function () { updateUvrButtons(); syncModelHint(); });

      // ---- 文字动画预设 ----
      el.presetSelect.addEventListener("change", onPresetPicked);
      el.presetSelect.addEventListener("change", syncFavPreset);    // 星标跟着选中项走
      el.btnFavPreset.addEventListener("click", function () {
        var v = el.presetSelect.value;
        if (!v) return;
        var label = selectedLabel(el.presetSelect) || v;
        var now = favToggle(LS.favPresets, v, label);
        log((now ? "★ 已收藏预设：" : "☆ 已取消收藏预设：") + label +
          (now ? "（下次在预设列表最上方的「收藏」组里直接选）" : ""));
        renderPresetOptions();                                        // 重画以体现收藏组的变化
        el.presetSelect.value = v;                                    // 重画后把选中项放回去
        if (!el.presetSelect.value) ensureCurrentPresetOption();
        syncFavPreset();
      });
      el.btnSeparate.addEventListener("click", runSeparateOnly);
    el.btnFreeMem.addEventListener("click", doFreeMemory);
    el.btnCleanFiles.addEventListener("click", doCleanFiles);
    el.btnCleanModels.addEventListener("click", doCleanModels);

    el.btnSubCheck.addEventListener("click", checkSubLayers);
    el.btnFixKeys.addEventListener("click", fixPresetKeys);

    el.btnPresetDir.addEventListener("click", openPresetDir);
    el.btnPresetFile.addEventListener("click", browsePresetFile);
    el.presetQuery.addEventListener("input", function () {
      state.presetQuery = el.presetQuery.value.trim();
      // 预设是纯前端过滤，不需要往返 AE；但首次搜索时列表可能还没读完
      if (!state.presets) { loadPresets(); return; }
      renderPresetOptions();
    });

      // ---- 字体 ----
      el.fontQuery.addEventListener("input", scheduleFontSearch);
      el.fontSelect.addEventListener("change", onFontPicked);
      el.fontSelect.addEventListener("change", syncFavFont);        // 星标跟着选中项走
      el.btnFavFont.addEventListener("click", function () {
        var v = el.fontSelect.value;
        if (!v) return;
        var label = selectedLabel(el.fontSelect) || v;
        var now = favToggle(LS.favFonts, v, label);
        log((now ? "★ 已收藏字体：" : "☆ 已取消收藏字体：") + label +
          (now ? "（下次在字体列表最上方的「收藏」组里直接选）" : ""));
        if (state.lastFontRes) renderFontOptions(state.lastFontRes);   // 重画以体现收藏组的变化
        el.fontSelect.value = v;                                      // 重画后把选中项放回去
        if (!el.fontSelect.value) ensureCurrentFontOption();           // 取消收藏后它可能不在当前搜索结果里
        syncFavFont();
      });
      el.btnPickFont.addEventListener("click", pickFontFromSelection);
    el.nameMode.addEventListener("change", function () {
      el.rowSubPrefix.style.display = el.nameMode.value === "seq" ? "" : "none";
    });
    el.rowSubPrefix.style.display = el.nameMode.value === "seq" ? "" : "none";

    el.btnFontRefresh.addEventListener("click", function () {
      setStatus("正在重新扫描字体列表…");
      log("重新扫描 AE 字体列表（忽略缓存）…");
      refreshFonts();
    });

    el.btnProbe.addEventListener("click", function () {
      saveSettings();
      clearLog();
      state.selSig = "";
      probeEnvironment();
      refreshSelection();
    });

    el.btnSelfTest.addEventListener("click", function () {
      saveSettings();
      clearLog();
      runSelfTest();
    });

    el.btnReset.addEventListener("click", function () {
      el.nodePath.value = "";
      el.pipelineDir.value = detectPipelineDir();
      el.outDir.value = "";
      el.fontQuery.value = "";
      el.presetQuery.value = "";
      state.presetQuery = "";
      el.uvrPython.value = "";
      setFontChoice("", "", "");     // 字体也回到"跟随 AE 默认"
      el.createLayers.checked = true; // 总开关一并归位
      el.uvrOn.checked = false;       // 人声分离回默认关
      state.presetPath = "";
      state.presetLabel = "";
      syncNoLayerWarn();
      syncUvrUi();
      syncStyleUi();
      saveSettings();
      clearLog();
      log("已恢复默认：路径清空、字体跟随 AE、字幕图层自动创建、人声分离关闭、预设取消");
      probeEnvironment();
      searchFonts("");
      loadPresets();
    });

    // 合成切换时刷新；CEP 提供 CSXS 事件，拿不到就退回轮询
    try {
      if (window.__adobe_cep__ && window.__adobe_cep__.addEventListener) {
        window.__adobe_cep__.addEventListener("com.adobe.csxs.events.ActiveFrameChanged", function () {
          state.selSig = "";
          refreshSelection();
        });
      }
    } catch (e) { }

    // 轮询兜底：时间线里换选中图层时没有事件可听，只能定时对一次
    setInterval(function () {
      if (!state.running) refreshSelection();
    }, REFRESH_MS);
  }

  function init() {
    var ids = [
      // 页面容器
      "pageHome", "pageUvr", "pageStyle", "pageEng", "pageSet",
      // 导航容器与一级标签
      "lv1", "tabWork", "tabSep", "tabSub", "tabEng", "tabSet",
      // 校对（v1.0.0 新增）
      "statSent2", "statEdited", "statLow", "checkList", "checkEmpty", "btnCommit", "btnRedo",
      // 位置与排版（v1.0.0 新增）
      "posGrid", "posName", "posX", "posY", "safeArea", "lineHeight", "maxLines",
      // 新页跳转
      "btnLocalModelGo", "btnLocalDirGo", "btnResetGo", "engLocalNote",
      // 校对（v1.0.0 实测）
      "checkList", "checkEmpty", "btnCommit", "btnRedo",
      "statSent2", "statEdited", "statLow",
      // 首页
      "envBadge", "btnGear", "btnSupport", "selInfo", "selHint", "btnRefresh", "btnRun",
      
      "createLayers", "noLayerWarn", "bar", "status", "snapSpeech", "stripPunct",
      "btnFreeMem", "btnCleanFiles", "maintOut", "btnSeparate",
      "resultCard", "resultInfo", "resultTip", "btnOpenOut",
      "log", "logBox",
      // 人声分离页
      "uvrOn", "uvrBadge", "uvrBody", "uvrTarget", "uvrModel", "uvrModelHint", "uvrFormat", "uvrKeep",
      "uvrGpu",
      "subPrefix", "nameMode", "rowSubPrefix", "btnSubCheck", "subCheckOut", "btnFixKeys",
      "owOverlay", "owBody", "owHint", "owReuse", "owOverwrite", "owCancel",
      "uvrPython", "uvrDeps", "btnUvrCheck", "btnUvrInstall", "btnUvrModel",
      "btnCleanModels", "skipPresetShort",
      // 字幕样式页
      "mode", "fontSize", "color", "fontQuery", "fontSelect", "btnFavFont", "fontNow", "btnPickFont",
      "btnFontRefresh", "fontCount",
      "presetQuery", "presetSelect", "btnFavPreset", "btnPresetFile", "btnPresetDir", "presetHint", "presetWarn",
      // 设置页
      "maxChars", "dropSuspect", "limitOn", "limitMin", "outDir", "keepAudio",
      // 识别引擎区
      "asrProfile", "asrHint", "asrQuota", "asrModelHint",
      "asrKeyRow", "asrApiKey", "asrPairRow", "asrSecretId", "asrSecretKey",
      "asrConsoleRow", "btnAsrConsole", "btnAsrTest", "asrModel", "asrModelPick", "asrBaseUrl", "asrPrompt", "asrChunk",
      "btnTest", "btnRebuild", "nodePath", "pipelineDir", "dataDir", "envDetail",
      "btnProbe", "btnReset", "btnSelfTest",
      // 通用二级确认弹层（cfmCount/cfmSize/cfmAll/cfmNone 为 v0.9.2 重做时新增）
      "cfmOverlay", "cfmTitle", "cfmBody", "cfmPermWrap", "cfmPerm", "cfmOk", "cfmCancel", "cfmHint",
      "cfmCount", "cfmSize", "cfmAll", "cfmNone",
      // 询问弹层
      "askOverlay", "askBody", "askHint", "askReplace", "askBelow", "askCancel",
      // v0.9.1 新组件
      "engBar", "engBarDot", "engBarText", "btnEngChange",
      "steps", "stExport", "stSep", "stAsr", "stLayer",
      "statGrid", "statSent", "statChars", "statEngine", "statTimeline",
      "chipsRow", "chipSrt", "chipJson", "chipTxt",
      "envGridUvr", "envGridSet",
      // 本地引擎（whisper.cpp）
      "asrLocalBlock", "asrAdvBox", "asrKeyNote", "localModel", "localModelHint",
      "envGridLocal", "lgExe", "lgModel", "lgGpu", "lgOffline",
      "btnLocalModel", "btnLocalDir", "btnCleanLocal", "localGpu", "localRuntime",
      "keyRowApi", "btnKeyEyeApi", "keyRowSecret", "btnKeyEyeSecret"
    ];
    ids.forEach(function (id) { el[id] = document.getElementById(id); });

    node = getNodeBuiltins();

    // 每次打开面板清空日志文件，保证看到的都是本次会话的记录
    if (node) {
      try {
        PANEL_LOG = joinPath(node.os.tmpdir(), "ae-subtitle", "panel.log");
        var logDir = node.path.dirname(PANEL_LOG);
        if (!node.fs.existsSync(logDir)) node.fs.mkdirSync(logDir, { recursive: true });
        node.fs.writeFileSync(PANEL_LOG, "", "utf8");
      } catch (e) { /* 忽略，不影响面板使用 */ }
    }

    if (!CepBridge.available()) {
      setBadge("不在 AE 中", "bad");
      log("× 这个面板需要从 After Effects 里打开（窗口 > 扩展 > Noniika）", "err");
    }
    if (!node) {
      setBadge("Node 未启用", "bad");
      log("× 面板内 Node 未启用，无法启动流水线。请确认 manifest 里配置了 --enable-nodejs", "err");
    }

    migrateSettings();      // 必须在 loadSettings 之前：老存档里的总开关要先归位
    loadSettings();
    bindEvents();
    showPage("work");       // 每次打开都从工作台开始
    syncNoLayerWarn();      // 让总开关的当前状态（含按钮文案）在面板一打开就如实反映
    syncUvrUi();            // 人声分离状态 → 首页入口按钮的副标题
    syncStyleUi();          // 排布 / 字号 / 预设 → 首页入口按钮的副标题
    syncEngineBar();        // 引擎状态条初值（引擎清单异步加载后会再刷一次）

    log("Noniika v1.0.0");
    log("用法：在时间线上选中要处理的素材图层 → 点「开始生成字幕」。");
    if (MIGRATE_NOTE) log("▲ " + MIGRATE_NOTE, "warn");
    log("提示：识别时音频会上传到所选引擎的服务商云端，请勿处理机密内容。", "warn");
    if (PANEL_LOG) log("（面板日志：" + PANEL_LOG + "）");

    probeEnvironment();
    refreshSelection();

    // 字体要遍历 AE 全部字体、预设要扫 AE 安装目录，首次都偏慢；
    // 推迟到界面画完之后再做，免得"打开面板就卡一下"
    if (CepBridge.available()) {
      setTimeout(function () {
        if (state.running) return;
        restoreFont();
        loadPresets();
      }, 700);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
