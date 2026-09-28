/**
 * providers/tencent.js —— 腾讯云「录音文件识别」
 * ==================================================================
 * 为什么值得单独写一个适配器（而不是只用免费档）：
 *   **它回真正的时间戳** —— 句级 StartMs/EndMs + 词级 OffsetStartMs/OffsetEndMs。
 *   免费档（SenseVoice）虽然不要钱，但只回纯文本，时间轴得靠静音检测重构；
 *   而字幕对时间轴敏感，所以"有时间戳的服务商"是这条链路的主力档之一。
 *
 * 免费额度（2026-09 官网口径，会变，以控制台为准）：
 *   录音文件识别 每月 10 小时免费；极速版每月 5 小时。开通即自动下发。
 *
 * 协议：腾讯云 3.0 签名 TC3-HMAC-SHA256（不是老版 HMAC-SHA1）。
 *   签名链路（照官方文档实现，零依赖，只用 node:crypto）：
 *     1. 拼规范请求串 → sha256
 *     2. 拼待签串（算法\n时间戳\n凭证范围\n规范请求串哈希）
 *     3. 逐级派生签名密钥：HMAC("TC3"+SecretKey, 日期) → HMAC(_, "asr") → HMAC(_, "tc3_request")
 *     4. HMAC(签名密钥, 待签串) 取十六进制
 *
 * 调用是**两段式**：CreateRecTask 提交任务 → DescribeTaskStatus 轮询拿结果。
 *   所以这里要自己实现轮询与退避，不能指望一次请求拿到字幕。
 *
 * ⚠ 单次提交的语音数据上限 5MB（base64 之后）。16kHz 单声道 WAV 约 32KB/秒，
 *   5 分钟就 9.6MB 超了 —— 所以上层会优先用 mp3（48kbps ≈ 6KB/秒，能装约 10 分钟），
 *   超长音频再由 lib/align.js 切块。这条约束写在 maxFileBytes 里由上层读取。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const id = "tencent";
export const label = "腾讯云 语音识别";

export const profiles = [
  {
    id: "tencent",
    label: "腾讯云 录音文件识别",
    region: "",
    engines: [
      { id: "16k_zh", note: "中文普通话（默认）" },
      { id: "16k_zh_large", note: "中文大模型版 · 更准" },
      { id: "16k_zh_en", note: "中英混合" },
      { id: "16k_en", note: "英文" },
      { id: "16k_yue", note: "粤语" },
    ],
    engine: "16k_zh",
    timestamps: "segments",
    needsKey: true,
    // 腾讯云用 SecretId + SecretKey 一对密钥，不是单个 Bearer token
    keyMode: "pair",
    keyLabels: { id: "SecretId", secret: "SecretKey" },
    consoleUrl: "https://console.cloud.tencent.com/cam/capi",
    // base64 后 ≤ 5MB ⇒ 原始数据留安全余量
    maxFileBytes: 3.5 * 1024 * 1024,
    maxDurationSec: 5 * 60 * 60,
    preferCompressed: true,     // 单文件能塞进去就不要切块，省一次网络往返
    freeNote: "每月 10 小时免费额度（录音文件识别），开通后自动下发",
    region_note: "cn",
    reachableInCn: true,
  },
];

export function getProfile(profileId) {
  return profiles.find((p) => p.id === profileId) || profiles[0];
}

const HOST = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";

const VOICE_FORMAT = {
  ".wav": "wav", ".mp3": "mp3", ".m4a": "m4a",
  ".flac": "flac", ".ogg": "ogg", ".amr": "amr", ".mp4": "m4a",
};

/* ------------------------------------------------------------------ 签名 */

const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg, "utf8").digest();

/** 实际会发出去的两个头，与签名内容必须**逐字符一致**（这是最常见的失败原因） */
export const SIGNED_HEADERS = "content-type;host";
export const CONTENT_TYPE_VALUE = "application/json; charset=utf-8";

/**
 * 拼规范请求串（CanonicalRequest）。抽成独立函数是为了能被自测断言，
 * 因为腾讯云校验时会**拿收到的头重新拼一遍**，只要有一处不一致就报签名失败，
 * 而那个报错信息完全不告诉你是哪里不一致。
 *
 * 格式（照官方文档）：
 *   HTTPMethod \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n HashedPayload
 *
 * ⚠ 三个坑，都已避开：
 *  1. CanonicalHeaders 里每个头都要"小写 + 去首尾空格"，并且**必须与实际发送的头一致**。
 *     有些语言会自动给 content-type 补 charset，补了而签名里没有 ⇒ 必然失败。
 *     所以这里把 content-type 的值写成常量，发送时也用它，两边同源。
 *  2. 头按 key 的 ASCII 升序排列（content-type 在 host 之前）。
 *  3. POST 的 CanonicalQueryString 是**空串**（不是省略，是留一行空的）。
 */
export function buildCanonicalRequest(payload) {
  const canonicalHeaders = `content-type:${CONTENT_TYPE_VALUE}\nhost:${HOST}\n`;
  return [
    "POST",
    "/",
    "",
    canonicalHeaders,
    SIGNED_HEADERS,
    sha256hex(payload),
  ].join("\n");
}

/**
 * 生成 TC3-HMAC-SHA256 的 Authorization 头。
 *
 * 只签 content-type 与 host 两个头（官方示例口径）。**不要顺手多签别的头** ——
 * 签名头列表与实际请求头必须严格一致，多一个少一个都会 401。
 */
export function buildAuthorization({ secretId, secretKey, action, timestamp, region, payload }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  // ---- 1. 规范请求串 ----
  const canonicalRequest = buildCanonicalRequest(payload);

  // ---- 2. 待签串（凭证范围里必须是 日期/服务/tc3_request）----
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256", timestamp, credentialScope, sha256hex(canonicalRequest),
  ].join("\n");

  // ---- 3. 派生签名密钥 ----
  const kDate = hmac("TC3" + secretKey, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, "tc3_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  // ---- 4. 拼头 ----
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    date,
    signature,
    credentialScope,
  };
}

/**
 * 拼出这次请求**真正要发的头**。
 * 关键点：content-type 的值取常量 CONTENT_TYPE_VALUE，与签名用的是同一个来源 ——
 * 这样就不可能出现"发的头和签的头不一致"这类无法自查的失败。
 */
export function buildHeaders({ secretId, secretKey, action, region, payload }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const { authorization } = buildAuthorization({
    secretId, secretKey, action, timestamp, region, payload,
  });
  const headers = {
    "Content-Type": CONTENT_TYPE_VALUE,
    "Host": HOST,
    "X-TC-Action": action,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Version": VERSION,
    "Authorization": authorization,
  };
  // 这个接口按文档不强制 region；配了才带，避免带错 region 被拒
  if (region) headers["X-TC-Region"] = region;
  return headers;
}

/** 发一次腾讯云 API 请求（JSON in / JSON out） */
async function callApi({ secretId, secretKey, action, region, body, timeoutMs = 60 * 1000 }) {
  const payload = JSON.stringify(body);
  const headers = buildHeaders({ secretId, secretKey, action, region, payload });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`https://${HOST}/`, { method: "POST", headers, body: payload, signal: ac.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`腾讯云请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`连不上腾讯云：${err && err.message ? err.message : err}（需要联网）`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`腾讯云返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }

  const r = json.Response || {};
  if (r.Error) {
    throw new Error(explainApiError(r.Error.Code, r.Error.Message));
  }
  if (!res.ok) {
    throw new Error(`腾讯云 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  return r;
}

/** 错误码 → 能照着动手的中文 */
export function explainApiError(code, message) {
  const c = String(code || "");
  const m = String(message || "");
  if (/AuthFailure|SignatureExpire|InvalidCredential/i.test(c)) {
    return `鉴权失败（${c}）：SecretId / SecretKey 不对或已失效，去控制台重新生成一对。\n${m}`;
  }
  if (/FailedOperation|ResourceInsufficient|LimitExceeded/i.test(c)) {
    return `调用被拒（${c}）：通常是免费额度用完或并发超限。\n${m}`;
  }
  if (/UnsupportedAudio|InvalidParameter.*Format/i.test(c)) {
    return `音频格式不被支持（${c}）：请换成 wav / mp3 / m4a 后重试。\n${m}`;
  }
  if (/RequestLimitExceeded/i.test(c)) {
    return `请求过于频繁（${c}）：降一点并发或稍后重试。\n${m}`;
  }
  return `腾讯云接口报错（${c}）：${m}`;
}

/* ------------------------------------------------------------------ 转写 */

/**
 * 密钥自检（**不消耗识别额度**）。
 *
 * 手法：拿一个必然不存在的 TaskId 去查任务状态。
 *   - 鉴权通过 → 返回**业务错误**（任务不存在 / 参数非法），说明签名和密钥都对；
 *   - 鉴权失败 → 返回 AuthFailure.*（签名错误 / SecretId 不存在）。
 * 两种都不产生计费，所以可以放心给用户当"测试密钥"按钮用。
 *
 * 实测（2026-09-26，用一对编造的密钥）：
 *   服务端返回 `AuthFailure.SecretIdNotFound`，**而不是网络错误**——
 *   说明请求流程、头部集合、Authorization 结构都能被腾讯云正常解析，
 *   这条链路本身是通的。
 *
 * ⚠ 但要如实说清能力边界：腾讯云**先校验 SecretId 是否存在**，再校验签名。
 *   所以用编造密钥只能证明"请求格式对"，**证不了"签名算法对"**——
 *   只有拿一对真密钥跑一次，看到业务错误而不是 `AuthFailure.SignatureFailure`，
 *   才算签名实现被真正验证过。面板上的「测试密钥」就是给这一步用的。
 *
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function ping({ secretId, secretKey, region = "", timeoutMs = 20 * 1000 }) {
  if (!secretId || !secretKey) return { ok: false, detail: "缺少 SecretId 或 SecretKey" };
  try {
    await callApi({
      secretId, secretKey, action: "DescribeTaskStatus", region,
      body: { TaskId: 1 }, timeoutMs,
    });
    // 没抛错说明居然查到了任务 1（几乎不可能），也算鉴权通过
    return { ok: true, detail: "鉴权通过（签名与服务端一致）" };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/AuthFailure|SignatureExpire|InvalidCredential|鉴权失败/i.test(msg)) {
      return { ok: false, detail: msg };
    }
    // 业务类错误 = 签名已通过、密钥有效，只是这个请求本身没意义
    return { ok: true, detail: "鉴权通过（服务端返回业务错误，属预期）：" + msg.slice(0, 160) };
  }
}

/**
 * 转写**单个**音频文件，返回带时间戳的段。
 *
 * @param {object} p
 * @param {string} p.file        音频文件（wav / mp3 / m4a …）
 * @param {string} p.secretId
 * @param {string} p.secretKey
 * @param {string} [p.engine]    16k_zh / 16k_zh_large / 16k_zh_en …
 * @param {number} [p.pollIntervalMs] 轮询间隔，默认 3 秒
 * @param {number} [p.timeoutMs] 等结果的最长时间，默认 15 分钟
 * @param {function} [p.onProgress]
 * @returns {Promise<{text:string, segments:Array|null, raw:object}>}
 */
export async function transcribeFile(p) {
  const {
    file, secretId, secretKey, engine = "16k_zh",
    pollIntervalMs = 3000, timeoutMs = 15 * 60 * 1000, onProgress, region = "",
  } = p;

  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云密钥：需要在面板里填 SecretId 与 SecretKey 两个值（不是单个 API Key）");
  }
  if (!file || !fs.existsSync(file)) throw new Error(`音频文件不存在：${file}`);

  const buf = await fs.promises.readFile(file);
  const fmt = VOICE_FORMAT[path.extname(file).toLowerCase()];
  if (!fmt) throw new Error(`腾讯云只接受 wav / mp3 / m4a / flac / ogg / amr，当前是 ${path.extname(file)}`);
  if (buf.length > 5 * 1024 * 1024) {
    throw new Error(
      `单个音频块 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过腾讯云 base64 上传上限（约 5MB）。` +
      `上层应当先切块 —— 这个约束由 providers/tencent.js 的 maxFileBytes 声明给调用方。`
    );
  }

  // ---- 第一段：提交任务 ----
  if (onProgress) onProgress(10, "提交识别任务到腾讯云");
  const created = await callApi({
    secretId, secretKey, action: "CreateRecTask", region,
    body: {
      EngSerViceType: engine,
      SourceType: 1,                        // 1 = 直接给语音数据（base64）
      Data: buf.toString("base64"),
      DataLen: buf.length,
      VoiceFormat: fmt,
      ResTextFormat: 1,                     // 1 = 结果含句级/词级时间戳
      ChannelNum: 1,
    },
  });

  const taskId = created.TaskId;
  if (!taskId) throw new Error(`腾讯云没有返回 TaskId：${JSON.stringify(created).slice(0, 300)}`);

  // ---- 第二段：轮询任务状态 ----
  const t0 = Date.now();
  let lastStatus = null;
  for (;;) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待识别结果超时（${Math.round(timeoutMs / 1000)} 秒）。音频较长或服务繁忙，可调大超时后重试。`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const st = await callApi({ secretId, secretKey, action: "DescribeTaskStatus", region, body: { TaskId: taskId } });
    const d = st.Data || {};
    lastStatus = d.Status;

    // Status：0 等待 / 1 执行中 / 2 成功 / 3 失败
    if (d.Status === 2) {
      const segments = parseResultDetail(d.ResultDetail, d.Result);
      if (onProgress) onProgress(100, `识别完成：${segments ? segments.length : 0} 句`);
      return {
        text: String(d.Result || "").trim(),
        segments,
        raw: { TaskId: taskId, AudioDuration: d.AudioDuration, StatusStr: d.StatusStr },
      };
    }
    if (d.Status === 3) {
      throw new Error(`识别任务失败：${d.ErrorMsg || "腾讯云未给出原因"}`);
    }
    if (onProgress) {
      const pct = typeof d.Progress === "number" ? d.Progress : 0;
      onProgress(Math.min(95, 15 + Math.round(pct * 0.8)), `腾讯云识别中（${d.StatusStr || "排队"}）`);
    }
  }
}

/**
 * 把 ResultDetail 转成统一格式。
 *
 * ResultDetail 里每句长这样：
 *   { FinalSentence, StartMs, EndMs, Words: [{ Word, OffsetStartMs, OffsetEndMs }] }
 * ⚠ 国际站/RTC 版把词的时间字段叫 StartTime / EndTime，所以这里两种都认。
 */
export function parseResultDetail(detail, fallbackText) {
  if (!Array.isArray(detail) || !detail.length) {
    // 没开 ResTextFormat=1 时只有整段文本，没有句子边界 —— 交给上层重构时间轴
    return null;
  }
  const out = [];
  for (const s of detail) {
    if (!s) continue;
    const text = String(s.FinalSentence || s.WrittenText || "").trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(s.StartMs) || 0));
    const endMs = Math.max(0, Math.round(Number(s.EndMs) || 0));
    if (!(endMs > startMs)) continue;

    const words = Array.isArray(s.Words)
      ? s.Words.map((w) => {
        const ws = Number(w.OffsetStartMs ?? w.StartTime ?? w.StartMs);
        const we = Number(w.OffsetEndMs ?? w.EndTime ?? w.EndMs);
        return { text: String(w.Word || w.Text || "").trim(), startMs: Math.max(0, Math.round(ws || 0)), endMs: Math.max(0, Math.round(we || 0)) };
      }).filter((w) => w.text && w.endMs > w.startMs)
      : undefined;

    out.push({ text, startMs, endMs, ...(words && words.length ? { words } : {}) });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out.length ? out : null;
}
