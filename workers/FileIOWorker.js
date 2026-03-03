'use strict';
/**
 * FileIOWorker.js
 * 在 worker_threads 子线程中处理重量级 JSON 文件读写，
 * 避免主线程（游戏逻辑线程）被大文件 I/O 阻塞。
 *
 * 协议：
 *   主 → 子：{ id, type: 'read'|'write'|'exists'|'mkdir', path, data? }
 *   子 → 主：{ id, type: 'result'|'error', value?, error? }
 */

const { parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

function reply(id, value) {
    parentPort.postMessage({ id, type: 'result', value });
}
function replyError(id, err) {
    parentPort.postMessage({ id, type: 'error', error: err.message });
}

parentPort.on('message', (msg) => {
    const { id, type, filePath, data } = msg;

    try {
        switch (type) {
            case 'read': {
                if (!fs.existsSync(filePath)) {
                    reply(id, null);
                } else {
                    const content = fs.readFileSync(filePath, 'utf8');
                    reply(id, JSON.parse(content));
                }
                break;
            }
            case 'write': {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                fs.writeFileSync(filePath, content, 'utf8');
                reply(id, true);
                break;
            }
            case 'exists': {
                reply(id, fs.existsSync(filePath));
                break;
            }
            case 'mkdir': {
                fs.mkdirSync(filePath, { recursive: true });
                reply(id, true);
                break;
            }
            case 'readRaw': {
                if (!fs.existsSync(filePath)) {
                    reply(id, null);
                } else {
                    reply(id, fs.readFileSync(filePath, 'utf8'));
                }
                break;
            }
            case 'writeRaw': {
                const dir2 = path.dirname(filePath);
                if (!fs.existsSync(dir2)) fs.mkdirSync(dir2, { recursive: true });
                fs.writeFileSync(filePath, data, 'utf8');
                reply(id, true);
                break;
            }
            default:
                replyError(id, new Error(`未知操作类型: ${type}`));
        }
    } catch (err) {
        replyError(id, err);
    }
});
