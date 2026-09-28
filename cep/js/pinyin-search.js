/**
 * 拼音搜索（面板侧）
 * ==================================================================
 * 为什么有这个东西：
 *   CEP 12 的面板里，中文输入法的候选浮窗会卡在屏幕左上角（Adobe 官方确认的
 *   缺陷，编号 CEP-3029，CEP 9/10 没有这个问题）。既然在面板里打汉字难受，
 *   那就让用户**一个汉字都不用打**——直接打拼音或首字母：
 *       搜「锐字奥运精神拼搏简」→ 打 ruizi / rz / aoyun 都能命中
 *       搜「华文行楷」        → 打 hw / huawei(前缀) / xingkai 都能命中
 *
 * 数据来自同目录的 pinyin-table.js（由 tools/make-pinyin-table.js 生成）。
 * 本文件只做纯计算、不碰 DOM，方便单独跑测试（test/pinyin-search-test.js）。
 */
var AesubPy = (function () {
  "use strict";

  var MAP = null;          // 汉字 → 拼音
  var CACHE = {};          // 显示名 → 索引（同一条会被反复打分，必须缓存）
  var CACHE_MAX = 4000;

  function build() {
    MAP = {};
    var chars = (typeof AESUB_PY_CHARS === "string") ? AESUB_PY_CHARS : "";
    var data = (typeof AESUB_PY_DATA === "string") ? AESUB_PY_DATA.split(",") : [];
    for (var i = 0; i < chars.length; i++) {
      if (data[i]) MAP[chars.charAt(i)] = data[i];
    }
    return MAP;
  }

  /** 表里有多少字（0 表示数据文件没加载上，调用方应退回原搜索） */
  function size() {
    if (!MAP) build();
    var n = 0;
    for (var k in MAP) { if (MAP.hasOwnProperty(k)) n++; }
    return n;
  }

  function usable() { return size() > 100; }

  /**
   * 该不该走"拼音模式"：纯 ASCII 字母数字、含至少一个字母、不太长。
   * 汉字 / 带符号的关键词照旧走原来的搜索路径。
   */
  function isAsciiQuery(q) {
    var s = String(q == null ? "" : q).replace(/\s+/g, "");
    if (!s || s.length > 24) return false;
    if (!/^[A-Za-z0-9]+$/.test(s)) return false;
    return /[A-Za-z]/.test(s);
  }

  /**
   * 给一个显示名建三种形态（都小写、去空白），带缓存：
   *   raw  —— 原文（ASCII 字母数字照留，汉字照留），用于字面命中
   *   full —— 拼音全拼（ASCII 部分原样拼进去），用于 ruizi 这种
   *   init —— 拼音首字母（ASCII 部分原样），用于 rz 这种
   */
  function index(text) {
    var key = String(text == null ? "" : text);
    var hit = CACHE[key];
    if (hit) return hit;
    if (!MAP) build();

    var raw = [], full = [], init = [];
    for (var i = 0; i < key.length; i++) {
      var ch = key.charAt(i);
      if (/[A-Za-z0-9]/.test(ch)) {
        var lo = ch.toLowerCase();
        raw.push(lo); full.push(lo); init.push(lo);
      } else if (MAP[ch]) {
        var py = MAP[ch];
        raw.push(ch);
        full.push(py);
        init.push(py.charAt(0));
      } else if (/\s/.test(ch)) {
        /* 空白丢掉：用户不会打空格 */
      } else {
        raw.push(ch);          // 标点（· ° / 等）只影响字面匹配
      }
    }

    var out = { raw: raw.join(""), full: full.join(""), init: init.join("") };

    var n = 0;
    for (var k in CACHE) { if (CACHE.hasOwnProperty(k)) { n++; if (n >= CACHE_MAX) { CACHE = {}; break; } } }
    CACHE[key] = out;
    return out;
  }

  /**
   * 打分：命中返回 1~100（越大越靠前），不命中返回 -1。
   * 优先级：字面前缀 > 首字母前缀 > 全拼前缀 > 字面包含 > 全拼包含 > 首字母包含
   *   —— 用户直接打英文名（simhei）时字面前缀最高分，打拼音时首字母/全拼依次排开。
   */
  function score(text, q) {
    var s = String(q == null ? "" : q).replace(/\s+/g, "").toLowerCase();
    if (!s) return -1;
    var ix = index(text);
    if (ix.raw.indexOf(s) === 0) return 100;
    if (ix.init && ix.init.indexOf(s) === 0) return 85;
    if (ix.full.indexOf(s) === 0) return 75;
    if (ix.raw.indexOf(s) > 0) return 65;
    if (ix.full.indexOf(s) > 0) return 45;
    if (ix.init.indexOf(s) > 0) return 35;
    return -1;
  }

  /** 只要"命中与否"的场合（预设过滤那种）用这个，读起来更清楚 */
  function hit(text, q) { return score(text, q) >= 0; }

  return {
    usable: usable,
    size: size,
    isAsciiQuery: isAsciiQuery,
    index: index,
    score: score,
    hit: hit
  };
})();
