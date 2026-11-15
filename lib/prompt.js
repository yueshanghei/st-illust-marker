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
export const PROMPT_LIMIT = 1500;

export function tidyTags(text) {
    return String(text || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .replace(/(^|,)\s*,+/g, '$1 ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();
}

/** 去掉 `0.6::…::`、`[x]`、`{x}`，只保留里面的标签 */
export function stripWeights(text) {
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
export function toA1111Weights(text) {
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
export function normalizePrompt(text, mode = 'strip') {
    const raw = String(text || '').trim();
    if (mode === 'raw') return raw.slice(0, PROMPT_LIMIT);
    if (mode === 'a1111') return toA1111Weights(raw).slice(0, PROMPT_LIMIT);
    return stripWeights(raw).slice(0, PROMPT_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 标记解析                                                            */
/* ------------------------------------------------------------------ */

export const MARKER_OPEN = '[ILLUST:';

/**
 * 从 start 开始找配对的 `]`。
 * 提示词里允许出现 `[ke-ta]`、`[modare]` 这种方括号，所以要按括号层级配对，
 * 不能简单找第一个 `]`（否则标记会被截断）。
 */
export function scanMarkerAt(text, start) {
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
export function hash(str) {
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
export function parseMarkers(text) {
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
export function promptFor(entry, settings) {
    const base = settings.useTagsOnly
        ? (entry.tags || entry.desc)
        : [entry.desc, entry.tags].filter(Boolean).join(', ');
    return `${settings.prefix || ''}${base}`;
}
