'use strict';
/**
 * Debug.js — NEssential 调试 & 压力测试模块
 *
 * 命令列表（仅 OP 可用）：
 *   /nestdebug info          — 系统 & 插件运行状态
 *   /nestdebug workers       — Worker 线程池状态
 *   /nestdebug config        — 当前配置快照
 *   /nestdebug player [名]   — 指定玩家详细信息
 *   /nestdebug lang <key>    — 查询语言 key 值
 *   /nestdebug gc            — 触发 GC 并报告内存变化
 *
 *   /nestbench [模式] [并发] — 压满工作线程基准测试
 *       模式: stress(默认) | fib | hash
 *       并发: 1-64（默认 = CPU核心数 × 2）
 */

const os         = require('os');
const path       = require('path');
const WorkerPool = require('./WorkerPool');

// ── Worker 池（按需懒加载，共享给 bench 命令）─────────────
let _cpuPool = null;
function getCpuPool() {
    if (!_cpuPool) {
        _cpuPool = new WorkerPool(
            path.resolve(__dirname, '../workers/CpuWorker.js')
        );
    }
    return _cpuPool;
}

// ── 格式化内存 ────────────────────────────────────────────
function fmtMem(bytes) {
    if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
    if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
}

// ── 格式化毫秒 ────────────────────────────────────────────
function fmtMs(ms) {
    if (ms >= 60000) return (ms / 60000).toFixed(2) + ' min';
    if (ms >= 1000)  return (ms / 1000).toFixed(2) + ' s';
    return ms + ' ms';
}

// ── 构建系统信息文本 ──────────────────────────────────────
function buildInfoText() {
    const mem   = process.memoryUsage();
    const cpus  = os.cpus();
    const upMs  = process.uptime() * 1000;
    const lines = [
        '§e§l====  NEssential Debug Info  ====',
        `§7插件版本  §f${globalThis.version || 'N/A'}`,
        `§7运行时间  §f${fmtMs(upMs)}`,
        '',
        '§b§l── 内存 ──',
        `§7 RSS      §f${fmtMem(mem.rss)}`,
        `§7 堆已用   §f${fmtMem(mem.heapUsed)}`,
        `§7 堆总量   §f${fmtMem(mem.heapTotal)}`,
        `§7 外部     §f${fmtMem(mem.external)}`,
        '',
        '§b§l── CPU ──',
        `§7 型号     §f${cpus[0]?.model || 'Unknown'}`,
        `§7 核心数   §f${cpus.length}`,
        `§7 平台     §f${os.platform()} ${os.arch()}`,
        `§7 OS版本   §f${os.release()}`,
        '',
        '§b§l── 在线玩家 ──',
        `§7 当前人数  §f${mc.getOnlinePlayers().length}`,
        `§7 玩家列表  §f${mc.getOnlinePlayers().map(p => p.realName).join(', ') || '(无)'}`,
    ];
    return lines.join('\n');
}

// ── 构建 Worker 状态文本 ──────────────────────────────────
function buildWorkerText() {
    const pools = [
        { name: 'UpdateWorker',  obj: globalThis.__updatePool  },
        { name: 'BStatsWorker',  obj: globalThis.__bstatsPool  },
        { name: 'FileIOWorker',  obj: globalThis.__filePool    },
        { name: 'CpuWorker',     obj: _cpuPool                 },
    ];
    const lines = ['§e§l====  Worker 线程状态  ===='];
    for (const { name, obj } of pools) {
        const alive   = obj?._worker != null;
        const pending = obj?._pending?.size ?? 0;
        lines.push(
            `§7 ${name.padEnd(16)} ` +
            (alive ? '§a■ 运行中' : '§8■ 未启动') +
            ` §7| 挂起请求: §f${pending}`
        );
    }
    lines.push('');
    lines.push(`§7 Node.js 版本  §f${process.version}`);
    lines.push(`§7 活动句柄     §f${process._getActiveHandles?.().length ?? 'N/A'}`);
    return lines.join('\n');
}

// ── 构建配置快照 ──────────────────────────────────────────
function buildConfigText() {
    const conf = globalThis.conf;
    if (!conf) return '§c配置对象不可用';
    const keys = ['Economy', 'PVP', 'Fcam', 'Notice', 'RTP', 'Hub', 'tpa', 'Home', 'RedPacket', 'Update', 'Motd', 'wh'];
    const lines = ['§e§l====  配置快照  ===='];
    for (const k of keys) {
        const v = conf.get(k);
        if (v === undefined) { lines.push(`§8 ${k}: (未设置)`); continue; }
        const preview = JSON.stringify(v).slice(0, 80);
        lines.push(`§7 §l${k}§r §f${preview}${preview.length >= 80 ? '...' : ''}`);
    }
    return lines.join('\n');
}

// ── 构建玩家信息 ──────────────────────────────────────────
function buildPlayerText(pl, target) {
    if (!target) return `§c找不到玩家`;
    const pos  = target.pos;
    const conf = globalThis.conf;
    const eco  = globalThis.economyCfg;
    const money = eco?.isLLMoney ? target.getMoney() : target.getScore(eco?.scoreboard || 'money');
    return [
        `§e§l====  玩家: ${target.realName}  ====`,
        `§7 xuid      §f${target.xuid}`,
        `§7 gameMode  §f${target.gameMode}`,
        `§7 isOP      §f${target.isOP()}`,
        `§7 device    §f${target.device}`,
        `§7 ip        §f${target.ip}`,
        `§7 pos       §f${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} (dim ${pos.dimid})`,
        `§7 ${eco?.coinName || '金币'}    §f${money}`,
        `§7 pvp       §f${globalThis.pvpConfig?.get(target.realName, false)}`,
        `§7 home数     §f${Object.keys(globalThis.homedata?.get(target.realName) || {}).length}`,
    ].join('\n');
}

// ── /nestdebug 命令 ───────────────────────────────────────
function registerDebugCmd() {
    const cmd = mc.newCommand('nestdebug', '§aNEssential 调试工具 (OP)', PermType.GameMasters);
    cmd.mandatory('sub', ParamType.SoftEnum, 'DebugSub',
        ['info', 'workers', 'config', 'player', 'lang', 'gc'], 1);
    cmd.optional('arg', ParamType.RawText);
    cmd.overload(['sub', 'arg']);
    cmd.overload(['sub']);

    cmd.setCallback((_, ori, out, res) => {
        const pl  = ori.player;
        const sub = (res.sub || 'info').toLowerCase();
        const arg = res.arg?.trim() || '';

        const reply = (text) => {
            if (pl) pl.tell(text);
            else    out.success(text.replace(/§./g, ''));
        };

        switch (sub) {
            case 'info':
                reply(buildInfoText());
                break;

            case 'workers':
                reply(buildWorkerText());
                break;

            case 'config':
                reply(buildConfigText());
                break;

            case 'player': {
                const name   = arg || pl?.realName;
                const target = name ? mc.getPlayer(name) : null;
                reply(buildPlayerText(pl, target));
                break;
            }

            case 'lang': {
                if (!arg) { reply('§c用法: /nestdebug lang <key>'); break; }
                const val = globalThis.lang?.get(arg);
                reply(val !== undefined && val !== arg
                    ? `§7[${arg}]§r = §f"${val}"`
                    : `§c键 "${arg}" 不存在或未翻译`);
                break;
            }

            case 'gc': {
                const before = process.memoryUsage().heapUsed;
                if (typeof gc === 'function') {
                    gc();
                    const after = process.memoryUsage().heapUsed;
                    reply(`§aGC 完成\n§7 释放: §f${fmtMem(Math.max(0, before - after))}\n§7 当前堆: §f${fmtMem(after)}`);
                } else {
                    reply('§c需要以 --expose-gc 启动 Node.js 才能手动触发 GC');
                }
                break;
            }

            default:
                reply(`§c未知子命令: ${sub}\n§7可用: info, workers, config, player, lang, gc`);
        }
    });

    cmd.setup();
}

// ── /nestbench 压力测试命令 ───────────────────────────────
function registerBenchCmd() {
    const cmd = mc.newCommand('nestbench', '§c压满工作线程基准测试 (OP)', PermType.GameMasters);
    cmd.optional('mode',        ParamType.SoftEnum, 'BenchMode', ['stress', 'fib', 'hash'], 1);
    cmd.optional('concurrency', ParamType.Int);
    cmd.overload(['mode', 'concurrency']);
    cmd.overload(['mode']);
    cmd.overload([]);

    cmd.setCallback(async (_, ori, out, res) => {
        const pl          = ori.player;
        const mode        = res.mode        || 'stress';
        const concurrency = Math.min(Math.max(res.concurrency || os.cpus().length * 2, 1), 64);

        const notify = (msg) => {
            if (pl) pl.tell(msg);
            else    logger.info(msg.replace(/§./g, ''));
        };

        notify(`§e[Bench] 启动压力测试: 模式=§f${mode} §e并发=§f${concurrency}`);
        notify(`§7 将向 CpuWorker 线程池同时投递 ${concurrency} 个计算任务...`);

        const pool   = getCpuPool();
        const params = buildBenchParams(mode);
        const t0     = Date.now();

        // 构造所有任务 Promise
        const tasks = Array.from({ length: concurrency }, (_, i) =>
            pool.send({ type: mode, params }, 300_000)
                .then(r => ({ index: i, ok: true,  elapsed: r.elapsed, result: r.result }))
                .catch(e => ({ index: i, ok: false, error: e.message }))
        );

        notify(`§7 所有任务已投递，等待完成...`);

        const results  = await Promise.all(tasks);
        const wallTime = Date.now() - t0;

        const ok      = results.filter(r => r.ok);
        const failed  = results.filter(r => !r.ok);
        const elapsed = ok.map(r => r.elapsed);
        const minMs   = elapsed.length ? Math.min(...elapsed) : 0;
        const maxMs   = elapsed.length ? Math.max(...elapsed) : 0;
        const avgMs   = elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0;

        const report = [
            `§a§l[Bench] 测试完成`,
            `§7 模式        §f${mode}`,
            `§7 并发数      §f${concurrency}`,
            `§7 成功任务    §a${ok.length} §7/ §f${concurrency}`,
            failed.length ? `§7 失败任务    §c${failed.length}` : null,
            `§7 总耗时      §f${fmtMs(wallTime)}`,
            `§7 单任务 min  §f${fmtMs(minMs)}`,
            `§7 单任务 avg  §f${fmtMs(avgMs)}`,
            `§7 单任务 max  §f${fmtMs(maxMs)}`,
            `§7 吞吐量      §f${(ok.length / (wallTime / 1000)).toFixed(2)} tasks/s`,
        ].filter(Boolean).join('\n');

        notify(report);

        if (failed.length) {
            failed.slice(0, 3).forEach(f =>
                notify(`§c 任务${f.index} 失败: ${f.error}`)
            );
        }
    });

    cmd.setup();
}

// ── 根据模式返回任务参数 ──────────────────────────────────
function buildBenchParams(mode) {
    switch (mode) {
        case 'stress': return { sieveLimit: 1_500_000, matrixSize: 200 };
        case 'fib':    return { n: 80_000 };
        case 'hash':   return { rounds: 30_000_000 };
        default:       return {};
    }
}

// ── 模块导出 ──────────────────────────────────────────────
module.exports = {
    init() {
        registerDebugCmd();
        registerBenchCmd();

        // 将 CpuWorker 池暴露给 /nestdebug workers 面板
        globalThis.__cpuPool = _cpuPool;

        if (typeof globalThis.randomGradientLog === 'function')
            globalThis.randomGradientLog('[Debug] 调试模块已加载 (/nestdebug & /nestbench)');
    },
};
