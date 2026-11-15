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

import { IllustError } from './index.js';
import { requestHeaders } from '../host.js';

function sdSettings() {
    try {
        const store = globalThis.extension_settings;
        return store?.sd && typeof store.sd === 'object' ? store.sd : {};
    } catch {
        return {};
    }
}

/** 酒馆「图像生成」里当前选中的模型 */
export function currentSdModel() {
    const model = sdSettings().model;
    return typeof model === 'string' ? model : '';
}

/** 酒馆当前配置的生图后端地址（auto 来源时是 source_url） */
function sdBackendUrl(settings) {
    const sd = sdSettings();
    return String(settings.adapterUrl || sd.source_url || sd.auto_url || '').trim();
}

export const tavernProvider = {
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
export async function listTavernModels(settings) {
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
