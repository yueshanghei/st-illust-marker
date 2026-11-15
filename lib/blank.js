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
export async function isBlankImage(base64) {
    const bytes = base64ToBytes(base64);

    if (bytes && looksTiny(bytes)) return true;
    if (!bytes) return false;

    const byColor = await colorLooksBlank(String(base64).replace(/^data:image\/[a-z+]+;base64,/i, ''));
    return byColor === true;
}

export { BLANK_MAX_CHANNEL, TINY_BYTES };
