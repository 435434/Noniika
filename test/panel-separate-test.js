/**
 * 面板「分离人声」按钮（runSeparateOnly）的沙箱测试
 * ==========================================================
 * 把 cep/js/main.js 里的 runSeparateOnly 原样抠出来，配桩运行，覆盖：
 *   ① 分离环境没装        → 明确提示、什么都不做
 *   ② 选中的已是人声层    → 停下，不重复分离
 *   ③ 视频源             → 不弹落轨窗，自动「关声音 + 放它下方」
 *   ④ 音频源             → 弹落轨窗
 *   ⑤ 同名产物点取消      → 不跑流水线
 *   ⑥ 跑完选「先不用」    → 不调 run()，日志说明没上传
 *   ⑦ 跑完选「接着识别」  → state.resume 正确、调用 run()
 *   ⑧ 参数：只分离（带 --separate-only，不带任何识别相关参数）
 * 重点抓「删错/跑错/该停没停」这类逻辑错误，以及引用错误。
 *
 * 用法： node test/panel-separate-test.js
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

const code = [
  slice("runSeparateOnly"),
  "globalThis.__go = runSeparateOnly;"
].join("\n\n");

function mkEl() {
  return {
    innerHTML: "", textContent: "", value: "", checked: false, disabled: false,
    style: {}, open: false, addEventListener() { }, removeEventListener() { }
  };
}

function makeOpts(o) {
  const logs = [];
  const calls = { pipeline: null, placed: 0, run: 0, exportAudio: 0, selection: 0 };
  const el = {
    logBox: mkEl(), resultCard: mkEl(), resultTip: mkEl(), resultInfo: mkEl(),
    btnProbe: mkEl(), btnOpenOut: mkEl(), pipelineDir: { value: "C:/proj/pipeline" }
  };
  const state = {
    running: false,
    env: { problems: [] },
    uvr: o.uvr || { installed: true, pythonOk: true },
    resume: null,
    lastPlaced: null,
    lastOutDir: null,
    midAudio: null,
    selSig: "x"
  };
  const sandbox = {
    state: state,
    el: el,
    saveSettings() { },
    collectParams: () => o.params || {
      outDir: "C:/out", pipelineDir: "C:/proj/pipeline", nodePath: "node",
      separateTarget: "vocals", separateTargetLabel: "仅人声",
      separateModel: "Kim_Vocal_2.onnx", separateFormat: "WAV",
      separatePython: "C:/venv/python.exe", separateKeep: false,
      limitSec: 0, createLayers: true
    },
    log: (m, k) => logs.push((k ? "[" + k + "] " : "") + String(m)),
    setStatus: (t, k) => logs.push("[status] " + t + (k ? " (" + k + ")" : "")),
    setProgress() { }, clearLog() { }, updateRunButton() { },
    AeApi: {
      getTimelineSelection: () => { calls.selection++; return Promise.resolve({ ok: true, data: o.sel }); },
      exportAudio: () => {
        calls.exportAudio++;
        return Promise.resolve({ ok: true, data: { file: "C:/out/_中间音频/x.wav", offsetSec: 0, format: "wav", durationSec: 4, bytes: 100 } });
      }
    },
    baseStemFromLayer: () => "无上光荣",
    existingArtifacts: () => (o.hits || []),
    nextFreeStem: (d, s) => s + " 2",
    // v0.9.0 起弹窗有「复用已有人声」选项，主流程会先问这个函数有没有可复用的文件
    reusableVocalsPath: () => "C:/out/_人声分离/无上光荣_人声.wav",
    askOverwrite: () => Promise.resolve(o.overwriteChoice || "overwrite"),
    askReplaceMode: () => Promise.resolve(o.replaceChoice === undefined ? "below" : o.replaceChoice),
    midAudioPath: () => "C:/out/_中间音频/x.wav",
    runPipeline: (np, args) => {
      calls.pipeline = args;
      return Promise.resolve({ ok: true, separate: o.sep || {
        vocabless: true, vocals: "C:/out/_人声分离/无上光荣_人声.wav",
        chosen: "C:/out/_人声分离/无上光荣_人声.wav", instrumental: null,
        elapsedSec: 12.5
      } });
    },
    placeVocalsFromPipeline: (r, p, sel) => {
      calls.placed++;
      if (o.placeResult !== null) {
        state.lastPlaced = o.placeResult || { layerName: "无上光荣_人声", layerIndex: 3 };
      }
      return Promise.resolve(null);
    },
    removeMidAudio() { },
    confirmDialog: (cfg) => {
      calls.cfm = cfg;
      return Promise.resolve({ ok: !!o.continueAsr, picked: [], perm: false });
    },
    run: () => { calls.run++; return Promise.resolve(); },
    joinPath: () => Array.prototype.join.call(arguments, "/"),
    // 模型目录统一入口（面板会把它的路径显式传给流水线）
    uvrModelsDir: () => "C:/data/models/uvr",
    fmtSec: (n) => Number(n || 0).toFixed(2),
    fmtBytes: (n) => n + "B",
    node: { fs: fs, path: path },
    JSON: JSON, Math: Math, Date: Date, String: String, Number: Number,
    Array: Array, Object: Object, Promise: Promise, setTimeout: setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, state: state, el: el, logs: logs, calls: calls };
}

/**
 * 跑一次 runSeparateOnly 并等它整条链跑完。
 *
 * ⚠ 这个函数**不返回** Promise（内部是 `Promise.resolve().then(...)` 语句，末尾没有 return，
 * 与 run() 的写法一致），所以不能直接 await 它的返回值 —— 必须等微任务队列跑空。
 */
async function go(t) {
  vm.runInContext("__go()", t.sandbox);
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 4));
  return t;
}

const SEL_VIDEO = {
  ready: true, compName: "合成 1", sourceLayerName: "无上光荣.mp4", sourceLayerIsVideo: true,
  sourceLayerIsSeparatedVocals: false, selectedLayerCount: 1, audioLayerCount: 1,
  rangeStart: 0, rangeEnd: 4
};
const SEL_AUDIO = Object.assign({}, SEL_VIDEO, {
  sourceLayerName: "伴奏.wav", sourceLayerIsVideo: false
});
const SEL_VOCALS_LAYER = Object.assign({}, SEL_VIDEO, {
  sourceLayerName: "无上光荣_人声", sourceLayerIsSeparatedVocals: true
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}

async function main() {
  /* ① 环境没装 → 什么都不做 */
  {
    const t = makeOpts({ sel: SEL_VIDEO, uvr: { installed: false, pythonOk: true } });
    await go(t);
    const all = t.logs.join("\n");
    check("① 明确提示去装环境", all.indexOf("还没装好") >= 0 && all.indexOf("一键安装环境") >= 0);
    check("① 没有读时间线、没有跑流水线", t.calls.selection === 0 && t.calls.pipeline === null);
  }

  /* ② 选中的已是人声层 */
  {
    const t = makeOpts({ sel: SEL_VOCALS_LAYER });
    await go(t);
    const all = t.logs.join("\n");
    check("② 提示已是人声层并停下", all.indexOf("本身就是干净人声") >= 0);
    check("② 没有跑流水线（不重复分离）", t.calls.pipeline === null);
    check("② 跑完解除 running", t.state.running === false);
  }

  /* ③ 视频源：自动视频模式、不弹落轨窗、参数含 --separate-only */
  {
    const t = makeOpts({ sel: SEL_VIDEO });
    await go(t);
    const args = t.calls.pipeline || [];
    check("③ 视频源自动关声音的说法出现在日志", t.logs.join("\n").indexOf("关掉它的声音开关") >= 0);
    check("③ 参数里有 --separate 与 --separate-only",
      args.indexOf("--separate") >= 0 && args.indexOf("--separate-only") >= 0);
    check("③ 参数里没有识别相关项（--max-chars / --snap-speech / --no-snap-speech）",
      args.indexOf("--max-chars") < 0 && args.indexOf("--snap-speech") < 0 && args.indexOf("--no-snap-speech") < 0,
      args.join(" "));
    check("③ 参数里带了模型与 Python",
      args.indexOf("--separate-model") >= 0 && args.indexOf("--separate-python") >= 0);
    check("③ 产物名用的是素材名", args.indexOf("--name") >= 0 && args[args.indexOf("--name") + 1] === "无上光荣");
    check("③ 落轨被调用一次", t.calls.placed === 1);
    check("③ 结果卡片显示了人声路径", t.el.resultInfo.innerHTML.indexOf("无上光荣_人声.wav") >= 0);
    check("③ 没读到引用错误", t.logs.join("\n").indexOf("is not defined") < 0);
  }

  /* ④ 音频源：弹落轨窗 */
  {
    const t = makeOpts({ sel: SEL_AUDIO, replaceChoice: "below" });
    await go(t);
    check("④ 音频源会问落轨方式（日志有「不替换」说明）",
      t.logs.join("\n").indexOf("不替换") >= 0);
    check("④ 仍然跑成了", t.calls.pipeline !== null);
  }

  /* ⑤ 同名产物点取消 → 不跑流水线 */
  {
    const t = makeOpts({ sel: SEL_VIDEO, hits: ["无上光荣.json"], overwriteChoice: "cancel" });
    await go(t);
    check("⑤ 取消后不跑流水线", t.calls.pipeline === null);
    check("⑤ 取消有明确状态", t.logs.join("\n").indexOf("已取消") >= 0);
    check("⑤ 取消后解除 running", t.state.running === false);
  }

  /* ⑥ 同名产物选覆盖 → 产物名用原名（「另存」选项已按用户要求从弹窗撤掉，
     legacy 的 "rename" 选择在主流程里等同覆盖） */
  {
    const t = makeOpts({ sel: SEL_VIDEO, hits: ["无上光荣.json"], overwriteChoice: "overwrite" });
    await go(t);
    const args = t.calls.pipeline || [];
    check("⑥ 弹窗选覆盖 → --name 用原名", args[args.indexOf("--name") + 1] === "无上光荣",
      String(args[args.indexOf("--name") + 1]));
  }

  /* ⑦ 跑完选「先不用」→ 不调 run() */
  {
    const t = makeOpts({ sel: SEL_VIDEO, continueAsr: false });
    await go(t);
    const all = t.logs.join("\n");
    check("⑦ 追问弹层出现了", !!t.calls.cfm);
    check("⑦ 弹层文案说清「没上传」", t.calls.cfm.bodyHtml.indexOf("没有上传任何音频") >= 0);
    check("⑦ 弹层按钮是「接着识别」+「先不用」",
      t.calls.cfm.okText.indexOf("接着识别") >= 0 && t.calls.cfm.cancelText === "先不用");
    check("⑦ 没调 run()", t.calls.run === 0);
    check("⑦ 没设 resume", t.state.resume === null);
    check("⑦ 日志说明全程没上传", all.indexOf("全程没有上传音频") >= 0);
  }

  /* ⑧ 跑完选「接着识别」→ resume 正确、调用 run() */
  {
    const t = makeOpts({ sel: SEL_VIDEO, continueAsr: true });
    await go(t);
    check("⑧ 调了 run() 一次", t.calls.run === 1);
    check("⑧ resume 指向刚分离出的人声", !!t.state.resume &&
      t.state.resume.asrInput.indexOf("无上光荣_人声.wav") >= 0,
      JSON.stringify(t.state.resume));
    check("⑧ resume 带上了产物名", t.state.resume && t.state.resume.stem === "无上光荣");
    check("⑧ 日志说明不会重复导出/分离", t.logs.join("\n").indexOf("不会重复导出、重复分离") >= 0);
  }

  /* ⑨ 只分离模式不需要「人声分离设置」总开关 */
  {
    const t = makeOpts({ sel: SEL_VIDEO });
    t.sandbox.state.uvrOnIgnored = true;      // 面板的 uvrOn 在 collectParams 里，桩里不体现
    await go(t);
    check("⑨ 未勾选总开关也能跑（不看 uvrOn，只看环境）", t.calls.pipeline !== null);
  }

  /* ⑩ 流水线失败 → 有明确报错 */
  {
    const t = makeOpts({ sel: SEL_VIDEO });
    t.sandbox.runPipeline = () => Promise.resolve({ ok: false, error: "分离失败（退出码 1）" });
    await go(t);
    check("⑩ 流水线失败有明确状态", t.logs.join("\n").indexOf("分离失败") >= 0);
    check("⑩ 失败也解除 running", t.state.running === false);
  }

  console.log(results.join("\n"));
  console.log("\n  通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log(results.join("\n"));
  console.log("\n  ❌ 测试崩溃: " + (e && e.stack ? e.stack : e));
  console.log("FAILED|crash");
  process.exit(1);
});
