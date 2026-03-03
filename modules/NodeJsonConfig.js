'use strict';
/**
 * NodeJsonConfig.js
 * 用 Node.js fs 模块替代 LLSE 的 JsonConfigFile。
 * 保留相同的 get / set / init / reload / read 接口。
 */
const fs   = require('fs');
const path = require('path');

class NodeJsonConfig {
    constructor(filePath, defaultJson = '{}') {
        this._path    = filePath;
        this._default = defaultJson;
        this._data    = {};
        this._ensureFile();
        this._load();
    }

    _ensureFile() {
        const dir = path.dirname(this._path);
        if (!fs.existsSync(dir))        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(this._path)) fs.writeFileSync(this._path, this._default, 'utf8');
    }

    _load() {
        try {
            const raw = fs.readFileSync(this._path, 'utf8');
            this._data = JSON.parse(raw || this._default);
        } catch { this._data = JSON.parse(this._default); }
    }

    _save() {
        fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
    }

    get(key, defaultVal)  {
        const v = this._data[key];
        return v !== undefined ? v : defaultVal;
    }
    set(key, value)       { this._data[key] = value; this._save(); return true; }
    init(key, def)        { if (this._data[key] === undefined) { this._data[key] = def; this._save(); } return this._data[key]; }
    delete(key)           { delete this._data[key]; this._save(); }
    reload()              { this._load(); }
    read()                { return JSON.stringify(this._data, null, 2); }
    write(jsonStr)        { this._data = JSON.parse(jsonStr); this._save(); }
    setAll(obj)           { this._data = obj; this._save(); }
    getKeys()             { return Object.keys(this._data); }
}

module.exports = NodeJsonConfig;
