/**
 * 标准 A1111 / Forge / SD.Next provider
 *
 *   GET  {baseUrl}/sdapi/v1/sd-models   取模型列表
 *   POST {baseUrl}/sdapi/v1/txt2img     出图
 *
 * 适用于本机跑的 WebUI，或任何对外暴露 A1111 兼容接口的中转/适配器。
 */

import { IllustError, fetchJson } from './index.js';

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

export const a1111Provider = {
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
export async function listA1111Models(settings) {
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
