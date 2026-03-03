'use strict';
/**
 * Bstats.js  (Node.js 版)
 * 主线程：收集系统信息 → 发给 BStatsWorker 子线程上报。
 */
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const WorkerPool = require('./WorkerPool');

function randomGradientLog(text) {
    if (typeof globalThis.randomGradientLog === 'function') {
        globalThis.randomGradientLog(text);
    } else if (typeof logger !== 'undefined') {
        logger.log(text);
    }
}

class BStatsImpl {
    constructor(pluginId) {
        this.pluginId      = pluginId;
        this.enabled       = true;
        this.debugMode     = true;
        this.pluginName    = 'NEssential';
        this.pluginVersion = this._readManifestVersion();
        this.platform      = 'bukkit';

        this._pool = null;
        this._syncConfig();
    }

    _readManifestVersion() {
        try {
            const p = path.resolve(__dirname, '../manifest.json');
            if (fs.existsSync(p)) {
                const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                const v = j.version || j.version_name;
                if (v) return Array.isArray(v) ? v.join('.') : String(v);
            }
        } catch {}
        return '2.10.3';
    }

    _syncConfig() {
        try {
            const cfg = globalThis.conf?.get('BStats');
            if (cfg && cfg.enabled === false) this.enabled = false;
        } catch {}
    }

    _getPool() {
        if (!this._pool) {
            const workerPath = path.resolve(__dirname, '../workers/BStatsWorker.js');
            this._pool = new WorkerPool(workerPath);
        }
        return this._pool;
    }

    _probeSystemInfo() {
        return {
            coreCount:  String(os.cpus().length),
            osName:     os.type(),
            osArch:     os.arch(),
            osVersion:  os.release(),
        };
    }

    _readOnlineMode() {
        try {
            const p = './server.properties';
            if (fs.existsSync(p)) {
                const m = fs.readFileSync(p, 'utf8').match(/^online-mode\s*=\s*(true|false)/m);
                if (m) return m[1] === 'true' ? 1 : 0;
            }
        } catch {}
        return 1;
    }

    async submitData() {
        if (!this.enabled) return;

        const sys        = this._probeSystemInfo();
        const onlineMode = this._readOnlineMode();

        const payload = {
            serverUUID:     'nessential-nodejs',
            minecraftVersion: '1.20',
            softwareName:    'LeviLamina',
            softwareVersion: '1.0',
            pluginVersion:   this.pluginVersion,
            onlineMode,
            ...sys,
        };

        if (this.debugMode) randomGradientLog(`[BStats] 上报遥测 v${this.pluginVersion}`);

        try {
            await this._getPool().send({ type: 'submit', pluginId: this.pluginId, payload });
        } catch (err) {
            if (this.debugMode && typeof logger !== 'undefined')
                logger.warn(`[BStats] 上报失败: ${err.message}`);
        }
    }

    startReporting(intervalMinutes = 30) {
        this.submitData();
        setInterval(() => this.submitData(), intervalMinutes * 60 * 1000);
    }
}

module.exports = { init() { new BStatsImpl(21867).startReporting(); } };
