'use strict';
/**
 * 渲染进程主逻辑。
 *
 * 数据模型：一个对话 = 一串 chat item
 *   { kind:'user', text }
 *   { kind:'assistant', status, blocks:[…], meta:{…} }
 * 一个用户回合对应**一个** assistant item（内部按 blocks 顺序排列文本 / 思考 / 工具卡片），
 * 这样既贴合 ChatGPT 的「一问一答」观感，也让落盘格式简单稳定。
 *
 * 引擎事件 → item 的归约只在这一处发生（主进程只负责转发与存储）。
 */
// ★ 整个文件包在 IIFE 里：preload 的 contextBridge 会把 `api` 定义成 window 上
// **不可配置**的属性，普通脚本顶层再写 `const api = window.api` 会直接抛
//   Uncaught SyntaxError: Identifier 'api' has already been declared
// 整个脚本都不会执行（表现为界面出来一半、什么都不响应）。包一层即可，顺便不污染全局。
(function () {
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = window.api;

const state = {
  boot: null,
  settings: {},
  profiles: null,   // 模型配置档案（供应商切换）的状态，由主进程 profilesState() 给
  skills: null,     // 技能管家的状态（skills/ 与 skills-disabled/ 两个列表）
  sessions: [],
  currentId: null,
  items: [],
  busy: false,
  engine: { alive: false, ready: false, model: null, sessionId: null },
  turn: null,      // 当前正在流式输出的归约状态
  filter: '',
  showThinking: true,
  showToolOutput: false,
  expandedTools: new Set(),
};

let toastTimer = null;

/**
 * 流式重绘的节流参数。
 * 逐字流每秒可能来几十上百个 delta，若每个都立刻跑一次 Markdown 解析，
 * CPU 白烧而肉眼无感。50ms（≈20fps）对文字流已经足够顺滑，解析次数压掉一个量级。
 * 声明放在模块级（而不是函数旁边），避免被 TDZ 坑到。
 */
const PAINT_INTERVAL_MS = 50;
const paintPending = new Set();

// ============================================================ 工具函数

function uid() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function nowIso() { return new Date().toISOString(); }

/** 给时间戳用（鼠标悬停在消息上能看到具体时刻） */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (startOf(today) - startOf(d)) / 86400000;
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return '7 天内';
  if (diff <= 30) return '30 天内';
  return '更早';
}

function nfmt(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

async function copyText(text) {
  try {
    await api.copy(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

// ============================================================ 侧边栏

function renderSidebar() {
  const list = $('#convList');
  const q = state.filter.trim().toLowerCase();
  const sessions = state.sessions.filter((s) =>
    !q || (s.title || '').toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));

  if (!sessions.length) {
    list.innerHTML = '<div class="conv-empty">' + (q ? '没有匹配的对话' : '还没有对话') + '</div>';
    return;
  }

  const groups = new Map();
  for (const s of sessions) {
    const label = dayLabel(s.updatedAt || s.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(s);
  }

  const frag = document.createDocumentFragment();
  for (const [label, items] of groups) {
    const h = document.createElement('div');
    h.className = 'conv-group';
    h.textContent = label;
    frag.appendChild(h);

    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'conv' + (s.id === state.currentId ? ' active' : '');
      row.dataset.id = s.id;
      row.title = s.title || '';

      const t = document.createElement('div');
      t.className = 'conv-title';
      t.textContent = s.title || '新对话';
      row.appendChild(t);

      const tools = document.createElement('div');
      tools.className = 'conv-tools';

      const ren = document.createElement('button');
      ren.title = '重命名';
      ren.innerHTML = '<svg class="ic"><use href="#i-pencil"/></svg>';
      ren.onclick = (e) => { e.stopPropagation(); startRename(row, s); };

      const del = document.createElement('button');
      del.title = '删除';
      del.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg>';
      del.onclick = (e) => { e.stopPropagation(); removeSession(s); };

      tools.append(ren, del);
      row.appendChild(tools);
      row.onclick = () => selectSession(s.id);
      frag.appendChild(row);
    }
  }
  list.replaceChildren(frag);
}

function startRename(row, session) {
  const input = document.createElement('input');
  input.className = 'conv-edit';
  input.value = session.title || '';
  const title = row.querySelector('.conv-title');
  row.replaceChild(input, title);
  input.focus();
  input.select();
  const commit = async () => {
    const v = input.value.trim();
    if (v && v !== session.title) {
      const meta = await api.renameSession(session.id, v);
      if (meta) {
        const i = state.sessions.findIndex((s) => s.id === session.id);
        if (i >= 0) state.sessions[i] = meta;
      }
    }
    renderSidebar();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.onblur = null; renderSidebar(); }
  };
}

async function removeSession(session) {
  if (state.busy && session.id === state.currentId) {
    toast('正在生成中，先停止再删除');
    return;
  }
  if (!confirm('删除对话「' + (session.title || '新对话') + '」？此操作不可撤销。')) return;
  state.sessions = await api.deleteSession(session.id);
  if (state.currentId === session.id) {
    state.currentId = null;
    state.items = [];
    state.busy = false;
    renderThread();
    renderSidebar();
  } else {
    renderSidebar();
  }
  toast('已删除');
}

// ============================================================ 会话切换

async function newSession(cwd) {
  // 生成中不允许新建：否则旧对话那一轮的内容会流进一个已经不存在的上下文
  if (state.busy) {
    toast('正在生成中，先停止再新建对话');
    return null;
  }
  const { meta } = await api.createSession(cwd || state.settings.workspace || state.boot.workspace);
  state.sessions = await api.listSessions();
  state.currentId = meta.id;
  state.items = [];
  state.busy = false;
  state.turn = null;
  state.expandedTools.clear();
  // 引擎状态也要复位，否则顶部会残留上一个对话的模型名/就绪状态
  state.engine = { alive: false, ready: false, model: null, sessionId: null };
  renderSidebar();
  renderThread();
  updateStatus();
  $('#input').focus();
  return meta;
}

async function selectSession(id) {
  if (state.busy) {
    toast('正在生成中，先停止再切换');
    return;
  }
  if (id === state.currentId) return;
  const data = await api.getSession(id);
  if (!data) { toast('对话不存在'); return; }
  state.currentId = id;
  state.items = Array.isArray(data.items) ? data.items : [];
  state.busy = false;
  state.turn = null;
  state.expandedTools.clear();
  state.engine = { alive: false, ready: false, model: null, sessionId: null };
  renderSidebar();
  renderThread();
  updateStatus();
}

/**
 * 立即把当前对话写盘。
 *
 * 早先这里用 350ms 防抖 —— 那意味着「发完消息马上关窗口」会丢掉最后一轮，
 * 而且丢掉的是用户刚看到的那条回复，很难察觉。现在改成即时写：
 * 只有「上一次写入还没回来」时才合并到一次，窗口期从 350ms 降到接近 0。
 */
let persistInFlight = false;
let persistQueued = null;

function persist() {
  if (!state.currentId) return;
  persistQueued = {
    id: state.currentId,
    snapshot: JSON.parse(JSON.stringify(state.items, usageReplacer)),
  };
  if (!persistInFlight) flushPersist();
}

/** 持久化时丢掉 usage 里那几十个用不上的字段，只留四个数字 */
function usageReplacer(key, value) {
  if (key === 'usage' && value && typeof value === 'object') {
    return {
      input_tokens: value.input_tokens,
      output_tokens: value.output_tokens,
      cache_read_input_tokens: value.cache_read_input_tokens,
      cache_creation_input_tokens: value.cache_creation_input_tokens,
    };
  }
  return value;
}

async function flushPersist() {
  if (!persistQueued) return;
  const job = persistQueued;
  persistQueued = null;
  persistInFlight = true;
  try {
    const sessions = await api.setItems(job.id, job.snapshot);
    if (Array.isArray(sessions)) {
      state.sessions = sessions;
      renderSidebar();
    }
  } catch {
    /* 写盘失败不该打断对话，静默重试交给下一次 persist */
  } finally {
    persistInFlight = false;
    if (persistQueued) flushPersist();
  }
}

// 关窗口前把没写完的补上（尽力而为；因为已改成即时写，一般这里无事可做）
window.addEventListener('beforeunload', () => { if (persistQueued) flushPersist(); });

// ============================================================ 消息渲染

function toolIcon(name) {
  const n = String(name || '').toLowerCase();
  if (/bash|shell|terminal|powershell|exec|run/.test(n)) return 'i-terminal';
  if (/read|write|edit|notebook|file|multi_edit/.test(n)) return 'i-file';
  if (/glob|grep|search|websearch|webfetch|fetch/.test(n)) return 'i-search';
  if (/todo|task/.test(n)) return 'i-check';
  return 'i-bolt';
}

function toolSummary(block) {
  const inp = block.input || {};
  if (typeof inp.command === 'string') return inp.command;
  if (typeof inp.file_path === 'string') return inp.file_path;
  if (typeof inp.path === 'string') return inp.path;
  if (typeof inp.pattern === 'string') return inp.pattern;
  if (typeof inp.url === 'string') return inp.url;
  if (typeof inp.prompt === 'string') return inp.prompt;
  if (block.inputRaw) return block.inputRaw;
  return '';
}

function toolResultText(block) {
  const c = block.result;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (p && p.type === 'text' ? p.text : typeof p === 'string' ? p : JSON.stringify(p)))
      .filter(Boolean).join('\n');
  }
  return JSON.stringify(c, null, 2);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 渲染单条消息，返回 DOM 节点 */
function renderItem(item) {
  if (item.kind === 'user') {
    // 直接 flex column + align-items:flex-end，不再多套一层无意义 div
    // （多套的那层会让「复制」按钮跑到气泡左边缘，与气泡对齐不一致）
    const wrap = el('div', 'msg user');
    const bubble = el('div', 'bubble');
    bubble.textContent = item.text || '';
    bubble.title = fmtTime(item.at);
    wrap.append(bubble, msgActions([{ label: '复制', onClick: () => copyText(item.text || '') }]));
    return wrap;
  }

  const wrap = el('div', 'msg assistant');
  const avatar = el('div', 'avatar');
  const img = document.createElement('img');
  img.src = '../assets/claude-logo.png';
  img.alt = '';
  img.draggable = false;
  avatar.appendChild(img);

  const body = el('div', 'body');
  body.dataset.body = item.id;

  wrap.append(avatar, body);
  paintAssistant(item, body, true);
  return wrap;
}

function msgActions(btns) {
  const acts = el('div', 'msg-actions');
  for (const cfg of btns) {
    const b = el('button', 'act');
    b.type = 'button';
    b.innerHTML = '<svg class="ic"><use href="#i-copy"/></svg><span>' + cfg.label + '</span>';
    b.onclick = cfg.onClick;
    acts.appendChild(b);
  }
  return acts;
}

function assistantPlainText(item) {
  return (item.blocks || []).filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n');
}

function blockVisible(b) {
  if (b.kind === 'text') return !!b.text;
  if (b.kind === 'thinking') {
    // DeepSeek 端点只回签名不回推理正文，空块直接不显示，避免出现空折叠框
    return state.showThinking && !!(b.text && b.text.trim());
  }
  return true;   // tool / notice 始终显示
}

/* ---------------------------------------------------------------- 增量绘制
 *
 * 为什么要这么写：早先每帧 body.replaceChildren()，等于把整篇回复的 Markdown
 * 重新解析一遍。长回复（几万字）会明显掉帧；而且每次重建都会打断文本选择、
 * 重置工具卡片的展开状态。
 *
 * 现在的策略：
 *   · 每个 block 对应一个**长期复用**的 DOM 节点，按 bid 存在 body._paint.blocks 里
 *   · 只有内容真的变了才重写该节点的 innerHTML（其他块完全跳过）
 *   · 只有当「块的集合/顺序/状态」变化时才重排 DOM
 */

function createBlockNode(b) {
  if (b.kind === 'text') {
    const d = el('div', 'md');
    d.dataset.block = b.bid;
    return d;
  }
  if (b.kind === 'thinking') {
    const d = el('details', 'think');
    const s = el('summary');
    s.innerHTML = '<svg class="ic"><use href="#i-chevron"/></svg><span>思考过程</span>';
    const bd = el('div', 'think-body');
    d.append(s, bd);
    d._body = bd;
    return d;
  }
  if (b.kind === 'tool') return createToolNode(b);
  return el('div', 'notice');
}

function updateBlockNode(node, b) {
  if (b.kind === 'text') {
    if (node._src === b.text) return;          // 内容没变，跳过 Markdown 解析
    node._src = b.text;
    node.innerHTML = window.Markdown.render(b.text);
    return;
  }
  if (b.kind === 'thinking') {
    if (node._src === b.text) return;
    node._src = b.text;
    node._body.textContent = b.text;
    return;
  }
  if (b.kind === 'tool') { updateToolNode(node, b); return; }
  const html = b.html || window.Markdown.escapeHtml(b.text || '');
  if (node._src === html) return;
  node._src = html;
  node.className = 'notice' + (b.level === 'error' ? ' err' : '');
  node.innerHTML = html;
}

function fillMeta(node, item) {
  const m = item.meta || {};
  const parts = [];
  if (m.model) parts.push(m.model);
  if (m.durationMs != null) parts.push((m.durationMs / 1000).toFixed(1) + ' s');
  if (m.numTurns > 1) parts.push(m.numTurns + ' 次模型调用');
  if (m.costUsd != null && m.costUsd > 0) parts.push('$' + m.costUsd.toFixed(4));
  if (m.usage) parts.push('↑' + nfmt(m.usage.input_tokens) + ' ↓' + nfmt(m.usage.output_tokens));

  node.replaceChildren(document.createTextNode(parts.join(' · ')));
  if (item.status === 'error') {
    const w = el('span', 'err');
    w.textContent = m.errorText || '出错';
    node.append(document.createTextNode(' · '), w);
  } else if (item.status === 'interrupted') {
    const w = el('span', 'warn');
    w.textContent = '已中断';
    node.append(document.createTextNode(' · '), w);
  }
}

function paintAssistant(item, body, force) {
  const N = body._paint || (body._paint = { blocks: new Map(), dots: null, meta: null, acts: null, sig: '' });
  const visible = (item.blocks || []).filter(blockVisible);

  // 1) 逐块更新内容（没变的块会被 updateBlockNode 内部直接跳过）
  for (const b of visible) {
    let node = N.blocks.get(b.bid);
    if (!node) {
      node = createBlockNode(b);
      N.blocks.set(b.bid, node);
    }
    updateBlockNode(node, b);
  }

  // 2) 清掉不再显示的块（比如内容为空的 thinking）
  const alive = new Set(visible.map((b) => b.bid));
  for (const [bid, node] of Array.from(N.blocks)) {
    if (!alive.has(bid)) { node.remove(); N.blocks.delete(bid); }
  }

  // 3) 只有结构真的变了才重排 DOM，避免每帧搬运节点
  const last = visible[visible.length - 1];
  const wantDots = item.status === 'streaming' && !(last && last.kind === 'text' && last.text);
  const wantMeta = item.status !== 'streaming';
  const sig = visible.map((b) => b.bid).join(',') + '|' + item.status + '|' + wantDots + '|' + wantMeta
    + '|' + (state.showThinking ? 1 : 0) + '|' + (state.showToolOutput ? 1 : 0);
  if (sig === N.sig && !force) return;
  N.sig = sig;

  if (wantDots) {
    if (!N.dots) {
      N.dots = el('div', 'thinking-dots');
      N.dots.innerHTML = '<i></i><i></i><i></i>';
    }
  } else if (N.dots) { N.dots.remove(); N.dots = null; }

  if (wantMeta) {
    if (!N.meta) N.meta = el('div', 'meta-line');
    fillMeta(N.meta, item);
  } else if (N.meta) { N.meta.remove(); N.meta = null; }

  if (!N.acts) {
    N.acts = msgActions([{ label: '复制', onClick: () => copyText(assistantPlainText(item)) }]);
  }

  const seq = visible.map((b) => N.blocks.get(b.bid));
  if (N.dots) seq.push(N.dots);
  if (N.meta) seq.push(N.meta);
  seq.push(N.acts);

  // 从左到右逐个就位：已经在对的位置时 cur === node，直接跳过
  for (let i = 0; i < seq.length; i++) {
    const cur = body.childNodes[i];
    if (cur !== seq[i]) body.insertBefore(seq[i], cur || null);
  }
  while (body.childNodes.length > seq.length) body.removeChild(body.lastChild);
}

/* ------------------------------------------------------------------ 工具卡片 */

function toolIsOpen(b) {
  return state.expandedTools.has(b.bid) || (state.showToolOutput && b.status !== 'running');
}

function createToolNode(b) {
  const d = el('div', 'tool');
  const head = el('div', 'tool-head');
  head.innerHTML =
    '<svg class="ic"><use href="#' + toolIcon(b.name) + '"/></svg>' +
    '<span class="tool-name"></span>' +
    '<span class="tool-sum"></span>' +
    '<span class="tool-status"></span>' +
    '<svg class="ic chev"><use href="#i-chevron"/></svg>';
  head.onclick = () => {
    if (state.expandedTools.has(b.bid)) state.expandedTools.delete(b.bid);
    else state.expandedTools.add(b.bid);
    const item = state.items.find((it) => (it.blocks || []).some((x) => x.bid === b.bid));
    const node = head.parentElement;
    node._bodySig = null;                       // 强制重建展开/收起后的内容
    updateToolNode(node, b);
    if (item) schedulePaint(item.id);
  };
  d.appendChild(head);
  d._head = head;
  return d;
}

function updateToolNode(node, b) {
  const head = node._head;
  head.querySelector('.tool-name').textContent = b.name || 'tool';
  head.querySelector('.tool-sum').textContent = toolSummary(b).split('\n')[0].slice(0, 200);
  const icon = head.querySelector('use');
  if (icon) icon.setAttribute('href', '#' + toolIcon(b.name));

  const st = head.querySelector('.tool-status');
  st.className = 'tool-status ' + (b.status === 'running' ? 'running' : b.status === 'error' ? 'err' : 'ok');
  st.textContent = b.status === 'running' ? '执行中' : b.status === 'error' ? '失败' : '完成';

  // 正文可能很大，所以只在状态/长度/展开态变化时才重建
  const out = toolResultText(b);
  const open = toolIsOpen(b);
  const bodySig = b.status + '|' + out.length + '|' + open + '|' + (b.input ? 1 : 0);
  if (node._bodySig === bodySig) return;
  node._bodySig = bodySig;
  node.classList.toggle('open', open);
  const old = node.querySelector('.tool-body');
  if (old) old.remove();
  if (open) node.appendChild(toolBody(b));
}

function toolBody(b) {
  const bd = el('div', 'tool-body');
  const inp = b.input || {};
  const keys = Object.keys(inp).filter((k) => k !== 'command' && k !== 'file_path');
  if (keys.length) {
    const args = el('div', 'tool-args');
    for (const k of keys.slice(0, 6)) {
      const line = el('div');
      line.innerHTML = '<span class="k">' + window.Markdown.escapeHtml(k) + ':</span> ' +
        window.Markdown.escapeHtml(String(inp[k]).slice(0, 400));
      args.appendChild(line);
    }
    bd.appendChild(args);
  }
  if (!b.input && b.inputRaw) {
    // 参数还在流式拼装中
    const args = el('div', 'tool-args');
    args.innerHTML = '<span class="k">参数接收中…</span> ' + window.Markdown.escapeHtml(b.inputRaw.slice(0, 400));
    bd.appendChild(args);
  }
  const out = toolResultText(b);
  const pre = document.createElement('pre');
  pre.textContent = out
    ? out.slice(0, 20000) + (out.length > 20000 ? '\n… (已截断)' : '')
    : (b.status === 'running' ? '（执行中…）' : '（无输出）');
  bd.appendChild(pre);
  return bd;
}

// ============================================================ 线程渲染

function renderThread() {
  const thread = $('#thread');
  const has = state.items.length > 0;
  $('#welcome').hidden = has;

  // 整棵树要重建了，之前排队的增量重绘已无意义（节点都没了）
  paintPending.clear();

  const frag = document.createDocumentFragment();
  for (const it of state.items) frag.appendChild(renderItem(it));
  thread.replaceChildren(frag);
  requestAnimationFrame(() => {
    scrollToBottom(false);
    updateScrollBtn();
  });
}

function threadScrolledToBottom(slack = 90) {
  const w = $('#threadWrap');
  return w.scrollHeight - w.scrollTop - w.clientHeight < slack;
}

/**
 * 滚到底。
 *
 * 非平滑模式下必须让 behavior 真的是"立即" —— styles.css 里如果给
 * .thread-wrap 写了 scroll-behavior: smooth，那么 behavior:'auto' 会被解释成
 * "跟随 CSS"，于是这一步变成动画，长对话会停在半路（末条消息被输入框盖住）。
 * 所以这里显式用 'instant'，并且 CSS 里也不再声明 smooth。
 */
function scrollToBottom(smooth = true) {
  const w = $('#threadWrap');
  try {
    w.scrollTo({ top: w.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  } catch {
    w.scrollTop = w.scrollHeight;   // 老内核不认识 'instant' 时的兜底
  }
}

function updateScrollBtn() {
  $('#scrollBottom').classList.toggle('show', !threadScrolledToBottom(160));
}

// ---- 流式增量更新 ----

/** 把排队中的增量重绘触发出去（实际绘制在下一个动画帧） */
function schedulePaint(itemId) {
  if (paintPending.has(itemId)) return;
  paintPending.add(itemId);
  setTimeout(() => {
    requestAnimationFrame(() => {
      paintPending.delete(itemId);
      const body = document.querySelector('[data-body="' + itemId + '"]');
      const item = state.items.find((i) => i.id === itemId);
      if (!body || !item) return;
      const pinned = threadScrolledToBottom();
      paintAssistant(item, body);
      if (pinned) scrollToBottom(false);
      updateScrollBtn();
    });
  }, PAINT_INTERVAL_MS);
}

// ============================================================ 引擎事件归约

function currentAssistant() {
  const t = state.turn;
  if (!t) return null;
  return state.items.find((i) => i.id === t.itemId) || null;
}

function findToolBlock(item, toolUseId) {
  return (item.blocks || []).find((b) => b.kind === 'tool' && b.id === toolUseId);
}

/**
 * 「正在重试…」提示用**固定 bid**，这样每次重试都是原地改文字，
 * 而不是往下堆七八条一模一样的通知。这一轮结束后再把它摘掉。
 */
const RETRY_BID = 'retry-notice';

function dropRetryNotice(item) {
  if (!item || !item.blocks) return;
  const i = item.blocks.findIndex((b) => b.bid === RETRY_BID);
  if (i >= 0) item.blocks.splice(i, 1);
}

/**
 * ★ 把这一轮的所有"临时"提示摘掉，并把气泡收尾。
 *
 * 为什么必须做（2026-09-26 补）：'retry' 和 'error'/'result' 是**两条不同的
 * IPC 事件**，渲染进程处理它们之间必有一次 requestAnimationFrame 的间隙。
 * 如果这中间用户点了「停止生成」、或者切了模型/权限（那条路径会 recycleEngine
 * 把子进程杀掉，于是收尾事件永远不会来），
 * `dropRetryNotice` 就没机会执行 —— 屏幕上会永远挂着一句
 * 「接口返回 502 server_error，正在重试（第 7/10 次）…」，
 * 而按钮早已变回「发送」、状态栏也写着「就绪」。
 * 这正是冒烟日志里 `busy=false hasError=false` 那一瞬的样子：
 * 测试只是碰巧抓拍到了这一帧，但真用户点一次"停止"就能把它永久留在界面上。
 *
 * @param {object} item  目标助手气泡
 * @param {object} [opt]
 * @param {string} [opt.status]  收尾后的状态（'interrupted' / 'error' / 'done'）
 * @param {string} [opt.text]    要补上的收尾提示（如果 finalize 时还没人补）
 */
function settleTurn(item, opt = {}) {
  if (!item) return;
  const has = (t) => (item.blocks || []).some((b) => b.kind === 'notice' && b.level === t);
  // 粘住的重试提示：本轮已经不在生成中了，它就不该再挂在界面上。
  const wasRetrying = (item.blocks || []).some((b) => b.bid === RETRY_BID);
  dropRetryNotice(item);
  if (opt.text && !has(opt.status === 'error' ? 'error' : 'warn')) {
    /**
     * 只有「本来在重试」才补一句。普通的主动中断不该平白多出一条提示 ——
     * 气泡本身已经有"已中断"标记了。
     */
    if (wasRetrying) {
      item.blocks.push({
        kind: 'notice',
        bid: uid(),
        level: opt.status === 'error' ? 'error' : 'warn',
        text: opt.text,
      });
    }
  }
  if (item.status === 'streaming') item.status = opt.status || 'interrupted';
  if (!item.meta || !item.meta.model) {
    item.meta = { ...item.meta, model: state.engine.model };
  }
}

function onEngineEvent({ sessionId, ev }) {
  if (sessionId !== state.currentId) return;

  switch (ev.type) {
    case 'state':
      state.engine.alive = ev.state !== 'exited' && ev.state !== 'stopping';
      /**
       * ★ 这里**故意什么都不做**。
       *
       * 我原先在这里挂了一段"收到 idle 就把正在生成的气泡收尾"的逻辑，
       * 结果是灾难性的：`send()` 之后引擎本来就会先发一发 `state: idle`
       * （见 claude-engine.js 的 `system/init` 分支，那是设计如此），
       * 于是**每一轮刚开始就被判成"已中断"** —— 气泡 status 提前离开
       * streaming，紧接着真正的 `result` / `error` 事件到达时
       * `currentAssistant()` 已经对不上，整条收尾链路失效，
       * 界面只剩一句"已中断"，而且按钮卡在"停止"上发不出下一条。
       * （2026-09-26 实测：一改就挂了 16 项，日志里断点全是 "已中断"。）
       *
       * 结论：`idle` 不代表这一轮结束，它只代表引擎进程没在开关中。
       * 「临时提示会被粘住」这个问题，改由**确定的收尾事件**
       * （result / error / interrupted / exit）来清理 —— 见 settleTurn。
       */
      updateStatus();
      break;

    case 'spawn':
      state.engine.alive = true;
      state.engine.dead = false;
      updateStatus();
      break;

    case 'init':
      state.engine.model = ev.model;
      state.engine.sessionId = ev.sessionId;
      state.engine.ready = true;
      state.engine.dead = false;
      updateStatus();
      break;

    case 'turn': {
      const item = {
        id: uid(),
        kind: 'assistant',
        at: nowIso(),
        status: 'streaming',
        blocks: [],
        meta: {},
      };
      state.items.push(item);
      state.turn = { itemId: item.id, keyToBlock: new Map(), curTool: null, m: -1 };
      state.busy = true;
      // 交给 renderThread 会导致整页重排；只追加这一个节点
      $('#thread').appendChild(renderItem(item));
      $('#welcome').hidden = true;
      scrollToBottom(true);
      updateStatus();
      break;
    }

    case 'cycle': {
      const t = state.turn;
      if (!t) break;
      t.m = ev.m;
      t.curTool = null;
      break;
    }

    case 'block': {
      const t = state.turn;
      const item = currentAssistant();
      if (!t || !item) break;
      const key = ev.m + ':' + ev.i;

      if (ev.op === 'start') {
        const bid = uid();
        const type = ev.block.type;
        let block;
        if (type === 'text') {
          block = { kind: 'text', bid, text: '' };
          t.curTool = null;
        } else if (type === 'thinking') {
          block = { kind: 'thinking', bid, text: '' };
          t.curTool = null;
        } else if (type === 'tool_use') {
          block = { kind: 'tool', bid, id: ev.block.id, name: ev.block.name, input: null, inputRaw: '', status: 'running', result: null };
          t.curTool = block;
        } else {
          block = { kind: 'notice', bid, text: '未知内容块: ' + type };
        }
        t.keyToBlock.set(key, block);
        item.blocks.push(block);
        schedulePaint(item.id);
      } else if (ev.op === 'stop') {
        const block = t.keyToBlock.get(key);
        if (!block) break;
        if (block.kind === 'thinking') {
          // 空思考块直接丢掉，避免 UI 出现空折叠框
          if (!block.text || !block.text.trim()) {
            item.blocks = item.blocks.filter((b) => b !== block);
          }
        } else if (block.kind === 'tool' && ev.block.input) {
          block.input = ev.block.input;
        }
        schedulePaint(item.id);
      }
      break;
    }

    case 'delta': {
      const t = state.turn;
      const item = currentAssistant();
      if (!t || !item) break;
      const block = t.keyToBlock.get(ev.m + ':' + ev.i);
      if (!block) break;
      if (ev.kind === 'text' && block.kind === 'text') block.text += ev.text;
      else if (ev.kind === 'thinking' && block.kind === 'thinking') block.text += ev.text;
      else if (ev.kind === 'tool_json' && block.kind === 'tool') block.inputRaw += ev.text;
      else break;
      schedulePaint(item.id);
      break;
    }

    // 权威的完整消息：用它校正增量可能丢的内容
    case 'message': {
      const t = state.turn;
      const item = currentAssistant();
      if (!t || !item) break;
      const m = ev.m;
      (ev.content || []).forEach((cb, i) => {
        const key = m + ':' + i;
        let block = t.keyToBlock.get(key);
        if (!block) {
          const bid = uid();
          if (cb.type === 'text') block = { kind: 'text', bid, text: '' };
          else if (cb.type === 'thinking') block = { kind: 'thinking', bid, text: '' };
          else if (cb.type === 'tool_use') block = { kind: 'tool', bid, id: cb.id, name: cb.name, input: cb.input, inputRaw: '', status: 'running', result: null };
          else return;
          t.keyToBlock.set(key, block);
          item.blocks.push(block);
        }
        if (cb.type === 'text' && cb.text && block.text !== cb.text) block.text = cb.text;
        if (cb.type === 'thinking' && cb.thinking && block.text !== cb.thinking) block.text = cb.thinking;
        if (cb.type === 'tool_use') {
          block.input = cb.input || block.input;
          block.name = cb.name || block.name;
          block.id = cb.id || block.id;
        }
      });
      if (ev.usage) item.meta.usage = ev.usage;
      if (ev.model) item.meta.model = ev.model;
      schedulePaint(item.id);
      break;
    }

    case 'toolresult': {
      const item = currentAssistant();
      if (!item) break;
      const block = findToolBlock(item, ev.toolUseId);
      if (!block) break;
      block.status = ev.isError ? 'error' : 'ok';
      block.result = ev.content;
      schedulePaint(item.id);
      break;
    }

    case 'result': {
      const item = currentAssistant();
      if (item) {
        // 这一轮结束了（成功或失败），「正在重试…」就不该再挂着
        dropRetryNotice(item);
        item.status = ev.isError ? 'error' : 'done';
        item.meta = {
          ...item.meta,
          model: item.meta.model || state.engine.model,
          durationMs: ev.durationMs,
          numTurns: ev.numTurns,
          costUsd: ev.costUsd,
          usage: ev.usage || item.meta.usage,
        };
        if (ev.isError) {
          const errText = (ev.errors && ev.errors.join('\n')) || ev.subtype || '执行失败';
          item.meta.errorText = errText.slice(0, 300);
          item.blocks.push({ kind: 'notice', bid: uid(), level: 'error', text: errText });
        }
        if (ev.permissionDenials && ev.permissionDenials.length) {
          const names = ev.permissionDenials.map((d) => d.tool_name || d.tool || JSON.stringify(d)).join(', ');
          item.blocks.push({
            kind: 'notice', bid: uid(),
            html: '有 ' + ev.permissionDenials.length + ' 个操作因权限被拒绝：<code>' +
                  window.Markdown.escapeHtml(names) + '</code>。可在顶部切换权限模式后重试。',
          });
        }
      }
      state.busy = false;
      state.turn = null;
      updateStatus();
      renderThread();
      persist();
      break;
    }

    case 'interrupted': {
      const item = currentAssistant();
      /**
       * 走 settleTurn 而不是就地改两行：用户点「停止生成」时，本条气泡上
       * 很可能正挂着一条「正在重试（第 N/10 次）…」—— 那是 claude 自己
       * 在退避时留下的。不摘掉的话，界面会一边显示"已中断"、
       * 一边永远挂着"正在重试"，而按钮已经变回可发送。
       */
      settleTurn(item, { status: 'interrupted' });
      state.busy = false;
      state.turn = null;
      updateStatus();
      renderThread();
      persist();
      break;
    }

    /**
     * claude 自己在退避重试（401 / 429 / 5xx …）。
     *
     * 以前这类事件被静默丢掉，用户只能看到一个不动的「生成中」——
     * 实测令牌过期时要等**十分钟**才等到一句话。现在实时显示第几次重试、
     * 什么错误码；失败原因已经结束了就由 error 事件接手。
     */
    case 'retry': {
      const item = currentAssistant();
      if (!item) break;
      const label = ev.status == null ? (ev.error || '请求失败')
        : ev.status + (ev.error ? ' ' + ev.error : '');
      const text = '接口返回 ' + label + '，正在重试（第 ' + ev.attempt + '/' + ev.maxRetries + ' 次）…';
      let b = item.blocks.find((x) => x.bid === RETRY_BID);
      if (b) b.text = text;
      else item.blocks.push({ kind: 'notice', bid: RETRY_BID, level: 'warn', text });
      schedulePaint(item.id);
      break;
    }

    case 'error': {
      const item = currentAssistant();
      if (item) {
        dropRetryNotice(item);
        item.status = 'error';
        item.meta = { ...item.meta, errorText: ev.message.slice(0, 200) };
        item.blocks.push({ kind: 'notice', bid: uid(), level: 'error', text: ev.message });
        schedulePaint(item.id);
      } else {
        toast(ev.message.slice(0, 120), 5000);
      }
      state.busy = false;
      state.turn = null;
      updateStatus();
      persist();
      break;
    }

    case 'exit': {
      const item = currentAssistant();
      state.engine.alive = false;
      state.engine.ready = false;
      if (!ev.intentional) {
        state.engine.dead = true;      // 只有真的异常退出才标红
        const detail = ev.code === 0 ? '进程正常退出' : '进程异常退出（code=' + ev.code + '）';
        const tail = (ev.stderrTail || []).filter(Boolean).slice(-4).join('\n');
        const text = detail + (tail ? '\n' + tail : '');
        if (item) {
          item.status = item.status === 'streaming' ? 'error' : item.status;
          item.meta = { ...item.meta, errorText: detail };
          item.blocks.push({ kind: 'notice', bid: uid(), level: 'error', text });
          schedulePaint(item.id);
        } else {
          toast(detail, 4000);
        }
      } else if (item) {
        /**
         * ★ 「主动结束」（reason 是 retry-abort-* / watchdog-timeout /
         * interrupted / profile-activated …）这条路上，进程是被我们杀掉的，
         * `intentional` 为 true，所以上面整段都不执行 ——
         * 后果是气泡上那条「正在重试（第 N/10 次）…」永远留着。
         * 这就是冒烟日志里 `busy=false hasError=false` 那一帧的真相：
         * 引擎已经认输、进程已死，但界面还挂着"正在重试"。
         */
        settleTurn(item, {
          status: item.status === 'streaming' ? 'interrupted' : item.status,
        });
        schedulePaint(item.id);
      }
      state.busy = false;
      state.turn = null;
      updateStatus();
      persist();
      break;
    }

    case 'stderr':
      // claude 会往 stderr 打一些无害警告（例如 unrecognized_model），不该弹给用户
      break;

    default:
      break;
  }
}

// ============================================================ 状态栏

const PERM_LABEL = {
  acceptEdits: '接受编辑',
  auto: '自动',
  bypassPermissions: '跳过权限',
  manual: '手动确认',
  dontAsk: '不询问',
  plan: '计划模式',
};
const PERM_DESC = {
  acceptEdits: '文件编辑自动通过，其余需要确认的操作会被拒绝',
  auto: '由 Claude Code 自行判断哪些操作可以放行',
  bypassPermissions: '所有权限检查全部跳过（有风险，仅在你信任的目录里使用）',
  manual: '每一步都停下来等确认 —— 图形界面下没有确认通道，会全部被拒',
  dontAsk: '不弹任何询问，也不自动放行',
  plan: '只做分析和规划，不执行修改',
};

function updateStatus() {
  const chipPerm = $('#chipPerm');
  const dot = $('#permDot');
  $('#permLabel').textContent = PERM_LABEL[state.settings.permissionMode] || state.settings.permissionMode;

  const alive = state.engine.alive;
  const ready = state.engine.ready;
  // 「还没启动」是常态（第一次发消息时才拉进程），不该标红吓人；
  // 只有真的异常退出（dead）才用错误色。
  const dead = !!state.engine.dead;
  dot.className = 'dot ' + (state.busy ? 'busy' : dead ? 'err' : ready ? 'ok' : '');

  const model = state.engine.model || state.settings.model
    || (state.profiles && state.profiles.effectiveModel) || '默认模型';
  const prof = activeProfile();
  // 顶栏那个 chip 要一眼看出「用的哪家 + 哪个模型」，否则换完供应商看不出区别。
  // 没配置档案时不加前缀，保持「默认模型」这种简短文案。
  $('#modelLabel').textContent = prof ? (prof.name + ' · ' + model) : model;
  $('#chipModel').title = prof
    ? ('当前配置：' + prof.name + '（' + profileMetaText(prof, true) + '）\n模型：' + model + '\n点击切换')
    : '还没有配置档案，点击管理模型配置';

  const es = $('#engineState');
  es.className = 'engine-state' + (state.busy ? ' busy' : dead ? ' err' : '');
  // 注意：claude 只在收到第一条消息后才回 init，所以「已启动但未握手」是正常状态，
  // 不能显示成「启动中…」让用户以为卡住了。
  es.textContent = state.busy ? '生成中…'
    : dead ? '引擎异常退出'
    : !alive ? '引擎待命'
    : ready ? '引擎就绪'
    : '待命';

  $('#cwdLabel').textContent = state.settings.workspace || state.boot.workspace;

  const btn = $('#btnSend');
  btn.classList.toggle('stop', state.busy);
  btn.innerHTML = state.busy
    ? '<svg class="ic"><use href="#i-stop"/></svg>'
    : '<svg class="ic"><use href="#i-send"/></svg>';
  btn.title = state.busy ? '停止生成' : '发送';
  btn.disabled = !state.busy && !$('#input').value.trim();
  chipPerm.title = PERM_DESC[state.settings.permissionMode] || '';
}

// ============================================================ 发送

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;

  if (!state.currentId) await newSession();
  if (state.busy) return;

  state.items.push({ id: uid(), kind: 'user', at: nowIso(), text });
  input.value = '';
  autoGrow();
  $('#thread').appendChild(renderItem(state.items[state.items.length - 1]));
  $('#welcome').hidden = true;
  scrollToBottom(true);
  persist();
  updateStatus();

  try {
    await api.send(state.currentId, text);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    state.items.push({
      id: uid(), kind: 'assistant', at: nowIso(), status: 'error',
      blocks: [{ kind: 'notice', bid: uid(), level: 'error', text: msg }],
      meta: {},
    });
    renderThread();
    persist();
    toast('发送失败', 3000);
  }
}

async function stop() {
  const r = await api.interrupt();
  if (!r.ok) toast('没有正在进行的生成');
}

// ============================================================ 输入框

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  $('#btnSend').disabled = !state.busy && !ta.value.trim();
}

// ============================================================ 权限菜单

function openPermMenu(anchor) {
  closePopovers();
  const menu = document.createElement('div');
  menu.className = 'popover';
  for (const mode of state.boot.permissionModes) {
    const b = document.createElement('button');
    b.className = 'pop-item' + (mode === state.settings.permissionMode ? ' on' : '');
    b.innerHTML = '<b>' + PERM_LABEL[mode] + '</b><span>' + PERM_DESC[mode] + '</span>';
    b.onclick = async () => {
      closePopovers();
      const { settings } = await api.setSettings({ permissionMode: mode });
      state.settings = settings;
      state.engine.alive = false;
      state.engine.ready = false;
      updateStatus();
      toast('权限模式：' + PERM_LABEL[mode] + '（引擎已重置）');
    };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  positionPopover(menu, anchor);
}

function positionPopover(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12) + 'px';
}

function closePopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
}

// ============================================================ 设置

function openSettings() {
  const s = state.settings;
  $('#optThinking').checked = !!s.showThinking;
  $('#optToolOut').checked = !!s.showToolOutput;
  $('#inpModel').value = s.model || '';
  $('#inpExe').value = s.claudeExe || '';
  $('#inpCwd').value = s.workspace || state.boot.workspace;

  const sel = $('#selPerm');
  sel.replaceChildren(...state.boot.permissionModes.map((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = PERM_LABEL[m] + '（' + m + '）';
    o.selected = m === s.permissionMode;
    return o;
  }));
  $('#permNote').textContent = PERM_DESC[s.permissionMode] || '';

  document.querySelectorAll('#segTheme button').forEach((b) => {
    b.classList.toggle('on', b.dataset.value === (s.theme || 'dark'));
  });

  $('#exeNote').textContent = state.boot.claude.ok
    ? '当前使用：' + state.boot.claude.path
    : '未找到 claude 可执行文件，请手动指定路径。';

  renderProfiles();
  closeProfileEditor();

  $('#aboutVer').textContent = 'v' + state.boot.version;
  $('#aboutEle').textContent = state.boot.electron;
  $('#aboutClaude').textContent = state.boot.claude.ok ? state.boot.claude.source : '未找到';
  $('#aboutData').textContent = state.boot.dataDir;

  $('#modal').hidden = false;
}

async function saveSettings(patch) {
  const { settings } = await api.setSettings(patch);
  state.settings = settings;
  state.showThinking = settings.showThinking !== false;
  state.showToolOutput = !!settings.showToolOutput;
  applyTheme(settings.theme);
  updateStatus();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

// ============================================================ 技能管家

/**
 * 把 ~/.workbuddy/skills 下的技能做成「点一下就开关」的卡片。
 *
 * 和独立网页版的区别只有一处：**取数走 IPC 而不是 fetch**。
 * 因为 index.html 的 CSP 写了 `connect-src 'none'`，渲染进程根本发不出网络请求
 * —— 照搬「起本地 HTTP 服务 + 前端 fetch」那套会直接被 CSP 挡死。
 *
 * 状态模型（两个数组，顺序有意义：停用的排前面）：
 *   state.skills.disabled[]  ← skills-disabled/ 下的，即"已停用"
 *   state.skills.enabled[]   ← skills/ 下的，即"启用中"
 */

/**
 * 中文简介对照表：技能名 → 一句话中文说明。
 *
 * 为什么不在卡片上直接显示 SKILL.md 里的英文 description：
 * 那一段文字**是给模型做技能匹配用的**（trigger 条件、关键词都在里面），
 * 改它等于动技能被正确识别的概率 —— 为了"看着舒服"去动机能，不划算。
 * 所以这里只做**显示层**的翻译，原文一个字不动。
 *
 * 维护约定：
 *   · 键就是技能目录名，值是一句话（15~30 字），说清「这是什么 / 干什么用」。
 *   · 表里没有的技能自动回落显示原文英文 —— 新装的技能不会因此变空白。
 *   · 卡片上会标一个「中文」小徽章，让人知道这条是翻译过的。
 */
const SKILL_ZH = {
  // ---- 官方 skill（英文原文）----
  'academy-guide': '回答「Claude 怎么用」类问题时，推荐官方 Academy 的课程与教程',
  'algorithmic-art': '用 p5.js 生成算法艺术图（艺术图 / 流场 / 粒子系统）',
  'brand-guidelines': '套用 Anthropic 官方品牌色与字体到产物上',
  'canvas-design': '做海报 / 平面设计图，输出 PNG 与 PDF',
  'claude-api': 'Claude API / Anthropic SDK 参考：模型名、定价、流式、缓存、工具调用',
  'discernment-nudge': '给完建议或草稿后，追加 2-3 个追问，帮用户核查关键事实与假设',
  'doc-coauthoring': '陪用户一起写文档：收集背景 → 迭代打磨 → 读者视角验证',
  'frontend-design': '做前端界面时的视觉设计指导：配色、字体、排版，避免千篇一律',
  'internal-comms': '写内部沟通稿：进度报告、公司通讯、FAQ、事故通报',
  'mcp-builder': '开发 MCP 服务器（Python FastMCP 或 Node/TS SDK），接外部 API',
  'skill-creator': '创建 / 修改 / 优化 skill，并跑评测衡量效果',
  'slack-gif-creator': '做适合 Slack 的表情动图（GIF），含尺寸约束与校验工具',
  'theme-factory': '给产物套主题（幻灯片 / 文档 / 报告 / 网页落地页），10 套预设配色字体',
  'web-artifacts-builder': '做复杂网页产物（React + Tailwind + shadcn/ui），带状态与路由',
  'webapp-testing': '用 Playwright 测本地网页：验功能、调界面、截图、看控制台日志',

  // ---- 本机自建的（原文已经是中文，这里再给一句更短的收敛版）----
  'anthropic-skills-vendor': '从官方仓库挑选并下载 Agent Skills 到本机',
  'cdp-page-dump': '用 CDP 直连浏览器，抓 JS 渲染 / 虚拟滚动页面的完整文本',
  'claude-code-provider-switch': '给 Claude Code 外壳切供应商 / 模型，或排查换了没生效',
  'dsh-harness-repair': '诊断并修复 DeepSeek Harness（dsh / 星绒）启动故障',
  'electron-headless-ui-verify': '无 GUI 环境下验证 Electron 界面真的渲染了（冒烟 + 截图）',
  'electron-state-machine-regression': '改 Electron 状态机时，分清「自己改坏了」还是「测试脏了」',
  'html-to-docx-windows': '在 Windows 上跑通 tencent-docx 的 HTML→DOCX 转换',
  'local-web-control-panel': '做本机网页控制面板（点一下就启停 / 整理文件）',
  'msstore-app-download-windows': '下载 Microsoft Store 应用的离线安装包',
  'windows-cli-shim-on-path': '排查「某命令敲不出来」，并把新 CLI 接进 PATH',
  'windows-recycle-bin-without-com': '沙箱里把文件送进回收站（可还原），绕开被拦的 COM',
  'windows-shortcut-without-com': '沙箱里创建 Windows 快捷方式（.lnk），绕开被拦的 COM',
};

/** 取这个技能的中文简介；没有就返回空串（调用方回落到原文） */
function skillZh(name) {
  return SKILL_ZH[name] || '';
}

function skillsData() {
  return state.skills || { available: false, enabled: [], disabled: [] };
}

/** 停用区排最前 —— 用户点停用之后最想看到的就是它去了哪 */
function allSkillItems() {
  const d = skillsData();
  return (d.disabled || []).map((x) => ({ ...x, off: true }))
    .concat((d.enabled || []).map((x) => ({ ...x, off: false })));
}

function skillSelected() {
  return new Set([...document.querySelectorAll('#skGrid .sk-check:checked')]
    .map((c) => c.dataset.name));
}

function renderSkills() {
  const d = skillsData();
  const grid = $('#skGrid');
  const note = $('#skNote');
  const counts = $('#skCounts');

  const items = allSkillItems();
  const offN = (d.disabled || []).length;
  const onN = (d.enabled || []).length;

  counts.innerHTML = '';
  counts.append(bold(String(onN)), ' 个启用中');
  if (offN) counts.append(' · ', bold(String(offN)), ' 个已停用');

  $('#btnRestoreAll').hidden = offN === 0;
  // 只改文字节点，不重建整个按钮 —— HTML 里图标已经写好了，
  // 重建的话 svg/<use> 得手拼 innerHTML，没必要。
  if ($('#restoreAllLabel')) $('#restoreAllLabel').textContent = '全部恢复 (' + offN + ')';

  $('#btnOpenSkRoot').disabled = !d.available;
  // 停用区可能还不存在（从没停用过任何技能）—— 那就不给按钮，
  // 否则用户点一下拿到"目录不存在"，白挨一次困惑
  $('#btnOpenSkDisabled').hidden = !d.available || offN === 0;
  $('#skRootPath').textContent = d.skillsRoot || '';

  if (!d.available) {
    note.textContent = d.note || '还没找到技能目录。';
    grid.replaceChildren(el('div', 'sk-empty', d.note || '还没有技能目录。'));
    return;
  }
  note.innerHTML = '停用 = 把目录挪到<strong>停用区</strong>（<code>skills-disabled</code>），'
    + '文件一个都不删。想用的时候点一下就回来了。';

  if (!items.length) {
    const empty = el('div', 'sk-empty');
    empty.innerHTML = '技能目录是空的。<br>可以用「技能管家」旁边的下载器装一些，'
      + '或者直接把技能文件夹放进 <code>' + (d.skillsRoot || '') + '</code>。';
    grid.replaceChildren(empty);
    return;
  }

  grid.replaceChildren(...items.map(skillCard));
  syncSkillBulk();
}

/** 内部辅助：往计数行里塞一个加粗数字 */
function bold(t) {
  const b = document.createElement('b');
  b.textContent = t;
  return b;
}

function skillCard(item) {
  const card = el('div', 'sk-card' + (item.off ? ' off' : ''));

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'sk-check';
  cb.dataset.name = item.name;
  cb.title = '选中后可批量操作';
  cb.onchange = () => {
    card.classList.toggle('pick', cb.checked);
    syncSkillBulk();
  };
  card.append(cb);

  const main = el('div', 'sk-main');
  main.append(el('div', 'sk-name', item.name));

  /**
   * 简介分两层显示：
   *   · 有中文译名 → 中文当主文案（用户要看的），英文原文降为小字副文案。
   *   · 没有译名   → 只显示英文原文（新装的技能不会变空白）。
   * 原文不隐藏是有意的：万一看中文有歧义，还能对照一眼。
   */
  const zh = skillZh(item.name);
  if (zh) {
    main.append(el('div', 'sk-desc zh', zh));
    if (item.desc) main.append(el('div', 'sk-desc-en', item.desc));
  } else if (item.desc) {
    main.append(el('div', 'sk-desc', item.desc));
  }

  const tags = el('div', 'sk-tags');
  if (item.off) tags.append(el('span', 'sk-badge off', '已停用'));
  else tags.append(el('span', 'sk-badge', '启用中'));
  if (zh) {
    const t = el('span', 'sk-badge tr', '中文');
    t.title = '这条简介是中文翻译；英文原文在下方小字里';
    tags.append(t);
  }
  if (!item.hasSkillMd) {
    const t = el('span', 'sk-badge no', '无 SKILL.md');
    t.title = '这个目录里没有 SKILL.md，技能扫描器不会认它';
    tags.append(t);
  }
  if (typeof item.files === 'number') tags.append(el('span', 'sk-badge', item.files + ' 项'));
  main.append(tags);

  if (item.off) {
    // 明确告诉用户文件去哪了 —— 不说的话「停用」俩字听着像删除
    main.append(el('div', 'sk-hint', '⤴ 已挪到停用区，文件还在，点右边 ↺ 就能恢复。'));
  }
  card.append(main);

  const acts = el('div', 'sk-acts');
  const btn = el('button', 'sk-act' + (item.off ? '' : ' danger'));
  btn.title = item.off ? '恢复这个技能' : '停用这个技能（挪到停用区，不删除）';
  btn.innerHTML = '<svg class="ic"><use href="#' + (item.off ? 'i-undo' : 'i-power') + '"/></svg>';
  btn.onclick = (e) => { e.stopPropagation(); toggleSkill(item); };
  acts.append(btn);

  const rv = el('button', 'sk-act');
  rv.title = '在资源管理器中显示';
  rv.innerHTML = '<svg class="ic"><use href="#i-folder"/></svg>';
  rv.onclick = (e) => {
    e.stopPropagation();
    api.skills.reveal(item.name, item.off ? 'disabled' : 'skills');
  };
  acts.append(rv);

  card.append(acts);
  return card;
}

/** 单卡开关 */
async function toggleSkill(item) {
  const names = [item.name];
  if (item.off) {
    const r = await api.skills.enable(names);
    applySkillResult(r, '恢复');
  } else {
    if (!confirm('停用「' + item.name + '」？\n\n它会从技能目录挪到停用区，文件不会被删除，\n随时点「↺」就能恢复。')) return;
    const r = await api.skills.disable(names);
    applySkillResult(r, '停用');
  }
}

/** 批量操作（停用选中的启用项 / 恢复选中的停用项） */
async function bulkToggleSkills(toDisabled) {
  const names = toDisabled ? selectedToDisable() : selectedToEnable();
  if (!names.length) {
    toast(toDisabled ? '选中的都是已停用的技能，没什么可停用的' : '选中的都是启用中的技能，没什么可恢复的');
    return;
  }
  const verb = toDisabled ? '停用' : '恢复';
  if (!confirm(verb + '这 ' + names.length + ' 个技能？\n\n' + names.join('\n')
    + '\n\n' + (toDisabled ? '它们会被挪到停用区，文件不会删除。' : '它们会被挪回技能目录。'))) return;
  const r = toDisabled ? await api.skills.disable(names) : await api.skills.enable(names);
  applySkillResult(r, verb);
}

/** 把一次操作的结果落到界面上 */
function applySkillResult(r, verb) {
  const res = (r && r.results) || [];
  const bad = res.filter((x) => !x.ok);
  const skipped = res.filter((x) => x.ok && x.skipped);
  if (bad.length) {
    toast(verb + '失败：' + bad.length + ' 个 — ' + (bad[0].reason || ''), 4000);
  } else if (skipped.length) {
    toast(skipped.length + ' 个本来就已经是目标状态，没重复动它');
  } else {
    toast(verb + '成功：' + res.length + ' 个');
  }
  if (r && r.state) state.skills = r.state;
  renderSkills();
}

/**
 * 勾选状态一变，批量条跟着变。
 *
 * 两个按钮**按选中项的实际情况显示**，而不是常驻并排摆着：
 * 全选的是已停用的技能时，「停用选中」点了等于什么都没做（幂等会回一句
 * "本来就已停用"）—— 摆一个必然无效的按钮只会让人怀疑自己点错了。
 * 选中的既有启用又有停用时，两个都显示，各自只作用于对应那一半。
 */
function syncSkillBulk() {
  const sel = skillSelected();
  const n = sel.size;
  const bar = $('#skBulk');
  if (bar) bar.hidden = n === 0;
  const label = $('#skBulkN');
  if (label) label.textContent = String(n);
  if (!n) return;

  const items = allSkillItems().filter((x) => sel.has(x.name));
  const onSel = items.filter((x) => !x.off).length;   // 选中的启用项 → 可以停用
  const offSel = items.filter((x) => x.off).length;   // 选中的停用项 → 可以恢复
  const bd = $('#btnSkBulkDisable');
  const be = $('#btnSkBulkEnable');
  bd.hidden = onSel === 0;
  be.hidden = offSel === 0;
  bd.textContent = '停用选中' + (onSel !== items.length ? ' (' + onSel + ')' : '');
  be.textContent = '恢复选中' + (offSel !== items.length ? ' (' + offSel + ')' : '');
}

/** 勾选集合里只保留「启用中」的那些（用于批量停用） */
function selectedToDisable() {
  const sel = skillSelected();
  return allSkillItems().filter((x) => sel.has(x.name) && !x.off).map((x) => x.name);
}

/** 勾选集合里只保留「已停用」的那些（用于批量恢复） */
function selectedToEnable() {
  const sel = skillSelected();
  return allSkillItems().filter((x) => sel.has(x.name) && x.off).map((x) => x.name);
}

function openSkills() {
  $('#skillsModal').hidden = false;
  $('#skGrid').replaceChildren(el('div', 'sk-empty', '正在读取…'));
  api.skills.state().then((s) => {
    state.skills = s;
    renderSkills();
  }).catch((err) => {
    $('#skGrid').replaceChildren(el('div', 'sk-empty', '读取失败：' + String(err && err.message || err)));
  });
}

// ============================================================ 模型配置档案

/**
 * 这块等价于 cc-switch 的「供应商切换」。
 *
 * 关键设计（都是实测逼出来的，改之前先看 engine/profiles.js 顶部的注释）：
 *   · 切换靠 `--settings <临时文件>` + `--setting-sources project,local`，
 *     所以**不动用户全局的 ~/.claude/settings.json**；
 *   · 界面上的「模型」是档案之上的一层覆盖，留空即跟随档案；
 *   · 切档案时若覆盖的模型名在新档案里不存在，主进程会清掉它（不然必然报模型不存在）。
 */

const CATEGORY_LABEL = {
  official: 'Claude 官方',
  cn_official: '国内官方',
  aggregator: '聚合站',
  third_party: '第三方',
  custom: '自定义',
};

function profilesAvailable() {
  return !!(state.profiles && state.profiles.available);
}

function activeProfile() {
  const P = state.profiles;
  if (!P || !Array.isArray(P.items)) return null;
  return P.items.find((p) => p.id === P.activeId) || null;
}

/** 档案里有意义的模型名（去重）。用于「模型」子菜单和编辑表单的候选。 */
function profileModels(profile) {
  const env = (profile && profile.env) || {};
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  push(env.ANTHROPIC_MODEL);
  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  return out;
}

/**
 * 列表/菜单里那行摘要。
 * compact=true 用于顶栏菜单（宽度只有 400px，多一个字段就换行）；
 * 列表里可以多带一个「N 项变量」——它能一眼区分「完整配置」和「只填了半个」。
 * 「快速模型」刻意不显示：菜单里本来就有单独的「模型」子菜单列它，
 * 显示出来只会把这行挤成两行。
 */
function profileMetaText(p, compact) {
  const s = p.summary || {};
  const bits = [s.host || 'Claude 官方'];
  if (s.model) bits.push(s.model);
  if (s.tokenSet) bits.push(s.tokenHint);
  if (!compact) bits.push(s.envCount + ' 项变量');
  return bits.join(' · ');
}

function popHeader(text) { return el('div', 'pop-hd', text); }
function popNote(text) { const d = el('div', 'pop-note'); d.textContent = text; return d; }
function popSep() { return el('div', 'pop-sep'); }

/** 顶栏那个「配置 · 模型」菜单 */
function openModelMenu(anchor) {
  closePopovers();
  const menu = el('div', 'popover pop-model');
  const P = state.profiles;
  const active = activeProfile();

  // ---------------- 供应商 ----------------
  menu.appendChild(popHeader('供应商配置'));
  if (!profilesAvailable()) {
    menu.appendChild(popNote('配置档案存储不可用，当前沿用全局设置。'));
  } else if (!P.items.length) {
    menu.appendChild(popNote('还没有配置档案 —— 当前直接沿用你全局的 ~/.claude/settings.json。'));
  } else {
    for (const p of P.items) {
      const b = document.createElement('button');
      b.className = 'pop-item' + (p.id === P.activeId ? ' on' : '');
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = p.name;
      b.querySelector('span').textContent = profileMetaText(p, true);
      b.onclick = () => { closePopovers(); activateProfile(p.id); };
      menu.appendChild(b);
    }
  }

  // ---------------- 模型 ----------------
  menu.appendChild(popHeader('模型'));
  const override = (P && P.modelOverride) || '';
  // 注意：这里读的是**配置里生效的模型**，不是 engine.model
  // —— 后者是上一个会话握手时上报的，切完档案还没重开进程时是旧值，会误导。
  const configured = (active && active.summary && active.summary.model) || '';
  const follow = document.createElement('button');
  follow.className = 'pop-item' + (override ? '' : ' on');
  follow.innerHTML = '<b></b><span></span>';
  follow.querySelector('b').textContent = '跟随配置文件';
  follow.querySelector('span').textContent = configured ? ('使用 ' + configured) : '（档案里没写模型名）';
  follow.onclick = () => { closePopovers(); setModelOverride(''); };
  menu.appendChild(follow);

  for (const m of profileModels(active)) {
    const b = document.createElement('button');
    b.className = 'pop-item' + (override === m ? ' on' : '');
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = m;
    b.querySelector('span').textContent = (m === configured) ? '配置文件里的模型' : '来自当前配置';
    b.onclick = () => { closePopovers(); setModelOverride(m); };
    menu.appendChild(b);
  }

  // 自定义模型名：Electron 里 window.prompt 不可用，所以内联一个输入框
  const custom = el('div', 'pop-custom');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = '自定义模型名…';
  inp.value = override;
  inp.spellcheck = false;
  const go = el('button', 'btn sm', '应用');
  go.type = 'button';
  const apply = () => {
    const v = inp.value.trim();
    closePopovers();
    setModelOverride(v);
  };
  go.onclick = apply;
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    e.stopPropagation();
  };
  custom.append(inp, go);
  menu.appendChild(custom);

  menu.appendChild(popSep());

  const manage = document.createElement('button');
  manage.className = 'pop-item';
  manage.innerHTML = '<b>管理模型配置…</b><span>新增 / 编辑 / 测试 / 从 cc-switch 导入</span>';
  manage.onclick = () => {
    closePopovers();
    openSettings();
    const sec = $('#secProfiles');
    if (sec) sec.scrollIntoView({ block: 'start' });
  };
  menu.appendChild(manage);

  document.body.appendChild(menu);
  positionPopover(menu, anchor);
}

async function setModelOverride(model) {
  if (state.busy) { toast('正在生成中，先停止再换模型'); return; }
  const { settings } = await api.setSettings({ model: model || '' });
  state.settings = settings;
  state.engine = { alive: false, ready: false, model: null, sessionId: null };
  state.profiles = await api.profiles.state();
  updateStatus();
  if (!$('#modal').hidden) renderProfiles();
  toast(model ? ('模型已切换为 ' + model) : '模型已跟随配置档案');
}

async function activateProfile(id) {
  if (state.busy) { toast('正在生成中，先停止再切换'); return; }
  const r = await api.profiles.activate(id);
  if (!r.ok) { toast(r.reason || '切换失败'); return; }
  state.profiles = r.state || await api.profiles.state();
  if (r.modelOverride !== undefined) {
    state.settings = { ...state.settings, model: r.modelOverride };
  }
  state.engine = { alive: false, ready: false, model: null, sessionId: null };
  updateStatus();
  renderProfiles();
  const name = (r.profile && r.profile.name) || '配置';
  toast(r.overrideCleared ? ('已切到「' + name + '」，模型覆盖已清空') : ('已切到「' + name + '」'));
}

/** 设置弹层里的档案列表 */
function renderProfiles() {
  const list = $('#profList');
  const sub = $('#profilesSub');
  if (!list) return;
  const P = state.profiles;

  if (!profilesAvailable()) {
    sub.textContent = '';
    list.innerHTML = '<div class="prof-empty">配置档案存储不可用。</div>';
    return;
  }

  sub.textContent = P.items.length
    ? '共 ' + P.items.length + ' 条，当前：' + (P.activeName || '—')
    : '还没有配置';

  if (!P.items.length) {
    list.innerHTML = '<div class="prof-empty">还没有配置档案，当前直接沿用全局的 ' +
      '<code>~/.claude/settings.json</code>。<br>' +
      '点「从当前设置导入」可以把你正在用的配置收成一条，之后就能一键切换。</div>';
  } else {
    list.replaceChildren(...P.items.map(profRow));
  }

  $('#optSyncGlobal').checked = !!P.syncGlobal;
  const g = P.globalEnv || {};
  const active = activeProfile();
  const notes = [];
  notes.push(P.syncGlobal
    ? '已开启：切换配置时会同时改写全局配置（写入前自动备份，只替换 env 一个键）。'
    : '未开启：全局配置保持原样，只有本应用用所选配置。');
  if (g.host) {
    notes.push('当前全局配置指向 ' + g.host + (active && active.summary && active.summary.host
      && active.summary.host !== g.host ? '，与本应用所选配置不同 —— 这是正常的（未开启同步时互不影响）。' : '。'));
  }
  if (P.globalEnv && !g.host && !g.tokenSet) {
    notes.push('全局配置里没有自定义地址（走 Claude 官方登录态）。');
  }
  $('#syncNote').textContent = notes.join(' ');
}

function profRow(p) {
  const P = state.profiles;
  const row = el('div', 'prof-item' + (p.id === P.activeId ? ' on' : ''));
  row.dataset.id = p.id;

  const main = el('div', 'prof-main');
  const head = el('div', 'prof-head');
  const nm = el('b', null, p.name);
  head.appendChild(nm);
  if (p.id === P.activeId) head.appendChild(el('span', 'prof-badge on', '当前'));
  if (p.source === 'cc-switch') head.appendChild(el('span', 'prof-badge', 'cc-switch'));
  else if (p.source === 'claude-settings') head.appendChild(el('span', 'prof-badge', '全局设置'));
  else if (p.category && CATEGORY_LABEL[p.category]) head.appendChild(el('span', 'prof-badge', CATEGORY_LABEL[p.category]));
  main.appendChild(head);
  main.appendChild(el('div', 'prof-meta', profileMetaText(p)));

  const test = el('span', 'prof-test');
  main.appendChild(test);

  const acts = el('div', 'prof-acts');
  const mkBtn = (label, cls, fn) => {
    const b = el('button', 'btn sm' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  };
  acts.appendChild(mkBtn('测试', null, async (b) => {
    b.disabled = true;
    b.textContent = '测试中…';
    test.className = 'prof-test';
    test.textContent = '';
    try {
      const r = await api.profiles.test({ id: p.id });
      test.className = 'prof-test ' + (r.ok ? 'ok' : 'err');
      test.textContent = (r.skipped ? '跳过：' : r.ok ? '通过 · ' : '失败 · ') +
        (r.reason || '') + (r.ms != null ? '（' + r.ms + ' ms）' : '');
      toast(r.ok ? '连通性正常' : '配置不通，见下方说明', r.ok ? 2000 : 5000);
    } finally {
      b.disabled = false;
      b.textContent = '测试';
    }
  }));
  acts.appendChild(mkBtn(p.id === P.activeId ? '已启用' : '启用', p.id === P.activeId ? null : 'primary',
    // 已经是当前档案时不再重复激活 —— 那会白白把正在用的引擎杀掉重拉
    () => { if (p.id !== state.profiles.activeId) activateProfile(p.id); }));
  acts.appendChild(mkBtn('编辑', null, () => openProfileEditor(p.id)));
  acts.appendChild(mkBtn('删除', 'danger', async () => {
    if (!confirm('删除配置「' + p.name + '」？（不会影响你自己的 ~/.claude/settings.json）')) return;
    const r = await api.profiles.remove(p.id);
    state.profiles = r.state || await api.profiles.state();
    state.engine = { alive: false, ready: false, model: null, sessionId: null };
    updateStatus();
    renderProfiles();
    toast('已删除');
  }));

  row.append(main, acts);
  row.onclick = () => { if (p.id !== P.activeId) activateProfile(p.id); };
  return row;
}

/* ------------------------------------------------------------ 档案编辑器 */

let editingId = null;

function closeProfileEditor() {
  editingId = null;
  const box = $('#profEditor');
  box.hidden = true;
  box.replaceChildren();
}

function field(labelText, node, hint) {
  const f = el('div', 'field');
  f.appendChild(el('label', null, labelText));
  f.appendChild(node);
  if (hint) f.appendChild(el('div', 'field-hint', hint));
  return f;
}

function openProfileEditor(id) {
  editingId = id || null;
  // datalist 是上一次打开编辑器时挂进旧 DOM 的，会被 replaceChildren 一起丢掉。
  // 不重置这个引用，「获取可用模型」就会往里塞 option 却挂不到当前表单上。
  const modelListRef = { node: null };
  const box = $('#profEditor');
  const existing = id ? (state.profiles.items.find((x) => x.id === id) || null) : null;
  const s = (existing && existing.simple) || { baseUrl: '', token: '', apiKey: '', model: '', fastModel: '', extraEnv: {} };

  box.replaceChildren();

  const title = el('h4', null, existing ? ('编辑「' + existing.name + '」') : '新增配置');
  box.appendChild(title);

  // 预设：点一下填好地址与模型，剩下只要贴令牌
  const presets = el('div', 'preset-row');
  for (const pr of (state.profiles.presets || [])) {
    const b = el('button', 'btn sm', pr.name);
    b.type = 'button';
    b.title = pr.note || (pr.baseUrl || '不覆盖任何环境变量');
    b.onclick = () => {
      if (!existing) $fName.value = pr.name;
      $fUrl.value = pr.baseUrl || '';
      $fModel.value = pr.model || '';
      $fFast.value = pr.fastModel || '';
      $fCat.value = pr.category || 'custom';
      toast('已填入预设：' + pr.name + (pr.baseUrl ? '，补上令牌即可' : ''));
    };
    presets.appendChild(b);
  }
  box.appendChild(field('预设', presets, '预设只填地址和模型名，令牌请自己粘贴 —— 我不替你编任何地址。'));

  const $fName = document.createElement('input');
  $fName.type = 'text'; $fName.placeholder = '例如 DeepSeek'; $fName.value = existing ? existing.name : '';
  box.appendChild(field('名称', $fName));

  const $fCat = document.createElement('select');
  for (const [v, t] of Object.entries(CATEGORY_LABEL)) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    $fCat.appendChild(o);
  }
  $fCat.value = (existing && existing.category) || 'custom';
  box.appendChild(field('类别', $fCat));

  const $fUrl = document.createElement('input');
  $fUrl.type = 'text'; $fUrl.placeholder = 'https://api.deepseek.com/anthropic';
  $fUrl.value = s.baseUrl || ''; $fUrl.spellcheck = false;
  box.appendChild(field('API 地址', $fUrl, '对应 ANTHROPIC_BASE_URL。留空 = 不覆盖，走 Claude 官方。'));

  const $fTok = document.createElement('input');
  $fTok.type = 'password'; $fTok.placeholder = 'sk-…';
  $fTok.value = s.token || s.apiKey || ''; $fTok.spellcheck = false;
  const tokRow = el('div', 'path-row');
  const eye = el('button', 'btn sm', '显示');
  eye.type = 'button';
  eye.onclick = () => {
    const showing = $fTok.type === 'text';
    $fTok.type = showing ? 'password' : 'text';
    eye.textContent = showing ? '显示' : '隐藏';
  };
  tokRow.append($fTok, eye);
  box.appendChild(field('API 令牌', tokRow, '对应 ANTHROPIC_AUTH_TOKEN，存在本机应用数据目录里，不会上传到任何地方。'));

  const $fModel = document.createElement('input');
  $fModel.type = 'text'; $fModel.placeholder = '例如 deepseek-flash';
  $fModel.value = s.model || ''; $fModel.spellcheck = false;
  const modelRow = el('div', 'path-row');
  const probe = el('button', 'btn sm', '获取可用模型');
  probe.type = 'button';
  probe.onclick = async () => {
    probe.disabled = true;
    probe.textContent = '查询中…';
    try {
      const r = await api.profiles.models({ env: buildEnvFromForm() });
      if (r.models && r.models.length) {
        // datalist 让用户从真实列表里选，而不是我编几个名字让他猜
        if (!modelListRef.node) {
          modelListRef.node = document.createElement('datalist');
          modelListRef.node.id = 'dlModels';
          box.appendChild(modelListRef.node);
        }
        modelListRef.node.replaceChildren(...r.models.map((m) => {
          const o = document.createElement('option'); o.value = m; return o;
        }));
        $fModel.setAttribute('list', 'dlModels');
        toast('拿到 ' + r.models.length + ' 个模型名（输入框里可以直接选）');
      } else {
        toast(r.reason || '该端点不提供模型列表，手填模型名即可', 4000);
      }
    } catch (e) {
      toast('查询失败：' + String(e && e.message || e), 4000);
    } finally {
      probe.disabled = false;
      probe.textContent = '获取可用模型';
    }
  };
  modelRow.append($fModel, probe);
  box.appendChild(field('主模型', modelRow, '对应 ANTHROPIC_MODEL。会同时写进 opus / sonnet 两个槽位，避免出现半套映射。'));

  const $fFast = document.createElement('input');
  $fFast.type = 'text'; $fFast.placeholder = '留空 = 跟随主模型';
  $fFast.value = s.fastModel || ''; $fFast.spellcheck = false;
  box.appendChild(field('快速模型', $fFast, '对应 HAIKU / FABLE / 子代理。留空就用主模型顶上。'));

  const $fSite = document.createElement('input');
  $fSite.type = 'text'; $fSite.placeholder = 'https://…（可选）';
  $fSite.value = existing ? (existing.websiteUrl || '') : ''; $fSite.spellcheck = false;
  box.appendChild(field('官网', $fSite));

  // 高级：附加环境变量（导入 cc-switch 时可能带进来一些我们没建模的键）
  const det = document.createElement('details');
  det.className = 'adv';
  const sum = document.createElement('summary');
  sum.textContent = '附加环境变量（高级）';
  det.appendChild(sum);
  const $fExtra = document.createElement('textarea');
  $fExtra.rows = 4; $fExtra.spellcheck = false;
  $fExtra.placeholder = '{"OTHER_KEY": "value"}';
  $fExtra.value = Object.keys(s.extraEnv || {}).length ? JSON.stringify(s.extraEnv, null, 2) : '';
  det.appendChild($fExtra);
  det.appendChild(el('div', 'field-hint',
    '档案里除地址/令牌/模型之外的键会原样保留在这里。从 cc-switch 导入时不会丢任何键。' +
    '这里的内容会在最后合并，所以也能用来强行覆盖上面任何一个键（例如某个槽位单独指定模型）。'));
  if (existing) {
    const keys = Object.keys(existing.env || {}).sort();
    det.appendChild(el('div', 'field-hint mono', '当前档案共 ' + keys.length + ' 个键：' + keys.join(', ')));
  }
  box.appendChild(det);

  const err = el('div', 'prof-test err');
  const btns = el('div', 'prof-actions');
  // 语义要分清：编辑已有档案时「保存」= 只改不切换，
  // 否则用户想改个备注，结果当前供应商被换掉了。
  const $btnSave = el('button', 'btn primary', existing ? '保存' : '保存并启用');
  $btnSave.type = 'button';
  const $btnSaveOnly = el('button', 'btn', existing ? '保存并启用' : '仅保存');
  $btnSaveOnly.type = 'button';
  const $btnTest = el('button', 'btn', '测试连接');
  $btnTest.type = 'button';
  // 结果那一行在按钮下面，用户在长表单里点完很可能看不到 —— 让它自己滚进视野
  const showTestResult = (cls, text) => {
    err.hidden = false;
    err.className = 'prof-test ' + cls;
    err.textContent = text;
    try { err.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  };
  const $btnCancel = el('button', 'btn', '取消');
  $btnCancel.type = 'button';
  $btnCancel.onclick = closeProfileEditor;
  btns.append($btnSave, $btnSaveOnly, $btnTest, $btnCancel);
  box.append(err, btns);
  err.hidden = true;

  // 把表单读成一个 env（测试和保存共用同一套逻辑，避免"存下去的和测的不是一回事"）
  function buildEnvFromForm() {
    const extraRaw = $fExtra.value.trim();
    let extraEnv = {};
    if (extraRaw) {
      try { extraEnv = JSON.parse(extraRaw) || {}; }
      catch { throw new Error('附加环境变量不是合法 JSON'); }
    }
    const main = $fModel.value.trim();
    // ★ 快速模型留空时**跟随主模型**，而不是干脆不写。
    // 不写的话，子代理 / 小模型槽位会退回 Claude 官方的默认名字（claude-haiku-*），
    // 在第三方端点上就是一个必然的 "model not found" —— 而且是只在触发子代理时才炸，
    // 最难查的那一类。
    const fast = $fFast.value.trim() || main;
    const env = {
      ANTHROPIC_BASE_URL: $fUrl.value.trim(),
      ANTHROPIC_AUTH_TOKEN: $fTok.value.trim(),
      ANTHROPIC_MODEL: main,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
      ANTHROPIC_DEFAULT_FABLE_MODEL: fast,
      ANTHROPIC_DEFAULT_OPUS_MODEL: main,
      ANTHROPIC_DEFAULT_SONNET_MODEL: main,
      CLAUDE_CODE_SUBAGENT_MODEL: fast,
      // *_MODEL_NAME 是显示别名。带上是为了跟 cc-switch 写出来的形状一致
      // （少了它们，切回 cc-switch 或 IDE 扩展里看到的模型名会空一截）。
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: fast,
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: fast,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: main,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: main,
    };
    // ★ 附加环境变量放在**最后**合并：它因此是万能兜底 ——
    // 任何上面这些键（比如某个槽位要单独指定模型）都能在这里强行覆盖。
    for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
    return env;
  }

  function payload() {
    return {
      id: existing ? existing.id : undefined,
      name: $fName.value.trim() || ($fModel.value.trim() || '未命名配置'),
      category: $fCat.value,
      websiteUrl: $fSite.value.trim(),
      notes: existing ? existing.notes : '',
      // 用 env 而不是 simple：这样「附加环境变量」里的键以及 opus/sonnet 等槽位
      // 能完整保留，也避免 envFromSimple 把用户手填的 fastModel 覆盖掉。
      env: buildEnvFromForm(),
    };
  }

  $btnTest.onclick = async () => {
    err.hidden = true;
    $btnTest.disabled = true;
    $btnTest.textContent = '测试中…';
    try {
      const r = await api.profiles.test({ env: buildEnvFromForm() });
      showTestResult(r.ok ? 'ok' : 'err',
        (r.skipped ? '跳过：' : r.ok ? '通过 · ' : '失败 · ') +
        (r.reason || '') + (r.ms != null ? '（' + r.ms + ' ms）' : '') +
        (r.url ? '  ' + r.url : '') +
        // 状态码翻成人话（404 到底是地址错还是模型错，差别很大）
        (r.hint ? '\n' + r.hint : ''));
    } catch (e) {
      showTestResult('err', String((e && e.message) || e));
    } finally {
      $btnTest.disabled = false;
      $btnTest.textContent = '测试连接';
    }
  };

  const doSave = async (activate) => {
    err.hidden = true;
    let p;
    try { p = payload(); }
    catch (e) { showTestResult('err', String(e.message || e)); return; }
    const r = await api.profiles.save({ ...p, activate });
    if (!r.ok) { showTestResult('err', r.reason || '保存失败'); return; }
    state.profiles = r.state || await api.profiles.state();
    if (activate) {
      state.engine = { alive: false, ready: false, model: null, sessionId: null };
      state.settings = { ...state.settings, model: '' };
    }
    updateStatus();
    closeProfileEditor();
    renderProfiles();
    toast(activate ? ('已保存并启用「' + r.profile.name + '」') : ('已保存「' + r.profile.name + '」'));
  };
  // ★ 注意 activate 的取值：
  //   新增 → 「保存并启用」才切过去；编辑 → 「保存」只改不切，另一个按钮才切。
  $btnSave.onclick = () => doSave(!existing);
  $btnSaveOnly.onclick = () => doSave(!!existing);

  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
  $fName.focus();
}

async function importFromCcSwitch() {
  const r = await api.profiles.importCcSwitch({ makeActive: false });
  if (!r.ok) { toast(r.reason || '导入失败', 5000); return; }
  state.profiles = r.state || await api.profiles.state();
  renderProfiles();
  toast(r.added ? ('已导入 ' + r.added + ' 条配置') : '没有新的配置可导入（已存在）');
}

async function importFromGlobal() {
  const r = await api.profiles.importGlobal();
  if (!r.ok) { toast(r.reason || '导入失败', 5000); return; }
  state.profiles = r.state || await api.profiles.state();
  renderProfiles();
  toast('已把当前 ~/.claude/settings.json 的配置收成一条档案');
}

// ============================================================ 初始化

const SUGGESTIONS = [
  { icon: 'i-folder', title: '看看当前目录', body: '读取工作目录结构，给我一个项目概览和文件职责说明' },
  { icon: 'i-code', title: '解释一段代码', body: '我把代码贴进来，你逐段说明它在做什么、有没有隐患' },
  { icon: 'i-terminal', title: '排查一个报错', body: '我遇到了报错，帮我定位根因并给出修改方案' },
  { icon: 'i-file', title: '写点东西', body: '帮我为这个目录写一份 README，包含安装、用法和目录说明' },
];

function renderSuggestions() {
  const box = $('#suggest');
  box.replaceChildren(...SUGGESTIONS.map((s) => {
    const d = el('div', 'sg');
    d.innerHTML = '<svg class="ic"><use href="#' + s.icon + '"/></svg><b></b><span></span>';
    d.querySelector('b').textContent = s.title;
    d.querySelector('span').textContent = s.body;
    d.onclick = () => {
      $('#input').value = s.body;
      autoGrow();
      $('#input').focus();
    };
    return d;
  }));
}

function bindUi() {
  $('#btnSend').onclick = () => (state.busy ? stop() : send());

  const ta = $('#input');
  ta.addEventListener('input', autoGrow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  $('#btnNew').onclick = () => newSession();
  $('#btnCollapse').onclick = () => $('#app').classList.add('collapsed');
  $('#btnExpand').onclick = () => $('#app').classList.remove('collapsed');
  $('#searchInput').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderSidebar();
  });

  $('#chipPerm').onclick = (e) => {
    e.stopPropagation();
    if (document.querySelector('.popover')) closePopovers();
    else openPermMenu($('#chipPerm'));
  };
  // 顶栏的模型 chip 现在开「配置 + 模型」菜单（以前是直接开设置，那样换供应商要点好几层）
  $('#chipModel').onclick = (e) => {
    e.stopPropagation();
    if (document.querySelector('.popover')) closePopovers();
    else openModelMenu($('#chipModel'));
  };

  $('#chipCwd').onclick = () => api.openPath(state.settings.workspace || state.boot.workspace);
  $('#chipCwd').oncontextmenu = (e) => {
    e.preventDefault();
    api.showItem(state.settings.workspace || state.boot.workspace);
  };

  $('#btnSettings').onclick = openSettings;
  $('#btnMemory').onclick = async () => {
    const r = await api.openMemory();
    if (!r.ok) toast(r.note || '没有找到记忆目录', 3000);
  };

  // ---- 技能管家 ----
  $('#btnSkills').onclick = openSkills;
  $('#btnCloseSkills').onclick = () => { $('#skillsModal').hidden = true; };
  $('#skillsModal').onclick = (e) => { if (e.target.id === 'skillsModal') $('#skillsModal').hidden = true; };
  $('#btnSkRefresh').onclick = () => openSkills();
  $('#btnRestoreAll').onclick = async () => {
    const names = (skillsData().disabled || []).map((x) => x.name);
    if (!names.length) { toast('没有已停用的技能'); return; }
    if (!confirm('恢复全部 ' + names.length + ' 个已停用的技能？')) return;
    const r = await api.skills.enable(names);
    applySkillResult(r, '恢复');
  };
  $('#btnSkBulkDisable').onclick = () => bulkToggleSkills(true);
  $('#btnSkBulkEnable').onclick = () => bulkToggleSkills(false);
  $('#btnSkBulkClear').onclick = () => {
    document.querySelectorAll('#skGrid .sk-check').forEach((c) => { c.checked = false; });
    document.querySelectorAll('#skGrid .sk-card').forEach((c) => c.classList.remove('pick'));
    syncSkillBulk();
  };
  $('#btnOpenSkRoot').onclick = () => api.skills.openRoot('skills');
  $('#btnOpenSkDisabled').onclick = () => api.skills.openRoot('disabled');

  $('#btnCloseModal').onclick = () => { $('#modal').hidden = true; };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; };

  $('#segTheme').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#segTheme button').forEach((x) => x.classList.toggle('on', x === b));
    saveSettings({ theme: b.dataset.value });
  };
  $('#optThinking').onchange = (e) => saveSettings({ showThinking: e.target.checked }).then(() => {
    state.items.forEach((it) => { if (it.kind === 'assistant') { const b = document.querySelector('[data-body="' + it.id + '"]'); if (b) paintAssistant(it, b); } });
  });
  $('#optToolOut').onchange = (e) => saveSettings({ showToolOutput: e.target.checked }).then(renderThread);
  $('#selPerm').onchange = async (e) => {
    await saveSettings({ permissionMode: e.target.value });
    $('#permNote').textContent = PERM_DESC[e.target.value] || '';
    state.engine.alive = false;
    state.engine.ready = false;
    updateStatus();
  };
  $('#inpModel').onchange = (e) => saveSettings({ model: e.target.value.trim() });
  $('#btnPickExe').onclick = async () => {
    const f = await api.pickFile({
      title: '选择 claude 可执行文件',
      filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (!f) return;
    $('#inpExe').value = f;
    await saveSettings({ claudeExe: f });
    state.boot.claude = { ok: true, path: f, source: 'settings' };
    $('#exeNote').textContent = '当前使用：' + f;
    toast('已指定 claude 路径，引擎已重置');
  };
  $('#inpExe').onchange = (e) => saveSettings({ claudeExe: e.target.value.trim() });
  $('#btnPickCwd').onclick = async () => {
    const dir = await api.pickDir();
    if (!dir) return;
    $('#inpCwd').value = dir;
    await saveSettings({ workspace: dir });
    await newSession(dir);
    $('#modal').hidden = true;
  };
  $('#btnOpenData').onclick = () => api.openPath(state.boot.dataDir);

  // ---- 模型配置档案 ----
  $('#btnProfAdd').onclick = () => openProfileEditor(null);
  $('#btnProfImportCc').onclick = importFromCcSwitch;
  $('#btnProfImportGlobal').onclick = importFromGlobal;
  $('#optSyncGlobal').onchange = async (e) => {
    const on = e.target.checked;
    if (on && !confirm(
      '开启后，每次切换配置都会改写你的全局 ~/.claude/settings.json，\n' +
      '让 VS Code / Trae 等编辑器里的 Claude Code 扩展也跟着换供应商。\n\n' +
      '写入前会自动备份（只替换 env 这一个键，其它设置原样保留）。\n\n确定开启吗？'
    )) { e.target.checked = false; return; }
    const r = await api.profiles.setSyncGlobal(on);
    state.profiles = await api.profiles.state();
    renderProfiles();
    toast(on ? '已开启：切换时会同步写入全局配置' : '已关闭：只影响本应用');
  };

  $('#scrollBottom').onclick = () => scrollToBottom(true);
  $('#threadWrap').addEventListener('scroll', updateScrollBtn);

  document.addEventListener('click', () => closePopovers());
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (document.querySelector('.popover')) closePopovers();
      else if (!$('#skillsModal').hidden) $('#skillsModal').hidden = true;
      else if (!$('#modal').hidden) $('#modal').hidden = true;
      else if (state.busy) stop();
    }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#app').classList.toggle('collapsed'); }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchInput').focus(); }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // 代码块复制
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-code]');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code');
    copyText(code.textContent);
  });
}

async function boot() {
  state.boot = await api.boot();
  state.settings = state.boot.settings;
  state.profiles = state.boot.profiles || null;
  state.sessions = state.boot.sessions || [];
  state.showThinking = state.settings.showThinking !== false;
  state.showToolOutput = !!state.settings.showToolOutput;

  applyTheme(state.settings.theme);
  renderSuggestions();
  bindUi();
  renderSidebar();
  renderThread();
  updateStatus();

  api.onEngineEvent(onEngineEvent);
  api.onSettingsChanged((s) => { state.settings = s; applyTheme(s.theme); updateStatus(); });
  api.onProfilesChanged((p) => {
    state.profiles = p;
    // 切档案时主进程会把引擎回收掉，但那条路径**不经过**渲染进程的回调，
    // 所以 state.engine.model 会停在上一个会话握手时的旧模型名上 ——
    // 顶栏就会显示「新供应商 · 旧模型」，看着像切换没生效。
    // 用主进程给的 engineRunning 判定，引擎没了就把状态清干净。
    if (!p.engineRunning) {
      state.engine = { alive: false, ready: false, model: null, sessionId: null };
    }
    updateStatus();
    if (!$('#modal').hidden) renderProfiles();
  });

  if (state.sessions.length) {
    await selectSession(state.sessions[0].id);
  } else {
    await newSession();
  }

  // ★ 这条提示必须放在「选定/新建对话之后」。
  // 早先写在前面，紧接着 selectSession/newSession 里的 state.items = [...] 就把它清掉了，
  // 等于白写 —— 用户看不到任何提示，只会觉得「发消息没反应」。
  if (!state.boot.claude.ok) {
    state.items.push({
      id: uid(), kind: 'assistant', at: nowIso(), status: 'error', meta: {},
      blocks: [{
        kind: 'notice', bid: uid(), level: 'error',
        html: '没有找到 <code>claude</code> 可执行文件。已查找 VS Code / Cursor / Trae 的扩展目录；' +
              '可在「设置 → 引擎 → claude 可执行文件」里点“浏览”指定完整路径。',
      }],
    });
    renderThread();
    persist();
  }

  $('#input').focus();
}

boot().catch((err) => {
  document.body.innerHTML = '<pre style="padding:24px;color:#f87171;font:13px/1.6 monospace">启动失败:\n' +
    String(err && err.stack || err) + '</pre>';
});

})();
