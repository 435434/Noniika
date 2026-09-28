/**
 * ae-api.js —— 对 ExtendScript 桥接层（jsx/ae-bridge.jsx）的语义化封装
 * ==========================================================
 * 所有函数统一返回 Promise<{ok:boolean, data?:any, error?:string}>。
 * 好处：调用方不用关心 evalScript 的字符串转义，也不用关心参数怎么拼。
 */
(function (global) {
  "use strict";

  var B = global.CepBridge;
  var a = B.arg;

  /** 统一收口：把 {ok:false} 也当成 Promise 的正常结果返回，由调用方决定怎么提示 */
  function call(script) {
    return B.evalJSON(script).then(
      function (res) { return res; },
      function (err) { return { ok: false, error: err.message }; }
    );
  }

  global.AeApi = {
    /** 读取【时间线上选中的图层】并给出处理计划（面板主入口） */
    getTimelineSelection: function (limitSec) {
      var v = (typeof limitSec === "number" && limitSec > 0) ? String(limitSec) : "0";
      return call("AESub_getTimelineSelection(" + v + ")");
    },

    /** 列出当前选中的合成（含音频体检结果）+ 项目信息（保留作诊断用） */
    getSelectionInfo: function () {
      return call("AESub_getSelectionInfo()");
    },

    /** 探测输出模板与格式（没有选中合成也能用） */
    probeEnvironment: function () {
      return call('AESub_probeEnvironment("")');
    },

    /** 按名字做音频体检 */
    analyzeByName: function (compName) {
      return call("AESub_analyzeByName(" + a(compName) + ")");
    },

    getProjectInfo: function () {
      return call("AESub_getProjectInfo()");
    },

    /**
     * 导出合成中【指定时间范围】的音频（仅音频，无损）。
     * 导出文件的时间 0 秒 == 合成时间 startSec，返回值里的 offsetSec 就是字幕需要的偏移量。
     * @param {string} compName     合成名
     * @param {number} startSec     起始时间（合成时间，秒）
     * @param {number} endSec       结束时间（合成时间，秒）
     * @param {string} outPathNoExt 输出路径不含扩展名，扩展名由 AE 按实际格式决定
     */
    exportAudio: function (compName, startSec, endSec, outPathNoExt) {
      return call(
        "AESub_exportAudio(" + a(compName) + "," + Number(startSec) + "," +
        Number(endSec) + "," + a(outPathNoExt) + ")"
      );
    },

    /**
     * 按字幕 JSON 在合成里创建字幕图层。
     * @param {string} compName 合成名
     * @param {string} jsonPath 字幕 JSON 的绝对路径
     * @param {object} opts     { mode, fontSize, color:[r,g,b], yPercent, prefix, fontPostScriptName }
     *                          yPercent 0.5 = 画面正中央（面板固定传 0.5，不再暴露给用户调）
     */
    createSubtitleLayers: function (compName, jsonPath, opts) {
      return call(
        "AESub_createSubtitleLayers(" + a(compName) + "," + a(jsonPath) + "," +
        a(JSON.stringify(opts || {})) + ")"
      );
    },

    /**
     * 字幕体检：检查合成里的字幕层是否真的能被看见（只读，不改任何东西）。
     * 报出：被上方视频层遮挡 / 空文本 / 被关闭 / 透明度 0 / 零时长。
     */
    checkSubtitleLayers: function (compName) {
      return call("AESub_checkSubtitleLayers(" + a(compName) + ")");
    },

    /**
     * 修复「预设动画关键帧错位」：把各字幕层的动画窗口整体搬回它的时间范围。
     * 只动"最早关键帧在层时间范围之外"的层，全程一个撤销组，可 Ctrl+Z 撤回。
     */
    fixPresetKeyTimes: function (compName) {
      return call("AESub_fixPresetKeyTimes(" + a(compName) + ")");
    },

    /**
     * 渲染验证：在同一时刻渲染两帧（指定文本层开 / 关），返回两个 PNG 路径，
     * 由面板自行比对。用于判断"这层到底有没有往画面画东西"。
     * 注意：会瞬间关一下该层再恢复。
     */
    probeSubtitleRender: function (compName, layerName, outDir) {
      return call("AESub_probeSubtitleRender(" + a(compName) + "," + a(layerName) + "," +
        a(outDir || "") + ")");
    },

    /**
     * 把分离出的人声音频落成时间线图层（混剪用）。
     * @param {string} compName     合成名
     * @param {string} srcLayerName 源图层名（要静音 / 替换的那条）
     * @param {string} audioPath    人声音频文件绝对路径
     * @param {object} opts         { mode: "video"|"replace"|"below", offsetSec, nameSuffix }
     */
    placeSeparatedAudio: function (compName, srcLayerName, audioPath, opts) {
      return call(
        "AESub_placeSeparatedAudio(" + a(compName) + "," + a(srcLayerName) + "," +
        a(audioPath) + "," + a(JSON.stringify(opts || {})) + ")"
      );
    },

    /**
     * 搜索字体家族（在 AE 侧过滤，只回传命中的少量结果）。
     * @param {string} query 关键词；空字符串返回"最近使用 + 常见中文字体"
     * @param {number} limit 最多返回多少个家族（默认 40）
     * @param {boolean} refresh 是否强制重建 AE 侧的字体缓存
     */
    searchFonts: function (query, limit, refresh) {
      var lim = (typeof limit === "number" && limit > 0) ? String(limit) : "40";
      return call("AESub_searchFonts(" + a(query || "") + "," + lim + "," +
        (refresh ? "true" : "false") + ")");
    },

    /** 从时间线上选中的文本图层里读取字体/字号/颜色 */
    pickTextStyleFromSelection: function () {
      return call("AESub_pickTextStyleFromSelection()");
    },

    /**
     * 一键自检：在当前工程里安全地验证字体检索 / 范围探测 / 居中几何，并写出报告。
     * 不导入素材、不新建合成，临时图层量完即删。
     * @param {string} outPath 报告 JSON 的绝对路径
     */
    selfTest: function (outPath) {
      return call("AESub_selfTest(" + a(outPath) + ")");
    }
  };
})(window);
