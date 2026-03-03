'use strict';
/**
 * CpuWorker.js
 * 纯 CPU 压力 Worker，无 LLSE 依赖。
 * 支持两种任务：
 *   - 'stress'  : 执行 CPU 密集型计算（质数筛 + 矩阵乘法），返回耗时
 *   - 'fib'     : 计算斐波那契数列（可调节规模）
 *   - 'hash'    : 模拟哈希计算循环
 */
const { parentPort } = require('worker_threads');

let _reqId;
const reply = (type, payload = {}) =>
    parentPort.postMessage({ type, id: _reqId, ...payload });

// ── 质数筛（埃拉托斯特尼）──────────────────────────────────
function sieve(limit) {
    const arr = new Uint8Array(limit + 1).fill(1);
    arr[0] = arr[1] = 0;
    for (let i = 2; i * i <= limit; i++)
        if (arr[i]) for (let j = i * i; j <= limit; j += i) arr[j] = 0;
    let count = 0;
    for (let i = 2; i <= limit; i++) if (arr[i]) count++;
    return count;
}

// ── 简单矩阵乘法 N×N ────────────────────────────────────
function matMul(n) {
    const a = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i * n + j) % 97));
    const b = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i + j) % 53));
    const c = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++)
        for (let k = 0; k < n; k++)
            for (let j = 0; j < n; j++)
                c[i][j] += a[i][k] * b[k][j];
    return c[0][0];
}

// ── 斐波那契（迭代）─────────────────────────────────────
function fib(n) {
    let a = 0n, b = 1n;
    for (let i = 0; i < n; i++) [a, b] = [b, a + b];
    return b.toString().length; // 返回位数避免超大数传输
}

// ── 伪哈希循环 ───────────────────────────────────────────
function hashLoop(rounds) {
    let h = 0x811c9dc5;
    for (let i = 0; i < rounds; i++) {
        h ^= (i & 0xff);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

parentPort.on('message', (msg) => {
    _reqId = msg.id;
    const { type, params = {} } = msg;
    const t0 = Date.now();

    try {
        let result;
        switch (type) {
            case 'stress': {
                const limit   = params.sieveLimit   || 2_000_000;
                const matSize = params.matrixSize    || 256;
                const primes  = sieve(limit);
                const mat     = matMul(matSize);
                result = { primes, matSample: mat };
                break;
            }
            case 'fib': {
                const n = params.n || 100_000;
                result = { digits: fib(n) };
                break;
            }
            case 'hash': {
                const rounds = params.rounds || 50_000_000;
                result = { hash: hashLoop(rounds) };
                break;
            }
            default:
                return reply('error', { error: `未知任务类型: ${type}` });
        }
        reply('done', { result, elapsed: Date.now() - t0 });
    } catch (e) {
        reply('error', { error: e.message, elapsed: Date.now() - t0 });
    }
});
