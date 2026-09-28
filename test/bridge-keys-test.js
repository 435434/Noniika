/**
 * 桥接层「关键帧工具」真函数测试（不需要 AE）
 * ==========================================================
 * 把 cep/jsx/ae-bridge.jsx 里的
 *   AESub_shiftPropertyKeys_ / AESub_shiftAllKeys_
 *   AESub_scalePropertyKeys_ / AESub_scaleAllKeys_
 *   AESub_keyTimeRange_
 * 原样抠出来，配一个假的"属性对象"（实现 numKeys/keyTime/keyValue/removeKey/setValueAtTime）
 * 跑断言。这样"把预设动画铺满整句"这套数学不必启动 AE 就能验证。
 *
 * 用法： node test/bridge-keys-test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "cep", "jsx", "ae-bridge.jsx"), "utf8")
  .split(/\r?\n/);

/** 按大括号配平抠出一个顶层函数的所有行 */
function grab(name) {
  const start = src.findIndex((l) => l.includes("function " + name + "("));
  if (start < 0) throw new Error("找不到函数 " + name);
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = start; i < src.length; i++) {
    for (const ch of src[i]) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; }
    }
    out.push(src[i]);
    if (started && depth === 0) break;
  }
  return out.join("\n");
}

const code = [
  grab("AESub_shiftPropertyKeys_"),
  grab("AESub_shiftAllKeys_"),
  grab("AESub_scalePropertyKeys_"),
  grab("AESub_scaleAllKeys_"),
  grab("AESub_keyTimeRange_"),
  grab("AESub_shouldSkipPreset_")
].join("\n\n");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

/* ---------------------------------------------------------- 假属性对象 */

function fakeProp(times, values) {
  return {
    _keys: times.map((t, i) => ({ t, v: values[i] })),
    get numKeys() { return this._keys.length; },
    keyTime(i) { return this._keys[i - 1].t; },
    keyValue(i) { return this._keys[i - 1].v; },
    removeKey(i) { this._keys.splice(i - 1, 1); },
    setValueAtTime(t, v) {
      this._keys = this._keys.filter((k) => Math.abs(k.t - t) > 1e-9);
      this._keys.push({ t, v });
      this._keys.sort((a, b) => a.t - b.t);
    },
    times() { return this._keys.map((k) => k.t); },
    values() { return this._keys.map((k) => k.v); }
  };
}
function fakeGroup(props) {
  return { numProperties: props.length, property: (i) => props[i - 1] };
}

const results = [];
function check(label, fn) {
  try { fn(); results.push({ label, pass: true }); }
  catch (e) { results.push({ label, pass: false, err: e.message }); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ---------------------------------------------------------- 平移 */

check("平移：所有关键帧整体后移（值不变、顺序保持）", () => {
  const p = fakeProp([0, 0.5, 2], [0, 100, 0]);
  const n = sandbox.AESub_shiftPropertyKeys_(p, 3);
  if (n !== 3) throw new Error("应移动 3 个关键帧，实际 " + n);
  const t = p.times();
  if (!near(t[0], 3) || !near(t[1], 3.5) || !near(t[2], 5)) throw new Error("时间错了：" + t);
  const v = p.values();
  if (v[0] !== 0 || v[1] !== 100 || v[2] !== 0) throw new Error("值被改了：" + v);
});

check("平移：递归处理嵌套组", () => {
  const inner = fakeProp([0, 1], [0, 100]);
  const g = fakeGroup([fakeGroup([inner]), fakeProp([], [])]);
  const n = sandbox.AESub_shiftAllKeys_(g, 10, { left: 50 });
  if (n !== 2) throw new Error("应移动 2 个，实际 " + n);
  if (!near(inner.times()[0], 10)) throw new Error("嵌套层没被平移");
});

/* ---------------------------------------------------------- 缩放（本次新增的核心） */

check("缩放：动画 2 秒铺满 5 秒句子（拉伸 2.5×）", () => {
  // 预设：0s 隐藏 → 0.5s 完全可见 → 2s 淡出结束
  const p = fakeProp([0, 0.5, 2], [0, 100, 0]);
  const moved = sandbox.AESub_scalePropertyKeys_(p, 0, 2, 7.82, 12.82);   // 句子 7.82~12.82
  if (moved !== 3) throw new Error("应重映射 3 个关键帧，实际 " + moved);
  const t = p.times();
  if (!near(t[0], 7.82)) throw new Error("起点应落在句子起点，实际 " + t[0]);
  if (!near(t[1], 7.82 + 0.5 * 2.5)) throw new Error("中间关键帧应按比例，实际 " + t[1]);
  if (!near(t[2], 12.82)) throw new Error("终点应落在句子终点，实际 " + t[2]);
  const v = p.values();
  if (v[0] !== 0 || v[1] !== 100 || v[2] !== 0) throw new Error("值被改了：" + v);
});

check("缩放：动画 2 秒压进 1.4 秒句子（压缩 0.7×）", () => {
  const p = fakeProp([0, 0.5, 2], [0, 100, 0]);
  sandbox.AESub_scalePropertyKeys_(p, 0, 2, 3.0, 4.4);
  const t = p.times();
  if (!near(t[0], 3.0)) throw new Error("起点错：" + t[0]);
  if (!near(t[2], 4.4)) throw new Error("终点错：" + t[2]);
  if (!near(t[1], 3.0 + 0.5 * 0.7)) throw new Error("中间点错：" + t[1]);
});

check("缩放：源区间为 0（只有一个关键帧）→ 不动", () => {
  const p = fakeProp([1], [100]);
  const n = sandbox.AESub_scalePropertyKeys_(p, 1, 1, 5, 9);
  if (n !== 0) throw new Error("应返回 0，实际 " + n);
  if (!near(p.times()[0], 1)) throw new Error("不该被改动");
});

check("缩放：递归处理嵌套组（范围选择器那种结构）", () => {
  const selector = fakeProp([0, 1.5], [100, 0]);
  const prop = fakeProp([0, 1.5], [0, 100]);
  const animator = fakeGroup([fakeGroup([selector]), fakeGroup([prop])]);
  const moved = sandbox.AESub_scaleAllKeys_(animator, 0, 1.5, 10, 12.5, { left: 50 });
  if (moved !== 4) throw new Error("应重映射 4 个关键帧，实际 " + moved);
  if (!near(selector.times()[0], 10) || !near(selector.times()[1], 12.5)) {
    throw new Error("选择器关键帧没铺满：" + selector.times());
  }
  if (!near(prop.times()[1], 12.5)) throw new Error("属性关键帧没铺满：" + prop.times());
});

/* ---------------------------------------------------------- 关键帧范围 */

check("范围：跨属性、跨嵌套组取最早/最晚", () => {
  const a = fakeProp([2, 3], [0, 100]);
  const b = fakeProp([0.5, 1.5], [0, 100]);
  const g = fakeGroup([a, fakeGroup([b])]);
  const r = sandbox.AESub_keyTimeRange_(g, { left: 50 });
  if (!r) throw new Error("应返回范围");
  if (!near(r.min, 0.5) || !near(r.max, 3)) throw new Error("范围错：" + JSON.stringify(r));
});

check("范围：没有任何关键帧 → null", () => {
  const g = fakeGroup([fakeProp([], [])]);
  const r = sandbox.AESub_keyTimeRange_(g, { left: 50 });
  if (r !== null) throw new Error("应返回 null，实际 " + JSON.stringify(r));
});

check("范围：单关键帧 → min=max", () => {
  const r = sandbox.AESub_keyTimeRange_(fakeGroup([fakeProp([4.2], [50])]), { left: 50 });
  if (!near(r.min, 4.2) || !near(r.max, 4.2)) throw new Error("范围错：" + JSON.stringify(r));
});

/* ---------------------------------------------------------- 短句跳过预设的判定 */
/* 这块是纯函数，判据共三条：开关打开 + 句子够短 + 动画比句子还长 */

const skip = (dur, span, minSec, enabled) =>
  sandbox.AESub_shouldSkipPreset_(dur, span, minSec, enabled);

check("判定：短句 + 动画更长 + 开关开 → 跳过", () => {
  if (skip(0.5, 2.0, 0.6, true) !== true) throw new Error("应当跳过");
});

check("判定：开关关 → 永不跳过", () => {
  if (skip(0.5, 2.0, 0.6, false) !== false) throw new Error("开关关时不该跳过");
});

check("判定：句子够长（≥0.6 秒）→ 不跳过", () => {
  if (skip(0.6, 2.0, 0.6, true) !== false) throw new Error("0.6 秒不该跳过");
  if (skip(5.0, 2.0, 0.6, true) !== false) throw new Error("5 秒不该跳过");
});

check("判定：动画比句子短（装得下）→ 不跳过", () => {
  // 句子 0.5 秒虽短，但动画只有 0.3 秒，压缩后能演完，没必要跳
  if (skip(0.5, 0.3, 0.6, true) !== false) throw new Error("动画装得下时不该跳过");
});

check("判定：量不到动画跨度（null）→ 不跳过（宁可按原样处理）", () => {
  if (skip(0.5, null, 0.6, true) !== false) throw new Error("null 时不该跳过");
  if (skip(0.5, undefined, 0.6, true) !== false) throw new Error("undefined 时不该跳过");
});

check("判定：零跨度 / 零时长 → 不跳过", () => {
  if (skip(0.5, 0, 0.6, true) !== false) throw new Error("零跨度不该跳过");
  if (skip(0, 2.0, 0.6, true) !== false) throw new Error("零时长不该跳过");
});

check("判定：字符串数字也认（ExtendScript 里常见）", () => {
  if (skip("0.5", "2", "0.6", true) !== true) throw new Error("字符串数字应当被认");
});

/* ---------------------------------------------------------- 汇总 */
const bad = results.filter((r) => !r.pass);
console.log("\n=== 桥接层关键帧工具测试 ===");
results.forEach((r) => console.log((r.pass ? "  ✅ " : "  ❌ ") + r.label + (r.pass ? "" : "  → " + r.err)));
console.log("\n  通过 " + (results.length - bad.length) + " / " + results.length);
process.exit(bad.length ? 1 : 0);
