/**
 * 插图标记自动配图 (illust-marker) —— 单文件构建产物
 *
 * 这个文件由 `node build.mjs` 从 lib/ 与 index.js 生成，请勿直接编辑；
 * 修改源码后重新构建。
 *
 * 为什么要打成单文件：
 *   SillyTavern 的静态端点 /scripts/extensions/<name>/* 只服务扩展根目录，
 *   根目录下的 ESM 可以正常加载，但任何子目录都会 404。而它的扩展加载器
 *   是 script.onload 驱动的 —— 模块加载失败时 onload 不触发，加载器会
 *   永久挂起，排在后面的扩展全部起不来。所以这里把全部模块内联成一份。
 *
 * 生成的代码按依赖顺序拼接，模块间通过闭包共享同一个作用域，
 * 因此去掉了 import/export 语句，仅保留实现。
 */

/* ===== lib/host.js ===== */
/**
 * 宿主适配层
 *
 * 这个扩展不再把 `/script.js` 当成唯一的入口假设，而是把「哪些能力可用」
 * 收敛到这一层。目标是同一份代码能跑在：
 *
 *   - 原版 SillyTavern（Node 后端，通过 /api/* 调服务端）
 *   - TauriTavern（Rust 后端，/api/* 由前端拦截器接管，未实现的路由返回 404）
 *   - 任何支持 ESM 扩展的兼容前端（能力缺失全部降级，不抛异常）
 *
 * 约定：这里所有能力都允许「不存在」。调用方要么用 `host.has*` 判断，
 * 要么走 `host.try*` 包装过的安全版本。绝不在导入期对宿主做出硬性依赖。
 */


/* ------------------------------------------------------------------ */
/* 全局符号探测                                                        */
/* ------------------------------------------------------------------ */

function globals() {
    return typeof globalThis === 'object' && globalThis ? globalThis : {};
}

function isTauriTavern() {
    const g = globals();
    return !!(g.__TAURITAVERN__ || g.__TAURI_RUNNING__ || g.__TAURI_INTERNALS__);
}

function isMobileHost() {
    const g = globals();
    const api = g.__TAURITAVERN__;
    try {
        if (typeof api?.isMobileHost === 'function') return !!api.isMobileHost();
        if (typeof api?.host?.kind === 'string') return api.host.kind === 'mobile';
    } catch { /* ignore */ }
    return false;
}

/** 宿主标识，仅用于日志和设置面板展示，不参与任何逻辑分支 */
function hostName() {
    if (isTauriTavern()) return 'TauriTavern';
    if (globals().__ST_USER_HANDLE__ || globals().SillyTavern) return 'SillyTavern';
    return 'Unknown';
}

/* ------------------------------------------------------------------ */
/* 核心模块                                                            */
/* ------------------------------------------------------------------ */

async function tryImport(path) {
    try {
        return await import(path);
    } catch {
        return null;
    }
}

/** 从候选模块里按顺序取第一个存在的导出 */
function pick(modules, ...names) {
    for (const mod of modules) {
        if (!mod) continue;
        for (const name of names) {
            const value = mod[name];
            if (value !== undefined && value !== null) return value;
        }
    }
    return undefined;
}

let corePromise = null;

/**
 * 惰性加载宿主核心模块。
 * 使用动态 import：某个路径 404 只会让对应槽位为 null，
 * 不会像顶层静态 import 那样让整个扩展加载失败。
 */
function loadCore() {
    if (corePromise) return corePromise;

    corePromise = (async () => {
        const [script, extensions, utils] = await Promise.all([
            tryImport('/script.js'),
            tryImport('/scripts/extensions.js'),
            tryImport('/scripts/utils.js'),
        ]);

        const mods = [script, extensions, utils];

        return {
            script,
            extensions,
            utils,
            eventSource: pick(mods, 'eventSource', 'EventSourceInstance'),
            eventTypes: pick(mods, 'event_types', 'eventTypes') || {},
            extensionSettings: pick(mods, 'extension_settings', 'extensionSettings'),
            getContext: pick(mods, 'getContext'),
            getRequestHeaders: pick(mods, 'getRequestHeaders'),
            saveChat: pick(mods, 'saveChat'),
            saveChatDebounced: pick(mods, 'saveChatDebounced'),
            saveSettingsDebounced: pick(mods, 'saveSettingsDebounced'),
            saveBase64AsFile: pick(mods, 'saveBase64AsFile'),
            getCurrentChatId: pick(mods, 'getCurrentChatId'),
            isSendPress: pick(mods, 'is_send_press'),
        };
    })();

    return corePromise;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 设置对象挂在哪：
 *   1. SillyTavern 的 extension_settings（与官方扩展面板共用、随设置一起同步）
 *   2. 都没有时退化为内存对象（刷新丢失，但不崩）
 *
 * 注意：SillyTavern 的 `extension_settings` 是 /scripts/extensions.js 的
 * **模块导出**，并不挂在 window 上。所以必须先动态 import 拿到引用，
 * 再把它缓存下来供同步读取使用（见 resolveSettingsStore）。
 */
const memorySettings = {};

/** 解析出来的真实设置容器；null = 还没解析过 */
let resolvedStore = null;
let resolvePromise = null;

/**
 * 解析并缓存设置容器。幂等，可以多次调用。
 * 必须在读取设置之前 await 一次（start() 里会做）。
 */
function resolveSettingsStore() {
    if (resolvePromise) return resolvePromise;

    resolvePromise = (async () => {
        const core = await loadCore();
        const g = globals();

        const candidate =
            (core.extensionSettings && typeof core.extensionSettings === 'object' && core.extensionSettings) ||
            (g.extension_settings && typeof g.extension_settings === 'object' && g.extension_settings) ||
            null;

        resolvedStore = candidate;
        return candidate ? { store: candidate, persistent: true } : { store: memorySettings, persistent: false };
    })();

    return resolvePromise;
}

/** 同步读取已解析的设置容器；未解析时退回 window 上的同名对象 */
function settingsStoreRef() {
    if (resolvedStore) return { store: resolvedStore, persistent: true };

    const g = globals();
    const fallback = g.extension_settings;
    if (fallback && typeof fallback === 'object') return { store: fallback, persistent: true };
    return { store: memorySettings, persistent: false };
}

async function getSettingsStore() {
    return resolveSettingsStore();
}

async function saveSettings() {
    const core = await loadCore();
    if (typeof core.saveSettingsDebounced === 'function') {
        try { core.saveSettingsDebounced(); } catch { /* ignore */ }
    }
}

/* ------------------------------------------------------------------ */
/* 聊天上下文                                                          */
/* ------------------------------------------------------------------ */

async function getChat() {
    const core = await loadCore();
    if (typeof core.getContext === 'function') {
        try {
            const ctx = core.getContext();
            if (Array.isArray(ctx?.chat)) return ctx.chat;
        } catch { /* ignore */ }
    }
    return [];
}

async function saveChat() {
    const core = await loadCore();
    const fn = core.saveChatDebounced || core.saveChat;
    if (typeof fn === 'function') {
        try { fn(); return true; } catch { /* ignore */ }
    }
    return false;
}

async function getCharacterName() {
    const core = await loadCore();
    if (typeof core.getContext === 'function') {
        try {
            const ctx = core.getContext();
            return String(ctx?.name2 || ctx?.characterName || ctx?.name || '') || '';
        } catch { /* ignore */ }
    }
    return '';
}

/* ------------------------------------------------------------------ */
/* 事件总线                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统一的事件订阅。宿主没有 eventSource 时返回 false，
 * 调用方应退化为 MutationObserver 轮询方案（index.js 里已实现）。
 */
async function onHostEvent(names, handler) {
    const core = await loadCore();
    const source = core.eventSource;
    if (!source || typeof source.on !== 'function') return [];

    const bound = [];
    for (const name of names) {
        const key = core.eventTypes?.[name];
        if (!key) continue;
        try {
            source.on(key, handler);
            bound.push(key);
        } catch { /* ignore */ }
    }
    return bound;
}

/** 把宿主事件名映射成实际的字符串（没有 event_types 时返回空） */
async function eventKey(name) {
    const core = await loadCore();
    return core.eventTypes?.[name] || null;
}

/* ------------------------------------------------------------------ */
/* 请求头                                                              */
/* ------------------------------------------------------------------ */

/**
 * 构造带鉴权的请求头。
 * ST 的 getRequestHeaders 会附加 CSRF token 和 Basic Auth；
 * TauriTavern 由前端拦截器处理 CSRF，这里同样兼容。
 */
async function requestHeaders(extra = {}) {
    const core = await loadCore();
    let base = {};
    if (typeof core.getRequestHeaders === 'function') {
        try {
            base = core.getRequestHeaders() || {};
        } catch { /* ignore */ }
    }
    if (base['Content-Type'] === undefined) base['Content-Type'] = 'application/json';
    return { ...base, ...extra };
}

/* ------------------------------------------------------------------ */
/* 图片落盘                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把 base64 图片变成可引用的 URL。
 *
 * 优先用宿主的 saveBase64AsFile（写到 user/images，刷新后仍在）。
 * 宿主没有这个能力时（例如某些精简前端），退化为 data: URL —— 图片会
 * 直接存进聊天记录的 extra 里，体积大但不会丢图。
 */
async function persistImage(base64, folder, name) {
    const core = await loadCore();

    if (typeof core.saveBase64AsFile === 'function') {
        try {
            const url = await core.saveBase64AsFile(base64, folder, name, 'png');
            if (url) return { url, mode: 'file' };
        } catch (error) {
            console.warn('[illust-marker] saveBase64AsFile failed, falling back to data URL', error);
        }
    }

    const data = String(base64 || '');
    const mime = data.startsWith('/9j/') ? 'jpeg' : 'png';
    return { url: `data:image/${mime};base64,${data}`, mode: 'data-url' };
}

/** 删除已落盘的图片；data: URL 直接忽略 */
async function removeImage(url) {
    if (!url || String(url).startsWith('data:')) return false;

    try {
        const headers = await requestHeaders();
        const res = await fetch('/api/images/delete', {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: url }),
        });
        return res.ok;
    } catch (error) {
        console.warn('[illust-marker] delete image failed', error);
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* 文件名                                                              */
/* ------------------------------------------------------------------ */

/**
 * 与 SillyTavern 服务端一致的文件夹名清洗。
 *
 * ST 服务端用 sanitize-filename 清洗目录名，非法字符会被替换成 `_`，
 * 所以客户端也必须用同样的规则，否则 `/api/images/delete` 会因为路径
 * 对不上而删不掉文件。
 */
const ILLEGAL_FILENAME_RE = /[<>:"/\\|?*\u0000-\u001F]/g;

function sanitizeFolderName(name) {
    const cleaned = String(name || '')
        .replace(ILLEGAL_FILENAME_RE, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .trim();
    return cleaned || 'illust';
}

/* ------------------------------------------------------------------ */
/* 宿主能力清单（给设置面板展示）                                       */
/* ------------------------------------------------------------------ */

async function capabilities() {
    const core = await loadCore();
    return {
        host: hostName(),
        tauriTavern: isTauriTavern(),
        mobile: isMobileHost(),
        events: !!core.eventSource,
        settings: !!(core.extensionSettings || globals().extension_settings),
        saveFile: typeof core.saveBase64AsFile === 'function',
        headers: typeof core.getRequestHeaders === 'function',
    };
}

/* ===== lib/settings.js ===== */
/**
 * 配置读写：把扩展设置整理成一个纯对象形状，带默认值和类型夹取。
 *
 * 所有 provider 共用一套字段，缺省值向「能跑」而不是「最好看」倾斜。
 */

const SETTINGS_KEY = 'illust_marker';

const DEFAULTS = {
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

const BACKENDS = ['relay', 'a1111', 'tavern'];
const WEIGHT_MODES = ['strip', 'a1111', 'raw'];

/** 把任意值夹成整数范围内的安全值 */
function clampInt(value, min, max, fallback) {
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
function normalizeSettings(raw) {
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
function migrateLegacy(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.backend) return raw;

    const isAdapterUser = String(raw.adapterUrl || '').trim().length > 0;
    return { ...raw, backend: isAdapterUser ? 'tavern' : DEFAULTS.backend };
}

/* ===== lib/prompt.js ===== */
/**
 * 提示词预处理
 *
 * 很多提示词是从 NovelAI 直接抄来的：`0.6::tag::`、`[tag]`、`{tag}`。
 * SDXL / illustrious 类后端不认这些语法，会被当成普通文字塞进 CLIP，
 * 所以要按用户选的档位转换：
 *
 *   strip —— 去掉语法只留标签（默认，最稳）
 *   a1111 —— 转成 `(tag:0.9)` 形式的 A1111 权重
 *   raw   —— 原样发送
 *
 * 已经有 A1111 含义的写法会被保留：`[a|b]`（交替）、
 * `[from:to:0.5]`（阶段切换）、`(tag:1.2)` 都不动。
 */

/**
 * `0.6::a, b::` 的权重组。
 * 前面那个字符不能是 `:`（避免切到 `artist:40hara` 之类），也不能是词字符。
 */
const WEIGHT_GROUP_RE = /(^|[^:\w.\-])(-?\d*\.?\d+)::([\s\S]*?)::/g;

/** 只处理"看着像 NovelAI 括号"的片段：里面没有 `|`（A1111 的 a|b）也没有 `:`（from:to:when） */
const BRACKET_RE = /\[\s*([^[\]{}|:]+?)\s*\]/g;
const BRACE_RE = /\{\s*([^[\]{}|:]+?)\s*\}/g;

/** 提示词上限。各家后端都会截断，这里提前截，免得白传 */
const PROMPT_LIMIT = 1500;

function tidyTags(text) {
    return String(text || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .replace(/(^|,)\s*,+/g, '$1 ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();
}

/** 去掉 `0.6::…::`、`[x]`、`{x}`，只保留里面的标签 */
function stripWeights(text) {
    let s = String(text || '');
    if (!s) return '';

    s = s.replace(WEIGHT_GROUP_RE, (m, pre, weight, inner) => pre + inner);

    // 嵌套括号最多处理 6 层，多一层也没意义
    for (let k = 0; k < 6; k++) {
        const before = s;
        s = s.replace(BRACKET_RE, '$1').replace(BRACE_RE, '$1');
        if (s === before) break;
    }
    return tidyTags(s);
}

/** `0.6::a, b::` → `(a, b:0.6)`；`[x]` → `(x:0.9)`；`{x}` → `(x:1.05)` */
function toA1111Weights(text) {
    let s = String(text || '');
    if (!s) return '';

    s = s.replace(WEIGHT_GROUP_RE, (m, pre, weight, inner) => `${pre}(${inner.trim()}:${weight})`);

    for (let k = 0; k < 6; k++) {
        const before = s;
        s = s.replace(BRACKET_RE, '($1:0.9)').replace(BRACE_RE, '($1:1.05)');
        if (s === before) break;
    }
    return tidyTags(s);
}

/** 按档位转换并截断 */
function normalizePrompt(text, mode = 'strip') {
    const raw = String(text || '').trim();
    if (mode === 'raw') return raw.slice(0, PROMPT_LIMIT);
    if (mode === 'a1111') return toA1111Weights(raw).slice(0, PROMPT_LIMIT);
    return stripWeights(raw).slice(0, PROMPT_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 标记解析                                                            */
/* ------------------------------------------------------------------ */

const MARKER_OPEN = '[ILLUST:';

/**
 * 从 start 开始找配对的 `]`。
 * 提示词里允许出现 `[ke-ta]`、`[modare]` 这种方括号，所以要按括号层级配对，
 * 不能简单找第一个 `]`（否则标记会被截断）。
 */
function scanMarkerAt(text, start) {
    if (!text.startsWith(MARKER_OPEN, start)) return null;

    let depth = 0;
    // 单个标记最多 4000 字符，超了就当没找到，避免大段文本拖慢
    const limit = Math.min(text.length, start + 4000);
    for (let i = start; i < limit; i++) {
        const ch = text[i];
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) return { start, end: i };
        }
    }
    return null;
}

/** djb2，用来给每个标记生成一个稳定的 key（存进 message.extra 当索引） */
function hash(str) {
    let h = 5381;
    for (let i = 0; i < String(str).length; i++) h = ((h * 33) ^ String(str).charCodeAt(i)) >>> 0;
    return h.toString(16);
}

/**
 * 解析正文里的所有标记。
 *
 * 格式：`[ILLUST: 自然语言描述 | danbooru,tags]`
 *   - 竖线前：描述，默认不用
 *   - 竖线后：Danbooru 标签，默认只用这段
 */
function parseMarkers(text) {
    const out = [];
    if (!text) return out;

    let i = 0;
    while (i < text.length) {
        const start = text.indexOf(MARKER_OPEN, i);
        if (start === -1) break;

        const hit = scanMarkerAt(text, start);
        if (!hit) {
            i = start + MARKER_OPEN.length;
            continue;
        }

        const marker = text.slice(hit.start, hit.end + 1);
        const body = marker.slice(MARKER_OPEN.length, -1);
        const pipe = body.indexOf('|');
        const desc = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
        const tags = (pipe >= 0 ? body.slice(pipe + 1) : '').trim();
        if (desc || tags) out.push({ marker, desc, tags, key: hash(marker) });

        i = hit.end + 1;
    }
    return out;
}

/** 拼出最终提示词：前缀 + （只标签 / 描述+标签） */
function promptFor(entry, settings) {
    const base = settings.useTagsOnly
        ? (entry.tags || entry.desc)
        : [entry.desc, entry.tags].filter(Boolean).join(', ');
    return `${settings.prefix || ''}${base}`;
}

/* ===== lib/providers/index.js ===== */
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

class IllustError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'IllustError';
        if (cause !== undefined) this.cause = cause;
    }
}

const PROVIDERS = new Map();

/** 注册一个 provider；后注册的同名会覆盖先注册的 */
function registerProvider(id, provider) {
    PROVIDERS.set(id, provider);
}

function getProvider(id) {
    const provider = PROVIDERS.get(id);
    if (!provider) {
        throw new IllustError(`未知的生图后端：${id}`);
    }
    return provider;
}

function providerIds() {
    return [...PROVIDERS.keys()];
}

/**
 * 内置 provider 的「注册器」。
 *
 * 不用 `export { x } from './x.js'` 中转：单文件构建时那样会变成顶层重复声明。
 * 统一改成函数，由入口显式调用完成注册。
 */
function registerBuiltinProviders(relay, a1111, tavern) {
    if (relay) registerProvider('relay', relay);
    if (a1111) registerProvider('a1111', a1111);
    if (tavern) registerProvider('tavern', tavern);
}

/* ------------------------------------------------------------------ */
/* 共用的 fetch 封装                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 180000;

/**
 * 带超时和错误归一的 fetch。
 * 中转站慢的时候 26–90 秒都正常，所以默认给 3 分钟。
 */
async function fetchJson(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, what = '生图服务' } = {}) {
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

/* ===== lib/providers/relay.js ===== */
/**
 * 中转站直连 provider（OpenAI 风格图像生成接口）
 *
 *   POST {baseUrl}/images/generations
 *   Authorization: Bearer <apiKey>
 *   { model, prompt, negative_prompt, n, size, steps, cfg_scale, seed }
 *
 * 这是本扩展默认的后端：不依赖本机 adapter、不依赖酒馆的 Node 后端，
 * 装到任何能跑 WebView 的酒馆里填上地址和 Key 就能用。
 */

/** 各家对 size 的接受范围差别很大，这里统一按 16 的倍数夹到 256–1344 */
const SIZE_MIN = 256;
const SIZE_MAX = 1344;
const SIZE_STEP = 16;

function clampSize(value, fallback) {
    const n = Math.round((Number(value) || fallback) / SIZE_STEP) * SIZE_STEP;
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
}

function trimBaseUrl(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function authHeaders(apiKey, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    const key = String(apiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
}

/**
 * 从各种可能的数据形状里挖出 base64。
 * 中转站有的返回 `{data:[{b64_json}]}`，有的返回 `{images:[...]}`，有的两种都给。
 */
function extractImage(json) {
    if (!json || typeof json !== 'object') return null;

    const candidates = [
        json?.data?.[0]?.b64_json,
        json?.data?.[0]?.image,
        json?.images?.[0],
        json?.image,
        json?.artifacts?.[0]?.base64,
    ];

    for (const value of candidates) {
        if (typeof value !== 'string' || !value) continue;
        const clean = value.replace(/^data:image\/[a-z+]+;base64,/i, '');
        if (clean.length > 64) return clean;
    }
    return null;
}

const relayProvider = {
    id: 'relay',
    label: '中转站直连',

    async generate(settings, request) {
        const baseUrl = trimBaseUrl(settings.relayBaseUrl);
        if (!baseUrl) {
            throw new IllustError('还没填中转站地址（设置 → 生图后端 → 中转站地址）');
        }

        const width = clampSize(request.width, 832);
        const height = clampSize(request.height, 1216);

        const body = {
            model: String(settings.relayModel || request.model || '').trim() || undefined,
            prompt: request.prompt,
            n: 1,
            size: `${width}x${height}`,
            response_format: 'b64_json',
            steps: Number(request.steps) || 25,
            cfg_scale: Number(request.cfgScale) || 5,
            seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : -1,
        };
        if (request.negativePrompt) body.negative_prompt = request.negativePrompt;

        // 中转站普遍只接受 1 张，多张就串行请求
        const count = Math.max(1, Math.min(4, Number(request.batchSize) || 1));
        const images = [];

        for (let i = 0; i < count; i++) {
            if (i > 0) await sleep(1200);
            const json = await fetchJson(`${baseUrl}/images/generations`, {
                method: 'POST',
                headers: authHeaders(settings.relayApiKey),
                body: JSON.stringify(body),
            }, { what: '中转站' });

            const image = extractImage(json);
            if (!image) {
                const reason = json?.error?.message || json?.message || '没有返回图片数据';
                throw new IllustError(`中转站没出图：${reason}`);
            }
            images.push(image);
        }

        return images;
    },
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 连通性测试                                                          */
/* ------------------------------------------------------------------ */

/**
 * 「测试连接」：发一次最小请求，只为了尽早暴露地址 / Key / 模型名的问题。
 * 成功返回 { ok: true, ms, bytes }，失败返回 { ok: false, error }。
 */
async function testRelay(settings) {
    const started = Date.now();
    try {
        const images = await relayProvider.generate(settings, {
            prompt: 'test, simple illustration',
            negativePrompt: '',
            width: SIZE_MIN,
            height: SIZE_MIN,
            steps: 4,
            cfgScale: 3,
            seed: -1,
            batchSize: 1,
        });
        return {
            ok: true,
            ms: Date.now() - started,
            bytes: images[0] ? Math.round((images[0].length * 3) / 4) : 0,
        };
    } catch (error) {
        return { ok: false, ms: Date.now() - started, error: error?.message || String(error) };
    }
}

/** 尝试从中转站拉模型列表（不支持就返回空数组，不报错） */
async function listRelayModels(settings) {
    const baseUrl = trimBaseUrl(settings.relayBaseUrl);
    if (!baseUrl) return [];

    try {
        const json = await fetchJson(`${baseUrl}/models`, {
            method: 'GET',
            headers: authHeaders(settings.relayApiKey),
        }, { what: '中转站', timeoutMs: 20000 });

        const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        return rows
            .map(row => (typeof row === 'string' ? row : String(row?.id || '')))
            .filter(Boolean);
    } catch {
        return [];
    }
}

/* ===== lib/providers/a1111.js ===== */
/**
 * 标准 A1111 / Forge / SD.Next provider
 *
 *   GET  {baseUrl}/sdapi/v1/sd-models   取模型列表
 *   POST {baseUrl}/sdapi/v1/txt2img     出图
 *
 * 适用于本机跑的 WebUI，或任何对外暴露 A1111 兼容接口的中转/适配器。
 */

// 注意：这个文件会被单文件构建拼进同一作用域，所以辅助函数都带 a1111 前缀，
// 避免与 relay.js / tavern.js 里的同名工具函数冲突。
function trimA1111BaseUrl(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function a1111AuthHeaders(settings, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    const user = String(settings.a1111User || '').trim();
    const pass = String(settings.a1111Pass || '').trim();
    if (user || pass) {
        // btoa 对非 ASCII 会抛错，先做 UTF-8 编码
        const raw = `${user}:${pass}`;
        headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
    }
    return headers;
}

/** 把 `override_settings` 里的模型名挑出来，其它字段原样透传 */
function overrideSettings(settings, model) {
    const out = {};
    const value = String(model || settings.a1111Model || '').trim();
    if (value) out.sd_model_checkpoint = value;

    const samplers = String(settings.a1111Sampler || '').trim();
    if (samplers) out.sd_sampler = samplers;

    return out;
}

const a1111Provider = {
    id: 'a1111',
    label: '本地 A1111 / 适配器',

    async generate(settings, request) {
        const baseUrl = trimA1111BaseUrl(settings.a1111Url);
        if (!baseUrl) {
            throw new IllustError('还没填 A1111 地址（设置 → 生图后端 → A1111 地址）');
        }

        const body = {
            prompt: request.prompt,
            negative_prompt: request.negativePrompt || '',
            steps: Number(request.steps) || 25,
            cfg_scale: Number(request.cfgScale) || 5,
            width: Math.max(64, Number(request.width) || 832),
            height: Math.max(64, Number(request.height) || 1216),
            seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : -1,
            batch_size: Math.max(1, Math.min(4, Number(request.batchSize) || 1)),
            sampler_name: String(settings.a1111Sampler || 'Euler a'),
        };

        const override = overrideSettings(settings, request.model);
        if (Object.keys(override).length) body.override_settings = override;

        const json = await fetchJson(`${baseUrl}/sdapi/v1/txt2img`, {
            method: 'POST',
            headers: a1111AuthHeaders(settings),
            body: JSON.stringify(body),
        }, { what: 'A1111' });

        const images = Array.isArray(json?.images) ? json.images.filter(Boolean) : [];
        if (!images.length) {
            const reason = json?.error || json?.detail || json?.info || '没有返回图片数据';
            throw new IllustError(`A1111 没出图：${String(reason).slice(0, 200)}`);
        }

        return images.map(img => String(img).replace(/^data:image\/[a-z+]+;base64,/i, ''));
    },
};

/** 读 A1111 的模型列表，失败返回空数组 */
async function listA1111Models(settings) {
    const baseUrl = trimA1111BaseUrl(settings.a1111Url);
    if (!baseUrl) return [];

    try {
        const json = await fetchJson(`${baseUrl}/sdapi/v1/sd-models`, {
            method: 'GET',
            headers: a1111AuthHeaders(settings),
        }, { what: 'A1111', timeoutMs: 20000 });

        const rows = Array.isArray(json) ? json : [];
        return rows
            .map(row => String(row?.title || row?.model_name || '').trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

/* ===== lib/providers/tavern.js ===== */
/**
 * 交给酒馆自己的「图像生成」后端
 *
 *   POST /api/sd/generate
 *   POST /api/sd/models
 *
 * 好处：模型、采样器、分辨率全部跟酒馆的「图像生成」扩展共享，
 * 不用重复配置。坏处：依赖宿主的 /api 路由实现 ——
 * TauriTavern 的 /api/* 由前端拦截器接管，没实现的路由会返回 404，
 * 这种情况下请改用 relay 或 a1111。
 */


function sdSettings() {
    try {
        const store = globalThis.extension_settings;
        return store?.sd && typeof store.sd === 'object' ? store.sd : {};
    } catch {
        return {};
    }
}

/** 酒馆「图像生成」里当前选中的模型 */
function currentSdModel() {
    const model = sdSettings().model;
    return typeof model === 'string' ? model : '';
}

/** 酒馆当前配置的生图后端地址（auto 来源时是 source_url） */
function sdBackendUrl(settings) {
    const sd = sdSettings();
    return String(settings.adapterUrl || sd.source_url || sd.auto_url || '').trim();
}

const tavernProvider = {
    id: 'tavern',
    label: '酒馆「图像生成」后端',

    async generate(settings, request) {
        const url = sdBackendUrl(settings);
        if (!url) {
            throw new IllustError('酒馆「图像生成」还没配置后端地址');
        }

        const headers = await requestHeaders();
        const body = {
            url,
            model: String(request.model || currentSdModel() || '').trim(),
            prompt: request.prompt,
            negative_prompt: request.negativePrompt || '',
            steps: Number(request.steps) || 25,
            cfg_scale: Number(request.cfgScale) || 5,
            width: Math.max(64, Number(request.width) || 832),
            height: Math.max(64, Number(request.height) || 1216),
            seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : -1,
            batch_size: Math.max(1, Math.min(4, Number(request.batchSize) || 1)),
            sampler_name: String(settings.a1111Sampler || 'Euler a'),
        };

        let res;
        try {
            res = await fetch('/api/sd/generate', {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (error) {
            throw new IllustError('调不到酒馆的生图接口', error);
        }

        if (res.status === 404) {
            throw new IllustError('当前酒馆没有 /api/sd/generate（TauriTavern 请改用中转站直连）');
        }
        if (!res.ok) {
            throw new IllustError(`酒馆生图接口返回 ${res.status}`);
        }

        let json;
        try {
            json = await res.json();
        } catch (error) {
            throw new IllustError('酒馆生图接口返回的不是 JSON', error);
        }

        const images = Array.isArray(json?.images) ? json.images.filter(Boolean) : [];
        if (!images.length) throw new IllustError('酒馆生图接口没有返回图片数据');

        return images.map(img => String(img).replace(/^data:image\/[a-z+]+;base64,/i, ''));
    },
};

/** 读酒馆后端支持的模型列表，失败返回空数组 */
async function listTavernModels(settings) {
    const url = sdBackendUrl(settings);
    if (!url) return [];

    try {
        const headers = await requestHeaders();
        const res = await fetch('/api/sd/models', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url }),
        });
        if (!res.ok) return [];

        const list = await res.json();
        if (!Array.isArray(list)) return [];
        return list.map(item => String(item?.value ?? item?.title ?? '')).filter(Boolean);
    } catch {
        return [];
    }
}

/* ===== lib/blank.js ===== */
/**
 * 空白（全黑 / 全白）图检测
 *
 * 中转站上游失败时经常不是报错，而是返回一张 200 + 纯黑占位图。
 * 不拦下来的话，用户会得到一张"成功生成"的黑图，还得自己发现。
 *
 * 做法：把 base64 解成字节流，不在浏览器里完整解码 PNG，
 * 而是抽样读取 IDAT 解压后的原始像素 —— 完整解码太慢，
 * 而空白图在「压缩后体积」和「采样像素方差」两个维度上都非常突出。
 *
 * 策略（由便宜到贵）：
 *   1. 体积启发式：小于 2KB 的 PNG 基本不可能是有效插画
 *   2. 如果宿主有 canvas，直接画到 1×1 缩略图看是否纯色
 *   3. 都没有则放行（宁可偶尔出现一张黑图，也不能把正常图误判掉）
 */

/** 判定为空白时，所有采样像素的最大通道值上限 */
const BLANK_MAX_CHANNEL = 8;
/** 小于这个字节数的图基本可以确定不是有效插画 */
const TINY_BYTES = 2048;

function base64ToBytes(base64) {
    const clean = String(base64 || '').replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '');
    if (!clean) return null;

    try {
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

/**
 * 快速体积检查。只对 PNG 生效：JPEG 体积波动太大，用体积判断会误伤。
 */
function looksTiny(bytes) {
    if (!bytes || bytes.length < 8) return true;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (!isPng) return false;
    return bytes.length < TINY_BYTES;
}

/**
 * canvas 采样：把图缩到 1×1，读那一个像素。
 * 有 canvas 的环境（所有酒馆前端）都会走这条，最准也最简单。
 */
async function colorLooksBlank(url) {
    if (typeof OffscreenCanvas !== 'undefined') {
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(1, 1);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            bitmap.close?.();
            if (a < 8) return true;
            return Math.max(r, g, b) <= BLANK_MAX_CHANNEL;
        } catch {
            return null;
        }
    }

    if (typeof document === 'undefined') return null;

    try {
        const img = await loadImage(`data:image/png;base64,${url}`);
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        if (a < 8) return true;
        return Math.max(r, g, b) <= BLANK_MAX_CHANNEL;
    } catch {
        return null;
    }
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = src;
    });
}

/**
 * 判断一张图是不是空白占位图。
 *
 * @param {string} base64 不带 data: 前缀的图片数据
 * @returns {Promise<boolean>} true = 看起来是空白，应该重试
 */
async function isBlankImage(base64) {
    const bytes = base64ToBytes(base64);

    if (bytes && looksTiny(bytes)) return true;
    if (!bytes) return false;

    const byColor = await colorLooksBlank(String(base64).replace(/^data:image\/[a-z+]+;base64,/i, ''));
    return byColor === true;
}

/* ===== index.js ===== */
/**
 * 插图标记自动配图 (illust-marker) —— 主入口
 *
 * 识别 AI 正文里的标记：
 *
 *   [ILLUST: 自然语言描述 | Danbooru,tags]
 *
 * 取竖线后的标签段作为提示词，调用生图后端出图，把图片插到标记所在段落
 * 下方，并把标记文本隐藏。
 *
 * 与宿主的关系全部收敛在 lib/host.js：
 *   - 不再静态 import `/script.js`，任何模块缺失都只让对应能力降级
 *   - 生图后端可切换（中转站直连 / A1111 / 酒馆自己的「图像生成」）
 *   - 没有 eventSource 时退化为 MutationObserver 驱动
 */








registerBuiltinProviders(relayProvider, a1111Provider, tavernProvider);

/**
 * 设置在 extension_settings 里的键名；同时作为日志前缀。
 * 单文件构建会把 lib/ 与入口拼到同一作用域，所以这个名字必须与 lib 里的不重复。
 */
const MODULE = 'illust-marker-portable';
const LOG = '[illust-marker]';

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

let cachedSettings = null;

/**
 * 设置容器（同步读取）。
 * 真实容器由 host.resolveSettingsStore() 在 start() 里异步解析并缓存 ——
 * SillyTavern 的 extension_settings 是模块导出而不是全局变量，
 * 所以不能直接读 window。
 */
function settingsStore() {
    return settingsStoreRef();
}

/**
 * 取当前设置。
 * 第一次访问时从宿主设置里读、迁移旧版本、补默认值，之后走缓存，
 * 由 updateSettings() 统一写回，避免「一半新一半旧」。
 */
function settings() {
    if (cachedSettings) return cachedSettings;

    const { store } = settingsStore();
    cachedSettings = normalizeSettings(migrateLegacy(store[MODULE]));
    store[MODULE] = cachedSettings;
    return cachedSettings;
}

function updateSettings(patch) {
    const { store } = settingsStore();
    // 先把面板上可能存在的非托管字段（比如别的版本留下的）合并进来再归一化
    const next = normalizeSettings({ ...settings(), ...patch });
    cachedSettings = next;
    store[MODULE] = next;
    saveSettings();
    return next;
}

/* ------------------------------------------------------------------ */
/* 轻提示 / 进度条                                                      */
/* ------------------------------------------------------------------ */

/**
 * 顶层 UI 容器。
 * 某些主题把 html 设成 transform + height:0，导致 position:fixed 的元素
 * 按 0 高度的包含块计算，bottom 定位全部跑到屏幕外。
 * 所以统一挂在一个 100vw × 100dvh 的固定图层里。
 */
function uiLayer() {
    let el = document.querySelector('.illust-ui-layer');
    if (el && document.body.contains(el)) return el;

    el = document.createElement('div');
    el.className = 'illust-ui-layer';
    document.body.appendChild(el);
    return el;
}

let toastTimer = null;
function showToast(text, ms = 1200) {
    document.querySelector('.illust-toast')?.remove();
    const el = document.createElement('div');
    el.className = 'illust-toast';
    el.textContent = text;
    uiLayer().appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

const gen = { running: 0 };

let progressEl = null;
let progressState = null;
let progressHideTimer = null;

function ensureProgressEl() {
    if (progressEl && document.body.contains(progressEl)) return progressEl;

    progressEl = document.createElement('div');
    progressEl.className = 'illust-progress hidden';
    progressEl.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'illust-progress-icon';

    const text = document.createElement('span');
    text.className = 'illust-progress-text';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'illust-progress-close';
    close.textContent = '✕';
    close.title = '关闭提示';
    close.addEventListener('click', (e) => {
        e.stopPropagation();
        hideProgress();
    });

    progressEl.append(icon, text, close);
    progressEl.addEventListener('click', () => {
        const cb = progressState?.onClick;
        if (cb) cb();
    });

    uiLayer().appendChild(progressEl);
    return progressEl;
}

function hideProgress() {
    if (!progressEl) return;
    progressEl.classList.add('hidden');
    progressEl.classList.remove('is-running', 'is-done', 'is-error', 'is-clickable');
    progressState = null;
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
}

function showProgress(kind, text, opts = {}) {
    // 灯箱 / 历史面板自带反馈，不要在上面再叠一条提示
    if (document.querySelector('.illust-lightbox, .illust-history-overlay')) return;

    const el = ensureProgressEl();
    progressState = { kind, text, onClick: opts.onClick || null };

    el.classList.remove('hidden', 'is-running', 'is-done', 'is-error');
    el.classList.add(`is-${kind}`);
    el.classList.toggle('is-clickable', !!opts.onClick);
    el.querySelector('.illust-progress-icon').textContent =
        kind === 'running' ? '🎨' : kind === 'done' ? '✅' : '⚠️';
    el.querySelector('.illust-progress-text').textContent = text;
    el.querySelector('.illust-progress-close').hidden = !opts.close;

    clearTimeout(progressHideTimer);
    progressHideTimer = null;
    if (opts.ms) progressHideTimer = setTimeout(hideProgress, opts.ms);
}

// 绘制中不在屏幕上弹窗（消息里已有「正在绘制插图…」占位）
function beginGen() { gen.running += 1; }
function endGen() { gen.running = Math.max(0, gen.running - 1); }

function vibrate(pattern) {
    if (!settings().vibrate) return;
    try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

let titleTimer = null;
let titleOriginal = null;
function flashTitle(msg) {
    if (!document.hidden) return;
    if (titleOriginal === null) titleOriginal = document.title;

    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => {
        on = !on;
        document.title = on ? msg : titleOriginal;
    }, 900);

    const stop = () => {
        clearInterval(titleTimer);
        titleTimer = null;
        if (titleOriginal !== null) document.title = titleOriginal;
        titleOriginal = null;
        window.removeEventListener('focus', stop);
        document.removeEventListener('visibilitychange', onVisible);
    };
    const onVisible = () => { if (!document.hidden) stop(); };

    window.addEventListener('focus', stop);
    document.addEventListener('visibilitychange', onVisible);
}

/* ------------------------------------------------------------------ */
/* 悬浮球：跳到最新插图 / 回到阅读位置                                   */
/* ------------------------------------------------------------------ */

let savedScrollTop = null;
let unseenCount = 0;
let lastDone = null;
let scrollGuardUntil = 0;

function chatArray() {
    // 同步快路径：宿主（SillyTavern / TauriTavern 前端）都在 context 上暴露了 chat，
    // 有了就不必等异步的 getChat()。
    const ctx = __globals().SillyTavern;
    if (Array.isArray(ctx?.chat)) return ctx.chat;
    return chatCache;
}

let chatCache = [];

/**
 * 全局对象。
 * 名字带下划线前缀只是因为单文件构建会把 lib/ 里同名的 `globals()` 拼进同一作用域。
 */
function __globals() {
    return globalThis;
}

async function refreshChatCache() {
    try {
        const chat = await getChat();
        if (Array.isArray(chat)) chatCache = chat;
    } catch { /* ignore */ }
    return chatCache;
}

function getScrollHost() {
    return document.getElementById('chat') || document.scrollingElement;
}

function currentScrollTop() {
    const scrollEl = getScrollHost();
    return scrollEl ? scrollEl.scrollTop : window.scrollY;
}

function latestIllustInChat() {
    const chat = chatArray();
    let best = null;

    chat.forEach((mes, i) => {
        const store = mes?.extra?.illust;
        if (!store) return;
        for (const [key, v] of Object.entries(store)) {
            if (!v?.url) continue;
            const at = Number(v.at) || 0;
            if (!best || at > best.at || (at === best.at && i >= best.mesId)) {
                best = { mesId: i, key, url: v.url, at };
            }
        }
    });

    return best;
}

/** 优先「刚生成完的那张」，其次会话里最新的一张（隐私模式下也有效，因为读的是数据） */
function latestTarget() {
    const fromChat = latestIllustInChat();

    if (lastDone) {
        const url = chatArray()[lastDone.mesId]?.extra?.illust?.[lastDone.key]?.url;
        if (url && (!fromChat || (lastDone.at || 0) >= (fromChat.at || 0))) {
            return { mesId: lastDone.mesId, key: lastDone.key, url, at: lastDone.at || 0 };
        }
    }

    return fromChat;
}

const revealedImages = new Set();

function revealForJump(target) {
    if (!settings().privacyMode) return;
    const mes = chatArray()[target.mesId];
    if (!mes) return;
    const rk = `${target.mesId}:${target.key}`;
    if (revealedImages.has(rk)) return;
    revealedImages.add(rk);
    try { decorate(target.mesId, mes); } catch (e) { console.warn(LOG, e); }
}

function jumpToLatestIllustration() {
    const target = latestTarget();
    if (!target) {
        showToast('这个聊天还没有生成过插图', 1600);
        return false;
    }
    if (!document.querySelector(`#chat .mes[mesid="${target.mesId}"]`)) {
        showToast('这条消息还没加载出来，往上翻一点再试', 1800);
        return false;
    }

    savedScrollTop = currentScrollTop();
    scrollGuardUntil = Date.now() + 1400;
    unseenCount = 0;
    if (progressState?.kind === 'done') hideProgress();

    revealForJump(target);

    const scrollToTarget = () => {
        const mes = document.querySelector(`#chat .mes[mesid="${target.mesId}"]`);
        if (!mes) return;
        const box = mes.querySelector('.illust-inline');
        const el = box || mes;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { el.scrollIntoView(); }
        mes.classList.add('illust-highlight');
        setTimeout(() => mes.classList.remove('illust-highlight'), 1600);
    };

    requestAnimationFrame(() => {
        const mes = document.querySelector(`#chat .mes[mesid="${target.mesId}"]`);
        const img = mes?.querySelector('.illust-inline img');
        if (img && !img.complete) {
            // 图片还没解码完，高度是 0，等加载后再滚才不会跑偏
            img.addEventListener('load', () => requestAnimationFrame(scrollToTarget), { once: true });
            setTimeout(scrollToTarget, 700);
        } else {
            scrollToTarget();
        }
        updateFab();
    });

    return true;
}

function returnToReadingPosition() {
    const top = savedScrollTop;
    savedScrollTop = null;
    scrollGuardUntil = 0;

    if (top !== null) {
        const hostEl = getScrollHost();
        try {
            if (hostEl) hostEl.scrollTo({ top, behavior: 'smooth' });
            else window.scrollTo({ top, behavior: 'smooth' });
        } catch { /* ignore */ }
    }
    updateFab();
}

const FAB_HOLD_MS = 320;
let fabLastDragAt = 0;

function applyFabPos(fab) {
    const pos = settings().fabPos;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;

    const w = fab.offsetWidth || 56;
    const h = fab.offsetHeight || 56;
    const x = Math.min(Math.max(0, pos.x), Math.max(0, innerWidth - w));
    const y = Math.min(Math.max(0, pos.y), Math.max(0, innerHeight - h));

    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
}

function moveFabTo(fab, x, y) {
    const w = fab.offsetWidth || 56;
    const h = fab.offsetHeight || 56;
    const cx = Math.min(Math.max(0, x), Math.max(0, innerWidth - w));
    const cy = Math.min(Math.max(0, y), Math.max(0, innerHeight - h));
    fab.style.left = `${cx}px`;
    fab.style.top = `${cy}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    return { x: cx, y: cy };
}

/** 长按 320ms 进入拖动，松手保存位置；短按仍然是「跳插图 / 回阅读位置」 */
function attachFabDrag(fab) {
    let holdTimer = null;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    const clearHold = () => {
        clearTimeout(holdTimer);
        holdTimer = null;
    };

    fab.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        dragging = false;
        const r = fab.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        originX = r.left;
        originY = r.top;

        clearHold();
        holdTimer = setTimeout(() => {
            dragging = true;
            holdTimer = null;
            fab.classList.add('dragging');
            try { fab.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            try { navigator.vibrate?.(10); } catch { /* ignore */ }
        }, FAB_HOLD_MS);
    });

    fab.addEventListener('pointermove', (e) => {
        if (!dragging) {
            // 还没长按成功就滑动了：当成滚动，取消长按
            if (holdTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clearHold();
            return;
        }
        moveFabTo(fab, originX + (e.clientX - startX), originY + (e.clientY - startY));
        e.preventDefault();
    });

    const finish = (e) => {
        clearHold();
        if (!dragging) return;

        dragging = false;
        fab.classList.remove('dragging');
        fabLastDragAt = Date.now();

        const rect = fab.getBoundingClientRect();
        updateSettings({ fabPos: { x: Math.round(rect.left), y: Math.round(rect.top) } });

        try { fab.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    fab.addEventListener('pointerup', finish);
    fab.addEventListener('pointercancel', finish);

    window.addEventListener('resize', () => applyFabPos(fab));
}

function ensureFab() {
    let fab = document.querySelector('.illust-fab');
    if (!fab) {
        fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'illust-fab hidden';
        fab.title = '跳到最新插图（长按可拖动）';
        fab.textContent = '🖼';
        fab.addEventListener('click', onFabClick);
        uiLayer().appendChild(fab);
        attachFabDrag(fab);
        applyFabPos(fab);
    }
    return fab;
}

function updateFab() {
    const fab = ensureFab();
    const cfg = settings();
    const target = latestTarget();
    const visible = !!cfg.showFab && !!target;

    fab.classList.toggle('hidden', !visible);

    if (!visible) {
        savedScrollTop = null;
        unseenCount = 0;
        fab.classList.remove('is-back', 'has-new');
        const stale = fab.querySelector('.illust-fab-badge');
        if (stale) stale.remove();
        return;
    }

    const back = savedScrollTop !== null;
    fab.classList.toggle('is-back', back);
    fab.textContent = back ? '↩' : '🖼';
    fab.title = back ? '回到阅读位置（长按可拖动）' : '跳到最新插图（长按可拖动）';

    let badge = fab.querySelector('.illust-fab-badge');
    if (!back && unseenCount > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'illust-fab-badge';
            fab.appendChild(badge);
        }
        badge.textContent = unseenCount > 9 ? '9+' : String(unseenCount);
        badge.hidden = false;
        fab.classList.add('has-new');
    } else {
        if (badge) badge.hidden = true;
        fab.classList.remove('has-new');
    }
}

function onFabClick() {
    // 刚拖完会补发一次 click，别当成点击
    if (Date.now() - fabLastDragAt < 500) return;

    if (savedScrollTop !== null) returnToReadingPosition();
    else jumpToLatestIllustration();
}

/* 用户自己滚回阅读位置后，把悬浮球恢复成「跳到插图」 */
let scrollSettleTimer = null;
function watchScrollBack() {
    const hostEl = getScrollHost();
    if (!hostEl || hostEl.dataset.illustScrollWatch) return;
    hostEl.dataset.illustScrollWatch = '1';
    hostEl.addEventListener('scroll', () => {
        clearTimeout(scrollSettleTimer);
        scrollSettleTimer = setTimeout(() => {
            if (savedScrollTop === null) return;
            if (Date.now() < scrollGuardUntil) return;
            if (Math.abs(currentScrollTop() - savedScrollTop) < 60) {
                savedScrollTop = null;
                updateFab();
            }
        }, 280);
    }, { passive: true });
}

/* ---- 生成结束时的回调 ---- */

function onGenDone(mesId, key, url) {
    lastDone = { mesId, key, url, at: Date.now() };
    unseenCount = gen.running > 0 ? unseenCount + 1 : 1;

    vibrate([25, 55, 35]);
    flashTitle('✅ 插图已完成');

    const cfg = settings();
    if (cfg.notifyDone) {
        showProgress('done', '插图已完成', {
            onClick: () => { hideProgress(); jumpToLatestIllustration(); },
            ms: 1000,
        });
    }

    updateFab();
}

function onGenFail(err, mesId) {
    vibrate([60, 40, 60]);

    const msg = String(err?.message || err || '未知错误');
    const short = msg.length > 34 ? `${msg.slice(0, 34)}…` : msg;

    // 灯箱 / 历史面板自带状态反馈，不要再叠提示条
    if (document.querySelector('.illust-lightbox, .illust-history-overlay')) {
        const toastr = __globals().toastr;
        if (toastr?.error) toastr.error(`配图失败：${msg}`, '插图标记');
        return;
    }

    showProgress('error', `配图失败：${short}`, {
        onClick: () => {
            hideProgress();
            if (Number.isFinite(mesId)) jumpToMessage(mesId);
        },
        close: true,
        ms: 15000,
    });
    updateFab();
}

/* ------------------------------------------------------------------ */
/* 生成                                                               */
/* ------------------------------------------------------------------ */

const busy = new Set();
let lastRequestAt = 0;

function __sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 调用选中的 provider 出图。
 * 这里集中处理：提示词归一化、尺寸/步数夹取、限速、空白图重试。
 */
async function requestImages(cfg, prompt) {
    const provider = getProvider(cfg.backend);

    const request = {
        prompt: normalizePrompt(prompt, cfg.weightMode).slice(0, PROMPT_LIMIT),
        negativePrompt: String(cfg.negative || '').slice(0, PROMPT_LIMIT),
        width: cfg.width,
        height: cfg.height,
        steps: cfg.steps,
        cfgScale: cfg.cfg,
        seed: cfg.seed,
        batchSize: cfg.batch,
        model: cfg.backend === 'relay' ? cfg.relayModel : (cfg.a1111Model || ''),
    };

    if (!request.prompt) throw new IllustError('提示词是空的');

    const attempts = cfg.retryOnBlank ? Math.max(1, cfg.maxAttempts) : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        // 限速：同一时间只跑一个请求，避免把公益站打到 429
        if (cfg.minIntervalMs > 0) {
            const wait = cfg.minIntervalMs - (Date.now() - lastRequestAt);
            if (wait > 0) await __sleep(wait);
        }
        lastRequestAt = Date.now();

        let images;
        try {
            images = await provider.generate(cfg, request);
        } catch (error) {
            lastError = error;
            if (attempt < attempts && isRetryable(error)) {
                console.warn(`${LOG} attempt ${attempt}/${attempts} failed:`, error?.message);
                await __sleep(1500 * attempt);
                continue;
            }
            throw error;
        }

        // 中转站上游失败时经常 200 + 纯黑占位图，必须自己识别
        if (cfg.retryOnBlank && await isBlankImage(images[0])) {
            lastError = new IllustError('后端返回了空白（全黑）图，通常是上游生成失败');
            if (attempt < attempts) {
                console.warn(`${LOG} blank image, attempt ${attempt}/${attempts}`);
                await __sleep(3000 * attempt);
                continue;
            }
            throw lastError;
        }

        return images;
    }

    throw lastError || new IllustError('生成失败');
}

function isRetryable(error) {
    const msg = String(error?.message || '');
    // 鉴权失败和参数错误重试没意义
    if (/鉴权|401|403|400|没出图|未知的生图后端/.test(msg)) return false;
    return true;
}

const pending = new Set();

async function ensureImage(mesId, entry, options = {}) {
    const { force = false, prompt = null, silent = false } = options;
    const chat = await refreshChatCache();
    const mes = chat[mesId];
    if (!mes) return null;

    mes.extra = mes.extra || {};
    const store = (mes.extra.illust = mes.extra.illust || {});
    if (!force && store[entry.key]?.url) return store[entry.key].url;

    const tag = `${mesId}:${entry.key}`;
    if (busy.has(tag)) return null;
    busy.add(tag);
    beginGen();
    pending.add(tag);

    try {
        const cfg = settings();
        const text = prompt ?? promptFor(entry, cfg);
        const images = await requestImages(cfg, text);

        const folder = sanitizeFolderName(await getCharacterName() || mes.name || 'illust');
        const saved = await persistImage(
            images[0],
            folder,
            `illust_${mesId}_${entry.key}_${Date.now()}`,
        );

        store[entry.key] = {
            url: saved.url,
            prompt: normalizePrompt(text, cfg.weightMode).slice(0, PROMPT_LIMIT),
            at: Date.now(),
        };
        await saveChat();
        console.log(LOG, 'generated', saved.mode === 'file' ? saved.url : '(data url)');

        endGen();
        pending.delete(tag);
        onGenDone(mesId, entry.key, saved.url);
        if (!silent && !settings().notifyDone) showToast('插图已生成', 2000);

        return saved.url;
    } catch (err) {
        console.error(`${LOG} generation failed:`, err);
        endGen();
        pending.delete(tag);
        store[entry.key] = { error: String(err?.message || err), at: Date.now() };
        await saveChat();
        onGenFail(err, mesId);
        return null;
    } finally {
        busy.delete(tag);
    }
}

/* ------------------------------------------------------------------ */
/* 删除                                                               */
/* ------------------------------------------------------------------ */

/**
 * targets: [{ mesId, key }]
 */
async function deleteIllustrations(targets) {
    const chat = await refreshChatCache();
    let removed = 0;

    for (const t of targets) {
        const mes = chat[t.mesId];
        const store = mes?.extra?.illust;
        if (!store?.[t.key]) continue;
        const url = store[t.key].url;
        delete store[t.key];
        revealedImages.delete(`${t.mesId}:${t.key}`);
        if (lastDone && lastDone.mesId === t.mesId && lastDone.key === t.key) lastDone = null;
        removed++;
        if (url) await removeImage(url);
        try { decorate(t.mesId, mes, { showButton: true }); } catch (e) { console.warn(e); }
    }

    if (removed) {
        await saveChat();
        updateFab();
        showToast(`已删除 ${removed} 张插图`);
    }
    return removed;
}

/* ------------------------------------------------------------------ */
/* 灯箱：查看大图 / 重新生成 / 编辑提示词                                */
/* ------------------------------------------------------------------ */

const lightboxState = { open: false };
const historyState = { open: false };

function openLightbox(url, mesId = null, entry = null) {
    document.querySelector('.illust-lightbox')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'illust-lightbox';
    overlay.innerHTML = `
        <div class="illust-lightbox-bar">
            <button type="button" class="illust-lb-btn" data-act="regen" title="用当前提示词重新生成">🔄 重新生成</button>
            <button type="button" class="illust-lb-btn" data-act="prompt" title="查看或修改提示词">📝 提示词</button>
            <span class="illust-lb-zoom">
                <button type="button" class="illust-lb-btn illust-lb-zbtn" data-act="zoomOut" title="缩小">−</button>
                <button type="button" class="illust-lb-btn illust-lb-zbtn" data-act="zoomReset" title="还原">1:1</button>
                <button type="button" class="illust-lb-btn illust-lb-zbtn" data-act="zoomIn" title="放大">＋</button>
            </span>
            <button type="button" class="illust-lb-btn illust-lb-close" data-act="close" title="关闭">✕</button>
        </div>
        <img class="illust-lb-img" alt="illustration">
        <div class="illust-lb-prompt" hidden>
            <textarea class="illust-lb-text" rows="4" spellcheck="false"></textarea>
            <div class="illust-lb-actions">
                <small>修改后点「保存并重新生成」</small>
                <button type="button" class="illust-lb-btn" data-act="save">保存并重新生成</button>
            </div>
        </div>
        <div class="illust-lb-busy" hidden><span class="illust-spinner"></span>正在生成…</div>`;

    const img = overlay.querySelector('.illust-lb-img');
    img.src = url;

    /* ---- 缩放 / 拖动 ---- */
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let rafId = null;
    let zoomTimer = null;
    let lastCursor = '';

    img.draggable = false;
    img.decoding = 'async';

    const flush = () => {
        rafId = null;
        img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
        const cur = scale > 1 ? 'grab' : 'zoom-in';
        if (cur !== lastCursor) {
            img.style.cursor = cur;
            lastCursor = cur;
        }
    };

    // 拖动/捏合走 rAF 合帧，避免每个 pointermove 都触发一次样式重算
    const applyZoom = (immediate = false) => {
        if (immediate) {
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            flush();
            return;
        }
        if (rafId === null) rafId = requestAnimationFrame(flush);
    };

    const setScale = (next, animate = false) => {
        scale = Math.min(6, Math.max(1, next));
        if (scale === 1) { tx = 0; ty = 0; }
        if (animate) {
            img.classList.add('zooming');
            clearTimeout(zoomTimer);
            zoomTimer = setTimeout(() => img.classList.remove('zooming'), 180);
            applyZoom(true);
        } else {
            applyZoom();
        }
    };

    const pointers = new Map();
    let startDist = 0;
    let startScale = 1;
    let dragStart = null;

    img.addEventListener('pointerdown', (e) => {
        try { img.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            dragStart = { x: e.clientX - tx, y: e.clientY - ty };
        } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            startDist = Math.hypot(a.x - b.x, a.y - b.y);
            startScale = scale;
        }
        e.stopPropagation();
    });

    img.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            if (startDist > 0) setScale(startScale * (dist / startDist));
        } else if (pointers.size === 1 && scale > 1 && dragStart) {
            tx = e.clientX - dragStart.x;
            ty = e.clientY - dragStart.y;
            applyZoom();
        }
        e.stopPropagation();
    });

    const endPointer = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) dragStart = null;
    };
    img.addEventListener('pointerup', endPointer);
    img.addEventListener('pointercancel', endPointer);

    img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        setScale(scale > 1 ? 1 : 2.5, true);
    });

    overlay.addEventListener('wheel', (e) => {
        if (!e.target.closest('.illust-lb-img')) return;
        e.preventDefault();
        setScale(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });

    applyZoom();

    const promptPanel = overlay.querySelector('.illust-lb-prompt');
    const textarea = overlay.querySelector('.illust-lb-text');
    const busyBox = overlay.querySelector('.illust-lb-busy');
    const regenBtn = overlay.querySelector('[data-act="regen"]');
    const saveBtn = overlay.querySelector('[data-act="save"]');

    const currentPrompt = () => {
        const store = chatArray()[mesId]?.extra?.illust || {};
        return store[entry?.key]?.prompt || (entry ? promptFor(entry, settings()) : '');
    };

    textarea.value = currentPrompt();

    const dismiss = () => {
        lightboxState.open = false;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };

    const runRegen = async (nextPrompt) => {
        if (mesId === null || !entry) {
            showToast('无法重新生成：缺少上下文');
            return;
        }
        busyBox.hidden = false;
        regenBtn.disabled = true;
        saveBtn.disabled = true;
        img.style.opacity = '0.35';
        try {
            const newUrl = await ensureImage(mesId, entry, { force: true, prompt: nextPrompt ?? undefined });
            if (newUrl) {
                img.src = newUrl;
                setScale(1);
                decorate(mesId, chatArray()[mesId]);
                updateFab();
            }
        } finally {
            busyBox.hidden = true;
            regenBtn.disabled = false;
            saveBtn.disabled = false;
            img.style.opacity = '1';
        }
    };

    overlay.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.getAttribute('data-act');
        if (!act) {
            if (e.target === overlay) dismiss();
            return;
        }
        e.stopPropagation();
        if (act === 'close') dismiss();
        else if (act === 'regen') runRegen(currentPrompt());
        else if (act === 'zoomIn') setScale(scale * 1.3, true);
        else if (act === 'zoomOut') setScale(scale / 1.3, true);
        else if (act === 'zoomReset') setScale(1, true);
        else if (act === 'prompt') {
            promptPanel.hidden = !promptPanel.hidden;
            if (!promptPanel.hidden) {
                textarea.value = currentPrompt();
                textarea.focus();
            }
        } else if (act === 'save') {
            runRegen(textarea.value.trim());
        }
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    lightboxState.open = true;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

function makeImageBox(url, mesId, entry, onHide = null) {
    const box = document.createElement('div');
    box.className = 'illust-inline';

    const wrap = document.createElement('div');
    wrap.className = 'illust-img-wrap';

    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = 'illustration';
    img.addEventListener('click', () => openLightbox(url, mesId, entry));
    wrap.appendChild(img);

    if (onHide) {
        const hideBtn = document.createElement('button');
        hideBtn.type = 'button';
        hideBtn.className = 'illust-hide-btn';
        hideBtn.textContent = '🙈 隐藏';
        hideBtn.title = '收起这张插图';
        hideBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onHide();
        });
        wrap.appendChild(hideBtn);
    }

    box.appendChild(wrap);
    return box;
}

/** 隐私模式：默认折叠，点按钮才显示 */
function makeRevealBox(mesId, entry, revealKey) {
    const box = document.createElement('div');
    box.className = 'illust-inline';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'illust-privacy-btn';
    btn.textContent = '🖼 显示插图';
    btn.title = '隐私模式：点击查看这张插图';
    btn.addEventListener('click', async () => {
        revealedImages.add(revealKey);
        const chat = await refreshChatCache();
        decorate(mesId, chat[mesId]);
    });

    box.appendChild(btn);
    return box;
}

function makeStatusBox(text, cls = 'illust-pending') {
    const box = document.createElement('div');
    box.className = 'illust-inline';
    const span = document.createElement('span');
    span.className = cls;
    if (cls === 'illust-pending') {
        const spin = document.createElement('span');
        spin.className = 'illust-spinner';
        span.appendChild(spin);
    }
    span.appendChild(document.createTextNode(text));
    box.appendChild(span);
    return box;
}

function makeGenerateButton(mesId, entry, error) {
    const box = document.createElement('div');
    box.className = 'illust-inline';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'illust-generate-btn';
    btn.textContent = error ? '🎨 重新绘制插图' : '🎨 绘制此段插图';
    btn.title = (entry.tags || entry.desc || '').slice(0, 200);

    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '绘制中…';
        try {
            await ensureImage(mesId, entry, { force: true });
        } finally {
            const chat = await refreshChatCache();
            decorate(mesId, chat[mesId]);
            updateFab();
        }
    });

    box.appendChild(btn);

    if (error) {
        const tip = document.createElement('span');
        tip.className = 'illust-error';
        tip.textContent = `上次失败：${error}`;
        box.appendChild(tip);
    }

    return box;
}

function isLatestMessage(mesId) {
    const chat = chatArray();
    return Number(mesId) === chat.length - 1;
}

function decorate(mesId, mes, opts = {}) {
    const root = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    if (!root || !mes) return;

    // 清理范围要覆盖整条消息：标记没有 <p> 包裹时，图片会插到 .mes_text 外层
    const scope = root.closest('.mes') || root;
    scope.querySelectorAll('.illust-inline').forEach(n => n.remove());
    scope.querySelectorAll('.illust-marker-hidden').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent || ''));
    });
    root.normalize();

    const entries = parseMarkers(mes.mes || '');
    if (!entries.length) return;

    const cfg = settings();
    const max = Math.max(1, Number(cfg.maxPerMessage) || 1);
    const store = mes.extra?.illust || {};

    const findMarkerNode = () => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return node.parentElement?.closest('.illust-marker-hidden')
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT;
            },
        });
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const idx = node.nodeValue.indexOf(MARKER_OPEN);
            if (idx === -1) continue;
            const hit = scanMarkerAt(node.nodeValue, idx);
            if (!hit) continue;
            return { node, idx, end: hit.end };
        }
        return null;
    };

    let shown = 0;
    let guard = 0;
    while (guard++ < 8) {
        const hit = findMarkerNode();
        if (!hit) break;

        const { node, idx, end } = hit;
        const markerText = node.nodeValue.slice(idx, end + 1);
        const entry = entries.find(e => e.marker === markerText);

        if (!entry) {
            const tail = node.splitText(idx);
            tail.nodeValue = tail.nodeValue.slice(markerText.length);
            continue;
        }

        const span = document.createElement('span');
        span.className = 'illust-marker-hidden';
        span.textContent = markerText;

        const tail = node.splitText(idx);
        tail.nodeValue = tail.nodeValue.slice(markerText.length);
        node.parentNode.insertBefore(span, tail);

        if (shown < max) {
            const saved = store[entry.key];
            const tag = `${mesId}:${entry.key}`;
            const isGenerating = opts.pending || busy.has(tag) || pending.has(tag);
            let box;
            if (saved?.url) {
                const rk = `${mesId}:${entry.key}`;
                if (cfg.privacyMode && !revealedImages.has(rk)) {
                    box = makeRevealBox(mesId, entry, rk);
                } else {
                    box = makeImageBox(
                        saved.url,
                        mesId,
                        entry,
                        cfg.privacyMode
                            ? () => { revealedImages.delete(rk); decorate(mesId, chatArray()[mesId]); }
                            : null,
                    );
                }
            } else if (isGenerating) {
                box = makeStatusBox('正在绘制插图…');
            } else if (cfg.mode === 'button' || saved?.error || !isLatestMessage(mesId) || opts.showButton) {
                box = makeGenerateButton(mesId, entry, saved?.error);
            }
            if (box) {
                const block = span.closest('p, div, li') || root;
                block.parentNode.insertBefore(box, block.nextSibling);
            }
            shown++;
        }
    }
}

async function decorateAll() {
    const chat = await refreshChatCache();
    if (!chat?.length) return;

    const nodes = document.querySelectorAll('#chat .mes[mesid]');
    for (const el of nodes) {
        const id = Number(el.getAttribute('mesid'));
        if (!Number.isFinite(id)) continue;
        const mes = chat[id];
        if (!mes || mes.is_user) continue;
        if (!parseMarkers(mes.mes || '').length) continue;
        try {
            decorate(id, mes);
        } catch (err) {
            console.error(`${LOG} decorate failed`, err);
        }
    }
    watchScrollBack();
    updateFab();
}

let decorateTimer = null;
function scheduleDecorateAll(delay = 150) {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => {
        decorateTimer = null;
        decorateAll().catch(e => console.error(LOG, e));
    }, delay);
}

async function handleMessage(mesId, opts = {}) {
    const cfg = settings();
    if (!cfg.enabled) return;
    if (cfg.mode !== 'auto' && !opts.force) return;

    const chat = await refreshChatCache();
    const mes = chat[mesId];
    if (!mes || mes.is_user) return;

    const entries = parseMarkers(mes.mes || '');
    if (!entries.length) return;

    const isLatest = Number(mesId) === chat.length - 1;
    if (!opts.force && !isLatest) return;

    const entry = entries[0];
    const store = mes.extra?.illust || {};
    if (!opts.force && store[entry.key]?.url) return;

    decorate(mesId, mes, { pending: true });
    await ensureImage(mesId, entry);
    decorate(mesId, mes);
    updateFab();
}

function onCharacterRendered(mesId) {
    const mes = chatArray()[mesId];
    if (!mes || mes.is_user) return;
    if (!parseMarkers(mes.mes || '').length) return;

    decorate(mesId, mes);
    updateFab();
}

function onMessageReceived(mesId) {
    handleMessage(mesId).catch(e => console.error(LOG, e));
}

/* ------------------------------------------------------------------ */
/* 历史面板（含单张 / 批量删除）                                        */
/* ------------------------------------------------------------------ */

function collectIllustrations() {
    const chat = chatArray();
    const items = [];
    chat.forEach((mes, i) => {
        const store = mes?.extra?.illust;
        if (!store) return;
        for (const [key, v] of Object.entries(store)) {
            if (v?.url) {
                items.push({ mesId: i, key, url: v.url, prompt: v.prompt || '', at: v.at || 0, name: mes.name || '' });
            }
        }
    });
    return items.sort((a, b) => a.mesId - b.mesId);
}

function jumpToMessage(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('illust-highlight');
    setTimeout(() => el.classList.remove('illust-highlight'), 1600);
}

function openHistoryPanel() {
    document.querySelector('.illust-history-overlay')?.remove();
    if (!chatCache.length) refreshChatCache().then(() => render());
    historyState.open = true;

    let items = collectIllustrations();
    const selected = new Set();
    let selectMode = false;

    const overlay = document.createElement('div');
    overlay.className = 'illust-history-overlay';
    overlay.innerHTML = `
        <div class="illust-history-panel">
            <div class="illust-history-head">
                <b class="illust-history-title"></b>
                <div class="illust-history-tools">
                    <button type="button" class="illust-hd-btn" data-act="select">选择</button>
                    <button type="button" class="illust-hd-btn" data-act="selectAll" hidden>全选</button>
                    <button type="button" class="illust-hd-btn illust-hd-danger" data-act="deleteSelected" hidden>删除</button>
                    <button type="button" class="illust-hd-btn" data-act="cancel" hidden>取消</button>
                    <button type="button" class="illust-hd-btn illust-hd-close" data-act="close">✕</button>
                </div>
            </div>
            <div class="illust-history-grid"></div>
            <div class="illust-history-foot">点缩略图看大图 · 「定位」跳回原消息 · 左上角 🗑 删除单张 · 「选择」后可批量删除</div>
        </div>`;

    const title = overlay.querySelector('.illust-history-title');
    const grid = overlay.querySelector('.illust-history-grid');
    const btn = (act) => overlay.querySelector(`[data-act="${act}"]`);

    const syncTools = () => {
        title.textContent = selectMode
            ? `已选 ${selected.size} / ${items.length}`
            : `本聊天插图历史（${items.length}）`;
        btn('select').hidden = selectMode;
        btn('selectAll').hidden = !selectMode;
        btn('deleteSelected').hidden = !selectMode;
        btn('cancel').hidden = !selectMode;
        btn('deleteSelected').textContent = selected.size ? `删除(${selected.size})` : '删除';
        btn('deleteSelected').disabled = selected.size === 0;
    };

    const render = () => {
        grid.textContent = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'illust-history-empty';
            empty.textContent = '本聊天还没有生成过插图';
            grid.appendChild(empty);
            syncTools();
            return;
        }

        for (const it of items) {
            const id = `${it.mesId}:${it.key}`;
            const card = document.createElement('div');
            card.className = 'illust-history-card' + (selected.has(id) ? ' selected' : '');
            card.title = it.prompt || '';

            const img = document.createElement('img');
            img.src = it.url;
            img.loading = 'lazy';
            img.alt = 'illustration';

            const meta = document.createElement('div');
            meta.className = 'illust-history-meta';
            meta.textContent = `#${it.mesId + 1} · ${it.name || ''}`;

            const locate = document.createElement('button');
            locate.type = 'button';
            locate.className = 'illust-history-open';
            locate.textContent = '定位';
            locate.title = '跳转到原消息';
            locate.addEventListener('click', (e) => {
                e.stopPropagation();
                closeOverlay();
                jumpToMessage(it.mesId);
            });

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'illust-card-del';
            del.textContent = '🗑';
            del.title = '删除这张';
            del.dataset.act = 'delOne';

            const mark = document.createElement('span');
            mark.className = 'illust-card-check';
            mark.hidden = !selectMode;

            card.append(img, meta, locate, del, mark);

            img.addEventListener('click', () => {
                if (selectMode) {
                    if (selected.has(id)) { selected.delete(id); card.classList.remove('selected'); }
                    else { selected.add(id); card.classList.add('selected'); }
                    syncTools();
                } else {
                    // 直接开大图（可缩放 / 重新生成 / 改提示词），不关面板
                    openLightbox(it.url, it.mesId, { key: it.key, desc: '', tags: '' });
                }
            });

            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!window.confirm('删除这张插图？')) return;
                await deleteIllustrations([it]);
                items = collectIllustrations();
                selected.clear();
                render();
            });

            grid.appendChild(card);
        }
        syncTools();
    };

    const closeOverlay = () => {
        historyState.open = false;
        overlay.remove();
        document.removeEventListener('keydown', esc);
    };

    overlay.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.getAttribute('data-act');
        if (!act) {
            if (e.target === overlay) closeOverlay();
            return;
        }
        e.stopPropagation();

        if (act === 'close') closeOverlay();
        else if (act === 'select') { selectMode = true; render(); }
        else if (act === 'cancel') { selectMode = false; selected.clear(); render(); }
        else if (act === 'selectAll') {
            if (selected.size === items.length) selected.clear();
            else items.forEach(it => selected.add(`${it.mesId}:${it.key}`));
            render();
        } else if (act === 'deleteSelected') {
            if (!selected.size) return;
            if (!window.confirm(`删除选中的 ${selected.size} 张插图？`)) return;
            const targets = items.filter(it => selected.has(`${it.mesId}:${it.key}`));
            await deleteIllustrations(targets.map(it => ({ mesId: it.mesId, key: it.key })));
            items = collectIllustrations();
            selected.clear();
            render();
        }
    });

    function esc(e) {
        if (e.key === 'Escape' && document.body.contains(overlay)) closeOverlay();
    }
    document.addEventListener('keydown', esc);

    render();
    document.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                           */
/* ------------------------------------------------------------------ */

const BACKEND_LABEL = {
    relay: '中转站直连（推荐）',
    a1111: '本地 A1111 / 适配器',
    tavern: '酒馆「图像生成」后端',
};

function renderSettingsUi(storeInfo = { persistent: true }) {
    const hostEl = document.getElementById('extensions_settings');
    if (!hostEl || document.getElementById('illust-portable-settings')) return;

    const cfg = settings();
    const box = document.createElement('div');
    box.id = 'illust-portable-settings';
    box.className = 'extension_container';
    box.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>插图标记自动配图</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-enabled"><span>启用插件</span></label>
                <label>生成方式
                    <select id="illust-portable-mode" class="text_pole">
                        <option value="auto">自动：收到带标记的回复就出图</option>
                        <option value="button">手动：消息里显示按钮，点击后再生图</option>
                    </select>
                </label>

                <hr>
                <label>生图后端
                    <select id="illust-portable-backend" class="text_pole">
                        <option value="relay">中转站直连（推荐，不依赖本机服务）</option>
                        <option value="a1111">本地 A1111 / 适配器</option>
                        <option value="tavern">酒馆「图像生成」后端</option>
                    </select>
                </label>

                <div data-backend="relay">
                    <label>中转站地址 <input type="text" id="illust-portable-relay-url" class="text_pole" placeholder="https://example.com/v1"></label>
                    <label>API Key <input type="password" id="illust-portable-relay-key" class="text_pole" placeholder="sk-... 或 nbk_..."></label>
                    <label>模型 <input type="text" id="illust-portable-relay-model" class="text_pole" list="illust-portable-relay-models" placeholder="留空用中转站默认"></label>
                    <datalist id="illust-portable-relay-models"></datalist>
                    <div class="illust-settings-row">
                        <button type="button" id="illust-portable-relay-test" class="menu_button">测试连接</button>
                        <button type="button" id="illust-portable-relay-fetch" class="menu_button">拉取模型列表</button>
                    </div>
                    <small class="illust-settings-hint" id="illust-portable-relay-hint"></small>
                </div>

                <div data-backend="a1111">
                    <label>A1111 地址 <input type="text" id="illust-portable-a1111-url" class="text_pole" placeholder="http://127.0.0.1:7860"></label>
                    <label>模型 <input type="text" id="illust-portable-a1111-model" class="text_pole" list="illust-portable-a1111-models" placeholder="留空用 WebUI 当前模型"></label>
                    <datalist id="illust-portable-a1111-models"></datalist>
                    <label>采样器 <input type="text" id="illust-portable-a1111-sampler" class="text_pole" placeholder="Euler a"></label>
                    <label>用户名（可选） <input type="text" id="illust-portable-a1111-user" class="text_pole"></label>
                    <label>密码（可选） <input type="password" id="illust-portable-a1111-pass" class="text_pole"></label>
                    <div class="illust-settings-row">
                        <button type="button" id="illust-portable-a1111-fetch" class="menu_button">拉取模型列表</button>
                    </div>
                </div>

                <div data-backend="tavern">
                    <label>后端地址（留空沿用酒馆配置） <input type="text" id="illust-portable-adapter-url" class="text_pole" placeholder="http://127.0.0.1:7860"></label>
                    <small class="illust-settings-hint">TauriTavern 的 /api/* 由前端接管，没实现的接口会返回 404；这种环境下请用「中转站直连」。</small>
                </div>

                <hr>
                <label>分辨率
                    <span class="illust-settings-row">
                        <input type="number" id="illust-portable-width" class="text_pole" min="256" max="1344" step="16" title="宽">
                        ×
                        <input type="number" id="illust-portable-height" class="text_pole" min="256" max="1344" step="16" title="高">
                    </span>
                </label>
                <label>采样步数 <input type="number" id="illust-portable-steps" class="text_pole" min="1" max="50" step="1"></label>
                <label>CFG <input type="number" id="illust-portable-cfg" class="text_pole" min="0" max="20" step="0.5"></label>
                <label>种子（-1 = 随机） <input type="number" id="illust-portable-seed" class="text_pole" min="-1" max="999999999" step="1"></label>
                <label>每次出图张数 <input type="number" id="illust-portable-batch" class="text_pole" min="1" max="4" step="1"></label>

                <hr>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-tags-only"><span>只用竖线后的 Danbooru 标签段做提示词</span></label>
                <label>提示词预处理
                    <select id="illust-portable-weights" class="text_pole">
                        <option value="strip">去掉 NovelAI 语法，只留标签（推荐）</option>
                        <option value="a1111">转成 A1111 权重 (tag:1.2)</option>
                        <option value="raw">原样发送</option>
                    </select>
                </label>
                <small>可以直接粘 NovelAI 写法：<code>0.6::tag1, tag2::</code>、<code>[tag]</code>、<code>{tag}</code>，会按上面选的方式转换。</small>
                <label>前缀提示词 <input type="text" id="illust-portable-prefix" class="text_pole"></label>
                <label>负面提示词 <input type="text" id="illust-portable-negative" class="text_pole"></label>
                <label>每条消息最多 <input type="number" id="illust-portable-max" class="text_pole" min="1" max="4" step="1"></label>

                <hr>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-privacy"><span>隐私模式：默认折叠图片，点按钮才显示</span></label>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-fab"><span>显示悬浮球（🖼 跳到最新插图 / ↩ 回到阅读位置）</span></label>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-notify"><span>生图完成时弹出提示条</span></label>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-vibrate"><span>生图完成时振动提醒（手机）</span></label>

                <hr>
                <label class="checkbox_label"><input type="checkbox" id="illust-portable-retry"><span>空白图自动重试</span></label>
                <label>最多尝试次数 <input type="number" id="illust-portable-attempts" class="text_pole" min="1" max="5" step="1"></label>
                <label>最小请求间隔（毫秒） <input type="number" id="illust-portable-interval" class="text_pole" min="0" max="120000" step="500"></label>

                <button type="button" id="illust-portable-history" class="menu_button">🖼 查看本聊天插图历史</button>
                <small class="illust-settings-hint" id="illust-portable-capabilities"></small>
            </div>
        </div>`;
    hostEl.appendChild(box);

    const $ = (sel) => box.querySelector(sel);
    const el = {
        enabled: $('#illust-portable-enabled'),
        mode: $('#illust-portable-mode'),
        backend: $('#illust-portable-backend'),
        relayUrl: $('#illust-portable-relay-url'),
        relayKey: $('#illust-portable-relay-key'),
        relayModel: $('#illust-portable-relay-model'),
        relayTest: $('#illust-portable-relay-test'),
        relayFetch: $('#illust-portable-relay-fetch'),
        relayHint: $('#illust-portable-relay-hint'),
        relayModels: $('#illust-portable-relay-models'),
        a1111Url: $('#illust-portable-a1111-url'),
        a1111Model: $('#illust-portable-a1111-model'),
        a1111Sampler: $('#illust-portable-a1111-sampler'),
        a1111User: $('#illust-portable-a1111-user'),
        a1111Pass: $('#illust-portable-a1111-pass'),
        a1111Fetch: $('#illust-portable-a1111-fetch'),
        a1111Models: $('#illust-portable-a1111-models'),
        adapterUrl: $('#illust-portable-adapter-url'),
        width: $('#illust-portable-width'),
        height: $('#illust-portable-height'),
        steps: $('#illust-portable-steps'),
        cfg: $('#illust-portable-cfg'),
        seed: $('#illust-portable-seed'),
        batch: $('#illust-portable-batch'),
        tagsOnly: $('#illust-portable-tags-only'),
        weights: $('#illust-portable-weights'),
        prefix: $('#illust-portable-prefix'),
        negative: $('#illust-portable-negative'),
        max: $('#illust-portable-max'),
        privacy: $('#illust-portable-privacy'),
        fab: $('#illust-portable-fab'),
        notify: $('#illust-portable-notify'),
        vibrate: $('#illust-portable-vibrate'),
        retry: $('#illust-portable-retry'),
        attempts: $('#illust-portable-attempts'),
        interval: $('#illust-portable-interval'),
        history: $('#illust-portable-history'),
        capabilities: $('#illust-portable-capabilities'),
    };

    /* ---- 填充当前值 ---- */
    el.enabled.checked = !!cfg.enabled;
    el.mode.value = cfg.mode;
    el.backend.value = cfg.backend;
    el.relayUrl.value = cfg.relayBaseUrl;
    el.relayKey.value = cfg.relayApiKey;
    el.relayModel.value = cfg.relayModel;
    el.a1111Url.value = cfg.a1111Url;
    el.a1111Model.value = cfg.a1111Model;
    el.a1111Sampler.value = cfg.a1111Sampler;
    el.a1111User.value = cfg.a1111User;
    el.a1111Pass.value = cfg.a1111Pass;
    el.adapterUrl.value = cfg.adapterUrl;
    el.width.value = cfg.width;
    el.height.value = cfg.height;
    el.steps.value = cfg.steps;
    el.cfg.value = cfg.cfg;
    el.seed.value = cfg.seed;
    el.batch.value = cfg.batch;
    el.tagsOnly.checked = !!cfg.useTagsOnly;
    el.weights.value = cfg.weightMode;
    el.prefix.value = cfg.prefix;
    el.negative.value = cfg.negative;
    el.max.value = cfg.maxPerMessage;
    el.privacy.checked = !!cfg.privacyMode;
    el.fab.checked = cfg.showFab !== false;
    el.notify.checked = cfg.notifyDone !== false;
    el.vibrate.checked = cfg.vibrate !== false;
    el.retry.checked = cfg.retryOnBlank !== false;
    el.attempts.value = cfg.maxAttempts;
    el.interval.value = cfg.minIntervalMs;

    const syncBackendSections = () => {
        box.querySelectorAll('[data-backend]').forEach(section => {
            section.hidden = section.dataset.backend !== el.backend.value;
        });
    };
    syncBackendSections();

    /* ---- 绑定 ---- */
    const bindText = (input, key, transform = (v) => v) => {
        input.addEventListener('input', () => updateSettings({ [key]: transform(input.value) }));
    };
    const bindNumber = (input, key, min, max, fallback) => {
        input.addEventListener('change', () => {
            const value = clampInt(input.value, min, max, fallback);
            input.value = value;
            updateSettings({ [key]: value });
        });
    };
    const bindCheck = (input, key, after = null) => {
        input.addEventListener('change', () => {
            updateSettings({ [key]: input.checked });
            if (after) after();
        });
    };

    bindCheck(el.enabled, 'enabled', () => scheduleDecorateAll(50));
    el.mode.addEventListener('change', () => {
        updateSettings({ mode: el.mode.value });
        scheduleDecorateAll(50);
    });
    el.backend.addEventListener('change', () => {
        updateSettings({ backend: el.backend.value });
        syncBackendSections();
    });

    bindText(el.relayUrl, 'relayBaseUrl', v => v.trim());
    bindText(el.relayKey, 'relayApiKey', v => v.trim());
    bindText(el.relayModel, 'relayModel', v => v.trim());

    bindText(el.a1111Url, 'a1111Url', v => v.trim());
    bindText(el.a1111Model, 'a1111Model', v => v.trim());
    bindText(el.a1111Sampler, 'a1111Sampler', v => v.trim());
    bindText(el.a1111User, 'a1111User', v => v.trim());
    bindText(el.a1111Pass, 'a1111Pass', v => v.trim());
    bindText(el.adapterUrl, 'adapterUrl', v => v.trim());

    bindNumber(el.width, 'width', 256, 1344, DEFAULTS.width);
    bindNumber(el.height, 'height', 256, 1344, DEFAULTS.height);
    bindNumber(el.steps, 'steps', 1, 50, DEFAULTS.steps);
    bindNumber(el.seed, 'seed', -1, 999999999, -1);
    bindNumber(el.batch, 'batch', 1, 4, 1);
    el.cfg.addEventListener('change', () => {
        const value = Math.min(20, Math.max(0, Number(el.cfg.value) || DEFAULTS.cfg));
        el.cfg.value = value;
        updateSettings({ cfg: value });
    });

    bindCheck(el.tagsOnly, 'useTagsOnly');
    el.weights.addEventListener('change', () => updateSettings({ weightMode: el.weights.value }));
    bindText(el.prefix, 'prefix');
    bindText(el.negative, 'negative');
    bindNumber(el.max, 'maxPerMessage', 1, 4, 1);

    bindCheck(el.privacy, 'privacyMode', () => {
        revealedImages.clear();
        scheduleDecorateAll(50);
    });
    bindCheck(el.fab, 'showFab', () => updateFab());
    bindCheck(el.notify, 'notifyDone');
    bindCheck(el.vibrate, 'vibrate');
    bindCheck(el.retry, 'retryOnBlank');
    bindNumber(el.attempts, 'maxAttempts', 1, 5, 2);
    bindNumber(el.interval, 'minIntervalMs', 0, 120000, 0);

    el.max.addEventListener('change', () => scheduleDecorateAll(50));

    el.history.addEventListener('click', openHistoryPanel);

    /* ---- 中转站：测试连接 / 拉模型 ---- */
    const setHint = (text, kind = '') => {
        el.relayHint.textContent = text;
        el.relayHint.dataset.kind = kind;
    };

    el.relayTest.addEventListener('click', async () => {
        el.relayTest.disabled = true;
        setHint('正在测试，可能要等 10–60 秒…');
        const result = await testRelay(settings());
        el.relayTest.disabled = false;
        if (result.ok) {
            setHint(`✅ 连接正常 · ${(result.ms / 1000).toFixed(1)} 秒 · 约 ${Math.round(result.bytes / 1024)} KB`, 'ok');
        } else {
            setHint(`❌ ${result.error}`, 'error');
        }
    });

    el.relayFetch.addEventListener('click', async () => {
        el.relayFetch.disabled = true;
        setHint('正在拉取模型列表…');
        const models = await listRelayModels(settings());
        el.relayFetch.disabled = false;

        el.relayModels.textContent = '';
        for (const name of models) {
            const option = document.createElement('option');
            option.value = name;
            el.relayModels.appendChild(option);
        }
        setHint(models.length
            ? `找到 ${models.length} 个模型，输入框里可以直接选`
            : '中转站没有返回模型列表（不影响出图，手动填模型名即可）');
    });

    el.a1111Fetch.addEventListener('click', async () => {
        el.a1111Fetch.disabled = true;
        const models = await listA1111Models(settings());
        el.a1111Fetch.disabled = false;

        el.a1111Models.textContent = '';
        for (const name of models) {
            const option = document.createElement('option');
            option.value = name;
            el.a1111Models.appendChild(option);
        }
        showToast(models.length ? `找到 ${models.length} 个模型` : '没读到模型列表');
    });

    /* ---- 宿主能力提示 ---- */
    capabilities().then(caps => {
        const lines = [`宿主：${caps.host}`];
        if (!storeInfo.persistent) lines.push('⚠️ 没找到宿主的设置存储，设置只在本次会话有效（刷新会恢复默认）');
        if (!caps.saveFile) lines.push('⚠️ 当前宿主不能把图片写入磁盘，插图会以 data URL 直接存进聊天记录（体积较大）');
        if (!caps.events) lines.push('⚠️ 没检测到事件总线，改用 DOM 变化监听（响应稍慢，功能正常）');
        if (caps.tauriTavern) lines.push('TauriTavern：推荐用「中转站直连」后端');
        el.capabilities.textContent = lines.join(' · ');
    }).catch(() => { /* ignore */ });
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

let started = false;

async function start() {
    if (started) return;
    started = true;

    // 先解析宿主设置容器：ST 的 extension_settings 是模块导出，不在 window 上
    const storeInfo = await resolveSettingsStore();

    settings();
    await refreshChatCache();
    renderSettingsUi(storeInfo);

    // 设置面板可能要等酒馆的扩展抽屉渲染完才存在
    if (!document.getElementById('illust-portable-settings')) {
        setTimeout(() => renderSettingsUi(storeInfo), 800);
        setTimeout(() => renderSettingsUi(storeInfo), 2500);
    }

    const wired = await wireHostEvents();

    /** 宿主没有事件总线时，靠 MutationObserver 兜底 */
    watchChatDom(wired);

    scheduleDecorateAll(400);
    setTimeout(() => scheduleDecorateAll(50), 1500);

    watchScrollBack();
    updateFab();

    console.log(`${LOG} loaded · backend=${settings().backend} · host=${hostName()}`);

    globalThis.__illustHistory = openHistoryPanel;
    globalThis.__illustDecorateAll = () => scheduleDecorateAll(0);
    globalThis.__illustJump = jumpToLatestIllustration;
    globalThis.__illustOnGenDone = onGenDone;
    globalThis.__illustSettings = settings;
    globalThis.__illustCapabilities = capabilities;
}

async function wireHostEvents() {
    const bound = [];

    await onHostEvent(['CHARACTER_MESSAGE_RENDERED'], (mesId) => {
        try { onCharacterRendered(mesId); } catch (e) { console.error(LOG, e); }
    }).then(list => bound.push(...list));

    await onHostEvent(['MESSAGE_RECEIVED'], (mesId) => {
        try { onMessageReceived(mesId); } catch (e) { console.error(LOG, e); }
    }).then(list => bound.push(...list));

    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
        await onHostEvent([name], () => {
            refreshChatCache().then(() => scheduleDecorateAll(250));
        }).then(list => bound.push(...list));
    }

    await onHostEvent(['CHAT_CHANGED'], () => {
        lastDone = null;
        unseenCount = 0;
        savedScrollTop = null;
        hideProgress();
    }).then(list => bound.push(...list));

    return bound.length > 0;
}

/**
 * 兜底驱动：既处理「宿主没有事件总线」的情况，也处理宿主事件名缺失
 * 的情况（例如某些精简前端只实现了部分 event_types）。
 * 已经有事件总线时，这里只做低频兜底，不抢主路径。
 */
function watchChatDom(hasEvents) {
    const chatRoot = document.getElementById('chat');
    if (!chatRoot || typeof MutationObserver === 'undefined') return;

    let debounce = null;
    const observer = new MutationObserver((mutations) => {
        let sawMessage = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList?.contains('mes') || node.querySelector?.('.mes')) {
                    sawMessage = true;
                    break;
                }
            }
            if (sawMessage) break;
        }
        if (!sawMessage) return;

        clearTimeout(debounce);
        debounce = setTimeout(() => {
            scheduleDecorateAll(200);
            // 没有事件总线时，还得自己触发自动出图
            if (!hasEvents) autoGenerateLatest();
        }, hasEvents ? 200 : 400);
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
}

let autoGenTimer = null;
function autoGenerateLatest() {
    clearTimeout(autoGenTimer);
    autoGenTimer = setTimeout(async () => {
        const chat = await refreshChatCache();
        const last = chat.length - 1;
        if (last < 0) return;
        handleMessage(last).catch(e => console.error(LOG, e));
    }, 1200);
}

/**
 * 启动时机：宿主已经跑起来（DOMContentLoaded 之后），或者马上就好。
 * 用 jQuery.ready 只在 jQuery 存在时才有意义，所以直接看 readyState。
 *
 * 另外加一层「入口文件预检」：
 *   酒馆（以及 TauriTavern）的扩展加载器是 `script.onload` 驱动的，
 *   脚本一旦 404 或顶层抛错，onload 不会触发，加载器会卡住，
 *   排在后面的扩展全都不会启动。所以先自己 HEAD 一下入口文件，
 *   确认同源静态端点能返回 JS，再决定是否启动 —— 失败就只打日志，不拖累别人。
 */
async function entryIsReachable() {
    const entry = document.currentScript?.src || '';
    if (!entry) return true;

    try {
        const res = await fetch(entry, { method: 'GET', cache: 'no-store' });
        if (!res.ok) {
            console.error(`${LOG} entry not served (${res.status}): ${entry}`);
            return false;
        }
        const type = String(res.headers.get('content-type') || '');
        // 被吞成 index.html 是最常见的坑，提前识别出来
        if (type.includes('text/html')) {
            console.error(`${LOG} entry served as HTML instead of JS: ${entry}`);
            return false;
        }
        return true;
    } catch (error) {
        console.warn(`${LOG} entry probe failed, starting anyway`, error);
        return true;
    }
}

function boot() {
    entryIsReachable()
        .then(ok => (ok ? start() : null))
        .catch(e => console.error(LOG, e));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}

