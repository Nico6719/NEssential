'use strict';
/**
 * WorkerPool.js
 * 对 worker_threads Worker 进行简单封装：
 *  - 懒加载（首次使用时创建 Worker）
 *  - Promise 化消息收发（通过 id 关联请求/响应）
 *  - 自动将 'log'/'warn'/'error' 类消息转发给 LLSE logger
 */
const { Worker } = require('worker_threads');
const path       = require('path');

class WorkerPool {
    /**
     * @param {string} workerFile  Worker 脚本绝对路径
     * @param {object} workerData  传给 workerData 的初始数据
     */
    constructor(workerFile, workerData = {}) {
        this._file      = workerFile;
        this._data      = workerData;
        this._worker    = null;
        this._pending   = new Map();  // id → { resolve, reject }
        this._msgId     = 0;
        this._listeners = [];         // { type, callback }
    }

    // ── 懒加载 Worker ────────────────────────────────────
    _getWorker() {
        if (this._worker) return this._worker;

        this._worker = new Worker(this._file, { workerData: this._data });

        this._worker.on('message', (msg) => {
            // 转发日志给 LLSE logger（如果全局可用）
            if (msg.type === 'log'   && typeof logger !== 'undefined') logger.info(msg.msg);
            if (msg.type === 'warn'  && typeof logger !== 'undefined') logger.warn(msg.msg);
            if (msg.type === 'error' && typeof logger !== 'undefined') logger.error(msg.msg);

            // 通知自定义监听器
            for (const l of this._listeners) {
                if (l.type === msg.type || l.type === '*') l.callback(msg);
            }

            // 解决挂起的 Promise（通过 id 匹配）
            if (msg.id !== undefined && this._pending.has(msg.id)) {
                const { resolve, reject } = this._pending.get(msg.id);
                this._pending.delete(msg.id);
                if (msg.type === 'error') reject(new Error(msg.error || msg.message || '未知错误'));
                else                      resolve(msg);
            }
        });

        this._worker.on('error', (err) => {
            if (typeof logger !== 'undefined') logger.error(`[WorkerPool] ${this._file}: ${err.message}`);
            // 拒绝所有挂起请求
            for (const [, { reject }] of this._pending) reject(err);
            this._pending.clear();
            this._worker = null;  // 允许下次重建
        });

        this._worker.on('exit', (code) => {
            if (code !== 0 && typeof logger !== 'undefined')
                logger.warn(`[WorkerPool] ${path.basename(this._file)} 异常退出 (code=${code})`);
            this._worker = null;
        });

        return this._worker;
    }

    /**
     * 发送消息，返回 Promise（等待 Worker 返回 done/result/error）
     * @param {object} msg    发送的消息体
     * @param {number} ms     超时毫秒数（默认 60s）
     */
    send(msg, ms = 60000) {
        const id     = ++this._msgId;
        const worker = this._getWorker();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Worker 响应超时 (${ms}ms): ${JSON.stringify(msg)}`));
            }, ms);

            this._pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject:  (e) => { clearTimeout(timer); reject(e);  },
            });

            worker.postMessage({ ...msg, id });
        });
    }

    /**
     * 发送消息但不等待响应（fire & forget）
     */
    post(msg) {
        this._getWorker().postMessage(msg);
    }

    /**
     * 监听特定 type 的 Worker 消息
     */
    on(type, callback) {
        this._listeners.push({ type, callback });
        return this;
    }

    /**
     * 销毁 Worker
     */
    terminate() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }
}

module.exports = WorkerPool;
