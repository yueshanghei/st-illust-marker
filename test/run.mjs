/**
 * 契约测试：不需要浏览器、不需要真中转站。
 *
 *   node test/run.mjs
 *
 * 覆盖：
 *   - 提示词预处理三档 + 标记解析
 *   - 设置归一化（越界夹取、枚举兜底、旧版迁移）
 *   - 空白图检测（体积启发式）
 *   - relay provider 的真实 HTTP 往返（对接 test/mock-relay.mjs）
 *   - 错误归一（401 / 404 / 超时都变成可读中文，而不是裸 Error）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** Windows 上 import() 必须传 file:// URL，不能直接给盘符路径 */
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    }
}

function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---------------- 1. 提示词 ---------------- */
console.log('\n[prompt]');
const prompt = await mod('lib/prompt.js');

eq('strip 去掉 NovelAI 语法', prompt.stripWeights('0.6::mignon, artist:x::, [ke-ta], {smile}'), 'mignon, artist:x, ke-ta, smile');
eq('a1111 转权重', prompt.toA1111Weights('0.6::mignon::, [ke-ta], {smile}'), '(mignon:0.6), (ke-ta:0.9), (smile:1.05)');
eq('保留 A1111 交替语法', prompt.stripWeights('[a|b] tag'), '[a|b] tag');
eq('保留 A1111 阶段语法', prompt.stripWeights('[from:to:0.5] tag'), '[from:to:0.5] tag');
eq('保留已有 A1111 权重', prompt.toA1111Weights('(tag:1.2)'), '(tag:1.2)');
check('提示词截断到 1500', prompt.normalizePrompt('x'.repeat(5000), 'raw').length === 1500);

const markers = prompt.parseMarkers('lead [ILLUST: a girl | 1girl, [ke-ta], smile] tail [ILLUST: b | dog]');
eq('解析出 2 个标记', markers.length, 2);
eq('竖线后是标签段', markers[0].tags, '1girl, [ke-ta], smile');
eq('嵌套方括号不截断标记', markers[1].tags, 'dog');
check('key 稳定可复现', prompt.parseMarkers('[ILLUST: x | y]')[0].key === prompt.parseMarkers('[ILLUST: x | y]')[0].key);
check('没闭合的标记被忽略', prompt.parseMarkers('[ILLUST: broken').length === 0);

/* ---------------- 2. 设置 ---------------- */
console.log('\n[settings]');
const settings = await mod('lib/settings.js');

const junk = settings.normalizeSettings({
    width: 99999, height: 1, steps: 'abc', cfg: 999, batch: 99,
    backend: 'nope', weightMode: 'nope', mode: 'nope',
});
eq('宽度夹到上限', junk.width, 1344);
eq('高度夹到下限', junk.height, 256);
eq('步数非法回默认', junk.steps, 25);
eq('CFG 夹到上限', junk.cfg, 20);
eq('张数夹到 4', junk.batch, 4);
eq('未知 backend 回默认', junk.backend, 'relay');
eq('未知 weightMode 回默认', junk.weightMode, 'strip');
eq('未知 mode 回默认', junk.mode, 'auto');

eq('旧版适配器用户迁移为 tavern', settings.migrateLegacy({ adapterUrl: 'http://127.0.0.1:7860' }).backend, 'tavern');
eq('新用户默认走 relay', settings.migrateLegacy({ width: 832 }).backend, 'relay');
check('已设置 backend 不被迁移覆盖', settings.migrateLegacy({ backend: 'a1111' }).backend === 'a1111');

/* ---------------- 3. 空白图 ---------------- */
console.log('\n[blank]');
const blank = await mod('lib/blank.js');
const TINY = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
check('超小 PNG 判为空白', await blank.isBlankImage(TINY));
check('空字符串不判为空白', (await blank.isBlankImage('')) === false);
check('无 canvas 环境下不误判大图', (await blank.isBlankImage('A'.repeat(9000))) === false);

/* ---------------- 4. relay provider（真实 HTTP） ---------------- */
console.log('\n[relay provider]');
const PORT = 7899;
const relay = await mod('lib/providers/relay.js');

const mock = spawn(process.execPath, [path.join(HERE, 'mock-relay.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 900));

const baseSettings = {
    relayBaseUrl: `http://127.0.0.1:${PORT}/v1`,
    relayApiKey: 'test-key',
    relayModel: 'mock-anime-xl',
};

try {
    const images = await relay.relayProvider.generate(baseSettings, {
        prompt: 'a cat, masterpiece',
        negativePrompt: 'lowres',
        width: 832, height: 1216, steps: 25, cfgScale: 5, seed: -1, batchSize: 1,
    });
    check('拿到 1 张图', images.length === 1);
    check('返回的是纯 base64（无 data: 前缀）', !String(images[0]).startsWith('data:'));
    check('base64 可解码', Buffer.from(images[0], 'base64').length > 0);

    const models = await relay.listRelayModels(baseSettings);
    eq('拉到模型列表', models, ['mock-anime-xl', 'mock-realistic-xl']);

    const okTest = await relay.testRelay(baseSettings);
    check('testRelay 成功', okTest.ok === true, JSON.stringify(okTest));

    // 401：Key 错误要被归一成可读信息
    let authError = null;
    try {
        await relay.relayProvider.generate({ ...baseSettings, relayApiKey: '' }, {
            prompt: 'x', width: 512, height: 512, steps: 4, cfgScale: 3, seed: -1, batchSize: 1,
        });
    } catch (e) { authError = e; }
    check('缺 Key 报鉴权错误', !!authError && /鉴权/.test(authError.message), authError?.message);

    // 地址不可达
    let connError = null;
    try {
        await relay.relayProvider.generate({ ...baseSettings, relayBaseUrl: 'http://127.0.0.1:1/v1' }, {
            prompt: 'x', width: 512, height: 512, steps: 4, cfgScale: 3, seed: -1, batchSize: 1,
        });
    } catch (e) { connError = e; }
    check('连不上报网络错误', !!connError && /连不上/.test(connError.message), connError?.message);

    // 未填地址
    let emptyError = null;
    try {
        await relay.relayProvider.generate({ relayBaseUrl: '' }, { prompt: 'x', width: 512, height: 512 });
    } catch (e) { emptyError = e; }
    check('空地址给出明确提示', !!emptyError && /地址/.test(emptyError.message), emptyError?.message);
} finally {
    mock.kill();
}

/* ---------------- 5. 文件名清洗 ---------------- */
console.log('\n[host]');
const host = await mod('lib/host.js');
eq('非法字符替换为下划线', host.sanitizeFolderName('a/b:c*d'), 'a_b_c_d');
eq('空名回退为 illust', host.sanitizeFolderName('   '), 'illust');
eq('中文名保留', host.sanitizeFolderName('角色 名'), '角色 名');

/* ---------------- 汇总 ---------------- */
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
