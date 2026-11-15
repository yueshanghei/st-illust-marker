/**
 * 生图后端（provider）注册表
 *
 * 扩展本身不认识任何一种后端，只按名字取一个 provider：
 *
 *   relay   —— 中转站（OpenAI 风格 POST /v1/images/generations），不依赖任何本机服务
 *   a1111   —— 标准 A1111 / Forge / SD.Next 的 /sdapi/v1/txt2img
 *   tavern  —— 交给酒馆自己的「图像生成」后端（/api/sd/generate 透传）
 *
 * 每个 provider 实现：
 *
 *   listModels(settings)  -> Promise<string[]>       可选，返回可选的模型名
 *   generate(settings, request) -> Promise<string>   必填，返回 base64（不带 data: 前缀）
 *
 * request 的结构：
 *   { prompt, negativePrompt, width, height, steps, cfgScale, seed, batchSize, model }
 *
 * 出错时抛 `IllustError`，message 是给用户看的中文短句。
 */

export class IllustError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'IllustError';
        if (cause !== undefined) this.cause = cause;
    }
}

const PROVIDERS = new Map();

/** 注册一个 provider；后注册的同名会覆盖先注册的 */
export function registerProvider(id, provider) {
    PROVIDERS.set(id, provider);
}

export function getProvider(id) {
    const provider = PROVIDERS.get(id);
    if (!provider) {
        throw new IllustError(`未知的生图后端：${id}`);
    }
    return provider;
}

export function providerIds() {
    return [...PROVIDERS.keys()];
}

/**
 * 内置 provider 的「注册器」。
 *
 * 不用 `export { x } from './x.js'` 中转：单文件构建时那样会变成顶层重复声明。
 * 统一改成函数，由入口显式调用完成注册。
 */
export function registerBuiltinProviders(relay, a1111, tavern) {
    if (relay) registerProvider('relay', relay);
    if (a1111) registerProvider('a1111', a1111);
    if (tavern) registerProvider('tavern', tavern);
}

/* ------------------------------------------------------------------ */
/* 共用的 fetch 封装                                                   */
/* ------------------------------------------------------------------ */

export const DEFAULT_TIMEOUT_MS = 180000;

/**
 * 带超时和错误归一的 fetch。
 * 中转站慢的时候 26–90 秒都正常，所以默认给 3 分钟。
 */
export async function fetchJson(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, what = '生图服务' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new IllustError(`${what}超时（${Math.round(timeoutMs / 1000)} 秒）`, error);
        }
        throw new IllustError(`连不上${what}，检查地址和网络（代理）`, error);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        let detail = '';
        try {
            const raw = await res.text();
            detail = raw.slice(0, 300);
        } catch { /* ignore */ }

        if (res.status === 401 || res.status === 403) {
            throw new IllustError(`${what}鉴权失败（${res.status}），检查 API Key`, detail);
        }
        if (res.status === 429) {
            throw new IllustError(`${what}触发限流（429），等一会儿再试`, detail);
        }
        throw new IllustError(`${what}返回 ${res.status}${detail ? `：${detail}` : ''}`);
    }

    try {
        return await res.json();
    } catch (error) {
        throw new IllustError(`${what}返回的不是 JSON`, error);
    }
}

/* ------------------------------------------------------------------ */
/* 内置 provider 由入口显式注册，见 registerBuiltinProviders()          */
/* ------------------------------------------------------------------ */
