'use strict';
/**
 * BStatsWorker.js
 * 在 worker_threads 子线程中运行，负责向 bstats.org 发送遥测数据。
 * 不使用任何 LLSE API，仅依赖 Node.js 内置模块。
 *
 * 与主线程通信：
 *   主 → 子：{ type: 'submit', payload: {...} }
 *   子 → 主：{ type: 'log'|'warn'|'error'|'done', ... }
 */

const { parentPort, workerData } = require('worker_threads');
const https = require('https');
const http  = require('http');

let _reqId = undefined;
const send  = (type, payload = {}) => parentPort.postMessage({ type, id: _reqId, ...payload });
const log   = (msg) => send('log',   { msg: `[BStats] ${msg}` });
const warn  = (msg) => send('warn',  { msg: `[BStats] ${msg}` });
const error = (msg) => send('error', { msg: `[BStats] ${msg}` });

// ── HTTP POST (JSON) ────────────────────────────────────────
function httpPost(url, jsonBody, ms = 15000) {
    return new Promise((resolve, reject) => {
        const body   = JSON.stringify(jsonBody);
        const parsed = new URL(url);
        const mod    = parsed.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + parsed.search,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent':     'BStats/1.0 NEssential',
            },
        };

        const timer = setTimeout(() => reject(new Error('请求超时')), ms);
        const req   = mod.request(options, (res) => {
            clearTimeout(timer);
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', e => { clearTimeout(timer); reject(e); });
        req.write(body);
        req.end();
    });
}

// ── 主消息处理 ──────────────────────────────────────────────
parentPort.on('message', async (msg) => {
    _reqId = msg.id;
    if (msg.type !== 'submit') return;

    const { pluginId, payload } = msg;
    const url = `https://bstats.org/api/v2/data/bukkit`;

    try {
        log(`上报遥测数据 (pluginId=${pluginId})...`);
        const result = await httpPost(url, { ...payload, pluginId });

        if (result.status === 200 || result.status === 201) {
            log('遥测数据上报成功');
            send('done', { status: 'success' });
        } else {
            warn(`遥测上报返回 HTTP ${result.status}`);
            send('done', { status: 'warn', httpStatus: result.status });
        }
    } catch (err) {
        // 遥测失败不影响插件运行，静默处理
        warn(`遥测上报失败: ${err.message}`);
        send('done', { status: 'error', message: err.message });
    }
});
