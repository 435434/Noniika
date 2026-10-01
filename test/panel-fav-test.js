/**
 * 面板「收藏夹 + 页面切换动画」的沙箱测试（不需要 AE）
 * ==========================================================
 * 把 cep/js/main.js 里的收藏工具、两个下拉的渲染、星标状态同步、
 * showPage 抠出来，配一个极简假 DOM 跑分支：
 *   ① 收藏的增 / 删 / 置前
 *   ② 存档容错（非法 JSON、不是数组、元素缺字段）
 *   ③ favFilter 关键词过滤
 *   ④ 字体下拉：收藏组置顶 + 搜索结果去重 + 无命中文案
 *   ⑤ 预设下拉：收藏组置顶 + 去重
 *   ⑥ 星标状态（★/☆、禁用、title 文案）
 *   ⑦ showPage 的动画名与 classList
 *
 * 用法： node test/panel-fav-test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "cep", "js", "main.js"), "utf8")
  .split(/\r?\n/);

function slice(name) {
  const start = src.findIndex((l) => l.includes("function " + name + "("));
  if (start < 0) throw new Error("找不到函数 " + name);
  for (let i = start + 1; i < src.length; i++) {
    if (src[i].replace(/\s+$/, "") === "  }") return src.slice(start, i + 1).join("\n");
  }
  throw new Error("找不到 " + name + " 的结束行");
}

/* 拼音搜索：把真实的数据表与匹配逻辑整个装进沙箱（不是打桩），
   这样测的就是线上跑的那套代码。 */
const PINYIN_SRC = ["cep/js/pinyin-table.js", "cep/js/pinyin-search.js"]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n");

const code = [
  'var LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };',
  'var state = {};',
  'var PRESET_CAT_ALIASES = {};',
  'var FONT_LIMIT = 120;',
  'var FONT_INDEX_LIMIT = 4000;',
  'function log() {}',
  PINYIN_SRC,
  slice("lsGet"),
  slice("lsSet"),
  slice("favGet"),
  slice("favSave"),
  slice("favIndexOf"),
  slice("favHas"),
  slice("favToggle"),
  slice("favFilter"),
  slice("favValueMap"),
  slice("syncFavFont"),
  slice("syncFavPreset"),
  slice("selectedLabel"),
  slice("ensureCurrentFontOption"),
  slice("ensureCurrentPresetOption"),
  slice("renderFontOptions"),
  slice("renderPresetOptions"),
  slice("showPage"),
  slice("groupsOf"),
  slice("showGroup"),
  slice("fontLabelOf"),
  slice("pickFontsByQuery"),
  slice("applyFontRes"),
  slice("searchFontsPinyin"),
  slice("searchFonts"),
  "globalThis.__api = { favGet: favGet, favToggle: favToggle, favHas: favHas, favFilter: favFilter,",
  "  favValueMap: favValueMap, favSave: favSave, syncFavFont: syncFavFont, syncFavPreset: syncFavPreset,",
  "  selectedLabel: selectedLabel, renderFontOptions: renderFontOptions,",
  "  renderPresetOptions: renderPresetOptions, showPage: showPage,",
  "  fontLabelOf: fontLabelOf, pickFontsByQuery: pickFontsByQuery, searchFonts: searchFonts,",
  "  setState: function (s) { state = s; }, getState: function () { return state; } };"
].join("\n\n");

/* ------------------------------------------------------------ 假 DOM */

function mkNode(tag) {
  const n = {
    _tag: tag,
    value: "",
    textContent: "",
    label: "",
    disabled: false,
    className: "",
    children: [],
    style: {},
    _cls: {},
    _l: {},
    classList: {
      add(c) { n._cls[c] = 1; },
      remove(c) { delete n._cls[c]; },
      contains(c) { return !!n._cls[c]; },
      toggle(c, on) {
        const want = (on === undefined) ? !n._cls[c] : !!on;
        if (want) n._cls[c] = 1; else delete n._cls[c];
        return want;
      }
    },
    appendChild(c) { n.children.push(c); return c; },
    insertBefore(c) { n.children.unshift(c); return c; },
    addEventListener(t, f) { n._l[t] = f; },
    // v0.9.3：main.js 会按选择器找分组容器。真实 CEF 里有这些方法，
    // stub 只关心收藏与切页动画，给空实现即可。
    querySelectorAll() { return []; },
    querySelector() { return null; },
    get firstChild() { return n.children[0] || null; }
  };
  return n;
}

function mkSelect() {
  const s = mkNode("select");
  s._opts = [];
  Object.defineProperty(s, "options", { get() { return s._opts; } });
  Object.defineProperty(s, "innerHTML", {
    get() { return ""; },
    set(v) { if (v === "") { s._opts = []; s.children = []; } }
  });
  s.appendChild = function (c) {
    s.children.push(c);
    if (c._tag === "optgroup") {
      const orig = c.appendChild.bind(c);
      c.appendChild = function (o) { orig(o); s._opts.push(o); return o; };
    } else {
      s._opts.push(c);
    }
    return c;
  };
  s.insertBefore = function (c) { s.children.unshift(c); s._opts.unshift(c); return c; };
  return s;
}

/** 递归取出下拉里的 option（带所属分组名），用于断言结构与顺序 */
function optsOf(sel) {
  const out = [];
  (function walk(node, group) {
    if (node._tag === "option") {
      out.push({ value: node.value, text: node.textContent, group: group });
    }
    (node.children || []).forEach((c) => walk(c, node._tag === "optgroup" ? node.label : group));
  })({ children: sel.children, _tag: "root" }, "");
  return out;
}

function makeEnv() {
  const storage = {};
  const ctl = {};
  const fontSelect = mkSelect();
  const presetSelect = mkSelect();
  const els = {
    fontSelect: fontSelect,
    presetSelect: presetSelect,
    fontQuery: Object.assign(mkNode("input"), { value: "" }),
    presetQuery: Object.assign(mkNode("input"), { value: "" }),
    fontCount: mkNode("span"),
    fontNow: mkNode("div"),
    presetHint: mkNode("div"),
    btnFavFont: mkNode("button"),
    btnFavPreset: mkNode("button")
  };
  const pages = { pageHome: mkNode("div"), pageUvr: mkNode("div"),
                  pageStyle: mkNode("div"), pageEng: mkNode("div"), pageSet: mkNode("div") };

  const sandbox = {
    LS: undefined,
    state: {},
    PRESET_CAT_ALIASES: {},
    window: {
      localStorage: {
        getItem(k) { return (k in storage) ? storage[k] : null; },
        setItem(k, v) { storage[k] = String(v); },
        removeItem(k) { delete storage[k]; }
      },
      scrollTo() { ctl.scrolled = (ctl.scrolled || 0) + 1; }
    },
    document: {
      createElement: mkNode,
      getElementById(id) { return pages[id] || null; },
      querySelectorAll() { return []; },
      querySelector() { return null; }
    },
    PAGE_IDS: { work: "pageHome", sep: "pageUvr", sub: "pageStyle",
                eng: "pageEng", set: "pageSet" },
    el: els,
    log() {},
    checkUvrDeps() {},
    loadPresets() {},
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, api: sandbox.__api, els, storage, pages, ctl, fontSelect, presetSelect };
}

function fontRes(families, query) {
  return {
    ok: true,
    data: {
      available: true,
      ready: true,
      totalFamilies: 999,
      matched: families.length,
      query: query || "",
      families: families
    }
  };
}

const F = (name, ps) => ({ nativeName: name, family: name, styles: [{ ps: ps, nativeStyle: "Regular" }] });

/* ------------------------------------------------------------ 断言收集 */

let pass = 0, fail = 0;
const results = [];
let PENDING_ASYNC = null;      // 第 ⑨ 节是异步的，汇总要等它跑完
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  OK    " + name); }
  else { fail++; results.push("  FAIL  " + name + (extra !== undefined ? "   -> " + extra : "")); }
}

/* ============================================================ ① 收藏增删 */
{
  const { api, storage } = makeEnv();
  const K = "aesub.favFonts";

  check("① 一开始收藏为空", api.favGet(K).length === 0);
  check("① 未收藏时 favHas 为 false", api.favHas(K, "PS_A") === false);

  const added = api.favToggle(K, "PS_A", "字体A");
  check("① toggle 返回 true 表示已收藏", added === true);
  check("① 收藏后 favHas 为 true", api.favHas(K, "PS_A") === true);
  check("① 收藏项记下了显示名", api.favGet(K)[0].t === "字体A");

  api.favToggle(K, "PS_B", "字体B");
  check("① 新收藏排在最前面", api.favGet(K)[0].v === "PS_B",
    JSON.stringify(api.favGet(K)));

  const removed = api.favToggle(K, "PS_B", "字体B");
  check("① 再 toggle 返回 false 表示已取消", removed === false);
  check("① 取消后只剩一个", api.favGet(K).length === 1 && api.favGet(K)[0].v === "PS_A");

  check("① 真的写进了 localStorage（不是只改内存）",
    typeof storage[K] === "string" && storage[K].indexOf("PS_A") >= 0, storage[K]);
}

/* ======================================================== ② 存档容错 */
{
  const { api, storage } = makeEnv();
  const K = "aesub.favFonts";

  storage[K] = "{这不是 JSON";
  check("② 非法 JSON → 当空收藏，不抛异常", api.favGet(K).length === 0);

  storage[K] = '{"a":1}';
  check("② 不是数组 → 当空收藏", api.favGet(K).length === 0);

  storage[K] = '[{"v":"PS_1","t":"好的"},{"no_v":1},{"v":""},{"v":"PS_2"}]';
  const got = api.favGet(K);
  check("② 缺字段 / 空值的元素被丢掉，只留合法的",
    got.length === 2 && got[0].v === "PS_1" && got[1].v === "PS_2",
    JSON.stringify(got));
  check("② 缺显示名时用值兜底", (() => {
    storage[K] = '[{"v":"PS_X"}]';
    return api.favGet(K)[0].t === "PS_X";
  })());
}

/* ======================================================== ③ 关键词过滤 */
{
  const { api } = makeEnv();
  const K = "aesub.favPresets";
  api.favToggle(K, "C:/p/飞入.ffx", "飞入");
  api.favToggle(K, "C:/p/打字机.ffx", "打字机");

  check("③ 空关键词返回全部", api.favFilter(K, "").length === 2);
  check("③ 按显示名过滤（中文）",
    api.favFilter(K, "打字").length === 1 && api.favFilter(K, "打字")[0].t === "打字机");
  check("③ 按值（路径）也能过滤", api.favFilter(K, "飞入.ffx").length === 1);
  check("③ 大小写不敏感", api.favFilter(K, "FFX").length === 2);
  check("③ 没有匹配时返回空数组（不是 undefined）",
    Array.isArray(api.favFilter(K, "zzz")) && api.favFilter(K, "zzz").length === 0);

  const map = api.favValueMap(api.favGet(K));
  check("③ favValueMap 能直接命中已收藏的值", map["C:/p/飞入.ffx"] === 1 && !map["别的"]);
}

/* ============================== ④ 字体下拉：收藏置顶 + 去重 + 无命中文案 */
{
  const { api, els, sandbox, fontSelect } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };
  api.favToggle("aesub.favFonts", "PS_A", "字体A");

  api.renderFontOptions(fontRes([F("字体A", "PS_A"), F("字体B", "PS_B")], ""));

  const opts = optsOf(fontSelect);
  const groups = fontSelect.children.map((c) => c.label || "(直接option)");
  check("④ 第一组是「★ 收藏的字体」", groups[0] === "★ 收藏的字体", groups.join(" | "));
  check("④ 收藏项在最前面且带 ★ 前缀",
    opts[0].value === "PS_A" && opts[0].text === "★ 字体A", JSON.stringify(opts[0]));
  check("④ 已收藏的字体不在下面的搜索结果里重复出现（去重）",
    opts.filter((o) => o.value === "PS_A").length === 1,
    JSON.stringify(opts.map((o) => o.value)));
  check("④ 未收藏的字体照常列出", opts.some((o) => o.value === "PS_B"));
  check("④ 计数里说明了收藏数", els.fontCount.textContent.indexOf("已收藏 1 个") >= 0,
    els.fontCount.textContent);

  // 搜索词只匹配搜索结果是空的场景
  api.renderFontOptions(fontRes([], "zzz"));
  const opts2 = optsOf(fontSelect);
  check("④ 搜索无命中：收藏也不匹配时不显示收藏组",
    !opts2.some((o) => o.group === "★ 收藏的字体"), JSON.stringify(opts2));
  check("④ 搜索无命中：给出「没有匹配」提示",
    opts2.some((o) => o.text.indexOf("没有匹配的字体") >= 0), JSON.stringify(opts2));

  // 搜索词匹配收藏项本身
  api.renderFontOptions(fontRes([], "字体A"));
  const opts3 = optsOf(fontSelect);
  check("④ 命中收藏项时，收藏组里能看到它",
    opts3.some((o) => o.group === "★ 收藏的字体" && o.value === "PS_A"));
  check("④ 此时提示改成「除收藏之外没有其他匹配」",
    opts3.some((o) => o.text.indexOf("除收藏之外没有其他匹配") >= 0), JSON.stringify(opts3));
}

/* ============================================ ⑤ 预设下拉：收藏置顶 + 去重 */
{
  const { api, els, sandbox, presetSelect } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };
  api.favToggle("aesub.favPresets", "C:/p/飞入.ffx", "飞入");

  sandbox.state = {
    presetQuery: "",
    presets: {
      builtinDir: "C:/ae", userDir: null,
      builtin: [
        { name: "飞入", cat: "Animate In", path: "C:/p/飞入.ffx" },
        { name: "打字机", cat: "Animate In", path: "C:/p/打字机.ffx" }
      ],
      user: []
    }
  };
  api.setState(sandbox.state);
  api.renderPresetOptions();

  const opts = optsOf(presetSelect);
  check("⑤ 第一项是「不使用预设」", opts[0].value === "" && opts[0].text === "不使用预设",
    JSON.stringify(opts[0]));
  const groups = presetSelect.children.map((c) => c.label || c.textContent);
  check("⑤ 「★ 收藏的预设」排在「AE 自带文字预设」之前",
    groups.indexOf("★ 收藏的预设") >= 0 &&
    groups.indexOf("★ 收藏的预设") < groups.indexOf("AE 自带文字预设"),
    groups.join(" | "));
  check("⑤ 收藏的预设带 ★ 前缀且排在最上面",
    opts.some((o) => o.group === "★ 收藏的预设" && o.text === "★ 飞入"),
    JSON.stringify(opts));
  check("⑤ 已收藏的预设不在自带组里重复出现（去重）",
    opts.filter((o) => o.value === "C:/p/飞入.ffx").length === 1,
    JSON.stringify(opts.map((o) => o.value)));
  check("⑤ 未收藏的预设照常列出",
    opts.some((o) => o.value === "C:/p/打字机.ffx"));
  check("⑤ 提示里报出收藏数",
    els.presetHint.textContent.indexOf("已收藏 1 个") >= 0, els.presetHint.textContent);
}

/* ======================================================== ⑥ 星标按钮状态 */
{
  const { api, els, sandbox, fontSelect, presetSelect } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };

  fontSelect.value = "";
  api.syncFavFont();
  check("⑥ 没选中字体时按钮禁用且是空心 ☆",
    els.btnFavFont.disabled === true && els.btnFavFont.textContent === "☆",
    els.btnFavFont.textContent);

  fontSelect.value = "PS_A";
  api.syncFavFont();
  check("⑥ 选中未收藏的字体 → 空心、可用",
    els.btnFavFont.disabled === false && els.btnFavFont.textContent === "☆" &&
    els.btnFavFont.classList.contains("on") === false);

  api.favToggle("aesub.favFonts", "PS_A", "字体A");
  api.syncFavFont();
  check("⑥ 选中已收藏的字体 → 实心 ★ 且点亮",
    els.btnFavFont.textContent === "★" && els.btnFavFont.classList.contains("on") === true);
  check("⑥ 已收藏时 title 里提示可取消收藏",
    els.btnFavFont.title.indexOf("取消收藏") >= 0, els.btnFavFont.title);

  presetSelect.value = "C:/p/飞入.ffx";
  api.favToggle("aesub.favPresets", "C:/p/飞入.ffx", "飞入");
  api.syncFavPreset();
  check("⑥ 预设星标同理（★ + 点亮）",
    els.btnFavPreset.textContent === "★" && els.btnFavPreset.classList.contains("on") === true);

  // selectedLabel：从带 ★ 前缀的显示名里取回干净的名字
  const o = mkNode("option");
  o.textContent = "★ 字体A";
  o.value = "PS_A";
  fontSelect.children = [o];
  fontSelect._opts = [o];
  fontSelect.selectedIndex = 0;
  check("⑥ selectedLabel 会剥掉 ★ 前缀", api.selectedLabel(fontSelect) === "字体A",
    api.selectedLabel(fontSelect));
}

/* =========================================================== ⑦ 页面切换动画 */
{
  const { api, sandbox, pages, ctl } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };

  api.showPage("sub");
  check("⑦ 进二级页：该页被点亮",
    pages.pageStyle.classList.contains("on") && !pages.pageHome.classList.contains("on"));
  check("⑦ 进二级页用的是 pgIn 动画",
    String(pages.pageStyle.style.animation).indexOf("pgIn") >= 0,
    pages.pageStyle.style.animation);
  check("⑦ 动画时长写进去了（.19s）",
    String(pages.pageStyle.style.animation).indexOf(".19s") >= 0,
    pages.pageStyle.style.animation);

  api.showPage("work");
  check("⑦ 回工作台：换页方向相反（pgBack）",
    String(pages.pageHome.style.animation).indexOf("pgBack") >= 0,
    pages.pageHome.style.animation);
  check("⑦ 每次切页都调用了 scrollTo(0,0)", (ctl.scrolled || 0) === 2, ctl.scrolled);

  // 连续切同一页也要能重播（靠「先清 none 再设」）
  api.showPage("sub");
  const anim = String(pages.pageStyle.style.animation);
  check("⑦ 再次进入仍会重设动画（不是残留上一次的值）",
    anim.indexOf("pgIn") >= 0 && anim.indexOf("none") < 0, anim);

  api.showPage("不存在的页");
  check("⑦ 未知页名回落到工作台", pages.pageHome.classList.contains("on"));
}

/* ====================================== ⑧ 拼音搜索（字体挑选 + 预设过滤） */
{
  const { api, els, sandbox, presetSelect } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };

  check("⑧ 沙箱里拿到了真实拼音表", sandbox.AesubPy && sandbox.AesubPy.size() > 20000,
    sandbox.AesubPy ? String(sandbox.AesubPy.size()) : "缺失");

  // ---- 字体：按拼音 / 首字母挑（与 AE 返回的结构一致）----
  const fams = [
    { family: "RuiZi-AoYun", nativeName: "锐字奥运精神拼搏简",
      styles: [{ ps: "RuiZiAoYun-Jian", style: "Regular" }] },
    { family: "SourceHanSansSC", nativeName: "思源黑体",
      styles: [{ ps: "SourceHanSansSC-Regular", style: "Regular" }] },
    { family: "STXingkai", nativeName: "华文行楷",
      styles: [{ ps: "STXingkai", style: "Regular" }] },
    { family: "SimHei", styles: [{ ps: "SimHei", style: "Regular" }] }
  ];
  const pick = (q) => api.pickFontsByQuery(fams, q, 120);

  check("⑧ 全拼 ruizi 命中「锐字」", pick("ruizi").matched === 1 &&
    api.fontLabelOf(pick("ruizi").list[0]) === "锐字奥运精神拼搏简",
    JSON.stringify(pick("ruizi").list.map((f) => api.fontLabelOf(f))));
  check("⑧ 首字母 rz 也命中「锐字」", pick("rz").matched === 1);
  check("⑧ 全拼 siyuan 命中「思源黑体」",
    api.fontLabelOf(pick("siyuan").list[0]) === "思源黑体");
  check("⑧ 英文名照旧能搜（simhei）", pick("simhei").list[0].family === "SimHei");
  check("⑧ 中文关键词不走拼音这条路（交给 AE 侧搜）",
    sandbox.AesubPy.isAsciiQuery("锐字") === false);
  check("⑧ limit 生效：命中多个但只回 1 个",
    pick("s").matched > 1 && api.pickFontsByQuery(fams, "s", 1).list.length === 1,
    pick("s").matched + " 命中 / limit1 时回 " + api.pickFontsByQuery(fams, "s", 1).list.length);
  check("⑧ 打错不命中", pick("qqqq").matched === 0);

  // ---- 预设：拼音参与过滤（原来只认字面）----
  sandbox.state = {
    presetQuery: "dzj",
    presets: {
      builtinDir: "C:/ae", userDir: null,
      builtin: [
        { name: "打字机", cat: "Animate In", path: "C:/p/1.ffx" },
        { name: "飞入", cat: "Animate In", path: "C:/p/2.ffx" }
      ],
      user: []
    }
  };
  api.setState(sandbox.state);
  api.renderPresetOptions();
  let pops = optsOf(presetSelect);
  check("⑧ 预设：首字母 dzj 命中「打字机」",
    pops.some((o) => o.value === "C:/p/1.ffx"), JSON.stringify(pops.map((o) => o.text)));
  check("⑧ 预设：dzj 不会顺手带出「飞入」",
    !pops.some((o) => o.value === "C:/p/2.ffx"), JSON.stringify(pops.map((o) => o.text)));

  sandbox.state.presetQuery = "daziji";
  api.setState(sandbox.state);
  api.renderPresetOptions();
  pops = optsOf(presetSelect);
  check("⑧ 预设：全拼 daziji 也命中", pops.some((o) => o.value === "C:/p/1.ffx"));

  sandbox.state.presetQuery = "xyz";
  api.setState(sandbox.state);
  api.renderPresetOptions();
  pops = optsOf(presetSelect);
  check("⑧ 预设：无命中时只给提示、不误列预设",
    !pops.some((o) => o.value) &&
    els.presetHint.textContent.indexOf("拼音") >= 0,
    els.presetHint.textContent.slice(0, 70));
}

/* ============== ⑨ 拼音搜索的取数路径（要等 Promise，故放在最后） */
{
  const { api, sandbox, fontSelect, els } = makeEnv();
  sandbox.LS = { favFonts: "aesub.favFonts", favPresets: "aesub.favPresets" };

  const INDEX = [
    { family: "RuiZi-AoYun", nativeName: "锐字奥运精神拼搏简",
      styles: [{ ps: "RuiZiAoYun-Jian", style: "Regular" }] },
    { family: "SourceHanSansSC", nativeName: "思源黑体",
      styles: [{ ps: "SourceHanSansSC-Regular", style: "Regular" }] }
  ];
  const calls = [];
  let fullOk = true;

  sandbox.AeApi = {
    searchFonts(q, limit) {
      calls.push({ q: q, limit: limit });
      if (q === "") {
        if (!fullOk) {
          return Promise.resolve({ ok: true, data: { available: true, ready: false,
            families: [], totalFamilies: 0, matched: 0, returned: 0, query: "" } });
        }
        return Promise.resolve({ ok: true, data: { available: true, ready: true,
          families: INDEX, totalFamilies: INDEX.length, matched: 0,
          returned: INDEX.length, query: "" } });
      }
      return Promise.resolve({ ok: true, data: { available: true, ready: true,
        families: [], totalFamilies: INDEX.length, matched: 0, returned: 0, query: q } });
    }
  };
  sandbox.state = { fontIndex: null };
  api.setState(sandbox.state);

  PENDING_ASYNC = (async function () {
    // ---- ① 打拼音：先拉一次全量，再在面板里过滤 ----
    await api.searchFonts("rz");
    check("⑨ 拼音模式先向 AE 要「全量清单」（q 为空、limit=4000）",
      calls.length === 1 && calls[0].q === "" && calls[0].limit === 4000,
      JSON.stringify(calls));
    check("⑨ 全量清单存进了 state.fontIndex（下次不再往返 AE）",
      (sandbox.state.fontIndex || []).length === INDEX.length);
    let opts = optsOf(fontSelect);
    check("⑨ 下拉里只剩命中的那个字体（锐字…）",
      opts.length === 1 && opts[0].value === "RuiZiAoYun-Jian",
      JSON.stringify(opts.map((o) => o.value)));
    check("⑨ 计数文案标出「按拼音匹配」（用户才知道自己打的是拼音）",
      els.fontCount.textContent.indexOf("按拼音匹配") >= 0, els.fontCount.textContent);

    // ---- ② 再打一次：命中缓存，不再问 AE ----
    await api.searchFonts("siyuan");
    check("⑨ 第二次输入不再往返 AE（复用缓存）", calls.length === 1, JSON.stringify(calls));
    opts = optsOf(fontSelect);
    check("⑨ 第二次能筛出「思源黑体」", opts.length === 1 && opts[0].value === "SourceHanSansSC-Regular",
      JSON.stringify(opts.map((o) => o.value)));

    // ---- ③ 打中文：照旧交给 AE 侧搜（那条路本来就好用）----
    await api.searchFonts("锐字");
    check("⑨ 中文关键词走 AE 侧搜索（limit 仍是 120）",
      calls.length === 2 && calls[1].q === "锐字" && calls[1].limit === 120,
      JSON.stringify(calls));

    // ---- ④ 全量拿不到（AE 字体服务没就绪）→ 退回按名称搜，不能让用户白打 ----
    sandbox.state.fontIndex = null;
    fullOk = false;
    calls.length = 0;
    await api.searchFonts("rz");
    check("⑨ 全量拿不到时退回 AE 侧搜索", calls.length === 2 && calls[1].q === "rz",
      JSON.stringify(calls));
    check("⑨ 退回时用的是普通 limit（120）", calls[1].limit === 120, String(calls[1].limit));
  })();
}

/* ------------------------------------------------------------ 汇总（等第 ⑨ 节跑完）*/
Promise.resolve(PENDING_ASYNC).then(function () {
  console.log(results.join("\n"));
  console.log("\n  通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.log(results.join("\n"));
  console.log("\n  第 ⑨ 节抛异常：" + (e && e.stack ? e.stack : e));
  console.log("FAILED|" + (fail + 1));
  process.exit(1);
});
