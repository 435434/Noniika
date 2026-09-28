/**
 * 面板「字幕体检」的真函数沙箱测试（不需要 AE）
 * ==========================================================
 * 把 cep/js/main.js 里的 json2 / sameFileBytes / cleanupProbeFiles / checkSubLayers
 * 原样抠出来，在 Node 沙箱里配桩运行，覆盖四条分支：
 *   ① 填充 alpha=0 + 字体解析不到      → 必须点名
 *   ② 渲染两帧完全相同                 → 判「对画面零贡献」
 *   ③ 渲染两帧不同                     → 判「确实画了内容」
 *   ④ 文字动画器把不透明度压到 0        → 必须点名
 * 目的是抓住引用错误（例如曾经踩过的 row is not defined）与分支逻辑错误。
 *
 * 用法： node test/panel-subcheck-test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "cep", "js", "main.js"), "utf8")
  .split(/\r?\n/);

/** 抠出一个顶层（缩进 2 空格）的函数体：从 function X( 到其后第一个 "  }" */
function slice(name) {
  const start = src.findIndex((l) => l.includes("function " + name + "("));
  if (start < 0) throw new Error("找不到函数 " + name);
  for (let i = start + 1; i < src.length; i++) {
    if (src[i].replace(/\s+$/, "") === "  }") return src.slice(start, i + 1).join("\n");
  }
  throw new Error("找不到 " + name + " 的结束行");
}

const code = [
  slice("json2"),
  slice("sameFileBytes"),
  slice("cleanupProbeFiles"),
  slice("checkSubLayers"),
  slice("fixPresetKeys"),
  "globalThis.__check = checkSubLayers;",
  "globalThis.__fix = fixPresetKeys;"
].join("\n\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aesub-panel-"));

function makeSandbox(payload, probeFiles, fixData) {
  const logs = [];
  const el = { logBox: {}, subCheckOut: { innerHTML: "" } };
  const sandbox = {
    CepBridge: { available: () => true },
    state: { sel: { ready: true, compName: "合成 1" } },
    setStatus: (t, k) => logs.push("[status] " + t + (k ? " (" + k + ")" : "")),
    log: (m) => logs.push(String(m)),
    el: el,
    AeApi: {
      checkSubtitleLayers: () => Promise.resolve({ ok: true, data: payload }),
      probeSubtitleRender: () =>
        Promise.resolve({ ok: true, data: Object.assign({ layer: "x", time: 45.92, ms: 9000 }, probeFiles) }),
      fixPresetKeyTimes: () => Promise.resolve({
        ok: true,
        data: fixData || { scanned: 0, fixed: 0, skipped: 0, movedKeys: 0, samples: [] }
      })
    },
    fmtSec: (n) => Number(n || 0).toFixed(2),
    node: { fs: fs, crypto: require("crypto") },
    JSON: JSON, Math: Math, Date: Date, String: String, Number: Number,
    Array: Array, Promise: Promise, setTimeout: setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, el: el, logs: logs };
}

async function runScenario(payload, probeFiles) {
  const s = makeSandbox(payload, probeFiles);
  await vm.runInContext("__check()", s.sandbox);
  return s;
}

/** 单独跑修复函数（它有自己的返回值桩） */
async function runFixScenario(fixData) {
  const s = makeSandbox(payload({}), { pngOn: "", pngOff: "", sizeOn: -1, sizeOff: -1 }, fixData);
  await vm.runInContext("__fix()", s.sandbox);
  return s;
}

async function runCheckOnly(payload2, probeFiles) {
  const s = makeSandbox(payload2, probeFiles);
  await vm.runInContext("__check()", s.sandbox);
  return s;
}

const BASE_SAMPLE = {
  index: 1, name: "我们今天所做的一切", text: "我们今天所做的一切",
  opacity: 100, inPoint: 45.0, outPoint: 46.84,
  pos: [960, 403], anchor: [-2, -27], textBox: [0, 0, 100, 50], frameBox: [900, 380, 100, 50],
  centerX: 960, centerY: 403, offscreen: false,
  font: "REEJI-PinboGB-Flash", fontSize: 77,
  fillEnabled: true, fill: [1, 1, 1], fontAvailable: true,
  occludedBy: null, animators: 0, animatorDetail: [], animOpacityLow: 0,
  effects: 0, effectNames: [], opacityExpression: null,
  blend: "BlendingMode.NORMAL", preserveTransparency: false, trackMatte: null
};

function payload(over) {
  const base = {
    compName: "合成 1", compWidth: 1920, compHeight: 806, totalLayers: 18, textLayers: 14,
    emptyText: 0, hidden: 0, transparent: 0, zeroLength: 0,
    occluded: 0, offscreen: 0, noFill: 0, zeroAlpha: 0, fontUnavailable: 0,
    opacityExpressions: 0, occluders: [], samples: []
  };
  base.samples = [Object.assign({}, BASE_SAMPLE, over || {})];
  return base;
}

const results = [];
function check(label, cond, extra) {
  results.push({ label: label, pass: !!cond, extra: extra || "" });
}
function tmpFile(name, content) {
  const p = path.join(tmp, name);
  if (content !== null && content !== undefined) fs.writeFileSync(p, Buffer.from(content));
  return p;
}

(async function main() {
  /* ---------- ① 填充透明 + 字体不可用 + 渲染帧没落盘 ---------- */
  {
    const s = await runScenario(
      payload({ fill: [1, 1, 1, 0], fontAvailable: false }),
      { pngOn: tmpFile("a-on.png", null), pngOff: tmpFile("a-off.png", null), sizeOn: -1, sizeOff: -1 }
    );
    const all = s.logs.join("\n");
    check("① 点名『填充透明度是 0』", s.el.subCheckOut.innerHTML.indexOf("填充色的透明度是 0") >= 0);
    check("① 点名『字体解析不到』",
      s.el.subCheckOut.innerHTML.indexOf("字体在 AE 里解析不到") >= 0 &&
      all.indexOf("字体列表里解析不到") >= 0);
    check("① 渲染帧缺失有提示", all.indexOf("没落盘") >= 0);
    check("① 结论行有输出", s.el.subCheckOut.innerHTML.length > 0);
    check("① 无引用错误", all.indexOf("is not defined") < 0,
      all.split("\n").filter((l) => l.indexOf("not defined") >= 0)[0] || "");
  }

  /* ---------- ② 属性干净 + 两帧完全相同 → 零贡献 ---------- */
  {
    const s = await runScenario(
      payload({}),
      { pngOn: tmpFile("same-on.png", "identical-bytes"), pngOff: tmpFile("same-off.png", "identical-bytes"),
        sizeOn: 15, sizeOff: 15 }
    );
    const all = s.logs.join("\n");
    check("② 判为零贡献", all.indexOf("根本没往画面画东西") >= 0);
    check("② 结论行含『零贡献』", s.el.subCheckOut.innerHTML.indexOf("零贡献") >= 0);
    check("② 无引用错误", all.indexOf("is not defined") < 0);
  }

  /* ---------- ③ 属性干净 + 两帧不同 → 确实画了内容 ---------- */
  {
    const s = await runScenario(
      payload({}),
      { pngOn: tmpFile("diff-on.png", "frame-with-text"), pngOff: tmpFile("diff-off.png", "frame-without-text-"),
        sizeOn: 15, sizeOff: 19 }
    );
    const all = s.logs.join("\n");
    check("③ 判为确实画了内容",
      all.indexOf("两张渲染帧不同") >= 0 &&
      s.el.subCheckOut.innerHTML.indexOf("确实在画面上画了内容") >= 0);
    check("③ 结论行正常", s.el.subCheckOut.innerHTML.indexOf("确实在画面上画了内容") >= 0);
    check("③ 无引用错误", all.indexOf("is not defined") < 0);
  }

  /* ---------- ④ 动画器把不透明度压到 0 ---------- */
  {
    const s = await runScenario(
      payload({ animators: 1, animOpacityLow: 1, animatorDetail: [{ name: "Animator 1", props: ["Opacity=0"] }] }),
      { pngOn: tmpFile("an-on.png", "x"), pngOff: tmpFile("an-off.png", "y"), sizeOn: 1, sizeOff: 1 }
    );
    const all = s.logs.join("\n");
    check("④ 点名动画器压到 0", all.indexOf("文字动画器里有 1 个不透明度属性小于 0.5") >= 0);
    check("④ 无引用错误", all.indexOf("is not defined") < 0);
  }

  /* ---------- ⑥ 有图层开了独奏 → 必须报最重的结论 ---------- */
  {
    const p6 = payload({});
    p6.soloLayers = 1;
    p6.soloNames = [{ name: "素材二.mp4", index: 15 }];
    const s6 = await runScenario(p6,
      { pngOn: tmpFile("solo-on.png", "aaa"), pngOff: tmpFile("solo-off.png", "bbb"), sizeOn: 3, sizeOff: 3 });
    const all6 = s6.logs.join("\n");
    check("⑥ 点名独奏", all6.indexOf("合成里有图层开了独奏") >= 0);
    check("⑥ 结论行含独奏", s6.el.subCheckOut.innerHTML.indexOf("独奏") >= 0);
    check("⑥ 无引用错误", all6.indexOf("is not defined") < 0);
  }

  /* ---------- ⑦ 两帧留档：必须把路径打出来，且不删文件 ---------- */
  {
    const on = tmpFile("keep-on.png", "frame-with-text-pixels");
    const off = tmpFile("keep-off.png", "frame-without-text-pix");
    const s7 = await runScenario(payload({}), { pngOn: on, pngOff: off, sizeOn: 23, sizeOff: 25, kept: true });
    const all7 = s7.logs.join(String.fromCharCode(10));
    check("⑦ 打出留档路径", all7.indexOf("两帧已留档") >= 0 && all7.indexOf("keep-on.png") >= 0);
    check("⑦ 留档时未删文件", fs.existsSync(on) && fs.existsSync(off));
    check("⑦ 无引用错误", all7.indexOf("is not defined") < 0);
  }

  /* ---------- ⑧ 混合模式：5212=正常 不该报，5240 该报 ---------- */
  {
    const on = tmpFile("bl-on.png", "aaa"), off = tmpFile("bl-off.png", "bbb");
    const s8a = await runScenario(payload({ blend: 5212 }), { pngOn: on, pngOff: off, sizeOn: 3, sizeOff: 3 });
    check("⑧ 正常模式不误报", s8a.logs.join(String.fromCharCode(10)).indexOf("混合模式不是") < 0);
    const s8b = await runScenario(payload({ blend: 5240 }), { pngOn: on, pngOff: off, sizeOn: 3, sizeOff: 3 });
    check("⑧ 异常模式被点名", s8b.logs.join(String.fromCharCode(10)).indexOf("混合模式不是") >= 0);
    check("⑧ 无引用错误", s8b.logs.join(String.fromCharCode(10)).indexOf("is not defined") < 0);
  }

  /* ---------- ⑨ 动画器不透明度值要打出来 ---------- */
  {
    const on = tmpFile("ao-on.png", "x"), off = tmpFile("ao-off.png", "y");
    const s9 = await runScenario(
      payload({ animators: 1, animOpacityVals: ["不透明度=0"],
                animatorDetail: [{ name: "动画 1", props: ["选择器", "属性/不透明度=0"] }] }),
      { pngOn: on, pngOff: off, sizeOn: 1, sizeOff: 1 });
    check("⑨ 打出动画器不透明度", s9.logs.join(String.fromCharCode(10)).indexOf("动画器里的不透明度值") >= 0);
    check("⑨ 无引用错误", s9.logs.join(String.fromCharCode(10)).indexOf("is not defined") < 0);
  }

  /* ---------- ⑪ 动画跨度诊断：正常要对齐，错位要告警 ---------- */
  {
    const on = tmpFile("ks-on.png", "aaa"), off = tmpFile("ks-off.png", "bbb");
    const ok = await runScenario(
      payload({ keySpan: 2.0, layerDur: 5.0, keyFirst: 7.82, inPoint: 7.82, outPoint: 12.82 }),
      { pngOn: on, pngOff: off, sizeOn: 3, sizeOff: 3 });
    const logOk = ok.logs.join(String.fromCharCode(10));
    check("⑪ 打出动画跨度/本句时长", logOk.indexOf("动画关键帧跨度 2.00 秒 / 本句时长 5.00 秒") >= 0);
    check("⑪ 正常时不告警", logOk.indexOf("动画关键帧不在本句时间范围内") < 0);

    const badRun = await runScenario(
      payload({ keySpan: 2.0, layerDur: 1.4, keyFirst: 52.8, inPoint: 7.82, outPoint: 9.22 }),
      { pngOn: on, pngOff: off, sizeOn: 3, sizeOff: 3 });
    const logBad = badRun.logs.join(String.fromCharCode(10));
    check("⑪ 关键帧错位时告警", logBad.indexOf("动画关键帧不在本句时间范围内") >= 0);
    check("⑪ 无引用错误", logBad.indexOf("is not defined") < 0,
      logBad.split(String.fromCharCode(10)).filter((l) => l.indexOf("not defined") >= 0)[0] || "");
  }

  /* ---------- ⑤ 边界：合成里没有文本图层 ---------- */
  {
    const p = payload({});
    p.textLayers = 0; p.samples = [];
    const s = await runScenario(p, { pngOn: "", pngOff: "", sizeOn: -1, sizeOff: -1 });
    const all = s.logs.join("\n");
    check("⑤ 无文本层有明确提示", s.el.subCheckOut.innerHTML.indexOf("这个合成里没有文本图层") >= 0);
    check("⑤ 无引用错误", all.indexOf("is not defined") < 0);
  }

  /* ---------- ⑩ 修复关键帧：日志与样例都要打出来 ---------- */
  {
    const sF = await runFixScenario({
      compName: "合成 1", scanned: 15, fixed: 12, skipped: 3, movedKeys: 48,
      samples: [{ name: "胜利了 4", from: 52.8, to: 7.82 }]
    });
    const allF = sF.logs.join(String.fromCharCode(10));
    check("⑩ 报出扫描/修复数量", allF.indexOf("扫描文本图层 15 个") >= 0 && allF.indexOf("修复 12 个") >= 0);
    check("⑩ 报出样例搬运细节", allF.indexOf("胜利了 4") >= 0 && allF.indexOf("搬到第") >= 0);
    check("⑩ 提示可撤销", allF.indexOf("Ctrl+Z") >= 0);
    check("⑩ 无引用错误", allF.indexOf("is not defined") < 0,
      allF.split(String.fromCharCode(10)).filter((l) => l.indexOf("not defined") >= 0)[0] || "");
  }

  const bad = results.filter((r) => !r.pass);
  console.log("\n=== 面板体检沙箱测试 ===");
  results.forEach((r) => console.log((r.pass ? "  ✅ " : "  ❌ ") + r.label + (r.pass ? "" : "   " + r.extra)));
  console.log("\n  通过 " + (results.length - bad.length) + " / " + results.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  process.exit(bad.length ? 1 : 0);
})();
