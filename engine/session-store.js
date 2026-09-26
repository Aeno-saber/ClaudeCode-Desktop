'use strict';
/**
 * SessionStore — 对话与消息的本地持久化。
 *
 * 落盘结构：  <base>/index.json                  索引（轻量，列表用）
 *             <base>/sessions/<sessionId>.json   单个对话的全部消息
 * 拆成两个文件是为了让侧边栏列表只读一个小文件，历史长了也不会卡。
 *
 * 写入用「临时文件 + rename」，避免写一半断电留下坏 JSON。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }

class SessionStore {
  constructor(baseDir) {
    this.base = baseDir;
    this.sessionsDir = path.join(baseDir, 'sessions');
    this.indexFile = path.join(baseDir, 'index.json');
    this._index = null;
  }

  init() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    if (!fs.existsSync(this.indexFile)) this._writeJson(this.indexFile, { version: 1, sessions: [] });
    this._index = this._readJson(this.indexFile, { version: 1, sessions: [] });
    if (!Array.isArray(this._index.sessions)) this._index.sessions = [];
    return this;
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _writeJson(file, data) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _flushIndex() { this._writeJson(this.indexFile, this._index); }

  _sessionFile(id) { return path.join(this.sessionsDir, id + '.json'); }

  // ------------------------------------------------------------------- public

  list() {
    return this._index.sessions
      .slice()
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  create({ cwd, title } = {}) {
    const meta = {
      id: crypto.randomUUID(),
      title: title || '新对话',
      cwd: cwd || '',
      claudeSessionId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      itemCount: 0,
      preview: '',
    };
    this._index.sessions.push(meta);
    this._flushIndex();
    this._writeJson(this._sessionFile(meta.id), { id: meta.id, items: [] });
    return meta;
  }

  meta(id) { return this._index.sessions.find((s) => s.id === id) || null; }

  get(id) {
    const meta = this.meta(id);
    if (!meta) return null;
    const data = this._readJson(this._sessionFile(id), { id, items: [] });
    return { meta, items: Array.isArray(data.items) ? data.items : [] };
  }

  patch(id, fields) {
    const meta = this.meta(id);
    if (!meta) return null;
    Object.assign(meta, fields, { updatedAt: nowIso() });
    this._flushIndex();
    return meta;
  }

  /** 整体替换某个对话的消息列表 */
  setItems(id, items) {
    const meta = this.meta(id);
    if (!meta) return null;
    this._writeJson(this._sessionFile(id), { id, items });
    meta.itemCount = items.length;
    const firstUser = items.find((it) => it.kind === 'user' && it.text);
    meta.preview = firstUser ? firstUser.text.slice(0, 120) : '';
    if (meta.title === '新对话' && firstUser) {
      meta.title = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
    }
    meta.updatedAt = nowIso();
    this._flushIndex();
    return meta;
  }

  rename(id, title) {
    return this.patch(id, { title: String(title || '').trim().slice(0, 80) || '未命名对话' });
  }

  remove(id) {
    const i = this._index.sessions.findIndex((s) => s.id === id);
    if (i >= 0) {
      this._index.sessions.splice(i, 1);
      this._flushIndex();
    }
    try { fs.unlinkSync(this._sessionFile(id)); } catch { /* already gone */ }
    return true;
  }
}

module.exports = { SessionStore };
