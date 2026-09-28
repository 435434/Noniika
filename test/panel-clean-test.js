/**
 * 面板「清理」相关函数的沙箱测试（不需要 AE、不真删任何东西）
 * ==========================================================
 * 把 cep/js/main.js 里的 fmtBytes / cleanPaths / confirmDialog /
 * doFreeMemory / doCleanFiles / doCleanModels 原样抠出来，
 * 配一个极简假 DOM + 桩掉 AeClean，跑这些分支：
 *   ① fmtBytes 各量级
 *   ② 清内存：正常 / 无明显变化 / 失败
 *   ③ 清文件：默认勾选全部 → 只删勾选的组 / 空扫描 / 扫描失败 / perm 选项透传
 *   ④ 清模型：有模型 / 没模型
 * 重点是抓引用错误（踩过 row is not defined）与「删错东西」这类逻辑错误。
 *
 * 用法： node test/panel-clean-test.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
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
  slice("joinPath"),
  slice("fmtBytes"),
  slice("cleanPaths"),
  slice("confirmDialog"),
  slice("doFreeMemory"),
  slice("doCleanFiles"),
  slice("doCleanModels"),
  "globalThis.__free = doFreeMemory;",
  "globalThis.__files = doCleanFiles;",
  "globalThis.__models = doCleanModels;"
].join("\n\n");

/* ------------------------------------------------------------ 极简假 DOM */

function mkBtn() {
  return {
    innerHTML: "", textContent: "", value: "", checked: false, disabled: false,
    style: {},
    _l: {},
    addEventListener(t, f) { this._l[t] = f; },
    removeEventListener(t) { delete this._l[t]; },
    fire(t) { if (this._l[t]) this._l[t](); }
  };
}

/** 能从 innerHTML 里认出 checkbox（HTML 是我们自己生成的，结构可控） */
function mkCfmBody() {
  const el = mkBtn();
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html || ""; },
    set(v) { el._html = String(v); }
  });
  el.querySelector = function (sel) {
    if (sel === "#cleanTotal") return el._total;
    return null;
  };
  el.querySelectorAll = function (sel) {
    if (String(sel).indexOf("checkbox") < 0) return [];
    const out = [];
    const re = /<input type="checkbox" data-key="([^"]+)"([^>]*)>/g;
    let m;
    while ((m = re.exec(el._html || ""))) {
      // ⚠ m 是循环变量，闭包必须先把值抓下来（否则 getAttribute 里拿到的是 null）
      const key = m[1];
      const isChecked = m[2].indexOf("checked") >= 0;
      out.push({
        key: key,
        checked: isChecked,
        getAttribute(n) { return n === "data-key" ? key : null; }
      });
    }
    return out;
  };
  el._total = { innerHTML: "" };
  return el;
}

function makeSandbox(stubs) {
  const logs = [];
  const el = {
    logBox: {},
    maintOut: { innerHTML: "" },
    pipelineDir: { value: "C:/proj/pipeline" },
    outDir: { value: "C:/out" },
    btnFreeMem: mkBtn(),
    btnCleanFiles: mkBtn(),
    btnCleanModels: mkBtn(),
    cfmOverlay: { style: {} },
    cfmTitle: mkBtn(),
    cfmBody: mkCfmBody(),
    cfmPermWrap: { style: {} },
    cfmPerm: { checked: false },
    cfmOk: mkBtn(),
    cfmCancel: mkBtn(),
    cfmHint: { innerHTML: "" }
  };
  const calls = { recycle: [], scanOpts: null, modelsDir: null };
  const sandbox = {
    state: { busyClean: false, running: false },
    node: { os: os, path: path },
    // 模型目录现在统一走这个入口（面板显式传给流水线，保证下载与使用是同一处）
    uvrModelsDir: () => (stubs.uvrModelsDir || "C:/data/models/uvr"),
    AeClean: {
      available: () => true,
      scan: stubs.scan,
      scanModels: (d) => { calls.modelsDir = d; return stubs.scanModels(); },
      freeMemory: stubs.freeMemory,
      recycle: (items, opts) => { calls.recycle.push({ items: items, opts: opts }); return stubs.recycle(items, opts); }
    },
    log: (m, k) => logs.push(String(m)),
    setStatus: (t, k) => logs.push("[status] " + t + (k ? " (" + k + ")" : "")),
    el: el,
    JSON: JSON, Math: Math, Date: Date, String: String, Number: Number,
    Array: Array, Object: Object, Promise: Promise, setTimeout: setTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, el: el, logs: logs, calls: calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? ("  → " + extra) : "")); }
}

/* ------------------------------------------------------------ 造数据 */

function groupsFixture() {
  return [
    { key: "mid", label: "中间音频", note: "n", defaultOn: true, items: [{ path: "C:/out/_中间音频", dir: true, size: 300000000 }], bytes: 300000000, count: 3 },
    { key: "sep", label: "人声分离产物", note: "n", defaultOn: true, items: [{ path: "C:/out/_人声分离", dir: true, size: 1200000000 }], bytes: 1200000000, count: 5 },
    { key: "temp", label: "系统临时文件", note: "n", defaultOn: true, items: [{ path: "C:/t/aesub-1.png", dir: false, size: 400000 }], bytes: 400000, count: 11 },
    { key: "subs", label: "字幕成品文件", note: "n", defaultOn: false, items: [{ path: "C:/out/a.srt", dir: false, size: 2000 }], bytes: 2000, count: 2 },
    { key: "models", label: "识别模型", note: "n", defaultOn: false, locked: true, items: [], bytes: 900000000, count: 2 }
  ];
}

async function main() {
  /* ---------- ① fmtBytes ---------- */
  {
    const s = makeSandbox({});
    const f = vm.runInContext("fmtBytes", s.sandbox);
    check("① 512 → 512 B", f(512) === "512 B", f(512));
    check("① 2048 → 2.0 KB", f(2048) === "2.0 KB", f(2048));
    check("① 5 MB", f(5 * 1048576) === "5.0 MB", f(5 * 1048576));
    check("① 1.75 GB", f(1.75 * 1073741824) === "1.75 GB", f(1.75 * 1073741824));
    check("① 0 / null → 0 B", f(0) === "0 B" && f(null) === "0 B", f(0) + "," + f(null));
  }

  /* ---------- ② cleanPaths ---------- */
  {
    const s = makeSandbox({});
    const p = vm.runInContext("cleanPaths()", s.sandbox);
    check("② 项目根 = 流水线目录的上一级", p.projectRoot === "C:/proj", p.projectRoot);
    check("② 模型目录统一走 uvrModelsDir()（下载与使用同一处）",
      p.modelsDir === "C:/data/models/uvr", p.modelsDir);
    check("② 输出目录取面板设置", p.outDir === "C:/out", p.outDir);
  }

  /* ---------- ③ 清内存：正常 ---------- */
  {
    const s = makeSandbox({
      freeMemory: () => Promise.resolve({
        totalBytes: 16 * 1073741824, beforeBytes: 5.4 * 1073741824,
        afterBytes: 7.3 * 1073741824, freedBytes: 1.9 * 1073741824,
        trimmed: 125, failed: 2
      })
    });
    await vm.runInContext("__free()", s.sandbox);
    const all = s.logs.join("\n");
    check("③ 内存：吐出了释放量", all.indexOf("释放 1.90 GB") >= 0, all.split("\n").filter((l) => l.indexOf("释放") >= 0)[0]);
    check("③ 内存：吐出了处理后可用量", all.indexOf("7.30 GB") >= 0);
    check("③ 内存：说明了不结束进程、跳过 AE", all.indexOf("没有结束任何进程") >= 0);
    check("③ 内存：回报到面板提示区", s.el.maintOut.innerHTML.indexOf("1.90 GB") >= 0);
    check("③ 内存：无引用错误", all.indexOf("is not defined") < 0);
    check("③ 内存：跑完解除禁用", s.el.btnFreeMem.disabled === false);
  }

  /* ---------- ④ 清内存：可用量没变化 ---------- */
  {
    const s = makeSandbox({
      freeMemory: () => Promise.resolve({
        totalBytes: 16 * 1073741824, beforeBytes: 5 * 1073741824,
        afterBytes: 5 * 1073741824 - 1000, freedBytes: -1000, trimmed: 120, failed: 0
      })
    });
    await vm.runInContext("__free()", s.sandbox);
    const all = s.logs.join("\n");
    check("④ 负数释放量按 0 显示（不显示 -0.00）", s.el.maintOut.innerHTML.indexOf("-") < 0, s.el.maintOut.innerHTML);
    check("④ 提示「没有明显变化」", all.indexOf("没有明显变化") >= 0);
  }

  /* ---------- ⑤ 清内存：失败 ---------- */
  {
    const s = makeSandbox({ freeMemory: () => Promise.reject(new Error("PowerShell 超时（120 秒）")) });
    await vm.runInContext("__free()", s.sandbox);
    check("⑤ 失败有明确文案", s.logs.join("\n").indexOf("清理内存失败") >= 0);
    check("⑤ 失败也解除禁用", s.el.btnFreeMem.disabled === false);
  }

  /* ---------- ⑥ 清文件：默认勾选全部 → 只删勾选的组 ---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.resolve({ groups: groupsFixture(), totalBytes: 1500400000, totalCount: 19 }),
      recycle: (items) => Promise.resolve({ recycled: items.length, permanent: 0, skipped: 0, freedBytes: 1500400000, sample: [] })
    });
    const p = vm.runInContext("__files()", s.sandbox);
    await tick();
    await tick();

    const html = s.el.cfmBody.innerHTML;
    check("⑥ 弹层列出了各组的勾选框", (html.match(/data-key=/g) || []).length === 4, "实际 " + (html.match(/data-key=/g) || []).length);
    check("⑥ 默认勾选前三组（不含字幕、不含锁定的模型）",
      html.indexOf('data-key="mid" checked') >= 0 && html.indexOf('data-key="subs" checked') < 0);
    check("⑥ 模型组标为 locked 且没有勾选框", html.indexOf("cleanGroup locked") >= 0 && html.indexOf('data-key="models"') < 0);
    check("⑥ 合计行按默认勾选算出 19 项", s.el.cfmBody.querySelector("#cleanTotal").innerHTML.indexOf("19 项") >= 0,
      s.el.cfmBody.querySelector("#cleanTotal").innerHTML);

    s.el.cfmOk.fire("click");
    await p;
    const rec = s.calls.recycle[0];
    const paths = rec.items.map((i) => i.path);
    check("⑥ 只删勾选的 3 组（mid/sep/temp）", rec.items.length === 3, JSON.stringify(paths));
    check("⑥ 没有删到字幕文件", paths.indexOf("C:/out/a.srt") < 0, JSON.stringify(paths));
    check("⑥ 没有删模型（那是另一个按钮的事）", !paths.some((x) => /models|\.onnx|\.ckpt/.test(x)));
    check("⑥ perm 选项默认透传为 true", rec.opts.permanentFallback === true, JSON.stringify(rec.opts));
    check("⑥ 日志回报删除结果", s.logs.join("\n").indexOf("已删除 3 项") >= 0);
    check("⑥ 无引用错误", s.logs.join("\n").indexOf("is not defined") < 0);
    check("⑥ 跑完解除禁用", s.el.btnCleanFiles.disabled === false);
  }

  /* ---------- ⑦ 清文件：用户取消勾选两组 ---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.resolve({ groups: groupsFixture(), totalBytes: 0, totalCount: 19 }),
      recycle: (items, opts) => Promise.resolve({ recycled: items.length, permanent: 0, skipped: 0, freedBytes: 1, sample: [] })
    });
    const p = vm.runInContext("__files()", s.sandbox);
    await tick(); await tick();
    // 模拟：变成只勾 mid（把 mid 之外的全摘掉）
    s.el.cfmBody.querySelectorAll = () => ([
      { key: "mid", checked: true, getAttribute: () => "mid" }
    ]);
    s.el.cfmOk.fire("click");
    await p;
    const rec = s.calls.recycle[0];
    check("⑦ 只删用户勾选的组", rec.items.length === 1 && rec.items[0].path === "C:/out/_中间音频",
      JSON.stringify(rec.items.map((i) => i.path)));
  }

  /* ---------- ⑧ 清文件：用户取消（点取消按钮）---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.resolve({ groups: groupsFixture(), totalBytes: 0, totalCount: 19 }),
      recycle: () => Promise.resolve({ recycled: 0, permanent: 0, skipped: 0, freedBytes: 0, sample: [] })
    });
    const p = vm.runInContext("__files()", s.sandbox);
    await tick(); await tick();
    s.el.cfmCancel.fire("click");
    await p;
    check("⑧ 取消后一个都没删", s.calls.recycle.length === 0);
    check("⑧ 取消有状态提示", s.logs.join("\n").indexOf("已取消") >= 0);
  }

  /* ---------- ⑨ 清文件：没扫到东西 ---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.resolve({ groups: [], totalBytes: 0, totalCount: 0 }),
      recycle: () => Promise.resolve({})
    });
    await vm.runInContext("__files()", s.sandbox);
    check("⑨ 无内容时不弹层、直接提示", s.calls.recycle.length === 0 &&
      s.logs.join("\n").indexOf("没有找到插件产生的文件") >= 0);
  }

  /* ---------- ⑩ 清文件：扫描报错 ---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.reject(new Error("面板里的 Node 未启用，无法扫描")),
      recycle: () => Promise.resolve({})
    });
    await vm.runInContext("__files()", s.sandbox);
    check("⑩ 扫描失败有明确文案", s.logs.join("\n").indexOf("清理失败") >= 0);
    check("⑩ 失败也解除禁用", s.el.btnCleanFiles.disabled === false);
  }

  /* ---------- ⑪ 清文件：输出目录为空时给提示 ---------- */
  {
    const s = makeSandbox({
      scan: () => Promise.resolve({ groups: groupsFixture().filter((g) => g.key === "temp"), totalBytes: 400000, totalCount: 11 }),
      recycle: (items) => Promise.resolve({ recycled: items.length, permanent: 0, skipped: 0, freedBytes: 400000, sample: [] })
    });
    s.el.outDir.value = "";
    const p = vm.runInContext("__files()", s.sandbox);
    await tick(); await tick();
    s.el.cfmOk.fire("click");
    await p;
    check("⑪ 未填输出目录时给出说明", s.logs.join("\n").indexOf("没填「输出目录」") >= 0);
  }

  /* ---------- ⑫ 清模型：有模型 ---------- */
  {
    const s = makeSandbox({
      scanModels: () => Promise.resolve({
        count: 2, bytes: 934000000,
        items: [
          { path: "C:/proj/models/uvr/Kim_Vocal_2.onnx", name: "Kim_Vocal_2.onnx", dir: false, size: 66800000 },
          { path: "C:/proj/models/uvr/vocals_mel_band_roformer.ckpt", name: "vocals_mel_band_roformer.ckpt", dir: false, size: 867200000 }
        ]
      }),
      recycle: (items) => Promise.resolve({ recycled: items.length, permanent: 0, skipped: 0, freedBytes: 934000000, sample: [] })
    });
    const p = vm.runInContext("__models()", s.sandbox);
    await tick(); await tick();
    const html = s.el.cfmBody.innerHTML;
    check("⑫ 弹层列出模型文件名", html.indexOf("Kim_Vocal_2.onnx") >= 0 && html.indexOf("MelBand") < 0 && html.indexOf("mel_band") >= 0);
    check("⑫ 弹层给出合计", html.indexOf("2</b> 个模型") >= 0 || html.indexOf("2 个模型") >= 0, html.slice(-200));
    check("⑫ 提示元数据保留、会自动重下", s.el.cfmHint.innerHTML.indexOf("自动重新下载") >= 0);

    s.el.cfmOk.fire("click");
    await p;
    const rec = s.calls.recycle[0];
    check("⑫ 删除的是两个模型文件", rec.items.length === 2 && rec.items[0].path.indexOf("Kim_Vocal_2.onnx") > 0,
      JSON.stringify(rec.items.map((i) => i.path)));
    check("⑫ 没有碰模型列表元数据（json 不在删除清单）",
      !rec.items.some((i) => /\.json$/.test(i.path)));
    check("⑫ 日志说明了会重新下载", s.logs.join("\n").indexOf("下次使用时会自动重新下载") >= 0);
    check("⑫ 无引用错误", s.logs.join("\n").indexOf("is not defined") < 0);
  }

  /* ---------- ⑬ 清模型：没有模型 ---------- */
  {
    const s = makeSandbox({
      scanModels: () => Promise.resolve({ count: 0, bytes: 0, items: [] }),
      recycle: () => Promise.resolve({})
    });
    await vm.runInContext("__models()", s.sandbox);
    check("⑬ 无模型时直接提示、不弹层", s.calls.recycle.length === 0 &&
      s.logs.join("\n").indexOf("没有已下载的模型") >= 0);
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
