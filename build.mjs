// 把 lib/ 与 index.js 打成一个单文件扩展入口。
// 原因：SillyTavern 的 /scripts/extensions/<name>/* 只服务扩展根目录，
// 子目录里的 ESM 会 404；而且加载器是 script.onload 驱动，模块失败会卡住
// 后续所有扩展。单文件 + 相对 import 能同时满足两个宿主。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const OUT = process.argv[3];
if (!ROOT || !OUT) {
    console.error('usage: node build.mjs <repoRoot> <outFile>');
    process.exit(1);
}

const ORDER = [
    'lib/host.js',
    'lib/settings.js',
    'lib/prompt.js',
    'lib/providers/index.js',
    'lib/providers/relay.js',
    'lib/providers/a1111.js',
    'lib/providers/tavern.js',
    'lib/blank.js',
    'index.js',
];

/**
 * 把 import 语句整行去掉。
 *
 * 但 `import * as ns from '...'` 会被去掉后留下未定义的 ns，
 * 而普通具名 import 的类型是会被内联的顶层声明覆盖的，所以只拦命名空间这一种。
 */
function stripImports(code, rel) {
    const namespaceImports = [...code.matchAll(/^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?\s*$/gm)];
    for (const m of namespaceImports) {
        hardErrors.push(
            `"${rel}" uses namespace import \`import * as ${m[1]} from '${m[2]}'\` — ` +
            '单文件构建会把它删掉并留下未定义引用，请改用具名 import',
        );
    }

    return code.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
}

/** 收集模块里所有「顶格」声明（列 0），用于跨模块重名检测 */
function collectTopLevelDecls(code) {
    const names = new Set();
    // 必须从第 0 列开始：缩进的就是函数体内部的局部变量，不参与冲突判断
    const patterns = [
        /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
        /^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm,
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm,
    ];
    for (const re of patterns) {
        for (const m of code.matchAll(re)) names.add(m[1]);
    }
    return names;
}

const chunks = [];
const declarations = new Map(); // name -> file
const hardErrors = [];
const banner = `/**
 * 插图标记自动配图 (illust-marker) —— 单文件构建产物
 *
 * 这个文件由 \`node build.mjs\` 从 lib/ 与 index.js 生成，请勿直接编辑；
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
`;

const seen = new Set();
for (const rel of ORDER) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
        console.error('missing file: ' + file);
        process.exit(1);
    }

    const original = fs.readFileSync(file, 'utf8');

    // 跨模块顶层重名在单文件里就是 SyntaxError，必须在构建期拦下
    for (const name of collectTopLevelDecls(original)) {
        if (declarations.has(name)) {
            hardErrors.push(`duplicate top-level declaration "${name}": ${declarations.get(name)} vs ${rel}`);
        } else {
            declarations.set(name, rel);
        }
    }

    let code = original;

    // 去掉 export 关键字，保留声明本身
    code = code
        .replace(/^\s*export\s+default\s+/gm, 'const __default__ = ')
        .replace(/^(\s*)export\s+(async\s+function|function|class|const|let|var)/gm, '$1$2')
        .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');

    code = stripImports(code, rel);

    chunks.push(`/* ===== ${rel} ===== */\n${code.trim()}\n`);
}

if (hardErrors.length) {
    console.error('build failed:');
    for (const err of hardErrors) console.error('  ✗ ' + err);
    process.exit(1);
}

const output = banner + '\n' + chunks.join('\n') + '\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, output, 'utf8');

console.log(`built ${OUT} · ${output.length} bytes · ${ORDER.length} modules`);
