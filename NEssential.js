'use strict';
/*--------------------------------
    NEssential  v2.10.3  (Node.js 重构版)
    原作者: Nico6719, PHEyeji
    Node.js 重构: 多线程 worker_threads 版本
    类型: lse-nodejs

    核心变更：
      1. 运行时从 lse-quickjs → lse-nodejs
      2. JsonConfigFile  → NodeJsonConfig (fs 实现)
      3. file/File API   → Node.js fs 模块
      4. network.httpGet → worker_threads + https (UpdateWorker / BStatsWorker)
      5. 重量级文件 I/O  → FileIOWorker 子线程（非阻塞）
      6. 模块加载改为标准 require()
----------------------------------*/

// ── Node.js 内置模块 ──────────────────────────────────────
const fs         = require('fs');
const path       = require('path');
const { Worker, isMainThread } = require('worker_threads');

// ── NodeJsonConfig 替代 LLSE JsonConfigFile ───────────────
const NodeJsonConfig = require('./modules/NodeJsonConfig');
// ── WorkerPool（统一 Worker 管理）────────────────────────
const WorkerPool     = require('./modules/WorkerPool');

// ══════════════════════════════════════════════════════════
// 常量 & 路径
// ══════════════════════════════════════════════════════════
const NEST_LangDir       = './plugins/NEssential/lang/';
const pluginpath         = './plugins/NEssential/';
const datapath           = './plugins/NEssential/data/';
const NAME               = 'NEssential';
const PluginInfo         = '基岩版多功能基础插件 ';
const version            = '2.10.3';
const regversion         = [2, 10, 3];
const info               = '§l§6[-NEST-] §r';
const offlineMoneyPath   = datapath + '/Money/offlineMoney.json';
const offlineNotifyPath  = datapath + '/Money/offlineNotify.json';
const langFilePath        = NEST_LangDir + 'zh_cn.json';

// ── Reload Guard ──────────────────────────────────────────
const __NEST_FIRST_LOAD__ = !globalThis.__NEST_listeners_registered__;

// ── 插件注册 ──────────────────────────────────────────────
ll.registerPlugin(NAME, PluginInfo, regversion, {
    Author:  'Nico6719',
    License: 'GPL-3.0',
    QQ:      '1584573887',
});

// ── MOTD 定时器 ───────────────────────────────────────────
let motdTimerId = null;

// ══════════════════════════════════════════════════════════
// 配置文件（NodeJsonConfig 替代 JsonConfigFile）
// ══════════════════════════════════════════════════════════
const lang        = new NodeJsonConfig(langFilePath, '{}');
const conf        = new NodeJsonConfig(pluginpath + '/Config/config.json', '{}');
const homedata    = new NodeJsonConfig(datapath + 'homedata.json', '{}');
const rtpdata     = new NodeJsonConfig(datapath + '/RTPData/Rtpdata.json', '{}');
const warpdata    = new NodeJsonConfig(datapath + 'warpdata.json', '{}');
const noticeconf  = new NodeJsonConfig(datapath + '/NoticeSettingsData/playersettingdata.json', '{}');
const pvpConfig   = new NodeJsonConfig(datapath + '/PVPSettingsData/pvp_data.json', '{}');
const MoneyHistory  = new NodeJsonConfig(datapath + '/Money/MoneyHistory.json', '{}');
const moneyranking  = new NodeJsonConfig(datapath + '/Money/Moneyranking.json', '{}');
const tpacfg        = new NodeJsonConfig(datapath + '/TpaSettingsData/tpaAutoRejectConfig.json', '{}');
const offlineMoney  = new NodeJsonConfig(offlineMoneyPath, '{}');

const defaultServerConfig = JSON.stringify({
    servers: [{ server_name: '生存服', server_ip: '127.0.0.1', server_port: 19132 }],
});
const servertp = new NodeJsonConfig(datapath + '/TrSeverData/server.json', defaultServerConfig);

// ── Economy 统一读取层 ────────────────────────────────────
const economyCfg = {
    get mode()      {
        const e = conf.get('Economy');
        if (e) return e.mode || 'scoreboard';
        return conf.get('LLMoney') == 1 ? 'llmoney' : 'scoreboard';
    },
    get isLLMoney() { return this.mode === 'llmoney'; },
    get scoreboard(){ const e = conf.get('Economy'); return (e ? e.Scoreboard : conf.get('Scoreboard')) || 'money'; },
    get coinName()  { const e = conf.get('Economy'); return (e ? e.CoinName : conf.get('CoinName')) || lang.get('CoinName') || '金币'; },
};

// ══════════════════════════════════════════════════════════
// FileIOWorker — 异步文件 I/O 线程池
// 用于排行榜等重量级 JSON 读写，不阻塞主线程
// ══════════════════════════════════════════════════════════
const fileWorker = new WorkerPool(
    path.resolve(__dirname, 'workers/FileIOWorker.js')
);

/** 异步读 JSON 文件（不阻塞主线程）*/
async function asyncReadJson(filePath, defaultVal = {}) {
    try {
        const result = await fileWorker.send({ type: 'read', filePath });
        return result.value !== undefined ? result.value : defaultVal;
    } catch {
        return defaultVal;
    }
}

/** 异步写 JSON 文件 */
async function asyncWriteJson(filePath, data) {
    try {
        await fileWorker.send({ type: 'write', filePath, data });
    } catch (err) {
        if (typeof logger !== 'undefined') logger.error(`异步写文件失败 ${filePath}: ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════════
// 颜色 / 渐变日志工具
// ══════════════════════════════════════════════════════════
function randomVividColor() {
    const rand = Math.random() * 260;
    let h;
    if      (rand < 90)  h = rand;
    else if (rand < 200) h = rand + 60;
    else                 h = rand + 100;
    const s = 0.90 + Math.random() * 0.10;
    const l = 0.65 + Math.random() * 0.15;
    const a = s * Math.min(l, 1 - l);
    function f(n) {
        const k = (n + h / 30) % 12;
        return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    }
    return [f(0), f(8), f(4)];
}
function generateColorPair() {
    const c1 = randomVividColor(); let c2, attempts = 0;
    do {
        c2 = randomVividColor();
        if (Math.abs(c1[0]-c2[0]) + Math.abs(c1[1]-c2[1]) + Math.abs(c1[2]-c2[2]) > 150 || attempts++ > 20) break;
    } while (true);
    return [c1, c2];
}
const [GLOBAL_C1, GLOBAL_C2] = generateColorPair();
function globalLerpColor(t) {
    return [
        Math.round(GLOBAL_C1[0] + (GLOBAL_C2[0] - GLOBAL_C1[0]) * t),
        Math.round(GLOBAL_C1[1] + (GLOBAL_C2[1] - GLOBAL_C1[1]) * t),
        Math.round(GLOBAL_C1[2] + (GLOBAL_C2[2] - GLOBAL_C1[2]) * t),
    ];
}
function randomGradientLog(text) {
    const len = text.length; let out = '';
    for (let i = 0; i < len; i++) {
        const t = len <= 1 ? 0 : i / (len - 1);
        const [r, g, b] = globalLerpColor(t);
        out += `\x1b[38;2;${r};${g};${b}m` + text[i];
    }
    logger.log(out + '\x1b[0m');
}

// ── AsyncFileManager（保持兼容，底层已用 fs）────────────
class AsyncFileManager {
    static async readFile(filePath, defaultContent = '{}') {
        return new Promise((resolve) => {
            try {
                if (!fs.existsSync(filePath)) {
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, defaultContent, 'utf8');
                    resolve(JSON.parse(defaultContent));
                } else {
                    resolve(JSON.parse(fs.readFileSync(filePath, 'utf8') || defaultContent));
                }
            } catch (e) {
                logger.error(`读取文件失败: ${filePath} ${e.message}`);
                resolve(JSON.parse(defaultContent));
            }
        });
    }
    static async writeFile(filePath, data) {
        return new Promise((resolve, reject) => {
            try {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                fs.writeFileSync(filePath, content, 'utf8');
                resolve(true);
            } catch (e) {
                logger.error(`写入文件失败: ${filePath} ${e.message}`);
                reject(e);
            }
        });
    }
}

// ══════════════════════════════════════════════════════════
// 全局依赖注入（供模块通过 globalThis 访问）
// ══════════════════════════════════════════════════════════
let stats = false;
Object.assign(globalThis, {
    // 配置 & 数据
    conf, lang, info, datapath, pluginpath,
    pvpConfig, noticeconf, homedata, warpdata, rtpdata,
    MoneyHistory, moneyranking, tpacfg, servertp,
    offlineMoney, offlineMoneyPath, offlineNotifyPath,
    MdataPath: datapath + '/Money/Moneyranking.json',
    // 常量
    NEST_LangDir, NAME, version, regversion, PluginInfo, langFilePath,
    economyCfg,
    // 工具
    globalLerpColor, randomGradientLog,
    AsyncFileManager,
    // 函数（在底部定义后会通过 globalThis.xxx = xxx 再次赋值）
});

// ══════════════════════════════════════════════════════════
// 经济系统
// ══════════════════════════════════════════════════════════
const OfflineMoneyCache = {
    load: () => {
        if (!fs.existsSync(offlineMoneyPath)) {
            fs.mkdirSync(path.dirname(offlineMoneyPath), { recursive: true });
            fs.writeFileSync(offlineMoneyPath, '{}', 'utf8');
        }
        try { return JSON.parse(fs.readFileSync(offlineMoneyPath, 'utf8')); } catch { return {}; }
    },
    save: (data) => {
        fs.writeFileSync(offlineMoneyPath, JSON.stringify(data, null, 2), 'utf8');
    },
    add: (playerName, type, amount) => {
        const cache = OfflineMoneyCache.load();
        if (!cache[playerName]) cache[playerName] = [];
        cache[playerName].push({ type, amount, timestamp: new Date().toISOString() });
        OfflineMoneyCache.save(cache);
    },
    get:   (name) => { const c = OfflineMoneyCache.load(); return c[name] || []; },
    clear: (name) => { const c = OfflineMoneyCache.load(); delete c[name]; OfflineMoneyCache.save(c); },
    apply: (player) => {
        const ops = OfflineMoneyCache.get(player.realName);
        if (!ops.length) return;
        let total = 0;
        ops.forEach(op => {
            Economy.execute(player, op.type, op.amount);
            if (op.type === 'add' || op.type === 'set') total += op.amount;
            else if (op.type === 'reduce') total -= op.amount;
        });
        OfflineMoneyCache.clear(player.realName);
        if (total !== 0)
            player.tell(total > 0
                ? `${info}§a离线期间金币变动 +${total} ${economyCfg.coinName}`
                : `${info}§c离线期间金币变动 ${total} ${economyCfg.coinName}`);
    },
};

const Economy = {
    isScoreboard: () => !economyCfg.isLLMoney,
    getObjName:   () => economyCfg.scoreboard,
    get: (p) => Economy.isScoreboard() ? p.getScore(Economy.getObjName()) : p.getMoney(),
    execute: (identifier, type, amount) => {
        if (typeof identifier === 'object' && identifier.getScore) {
            const p = identifier; const isScore = Economy.isScoreboard(); const obj = Economy.getObjName();
            switch (type) {
                case 'set':    return isScore ? p.setScore(obj, amount)    : p.setMoney(amount);
                case 'add':    return isScore ? p.addScore(obj, amount)    : p.addMoney(amount);
                case 'reduce': return isScore ? p.reduceScore(obj, amount) : p.reduceMoney(amount);
                default: return false;
            }
        }
        const name = typeof identifier === 'string' ? identifier : identifier.realName;
        const online = mc.getPlayer(name);
        if (online) return Economy.execute(online, type, amount);
        OfflineMoneyCache.add(name, type, amount);
        randomGradientLog(`[Economy] 玩家 ${name} 离线，操作已缓存: ${type} ${amount}`);
        return true;
    },
};

const EconomyNotify = {
    _load: () => {
        if (!fs.existsSync(offlineNotifyPath)) {
            fs.mkdirSync(path.dirname(offlineNotifyPath), { recursive: true });
            fs.writeFileSync(offlineNotifyPath, '{}', 'utf8');
        }
        try { return JSON.parse(fs.readFileSync(offlineNotifyPath, 'utf8')) || {}; } catch { return {}; }
    },
    _save: (data) => fs.writeFileSync(offlineNotifyPath, JSON.stringify(data, null, 2), 'utf8'),
    addOffline: (name, msg) => {
        const db = EconomyNotify._load();
        if (!db[name]) db[name] = [];
        db[name].push(msg);
        EconomyNotify._save(db);
    },
    send: (playerOrName, msg) => {
        if (typeof playerOrName === 'string') {
            const online = mc.getPlayer(playerOrName);
            if (online) online.sendText(msg);
            else        EconomyNotify.addOffline(playerOrName, msg);
        } else {
            playerOrName.sendText(msg);
        }
    },
    apply: (player) => {
        const db   = EconomyNotify._load();
        const msgs = db[player.realName];
        if (!msgs || !msgs.length) return;
        msgs.forEach(m => player.tell(m));
        delete db[player.realName];
        EconomyNotify._save(db);
    },
};

// 注入 Economy 到 globalThis（Redpacket 等模块需要）
Object.assign(globalThis, { Economy, EconomyNotify, OfflineMoneyCache });

// ══════════════════════════════════════════════════════════
// 排行榜缓存（内存 + Worker 异步落盘）
// ══════════════════════════════════════════════════════════
const moneyCache = new Map();
let   moneyDirty = false;

function updateSinglePlayerCache(pl) {
    if (!pl) return;
    const v = economyCfg.isLLMoney ? pl.getMoney() : pl.getScore(economyCfg.scoreboard);
    if (v !== null && v !== undefined && moneyCache.get(pl.realName) !== v) {
        moneyCache.set(pl.realName, v);
        moneyDirty = true;
    }
}

// 每 30s 更新在线玩家缓存
setInterval(() => mc.getOnlinePlayers().forEach(updateSinglePlayerCache), 30000);

// 每 60s 异步批量写入排行榜（仅在有变化时，走 FileIOWorker 不阻塞主线程）
setInterval(() => {
    if (!moneyDirty) return;
    moneyDirty = false;
    const snapshot = {};
    moneyCache.forEach((v, k) => { snapshot[k] = v; });
    // 异步写入，不阻塞游戏逻辑
    asyncWriteJson(datapath + '/Money/Moneyranking.json', snapshot);
}, 60000);

// ══════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════
function smartMoneyCheck(plname, value) {
    const pl = mc.getPlayer(plname);
    if (!pl) return false;
    let balance = economyCfg.isLLMoney ? pl.getMoney() : pl.getScore(economyCfg.scoreboard);
    if (balance === null || balance === undefined) {
        if (economyCfg.isLLMoney) pl.setMoney(0); else pl.setScore(economyCfg.scoreboard, 0);
        balance = 0;
    }
    if (balance < value) return false;
    return economyCfg.isLLMoney
        ? pl.reduceMoney(value)
        : pl.reduceScore(economyCfg.scoreboard, value);
}

function displayMoneyInfo(pl, target, isSelf = true) {
    if (!pl || !target) return '信息获取失败';
    const prefix = isSelf ? '你的' : `玩家 ${target.realName} 的`;
    const money  = economyCfg.isLLMoney ? target.getMoney() : target.getScore(economyCfg.scoreboard);
    pl.sendText(info + `${prefix}当前${economyCfg.coinName}为：${money}`);
    return `${prefix}${economyCfg.coinName}为: ${money}`;
}

function getDimensionName(id) {
    return { 0:'主世界', 1:'下界', 2:'末地' }[id] || `未知维度 (ID: ${id})`;
}

function showInsufficientMoneyGui(pl, cost, returnCmd) {
    const fm = mc.newSimpleForm();
    fm.setTitle(lang.get('gui.insufficient.money.title'));
    fm.setContent(lang.get('gui.insufficient.money.content')
        .replace('${cost}', cost).replace('${coin}', conf.get('Economy').CoinName));
    fm.addButton(lang.get('gui.button.confirm'));
    if (returnCmd) fm.addButton(lang.get('gui.button.back'));
    pl.sendForm(fm, (p, id) => { if (id === 1 && returnCmd) p.runcmd(returnCmd); });
}

function ranking(plname) {
    const pl = mc.getPlayer(plname);
    if (!pl) return;

    // 从磁盘读取基础数据（同步，因为需要立刻展示 GUI）
    let datas = {};
    try {
        const raw = fs.readFileSync(datapath + '/Money/Moneyranking.json', 'utf8');
        datas = JSON.parse(raw);
    } catch {}

    // 合并内存缓存
    moneyCache.forEach((v, k) => { datas[k] = v; });

    // 强制刷新自己的实时余额
    const myReal = economyCfg.isLLMoney ? pl.getMoney() : pl.getScore(economyCfg.scoreboard);
    if (myReal !== undefined && myReal !== null) {
        datas[pl.realName] = myReal;
        moneyCache.set(pl.realName, myReal);
        moneyDirty = true;
    }

    const lst = Object.keys(datas).map(n => ({ name: n, money: datas[n] }));
    if (!lst.length) { pl.tell(info + lang.get('no.ranking.data')); return; }
    lst.sort((a, b) => b.money - a.money);
    const top = lst.slice(0, 50);

    if (conf.get('Economy').RankingModel === 'New') {
        const total = top.reduce((s, c) => s + c.money, 0);
        const form  = mc.newSimpleForm()
            .setTitle(`§l§6■ 财富排行榜 ■ §r§8[前${top.length}名]`)
            .setContent(
                `§7服务器总财富: §6${fmt(total)}\n§7统计时间: §f${new Date().toLocaleTimeString()}\n` +
                `§6点击按钮返回菜单 | §a你的余额: ${fmt(myReal)}\n§8${'═'.repeat(21)}`
            );
        top.forEach((v, i) => {
            const r = i + 1; const pct = total > 0 ? (v.money / total * 100).toFixed(1) : '0.0';
            const name = v.name === pl.realName ? `§e§l[我] ${v.name}§r` : v.name;
            form.addButton(
                `${['§b☆','§c◆','§a▣'][Math.min(2,r-1)] || '§7'} §l${r}. §r${name}\n` +
                `§l§c├ 持有: ${fmt(v.money)} §r§l占比: §a${pct}%`
            );
        });
        pl.sendForm(form, (pl, id) => {
            if (id !== null) pl.tell(info + lang.get('money.callback.menu'));
            pl.runcmd('moneygui');
        });
    } else {
        const form = mc.newSimpleForm();
        form.setTitle(lang.get('ranking.list'));
        form.setContent(top.map(v => `${v.name}: ${v.money}`).join('\n'));
        pl.sendForm(form, (pl, id) => { if (id == null) pl.runcmd('moneygui'); });
    }

    function fmt(n) {
        if (n === undefined || n === null) return '0';
        if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
        return n.toLocaleString();
    }
}

function openPlayerSelectionGui(pl, title, onSelect) {
    const players = mc.getOnlinePlayers();
    const fm = mc.newSimpleForm().setTitle(title);
    players.forEach(p => fm.addButton(p.realName));
    pl.sendForm(fm, (p, id) => { if (id !== null) onSelect(p, players[id]); });
}

// 注入工具函数
Object.assign(globalThis, {
    smartMoneyCheck, displayMoneyInfo, showInsufficientMoneyGui,
    openPlayerSelectionGui, ranking, getDimensionName,
});

// ══════════════════════════════════════════════════════════
// 维护模块
// ══════════════════════════════════════════════════════════
const Maintenance = {
    get config() { return conf.get('wh') || { EnableModule: true, status: 0 }; },
    get isActive() { return this.config.status === 1; },
    setStatus(s) { const c = this.config; c.status = s ? 1 : 0; conf.set('wh', c); return s; },
};
globalThis.Maintenance = Maintenance;

// ══════════════════════════════════════════════════════════
// MOTD
// ══════════════════════════════════════════════════════════
function Motd() {
    if (conf.get('Motd')?.EnabledModule == 0) return;
    if (motdTimerId !== null) { clearInterval(motdTimerId); motdTimerId = null; }
    const motds = conf.get('Motd')?.message;
    if (!motds || !motds.length) { logger.warn(lang.get('Motd.config.isemp')); return; }
    let idx = 0;
    motdTimerId = setInterval(() => { mc.setMotd(motds[idx]); idx = (idx + 1) % motds.length; }, 5000);
}

// ══════════════════════════════════════════════════════════
// 渐变 Logo
// ══════════════════════════════════════════════════════════
function printGradientLogo() {
    const logo = [
        '    __   __ ______   _____   _____  ______  _   _  _______  _____          _      ',
        '    \\ \\ / /|  ____| / ____| / ____||  ____|| \\ | ||__   __||_   _|   /\\   | |     ',
        '     \\ V / | |__   | (___  | (___  | |__   |  \\| |   | |     | |    /  \\  | |     ',
        '      | |  |  __|   \\___ \\  \\___ \\ |  __|  | . ` |   | |     | |   / /\\ \\ | |     ',
        '      | |  | |____  ____) | ____) || |____ | |\\  |   | |    _| |_ / ____ \\| |____ ',
        '      |_|  |______||_____/ |_____/ |______||_| \\_|   |_|   |_____|/_/  \\_\\|______|',
        ' ',
    ];
    const reset = '\x1b[0m';
    const totalChars = logo.length * logo[0].length;
    logger.log('');
    logo.forEach((line, li) => {
        let out = '';
        for (let i = 0; i < line.length; i++) {
            const t = (li * line.length + i) / totalChars;
            const [r, g, b] = globalLerpColor(t);
            out += `\x1b[38;2;${r};${g};${b}m` + line[i];
        }
        logger.log(out + reset);
    });
    logger.log('');
    randomGradientLog(`${PluginInfo} 版本:${version}, 作者：Nico6719 | Node.js 重构版`);
    randomGradientLog('-'.repeat(50));
}

// ══════════════════════════════════════════════════════════
// 事件监听（仅注册一次）
// ══════════════════════════════════════════════════════════
if (__NEST_FIRST_LOAD__) {

    // 玩家加入
    mc.listen('onJoin', (pl) => {
        updateSinglePlayerCache(pl);
        try {
            homedata.init(pl.realName, {});
            rtpdata.init(pl.realName, {});
            MoneyHistory.init(pl.realName, {});
            // 初始化金币
            if (economyCfg.isLLMoney) {
                if (pl.getMoney() === null || pl.getMoney() === undefined) pl.setMoney(0);
            } else {
                if (!pl.getScore(economyCfg.scoreboard)) pl.setScore(economyCfg.scoreboard, 0);
            }
            if (!pl.isOP() && pvpConfig.get(pl.realName) === undefined)
                pvpConfig.set(pl.realName, false);

            // 投递离线消息
            EconomyNotify.apply(pl);
            OfflineMoneyCache.apply(pl);
        } catch (err) {
            logger.error(`玩家 ${pl.realName} 加入事件处理失败: ${err.message}`);
        }
    });

    // 玩家离开
    mc.listen('onLeft', (pl) => {
        if (moneyCache.has(pl.realName)) {
            // 异步保存离开玩家的排行数据
            const snapshot = {};
            moneyCache.forEach((v, k) => { snapshot[k] = v; });
            asyncWriteJson(datapath + '/Money/Moneyranking.json', snapshot);
            moneyCache.delete(pl.realName);
        }
    });

    // 控制台 stop 消息
    mc.listen('onConsoleCmd', (cmd) => {
        if (cmd.toLowerCase() !== 'stop' || !lang.get('stop.msg')) return;
        const msg = lang.get('stop.msg');
        mc.getOnlinePlayers().forEach(p => p.disconnect(msg));
        mc.runcmdEx('stop');
    });
}

// ══════════════════════════════════════════════════════════
// 命令注册（仅保留主文件中的命令，模块命令由各模块注册）
// ══════════════════════════════════════════════════════════

// /suicide
const suicidecmd = mc.newCommand('suicide', '自杀', PermType.Any);
suicidecmd.overload([]);
suicidecmd.setCallback((cmd, ori, out) => {
    const pl = ori.player;
    if (!smartMoneyCheck(pl.realName, conf.get('suicide') || 0))
        return pl.tell(info + lang.get('money.no.enough'));
    pl.tell(info + lang.get('suicide.kill.ok'));
    pl.kill();
});
suicidecmd.setup();

// /servers
const sercmd = mc.newCommand('servers', '§l§a跨服传送', PermType.Any);
sercmd.overload([]);
sercmd.setCallback((cmd, ori, out) => {
    const pl = ori.player;
    const cfg = conf.get('CrossServerTransfer');
    if (!cfg || !cfg.EnabledModule) { pl.tell(info + lang.get('module.no.Enabled')); return; }
    const serverList = cfg.servers || [];
    if (!serverList.length) { pl.tell(info + lang.get('no.server.can.tp')); return; }
    const fm = mc.newSimpleForm().setTitle(lang.get('server.from.title')).setContent(lang.get('choose.a.server'));
    serverList.forEach(s => fm.addButton(`§l§b${s.server_name}\n§7IP: ${s.server_ip}:${s.server_port}`));
    pl.sendForm(fm, (p, id) => {
        if (id === null) return;
        const t = serverList[id];
        try { p.transServer(t.server_ip, t.server_port); mc.broadcast(info + `§a${p.realName} 前往了 ${t.server_name}`); }
        catch (e) { p.tell(info + lang.get('server.tp.fail')); }
    });
});
sercmd.setup();

// /hub & /sethub
mc.regPlayerCmd('hub', '打开回城菜单', (pl) => {
    if (conf.get('Hub')?.EnabledModule == 0) { pl.tell(info + lang.get('module.no.Enabled')); return; }
    const Hub = conf.get('Hub');
    const fm  = mc.newSimpleForm().setTitle(lang.get('hub.tp.check')).setContent(
        `§e目标位置：\n§bX: §f${Hub.x}\n§bY: §f${Hub.y}\n§bZ: §f${Hub.z}\n§b维度: §f${getDimensionName(Hub.dimid)}`
    );
    fm.addButton(lang.get('hub.tp.now'), 'textures/ui/confirm');
    fm.addButton(lang.get('hub.tp.notnow'), 'textures/ui/cancel');
    pl.sendForm(fm, (p, id) => {
        if (id !== 0) return;
        try {
            p.teleport(parseFloat(Hub.x), parseFloat(Hub.y), parseFloat(Hub.z), parseInt(Hub.dimid));
            p.tell(lang.get('hub.tp.success'));
        } catch (e) { p.tell(lang.get('hub.tp.fail').replace('${msg}', e.message)); }
    });
});

mc.regPlayerCmd('sethub', '设置回城点', (pl) => {
    if (!pl.isOP()) { pl.tell(info + lang.get('player.not.op')); return; }
    const pos = pl.pos;
    conf.set('Hub', { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1), dimid: pos.dimid, isSet: true, EnabledModule: 1 });
    pl.tell(`§a回城点已设置为：\n§eX: §f${pos.x.toFixed(1)}\n§eY: §f${pos.y.toFixed(1)}\n§eZ: §f${pos.z.toFixed(1)}\n§e维度: §f${getDimensionName(pos.dimid)}`);
});

// /moneygui & /moneys（保持与原版一致，略去 GUI 细节复用原逻辑）
const moneygui = mc.newCommand('moneygui', '金币', PermType.Any);
moneygui.overload([]);
moneygui.setCallback((cmd, ori) => {
    const pl = ori.player;
    if (!pl) return;
    pl.isOP() ? OPMoneyGui(pl.realName) : MoneyGui(pl.realName);
});
moneygui.setup();

function MoneyGui(plname) {
    const pl = mc.getPlayer(plname);
    if (!pl) return;
    const fm  = mc.newSimpleForm().setTitle(economyCfg.coinName);
    const _c  = economyCfg.coinName;
    fm.addButton((lang.get('money.query') || '查询') + _c, 'textures/ui/MCoin');
    fm.addButton((lang.get('money.transfer') || '转账') + _c, 'textures/ui/trade_icon');
    fm.addButton(lang.get('money.offline.transfer.btn') || '转账给离线玩家', 'textures/ui/FriendsDiversity');
    fm.addButton((lang.get('money.view') || '查看') + _c + (lang.get('money.history') || '历史'), 'textures/ui/book_addtextpage_default');
    fm.addButton(_c + (lang.get('money.player.list') || '排行榜'), 'textures/ui/icon_book_writable');
    if (conf.get('RedPacket')?.EnabledModule == 1)
        fm.addButton(lang.get('rp.menu.1') || '红包', 'textures/ui/gift_square');

    pl.sendForm(fm, (p, id) => {
        if (id == null) return p.tell(info + lang.get('gui.exit'));
        switch (id) {
            case 0: displayMoneyInfo(p, p); break;
            case 1: p.runcmd('moneytransfer'); break;
            case 2: p.runcmd('moneyofflinetransfer'); break;
            case 3: showMoneyHistory(p); break;
            case 4: ranking(p.realName); break;
            case 5: if (globalThis.showRpHelp) globalThis.showRpHelp(p); break;
        }
    });
}

function OPMoneyGui(plname) {
    const pl = mc.getPlayer(plname);
    if (!pl) return;
    const fm = mc.newSimpleForm().setTitle('(OP)' + economyCfg.coinName);
    const _c  = economyCfg.coinName;
    fm.addButton((lang.get('money.op.add') || '增加') + _c, 'textures/ui/icon_best3');
    fm.addButton((lang.get('money.op.remove') || '减少') + _c, 'textures/ui/redX1');
    fm.addButton((lang.get('money.op.set') || '设置') + _c, 'textures/ui/gear');
    fm.addButton(lang.get('money.op.look') || '查看', 'textures/ui/MCoin');
    fm.addButton('全服' + _c + '排行榜', 'textures/ui/icon_book_writable');
    fm.addButton(lang.get('money.gui.useplayer') || '使用玩家菜单', 'textures/ui/icon_multiplayer');

    pl.sendForm(fm, (p, id) => {
        if (id == null) return p.tell(info + lang.get('gui.exit'));
        switch (id) {
            case 0: openPlayerSelectionGui(p, '增加金币', (op, tgt) => { /* 略 */ }); break;
            case 4: ranking(p.realName); break;
            case 5: MoneyGui(p.realName); break;
        }
    });
}

function showMoneyHistory(pl) {
    const hist = MoneyHistory.get(pl.realName) || {};
    const items = Object.entries(hist).slice(-50).reverse();
    const str   = items.length ? items.map(([t, v]) => `${t}: ${v}`).join('\n') : lang.get('money.history.empty');
    const fm    = mc.newSimpleForm().setTitle('你的' + economyCfg.coinName + '历史记录').setContent(str);
    pl.sendForm(fm, (p, id) => { if (id == null) p.runcmd('moneygui'); });
}

// ══════════════════════════════════════════════════════════
// 模块加载器（Node.js require，串行保证顺序）
// ══════════════════════════════════════════════════════════
(function loadModules() {
    const BASE_PATH = 'plugins/NEssential/modules/';

    let modules = [];
    try {
        const raw = fs.readFileSync(BASE_PATH + 'modulelist.json', 'utf8');
        modules   = JSON.parse(raw).modules.map(m => ({
            path: BASE_PATH + m.path,
            name: m.name,
        }));
    } catch (err) {
        logger.error('读取模块列表失败: ' + err.message);
    }

    let loaded = 0, failed = 0, idx = 0;

    function loadNext() {
        if (idx >= modules.length) {
            // 所有模块加载完毕
            const whCfg = conf.get('wh') || { EnableModule: true, status: 0 };
            stats = whCfg.status === 1;
            if (whCfg.EnableModule && whCfg.status === 1) {
                mc.setMotd(conf.get('wh').motd || '服务器维护中，请勿进入！');
            } else {
                Motd();
            }

            try { initializePlugin(); } catch (e) {
                logger.error('插件初始化失败: ' + e.message);
            }

            setTimeout(() => {
                if (conf.get('SimpleLogOutPut') !== false) return;
                if (failed > 0) { randomGradientLog(lang.get('init.fail') || '部分模块加载失败'); }
                else {
                    randomGradientLog(lang.get('init.success') || '所有模块加载成功！');
                    randomGradientLog('-'.repeat(50));
                    randomGradientLog(lang.get('Tip1') || '感谢使用 NEssential！');
                    randomGradientLog(lang.get('Tip2') || '');
                    randomGradientLog(lang.get('Tip3') || '');
                    randomGradientLog('-'.repeat(50));
                }
            }, 100);
            return;
        }

        const m = modules[idx++];
        try {
            if (conf.get('SimpleLogOutPut') === false)
                randomGradientLog(`加载模块: ${m.name}`);

            const mod = require(path.resolve(m.path));
            if (!mod) { logger.warn(`模块 ${m.name} 返回值为空`); failed++; }
            else if (typeof mod.init === 'function') { mod.init(); loaded++; }
            else if (typeof mod.initializeConfig === 'function') { mod.initializeConfig(); loaded++; }
            else loaded++;
        } catch (err) {
            logger.error(`✗ 模块 ${m.name} 加载失败: ${err.message}`);
            logger.error(err.stack || '无堆栈信息');
            failed++;
        }

        // 用 setTimeout(0) 让 LLSE 事件循环有机会处理其他事务
        setTimeout(loadNext, 10);
    }

    setTimeout(() => {
        printGradientLogo();
        loadNext();
    }, 2000);
})();

// ══════════════════════════════════════════════════════════
// 插件主初始化（在所有模块加载完毕后调用）
// ══════════════════════════════════════════════════════════
function initializePlugin() {
    // 1. 创建计分板
    const sbName = economyCfg.scoreboard;
    try {
        const all = mc.getAllScoreObjectives();
        if (!all.some(o => o === sbName))
            mc.runcmdEx(`scoreboard objectives add ${sbName} dummy`);
    } catch {
        mc.runcmdEx(`scoreboard objectives add ${sbName} dummy`);
    }

    // 2. 维护模式提示
    if (Maintenance.isActive)
        setTimeout(() => randomGradientLog(lang.get('wh.warn')), 1000);

    // 3. 死亡不掉落
    if (conf.get('KeepInventory'))
        mc.runcmdEx('gamerule KeepInventory true');

    // 4. 清理残留 FCAM 模拟玩家
    mc.getOnlinePlayers().forEach(p => {
        if (p.isSimulatedPlayer?.() && p.name.endsWith('_sp')) p.simulateDisconnect?.();
    });

    // 5. 异步更新检查（走 UpdateWorker 子线程，不阻塞主线程）
    setTimeout(async () => {
        try {
            const AsyncUpdateChecker = require('./modules/AsyncUpdateChecker');
            await AsyncUpdateChecker.init();

            const uc = conf.get('Update');
            if (uc?.EnableModule) {
                await AsyncUpdateChecker.checkForUpdates(version);
                if (uc.CheckInterval > 0) {
                    setInterval(() => AsyncUpdateChecker.checkForUpdates(version),
                        uc.CheckInterval * 60 * 1000);
                }
            }
        } catch (err) {
            logger.error(`更新检查失败: ${err.message}`);
        }
    }, 3000);
}

// 暴露各 Worker 池供 Debug 模块查询
globalThis.__filePool = fileWorker;
// UpdateWorker 池在 AsyncUpdateChecker 首次调用时创建，通过下面的 hook 暴露
const _origGetPool = (require('./modules/AsyncUpdateChecker')._getPool || (() => {})).bind(null);

// 标记监听器已注册
globalThis.__NEST_listeners_registered__ = true;

// ══════════════════════════════════════════════════════════
// EconomyManager（home/warp/tpa 需要）
// ══════════════════════════════════════════════════════════
const EconomyManager = {
    getScoreboard: () => economyCfg.scoreboard,
    isLLMoney: () => !!economyCfg.isLLMoney,
    checkAndReduce(playerName, amount) {
        const player = mc.getPlayer(playerName);
        if (!player) return false;
        if (this.isLLMoney()) {
            const bal = player.getMoney();
            if (bal === null || bal === undefined) { player.setMoney(0); return false; }
            if (bal < amount) return false;
            return player.reduceMoney(amount);
        } else {
            const sb = this.getScoreboard();
            if (player.getScore(sb) < amount) return false;
            return player.reduceScore(sb, amount);
        }
    },
};
globalThis.EconomyManager = EconomyManager;

const transdimid = { 0: '主世界', 1: '下界', 2: '末地' };
globalThis.transdimid = transdimid;

// ══════════════════════════════════════════════════════════
// WARP 系统
// ══════════════════════════════════════════════════════════
const warpgui = mc.newCommand('warp', '公共传送点', PermType.Any);
warpgui.overload([]);
warpgui.setCallback((cmd, ori, out) => {
    const pl = ori.player;
    if (!pl) return out.error((lang.get('warp.only.player') || 'warp.only.player'));
    pl.isOP() ? OPWarpGui(pl.realName) : WarpGui(pl.realName);
});
warpgui.setup();

function OPWarpGui(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const fm = mc.newSimpleForm().setTitle((lang.get('warp.menu.public.op') || 'warp.menu.public.op'));
    fm.addButton((lang.get('warp.add') || 'warp.add'));
    fm.addButton((lang.get('warp.del') || 'warp.del'));
    fm.addButton((lang.get('warp.list') || 'warp.list'));
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
        [() => WarpAddGui(pl.realName), () => WarpDelGui(pl.realName), () => WarpGui(pl.realName)][id]?.();
    });
}

function WarpGui(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const warpList = Object.keys(JSON.parse(warpdata.read()));
    const fm = mc.newSimpleForm().setTitle((lang.get('warp.menu.public') || 'warp.menu.public'));
    warpList.forEach(n => fm.addButton(n));
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
        const warpName = warpList[id];
        const wi = warpdata.get(warpName);
        const cost = conf.get('Warp') || 0;
        const cf = mc.newCustomForm().setTitle((lang.get('warp.go.to') || 'warp.go.to'));
        cf.addLabel((lang.get('warp.teleport.name') || 'warp.teleport.name') + warpName);
        cf.addLabel((lang.get('warp.teleport.coord') || 'warp.teleport.coord') + `${wi.x},${wi.y},${wi.z} ${transdimid[wi.dimid]}`);
        cf.addLabel((lang.get('warp.teleport.cost') || 'warp.teleport.cost') + cost);
        cf.addLabel('您的' + economyCfg.coinName + '为：' + Economy.get(pl));
        pl.sendForm(cf, (pl, data) => {
            if (data == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
            if (!EconomyManager.checkAndReduce(pl.realName, cost)) return showInsufficientMoneyGui(pl, cost, 'warp');
            setTimeout(() => {
                pl.teleport(parseFloat(wi.x), parseFloat(wi.y), parseFloat(wi.z), parseInt(wi.dimid));
                pl.sendText(info + (lang.get('warp.teleported') || 'warp.teleported').replace('${name}', warpName));
            }, 200);
            mc.runcmdEx(`camera ${pl.realName} fade time 0.15 0.5 0.35 color 0 0 0`);
        });
    });
}

function WarpDelGui(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const warpList = Object.keys(JSON.parse(warpdata.read()));
    const fm = mc.newSimpleForm().setTitle((lang.get('warp.del.point') || 'warp.del.point'));
    warpList.forEach(n => fm.addButton(n));
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.runcmd('warp');
        const n = warpList[id];
        warpdata.delete(n);
        pl.sendText(info + (lang.get('warp.del.success') || 'warp.del.success').replace('${name}', n));
    });
}

function WarpAddGui(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const pos = pl.pos;
    const fm = mc.newCustomForm().setTitle((lang.get('warp.add.point') || 'warp.add.point'));
    fm.addLabel((lang.get('warp.add.point.xyz') || 'warp.add.point.xyz'));
    fm.addLabel((lang.get('warp.teleport.coord') || 'warp.teleport.coord') + `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} ${transdimid[pos.dimid]}`);
    fm.addInput((lang.get('warp.input.name') || 'warp.input.name'), (lang.get('warp.name') || 'warp.name'), 'myWarp', lang.get('warp.input.name.tip') || '');
    pl.sendForm(fm, (pl, data) => {
        if (data == null) return pl.runcmd('warp');
        const warpName = data[2];
        if (!warpName) return pl.tell(info + (lang.get('warp.noinput.name') || 'warp.noinput.name'));
        if (warpdata.get(warpName)) return pl.tell(info + (lang.get('warp.name.repetitive') || 'warp.name.repetitive'));
        warpdata.set(warpName, { x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1), dimid: pos.dimid });
        pl.sendText(info + (lang.get('warp.add.success') || 'warp.add.success').replace('${name}', warpName));
    });
}

// ══════════════════════════════════════════════════════════
// BACK 死亡回溯系统
// ══════════════════════════════════════════════════════════
const deathPoints = {};

if (__NEST_FIRST_LOAD__) {
    mc.listen('onPlayerDie', (pl) => {
        const name = pl.realName;
        const pos  = pl.pos;
        if (!pos) return;
        if (!deathPoints[name]) deathPoints[name] = [];
        deathPoints[name].unshift({
            pos: { x: pos.x, y: pos.y, z: pos.z, dimid: pos.dimid },
            time: new Date().toLocaleString(),
            dimension: transdimid[pos.dimid] || '未知维度',
        });
        if (deathPoints[name].length > 3) deathPoints[name] = deathPoints[name].slice(0, 3);
        pl.tell(info + (lang.get('back.helpinfo') || '已记录死亡点，使用 /back 可返回'));
    });

    mc.listen('onRespawn', (pl) => {
        if (conf.get('BackTipAfterDeath')) setTimeout(() => BackGUI(pl.realName), 100);
    });
}

const backcmd = mc.newCommand('back', '返回死亡点', PermType.Any);
backcmd.overload([]);
backcmd.setCallback((cmd, ori, out) => {
    const pl = ori.player;
    if (!pl) return out.error((lang.get('warp.only.player') || 'warp.only.player'));
    BackGUI(pl.realName);
});
backcmd.setup();

const deathlogcmd = mc.newCommand('deathlog', '查看死亡历史记录', PermType.Any);
deathlogcmd.overload([]);
deathlogcmd.setCallback((cmd, ori) => {
    const pl = ori.player; if (!pl) return;
    const pts = deathPoints[pl.realName];
    if (!pts || !pts.length) return pl.tell(info + (lang.get('back.list.Empty') || '暂无死亡记录'));
    pl.tell('§6=== 您的死亡点列表 ===');
    pts.forEach((p, i) => {
        pl.tell(`§e死亡点 ${i+1}：`);
        pl.tell(`§7坐标：${Math.round(p.pos.x)}, ${Math.round(p.pos.y)}, ${Math.round(p.pos.z)}`);
        pl.tell(`§7维度：${p.dimension}  时间：${p.time}`);
    });
});
deathlogcmd.setup();

function BackGUI(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const pts = deathPoints[pl.realName];
    if (!pts || !pts.length) return pl.tell(info + (lang.get('back.list.Empty') || '暂无死亡记录'));
    const cost = conf.get('Back') || 0;
    const fm = mc.newCustomForm().setTitle(lang.get('back.to.point') || '返回死亡点');
    fm.addLabel(lang.get('back.choose') || '请选择死亡点');
    pts.forEach((p, i) => fm.addLabel(
        `§e死亡点 ${i+1}：\n§7${Math.round(p.pos.x)}, ${Math.round(p.pos.y)}, ${Math.round(p.pos.z)}  ${p.dimension}\n§7${p.time}`
    ));
    fm.addDropdown('选择要传送的死亡点', pts.map((p, i) =>
        `死亡点${i+1} - ${p.dimension} (${Math.round(p.pos.x)}, ${Math.round(p.pos.y)}, ${Math.round(p.pos.z)})`
    ), 0);
    fm.addLabel(displayMoneyInfo(pl, pl, true));
    fm.addLabel('传送需要花费 ' + cost + ' ' + economyCfg.coinName);
    pl.sendForm(fm, (pl, data) => {
        if (data === null || data === undefined) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
        const cur = deathPoints[pl.realName];
        if (!cur || !cur.length) return pl.tell(info + '§c死亡点数据已失效！');
        const sel = data[1 + cur.length];
        if (sel === undefined || sel < 0 || sel >= cur.length) return pl.tell(info + (lang.get('back.choose.null') || '选择无效'));
        const pt = cur[sel];
        if (!pt || !pt.pos) return pl.tell(info + (lang.get('back.deathlog.error') || '数据错误'));
        if (!smartMoneyCheck(pl.realName, cost)) return pl.tell(info + (lang.get('money.no.enough') || 'money.no.enough'));
        try {
            pl.teleport(pt.pos.x, pt.pos.y, pt.pos.z, pt.pos.dimid);
            mc.runcmdEx(`effect "${pl.realName}" resistance 15 255 true`);
            pl.tell(info + `§a已传送至死亡点${sel + 1}！`);
        } catch (e) {
            pl.tell(info + (lang.get('back.fail') || '传送失败'));
            logger.error('Back System Error: ' + e);
        }
    });
}

// ══════════════════════════════════════════════════════════
// HOME 家园系统
// ══════════════════════════════════════════════════════════
const homegui = mc.newCommand('home', '家园系统', PermType.Any);
homegui.overload([]);
homegui.setCallback((cmd, ori, out) => {
    const pl = ori.player;
    if (!pl) return out.error((lang.get('warp.only.player') || 'warp.only.player'));
    const fm = mc.newSimpleForm().setTitle(lang.get('home.tp.system') || '家园系统');
    fm.addButton(lang.get('home.tp') || '传送到家');
    fm.addButton(lang.get('home.add') || '添加家');
    fm.addButton(lang.get('home.del') || '删除家');
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
        [TpHome, AddHome, DelHome][id]?.(pl.realName);
    });
});
homegui.setup();

function TpHome(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const cost = conf.get('Home')?.tp || 0;
    const pldata = homedata.get(pl.realName) || {};
    const lst = Object.keys(pldata);
    if (!lst.length) return pl.tell(info + (lang.get('home.list.empty') || '还没有设置任何家'));
    const fm = mc.newSimpleForm().setTitle(lang.get('home.tp') || '传送到家').setContent(lang.get('home.tp.choose') || '选择一个家');
    lst.forEach(k => fm.addButton(k + '\n坐标：' + pldata[k].x + ',' + pldata[k].y + ',' + pldata[k].z + ' ' + transdimid[pldata[k].dimid]));
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
        const cf = mc.newCustomForm().setTitle(lang.get('home.tp') || '传送到家');
        cf.addLabel('确认传送家 ' + lst[id] + '？');
        cf.addLabel('您的' + economyCfg.coinName + '：' + Economy.get(pl));
        cf.addLabel('传送需要花费 ' + cost + ' ' + economyCfg.coinName);
        cf.addLabel('坐标：' + pldata[lst[id]].x + ',' + pldata[lst[id]].y + ',' + pldata[lst[id]].z + ' ' + transdimid[pldata[lst[id]].dimid]);
        pl.sendForm(cf, (pl, data) => {
            if (data == null) return pl.runcmd('home');
            if (!EconomyManager.checkAndReduce(pl.realName, cost)) return showInsufficientMoneyGui(pl, cost, 'home');
            const d = homedata.get(pl.realName);
            setTimeout(() => {
                pl.teleport(parseFloat(d[lst[id]].x), parseFloat(d[lst[id]].y), parseFloat(d[lst[id]].z), parseInt(d[lst[id]].dimid));
                pl.sendText(info + '传送家 ' + lst[id] + ' 成功！');
            }, 200);
            mc.runcmdEx(`camera ${pl.realName} fade time 0.15 0.5 0.35 color 0 0 0`);
        });
    });
}

function DelHome(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const cost = conf.get('Home')?.del || 0;
    const pldata = homedata.get(pl.realName) || {};
    const lst = Object.keys(pldata);
    if (!lst.length) return pl.tell(info + (lang.get('home.list.empty') || '还没有设置任何家'));
    const fm = mc.newSimpleForm().setTitle(lang.get('home.del') || '删除家').setContent(lang.get('home.del.choose') || '选择要删除的家');
    lst.forEach(k => fm.addButton(k + '\n坐标：' + pldata[k].x + ',' + pldata[k].y + ',' + pldata[k].z));
    pl.sendForm(fm, (pl, id) => {
        if (id == null) return pl.runcmd('home');
        const cf = mc.newCustomForm().setTitle(lang.get('home.del') || '删除家');
        cf.addLabel('§c§l确认删除家 ' + lst[id] + '？此操作不可撤销！');
        cf.addLabel('您的' + economyCfg.coinName + '：' + Economy.get(pl));
        cf.addLabel('删除需要花费 ' + cost + ' ' + economyCfg.coinName);
        pl.sendForm(cf, (pl, data) => {
            if (data == null) return pl.tell(info + (lang.get('gui.exit') || 'gui.exit'));
            if (!EconomyManager.checkAndReduce(pl.realName, cost)) return showInsufficientMoneyGui(pl, cost, 'home');
            const d = homedata.get(pl.realName);
            delete d[lst[id]];
            homedata.set(pl.realName, d);
            pl.sendText(info + '删除家 ' + lst[id] + ' 成功！');
        });
    });
}

function AddHome(plname) {
    const pl = mc.getPlayer(plname); if (!pl) return;
    const cost = conf.get('Home')?.add || 0;
    const maxHome = conf.get('Home')?.MaxHome || 5;
    const pldata = homedata.get(pl.realName) || {};
    if (Object.keys(pldata).length >= maxHome) return pl.sendText(info + '您的家数量已达到上限：' + maxHome + '！');
    const pos = pl.pos;
    const fm = mc.newCustomForm().setTitle(lang.get('home.add') || '添加家');
    fm.addLabel('当前坐标：' + pos.x.toFixed(1) + ',' + pos.y.toFixed(1) + ',' + pos.z.toFixed(1));
    fm.addLabel('您的' + economyCfg.coinName + '：' + Economy.get(pl));
    fm.addLabel('添加花费：' + cost + ' ' + economyCfg.coinName);
    fm.addInput(lang.get('home.add.input') || '家的名字', 'home1', 'home1', lang.get('home.add.input.tip') || '');
    pl.sendForm(fm, (pl, data) => {
        if (data == null) return pl.runcmd('home');
        if (!data[3]) return pl.tell(info + (lang.get('home.name.noinput') || '请输入家的名字'));
        const d = homedata.get(pl.realName);
        if (Object.keys(d).includes(data[3])) return pl.tell(info + (lang.get('home.name.repetitive') || '家的名字已存在'));
        if (!EconomyManager.checkAndReduce(pl.realName, cost)) return showInsufficientMoneyGui(pl, cost, 'home');
        d[data[3]] = { x: pos.x.toFixed(1), y: pos.y.toFixed(1), z: pos.z.toFixed(1), dimid: pos.dimid };
        homedata.set(pl.realName, d);
        pl.sendText(info + '添加家：' + data[3] + ' 成功！');
    });
}

// ══════════════════════════════════════════════════════════
// TPA 传送系统
// ══════════════════════════════════════════════════════════
const pendingTpaRequests = {};

mc.regPlayerCmd('tpa', '传送系统', (player) => { showTpaMainMenu(player); });
mc.regPlayerCmd('tpayes', '§a同意传送请求', (pl) => { acceptTpaRequest(pl.name); });
mc.regPlayerCmd('tpano', '§c拒绝传送请求', (pl) => { denyTpaRequest(pl.name); });

function showTpaMainMenu(player) {
    if (!conf.get('tpa')?.EnabledModule) { player.tell(info + (lang.get('module.no.Enabled') || 'module.no.Enabled')); return; }
    const fm = mc.newSimpleForm().setTitle('TPA 主菜单').setContent('请选择您要进行的操作：');
    fm.addButton('传送到玩家');
    fm.addButton('把玩家传过来');
    fm.addButton('偏好设置');
    player.sendForm(fm, (pl, id) => {
        if (id == null) return;
        if (id === 0) showTpaMenu(pl, 'to');
        else if (id === 1) showTpaMenu(pl, 'here');
        else showTpaPrefsGui(pl);
    });
}

function showTpaMenu(player, fixedDirection) {
    const cost = conf.get('tpa')?.cost || 0;
    const tpaConfig = conf.get('tpa') || {};
    const onlinePlayers = mc.getOnlinePlayers().filter(p => p.name !== player.name);
    if (!onlinePlayers.length) { player.tell(info + (lang.get('tpa.noplayer.online') || '没有其他在线玩家')); return; }
    const nameList = onlinePlayers.map(p => p.name);
    const form = mc.newCustomForm().setTitle(fixedDirection === 'to' ? '传送到玩家' : '把玩家传过来');
    form.addDropdown(lang.get('tpa.choose.player') || '选择玩家', nameList);
    form.addLabel((lang.get('tpa.cost') || '传送费用: ${cost}').replace('${cost}', cost));
    const isDelayEnabled = tpaConfig.isDelayEnabled !== false;
    const maxD = Number(tpaConfig.maxDelay) || 20;
    if (isDelayEnabled) form.addSlider(`§e传送延迟(0~${maxD}秒)`, 0, maxD, 1, 0);
    player.sendForm(form, (pl, data) => {
        if (!data) { pl.tell(info + (lang.get('tpa.exit') || '已取消')); return; }
        let idx = 0;
        const targetIndex = data[idx++]; idx++; // skip label
        const delaySec = isDelayEnabled ? Math.floor(data[idx++]) : 0;
        sendTpaRequest(pl, nameList[targetIndex], fixedDirection, delaySec);
    });
}

function showTpaPrefsGui(player) {
    const prefs = tpacfg.get(player.realName) || {};
    const tpaConfig = conf.get('tpa') || {};
    const fm = mc.newCustomForm().setTitle('TPA 设置');
    fm.addLabel('关闭此开关将立即拒绝任何 TPA 请求。');
    fm.addSwitch('TPA 开关', prefs.acceptTpaRequests !== false);
    fm.addDropdown('接收到请求时', ['弹窗提醒', '文字提醒'], prefs.promptType === 'text' ? 1 : 0);
    fm.addInput('请求有效时间/秒', '秒', String(prefs.requestTimeout || tpaConfig.requestTimeout || 60), '');
    player.sendForm(fm, (pl, data) => {
        if (!data) return;
        const timeout = parseInt(data[3]);
        tpacfg.set(pl.realName, {
            ...prefs,
            acceptTpaRequests: data[1],
            promptType: data[2] === 0 ? 'form' : 'text',
            requestTimeout: isNaN(timeout) || timeout <= 0 ? 60 : timeout,
        });
        pl.tell(info + (lang.get('tpa.save.conf.ok') || '设置已保存'));
    });
}

function sendTpaRequest(fromPlayer, toPlayerName, direction, delaySec = 0) {
    const toPlayer = mc.getPlayer(toPlayerName);
    if (!toPlayer) { fromPlayer.tell(info + (lang.get('tpa.send.fail') || '目标玩家不在线')); return; }
    if (tpacfg.get(toPlayerName)?.acceptTpaRequests === false) {
        fromPlayer.tell(info + (lang.get('tpa.send.noway') || '对方已关闭 TPA 请求'));
        return;
    }
    const tpaConfig = conf.get('tpa') || {};
    const toPrefs = tpacfg.get(toPlayerName) || {};
    const uid = Math.floor(Math.random() * 1e8);
    const timeoutSec = toPrefs.requestTimeout || tpaConfig.requestTimeout || 60;
    const pType = toPrefs.promptType || tpaConfig.promptType || 'form';
    const req = { from: fromPlayer, to: toPlayer, fromName: fromPlayer.name, toName: toPlayerName, direction, delay: delaySec, bossbarId: uid };
    pendingTpaRequests[toPlayerName] = req;

    toPlayer.tell(`${info}§e收到来自 ${fromPlayer.name} 的传送请求(${direction === 'to' ? '对方想传送到你' : '对方想把你传过去'})${delaySec > 0 ? `，延迟 ${delaySec}s` : ''}\n§c请求将在 ${timeoutSec}s 后超时`);
    fromPlayer.tell(`${info}§a已向 ${toPlayerName} 发送请求(延迟=${delaySec}s)，等待对方同意`);

    if (pType === 'form') showTpaConfirmForm(req, timeoutSec);
    else showTpaBossbarPrompt(req, timeoutSec);
}

function showTpaConfirmForm(req, timeoutSec) {
    const form = mc.newSimpleForm().setTitle(lang.get('tpa.request') || 'TPA 请求')
        .setContent(`${info}§b[${req.fromName}] 请求${req.direction === 'to' ? '传送到你' : '把你传过去'}${req.delay > 0 ? `(延迟${req.delay}s)` : ''}\n§e剩余时间: ${timeoutSec}s`);
    form.addButton(lang.get('tpa.a') || '同意');
    form.addButton(lang.get('tpa.d') || '拒绝');
    req.to.sendForm(form, (pl, id) => {
        if (id == null) return;
        id === 0 ? acceptTpaRequest(pl.name) : denyTpaRequest(pl.name);
    });
    startTpaCountdown(req, timeoutSec, false);
}

function showTpaBossbarPrompt(req, timeoutSec) {
    req.to.setBossBar(req.bossbarId,
        `§a${req.fromName}请求${req.direction === 'to' ? '传送到你' : '把你传过去'}${req.delay > 0 ? `(延迟${req.delay}s)` : ''} §c(/tpayes 同意 /tpano 拒绝)`,
        100, 3);
    startTpaCountdown(req, timeoutSec, true);
}

function startTpaCountdown(req, timeoutSec, bossbarMode) {
    let remain = timeoutSec;
    req.timer = setInterval(() => {
        remain--;
        if (!mc.getPlayer(req.to.name) || !mc.getPlayer(req.from.name)) {
            clearInterval(req.timer);
            cancelTpaRequest(req.toName, lang.get('tpa.player.offline') || '玩家已下线');
            return;
        }
        if (bossbarMode) {
            req.to.setBossBar(req.bossbarId,
                `§a${req.fromName}请求传送 §c(/tpayes /tpano) §e剩余${remain}s`,
                Math.floor((remain / timeoutSec) * 100), 3);
        }
        if (remain <= 0) {
            clearInterval(req.timer);
            cancelTpaRequest(req.toName, info + (lang.get('tpa.request.timeout') || '传送请求已超时'));
        }
    }, 1000);
}

function acceptTpaRequest(targetName) {
    const req = pendingTpaRequests[targetName];
    if (!req) { const p = mc.getPlayer(targetName); if (p) p.tell(info + (lang.get('tpa.no.request') || '没有待处理的请求')); return; }
    clearTpaRequest(req);
    const { from, to, direction, delay } = req;
    const doTp = () => {
        if (!mc.getPlayer(from.name) || !mc.getPlayer(to.name)) { from.tell(info + (lang.get('tpa.tp.fail.noonline') || 'tpa.tp.fail.noonline')); return; }
        const tgt = direction === 'to' ? to : from;
        const mover = direction === 'to' ? from : to;
        const footPos = tgt.pos;
        setTimeout(() => {
            mover.teleport(footPos.x, footPos.y - 1.62, footPos.z, footPos.dimid);
        }, 500);
        mc.runcmdEx(`camera ${mover.realName} fade time 0.15 0.5 0.35 color 0 0 0`);
        from.tell(info + (lang.get('tpa.tp.okey') || 'tpa.tp.okey'));
        to.tell(info + (lang.get('tpa.tp.okey') || 'tpa.tp.okey'));
    };
    if (delay > 0) {
        from.tell(info + `§e${delay} 秒后传送...`);
        to.tell(info + `§e${delay} 秒后传送...`);
        let remain = delay;
        const timer = setInterval(() => {
            remain--;
            if (!mc.getPlayer(from.name) || !mc.getPlayer(to.name)) { clearInterval(timer); return; }
            if (remain <= 0) { clearInterval(timer); doTp(); }
        }, 1000);
    } else {
        doTp();
    }
    delete pendingTpaRequests[targetName];
}

function denyTpaRequest(targetName) {
    const req = pendingTpaRequests[targetName];
    if (!req) { const p = mc.getPlayer(targetName); if (p) p.tell(info + (lang.get('tpa.no.request') || 'tpa.no.request')); return; }
    clearTpaRequest(req);
    req.from.tell(info + (lang.get('tpa.d.request') || 'tpa.d.request'));
    req.to.tell(info + (lang.get('tpa.d.request.you') || 'tpa.d.request.you'));
    delete pendingTpaRequests[targetName];
}

function cancelTpaRequest(targetName, msg) {
    const req = pendingTpaRequests[targetName]; if (!req) return;
    clearTpaRequest(req);
    req.from.tell(msg);
    delete pendingTpaRequests[targetName];
}

function clearTpaRequest(req) {
    if (req.timer) clearInterval(req.timer);
    try { req.to?.removeBossBar?.(req.bossbarId); } catch {}
}

if (__NEST_FIRST_LOAD__) {
    mc.listen('onLeft', (pl) => {
        for (const [key, req] of Object.entries(pendingTpaRequests)) {
            if (!req) continue;
            if (req.toName === pl.name) { clearTpaRequest(req); req.from.tell(info + (lang.get('tpa.player.offline') || 'tpa.player.offline')); delete pendingTpaRequests[key]; }
            else if (req.fromName === pl.name) { clearTpaRequest(req); req.to?.tell(info + (lang.get('tpa.player.offline') || 'tpa.player.offline')); delete pendingTpaRequests[key]; }
        }
    });
}
