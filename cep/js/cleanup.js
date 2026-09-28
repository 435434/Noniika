/**
 * 清理模块 —— 内存 / 插件产物 / 模型。
 *
 * 设计原则（安全第一）：
 *   ① 所有删除**一律走回收站**（可还原）；只有用户明确勾选「放不进回收站就彻底删」
 *      才会降级为永久删除
 *   ② 路径全部来自**白名单式的已知位置**（我们的专用目录、我们自己的文件名前缀），
 *      绝不做「递归删父目录」这种事
 *   ③ 被占用的文件跳过并如实回报，不做任何强制手段
 *   ④ 清内存**不结束任何进程**，并且**跳过 AE 自身**（用户要求：不涉及 AE 的运行）
 *
 * 本文件只做「操作系统级的活儿」，不碰面板 DOM —— 这样可以在 Node 沙箱里直接测。
 */
var AeClean = (function () {
  "use strict";

  /* ------------------------------------------------------------ Node 底座 */

  var _nb = null;
  function nb() {
    if (_nb) return _nb;
    try {
      if (typeof require === "function") {
        _nb = {
          cp: require("node:child_process"),
          fs: require("node:fs"),
          path: require("node:path"),
          os: require("node:os"),
          buffer: require("node:buffer")
        };
      }
    } catch (e) { _nb = null; }
    return _nb;
  }

  /** 用正斜杠拼路径（Windows 完全接受，省掉反斜杠转义的麻烦） */
  function join() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = arguments[i];
      if (p === undefined || p === null || p === "") continue;
      parts.push(String(p).replace(/[\\/]+$/, ""));
    }
    return parts.join("/").replace(/([^:])\/{2,}/g, "$1/");
  }

  /* ---------------------------------------------------- PowerShell 调用层 */

  /**
   * 跑一段 PowerShell（用 -EncodedCommand 传，彻底避开引号转义与编码问题）。
   * @param {String} script PowerShell 脚本文本
   * @param {Object} [env]  额外环境变量（字符串值）
   * @returns {Promise<{code:Number, out:String, err:String}>}
   */
  function runPs(script, env) {
    var n = nb();
    if (!n) return Promise.reject(new Error("面板里的 Node 未启用，无法执行清理"));

    var encoded;
    try {
      encoded = n.buffer.Buffer.from(script, "utf16le").toString("base64");
    } catch (e) {
      return Promise.reject(new Error("脚本编码失败：" + (e.message || e)));
    }

    return new Promise(function (resolve, reject) {
      var child;
      try {
        child = n.cp.spawn("powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          {
            windowsHide: true,
            env: Object.assign({}, process.env, env || {})
          });
      } catch (e) {
        return reject(new Error("无法启动 PowerShell：" + (e.message || e)));
      }

      var out = "", err = "", done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { child.kill(); } catch (e) { }
        reject(new Error("PowerShell 超时（120 秒）"));
      }, 120000);

      if (child.stdout) child.stdout.on("data", function (d) { out += d.toString("utf8"); });
      if (child.stderr) child.stderr.on("data", function (d) { err += d.toString("utf8"); });
      child.on("error", function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(new Error("PowerShell 启动失败：" + (e.message || e)));
      });
      child.on("close", function (code) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ code: code, out: out, err: err });
      });
    });
  }

  /** 从 PowerShell 的输出里取出最后一行 JSON 并解析 */
  function pickJson(text) {
    var lines = String(text || "").split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var t = lines[i].trim();
      if (t.charAt(0) === "{") {
        try { return JSON.parse(t); } catch (e) { /* 继续往前找 */ }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ 内存清理 */

  /**
   * 把各进程「占着不用」的内存页还给系统（EmptyWorkingSet）。
   *
   * - 不需要管理员权限，**不结束任何进程**，不改任何数据
   * - **跳过 AE 自身**（AfterFX / AfterFXLib）：用户要求清理不涉及 AE 的运行
   * - 也跳过几个关键系统进程（对它们调用会失败，跳过更干净）
   * - 不做「清空备用内存列表」：那需要管理员权限，且会连带清掉文件缓存，
   *   反而让 AE 读素材变慢 —— 与「不涉及 AE 的运行」相悖
   */
  var PS_FREE_MEMORY = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$sig = '[DllImport(\"psapi.dll\", SetLastError=true)] public static extern bool EmptyWorkingSet(IntPtr hProcess);'",
    "$t = Add-Type -MemberDefinition $sig -Name AesubWs -Namespace AesubMem -PassThru",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "$total = [int64]$os.TotalVisibleMemorySize * 1024",
    "$before = [int64]$os.FreePhysicalMemory * 1024",
    "$skip = @('AfterFX','AfterFXLib','System','Idle','Registry','Memory Compression','csrss','wininit','services','lsass','fontdrvhost','dwm','smss','winlogon','audiodg')",
    "$me = $PID; $trimmed = 0; $failed = 0",
    "foreach ($p in @(Get-Process)) {",
    "  if ($skip -contains $p.ProcessName) { continue }",
    "  if ($p.Id -eq $me) { continue }",
    "  $h = $null",
    "  try { $h = $p.Handle } catch { continue }",
    "  if ($h -eq $null) { continue }",
    "  try { if ($t::EmptyWorkingSet($h)) { $trimmed++ } else { $failed++ } } catch { $failed++ }",
    "}",
    "Start-Sleep -Milliseconds 600",
    "$os2 = Get-CimInstance Win32_OperatingSystem",
    "$after = [int64]$os2.FreePhysicalMemory * 1024",
    "$o = New-Object System.Collections.Hashtable",
    "$o.total = $total; $o.before = $before; $o.after = $after; $o.freed = $after - $before",
    "$o.trimmed = $trimmed; $o.failed = $failed",
    "$o | ConvertTo-Json -Compress"
  ].join("\n");

  function freeMemory() {
    return runPs(PS_FREE_MEMORY).then(function (r) {
      var o = pickJson(r.out);
      if (!o) {
        throw new Error("没能读到内存数据" +
          (r.err ? ("（" + String(r.err).trim().slice(0, 160) + "）") : ""));
      }
      return {
        totalBytes: Number(o.total) || 0,
        beforeBytes: Number(o.before) || 0,
        afterBytes: Number(o.after) || 0,
        freedBytes: Number(o.freed) || 0,
        trimmed: Number(o.trimmed) || 0,
        failed: Number(o.failed) || 0
      };
    });
  }

  /* ------------------------------------------------------------ 目录扫描 */

  /** 递归统计一个路径（文件数 + 字节数），出错的地方跳过 */
  function measure(n, target, isDir) {
    var acc = { bytes: 0, count: 0 };
    if (!isDir) {
      try {
        var st = n.fs.statSync(target);
        acc.bytes = st.size;
        acc.count = 1;
      } catch (e) { }
      return acc;
    }
    var stack = [target];
    while (stack.length) {
      var dir = stack.pop();
      var names;
      try { names = n.fs.readdirSync(dir); } catch (e) { continue; }
      for (var i = 0; i < names.length; i++) {
        var p = join(dir, names[i]);
        var st2 = null;
        try { st2 = n.fs.lstatSync(p); } catch (e2) { continue; }
        if (st2.isDirectory()) stack.push(p);
        else { acc.bytes += st2.size; acc.count++; }
      }
    }
    return acc;
  }

  function existsDir(n, p) {
    try { return n.fs.statSync(p).isDirectory(); } catch (e) { return false; }
  }
  function existsFile(n, p) {
    try { return n.fs.statSync(p).isFile(); } catch (e) { return false; }
  }

  /**
   * 判断这个文件是不是**我们生成的字幕**（而不是用户自己的同名文件）。
   *
   * 输出目录是用户填的，可能本来就放着他的东西 —— 只看扩展名删文件太危险，
   * 所以读一小段内容核对结构：
   *   json → 能解析、且是数组、元素带 text 与 startMs/endMs
   *   srt  → 以「序号 + 时间码 -->」的标准结构开头
   * 读不了、结构不符、或文件大得不像字幕（>8MB）一律**不认**。
   */
  function looksLikeSubtitle(n, filePath, kind) {
    try {
      var st = n.fs.statSync(filePath);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return false;
      var text = n.fs.readFileSync(filePath, "utf8");
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

      if (kind === "json") {
        var arr = null;
        try { arr = JSON.parse(text); } catch (e) { return false; }
        if (!arr || Object.prototype.toString.call(arr) !== "[object Array]" || !arr.length) return false;
        var first = arr[0] || {};
        var hasText = (typeof first.text === "string");
        var hasMs = (typeof first.startMs === "number") || (typeof first.endMs === "number") ||
          (typeof first.start === "number");
        return hasText && hasMs;
      }

      // srt：第 1 行是序号、第 2 行是 00:00:00,040 --> 00:00:01,920
      return /^\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text);
    } catch (e2) {
      return false;
    }
  }

  /**
   * 列出所有插件产生的文件（不含模型 —— 模型走单独的「清理模型」）。
   *
   * 只认白名单式的已知位置：
   *   <输出目录>/_中间音频/        本次识别用的导出音频与转码产物
   *   <输出目录>/_人声分离/        人声 / 伴奏（含 _tmp）
   *   <输出目录>/*.srt|.json|.txt  字幕成品文件（单独一组，默认不勾）
   *   %TEMP%/aesub-*               体检帧、诊断中间文件
   *   %TEMP%/CEPHtmlEngine*com.aesub.autosubtitle*.log   面板日志
   *   <项目根>/python-env/         Python 运行环境（单独一组，默认不勾）
   *
   * @param {Object} opts { outDir, projectRoot, tempDir, modelsDir }
   * @returns {Promise<{groups:Array, totalBytes:Number, totalCount:Number}>}
   */
  function scan(opts) {
    var n = nb();
    if (!n) return Promise.reject(new Error("面板里的 Node 未启用，无法扫描"));

    var o = opts || {};
    var groups = [];

    function pushGroup(g) {
      if (!g) return;
      if (!g.items.length) return;
      groups.push(g);
    }

    // —— 1. 中间音频 ——
    if (o.outDir) {
      var midDir = join(o.outDir, "_中间音频");
      if (existsDir(n, midDir)) {
        var m = measure(n, midDir, true);
        pushGroup({
          key: "mid", label: "中间音频", note: "识别用的导出音频与转码中间产物",
          defaultOn: true,
          items: [{ path: midDir, dir: true, size: m.bytes, count: m.count }],
          bytes: m.bytes, count: m.count
        });
      }
    }

    // —— 2. 人声分离产物 ——
    if (o.outDir) {
      var sepDir = join(o.outDir, "_人声分离");
      if (existsDir(n, sepDir)) {
        var s = measure(n, sepDir, true);
        pushGroup({
          key: "sep", label: "人声分离产物", note: "人声 / 伴奏音频（时间线上的图层仍指向它们，删后图层会离线）",
          defaultOn: true,
          items: [{ path: sepDir, dir: true, size: s.bytes, count: s.count }],
          bytes: s.bytes, count: s.count
        });
      }
    }

    // —— 3. 系统临时目录里插件产生的文件 ——
    var tempDir = o.tempDir || n.os.tmpdir();
    var tempItems = [], tempBytes = 0, tempCount = 0;
    try {
      var names = n.fs.readdirSync(tempDir);
      for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        var low = nm.toLowerCase();
        // 判据全部是「我们自己写出去的名字」：
        //   aesub-* / aesub_*  = 插件自己写的临时文件（体检帧、诊断中间文件）
        //   体检帧_*            = 体检留档的两帧 PNG
        //   *com.aesub.autosubtitle*.log = CEP 引擎给本面板写的日志
        var hit = (low.indexOf("aesub-") === 0 || low.indexOf("aesub_") === 0 ||
          nm.indexOf("体检帧_") === 0 ||
          (low.indexOf("com.aesub.autosubtitle") >= 0 && low.slice(-4) === ".log"));
        if (!hit) continue;
        var fp = join(tempDir, nm);
        var st = null;
        try { st = n.fs.lstatSync(fp); } catch (e) { continue; }
        if (st.isDirectory()) continue;
        tempItems.push({ path: fp, dir: false, size: st.size, count: 1 });
        tempBytes += st.size; tempCount++;
      }
    } catch (e2) { }
    pushGroup({
      key: "temp", label: "系统临时文件", note: "体检渲染帧、诊断中间文件、面板日志（正在使用的会跳过）",
      defaultOn: true, items: tempItems, bytes: tempBytes, count: tempCount
    });

    // —— 4. 输出目录里的字幕成品文件（默认不勾，怕误删用户自己的同名文件）——
    // 输出目录是用户自己填的，里面完全可能有他自己的文件 —— 所以这里**不只看扩展名**，
    // 还要读一小段内容确认「这确实是插件生成的字幕」：
    //   .json → 解析成功、且是「段落数组」（我们的产物就是 segments 数组）
    //   .srt  → 开头是标准的 序号 + 时间码 --> 结构
    //   .txt  → **不收录**（纯文本太通用，无法可靠区分，宁可不删）
    if (o.outDir) {
      var subItems = [], subBytes = 0;
      try {
        var entries = n.fs.readdirSync(o.outDir);
        for (var k = 0; k < entries.length; k++) {
          var fn = entries[k];
          if (!/\.(srt|json)$/i.test(fn)) continue;
          var full = join(o.outDir, fn);
          if (!existsFile(n, full)) continue;
          if (!looksLikeSubtitle(n, full, /\.json$/i.test(fn) ? "json" : "srt")) continue;
          var st3 = null;
          try { st3 = n.fs.statSync(full); } catch (e) { continue; }
          subItems.push({ path: full, dir: false, size: st3.size, count: 1 });
          subBytes += st3.size;
        }
      } catch (e3) { }
      pushGroup({
        key: "subs", label: "字幕成品文件", note: "输出目录里确认是插件生成的字幕文件（.srt / .json）；" +
          "纯文本 .txt 不自动清理，避免误删你自己的文件。删掉后「用已有字幕建图层」需要重新识别",
        defaultOn: false, items: subItems, bytes: subBytes, count: subItems.length
      });
    }

    // —— 5. Python 运行环境（默认不勾：删了要重装）——
    if (o.projectRoot) {
      var venv = join(o.projectRoot, "python-env");
      if (existsDir(n, venv)) {
        var v = measure(n, venv, true);
        pushGroup({
          key: "venv", label: "Python 运行环境", note: "人声分离用的独立环境，删除后需重新「一键安装环境」",
          defaultOn: false,
          items: [{ path: venv, dir: true, size: v.bytes, count: v.count }],
          bytes: v.bytes, count: v.count
        });
      }
    }

    // —— 6. 模型：只报出来，不在这个按钮里删 ——
    if (o.modelsDir) {
      var ms = scanModelsIn(n, o.modelsDir);
      if (ms.count) {
        groups.push({
          key: "models", label: "识别模型", note: "需要用「清理模型」按钮单独清理（此处不可勾）",
          defaultOn: false, locked: true, items: [], bytes: ms.bytes, count: ms.count
        });
      }
    }

    var totalBytes = 0, totalCount = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      if (g.locked) continue;
      if (g.defaultOn) { totalBytes += g.bytes; totalCount += g.count; }
    }

    return Promise.resolve({ groups: groups, totalBytes: totalBytes, totalCount: totalCount });
  }

  /* ------------------------------------------------------------ 模型清理 */

  /** 模型本体只认这些扩展名（元数据 json 保留，否则模型列表会失效） */
  var MODEL_EXT = /\.(onnx|ckpt|pth|th|yaml|yml)$/i;

  function scanModelsIn(n, modelsDir) {
    var items = [], bytes = 0;
    if (!existsDir(n, modelsDir)) return { items: [], bytes: 0, count: 0 };
    var names;
    try { names = n.fs.readdirSync(modelsDir); } catch (e) { return { items: [], bytes: 0, count: 0 }; }
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      if (!MODEL_EXT.test(nm)) continue;
      var p = join(modelsDir, nm);
      if (!existsFile(n, p)) continue;
      var st = null;
      try { st = n.fs.statSync(p); } catch (e) { continue; }
      items.push({ path: p, dir: false, size: st.size, count: 1, name: nm });
      bytes += st.size;
    }
    return { items: items, bytes: bytes, count: items.length };
  }

  function scanModels(modelsDir) {
    var n = nb();
    if (!n) return Promise.reject(new Error("面板里的 Node 未启用，无法扫描"));
    var r = scanModelsIn(n, modelsDir);
    return Promise.resolve({ items: r.items, bytes: r.bytes, count: r.count });
  }

  /* ------------------------------------------------------------ 删除执行 */

  var PS_RECYCLE = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$raw = [System.IO.File]::ReadAllText($env:AESUB_LIST, [System.Text.Encoding]::UTF8)",
    "$list = $raw | ConvertFrom-Json",
    "$ok = 0; $perm = 0; $skip = 0; $freed = 0; $errs = @()",
    "foreach ($it in $list) {",
    "  $p = [string]$it.path",
    "  $sz = [int64]$it.size",
    "  if (-not (Test-Path -LiteralPath $p)) { continue }",
    "  try {",
    "    if ($it.dir) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }",
    "    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }",
    "  } catch { }",
    "  $gone = -not (Test-Path -LiteralPath $p)",
    "  if ($gone) { $ok++; $freed += $sz }",
    "  if (-not $gone -and $env:AESUB_PERM -eq '1') {",
    "    try {",
    "      if ($it.dir) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }",
    "      else { Remove-Item -LiteralPath $p -Force -ErrorAction Stop }",
    "    } catch { }",
    "    $gone = -not (Test-Path -LiteralPath $p)",
    "    if ($gone) { $perm++; $freed += $sz }",
    "  }",
    "  if (-not $gone) { $skip++; if ($errs.Count -lt 8) { $errs += $p } }",
    "}",
    "$o = New-Object System.Collections.Hashtable",
    "$o.ok = $ok; $o.permanent = $perm; $o.skipped = $skip; $o.freed = $freed; $o.sample = $errs",
    "$o | ConvertTo-Json -Compress"
  ].join("\n");

  /**
   * 删除一批路径（默认走回收站）。
   *
   * @param {Array} items [{path, dir, size}]
   * @param {Object} [opts] { permanentFallback:Boolean }
   * @returns {Promise<{recycled, permanent, skipped, freedBytes, sample}>}
   */
  function recycle(items, opts) {
    var n = nb();
    if (!n) return Promise.reject(new Error("面板里的 Node 未启用，无法删除"));
    var list = (items || []).filter(function (it) { return it && it.path; });
    if (!list.length) {
      return Promise.resolve({ recycled: 0, permanent: 0, skipped: 0, freedBytes: 0, sample: [] });
    }

    var stamp = String(Date.now());
    var listPath = join(n.os.tmpdir(), "aesub-clean-" + stamp + ".json");
    var payload = list.map(function (it) {
      return { path: String(it.path).replace(/\\/g, "/"), dir: !!it.dir, size: Number(it.size) || 0 };
    });

    try {
      n.fs.writeFileSync(listPath, JSON.stringify(payload), "utf8");
    } catch (e) {
      return Promise.reject(new Error("无法写入待删清单：" + (e.message || e)));
    }

    return runPs(PS_RECYCLE, {
      AESUB_LIST: listPath,
      AESUB_PERM: opts && opts.permanentFallback ? "1" : "0"
    }).then(function (r) {
      try { n.fs.unlinkSync(listPath); } catch (e2) { }
      var o = pickJson(r.out);
      if (!o) {
        throw new Error("删除结果无法解析" +
          (r.err ? ("（" + String(r.err).trim().slice(0, 160) + "）") : ""));
      }
      return {
        recycled: Number(o.ok) || 0,
        permanent: Number(o.permanent) || 0,
        skipped: Number(o.skipped) || 0,
        freedBytes: Number(o.freed) || 0,
        sample: o.sample || []
      };
    }, function (e3) {
      try { n.fs.unlinkSync(listPath); } catch (e4) { }
      throw e3;
    });
  }

  /* ------------------------------------------------------------ 对外接口 */

  return {
    available: function () { return !!nb(); },
    join: join,
    runPs: runPs,
    freeMemory: freeMemory,
    scan: scan,
    scanModels: scanModels,
    recycle: recycle,
    /** 仅给测试用：暴露脚本常量，便于断言 */
    _scripts: { freeMemory: PS_FREE_MEMORY, recycle: PS_RECYCLE }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AeClean;
