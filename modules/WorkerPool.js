'use strict';
/**
 * WorkerPool.js — 真正的多线程 Worker 池
 *  - 固定 N 个 Worker 线程常驻（默认 CPU 核心数）
 *  - 空闲分配，忙时 FIFO 排队
 *  - Promise 化收发，超时保护
 *  - 自动转发 log/warn/error 给 LLSE logger
 */
const { Worker }   = require('worker_threads');
const os           = require('os');
const path         = require('path');
const EventEmitter = require('events');

class WorkerPool extends EventEmitter {
    /**
     * @param {string} workerFile  Worker 脚本绝对路径
     * @param {object} workerData  传给每个 Worker 的 workerData
     * @param {number} size        线程数（默认 CPU 核心数）
     */
    constructor(workerFile, workerData = {}, size) {
        super();
        this._file    = workerFile;
        this._data    = workerData;
        this._size    = size || Math.max(2, os.cpus().length);
        this._slots   = [];   // { worker, busy }[]
        this._queue   = [];   // 等待中的任务
        this._msgId   = 0;
        this._pending = new Map(); // id → { resolve, reject, timer }
        this._ready   = false;
    }

    // ── 懒初始化所有 Worker ──────────────────────────────
    _ensureReady() {
        if (this._ready) return;
        this._ready = true;
        for (let i = 0; i < this._size; i++) this._spawnSlot(i);
    }

    _spawnSlot(idx) {
        const w    = new Worker(this._file, { workerData: this._data });
        const slot = { worker: w, busy: false };
        this._slots[idx] = slot;

        w.on('message', (msg) => {
            if (typeof logger !== 'undefined') {
                if (msg.type === 'log')   logger.info(msg.msg);
                if (msg.type === 'warn')  logger.warn(msg.msg);
                if (msg.type === 'error') logger.error(msg.msg);
            }
            this.emit(msg.type, msg);

            if (msg.id !== undefined && this._pending.has(msg.id)) {
                const { resolve, reject, timer } = this._pending.get(msg.id);
                this._pending.delete(msg.id);
                clearTimeout(timer);
                slot.busy = false;
                if (msg.type === 'error') reject(new Error(msg.error || msg.message || 'Worker 错误'));
                else resolve(msg);
                this._drain();
            }
        });

        w.on('error', (err) => {
            if (typeof logger !== 'undefined')
                logger.error(`[WorkerPool] ${path.basename(this._file)}[${idx}]: ${err.message}`);
            slot.busy = false;
            setTimeout(() => this._spawnSlot(idx), 500);
        });

        w.on('exit', (code) => {
            if (code !== 0 && typeof logger !== 'undefined')
                logger.warn(`[WorkerPool] ${path.basename(this._file)}[${idx}] 退出 (code=${code})`);
            slot.busy = false;
            setTimeout(() => this._spawnSlot(idx), 500);
        });
    }

    // ── 将队列中的任务分配给空闲 Worker ─────────────────
    _drain() {
        while (this._queue.length > 0) {
            const idx = this._slots.findIndex(s => !s.busy);
            if (idx === -1) break;
            const item = this._queue.shift();
            clearTimeout(item.qTimer);
            this._dispatch(idx, item.msg, item.resolve, item.reject, item.ms);
        }
    }

    _dispatch(idx, msg, resolve, reject, ms) {
        const slot = this._slots[idx];
        slot.busy  = true;

        const timer = ms > 0 ? setTimeout(() => {
            this._pending.delete(msg.id);
            slot.busy = false;
            this._drain();
            reject(new Error(`Worker 响应超时 (${ms}ms)`));
        }, ms) : undefined;

        this._pending.set(msg.id, { resolve, reject, timer });
        slot.worker.postMessage(msg);
    }

    // ── 公共 API ─────────────────────────────────────────
    send(msg, ms = 60000) {
        this._ensureReady();
        const id     = ++this._msgId;
        const tagged = { ...msg, id };

        return new Promise((resolve, reject) => {
            const idx = this._slots.findIndex(s => !s.busy);
            if (idx !== -1) {
                this._dispatch(idx, tagged, resolve, reject, ms);
            } else {
                const qTimer = ms > 0 ? setTimeout(() => {
                    const qi = this._queue.findIndex(q => q.msg.id === id);
                    if (qi !== -1) this._queue.splice(qi, 1);
                    reject(new Error(`Worker 排队超时 (${ms}ms)`));
                }, ms) : null;
                this._queue.push({ msg: tagged, resolve, reject, ms, qTimer });
            }
        });
    }

    post(msg) {
        this._ensureReady();
        const idx = this._slots.findIndex(s => !s.busy);
        const target = this._slots[idx !== -1 ? idx : 0];
        target?.worker.postMessage(msg);
    }

    terminate() {
        this._slots.forEach(s => s.worker?.terminate());
        this._slots = [];
        this._ready = false;
    }

    // 兼容旧代码
    get _worker() { return this._slots[0]?.worker ?? null; }
    set _worker(_) {}
}

module.exports = WorkerPool;
