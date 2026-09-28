/*
 * demo.js —— 设计稿专用演示脚本（**不进面板**，实施时删除）
 * ============================================================
 * 纯前端交互，方便在浏览器里评审：
 *   · 标签栏四页切换（pgIn/pgBack 动画与面板一致）
 *   · 密钥显示/隐藏、收藏星标、字幕预览框实时渲染
 *   · URL 参数复现状态：?page=home|uvr|style|set
 *                            &dlg=ask|cfm|ow
 *                            &state=ready|nokey|noenv|running|done
 * 不含任何 AE / Node / 网络调用（没有后端逻辑）。
 * ============================================================
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);

  /* ---------------------------------------------------------- 标签页切换 */
  var PAGES = { home: "pageHome", uvr: "pageUvr", style: "pageStyle", set: "pageSet" };
  var TABS = { home: "tabHome", uvr: "tabUvr", style: "tabStyle", set: "tabSet" };
  var current = "home";

  function showPage(name, noAnim) {
    if (!PAGES[name]) name = "home";
    var prev = current;
    current = name;
    for (var k in PAGES) {
      if (!PAGES.hasOwnProperty(k)) continue;
      var p = $(PAGES[k]), t = $(TABS[k]);
      if (t) t.classList.toggle("on", k === name);
      if (!p) continue;
      var on_ = (k === name);
      p.classList.toggle("on", on_);
      if (on_ && !noAnim) {
        var anim = (name === "home" && prev !== "home") ? "pgBack" : "pgIn";
        p.style.animation = "none";
        void p.offsetWidth;
        p.style.animation = anim + " .19s ease-out";
      }
      p.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }

  var tabs = document.querySelectorAll(".tab[data-page]");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener("click", function () { showPage(this.getAttribute("data-page")); });
  }
  function on(id, fn) { var el = $(id); if (el) el.addEventListener("click", fn); }
  on("btnGear", function () { showPage("set"); });
  on("btnEngChange", function () { showPage("set"); });
  on("btnGoUvr", function () { showPage("uvr"); });
  on("btnGoStyle", function () { showPage("style"); });

  /* ---------------------------------------------------------- 密钥显隐 */
  function eye(inputId, btnId) {
    var inp = $(inputId), btn = $(btnId);
    if (!inp || !btn) return;
    btn.addEventListener("click", function () {
      var show = inp.type === "password";
      inp.type = show ? "text" : "password";
      btn.textContent = show ? "隐藏" : "显示";
    });
  }
  eye("asrApiKey", "btnKeyEyeApi");
  eye("asrSecretKey", "btnKeyEyeSecret");

  /* ---------------------------------------------------------- 字幕预览框（实时） */
  var FONT_CSS = {
    "STXingkai": '"STXingkai","KaiTi",serif',
    "SourceHanSansSC-Regular": '"Source Han Sans SC","Microsoft YaHei",sans-serif',
    "SimHei": '"SimHei",sans-serif',
    "SimSun": '"SimSun",serif',
    "MicrosoftYaHei": '"Microsoft YaHei",sans-serif'
  };
  function fontNameOf(v) {
    return {
      "STXingkai": "华文行楷", "SourceHanSansSC-Regular": "思源黑体",
      "SimHei": "SimHei", "SimSun": "宋体", "MicrosoftYaHei": "微软雅黑"
    }[v] || "跟随 AE 默认";
  }
  function refreshPreview() {
    var t = $("prevText"), cap = $("prevCap");
    if (!t) return;
    var sel = $("fontSelect"), size = $("fontSize"), color = $("color"), preset = $("presetSelect");
    var fv = sel ? sel.value : "STXingkai";
    t.style.fontFamily = FONT_CSS[fv] || "inherit";
    var px = size ? Math.max(16, Math.min(48, Math.round((+size.value || 72) * 0.5))) : 36;
    t.style.fontSize = px + "px";
    var cv = color ? color.value : "#ffe600";
    t.style.color = cv;
    if (cap) {
      cap.textContent = fontNameOf(fv) + " · " + (size ? size.value : 72) + " · " + cv +
        " · " + (preset && preset.value ? "预设：" + preset.options[preset.selectedIndex].text.replace("★ ", "") : "无动画预设");
    }
  }
  ["fontSelect", "fontSize", "color", "presetSelect"].forEach(function (id) {
    var el = $(id);
    if (el) { el.addEventListener("input", refreshPreview); el.addEventListener("change", refreshPreview); }
  });
  refreshPreview();

  /* ---------------------------------------------------------- 收藏星标（纯视觉） */
  ["btnFavFont", "btnFavPreset"].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener("click", function () {
      var on_ = el.classList.toggle("on");
      el.textContent = on_ ? "★" : "☆";
    });
  });

  /* ---------------------------------------------------------- 弹窗 */
  var DLG = { ask: "askOverlay", cfm: "cfmOverlay", ow: "owOverlay" };
  function showDlg(name) {
    for (var k in DLG) {
      if (!DLG.hasOwnProperty(k)) continue;
      var ov = $(DLG[k]);
      if (ov) ov.style.display = (k === name) ? "flex" : "none";
    }
  }
  function closeDlg() { showDlg(null); }
  for (var k2 in DLG) {
    if (!DLG.hasOwnProperty(k2)) continue;
    (function (ovId) {
      var ov = $(ovId);
      if (!ov) return;
      ov.addEventListener("click", function (e) { if (e.target === ov) closeDlg(); });
    })(DLG[k2]);
  }
  ["askCancel", "cfmCancel", "owCancel", "askReplace", "askBelow", "cfmOk", "owReuse", "owOverwrite"]
    .forEach(function (id) { on(id, closeDlg); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDlg(); });
  on("btnCleanFiles", function () { showDlg("cfm"); });

  /* ---------------------------------------------------------- 产物 chips（演示提示） */
  ["chipSrt", "chipJson", "chipTxt"].forEach(function (id) {
    on(id, function () {
      var st = $("status");
      if (st) st.textContent = "（演示）这里会用系统默认程序打开对应产物文件";
    });
  });

  /* ---------------------------------------------------------- 状态复现（URL 参数） */
  function setSteps(st) {
    var ids = ["stExport", "stSep", "stAsr", "stLayer"];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.className = "st" + (st[i] ? " " + st[i] : "");
    }
  }
  function setBar(pct) { var b = $("bar"); if (b) b.style.width = pct + "%"; }
  function setStatus(t) { var s = $("status"); if (s) s.textContent = t; }

  var state = qs.get("state") || "ready";
  if (state === "nokey") {
    var eb = $("engBar");
    if (eb) {
      eb.classList.remove("ok"); eb.classList.add("bad");
      $("engBarDot").className = "dot bad";
      $("engBarText").innerHTML = "未配置密钥 —— 生成字幕前必须先填（点「更改」去设置页）";
    }
    var badge = $("envBadge");
    if (badge) { badge.className = "badge warn"; badge.textContent = "待配置"; }
    /* 与 main.js:714 的真实禁用规则一致：环境未就绪 → 主按钮禁用 */
    ["btnRun", "btnSeparate"].forEach(function (id) {
      var el = $(id); if (el) el.disabled = true;
    });
  } else if (state === "noenv") {
    var badge2 = $("envBadge");
    if (badge2) { badge2.className = "badge warn"; badge2.textContent = "环境未就绪"; }
    var grid = $("envGridUvr");
    if (grid) {
      grid.innerHTML =
        '<div class="er off"><span class="dot"></span>分离环境<b>未安装</b></div>' +
        '<div class="er off"><span class="dot"></span>模型<b>未下载</b></div>' +
        '<div class="er"><span class="dot"></span>GPU 加速<b>可用 · CUDA</b></div>' +
        '<div class="er warn"><span class="dot"></span>Python<b>未找到 3.10~3.13</b></div>';
    }
    var ru = $("readyUvr");
    if (ru) { ru.classList.add("off"); $("navUvr").textContent = "未启用（环境未安装）"; }
  } else if (state === "running") {
    setSteps(["done", "on", "", ""]);
    setBar(34);
    setStatus("分离人声中…（本地 · Kim Vocal 2 · 约 1× 实时）");
    ["btnRun", "btnSeparate", "btnRefresh", "btnTest"].forEach(function (id) {
      var el = $(id); if (el) el.disabled = true;
    });
  } else if (state === "done") {
    setSteps(["done", "done", "done", "done"]);
    setBar(100);
    setStatus("完成：47 句 · 812 字 · 已建字幕图层");
    var rc = $("resultCard");
    if (rc) rc.style.display = "";
  } else {
    setSteps(["", "", "", ""]);
  }

  /* ---------------------------------------------------------- 入口参数 */
  var page = qs.get("page");
  if (page && PAGES[page]) showPage(page, true);
  var dlg = qs.get("dlg");
  if (dlg && DLG[dlg]) showDlg(dlg);
})();
