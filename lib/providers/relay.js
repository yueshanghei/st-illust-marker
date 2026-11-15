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

import { IllustError, fetchJson } from './index.js';

/** 各家对 size 的接受范围差别很大，这里统一按 16 的倍数夹到 256–1344 */
export const SIZE_MIN = 256;
export const SIZE_MAX = 1344;
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

export const relayProvider = {
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
export async function testRelay(settings) {
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
export async function listRelayModels(settings) {
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
