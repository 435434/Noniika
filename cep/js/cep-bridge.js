/**
 * cep-bridge.js —— 面板 ↔ ExtendScript 通信层
 * ==========================================================
 * 刻意不引入 Adobe 官方的 CSInterface.js：
 * 那个库版本繁杂、跨 CEP 版本容易踩坑，而面板真正需要的只有 evalScript
 * 一个能力，自己写三十行反而更可控、更好排障。
 *
 * 关键约束：**evalScript 只能回传字符串**，所以 ExtendScript 侧所有对外函数
 * 统一返回 JSON 字符串，这里负责解析。
 */
(function (global) {
  "use strict";

  function getCep() {
    try { return global.__adobe_cep__ || null; } catch (e) { return null; }
  }

  /** 调用 ExtendScript，拿到的永远是字符串 */
  function evalScript(script) {
    return new Promise(function (resolve) {
      var cep = getCep();
      if (!cep) {
        resolve('{"ok":false,"error":"CEP 环境不可用（面板可能不是从 AE 内打开的）"}');
        return;
      }
      var code = String(script);
      try {
        cep.evalScript(code, function (result) { resolve(result); });
      } catch (e) {
        var msg = String((e && e.message) || e).replace(/"/g, "'");
        resolve('{"ok":false,"error":"evalScript 调用失败：' + msg + '"}');
      }
    });
  }

  /** 调用 ExtendScript 并解析其返回的 JSON */
  function evalJSON(script) {
    return evalScript(script).then(function (raw) {
      if (raw === undefined || raw === null || raw === "") {
        throw new Error("AE 没有返回任何内容（脚本可能抛异常中断了）");
      }
      var text = String(raw);
      if (text === "EvalScript error.") {
        throw new Error("AE 执行脚本出错（EvalScript error），请检查 jsx 是否有语法错误");
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("AE 返回内容不是合法 JSON：" + text.slice(0, 300));
      }
    });
  }

  /** 把 JS 值转成可安全嵌进 evalScript 源码的字符串字面量 */
  function arg(v) {
    return JSON.stringify(v === undefined ? null : v);
  }

  /**
   * 把 CEP 返回的路径统一成**磁盘路径**（正斜杠）。
   *
   * ⚠️ 这里踩过一个大坑，务必保留：
   *   `cep.getSystemPath("extension")` 在实测环境里返回的是 **`file:///C:/…` 形式的 URL**，
   *   不是磁盘路径。直接拿它去拼 `joinPath(ext, "support.html")` 再喂给 Node 的
   *   `fs.existsSync` / `child_process`，**永远判不存在** —— 而且不报错，只是静默走兜底分支
   *   （实测症状：点面板上的按钮，日志写"文件不在插件目录"，然后打开了备用的网址）。
   *   同一台机器上不同 CEP 版本还可能返回普通路径，所以**两种形态都要能吃**。
   */
  function toFsPath(p) {
    var s = String(p === undefined || p === null ? "" : p).replace(/\\/g, "/");
    s = s.replace(/^file:\/{2,3}/i, "");          // file:///C:/… → C:/…
    try { s = decodeURIComponent(s); } catch (e) { }   // URI 里空格会写成 %20
    return s;
  }

  /** 取系统路径（复用 JSON 包一层，避免 getSystemPath 抛错时把调用方带崩） */
  function systemPath(type) {
    var cep = getCep();
    if (!cep || typeof cep.getSystemPath !== "function") return "";
    try {
      var p = cep.getSystemPath(type);
      return p ? toFsPath(p) : "";
    } catch (e) { return ""; }
  }

  global.CepBridge = {
    evalScript: evalScript,
    evalJSON: evalJSON,
    arg: arg,
    available: function () { return !!getCep(); },
    /**
     * 本扩展在磁盘上的目录（**普通路径**，已剥掉 file:// 前缀）。
     * **分发给别人时，流水线（pipeline）与自带 Node 就放在这个目录下面** ——
     * 面板靠它零配置定位，用户不用手填路径。开发环境里扩展目录下没有 pipeline，
     * 会自动回退到工程目录。
     */
    extensionPath: function () { return systemPath("extension"); },
    /** 我的文档目录（分离环境与模型的默认落脚点，别塞进系统目录） */
    myDocuments: function () { return systemPath("myDocuments"); }
  };
})(window);
