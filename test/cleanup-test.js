/**
 * AeClean（清理模块）的沙箱测试。
 *
 * 只跑真实函数、只碰自己造的临时文件；删除一律走回收站（可还原）。
 * 用法：node test/cleanup-test.js
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AeClean = require(path.join(__dirname, "..", "cep", "js", "cleanup.js"));

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  PASS  " + name); }
  else { fail++; results.push("  FAIL  " + name + (extra ? ("  ← " + extra) : "")); }
}

function mb(bytes) { return (bytes / 1048576).toFixed(2) + " MB"; }

/** 造一个假的项目现场 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aesub-clean-fx-"));
  const outDir = path.join(root, "out");
  const tempDir = path.join(root, "tmp");
  const modelsDir = path.join(root, "models", "uvr");

  fs.mkdirSync(path.join(outDir, "_中间音频"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "_人声分离", "_tmp"), { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

  // 中间音频：2 个文件共 3000 字节
  fs.writeFileSync(path.join(outDir, "_中间音频", "合成 1_audio.wav"), Buffer.alloc(2000));
  fs.writeFileSync(path.join(outDir, "_中间音频", "合成 1_audio.mp3"), Buffer.alloc(1000));
  // 人声分离：2 个文件共 5000 字节（含子目录）
  fs.writeFileSync(path.join(outDir, "_人声分离", "无上光荣_人声.wav"), Buffer.alloc(3000));
  fs.writeFileSync(path.join(outDir, "_人声分离", "_tmp", "leftover.wav"), Buffer.alloc(2000));
  // 字幕成品：2 个「真格式」文件（默认不勾）
  fs.writeFileSync(path.join(outDir, "无上光荣.json"),
    JSON.stringify([{ text: "我们胜利了", startMs: 40, endMs: 1920 }]), "utf8");
  fs.writeFileSync(path.join(outDir, "无上光荣.srt"),
    "1\n00:00:00,040 --> 00:00:01,920\n我们胜利了\n\n", "utf8");
  // 干扰项：输出目录里不属于插件的文件，不能被列入
  fs.writeFileSync(path.join(outDir, "我的笔记.txt"), Buffer.alloc(50));
  fs.writeFileSync(path.join(outDir, "我的笔记.json"), JSON.stringify({ a: 1, note: "别删我" }), "utf8");
  fs.mkdirSync(path.join(outDir, "素材"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "素材", "a.srt"), Buffer.alloc(10));
  // 临时目录：插件的 3 个 + 别人的 1 个
  fs.writeFileSync(path.join(tempDir, "aesub-probe-1-on.png"), Buffer.alloc(400));
  fs.writeFileSync(path.join(tempDir, "aesub-clean-x.json"), Buffer.alloc(100));
  fs.writeFileSync(path.join(tempDir, "CEPHtmlEngine12-AEFT-25.6-com.aesub.autosubtitle.panel.log"), Buffer.alloc(80));
  fs.writeFileSync(path.join(tempDir, "别人家的文件.tmp"), Buffer.alloc(999));
  // 模型：3 个本体 + 1 个元数据 json（json 不该算）
  fs.writeFileSync(path.join(modelsDir, "Kim_Vocal_2.onnx"), Buffer.alloc(6000));
  fs.writeFileSync(path.join(modelsDir, "vocals_mel_band_roformer.ckpt"), Buffer.alloc(9000));
  fs.writeFileSync(path.join(modelsDir, "vocals_mel_band_roformer.yaml"), Buffer.alloc(100));
  fs.writeFileSync(path.join(modelsDir, "mdx_model_data.json"), Buffer.alloc(7000));

  return { root, outDir, tempDir, modelsDir };
}

async function main() {
  const fx = makeFixture();

  /* ---------- ① scan：分组、字节数、白名单过滤 ---------- */
  const sc = await AeClean.scan({
    outDir: fx.outDir,
    tempDir: fx.tempDir,
    modelsDir: fx.modelsDir,
    projectRoot: fx.root            // 故意没有 python-env，走「不存在就不列」分支
  });
  const byKey = {};
  sc.groups.forEach((g) => { byKey[g.key] = g; });

  check("① 识别出 4 组（中间音频/人声分离/临时/字幕成品）+ 模型只读组",
    Object.keys(byKey).length === 5,
    "实际 " + Object.keys(byKey).join(","));

  check("① 中间音频 = 2 文件 / 3000 字节",
    byKey.mid && byKey.mid.count === 2 && byKey.mid.bytes === 3000,
    byKey.mid ? byKey.mid.count + " 文件 / " + byKey.mid.bytes + " 字节" : "缺失");

  check("① 人声分离含子目录 = 2 文件 / 5000 字节",
    byKey.sep && byKey.sep.count === 2 && byKey.sep.bytes === 5000,
    byKey.sep ? byKey.sep.count + " / " + byKey.sep.bytes : "缺失");

  check("① 临时目录只收插件的 3 个（别人家的 .tmp 不入列）",
    byKey.temp && byKey.temp.count === 3,
    byKey.temp ? String(byKey.temp.count) : "缺失");

  check("① 字幕成品 2 个且默认不勾",
    byKey.subs && byKey.subs.count === 2 && byKey.subs.defaultOn === false,
    byKey.subs ? byKey.subs.count + " / defaultOn=" + byKey.subs.defaultOn : "缺失");

  check("① 内容不像字幕的文件被排除（我的笔记.json / .txt / 素材子目录）",
    (byKey.subs ? byKey.subs.items.length : -1) === 2,
    byKey.subs ? byKey.subs.items.map(function (it) { return it.path.split(/[\\/]/).pop(); }).join(",") : "");

  check("① 模型组是只读（locked）",
    byKey.models && byKey.models.locked === true && byKey.models.items.length === 0);

  check("① 合计只算默认勾选的组：2+2+3 = 7 个文件",
    sc.totalCount === 7, "实际 " + sc.totalCount);

  check("① 合计字节 = 3000+5000+580（不含字幕/模型）",
    sc.totalBytes === 3000 + 5000 + 400 + 100 + 80,
    "实际 " + sc.totalBytes);

  check("① 没有 python-env 时不生成该组", !byKey.venv);

  /* ---------- ② scanModels：只认模型本体，不碰元数据 ---------- */
  const md = await AeClean.scanModels(fx.modelsDir);
  check("② 模型数 3（.onnx/.ckpt/.yaml），元数据 json 不算",
    md.count === 3, "实际 " + md.count);
  check("② 模型字节 = 6000+9000+100", md.bytes === 15100, "实际 " + md.bytes);

  /* ---------- ③ recycle：真删（走回收站）---------- */
  const fileA = path.join(fx.tempDir, "aesub-del-a.bin");
  const fileB = path.join(fx.tempDir, "aesub-del-b.bin");
  fs.writeFileSync(fileA, Buffer.alloc(1234));
  fs.writeFileSync(fileB, Buffer.alloc(4321));
  const dirC = path.join(fx.root, "del-me");
  fs.mkdirSync(dirC, { recursive: true });
  fs.writeFileSync(path.join(dirC, "inner.bin"), Buffer.alloc(2000));

  const rc = await AeClean.recycle([
    { path: fileA, dir: false, size: 1234 },
    { path: fileB, dir: false, size: 4321 },
    { path: dirC, dir: true, size: 2000 }
  ], { permanentFallback: false });

  check("③ 三个目标都删掉了（回收站）", rc.recycled === 3,
    "recycled=" + rc.recycled + " skipped=" + rc.skipped);
  check("③ 没有意外永久删除", rc.permanent === 0, "permanent=" + rc.permanent);
  check("③ 文件确实不在了", !fs.existsSync(fileA) && !fs.existsSync(fileB) && !fs.existsSync(dirC));
  check("③ 释放量 = 1234+4321+2000", rc.freedBytes === 7555, "实际 " + rc.freedBytes);

  /* ---------- ④ recycle 的健壮性：不存在的路径不报错 ---------- */
  const rc2 = await AeClean.recycle([
    { path: path.join(fx.root, "根本不存在.bin"), dir: false, size: 999 }
  ], {});
  check("④ 不存在的路径被安静跳过（不报错、不算删除）",
    rc2.recycled === 0 && rc2.skipped === 0, JSON.stringify(rc2));

  check("④ 空清单直接返回零", (await AeClean.recycle([], {})).recycled === 0);

  /* ---------- ⑤ 真实内存清理（安全：不结束任何进程）---------- */
  const mem = await AeClean.freeMemory();
  check("⑤ 拿到内存总量", mem.totalBytes > 1024 * 1024 * 1024,
    "total=" + mb(mem.totalBytes));
  check("⑤ 拿到清理前后可用量", mem.beforeBytes > 0 && mem.afterBytes > 0,
    "before=" + mb(mem.beforeBytes) + " after=" + mb(mem.afterBytes));
  check("⑤ 报告了处理的进程数", mem.trimmed > 0, "trimmed=" + mem.trimmed);

  console.log(results.join("\n"));
  console.log("");
  console.log("  --- 实测数据 ---");
  console.log("  内存: 总 " + mb(mem.totalBytes) +
    " · 清理前可用 " + mb(mem.beforeBytes) +
    " → 清理后 " + mb(mem.afterBytes) +
    " · 释放 " + mb(mem.freedBytes) +
    " · 处理 " + mem.trimmed + " 个进程（跳过 " + mem.failed + "）");
  console.log("  扫描: 默认勾选 " + sc.totalCount + " 个条目 · " + mb(sc.totalBytes));
  console.log("  模型: " + md.count + " 个文件 · " + mb(md.bytes));
  console.log("  删除: 回收站 " + rc.recycled + " 项 · 释放 " + mb(rc.freedBytes));
  console.log("");
  console.log(fail === 0 ? ("ALLPASS|" + pass) : ("FAILED|" + fail + "/" + (pass + fail)));

  // 清理现场
  try { fs.rmSync(fx.root, { recursive: true, force: true }); } catch (e) { }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("  FAIL  测试崩溃: " + (e && e.message ? e.message : e));
  console.log("FAILED|0/1");
  process.exit(1);
});
