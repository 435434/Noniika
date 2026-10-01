/**
 * 验证 cep-bridge 的路径归一化（修 file:/// 那个坑）。
 * 用**真实的 cep-bridge.js**，只伪造 __adobe_cep__.getSystemPath 的返回值，
 * 因为那正是出问题的地方（实测它返回 file:///C:/… 形式的 URL）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const EXT_REAL = path.join(os.homedir(), "AppData", "Roaming", "Adobe", "CEP", "extensions",
  "com.aesub.autosubtitle");
const CODE = fs.readFileSync(path.join(ROOT, "cep", "js", "cep-bridge.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  → " + extra : "")); }
}

/** 用给定的 getSystemPath 实现加载真实的桥接层 */
function load(getSystemPath) {
  const win = { __adobe_cep__: { getSystemPath: getSystemPath, evalScript: (s, cb) => cb("{}") } };
  win.window = win;
  vm.runInNewContext(CODE, win, { filename: "cep-bridge.js" });
  return win.CepBridge;
}

/** 与 main.js 里 joinPath 同款实现（只做拼接，便于验证调用方拿到的路径能不能用） */
function joinPath() {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const p = arguments[i];
    if (p === undefined || p === null || p === "") continue;
    parts.push(String(p).replace(/[\\/]+$/, ""));
  }
  return parts.join("/").replace(/([^:])\/{2,}/g, "$1/");
}

const wantReal = EXT_REAL.replace(/\\/g, "/");

console.log("=== ① 实测形态：getSystemPath 返回 file:///C:/… （本机就是这个）===");
{
  const b = load(() => "file:///" + wantReal);
  const got = b.extensionPath();
  check("extensionPath() 剥掉了 file:// 前缀", got === wantReal, JSON.stringify(got));
  // ⚠ 不能硬断言"文件存在"：**自用版刻意不带支持页**（去掉 ♥ 支持作者），只有分发包有。
  //   这里真正要验的是"剥掉 file:/// 前缀之后，拼出来的路径落在扩展目录里"。
  const _sp = joinPath(got, "support.html");
  check("剥前缀后拼出的路径落在扩展目录里（file:/// 坑的核心）",
    _sp.indexOf(wantReal) === 0, _sp);
  console.log("  ℹ support.html：" + (fs.existsSync(_sp)
    ? "在（分发包形态）" : "不在（自用版形态 —— 刻意不带 ♥ 支持页，属预期）"));
}

console.log("\n=== ①b 用真实分发包的目录布局验证（node-runtime / pipeline 都在扩展目录下）===");
{
  const PKG = path.join(ROOT, "插件打包", "com.aesub.autosubtitle").replace(/\\/g, "/");
  if (!fs.existsSync(PKG)) {
    console.log("  （跳过：还没有 插件打包/com.aesub.autosubtitle）");
  } else {
    const b = load(() => "file:///" + PKG);
    const ext = b.extensionPath();
    check("自带 Node 能被定位（这是「别人没装 Node 也能用」的前提）",
      fs.existsSync(joinPath(ext, "node-runtime", "node.exe")),
      joinPath(ext, "node-runtime", "node.exe"));
    check("随包 pipeline 能被定位", fs.existsSync(joinPath(ext, "pipeline", "cli.js")));
    // 分发包是否已带上 support.html —— 只提示，不作为失败项（分发包可能还是旧的版本）
    const sp = joinPath(ext, "support.html");
    console.log("  ℹ 分发包里的 support.html：" + (fs.existsSync(sp)
      ? "已在（%.0f KB）".replace("%.0f", fs.statSync(sp).size / 1024) : "**还没有 —— 需要重跑 tools/build-package.py**"));
  }
}

console.log("\n=== ② 兼容形态：返回普通路径（别的 CEP 版本可能是这样）===");
{
  const b = load(() => wantReal);
  check("普通路径原样返回", b.extensionPath() === wantReal, b.extensionPath());
  check("普通路径形态：拼出的路径同样落在扩展目录里",
    joinPath(b.extensionPath(), "support.html").indexOf(wantReal) === 0);
}

console.log("\n=== ③ 反斜杠 + URI 转义（用户名带空格的情况）===");
{
  const b = load(() => "file:///C:/Users/kun%20ku/doc");
  check("反斜杠与 %20 都归一化", b.extensionPath() === "C:/Users/kun ku/doc", b.extensionPath());
}

console.log("\n=== ④ 取不到时不炸、返回空串 ===");
{
  const b1 = load(() => { throw new Error("boom"); });
  check("getSystemPath 抛异常 → 返回空串", b1.extensionPath() === "", b1.extensionPath());
  const win = { __adobe_cep__: null };
  win.window = win;
  vm.runInNewContext(CODE, win, { filename: "cep-bridge.js" });
  check("根本没有 CEP 环境 → 返回空串且不抛", win.CepBridge.extensionPath() === "");
}

console.log("\n=== ⑤ 指定目录（模拟「别人的电脑」，由 AESUB_EXT_DIR 传入）===");
if (!process.env.AESUB_EXT_DIR) {
  console.log("  （跳过：没有设置 AESUB_EXT_DIR）");
} else {
  const dir = process.env.AESUB_EXT_DIR.replace(/\\/g, "/");
  const b1 = load(() => "file:///" + dir);     // CEP 实测形态：URI
  const b2 = load(() => dir);                  // 兼容形态：普通路径
  check("URI 形态：剥前缀后与目标目录一致", b1.extensionPath() === dir, b1.extensionPath());
  check("普通形态：原样返回", b2.extensionPath() === dir, b2.extensionPath());
  check("support.html 在该目录下真实存在",
    fs.existsSync(joinPath(dir, "support.html")), joinPath(dir, "support.html"));
  check("赞赏码图片在该目录下真实存在",
    fs.existsSync(joinPath(dir, "assets", "zanshang-code.png")),
    joinPath(dir, "assets", "zanshang-code.png"));
}

console.log("\n  通过 " + pass + " / " + (pass + fail));
process.exit(fail ? 1 : 0);
