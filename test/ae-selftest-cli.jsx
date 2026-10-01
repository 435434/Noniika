/**
 * ae-selftest-cli.jsx —— 命令行执行通道探针 + 自检
 * ==========================================================
 * 目的：用 `AfterFX.exe -r` 跑通自检，从而不必每次都麻烦人工点面板。
 *
 * 与上一版的区别（关键）：
 *   上一版的开头守卫会调用 flush()，而 flush() 依赖桥接层里的 AESub_toJSON_。
 *   如果加载桥接层之前就走到守卫（例如 AE 恢复了一个非空项目），
 *   就会抛出未捕获异常 → 脚本静默死掉、一个文件都不写，
 *   症状与"卡在对话框"完全一样，极难分辨。
 *
 *   所以本版改成：**第一行就留痕**（不依赖任何外部函数），
 *   逐阶段落盘，任何一步失败都能精确定位。
 */

var OUT  = "E:/项目文件/agent/ae字幕插件/test/output/ae-selftest-result.json";
var PROG = "E:/项目文件/agent/ae字幕插件/test/output/ae-selftest-progress.txt";
var BRIDGE = "C:/Users/kunku/AppData/Roaming/Adobe/CEP/extensions/com.aesub.autosubtitle/jsx/ae-bridge.jsx";

/** 最基础的落盘：不依赖桥接层，任何阶段都能用 */
function mark(line, append) {
  try {
    var f = new File(PROG);
    f.encoding = "UTF-8";
    if (f.open(append ? "a" : "w")) {
      f.write(new Date().toLocaleTimeString() + "  " + line + "\n");
      f.close();
      return true;
    }
  } catch (e) { }
  return false;
}

// ---------- 第 0 步：证明脚本本体真的开始执行了 ----------
mark("0 script-entered", false);

// ---------- 第 1 步：环境事实 ----------
try {
  mark("1 aeVersion=" + app.version +
       "  projectNull=" + (app.project === null) +
       "  numItems=" + app.project.numItems +
       "  projectFile=" + (app.project.file ? app.project.file.fsName : "null"), true);
} catch (e1) {
  mark("1 probe-failed: " + (e1.message || e1.toString()), true);
}

// ---------- 第 2 步：加载桥接层 ----------
var bridgeOk = false;
try {
  $.evalFile(new File(BRIDGE));
  bridgeOk = true;
  mark("2 bridge-loaded", true);
} catch (e2) {
  mark("2 bridge-load-FAILED: " + (e2.message || e2.toString()), true);
}

// ---------- 第 3 步：跑自检 ----------
// 注意：`-r` 启动的 AE 是空工程，没有活动合成，
// 而自检的"居中几何"必须有个合成才有地方建临时文本层。
// 所以这里自建一个临时合成并激活它（跑完删掉），
// 只为验证「面板自检按钮」那条代码路径本身。
if (!bridgeOk) {
  try {
    var f3 = new File(OUT);
    f3.encoding = "UTF-8";
    if (f3.open("w")) {
      f3.write('{"ok":false,"errors":["bridge load failed"]}');
      f3.close();
    }
  } catch (e3) { }
  mark("3 skipped (no bridge)", true);
} else {
  var tmpComp = null;
  try {
    tmpComp = app.project.items.addComp("AESubSelfTestTmp", 1920, 1080, 1, 5, 25);
    try { tmpComp.openInViewer(); } catch (eOv) { }
    mark("3a temp-comp created, activeItemIsComp=" + (app.project.activeItem === tmpComp), true);
  } catch (eCC) {
    mark("3a temp-comp FAILED: " + (eCC.message || eCC.toString()), true);
  }

  try {
    var raw = AESub_selfTest(OUT);
    mark("3b selftest-returned, length=" + String(raw).length, true);
    try {
      var f4 = new File(OUT.replace(".json", "-raw.txt"));
      f4.encoding = "UTF-8";
      if (f4.open("w")) { f4.write(String(raw)); f4.close(); }
    } catch (e4) { }
  } catch (e5) {
    mark("3b selftest-THREW: " + (e5.message || e5.toString()), true);
  }

  // 清理临时合成
  try {
    if (tmpComp) tmpComp.remove();
    mark("3c temp-comp removed, projectItems=" + app.project.numItems, true);
  } catch (eRm) {
    mark("3c temp-comp remove FAILED: " + (eRm.message || eRm.toString()), true);
  }
}

// ---------- 第 4 步：收尾（避免 AE 退出时弹保存询问）----------
try { app.project.dirty = false; } catch (e6) { }
mark("4 finished", true);
