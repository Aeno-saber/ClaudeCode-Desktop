'use strict';
/**
 * ProfilesStore — 「模型配置档案」，等价于 cc-switch 的供应商切换。
 *
 * 为什么要做这个（而不是只在自己进程里设环境变量）：
 *   实测（2026-09-24，_probe/probe_env_precedence.py）：
 *     进程环境变量里设 ANTHROPIC_MODEL=deepseek-v4-pro，
 *     而 ~/.claude/settings.json 的 env 里是 deepseek-flash，
 *     claude init 上报的仍然是 **deepseek-flash** ——
 *   也就是说 **settings.json 的 env 优先于进程环境变量**，
 *   光给子进程塞 env 是切不动的。
 *
 *   好在 claude 支持 `--settings <file-or-json>`（_probe/probe_settings_flag.py 实测
 *   内联 JSON 和文件路径都能压过全局 settings.json），所以：
 *     · 想把切换限制在本应用内 → 生成一份 settings JSON，用 --settings 指过去，
 *       再用 --setting-sources 把用户级设置挡掉，互不干扰；
 *     · 想让 VS Code / Trae 的扩展也跟着换 → 额外把 env 段写进
 *       ~/.claude/settings.json（每次写之前备份，且**只替换 env 这一个键**）。
 *
 * 数据形状刻意跟 cc-switch 对齐：一条档案的核心就是一段 `env` 键值对
 * （cc-switch 的 providers.settings_config 就是 {"env": {...}}）。
 * 这样从 cc-switch 导入可以原样搬运，包括我们没建模的键（FABLE、SUBAGENT 之类）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ---------------------------------------------------------------- env 键位定义

/** 「主模型」与「快速/小模型」两组分别对应哪些 env 键 */
const MODEL_SLOTS = {
  main: ['ANTHROPIC_MODEL'],
  opus: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
  sonnet: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
  haiku: ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
  fable: ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'],
  subagent: ['CLAUDE_CODE_SUBAGENT_MODEL'],
};
const KEY_BASE_URL = 'ANTHROPIC_BASE_URL';
const KEY_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const KEY_API_KEY = 'ANTHROPIC_API_KEY';

/** 由 UI 的友好字段（地址/令牌/两个模型）生成完整 env —— 形状参照本机 cc-switch 的 DeepSeek 档案 */
function envFromSimple({ baseUrl, token, model, fastModel, apiKey, extraEnv }) {
  const env = {};
  if (baseUrl) env[KEY_BASE_URL] = String(baseUrl).trim();
  if (token) env[KEY_TOKEN] = String(token).trim();
  if (apiKey) env[KEY_API_KEY] = String(apiKey).trim();
  const m = (model || '').trim();
  const f = (fastModel || model || '').trim();
  if (m) for (const k of MODEL_SLOTS.main) env[k] = m;
  if (m) for (const k of MODEL_SLOTS.opus) env[k] = m;
  if (m) for (const k of MODEL_SLOTS.sonnet) env[k] = m;
  // 快速模型：haiku / fable / 子代理 —— 缺省时跟随主模型，避免出现半套映射
  const fast = f || m;
  if (fast) for (const k of MODEL_SLOTS.haiku) env[k] = fast;
  if (fast) for (const k of MODEL_SLOTS.fable) env[k] = fast;
  if (fast) for (const k of MODEL_SLOTS.subagent) env[k] = fast;
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (k && v !== '' && v != null) env[String(k).trim()] = String(v);
  }
  return env;
}

/** 反过来：从一段 env 里抽取 UI 要显示的友好字段 */
function simpleFromEnv(env) {
  const e = env || {};
  const pick = (keys) => {
    for (const k of keys) if (e[k]) return e[k];
    return '';
  };
  const model = pick(MODEL_SLOTS.main) || pick(MODEL_SLOTS.opus) || pick(MODEL_SLOTS.sonnet);
  const fast = pick(MODEL_SLOTS.haiku) || pick(MODEL_SLOTS.fable) || pick(MODEL_SLOTS.subagent);
  // extraEnv = 不吃建模的、以及被建模字段吃掉之外的剩余键（导入时不能丢）
  const known = new Set([KEY_BASE_URL, KEY_TOKEN, KEY_API_KEY,
    ...Object.values(MODEL_SLOTS).flat()]);
  const extraEnv = {};
  for (const [k, v] of Object.entries(e)) if (!known.has(k)) extraEnv[k] = v;
  return {
    baseUrl: e[KEY_BASE_URL] || '',
    token: e[KEY_TOKEN] || '',
    apiKey: e[KEY_API_KEY] || '',
    model,
    fastModel: fast && fast !== model ? fast : '',
    extraEnv,
  };
}

// cc-switch 自带的常见供应商（本机 cc-switch 里能读到的两个，URL 是从它那儿核实过的；
// 其余的我不凭印象编地址 —— 地址写错比不给预设更糟）
const PRESETS = [
  { key: 'blank', name: '空白配置', category: 'custom', baseUrl: '', model: '', fastModel: '' },
  { key: 'official', name: 'Claude 官方', category: 'official', baseUrl: '', model: '', fastModel: '',
    note: '不覆盖任何环境变量，直接走 Claude 官方账号与默认模型。' },
  { key: 'deepseek', name: 'DeepSeek', category: 'cn_official',
    baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', fastModel: 'deepseek-v4-pro' },
  { key: 'kimi', name: 'Kimi（Moonshot）', category: 'cn_official',
    baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2.7-code', fastModel: '' },
];

/** 由地址猜一个顺眼的档案名（只在导入时做提示，猜不出就留空） */
const HOST_HINTS = {
  'api.deepseek.com': 'DeepSeek',
  'api.moonshot.cn': 'Kimi',
  'api.anthropic.com': 'Claude 官方',
  'open.bigmodel.cn': '智谱 GLM',
  'api.minimaxi.com': 'MiniMax',
  'dashscope.aliyuncs.com': '通义千问',
};
function nameFromEnv(env) {
  const url = (env || {})[KEY_BASE_URL] || '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (HOST_HINTS[host]) return HOST_HINTS[host];
    return host.replace(/^api\./, '').split('.')[0] || '';
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 列表里显示的摘要（不含任何密钥内容） */
function describeEnv(env) {
  const e = env || {};
  const s = simpleFromEnv(e);
  return {
    baseUrl: s.baseUrl,
    host: hostOf(s.baseUrl),
    model: s.model,
    fastModel: s.fastModel,
    tokenSet: !!(e[KEY_TOKEN] || e[KEY_API_KEY]),
    tokenHint: e[KEY_TOKEN] ? maskToken(e[KEY_TOKEN]) : (e[KEY_API_KEY] ? maskToken(e[KEY_API_KEY]) : ''),
    envCount: Object.keys(e).filter((k) => e[k] !== '' && e[k] != null).length,
  };
}

function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 12) return '****';
  return s.slice(0, 5) + '…' + s.slice(-4);
}

function nowIso() { return new Date().toISOString(); }

// ------------------------------------------------------------------ 全局配置文件

/**
 * 用户的全局 Claude 配置文件位置。
 *
 * CLAUDE_DESKTOP_SETTINGS_FILE 是给**测试**用的重定向口子：
 * 「切换时同步写入全局配置」这条路径默认会落在用户真实的 ~/.claude/settings.json
 * 上——那正是我们绝不能拿来试的东西。重定向之后，冒烟测试可以先把真文件**复制**
 * 一份，再在副本上把整条写入链路（备份 → 只换 env → 原子落盘）真跑一遍。
 *
 * 正常运行（双击启动）时这个变量是空的，行为与以前完全一致。
 */
function claudeSettingsPath() {
  const over = process.env.CLAUDE_DESKTOP_SETTINGS_FILE;
  if (over && String(over).trim()) return path.resolve(String(over).trim());
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readGlobalSettings() {
  return readJson(claudeSettingsPath());
}

function readGlobalEnv() {
  const g = readGlobalSettings();
  return g.env && typeof g.env === 'object' ? g.env : {};
}

/**
 * 把 env 写进 ~/.claude/settings.json。
 *
 * 三条硬规矩（用户的既有文件不能受伤）：
 *   1. 写之前**先备份**（带时间戳，放应用自己的目录，不往 ~/.claude 里塞垃圾）
 *   2. **只替换 env 这一个键**，其它键（model / permissions / hooks …）原样保留
 *   3. 用「临时文件 + rename」，避免写一半留下坏 JSON
 *
 * targetFile 只给自检用：让测试打在一个临时文件上，而不是用户的真实配置。
 */
function applyEnvToGlobal(env, backupDir, targetFile) {
  const file = targetFile || claudeSettingsPath();
  const before = targetFile ? readJson(file) : readGlobalSettings();
  const backupPath = backupSettings(file, backupDir, before);
  const after = { ...before, env: { ...env } };
  if (!Object.keys(env).length) {
    // 官方档案 = 不覆盖任何变量。给 {} 而不是删掉键，
    // 这样 IDE 扩展读到的是"没有覆盖"，不会继承上一家供应商的地址。
    after.env = {};
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(after, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return { file, backupPath, envKeys: Object.keys(after.env) };
}

function readJson(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function backupSettings(file, backupDir, parsed) {
  const dir = backupDir || path.join(os.homedir(), '.claude-desktop-backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dir, 'claude-settings-' + stamp + '.json');
  let body;
  if (parsed !== undefined) {
    body = JSON.stringify(parsed, null, 2);
  } else {
    try { body = fs.readFileSync(file, 'utf8'); } catch { body = '{}'; }
  }
  fs.writeFileSync(dst, body, 'utf8');
  pruneBackups(dir, 20);
  return dst;
}

/** 备份别无限堆 —— 只留最近 20 份 */
function pruneBackups(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('claude-settings-') && f.endsWith('.json'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* 清理失败不影响主流程 */ }
}

// -------------------------------------------------------------- 引擎用的设置文件

/**
 * 生成一份只含 env 的 settings JSON，交给 claude 的 `--settings`。
 * 路径按档案 id 命名：切换档案时不必覆盖正在被另一个进程读的文件。
 */
function writeEngineSettingsFile(dir, profile) {
  fs.mkdirSync(dir, { recursive: true });
  const id = (profile && profile.id) || 'active';
  const file = path.join(dir, safeId(id) + '.settings.json');
  const body = { env: { ...((profile && profile.env) || {}) } };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return file;
}

function safeId(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64); }

// ------------------------------------------------------------------ 导入

/**
 * 从 cc-switch 的 SQLite 只读导入 claude 档案。
 *
 * 为什么只读、不直接共用它的库：
 *   cc-switch 是另一个程序，数据库表结构随版本变化（v3.19 有 providers/meta/is_current
 *   /failover 等一堆字段）。共用一份数据看着优雅，但它一旦升级表结构，我这边的读写
 *   就可能把它的数据写坏。导入进来各管各的，风险小得多。
 */
function importFromCcSwitch(dbPath) {
  const file = dbPath || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (!fs.existsSync(file)) return { ok: false, reason: '没找到 cc-switch 数据库: ' + file, items: [] };
  let sqlite;
  try {
    sqlite = require('node:sqlite');       // Electron 43 / Node 24 自带，无需第三方依赖
  } catch (err) {
    return { ok: false, reason: '当前运行时没有 node:sqlite: ' + err.message, items: [] };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      'SELECT id, name, category, settings_config, website_url, notes FROM providers ' +
      "WHERE app_type = 'claude' ORDER BY COALESCE(sort_index, 999), name"
    ).all();
    const items = [];
    for (const r of rows) {
      let cfg = {};
      try { cfg = JSON.parse(r.settings_config || '{}'); } catch { /* 坏行就跳过 */ }
      items.push({
        source: 'cc-switch',
        sourceId: r.id,
        name: r.name || '未命名',
        category: r.category || 'custom',
        websiteUrl: r.website_url || '',
        notes: r.notes || '',
        env: (cfg && typeof cfg.env === 'object' && cfg.env) || {},
      });
    }
    // 哪一条是 cc-switch 当前的，顺手带回去，好让首次导入直接对齐
    let currentName = null;
    try {
      const sf = path.join(path.dirname(file), 'settings.json');
      const cur = JSON.parse(fs.readFileSync(sf, 'utf8')).currentProviderClaude;
      const hit = items.find((it) => it.sourceId === cur);
      if (hit) currentName = hit.name;
    } catch { /* 没有 settings.json 也无所谓 */ }
    return { ok: true, items, currentName, file };
  } catch (err) {
    return { ok: false, reason: '读取 cc-switch 数据库失败: ' + err.message, items: [] };
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

/** 把「当前 ~/.claude/settings.json 的 env」收成一条档案 */
function importFromGlobal() {
  const env = readGlobalEnv();
  const name = nameFromEnv(env) || '当前配置';
  return { ok: true, item: { source: 'claude-settings', name, category: 'custom', env }, file: claudeSettingsPath() };
}

// ------------------------------------------------------------------ 联网探测

/** 档案没写模型名时，用这个占位模型去探（它不需要真的存在，见 probeHint） */
const PROBE_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * 把探测拿到的状态码翻成人话。
 *
 * 目的只有一个：让用户知道**下一步该改什么**。404 是最典型的歧义 ——
 * 既可能是地址少了 /anthropic 后缀，也可能只是模型名端点不认；
 * 而这两种改法完全不同。
 */
function probeHint(status, modelGuessed, model) {
  if (status === 401) return '令牌无效或已过期，请重新复制一个';
  if (status === 403) return '令牌没有调用权限，或地址指向了别的服务';
  if (status === 404) {
    return modelGuessed
      ? '地址可能不对（常见：少了 /anthropic 后缀）。若地址确认无误，说明这个端点不认探测用的占位模型，属正常'
      : '地址可能不对（常见：少了 /anthropic 后缀），或端点不认模型「' + model + '」';
  }
  if (status === 400) return '端点可达，但请求被拒 —— 最常见的原因是模型名不存在';
  if (status === 429) return '请求过于频繁（限流），稍后再试；地址与令牌本身可能是好的';
  if (status >= 500) return '服务端报错，可能是对方暂时故障，也可能地址不通';
  return '';
}

/**
 * 连通性 + 鉴权探测。
 *
 * 为什么不只是「TCP 能连上」：地址填对但令牌过期、或者 baseUrl 忘了带 /anthropic
 * 后缀，这两种最常见的问题在「能连上」这个口径下都是绿的，用户只会在真正发消息时
 * 才看到 401/404。所以这里直接打一次最小的 /v1/messages 请求。
 *
 * 官方档案（env 里没有地址也没有令牌）走的是 CLI 自己的登录态，这里没有凭据可用，
 * 明确跳过而不是报红 —— 报红会把一个正常配置说成坏的。
 */
async function testProfile(env, { timeoutMs = 20000 } = {}) {
  const e = env || {};
  const base = (e[KEY_BASE_URL] || '').replace(/\/+$/, '');
  const token = e[KEY_TOKEN] || e[KEY_API_KEY] || '';
  const declared = e.ANTHROPIC_MODEL
    || e.ANTHROPIC_DEFAULT_HAIKU_MODEL || e.ANTHROPIC_DEFAULT_SONNET_MODEL || '';
  // 档案里没写模型名时用占位模型照样探。
  // 早先这里是直接 return「无法构造探测请求」—— 用户刚填完地址和令牌点「测试连接」
  // 却只得到这么一句，等于按钮废掉了。而这一步真正要回答的是
  // 「地址通不通、令牌认不认」，模型名对不对是下一件事。
  const modelGuessed = !declared;
  const model = declared || PROBE_MODEL;

  if (!base && !token) {
    return { ok: true, skipped: true, reason: '使用 Claude 官方登录态，无需在档案里填地址和令牌' };
  }
  if (!base) return { ok: false, reason: '档案里没有填 API 地址（ANTHROPIC_BASE_URL）' };
  if (!token) return { ok: false, reason: '档案里没有填 API 令牌（ANTHROPIC_AUTH_TOKEN）' };

  const url = base + '/v1/messages';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'authorization': 'Bearer ' + token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const ms = Date.now() - t0;
    const text = await res.text().catch(() => '');
    if (res.ok) {
      return {
        ok: true, status: res.status, ms, url, model, modelGuessed,
        reason: modelGuessed
          ? '鉴权通过（地址与令牌可用；档案里还没写模型名）'
          : '鉴权通过，模型 ' + model + ' 可用',
      };
    }
    // 把服务端原话带回去，比「失败了」有用得多（常见的是 model 名不对）
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error.type)) || j.message || detail;
    } catch { /* 非 JSON 就原文 */ }
    return {
      ok: false, status: res.status, ms, url, model, modelGuessed,
      reason: 'HTTP ' + res.status + ' · ' + detail,
      // 状态码翻成人话，省得用户去猜「404 到底是地址错还是模型错」
      hint: probeHint(res.status, modelGuessed, model),
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const aborted = err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));
    const timeoutSec = Math.round(timeoutMs / 1000);
    const reason = aborted
      ? '超时（>' + timeoutSec + ' 秒无响应），地址可能不通'
      : '请求失败: ' + ((err && err.message) || err);
    return { ok: false, ms, url, model, aborted: !!aborted, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 尽力列出可用模型（GET <base>/v1/models）。
 *
 * 刻意是「尽力」：Anthropic 官方端点有这个接口，不少转接站并没有，
 * 拿到 404 不算配置错误 —— 界面上就退回档案里已有的模型名。
 */
async function listModels(env, { timeoutMs = 12000 } = {}) {
  const e = env || {};
  const base = (e[KEY_BASE_URL] || '').replace(/\/+$/, '');
  const token = e[KEY_TOKEN] || e[KEY_API_KEY] || '';
  if (!base || !token) return { ok: false, models: [], reason: '没有地址或令牌，无法查询模型列表' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/v1/models', {
      signal: ac.signal,
      headers: {
        'x-api-key': token,
        'authorization': 'Bearer ' + token,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) return { ok: false, models: [], status: res.status, reason: 'HTTP ' + res.status };
    const j = await res.json().catch(() => null);
    const arr = (j && (j.data || j.models)) || [];
    const models = [];
    for (const m of arr) {
      const id = typeof m === 'string' ? m : (m && (m.id || m.name));
      if (id) models.push(String(id));
    }
    return { ok: true, models, reason: models.length ? '' : '端点返回了空列表' };
  } catch (err) {
    return { ok: false, models: [], reason: '请求失败: ' + (err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 存储

const DEFAULTS = {
  version: 1,
  activeId: null,
  /** 切换时是否同时写 ~/.claude/settings.json（写它 = VS Code / Trae 扩展跟着换） */
  syncGlobal: false,
  lastAppliedAt: null,
  items: [],
};

class ProfilesStore {
  constructor(baseDir) {
    this.base = baseDir;
    this.file = path.join(baseDir, 'profiles.json');
    this.backupDir = path.join(baseDir, 'backups');
    this.engineDir = path.join(baseDir, 'engine');
    this._data = null;
  }

  init() {
    fs.mkdirSync(this.base, { recursive: true });
    this._data = this._read();
    if (!Array.isArray(this._data.items)) this._data.items = [];
    return this;
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULTS, ...d, items: Array.isArray(d.items) ? d.items : [] };
    } catch {
      return { ...DEFAULTS, items: [] };
    }
  }

  _flush() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    // 这个文件里有明文 token，尽量收紧权限（Windows 上作用有限，聊胜于无）
    try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
    fs.renameSync(tmp, this.file);
  }

  get syncGlobal() { return !!this._data.syncGlobal; }
  set syncGlobal(v) { this._data.syncGlobal = !!v; this._flush(); }

  get activeId() { return this._data.activeId; }
  get lastAppliedAt() { return this._data.lastAppliedAt; }

  list() { return this._data.items.map((p) => ({ ...p })); }

  get(id) { return this._data.items.find((p) => p.id === id) || null; }

  active() {
    return this.get(this._data.activeId) || this._data.items[0] || null;
  }

  upsert(profile) {
    const p = {
      id: profile.id || crypto.randomUUID(),
      name: String(profile.name || '').trim() || '未命名配置',
      category: profile.category || 'custom',
      websiteUrl: profile.websiteUrl || '',
      notes: profile.notes || '',
      env: sanitizeEnv(profile.env),
      source: profile.source || 'manual',
      createdAt: profile.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    const i = this._data.items.findIndex((x) => x.id === p.id);
    if (i >= 0) p.createdAt = this._data.items[i].createdAt || p.createdAt;
    if (i >= 0) this._data.items[i] = p; else this._data.items.push(p);
    if (!this._data.activeId) this._data.activeId = p.id;
    this._flush();
    return p;
  }

  remove(id) {
    const i = this._data.items.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this._data.items.splice(i, 1);
    if (this._data.activeId === id) {
      this._data.activeId = this._data.items.length ? this._data.items[0].id : null;
    }
    this._flush();
    return true;
  }

  setActive(id) {
    if (!this.get(id)) return null;
    this._data.activeId = id;
    this._flush();
    return this.active();
  }

  /** 导入：按「名字 + env 是否等价」去重，返回新增了几条 */
  importItems(items, { makeActiveName } = {}) {
    let added = 0;
    const sig = (p) => p.name + '|' + JSON.stringify(sortedEnv(p.env));
    const seen = new Set(this._data.items.map(sig));
    for (const it of items || []) {
      const p = {
        id: crypto.randomUUID(),
        name: it.name,
        category: it.category || 'custom',
        websiteUrl: it.websiteUrl || '',
        notes: it.notes || '',
        env: sanitizeEnv(it.env),
        source: it.source || 'imported',
      };
      const s = sig(p);
      if (seen.has(s)) continue;
      seen.add(s);
      this._data.items.push({ ...p, createdAt: nowIso(), updatedAt: nowIso() });
      added++;
      if (makeActiveName && p.name === makeActiveName) this._data.activeId = p.id;
    }
    if (!this._data.activeId && this._data.items.length) this._data.activeId = this._data.items[0].id;
    this._flush();
    return added;
  }

  markApplied() { this._data.lastAppliedAt = nowIso(); this._flush(); }

  /** 应用某个档案：算 env、可选写全局、给出引擎该用的 --settings 文件 */
  apply(id) {
    const p = id ? this.setActive(id) : this.active();
    if (!p) return { ok: false, reason: '没有可用的配置档案' };
    const env = sanitizeEnv(p.env);
    const engineSettingsFile = writeEngineSettingsFile(this.engineDir, { ...p, env });
    let global = null;
    if (this.syncGlobal) {
      // 写入失败必须让调用方知道 —— 否则界面显示"已切换"，实际全局配置没变
      global = applyEnvToGlobal(env, this.backupDir);
    }
    this.markApplied();
    return {
      ok: true,
      profile: { ...p, env },
      envKeys: Object.keys(env),
      engineSettingsFile,
      global,
      syncGlobal: this.syncGlobal,
    };
  }

  /** 引擎启动参数 */
  engineLaunchArgs(id) {
    const p = id ? this.get(id) : this.active();
    // 一条档案都没有 → 完全不插手，沿用旧行为（继承 ~/.claude 的设置）。
    // 这条兜底很重要：万一档案文件被删了/坏了，应用也不能变成"连令牌都没有"而发不出消息。
    if (!p) return { args: [], settingsFile: null, env: {} };
    const env = sanitizeEnv(p.env);
    const file = writeEngineSettingsFile(this.engineDir, { id: (p && p.id) || 'active', env });
    const args = ['--settings', file];
    // 没开同步时，用户级设置里可能还留着**上一家供应商**的 env，
    // 它会漏进子进程（--settings 只覆盖它写了的那几个键）。
    // 所以把 user 这一源整个挡掉，只留 project/local —— 切换结果才完全由档案决定。
    if (!this.syncGlobal) args.push('--setting-sources', 'project,local');
    return { args, settingsFile: file, env };
  }

  uiState() {
    const items = this._data.items.map((p) => ({
      id: p.id, name: p.name, category: p.category, websiteUrl: p.websiteUrl,
      notes: p.notes, source: p.source, env: p.env,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      summary: describeEnv(p.env),
      // 编辑表单要回填原值（尤其是令牌，否则用户每改一次名字就得重贴一次 key）。
      // 本地渲染进程、contextIsolation 开着、页面不加载任何远程内容，所以不外泄。
      simple: simpleFromEnv(p.env),
    }));
    return {
      items,
      activeId: this._data.activeId,
      syncGlobal: this.syncGlobal,
      lastAppliedAt: this._data.lastAppliedAt,
      storeFile: this.file,
      backupDir: this.backupDir,
      claudeSettingsFile: claudeSettingsPath(),
      presets: PRESETS,
      globalEnv: describeEnv(readGlobalEnv()),
    };
  }
}

/**
 * 清洗 env：丢掉空键空值，并**按键名排序**。
 *
 * 排序不只是好看：cc-switch 写出来的就是字母序（AUTH_TOKEN → BASE_URL →
 * DEFAULT_FABLE… → MODEL → SUBAGENT）。如果我这边的顺序跟它不一样，
 * 每次「导入 → 编辑 → 存回」都会产生一堆毫无意义的 diff，也没法和它的文件对照。
 */
function sanitizeEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {}).sort()) {
    const key = String(k).trim();
    if (!key) continue;
    const v = env[k];
    if (v === '' || v == null) continue;      // 空值不写，避免弄出 ANTHROPIC_BASE_URL=""
    out[key] = String(v);
  }
  return out;
}

function sortedEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {}).sort()) out[k] = env[k];
  return out;
}

module.exports = {
  ProfilesStore,
  MODEL_SLOTS, KEY_BASE_URL, KEY_TOKEN, KEY_API_KEY,
  PRESETS, envFromSimple, simpleFromEnv, describeEnv, nameFromEnv, maskToken,
  readGlobalSettings, readGlobalEnv, applyEnvToGlobal, claudeSettingsPath, backupSettings,
  writeEngineSettingsFile, importFromCcSwitch, importFromGlobal, sanitizeEnv,
  testProfile, listModels,
};
