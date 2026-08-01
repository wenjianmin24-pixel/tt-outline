/**
 * tt-outline 大纲 API CORS 中继（零依赖 Node.js）
 * ------------------------------------------------------------
 * 用途：
 *   手机/桌面端 WebView 直接 fetch 外部 API 时会受 CORS 限制。
 *   如果你的大纲 API 不支持跨域（大多数官方 API 都不支持），
 *   在本机或一台服务器上跑这个中继，把扩展里的「大纲 API 地址」填成中继地址即可。
 *
 * 用法：
 *   UPSTREAM_URL="https://api.openai.com/v1/chat/completions" \
 *   UPSTREAM_KEY="sk-xxxx" \
 *   PORT=8799 \
 *   node relay-server.js
 *
 * 说明：
 *   - UPSTREAM_KEY 可选：设置了就在服务端注入 Authorization，手机端无需再填 Key；
 *     不设置则透传客户端请求里的 Authorization 头。
 *   - 手机和电脑在同一局域网时，中继地址填 http://电脑局域网IP:8799
 *   - 也可以部署到 Render / Railway / Fly.io 等免费平台，获得一个公网 HTTPS 地址。
 *   - 本文件是给开发者/自用的小工具，请勿直接暴露到公网用于不受信任的流量。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const upstreamUrl = (process.env.UPSTREAM_URL || '').trim();
const upstreamKey = (process.env.UPSTREAM_KEY || '').trim();
const port = Number(process.env.PORT || 8799);

if (!upstreamUrl) {
    console.error('缺少环境变量 UPSTREAM_URL，例如：');
    console.error('  UPSTREAM_URL="https://api.openai.com/v1/chat/completions" UPSTREAM_KEY="sk-xxx" PORT=8799 node relay-server.js');
    process.exit(1);
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

function forwardRequest(reqBody) {
    return new Promise((resolve, reject) => {
        const upstream = new URL(upstreamUrl);
        const isHttps = upstream.protocol === 'https:';
        const transport = isHttps ? https : http;
        const headers = {
            'Content-Type': 'application/json',
            ...(upstreamKey ? { Authorization: `Bearer ${upstreamKey}` } : {}),
            'Content-Length': Buffer.byteLength(reqBody || ''),
        };

        const request = transport.request(
            upstream,
            { method: 'POST', headers, timeout: 60000 },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    resolve({ status: response.statusCode || 502, body });
                });
            },
        );

        request.on('timeout', () => {
            request.destroy(new Error('上游请求超时'));
        });
        request.on('error', (err) => reject(err));

        if (reqBody) {
            request.write(reqBody);
        }
        request.end();
    });
}

const server = http.createServer(async (req, res) => {
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('仅支持 POST');
        return;
    }

    // 读取请求体
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
        const reqBody = Buffer.concat(chunks).toString('utf8');

        try {
            const result = await forwardRequest(reqBody);
            res.writeHead(result.status, {
                ...CORS_HEADERS,
                'Content-Type': 'application/json; charset=utf-8',
            });
            res.end(result.body);
        } catch (err) {
            console.error('[relay] 转发失败：', err.message);
            res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: `relay 转发失败：${err.message}` } }));
        }
    });

    req.on('error', (err) => {
        console.error('[relay] 请求错误：', err.message);
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`tt-outline CORS 中继已启动`);
    console.log(`  上游地址：${upstreamUrl}`);
    console.log(`  服务地址：http://0.0.0.0:${port}/chat/completions`);
    console.log(`  手机端请在扩展里把「大纲 API 地址」填成：http://本机局域网IP:${port}`);
});
