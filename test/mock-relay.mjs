/**
 * 极简的中转站 mock，用来在本地验证 provider 的请求/响应契约。
 *
 *   node test/mock-relay.mjs [port]
 *
 * 支持：
 *   GET  /v1/models               返回两个假模型
 *   POST /v1/images/generations   返回 1x1 PNG（base64），并校验关键字段
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 7899);

/** 1x1 透明 PNG */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (!req.headers.authorization?.startsWith('Bearer ')) {
            return json(res, 401, { error: { message: 'missing bearer token' } });
        }
        return json(res, 200, { data: [{ id: 'mock-anime-xl' }, { id: 'mock-realistic-xl' }] });
    }

    if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
        if (!req.headers.authorization?.startsWith('Bearer ')) {
            return json(res, 401, { error: { message: 'missing bearer token' } });
        }

        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch {
            return json(res, 400, { error: { message: 'invalid json' } });
        }

        // 契约校验：这些字段是 relay.js 承诺一定会发的
        const problems = [];
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) problems.push('prompt missing');
        if (typeof body.size !== 'string' || !/^\d+x\d+$/.test(body.size)) problems.push('size malformed: ' + body.size);
        if (body.n !== 1) problems.push('n should be 1, got ' + body.n);
        if (body.response_format !== 'b64_json') problems.push('response_format should be b64_json');
        if (typeof body.steps !== 'number') problems.push('steps should be number');
        if (typeof body.cfg_scale !== 'number') problems.push('cfg_scale should be number');
        if (problems.length) return json(res, 422, { error: { message: problems.join('; ') } });

        return json(res, 200, { data: [{ b64_json: PNG_1X1 }] });
    }

    json(res, 404, { error: { message: 'not found: ' + url.pathname } });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`mock relay listening on http://127.0.0.1:${PORT}/v1`);
});
