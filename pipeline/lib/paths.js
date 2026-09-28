/**
 * paths.js —— 定位外部可执行文件
 * ==========================================================
 * 设计原则：**永远用绝对路径，绝不依赖 PATH**。
 *
 * 为什么（实测踩坑）：
 *   早期用的那个识别库在处理媒体时内部 `spawn("ffmpeg")` / `spawn("ffprobe")`
 *   直接依赖 PATH。一旦 PATH 里没有，它的探测函数会走 error 分支返回 undefined，
 *   然后抛出 **"Input video has no audio track"** —— 一个完全误导人的报错。
 *   所以流水线自己用绝对路径调 ffmpeg，只把转好的标准音频交给识别服务，彻底绕开这条链路。
 *
 * 查找顺序：
 *   1. 环境变量覆盖（AESUB_FFMPEG / AESUB_FFPROBE）—— 便于用户自带新版
 *   2. **随包 vendor**（`pipeline/vendor/ffmpeg/`）—— 分发包默认走这条
 *      ⚠ 这里放的是 **LGPL 构建**。合规原因见 THIRD-PARTY-NOTICES.md：
 *        LGPL 构建不含 GPL-only 组件，商业分发时义务最轻。
 *        若换成 GPL 构建，必须同步更新第三方声明。
 *   3. node_modules 里 @ffmpeg-installer / @ffprobe-installer 提供的二进制
 *   4. 系统 PATH（where 能查到就算）
 * 全部失败则返回 null，由调用方给出明确报错。
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** pipeline 目录（lib 的上一级） */
export const PIPELINE_DIR = path.resolve(__dirname, "..");
/** 项目根目录 */
export const PROJECT_ROOT = path.resolve(PIPELINE_DIR, "..");

/**
 * 解析 @xxx-installer 风格包的二进制路径。
 * 这类包导出 { path, version, url }，其中 path 指向解包好的可执行文件。
 */
function resolveFromInstaller(pkgName) {
  try {
    const mod = require(pkgName);
    const p = mod && (mod.path || mod.default?.path);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 包没装，继续找下一个来源 */
  }
  return null;
}

/** 在系统 PATH 中查找可执行文件（不依赖 spawn，纯文件系统扫描，避免副作用） */
function resolveFromSystemPath(exeName) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, exeName + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 权限等异常直接跳过 */
      }
    }
  }
  return null;
}

/** 随包自带的 ffmpeg 目录（分发包里就是这一份，LGPL 构建） */
export const VENDOR_FFMPEG_DIR = path.join(PIPELINE_DIR, "vendor", "ffmpeg");

/**
 * 先看随包 vendor 目录。
 * 只接受真实存在的文件 —— 开发机上这个目录可能是空的（没放二进制），
 * 那就自然落到后面的 node_modules / PATH，行为与从前一致。
 */
function resolveFromVendor(exeName) {
  const p = path.join(VENDOR_FFMPEG_DIR, exeName + (process.platform === "win32" ? ".exe" : ""));
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  } catch {
    /* 权限等异常直接跳过 */
  }
  return null;
}

function locate(envKey, installerPkg, exeName) {
  const override = process.env[envKey];
  if (override && fs.existsSync(override)) return override;
  return resolveFromVendor(exeName) || resolveFromInstaller(installerPkg) || resolveFromSystemPath(exeName);
}

let _ffmpeg = undefined;
let _ffprobe = undefined;

/** ffmpeg 可执行文件绝对路径；找不到返回 null */
export function getFfmpegPath() {
  if (_ffmpeg === undefined) {
    _ffmpeg = locate("AESUB_FFMPEG", "@ffmpeg-installer/ffmpeg", "ffmpeg");
  }
  return _ffmpeg;
}

/** ffprobe 可执行文件绝对路径；找不到返回 null */
export function getFfprobePath() {
  if (_ffprobe === undefined) {
    _ffprobe = locate("AESUB_FFPROBE", "@ffprobe-installer/ffprobe", "ffprobe");
  }
  return _ffprobe;
}

/**
 * 校验依赖是否齐备，缺什么就说清楚缺什么、怎么补。
 *
 * ⚠ **ffprobe 是可选的**：只有 ffmpeg 也是必需且充分的。
 * 原因：ffprobe 那个静态二进制有 77 MB（比 ffmpeg 自己还大），而这里只需要从它拿
 * 「时长 / 有没有音轨 / 声道与采样率」—— ffmpeg 自己 `-i` 就能给出这些。
 * 分发包因此不带 ffprobe，体积直接砍掉一半多；有 ffprobe 的环境（开发机）
 * 依然优先用它，行为完全不变。
 *
 * @returns {{ok: boolean, ffmpeg: string|null, ffprobe: string|null, error?: string}}
 */
export function checkDependencies() {
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  if (ffmpeg) return { ok: true, ffmpeg, ffprobe };

  return {
    ok: false,
    ffmpeg: null,
    ffprobe,
    error:
      `找不到 ffmpeg。请在 pipeline 目录执行：\n` +
      `  npm install\n` +
      `或设置环境变量 AESUB_FFMPEG 指向你自带的版本。` +
      `（ffprobe 可选：没有时会用 ffmpeg 自己解析媒体信息）`,
  };
}
