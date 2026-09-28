/**
 * providers/openai-compat.js —— 「OpenAI 兼容 /v1/audio/transcriptions」类服务商
 * ==================================================================
 * 一个适配器覆盖一批服务商，因为它们共用同一个 HTTP 契约：
 *   POST {baseUrl}/audio/transcriptions
 *   Authorization: Bearer <key>
 *   multipart/form-data：file / model / language / prompt / response_format
 *
 * 为什么优先做这一类（而不是一上来就啃各家私有签名协议）：
 *   1. 零依赖可实现 —— Node 18+ 自带 fetch / FormData / Blob，不需要任何 SDK
 *   2. 换服务商只是改 baseUrl + model 两个字符串，用户能自己切
 *   3. 其中**有真正长期免费的档位**，符合"免费优先"的项目原则
 *
 * ⚠ 最要紧的一件事：**有的模型不回时间戳**。
 *   字幕必须有时间轴，所以这里如实上报 `hasTimestamps`，
 *   拿不到时间戳时由 lib/asr.js 走"按静音切块 + 块内按字数分配"的兜底（见 lib/align.js）。
 *   这不是缺陷，是这条链路的设计分层：**能拿真时间戳就拿，拿不到就用语音区间重构**。
 *
 * 隐私提示：音频会上传到所选服务商的云端，调用方必须在界面上告知用户。
 */

import fs from "node:fs";
import path from "node:path";

export const id = "openai-compat";
export const label = "OpenAI 兼容接口（免费档可用）";

/**
 * 预置服务商档位。
 *
 * timestamps 取值：
 *   "segments" —— 该档位的默认模型会回句级时间戳（verbose_json），可直接用
 *   "none"     —— 默认模型只回纯文本，需要按静音切块重构时间轴
 *   "auto"     —— 先按 verbose_json 请求，拿不到 segments 就退回纯文本路径
 */
export const profiles = [
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
    /**
     * 硅基流动的**免费档不止一个语音模型**（2026-09 价格页口径）。
     * 面板会把这些列出来，用户只要改「模型」这一格就能换，不用改代码。
     *
     * ⚠ 免费模型清单平台会调整 ⇒ 以控制台「模型广场 / 价格页」的「免费」标记为准。
     * ⚠ 带 note 里写"可能带时间戳"的，**必须实测**：能拿到时间戳就用单次调用，
     *   拿不到就自动走"按静音切块重建"（两条路都已经实现，不需要改代码）。
     */
    altModels: [
      { id: "FunAudioLLM/SenseVoiceSmall", note: "免费 · 中文好 · 无时间戳（当前默认）" },
      { id: "Qwen/Qwen3-ASR-1.7B", note: "免费 · 通义千问 ASR 大模型 · 中文更强 · 可能带时间戳 ← 优先试这个" },
      { id: "TeleAI/TeleSpeechASR", note: "免费 · 中国电信 · 中文" },
    ],
    timestamps: "none",
    needsKey: true,
    keyPlaceholder: "sk-...",
    consoleUrl: "https://cloud.siliconflow.cn/account/ak",
    // 实测/文档口径：单文件 ≤ 50MB、时长 ≤ 1 小时（免费档）
    maxFileBytes: 50 * 1024 * 1024,
    maxDurationSec: 60 * 60,
    freeNote: "免费档模型不收费、不限量（有单文件 50MB / 1 小时上限）",
    region: "cn",
    reachableInCn: true,
  },
  {
    id: "groq",
    label: "Groq（Whisper 免费层）",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    altModels: [
      { id: "whisper-large-v3-turbo", note: "快 · 有句级时间戳" },
      { id: "whisper-large-v3", note: "更准 · 稍慢" },
    ],
    timestamps: "segments",
    needsKey: true,
    keyPlaceholder: "gsk_...",
    consoleUrl: "https://console.groq.com/keys",
    // 免费层口径：单文件 ≤ 25MB（付费档 100MB）
    maxFileBytes: 25 * 1024 * 1024,
    maxDurationSec: 60 * 60,
    freeNote: "免费层：约 2000 请求/日、8 小时音频/日、单文件 ≤ 25MB",
    region: "us",
    reachableInCn: false,   // 国内直连不通，需要代理
  },
  {
    id: "custom",
    label: "自建 / 其他 OpenAI 兼容服务",
    baseUrl: "",
    model: "",
    altModels: [],
    timestamps: "auto",
    needsKey: true,
    needsBaseUrl: true,     // 自建服务没有默认地址，必须由用户填
    keyPlaceholder: "按你的服务填写",
    consoleUrl: "",
    maxFileBytes: 50 * 1024 * 1024,
    maxDurationSec: 60 * 60,
    freeNote: "取决于你自己部署的服务（如 faster-whisper-server / vLLM）",
    region: "custom",
    reachableInCn: true,
  },
];

/** 找不到档位时退回第一个，保证调用方永远拿得到一个可用对象 */
export function getProfile(profileId) {
  return profiles.find((p) => p.id === profileId) || profiles[0];
}

const MIME = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
};

/**
 * 从服务商的**全量模型清单**里挑出"语音识别"相关的。
 *
 * 抽成独立纯函数是为了能被自测断言 —— 这段正则一旦写错，
 * 要么把该用的 ASR 模型滤掉（用户以为没有），要么把语音合成（TTS）混进来
 * （选了它会报错，而且报错信息完全看不出是"选错类型"）。
 *
 * 保留：asr / whisper / sensevoice / speech / audio / transcri
 * 排除：cosyvoice / tts / text-to-speech / voice-clone / voice-design / realtime
 *       （前几个是"文字转语音"，方向正好相反；realtime 是流式，本插件用不上）
 */
export function filterAsrModels(ids) {
  const KEEP = /asr|whisper|sensevoice|speech|audio|transcri/i;
  const DROP = /cosyvoice|tts|text-to-speech|voice-?clone|voice-?design|realtime/i;
  return (ids || []).map(String).filter((id) => KEEP.test(id) && !DROP.test(id)).sort();
}

/**
 * 向服务商要**它当前可用的模型清单**（OpenAI 兼容的 `GET {baseUrl}/models`）。
 *
 * 为什么需要它：各家免费模型清单一直在变，写死在代码里的列表迟早过期。
 * 直接问服务商拿，用户看到的就是**此刻真正能调用的**东西。
 *
 * 但有个现实问题：`/models` 返回的是**该账号可用的全部模型**（硅基流动有几百个，
 * 绝大多数是语言模型），对"选一个语音识别模型"毫无帮助。所以这里做一次**筛选**：
 *   保留：名字里带 asr / whisper / sensevoice / speech / audio / transcri 的
 *   排除：明显是语音合成/克隆的（cosyvoice / tts / voice-clone …），它们不能转写
 * 同时把"过滤掉了多少个"如实回报，避免用户以为清单不全。
 *
 * @returns {Promise<{ok:boolean, models:string[], total:number, filteredOut:number, detail:string}>}
 */
export async function listModels({ apiKey, baseUrl, timeoutMs = 20000 }) {
  if (!apiKey) return { ok: false, models: [], total: 0, filteredOut: 0, detail: "缺少 API Key" };
  if (!baseUrl) return { ok: false, models: [], total: 0, filteredOut: 0, detail: "缺少服务地址" };
  const url = baseUrl.replace(/\/+$/, "") + "/models";

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, models: [], total: 0, filteredOut: 0, detail: explainHttpError(res.status, body, baseUrl) };
    }
    let ids = [];
    try {
      const j = JSON.parse(body);
      const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
      ids = arr.map((m) => String((m && (m.id || m.name)) || "")).filter(Boolean);
    } catch {
      return { ok: false, models: [], total: 0, filteredOut: 0, detail: "服务商返回的模型清单无法解析：" + body.slice(0, 200) };
    }

    const keep = filterAsrModels(ids);
    return {
      ok: true,
      models: keep.sort(),
      total: ids.length,
      filteredOut: ids.length - keep.length,
      detail: `共 ${ids.length} 个模型，其中语音识别相关 ${keep.length} 个`,
    };
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, models: [], total: 0, filteredOut: 0, detail: `获取模型清单超时（${Math.round(timeoutMs / 1000)} 秒）` };
    }
    return { ok: false, models: [], total: 0, filteredOut: 0, detail: `连不上 ${url}：${(err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 把服务商返回的英文错误，翻译成"能照着动手"的中文 */export function explainHttpError(status, bodyText, baseUrl) {
  const body = String(bodyText || "").slice(0, 400);
  if (status === 401 || status === 403) {
    return `鉴权失败（HTTP ${status}）：API Key 不对、已失效，或没有开通该模型。\n${body}`;
  }
  if (status === 404) {
    return `接口地址不对（HTTP 404）：请检查服务地址是否为 ${baseUrl || "(空)"}，` +
      `注意要带 /v1 且程序会自动补 /audio/transcriptions。\n${body}`;
  }
  if (status === 413) {
    return `音频太大被拒（HTTP 413）：该服务商单文件体积上限更小，请缩短处理区间。\n${body}`;
  }
  if (status === 429) {
    return `超出速率/额度限制（HTTP 429）：免费额度用完了或请求太密，稍后再试或换服务商。\n${body}`;
  }
  if (status >= 500) {
    return `服务商内部错误（HTTP ${status}）：通常是对方临时故障，稍后重试。\n${body}`;
  }
  return `请求失败（HTTP ${status}）：${body}`;
}

/**
 * 调一次转写（**单个音频文件**）。
 *
 * 这个函数是"哑"的：不知道时间戳、不管切块，只管把这一份音频发出去、把原始响应拿回来。
 * 切块与时间轴重构都在上层（lib/asr.js + lib/align.js）做，这样职责单一、好测。
 *
 * @param {object} p
 * @param {string} p.file        音频文件绝对路径
 * @param {string} p.apiKey      密钥（必填）
 * @param {string} p.baseUrl     形如 https://api.siliconflow.cn/v1
 * @param {string} p.model       模型 id
 * @param {"verbose_json"|"json"} [p.responseFormat]
 * @param {string} [p.language]  语言提示（如 zh），留空由模型自判
 * @param {string} [p.prompt]    上下文提示词，能显著提升专有名词准确率
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{text:string, segments:Array|null, raw:object}>}
 */
export async function transcribeFile(p) {
  const {
    file, apiKey, baseUrl, model,
    responseFormat = "json", language, prompt,
    timeoutMs = 15 * 60 * 1000, signal, onProgress,
  } = p;

  if (!apiKey) throw new Error("缺少 API Key：请在面板「识别选项」里填写，或设置环境变量（见 README）");
  if (!file || !fs.existsSync(file)) throw new Error(`音频文件不存在：${file}`);
  if (!baseUrl) throw new Error("缺少服务地址 baseUrl");
  if (!model) throw new Error("缺少模型名 model");

  const url = baseUrl.replace(/\/+$/, "") + "/audio/transcriptions";
  const buf = await fs.promises.readFile(file);
  const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), path.basename(file));
  form.append("model", model);
  form.append("response_format", responseFormat);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  if (responseFormat === "verbose_json") {
    // OpenAI 语义：要句级时间戳。不支持的实现会忽略或直接报错，由上层降级处理。
    form.append("timestamp_granularities[]", "segment");
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  if (onProgress) onProgress(10, `上传到 ${new URL(url).host}（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`请求超时或被取消（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(
      `连不上 ${url}：${err && err.message ? err.message : err}\n` +
      `排查：① 需要联网；② 若该服务在境外（如 Groq），国内网络可能直连不通；` +
      `③ 换个服务商试试（面板「识别选项 → 引擎」）。`
    );
  }
  clearTimeout(timer);

  const bodyText = await res.text();

  if (!res.ok) {
    // 有些实现不支持 verbose_json：退回普通 json 再试一次，别让用户卡在一个格式上
    if (responseFormat === "verbose_json" && (res.status === 400 || res.status === 422)) {
      return transcribeFile({ ...p, responseFormat: "json" });
    }
    throw new Error(explainHttpError(res.status, bodyText, baseUrl));
  }

  let raw;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    // 少数实现会直接回纯文本
    return { text: String(bodyText || "").trim(), segments: null, raw: { text: bodyText } };
  }

  const text = typeof raw.text === "string" ? raw.text : "";
  const segments = normalizeUpstreamSegments(raw.segments);
  if (onProgress) onProgress(100, segments ? `识别完成：${segments.length} 句` : `识别完成：${text.length} 字（无时间戳）`);

  return { text, segments, raw };
}

/** 把服务商返回的 segments（秒为单位）换算成我们的统一格式（毫秒） */
function normalizeUpstreamSegments(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const s of list) {
    if (!s) continue;
    const t = String(s.text || "").trim();
    if (!t) continue;
    const startMs = Math.max(0, Math.round(Number(s.start) * 1000) || 0);
    const endMs = Math.max(0, Math.round(Number(s.end) * 1000) || 0);
    if (!(endMs > startMs)) continue;
    out.push({ text: t, startMs, endMs });
  }
  return out.length ? out : null;
}

/**
 * 密钥自检（**不消耗识别额度**）：拉一次模型列表。
 *
 * OpenAI 兼容的服务基本都实现 `GET {baseUrl}/models`，这是最便宜的鉴权探针 ——
 * 不传音频、不计费，只看 401 还是 200。
 *
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function ping({ apiKey, baseUrl, timeoutMs = 20 * 1000 }) {
  if (!apiKey) return { ok: false, detail: "缺少 API Key" };
  if (!baseUrl) return { ok: false, detail: "缺少服务地址" };
  const url = baseUrl.replace(/\/+$/, "") + "/models";

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    const body = await res.text();
    if (res.ok) {
      let n = null;
      try { n = (JSON.parse(body).data || []).length; } catch { /* 有些实现不返回 data */ }
      return { ok: true, detail: "鉴权通过" + (n ? `（该服务列出 ${n} 个模型）` : "") };
    }
    return { ok: false, detail: explainHttpError(res.status, body, baseUrl) };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, detail: `自检超时（${Math.round(timeoutMs / 1000)} 秒）` };
    return { ok: false, detail: `连不上 ${url}：${(err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
}
