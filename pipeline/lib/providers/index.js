/**
 * providers/index.js —— ASR 服务商注册表
 * ==================================================================
 * 目的：把"识别"这件事从某个具体服务商里**解耦**出来。
 *
 * 为什么值得为此多写一层：
 *   旧版把剪映逆向接口写死在 lib/asr.js 里，结果那套接口一旦失效/被风控，
 *   整个插件就没有识别能力；而且它带着 GPL-3.0 与"逆向调用"两重风险，没法商用。
 *   现在这一层让"换服务商"= 改一个字符串（profileId），而不是改代码。
 *
 * 一个 provider 模块对外必须导出：
 *   id / label            —— 面板展示用
 *   profiles[]            —— 档位（含 baseUrl、默认模型、免费额度说明、体积/时长上限、
 *                            timestamps 能力、是否需要"一对密钥"）
 *   transcribeFile(args)  —— **单个音频文件** → { text, segments|null, raw }
 *
 * 上层（lib/asr.js）负责：挑档位、按上限切块、把时间戳拼回全局时间轴。
 * 本层只负责"怎么和这一家说话"。
 */

import * as openaiCompat from "./openai-compat.js";
import * as tencent from "./tencent.js";
import * as local from "./local.js";

// ⚠ 这个数组的顺序 = 面板下拉里的顺序：云端在前、本地在后
// （本地那条要用户先下模型才能用，不适合当默认；默认仍是免费云端档）
const MODULES = [openaiCompat, tencent, local];

/** 默认档位：免费、国内直连、中文好。免费档没有额度焦虑，适合当默认。 */
export const DEFAULT_PROVIDER = "openai-compat";
export const DEFAULT_PROFILE = "siliconflow";

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

/** 拿一个 provider 模块；找不到就抛出带清单的错误（不静默退回，避免用户以为在用 A 其实在用 B） */
export function getProvider(providerId) {
  const m = BY_ID.get(String(providerId || ""));
  if (!m) {
    throw new Error(
      `不认识的服务商「${providerId}」。可用：${[...BY_ID.keys()].join(" / ")}`
    );
  }
  return m;
}

/** 所有档位拍平成一个列表，供面板渲染下拉框 */
export function listProfiles() {
  const out = [];
  for (const m of MODULES) {
    for (const p of m.profiles) {
      out.push({
        provider: m.id,
        providerLabel: m.label,
        profile: p.id,
        label: p.label,
        baseUrl: p.baseUrl || "",
        model: p.model || (p.engine || ""),
        models: (p.altModels || p.engines || []).map((x) => ({ id: x.id, note: x.note || "" })),
        timestamps: p.timestamps,
        keyMode: p.keyMode || "single",
        needsKey: p.needsKey !== false,
        needsBaseUrl: !!p.needsBaseUrl,
        keyLabels: p.keyLabels || null,
        keyPlaceholder: p.keyPlaceholder || "",
        consoleUrl: p.consoleUrl || "",
        maxFileBytes: p.maxFileBytes || 0,
        maxDurationSec: p.maxDurationSec || 0,
        preferCompressed: !!p.preferCompressed,
        freeNote: p.freeNote || "",
        reachableInCn: p.reachableInCn !== false,
      });
    }
  }
  return out;
}

/** 找档位；返回 { provider, profile }，两个都找不到就抛错 */
export function resolve(providerId, profileId) {
  const mod = getProvider(providerId);
  const profile = mod.profiles.find((p) => p.id === profileId) || mod.profiles[0];
  return { provider: mod, profile };
}

/**
 * 统一入口：调**单个音频文件**的转写。
 *
 * 凭据统一用 credentials 包着传，因为各家形态不同：
 *   单密钥（Bearer）：{ apiKey }
 *   一对密钥（腾讯云）  ：{ secretId, secretKey }
 * 这样上层不用为每家分支，新增服务商也不用改这里。
 *
 * @returns {Promise<{text:string, segments:Array|null, raw:object}>}
 */
export async function transcribeFile({ providerId, profileId, credentials = {}, model, baseUrl, ...rest }) {
  const { provider, profile } = resolve(providerId, profileId);

  if (provider.id === "openai-compat") {
    return provider.transcribeFile({
      ...rest,
      apiKey: credentials.apiKey,
      baseUrl: baseUrl || profile.baseUrl,
      model: model || profile.model,
      responseFormat: rest.responseFormat || (profile.timestamps === "segments" ? "verbose_json" : "json"),
    });
  }

  if (provider.id === "tencent") {
    return provider.transcribeFile({
      ...rest,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
      engine: model || profile.engine,
      region: profile.region || "",
    });
  }

  // 兜底：provider 自带 transcribeFile 就透传（新增服务商时不必改这个文件的结构）
  // 走这条的典型是 local（whisper.cpp）：它只要 file 与档位（model），密钥/地址都不需要。
  return provider.transcribeFile({ ...rest, ...credentials, model, baseUrl });
}

/**
 * 密钥自检（**不消耗识别额度**）—— 面板上「测试密钥」按钮走这条。
 * 目的：让用户在真正跑一遍长流水线之前，就知道自己的密钥/地址/模型是否配对了。
 *
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function ping({ providerId, profileId, credentials = {}, baseUrl }) {
  const { provider, profile } = resolve(providerId, profileId);
  if (typeof provider.ping !== "function") {
    return { ok: false, detail: `「${profile.label}」暂不支持密钥自检` };
  }
  if (provider.id === "openai-compat") {
    return provider.ping({ apiKey: credentials.apiKey, baseUrl: baseUrl || profile.baseUrl });
  }
  return provider.ping({ ...credentials, region: profile.region || "" });
}

/**
 * 向服务商索取**当前可用模型清单**。
 *
 * 为什么值得单独一个接口：写死在代码里的模型列表一定会过期，
 * 而"免费档有哪些模型"这件事各家都在改。直接问服务商最准。
 *
 * 不支持该能力的档位不报错，而是回退到档位内置清单 ——
 * 例如腾讯云的引擎（16k_zh 等）本来就是固定几个，内置清单反而更清晰。
 *
 * @returns {Promise<{ok:boolean, models:string[], total:number, filteredOut:number, detail:string, source?:string}>}
 */
export async function listModels({ providerId, profileId, credentials = {}, baseUrl }) {
  const { provider, profile } = resolve(providerId, profileId);
  if (typeof provider.listModels === "function") {
    if (provider.id === "openai-compat") {
      return provider.listModels({ apiKey: credentials.apiKey, baseUrl: baseUrl || profile.baseUrl });
    }
    return provider.listModels({ ...credentials, region: profile.region || "" });
  }
  const builtin = (profile.altModels || profile.engines || []).map((x) => x.id);
  return {
    ok: true,
    models: builtin,
    total: builtin.length,
    filteredOut: 0,
    source: "builtin",
    detail: `「${profile.label || profileId}」的可用模型是固定的，已列出内置清单`,
  };
}
