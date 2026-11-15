/**
 * 配置读写：把扩展设置整理成一个纯对象形状，带默认值和类型夹取。
 *
 * 所有 provider 共用一套字段，缺省值向「能跑」而不是「最好看」倾斜。
 */

export const SETTINGS_KEY = 'illust_marker';

export const DEFAULTS = {
    /* 总开关 */
    enabled: true,
    mode: 'auto', // auto | button

    /* 后端选择 */
    backend: 'relay', // relay | a1111 | tavern

    /* 中转站直连（默认留空，由用户填自己的服务；不要在这里写死任何第三方地址） */
    relayBaseUrl: '',
    relayApiKey: '',
    relayModel: '',

    /* A1111 / 适配器 */
    a1111Url: 'http://127.0.0.1:7860',
    a1111Model: '',
    a1111Sampler: 'Euler a',
    a1111User: '',
    a1111Pass: '',

    /* 酒馆「图像生成」后端地址（留空则沿用酒馆自己的配置） */
    adapterUrl: '',

    /* 提示词 */
    useTagsOnly: true,
    weightMode: 'strip', // strip | a1111 | raw
    prefix: 'masterpiece, best quality, ',
    negative: 'lowres, bad anatomy, worst quality, watermark, signature, text',

    /* 出图参数 */
    width: 832,
    height: 1216,
    steps: 25,
    cfg: 5,
    seed: -1, // -1 = 随机
    batch: 1, // 1–4

    /* 交互 */
    maxPerMessage: 1,
    privacyMode: false,
    showFab: true,
    notifyDone: true,
    vibrate: true,
    fabPos: null,

    /* 高级 */
    retryOnBlank: true,
    maxAttempts: 2,
    minIntervalMs: 0,
};

export const BACKENDS = ['relay', 'a1111', 'tavern'];
export const WEIGHT_MODES = ['strip', 'a1111', 'raw'];

/** 把任意值夹成整数范围内的安全值 */
export function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function asBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function asEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

/**
 * 归一化一份设置：补齐默认值 + 夹取范围 + 丢弃未知枚举。
 * 返回新对象，调用方直接替换即可（避免「半新半旧」的状态）。
 */
export function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};

    return {
        enabled: asBool(src.enabled, DEFAULTS.enabled),
        mode: asEnum(src.mode, ['auto', 'button'], DEFAULTS.mode),
        backend: asEnum(src.backend, BACKENDS, DEFAULTS.backend),

        relayBaseUrl: String(src.relayBaseUrl ?? DEFAULTS.relayBaseUrl),
        relayApiKey: String(src.relayApiKey ?? DEFAULTS.relayApiKey),
        relayModel: String(src.relayModel ?? DEFAULTS.relayModel),

        a1111Url: String(src.a1111Url ?? DEFAULTS.a1111Url),
        a1111Model: String(src.a1111Model ?? DEFAULTS.a1111Model),
        a1111Sampler: String(src.a1111Sampler ?? DEFAULTS.a1111Sampler),
        a1111User: String(src.a1111User ?? DEFAULTS.a1111User),
        a1111Pass: String(src.a1111Pass ?? DEFAULTS.a1111Pass),

        adapterUrl: String(src.adapterUrl ?? DEFAULTS.adapterUrl),

        useTagsOnly: asBool(src.useTagsOnly, DEFAULTS.useTagsOnly),
        weightMode: asEnum(src.weightMode, WEIGHT_MODES, DEFAULTS.weightMode),
        prefix: String(src.prefix ?? DEFAULTS.prefix),
        negative: String(src.negative ?? DEFAULTS.negative),

        width: clampInt(src.width, 256, 1344, DEFAULTS.width),
        height: clampInt(src.height, 256, 1344, DEFAULTS.height),
        steps: clampInt(src.steps, 1, 50, DEFAULTS.steps),
        cfg: Math.min(20, Math.max(0, Number(src.cfg) || DEFAULTS.cfg)),
        seed: clampInt(src.seed ?? DEFAULTS.seed, -1, 999999999, -1),
        batch: clampInt(src.batch, 1, 4, DEFAULTS.batch),

        maxPerMessage: clampInt(src.maxPerMessage, 1, 4, DEFAULTS.maxPerMessage),
        privacyMode: asBool(src.privacyMode, DEFAULTS.privacyMode),
        showFab: asBool(src.showFab, DEFAULTS.showFab),
        notifyDone: asBool(src.notifyDone, DEFAULTS.notifyDone),
        vibrate: asBool(src.vibrate, DEFAULTS.vibrate),
        fabPos: src.fabPos && typeof src.fabPos === 'object' ? {
            x: Number(src.fabPos.x) || 0,
            y: Number(src.fabPos.y) || 0,
        } : null,

        retryOnBlank: asBool(src.retryOnBlank, DEFAULTS.retryOnBlank),
        maxAttempts: clampInt(src.maxAttempts, 1, 5, DEFAULTS.maxAttempts),
        minIntervalMs: clampInt(src.minIntervalMs, 0, 120000, DEFAULTS.minIntervalMs),
    };
}

/**
 * 旧版本（纯 ST 适配器版）的设置迁移。
 * 旧字段：weightMode / adapterUrl / width / height / steps / cfg 保持不变；
 * 只要没设置过后端，就默认当成 tavern，让它继续走原来的路线。
 */
export function migrateLegacy(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.backend) return raw;

    const isAdapterUser = String(raw.adapterUrl || '').trim().length > 0;
    return { ...raw, backend: isAdapterUser ? 'tavern' : DEFAULTS.backend };
}
