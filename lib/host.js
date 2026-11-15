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

export function isTauriTavern() {
    const g = globals();
    return !!(g.__TAURITAVERN__ || g.__TAURI_RUNNING__ || g.__TAURI_INTERNALS__);
}

export function isMobileHost() {
    const g = globals();
    const api = g.__TAURITAVERN__;
    try {
        if (typeof api?.isMobileHost === 'function') return !!api.isMobileHost();
        if (typeof api?.host?.kind === 'string') return api.host.kind === 'mobile';
    } catch { /* ignore */ }
    return false;
}

/** 宿主标识，仅用于日志和设置面板展示，不参与任何逻辑分支 */
export function hostName() {
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
export function resolveSettingsStore() {
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
export function settingsStoreRef() {
    if (resolvedStore) return { store: resolvedStore, persistent: true };

    const g = globals();
    const fallback = g.extension_settings;
    if (fallback && typeof fallback === 'object') return { store: fallback, persistent: true };
    return { store: memorySettings, persistent: false };
}

export async function getSettingsStore() {
    return resolveSettingsStore();
}

export async function saveSettings() {
    const core = await loadCore();
    if (typeof core.saveSettingsDebounced === 'function') {
        try { core.saveSettingsDebounced(); } catch { /* ignore */ }
    }
}

/* ------------------------------------------------------------------ */
/* 聊天上下文                                                          */
/* ------------------------------------------------------------------ */

export async function getChat() {
    const core = await loadCore();
    if (typeof core.getContext === 'function') {
        try {
            const ctx = core.getContext();
            if (Array.isArray(ctx?.chat)) return ctx.chat;
        } catch { /* ignore */ }
    }
    return [];
}

export async function saveChat() {
    const core = await loadCore();
    const fn = core.saveChatDebounced || core.saveChat;
    if (typeof fn === 'function') {
        try { fn(); return true; } catch { /* ignore */ }
    }
    return false;
}

export async function getCharacterName() {
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
export async function onHostEvent(names, handler) {
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
export async function eventKey(name) {
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
export async function requestHeaders(extra = {}) {
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
export async function persistImage(base64, folder, name) {
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
export async function removeImage(url) {
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

export function sanitizeFolderName(name) {
    const cleaned = String(name || '')
        .replace(ILLEGAL_FILENAME_RE, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .trim();
    return cleaned || 'illust';
}

/* ------------------------------------------------------------------ */
/* 宿主能力清单（给设置面板展示）                                       */
/* ------------------------------------------------------------------ */

export async function capabilities() {
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

