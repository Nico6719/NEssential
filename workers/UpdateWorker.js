'use strict';
/**
 * UpdateWorker.js
 * 运行在 worker_threads 子线程中，负责：
 *  - 检查远程版本（HTTPS GET）
 *  - 下载更新文件（并发 HTTPS GET）
 *  - 文件备份 / 写入（fs）
 * 不使用任何 LLSE 全局 API（mc / logger / File 等），
 * 仅依赖 Node.js 内置模块。
 *
 * 与主线程通信协议（parentPort.postMessage）：
 *   主线程 → Worker：{ type, ...payload }
 *   Worker → 主线程：{ type, ...result }
 *
 * type 列表：
 *   主 → 子：'check' | 'download' | 'repair' | 'integrity'
 *   子 → 主：'log' | 'warn' | 'error' | 'done' | 'progress'
 */

const { parentPort, workerData } = require('worker_threads');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ── 配置（由 workerData 传入）──────────────────────────────
const {
    pluginPath  = './plugins/NEssential/',
    versionUrl  = 'https://dl.mcmcc.cc/file/Version.json',
    baseUrl     = 'https://dl.mcmcc.cc/file/',
    timeout     = 30000,
    reloadDelay = 1000,
} = workerData || {};

// ── 工具：向主线程发消息 ────────────────────────────────────
// _reqId 在每次收到消息时设置，确保所有响应都带上请求 id
let _reqId = undefined;
const send = (type, payload = {}) => parentPort.postMessage({ type, id: _reqId, ...payload });

const log   = (msg)   => send('log',   { msg });
const warn  = (msg)   => send('warn',  { msg });
const error = (msg)   => send('error', { msg });
const progress = (current, total, file) =>
    send('progress', { current, total, file });

// ── 版本比较 ────────────────────────────────────────────────
function compareVersions(v1, v2) {
    const p1 = String(v1).split('.').map(Number);
    const p2 = String(v2).split('.').map(Number);
    const len = Math.max(p1.length, p2.length);
    for (let i = 0; i < len; i++) {
        const a = p1[i] || 0, b = p2[i] || 0;
        if (a > b) return  1;
        if (a < b) return -1;
    }
    return 0;
}

// ── HTTP(S) GET（返回 Promise<string>）──────────────────────
function httpGet(url, ms = timeout) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const timer = setTimeout(() => reject(new Error(`请求超时: ${url}`)), ms);

        mod.get(url, (res) => {
            // 处理重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                clearTimeout(timer);
                return httpGet(res.headers.location, ms).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                clearTimeout(timer);
                return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                clearTimeout(timer);
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
            res.on('error', e => { clearTimeout(timer); reject(e); });
        }).on('error', e => { clearTimeout(timer); reject(e); });
    });
}

// ── 确保目录存在 ────────────────────────────────────────────
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── 获取远程版本信息 ────────────────────────────────────────
async function fetchRemoteVersion() {
    const raw = await httpGet(versionUrl);
    const data = JSON.parse(raw);
    if (!data.version) throw new Error('版本信息格式错误: 缺少 version 字段');
    return data;
}

// ── 下载文件列表（并发）────────────────────────────────────
async function downloadFiles(fileList) {
    const total = fileList.length;
    let completed = 0;

    const results = await Promise.all(fileList.map(async (f) => {
        try {
            log(`下载: ${f.url}`);
            const data = await httpGet(baseUrl + f.url);
            completed++;
            progress(completed, total, f.url);
            return { success: true, file: f, data: data.replace(/\r/g, '') };
        } catch (e) {
            error(`下载失败 ${f.url}: ${e.message}`);
            return { success: false, file: f, error: e.message };
        }
    }));
    return results;
}

// ── 写入文件到磁盘 ──────────────────────────────────────────
function writeFiles(results) {
    for (const r of results) {
        if (!r.success) continue;
        const fullPath = path.join(pluginPath, r.file.path);
        ensureDir(path.dirname(fullPath));
        fs.writeFileSync(fullPath, r.data, 'utf8');
        log(`写入成功: ${r.file.path}`);
    }
}

// ── 创建备份 ────────────────────────────────────────────────
function createBackup(files) {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(pluginPath, 'backups', `backup_${ts}`);
    ensureDir(dir);

    for (const f of files) {
        const src = path.join(pluginPath, f.path);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(dir, f.path);
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
        log(`备份: ${f.path}`);
    }
    return dir;
}

// ── 还原备份 ────────────────────────────────────────────────
function restoreBackup(backupDir, files) {
    for (const f of files) {
        const src = path.join(backupDir, f.path);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(pluginPath, f.path);
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
        log(`还原: ${f.path}`);
    }
}

// ── 检查缺失文件 ────────────────────────────────────────────
function checkMissing(files) {
    return files.filter(f => !fs.existsSync(path.join(pluginPath, f.path)));
}

// ══════════════════════════════════════════════════════════════
// 消息处理入口
// ══════════════════════════════════════════════════════════════
parentPort.on('message', async (msg) => {
    _reqId = msg.id;  // 捕获请求 id，所有回复都会带上
    const { type, currentVersion, files = [] } = msg;

    try {
        // ── 检查更新 ────────────────────────────────────────
        if (type === 'check') {
            log('开始检查更新...');
            const info = await fetchRemoteVersion();
            const cmp  = compareVersions(info.version, currentVersion);

            if (cmp > 0) {
                warn(`发现新版本! ${currentVersion} → ${info.version}`);
                if (info.changelog) warn(`更新内容: ${info.changelog}`);
                // 触发下载
                parentPort.postMessage({ type: 'need_update', id: _reqId, remoteVersion: info.version, files });
                send('done', { action: 'check', status: 'updating' });
            } else if (cmp < 0) {
                warn(`本地版本(${currentVersion})比远程版本(${info.version})更新`);
                send('done', { action: 'check', status: 'ahead' });
            } else {
                log(`已是最新版本 (${currentVersion})`);
                // 仍然检查文件完整性
                const missing = checkMissing(files);
                if (missing.length > 0) {
                    warn(`${missing.length} 个文件缺失，自动修复...`);
                    parentPort.postMessage({ type: 'need_repair', files: missing });
                } else {
                    send('done', { action: 'check', status: 'latest' });
                }
            }
        }

        // ── 下载全量更新 ────────────────────────────────────
        else if (type === 'download') {
            log('创建备份...');
            let backupDir = null;
            try { backupDir = createBackup(files); } catch (e) { warn(`备份失败: ${e.message}`); }

            const results = await downloadFiles(files);
            const failed  = results.filter(r => !r.success);

            if (failed.length > 0) {
                error(`${failed.length} 个文件下载失败`);
                if (backupDir) { warn('正在还原备份...'); restoreBackup(backupDir, files); }
                send('done', { action: 'download', status: 'failed' });
            } else {
                writeFiles(results);
                log(`成功更新 ${results.length} 个文件`);
                send('done', { action: 'download', status: 'success', reloadDelay });
            }
        }

        // ── 修复缺失文件 ────────────────────────────────────
        else if (type === 'repair') {
            log(`修复 ${files.length} 个缺失文件...`);
            const results = await downloadFiles(files);
            const failed  = results.filter(r => !r.success);

            if (failed.length > 0) {
                error(`${failed.length} 个文件修复失败`);
                send('done', { action: 'repair', status: 'partial' });
            } else {
                writeFiles(results);
                log(`成功修复 ${results.length} 个文件`);
                send('done', { action: 'repair', status: 'success', reloadDelay });
            }
        }

        // ── 完整性检查 ──────────────────────────────────────
        else if (type === 'integrity') {
            const missing = checkMissing(files);
            if (missing.length === 0) {
                log('所有核心文件完整!');
                send('done', { action: 'integrity', status: 'ok' });
            } else {
                warn(`${missing.length} 个文件缺失`);
                parentPort.postMessage({ type: 'need_repair', id: _reqId, files: missing });
                send('done', { action: 'integrity', status: 'repairing' });
            }
        }

    } catch (err) {
        error(`Worker 异常: ${err.message}`);
        send('done', { action: type, status: 'error', message: err.message });
    }
});
