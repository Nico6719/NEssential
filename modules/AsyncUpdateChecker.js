'use strict';
/**
 * AsyncUpdateChecker.js  (Node.js 版)
 * 主线程侧封装：通过 WorkerPool 将网络/文件操作委托给 UpdateWorker 子线程。
 * LLSE API（mc / logger）仍在主线程调用。
 */
const path       = require('path');
const WorkerPool = require('./WorkerPool');

const KNOWN_FILES = [
    { url: 'NEssential.js',                  path: 'NEssential.js' },
    { url: 'modules/I18n.js',                path: './modules/I18n.js' },
    { url: 'modules/Cleanmgr.js',            path: './modules/Cleanmgr.js' },
    { url: 'modules/ConfigManager.js',       path: './modules/ConfigManager.js' },
    { url: 'modules/AsyncUpdateChecker.js',  path: './modules/AsyncUpdateChecker.js' },
    { url: 'modules/RadomTeleportSystem.js', path: './modules/RadomTeleportSystem.js' },
    { url: 'modules/Bstats.js',              path: './modules/Bstats.js' },
    { url: 'modules/Cd.js',                  path: './modules/Cd.js' },
    { url: 'modules/PVP.js',                 path: './modules/PVP.js' },
    { url: 'modules/Fcam.js',                path: './modules/Fcam.js' },
    { url: 'modules/Redpacket.js',           path: './modules/Redpacket.js' },
    { url: 'modules/Notice.js',              path: './modules/Notice.js' },
];

class AsyncUpdateChecker {
    static get KNOWN_FILES() { return KNOWN_FILES; }

    static _getConfig() {
        try {
            const uc = globalThis.conf?.get('Update');
            if (uc && typeof uc === 'object') {
                return {
                    versionUrl:  uc.versionUrl  || 'https://dl.mcmcc.cc/file/Version.json',
                    baseUrl:     uc.baseUrl      || 'https://dl.mcmcc.cc/file/',
                    files:       Array.isArray(uc.files) ? uc.files : [],
                    reloadDelay: uc.reloadDelay  || 1000,
                    timeout:     uc.timeout      || 30000,
                    checkMissingFilesOnStart: uc.checkMissingFilesOnStart !== undefined
                        ? uc.checkMissingFilesOnStart : true,
                };
            }
        } catch {}
        return {
            versionUrl:  'https://dl.mcmcc.cc/file/Version.json',
            baseUrl:     'https://dl.mcmcc.cc/file/',
            files:       KNOWN_FILES,
            reloadDelay: 1000,
            timeout:     30000,
            checkMissingFilesOnStart: true,
        };
    }

    static _getPool() {
        if (!this._pool) {
            const cfg = this._getConfig();
            const workerPath = path.resolve(__dirname, '../workers/UpdateWorker.js');
            this._pool = new WorkerPool(workerPath, {
                pluginPath:  path.resolve(__dirname, '..') + '/',
                versionUrl:  cfg.versionUrl,
                baseUrl:     cfg.baseUrl,
                timeout:     cfg.timeout,
                reloadDelay: cfg.reloadDelay,
            });

            // 监听 Worker 发来的子消息（need_update / need_repair 等）
            this._pool.on('need_update', (msg) => {
                globalThis.randomGradientLog?.(`发现新版本，开始下载...`);
                this._pool.send({
                    type:  'download',
                    files: msg.files && msg.files.length ? msg.files : this._getConfig().files,
                }).then(r => this._handleDone(r)).catch(e => logger?.error?.(`下载失败: ${e.message}`));
            });

            this._pool.on('need_repair', (msg) => {
                this._pool.send({
                    type:  'repair',
                    files: msg.files,
                }).then(r => this._handleDone(r)).catch(e => logger?.error?.(`修复失败: ${e.message}`));
            });

            this._pool.on('progress', (msg) => {
                globalThis.randomGradientLog?.(`[${msg.current}/${msg.total}] ${msg.file}`);
            });
        }
        return this._pool;
    }

    static _handleDone(result) {
        if (result.status === 'success' && result.reloadDelay > 0) {
            globalThis.randomGradientLog?.('更新完成，即将重载插件...');
            setTimeout(() => {
                try { mc?.runcmdEx('ll reload NEssential'); }
                catch (e) { logger?.warn?.('请手动执行: ll reload NEssential'); }
            }, result.reloadDelay);
        }
    }

    /** 初始化：检查缺失文件 */
    static async init() {
        const cfg = this._getConfig();
        if (!cfg.checkMissingFilesOnStart) return;
        try {
            await this._getPool().send({
                type:  'integrity',
                files: cfg.files.length ? cfg.files : KNOWN_FILES,
            });
        } catch (err) {
            logger?.error?.(`[UpdateChecker] 初始化失败: ${err.message}`);
        }
    }

    /** 检查更新 */
    static async checkForUpdates(currentVersion) {
        const cfg = this._getConfig();
        try {
            await this._getPool().send({
                type:           'check',
                currentVersion: String(currentVersion),
                files:          cfg.files.length ? cfg.files : KNOWN_FILES,
            });
        } catch (err) {
            logger?.error?.(`[UpdateChecker] 检查更新失败: ${err.message}`);
        }
    }
}

module.exports = AsyncUpdateChecker;

if (typeof globalThis !== 'undefined') globalThis.AsyncUpdateChecker = AsyncUpdateChecker;
