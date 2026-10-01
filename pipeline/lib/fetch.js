/**
 * fetch.js —— 极简 HTTP 下载器（**零依赖**）
 * ==================================================================
 * 为什么自己写：项目对外承诺「零运行时 npm 依赖」（分发包不含 node_modules），
 * 而 Node 内置的 https 足够做我们要的四件事：
 *   跟随 302 / Range 断点续传 / 进度回调 / 落地后校验体积。
 *
 * ⚠⚠ 两条**实测**出来的约束，改代码前先读：
 *
 *  1. **不能下 `github.com/.../releases/download/...`**。
 *     本机（以及不少国内网络）`github.com` 被 DNS 污染，解析到 `127.0.0.1` / `::1`，
 *     连不上；几个常见的 gh 代理镜像（ghproxy.net / gh-proxy.com / ghfast.top）同样 000。
 *     但 **`api.github.com` 与 `release-assets.githubusercontent.com` 是通的** ——
 *     所以正确姿势是走 API：
 *        GET https://api.github.com/repos/<repo>/releases/assets/<id>
 *            Accept: application/octet-stream
 *     它会 302 到 `release-assets.githubusercontent.com`（实测 200 + Accept-Ranges: bytes）。
 *
 *  2. **模型走 `hf-mirror.com`**（HuggingFace 官方直连不通）：resolve 路径会 302 到
 *     S3 预签名 URL，**签名只有 1 小时有效** ⇒ 续传时不要缓存那个直链，每次都重新解析。
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

const UA = "Noniika/0.9.2 (+ae-subtitle)";
const MAX_HOPS = 6;

/** 一次 GET（不跟重定向，由调用方决定） */
function get(u, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(
      u,
      { headers: { "User-Agent": UA, "Accept-Encoding": "identity", ...headers } },
      (res) => resolve(res)
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接超时（${timeoutMs} ms）`)));
    req.on("error", reject);
  });
}

/** 跟完重定向，返回最终响应（不读 body） */
async function follow(url, headers, timeoutMs) {
  let u = new URL(url);
  let hops = 0;
  for (;;) {
    const res = await get(u, headers, timeoutMs);
    const code = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(code)) {
      const loc = res.headers.location;
      res.resume();
      if (!loc) throw new Error("重定向缺少 Location");
      if (++hops > MAX_HOPS) throw new Error("重定向次数过多（> " + MAX_HOPS + "）");
      u = new URL(loc, u);
      continue;
    }
    return { res, finalUrl: u.toString() };
  }
}

/** 拿远端体积（HEAD；有些源不支持 HEAD 就退回带 Range 的 GET，只取 1 字节） */
export async function remoteSize(url, headers = {}, timeoutMs = 25000) {
  try {
    const { res } = await follow(url, { ...headers, Range: "bytes=0-0" }, timeoutMs);
    const cr = res.headers["content-range"];          // bytes 0-0/1533763059
    res.resume();
    if (cr && cr.indexOf("/") >= 0) return Number(cr.split("/").pop()) || 0;
    const cl = Number(res.headers["content-length"]) || 0;
    return cl;
  } catch {
    return 0;
  }
}

/** 取一段 JSON（GitHub API 用） */
export async function getJson(url, headers = {}, timeoutMs = 25000) {
  const { res } = await follow(url, { ...headers, Accept: "application/vnd.github+json" }, timeoutMs);
  let buf = "";
  await new Promise((resolve, reject) => {
    res.on("data", (c) => (buf += c.toString("utf8")));
    res.on("end", resolve);
    res.on("error", reject);
  });
  if ((res.statusCode || 0) !== 200) throw new Error(`HTTP ${res.statusCode}：${buf.slice(0, 200)}`);
  try {
    return JSON.parse(buf);
  } catch (e) {
    throw new Error("返回的不是 JSON：" + buf.slice(0, 160));
  }
}

/**
 * 下载到文件（**支持断点续传 + 自动重试**）。
 *
 * ⚠ 为什么必须有重试：实测本机到 GitHub CDN 的链路会**中途断**（3.6 MB 的包
 *   平均 43 KB/s，且出现过连接被重置）。没有重试的话，429 MB 的 CUDA 包几乎不可能下完 ——
 *   而有了重试 + Range，断了就从断点接着下，慢但一定能下完。
 *
 * @param {object} o
 * @param {string} o.url          直链（可被 302；也支持 GitHub API 资产地址）
 * @param {string} o.dest         落地路径
 * @param {object} [o.headers]    额外请求头（如 Accept: application/octet-stream）
 * @param {number} [o.expectBytes] 期望体积；给了就做完整性校验，并对"已下满"直接跳过
 * @param {function} [o.onProgress] ({got,total,percent,retry}) 节流回调（约 300ms 一次）
 * @param {number} [o.attempts]   最多尝试次数（默认 8）
 */
export async function download(o) {
  const attempts = o.attempts || 8;
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await downloadOnce(o);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (/HTTP 4\d\d/.test(msg)) throw e;          // 403/404 这类重试没意义
      if (i >= attempts) break;
      if (o.onProgress) {
        o.onProgress({ got: 0, total: 0, percent: 0, retry: i, message: `连接中断，续传中（第 ${i + 1}/${attempts} 次）` });
      }
      await new Promise((r) => setTimeout(r, Math.min(6000, 800 * i)));
    }
  }
  throw lastErr;
}

async function downloadOnce({ url, dest, headers = {}, expectBytes = 0, onProgress, timeoutMs = 30000 }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let start = 0;
  try { start = fs.statSync(dest).size; } catch { start = 0; }

  // 已经下满 → 直接算成功（重复点"下载"不该重下一遍）
  if (expectBytes && start === expectBytes) {
    if (onProgress) onProgress({ got: start, total: start, percent: 100, done: true, skipped: true });
    return { ok: true, bytes: start, skipped: true, resumed: true, url };
  }
  // 比期望还大 → 文件脏了，重来
  if (expectBytes && start > expectBytes) {
    try { fs.unlinkSync(dest); } catch { /* 删不掉就覆盖写 */ }
    start = 0;
  }

  const reqHeaders = { ...headers };
  if (start > 0) reqHeaders.Range = "bytes=" + start + "-";

  const { res, finalUrl } = await follow(url, reqHeaders, timeoutMs);
  const code = res.statusCode || 0;

  if (code === 416) {                       // 我们已经下满了（但 expectBytes 没给）
    res.resume();
    return { ok: true, bytes: start, skipped: true, resumed: true, url: finalUrl };
  }
  if (code !== 200 && code !== 206) {
    res.resume();
    throw new Error(`HTTP ${code}（${finalUrl.slice(0, 90)}）`);
  }

  const len = Number(res.headers["content-length"]) || 0;
  const total = code === 206 ? len + start : len;
  const out = fs.createWriteStream(dest, { flags: start > 0 ? "a" : "w" });
  let got = start;
  let last = 0;

  await new Promise((resolve, reject) => {
    res.on("data", (c) => {
      got += c.length;
      const now = Date.now();
      if (onProgress && now - last > 300) {
        last = now;
        onProgress({
          got,
          total,
          percent: total ? Math.min(100, Math.round((got / total) * 100)) : 0,
        });
      }
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });

  if (onProgress) onProgress({ got, total: total || got, percent: 100, done: true });

  // 体积校验：宁可报"不完整"（文件留着，下次接着下），也不要一个坏文件被当成好的
  if (expectBytes && got !== expectBytes) {
    throw new Error(
      `下载不完整：得到 ${got} 字节 / 应为 ${expectBytes}（文件已保留，再点一次会接着下）`
    );
  }
  return { ok: true, bytes: got, resumed: start > 0, url: finalUrl };
}

/**
 * **多连接分段**下载（把大文件切成若干块并发下，再拼起来）。
 *
 * ⚠ 为什么需要它 —— 实测结论（2026-09-29，本机 1.5 GB 权重的真实场景）：
 *   · 单连接下载 hf-mirror：约 **60~450 KB/s**（波动极大），1.5 GB 要 60~120 分钟；
 *   · **同一条源 8 连接并发：1.4~3.5×**（单连接被按连接限速，并发才吃满带宽）；
 *   · 换源没用 —— hf-mirror 与魔搭（阿里云）在同一时刻只差 1.4×，且互相追赶；
 *   · 真正的瓶颈是**本机到 CDN 的线路**，所以靠"并发 + 多源分摊"而不是"找更快的源"。
 *
 * 设计要点：
 *  1. **块落盘成独立小文件**（`<dest>.parts/pN`），任一块断了只重下那一块；
 *  2. **可跨源续传** —— 两个镜像同一区间 sha256 实测一致（已核对），所以每块可以
 *     轮流从不同源取；某源失败自动换下一个源；
 *  3. **能接管旧的单流半成品** —— 之前用单连接下了一半的大文件，会被切成块继续用，
 *     不浪费已下的流量（用户已经下过 400+ MB 的情况很常见）；
 *  4. 全部块齐了才拼接成最终文件，最后按 `expectBytes` 校验体积。
 *
 * @param {object} o
 * @param {string[]} o.urls       同一文件的多个源（字节必须一致）
 * @param {string} o.dest         最终落地路径
 * @param {object} [o.headers]    额外请求头
 * @param {number} [o.expectBytes] 期望体积（不给就自动探测）
 * @param {number} [o.connections] 并发连接数（默认 8；实测再多不涨反降）
 * @param {number} [o.chunkBytes]  每块大小（默认 16 MB）
 * @param {function} [o.onProgress]
 */
export async function downloadRanged(o) {
  const urls = (o.urls || []).filter(Boolean);
  if (!urls.length) throw new Error("downloadRanged 需要一个源地址");
  const dest = o.dest;
  const headers = o.headers || {};
  const connections = Math.max(1, Math.min(24, o.connections || 8));
  const chunkBytes = o.chunkBytes || 16 * 1048576;
  const attempts = o.attempts || 6;
  const report = o.onProgress || (() => {});

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const total = o.expectBytes || (await remoteSize(urls[0], headers));
  if (!total) throw new Error("拿不到文件体积（源可能不支持 Range）");

  try {
    const s = fs.statSync(dest).size;
    if (s === total) {
      report({ got: s, total: s, percent: 100, done: true, skipped: true });
      return { ok: true, bytes: s, skipped: true, url: urls[0] };
    }
    if (s > total) fs.unlinkSync(dest);
  } catch { /* 不存在，正常 */ }

  const partsDir = dest + ".parts";
  const partPath = (i) => path.join(partsDir, "p" + String(i).padStart(4, "0"));

  // ---- 把旧的单流半成品切成块（省下已经下过的流量）----
  try {
    const s = fs.statSync(dest).size;
    if (s > 0 && s < total && !fs.existsSync(partsDir)) {
      fs.mkdirSync(partsDir, { recursive: true });
      const fd = fs.openSync(dest, "r");
      let off = 0;
      for (let i = 0; off < s; i++) {
        const take = Math.min(chunkBytes, s - off);
        const buf = Buffer.allocUnsafe(take);
        fs.readSync(fd, buf, 0, take, off);
        fs.writeFileSync(partPath(i), buf);
        off += take;
      }
      fs.closeSync(fd);
      fs.unlinkSync(dest);
      report({ got: s, total, percent: Math.round((s / total) * 100), message: "已接管上次下了一半的数据，从断点继续" });
    } else if (s >= total) {
      fs.unlinkSync(dest);          // 不在这里拼装时删掉，避免和最终文件混淆
    }
  } catch { /* 没有旧文件 */ }

  fs.mkdirSync(partsDir, { recursive: true });

  // ---- 建任务表 ----
  const nParts = Math.ceil(total / chunkBytes);
  const tasks = [];
  for (let i = 0; i < nParts; i++) {
    const s = i * chunkBytes;
    const e = Math.min(total, s + chunkBytes) - 1;
    const want = e - s + 1;
    let have = 0;
    try {
      have = fs.statSync(partPath(i)).size;
      if (have > want) { fs.unlinkSync(partPath(i)); have = 0; }
    } catch { have = 0; }
    if (have < want) tasks.push({ i, s: s + have, e, want, have });
  }

  const progress = () => {
    let got = 0;
    for (const t of tasks) {
      try { got += Math.min(t.want, fs.statSync(partPath(t.i)).size); } catch { /* 还没建 */ }
    }
    for (let i = 0; i < nParts; i++) {
      if (!tasks.some((t) => t.i === i)) got += Math.min(chunkBytes, total - i * chunkBytes);
    }
    report({ got, total, percent: Math.min(99, Math.round((got / total) * 100)) });
  };

  let round = 0;
  while (tasks.length) {
    if (++round > attempts) throw new Error(`有 ${tasks.length} 块反复失败，已停在第 ${round - 1} 次重试`);
    const wave = tasks.splice(0, tasks.length);
    let idx = 0;
    const failed = [];

    const worker = async () => {
      for (;;) {
        const t = wave[idx++];
        if (!t) return;
        const url = urls[(t.i + round) % urls.length];   // 每块轮流换源
        try {
          const end = await partRange({ url, dest: partPath(t.i), start: t.s, end: t.e, headers, timeoutMs: o.timeoutMs || 30000 });
          if (end !== t.e + 1) throw new Error(`块 ${t.i} 不完整（到 ${end}，应到 ${t.e + 1}）`);
        } catch (e) {
          t.err = (e && e.message) || String(e);
          failed.push(t);
        }
        progress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(connections, wave.length) }, worker));

    if (failed.length) {
      report({ message: `有 ${failed.length} 块需要重试（第 ${round} 次）`, retry: round });
      await new Promise((r) => setTimeout(r, Math.min(6000, 700 * round)));
      tasks.push(...failed);
    }
  }

  // ---- 拼接 ----
  report({ got: total, total, percent: 99, message: "正在合并分块…" });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: "w" });
    out.on("error", reject);
    out.on("finish", resolve);
    let i = 0;
    const next = () => {
      if (i >= nParts) { out.end(); return; }
      const rs = fs.createReadStream(partPath(i++));
      rs.on("error", reject);
      rs.on("end", next);
      rs.pipe(out, { end: false });
    };
    next();
  });

  const finalSize = fs.statSync(dest).size;
  if (finalSize !== total) {
    throw new Error(`合并后体积不对：${finalSize} / 应为 ${total}（分块留在 ${partsDir}，再点一次会接着下）`);
  }
  fs.rmSync(partsDir, { recursive: true, force: true });
  report({ got: total, total, percent: 100, done: true });
  return { ok: true, bytes: total, url: urls[0], parts: nParts };
}

/** 取某一块的区间，追加写入；返回已写到哪个字节（end+1） */
async function partRange({ url, dest, start, end, headers, timeoutMs }) {
  const reqHeaders = { ...headers, Range: `bytes=${start}-${end}` };
  const { res, finalUrl } = await follow(url, reqHeaders, timeoutMs);
  const code = res.statusCode || 0;
  if (code === 200) {
    // 源忽略了 Range：只有从头取整文件才安全，否则会写错位置
    res.destroy();
    throw new Error(`源忽略了 Range（HTTP 200，${finalUrl.slice(0, 70)}）`);
  }
  if (code !== 206) {
    res.resume();
    throw new Error(`HTTP ${code}（${finalUrl.slice(0, 70)}）`);
  }
  const out = fs.createWriteStream(dest, { flags: "a" });
  let written = start;
  await new Promise((resolve, reject) => {
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.on("data", (c) => { written += c.length; });
    res.pipe(out);
  });
  return written;
}

/**
 * 取 GitHub release 里某个资产的信息（**走 api.github.com**，绕开被污染的 github.com）。
 * @returns {Promise<{id:number,name:string,size:number,apiUrl:string}>}
 */
export async function githubAsset(repo, tag, assetName) {
  const d = await getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
  const list = d.assets || [];
  const a = list.find((x) => x.name === assetName);
  if (!a) {
    throw new Error(
      `release ${tag} 里没有「${assetName}」。该 release 现有：` +
      (list.map((x) => x.name).join(" / ") || "（一个资产都没有）")
    );
  }
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    apiUrl: `https://api.github.com/repos/${repo}/releases/assets/${a.id}`,
  };
}

/** 下 GitHub 资产（自动走 API + octet-stream，302 由下载器跟随） */
export async function downloadGithubAsset({ repo, tag, assetName, dest, onProgress, timeoutMs }) {
  const meta = await githubAsset(repo, tag, assetName);
  const r = await download({
    url: meta.apiUrl,
    dest,
    headers: { Accept: "application/octet-stream" },
    expectBytes: meta.size,
    onProgress,
    timeoutMs,
  });
  return { ...r, asset: meta };
}
