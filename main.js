'use strict';
/**
 * Claude Desktop — Electron 主进程
 *
 * 职责：
 *   1. 开窗（无边框 + 系统窗口控件覆盖，像 ChatGPT 桌面版那样）
 *   2. 每个对话托管一个常驻 claude 子进程（切走即回收，回来用 --resume 接上）
 *   3. 把引擎事件转发给渲染进程；把对话内容落盘
 *
 * 渲染进程不做任何 Node 操作，全部走 preload 暴露的窄接口。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeEngine, PERMISSION_MODES } = require('./engine/claude-engine');
const { SessionStore } = require('./engine/session-store');
const { resolveClaude, listCandidates } = require('./engine/find-claude');
const profilesLib = require('./engine/profiles');
const {
  ProfilesStore, envFromSimple, simpleFromEnv, describeEnv,
  importFromCcSwitch, importFromGlobal, testProfile, listModels, claudeSettingsPath,
} = profilesLib;

const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke');
/**
 * --shot：把窗口渲染的样子抓成 PNG。
 *
 * 加这个是因为「布局像不像 ChatGPT」光靠 DOM 断言证明不了 —— 断言只能说
 * 元素在不在、圆角够不够大。真正要看的间距、对齐、配色，得看图像。
 * 沙箱里我点不了 GUI，但 capturePage 可以在**不弹窗**的情况下抓到位图
 * （窗口 hidden 时默认仍会绘制，paintWhenInitiallyHidden）。
 */
const SHOT = process.argv.includes('--shot');

/**
 * 无 GPU 环境（沙箱、远程会话、虚拟机）下 Electron 的 GPU 进程会直接崩：
 *   GPU process exited unexpectedly: exit_code=-1073741819
 *   FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
 * 所以给一个显式开关，仅在「冒烟测试 / 明确要求 / 设了环境变量」时关掉硬件加速，
 * 你正常双击启动时仍然走 GPU 加速，滚动和动画不受影响。
 */
const NO_GPU = SMOKE || SHOT
  || process.argv.includes('--disable-gpu')
  || process.env.CLAUDE_DESKTOP_DISABLE_GPU === '1';
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  // 受限环境下连 GPU **子进程**都拉不起来（0xC0000005 访问违例，反复重启后
  // FATAL: GPU process isn't usable）。in-process-gpu 让 GPU 逻辑跑在主进程里，
  // 不再派生那个注定失败的子进程。
  app.commandLine.appendSwitch('in-process-gpu');
  // 冒烟模式额外关掉 Chromium 自己的沙箱：WorkBuddy 的沙箱与它嵌套后
  // 子进程创建会被拒。正常启动不受影响。
  app.commandLine.appendSwitch('no-sandbox');
  console.log('[claude] GPU disabled (smoke/headless mode)');
}

/**
 * --smoke 必须跑在一个**一次性**的配置目录里，而不是用户真实的数据目录。
 *
 * 这是实测踩出来的，不是洁癖：
 *   1) 渲染进程的 boot() 逻辑是「有历史对话就选中最近一条」。用真实目录跑冒烟时，
 *      上一轮冒烟写下的对话会被选中 —— 界面一打开就是"有消息"的状态，
 *      于是「空对话时显示欢迎页」这条断言永远为假。它报的是测试环境的账，
 *      不是应用的 bug，可我第一眼会当成 bug 去查，白花时间。
 *   2) 冒烟产生的测试对话会混进用户真实的侧边栏（实测已经躺了 2 条，
 *      标题还是冒烟的提示词「回复两个字：收到」）。
 *   3) 顺带解决单实例锁：冒烟用独立 userData 后，用户正开着应用也能跑冒烟
 *      （否则 requestSingleInstanceLock 直接让冒烟进程自杀）。
 *
 * 必须在 requestSingleInstanceLock() 之前设置，否则锁和 store 都还指着旧目录。
 */
if (SMOKE || SHOT) {
  const dir = process.env.CLAUDE_DESKTOP_SMOKE_DIR
    || path.join(os.tmpdir(), SHOT ? 'claude-desktop-shot' : 'claude-desktop-smoke');
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    console.log('[claude] smoke profile: ' + dir);
  } catch (err) {
    // 清不掉就退回真实目录继续跑 —— 冒烟失败也不该把测试本身搞挂
    console.log('[claude] smoke profile 准备失败（退回真实目录）: ' + err.message);
  }
}

let win = null;
let store = null;
let settings = null;
let settingsFile = null;
let profiles = null;          // 模型配置档案（供应商切换，等价 cc-switch）
let engine = null;            // 当前活动对话的引擎
let engineSessionId = null;   // 该引擎属于哪个对话

// ------------------------------------------------------------------ settings

const DEFAULT_SETTINGS = {
  theme: 'dark',
  permissionMode: 'acceptEdits',
  // 空 = 跟随当前「模型配置档案」里写的模型。
  // 填了 = 在这一层再盖一个模型名（档案仍决定地址/令牌），用于临时换模型不动档案。
  model: '',
  workspace: '',             // 空 = 用 <userData>/workspace
  claudeExe: '',             // 空 = 自动探测
  showThinking: true,
  showToolOutput: true,
};

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* first run */ }
  settings = { ...DEFAULT_SETTINGS, ...raw };
  if (!PERMISSION_MODES.includes(settings.permissionMode)) {
    settings.permissionMode = DEFAULT_SETTINGS.permissionMode;
  }
  return settings;
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8'); } catch { /* ignore */ }
}

function defaultWorkspace() {
  const ws = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function currentWorkspace() {
  const ws = settings.workspace && fs.existsSync(settings.workspace)
    ? settings.workspace
    : defaultWorkspace();
  return ws;
}

// -------------------------------------------------------------------- window

function overlayColors() {
  const dark = settings.theme !== 'light';
  return {
    // 用实色而不是透明。透明在部分 Windows 版本上会让系统按钮区域
    // 出现一条与页面背景不一致的色带；这里直接对齐 --bg-main 的值，保证无缝。
    color: dark ? '#212121' : '#ffffff',
    symbolColor: dark ? '#ececec' : '#3f3f46',
    height: 46,
  };
}

function createWindow() {
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1240,
    height: 830,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: settings.theme === 'light' ? '#ffffff' : '#212121',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // --smoke / --shot：跑自动化，不弹窗（沙箱/无人值守环境下也能验证 UI 真的渲染出来了）
    if (SMOKE || SHOT) return;
    win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  if (SHOT) {
    win.webContents.on('did-finish-load', () => runShots());
  }

  if (SMOKE || SHOT) {
    // 窗口是 hidden 的，Chromium 默认会节流后台页面的 rAF / 定时器。
    // 后果是「点完等 600ms 再抓图」抓到的可能是**上一次绘制的旧帧**
    // —— 实测踩过：DOM 里弹层已经是 display:grid，图里却什么都没有，
    // 于是我误判成"弹层打不开"，差点去改没坏的代码。
    win.webContents.setBackgroundThrottling(false);
  }

  if (SMOKE) {
    const consoleErrors = [];
    win.webContents.on('console-message', (...a) => {
      // Electron 新版把参数收成一个对象，旧版是 (event, level, message, ...)
      const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : null;
      const level = d ? d.level : a[1];
      const message = d ? d.message : a[2];
      if (level === 'error' || level === 3 || level === 1) consoleErrors.push(String(message));
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('SMOKE_FAIL did-fail-load', code, desc, url);
      app.exit(1);
    });
    win.webContents.on('did-finish-load', () => runSmoke(consoleErrors));
  }

  win.on('closed', () => { win = null; });

  // 菜单被移除了，所以快捷键要自己接。没有这个，出问题时用户连控制台都打不开。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (k === 'f12' || (input.control && input.shift && k === 'i')) {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // 外链一律交给系统浏览器，不在应用内开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

// ------------------------------------------------------------------ 冒烟测试

/**
 * --smoke 模式：窗口不显示，但**真实加载页面并回读 DOM**。
 *
 * 加这个是因为 Electron 的界面我无法在沙箱里用手点，而「代码看起来对」
 * 不算验证。这里做两段：
 *   A 静态：页面渲染出来了吗？boot() 跑完了吗？关键控件在不在？有没有报错？
 *   B 联调（加 --live）：真的在输入框里打字、点发送，等一轮真实回复回来。
 *     这一段才真正验证 渲染进程 ↔ 主进程 ↔ claude 子进程 的整条链路。
 *
 * 用法： electron.exe . --smoke
 *        electron.exe . --smoke --live
 */
const SMOKE_PROBE = `(function(){
  var q = function(s){ return document.querySelector(s); };
  var txt = function(s){ var n=q(s); return n ? n.textContent.trim() : null; };
  return {
    hasApi: !!window.api,
    hasMarkdown: typeof window.Markdown === 'object',
    fatal: document.body.innerText.indexOf('启动失败') >= 0,
    bodyText: document.body.innerText.slice(0, 400),
    hasSidebar: !!q('#sidebar'),
    hasConvList: !!q('#convList'),
    hasInput: !!q('#input'),
    hasSend: !!q('#btnSend'),
    hasThread: !!q('#thread'),
    hasModal: !!q('#modal'),
    hasPermChip: !!q('#chipPerm'),
    iconUses: document.querySelectorAll('svg use').length,
    convCount: document.querySelectorAll('.conv').length,
    suggestCount: document.querySelectorAll('.sg').length,
    welcomeVisible: q('#welcome') ? !q('#welcome').hidden : null,
    cwdLabel: txt('#cwdLabel'),
    modelLabel: txt('#modelLabel'),
    permLabel: txt('#permLabel'),
    engineState: txt('#engineState'),
    // 模型配置档案：顶栏入口 + 设置里的区块，缺一个用户就没法换供应商
    hasModelChip: !!q('#chipModel'),
    hasProfilesSec: !!q('#secProfiles'),
    hasProfList: !!q('#profList'),
    hasSyncToggle: !!q('#optSyncGlobal'),
    profItems: document.querySelectorAll('.prof-item').length,
    modelChipTitle: q('#chipModel') ? q('#chipModel').title : null,
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    sidebarBg: getComputedStyle(q('#sidebar')).backgroundColor,
    inputFontSize: getComputedStyle(q('#input')).fontSize,
    composerRadius: getComputedStyle(q('.composer-box')).borderRadius,
    // CSP 里写了 img-src 'self'，file:// 下能不能加载 logo 必须实测，
    // 否则界面上会是一个空白的头像占位，代码里却看不出问题
    logoOk: (function () {
      var i = q('.welcome-logo');
      return !!(i && i.complete && i.naturalWidth > 0);
    })(),
    msgCount: document.querySelectorAll('.msg').length
  };
})()`;

const LIVE_PROBE = `(function(){
  var bodies = document.querySelectorAll('.msg.assistant .body');
  var last = bodies[bodies.length - 1];
  var sum = function (sel) {
    var t = 0;
    if (!last) return 0;
    last.querySelectorAll(sel).forEach(function (n) { t += n.textContent.trim().length; });
    return t;
  };
  return {
    assistantCount: bodies.length,
    // ★ 别用 last.innerText.length 判断"有没有内容"：它会把正文下面「复制」
    // 按钮那两个字一起算进去，于是**永远是 2**，断言等于没写。
    // （2026-09-24 实测踩到：日志里写着"按下停止前已渲染 2 字符"，其实是复制按钮。）
    textLen: sum('.md'),
    thinkLen: sum('.think-body'),
    blocks: last ? last.querySelectorAll('.md,.think,.tool,.notice').length : 0,
    len: last ? last.innerText.length : 0,
    hasError: last ? !!last.querySelector('.notice.err') : false,
    toolCards: last ? last.querySelectorAll('.tool').length : 0,
    meta: last && last.querySelector('.meta-line') ? last.querySelector('.meta-line').innerText : '',
    text: last ? last.innerText.slice(0, 300) : ''
  };
})()`;

/** 给文件拍个指纹（大小 / mtime / sha256），用来证明「它没被动过」 */
function snapshotFile(file) {
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    return {
      exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs),
      hash: require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16),
    };
  } catch (err) {
    return { exists: false, error: err.code || String(err) };
  }
}

function countFiles(dir) {
  try {
    let n = 0;
    for (const e of fs.readdirSync(dir)) { if (fs.statSync(path.join(dir, e)).isFile()) n++; }
    return n;
  } catch { return -1; }
}

async function runSmoke(consoleErrors) {
  const LIVE = process.argv.includes('--live');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  /**
   * 安全基线：**在动任何东西之前**记下用户真实配置的指纹。
   * 整轮测试结束后要逐字节比对 —— 功能再花哨，只要偷偷改了
   * ~/.claude/settings.json，就是在动用户的既有文件。
   */
  const REAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
  const HOME_BACKUP_DIR = path.join(os.homedir(), '.claude-desktop-backups');
  const safetyBefore = snapshotFile(REAL_SETTINGS);
  const backupsBefore = countFiles(HOME_BACKUP_DIR);
  const settingsRedirect = process.env.CLAUDE_DESKTOP_SETTINGS_FILE || null;

  try {
    // ---------- A 静态 ----------
    let p = null;
    for (let i = 0; i < 48; i++) {
      await sleep(250);
      p = await win.webContents.executeJavaScript(SMOKE_PROBE, true);
      if (p.fatal) break;
      if (p.hasApi && p.convCount > 0 && p.cwdLabel && p.cwdLabel !== '\u2026') break;
    }

    check('页面没有渲染成"启动失败"', !p.fatal, p.bodyText.slice(0, 200));
    check('preload 桥接就绪 (window.api)', p.hasApi);
    check('markdown 模块已加载', p.hasMarkdown);
    check('侧边栏 / 会话列表存在', p.hasSidebar && p.hasConvList);
    check('输入框与发送键存在', p.hasInput && p.hasSend);
    check('消息容器存在', p.hasThread);
    check('设置弹层存在', p.hasModal);
    check('图标 sprite 已渲染 (svg use > 10)', p.iconUses > 10, 'uses=' + p.iconUses);
    check('已自动创建会话', p.convCount > 0, 'convCount=' + p.convCount);
    check('欢迎页建议卡渲染了 4 张', p.suggestCount === 4, 'n=' + p.suggestCount);
    check('空对话时显示欢迎页', p.welcomeVisible === true);
    check('工作目录已填充（不是占位符）', !!p.cwdLabel && p.cwdLabel !== '\u2026', p.cwdLabel);
    check('模型/权限标签已填充', p.modelLabel !== '\u2026' && p.permLabel !== '\u2026',
      p.modelLabel + ' / ' + p.permLabel);
    check('主题已应用', p.theme === 'dark' || p.theme === 'light', p.theme);
    check('深浅色背景确实不同（变量生效）',
      p.bg !== 'rgba(0, 0, 0, 0)' && p.bg !== p.sidebarBg, p.bg + ' vs sidebar ' + p.sidebarBg);
    check('输入框字号被样式表接管', p.inputFontSize === '15px', p.inputFontSize);
    check('输入框是胶囊圆角（ChatGPT 观感）', parseFloat(p.composerRadius) >= 20, p.composerRadius);
    check('logo 在 CSP 下成功加载（img-src self）', p.logoOk);
    check('渲染进程无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('顶栏有「配置 · 模型」切换入口', p.hasModelChip, p.modelChipTitle);
    check('设置里有「模型配置」区块', p.hasProfilesSec && p.hasProfList && p.hasSyncToggle,
      'sec=' + p.hasProfilesSec + ' list=' + p.hasProfList + ' sync=' + p.hasSyncToggle);

    // 顶栏菜单必须真的能打开 —— 它是换供应商的唯一入口，
    // 打不开的话功能等于不存在，而 DOM 里那个按钮看着一切正常。
    await exec(`document.querySelector('#chipModel').click(); true`);
    await sleep(350);
    const menu = await exec(`(function(){
      var m = document.querySelector('.pop-model');
      if (!m) return { open: false };
      var r = m.getBoundingClientRect();
      var cs = getComputedStyle(m);
      return {
        open: true,
        items: m.querySelectorAll('.pop-item').length,
        heads: m.querySelectorAll('.pop-hd').length,
        custom: !!m.querySelector('.pop-custom input'),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        display: cs.display, visibility: cs.visibility, z: cs.zIndex, bg: cs.backgroundColor,
      };
    })()`);
    check('顶栏模型菜单能打开且内容完整',
      menu.open && menu.items >= 2 && menu.heads >= 2 && menu.custom &&
      menu.rect[2] > 150 && menu.rect[3] > 80 && menu.visibility === 'visible',
      JSON.stringify(menu));
    check('模型菜单定位在顶栏 chip 下方（没有跑到屏幕外）',
      menu.open && menu.rect[1] > 30 && menu.rect[1] < 120 && menu.rect[0] >= 0,
      menu.open ? JSON.stringify(menu.rect) : 'menu 未打开');
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    await sleep(200);
    check('Esc 能关掉弹层', !(await exec(`!!document.querySelector('.popover')`)));

    // 设置弹层里也要能看到「模型配置」区块真的渲染了（空态也算渲染）
    await exec(`document.querySelector('#btnSettings').click(); true`);
    await sleep(300);
    const profSec = await exec(`(function(){
      var sec = document.querySelector('#secProfiles');
      var list = document.querySelector('#profList');
      var r = sec ? sec.getBoundingClientRect() : null;
      return {
        visible: !!sec && r.width > 100 && r.height > 40,
        text: (list ? list.innerText : '').slice(0, 120),
        hasEmpty: !!document.querySelector('.prof-empty') || document.querySelectorAll('.prof-item').length > 0,
        syncNote: (document.querySelector('#syncNote') || {}).textContent || '',
      };
    })()`);
    check('「模型配置」区块真的渲染出来了（有高度、有内容）',
      profSec.visible && profSec.hasEmpty, JSON.stringify(profSec).slice(0, 240));
    check('同步开关的说明文字已填充', profSec.syncNote.length > 8, profSec.syncNote.slice(0, 120));
    await exec(`document.querySelector('#btnCloseModal').click(); true`);
    await sleep(200);

    console.log('\n--- A 静态渲染 ---');
    for (const r of results) {
      console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.name + (r.ok || !r.detail ? '' : '   ← ' + r.detail));
    }

    // ---------- B 真实联调 ----------
    if (LIVE && !p.fatal) {
      console.log('\n--- B 真实回合（打字 → 点发送 → 等回复）---');
      const lr = [];
      const lc = (n, c, d) => lr.push({ name: n, ok: !!c, detail: d });

      const sendText = (text) => exec(`(function(){
        var ta = document.querySelector('#input');
        ta.value = ${JSON.stringify(text)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btnSend').click();
        return true;
      })()`);
      const probe = () => exec(LIVE_PROBE);

      /**
       * 等这一轮结束。
       *
       * minCount 不能省：`.msg.assistant .body` 取的是**最后一个**助手气泡，
       * 而 turn 事件要过 ~100ms 才到渲染进程。少等这一步的话，紧接着发下一条时
       * 读到的还是**上一轮**那条已经带元信息的气泡，会立刻"成功"返回 ——
       * 断言看似通过，其实验的是上一轮。加上「助手气泡数量必须增加」就锁死了。
       */
      async function waitDone(maxMs, minCount) {
        const t0 = Date.now();
        let cur = null;
        while (Date.now() - t0 < maxMs) {
          await sleep(300);
          cur = await probe();
          if (cur && cur.meta && (!minCount || cur.assistantCount >= minCount)) {
            return { cur, ms: Date.now() - t0 };
          }
        }
        return { cur, ms: Date.now() - t0, timeout: true };
      }

      /**
       * 确保没有上一轮残留的「生成中」。
       * 上一轮如果以失败告终、或被测的那条路本来就是坏的，状态可能没干净地回到 idle；
       * 不清掉的话下一条消息根本发不出去，而断言报出来的却是"产品坏了"。
       * （2026-09-24 就因为这个把自己的测试脚本坑过一次。）
       */
      const ensureIdle = async (tag) => {
        for (let i = 0; i < 24; i++) {
          if (!(await exec(`document.querySelector('#btnSend').classList.contains('stop')`))) return true;
          await sleep(250);
        }
        await exec(`window.api.interrupt()`);
        await sleep(1500);
        console.log('  [诊断] ensureIdle 兜底触发了一次 interrupt' + (tag ? ' @' + tag : ''));
        return false;
      };

      // ---- 轮 1：一次普通对话 ----
      await sendText('回复两个字：收到');
      let r1 = await waitDone(120000, 1);
      lc('轮1 助手回复有实际文本', r1.cur && r1.cur.textLen > 0,
        r1.cur ? 'textLen=' + r1.cur.textLen : '');
      lc('轮1 没有出错提示', r1.cur && !r1.cur.hasError, r1.cur ? r1.cur.text.slice(0, 100) : '');
      lc('轮1 写入了元信息（耗时/用量）', !!r1.cur.meta, r1.cur ? r1.cur.meta : '');

      /**
       * 末条消息有没有被输入框盖住。
       *
       * 这条是看截图才发现的：一长轮结束后滚动停在半路，工具卡片的输出正好压在
       * 输入框底下，用户以为"输出丢了"。DOM 断言全绿也照样漏 —— 因为元素确实都在，
       * 只是被浮在上面的输入区挡住了。所以必须比较**几何位置**。
       */
      const layout = await exec(`(function(){
        var w = document.querySelector('#threadWrap');
        var ca = document.querySelector('.composer-area');
        var msgs = document.querySelectorAll('.msg');
        var last = msgs[msgs.length - 1];
        return {
          gap: Math.round(w.scrollHeight - w.scrollTop - w.clientHeight),
          composerTop: ca ? Math.round(ca.getBoundingClientRect().top) : null,
          lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null
        };
      })()`);
      lc('回复结束后滚到底，末条不被输入框盖住',
        layout.gap <= 8 && (layout.lastBottom == null || layout.lastBottom <= layout.composerTop + 1),
        JSON.stringify(layout));
      console.log('  轮1 用时 ' + (r1.ms / 1000).toFixed(1) + 's  回复: ' +
        JSON.stringify(r1.cur.text.slice(0, 80)));

      // ---- 落盘检查（验证 persist 的即时写）----
      await sleep(600);
      const sm = store.list()[0];
      const sdata = sm ? store.get(sm.id) : null;
      const persisted = sdata ? JSON.stringify(sdata.items) : '';
      lc('对话已即时落盘（含刚发送的用户消息）', persisted.includes('收到'),
        'items=' + (sdata ? sdata.items.length : 0));
      lc('落盘内容里 usage 已瘦身（无 server_tool_use 之类）',
        !persisted.includes('server_tool_use'));

      // ---- 轮 2：中断 ----
      // ★ 这里有两个坑，都踩过，别改回去：
      //   (1) 不能「固定 sleep 之后点停」。实测模型 2.1 秒就把「数到 200」答完了，
      //       脚本等 2600ms 再点，按钮早已不是 stop 态，点到的是「发送」——
      //       于是「已中断」永远不出现，报出来是一条正常的完成元信息
      //       （deepseek-flash · 2.1 s · $0.1239 · …），看着像应用的 bug，
      //       其实是测试自己在瞎点。
      //   (2) 也不能「一见 stop 态就点」。turn 事件在写 stdin **之前**发出，
      //       所以按钮在 9ms 时就已经是 stop 了 —— 那样测的是"还没开始就掐断"，
      //       覆盖不到「看着它一行行写出来，然后按停」这条真正会被用的路径。
      // 做法：先等按钮进入 stop 态（确定这一轮已经开始），再等**内容真的开始出现**
      // （上限 3.5s），然后才点。题目故意选长文，保证它有足够长的时间处在"正在写"。
      const essay = '请写一篇 600 字的短文介绍你自己，分三段，要有开头和结尾，不要省略内容。';
      let stopClickedAt = -1;
      let sawText = 0;
      for (let attempt = 1; attempt <= 2 && stopClickedAt < 0; attempt++) {
        await sendText(essay);
        const tStop = Date.now();
        let busy = false;
        while (Date.now() - tStop < 10000) {
          busy = await exec(`document.querySelector('#btnSend').classList.contains('stop')`);
          if (busy) break;
          await sleep(50);
        }
        if (!busy) continue;                       // 连"生成中"都没抓到，重来

        const tTxt = Date.now();
        while (Date.now() - tTxt < 3500) {
          const cur = await probe();
          // 正文或思考过程任意一个有字，就算"开始往外吐了"
          if (cur.textLen + cur.thinkLen > 0) { sawText = cur.textLen + cur.thinkLen; break; }
          // 万一它自己已经答完，就别点了（这时点的是「发送」）
          if (!(await exec(`document.querySelector('#btnSend').classList.contains('stop')`))) break;
          await sleep(100);
        }
        // 确认这一刻还处在生成中，才把手按下去
        if (!(await exec(`document.querySelector('#btnSend').classList.contains('stop')`))) continue;
        await exec(`document.querySelector('#btnSend').click()`);
        stopClickedAt = Date.now() - tStop;
      }
      console.log('  轮2 在 ' + stopClickedAt + 'ms 处按下停止（按下前已渲染 ' + sawText + ' 字符）');
      lc('中断请求确实是在"生成中"发出的', stopClickedAt >= 0, 'clicked@' + stopClickedAt + 'ms');
      lc('中断发生在已经吐出内容之后（覆盖"边看边停"）', sawText > 0, 'chars=' + sawText);

      // 等「已中断」标记落地（渲染进程处理 interrupted 事件后立即同步重绘，通常 <200ms）
      let afterStop = null;
      const tMark = Date.now();
      while (Date.now() - tMark < 8000) {
        await sleep(200);
        afterStop = await probe();
        if (/已中断/.test(afterStop.meta || '')) break;
      }
      lc('中断后出现"已中断"标记', /已中断/.test(afterStop.meta || ''),
        JSON.stringify(afterStop.meta || '') + ' | text=' + afterStop.text.slice(0, 60));
      lc('中断后输入区恢复可发送（不再处于生成中）',
        await exec(`document.querySelector('#btnSend').classList.contains('stop') === false`));

      // ---- 轮 3：中断之后还能继续说话（★ 本次修复的回归点）----
      const beforeCount = afterStop.assistantCount;
      await sendText('Reply with exactly: resumed');
      const r3 = await waitDone(120000, beforeCount + 1);
      lc('中断后仍能继续发送并拿到回复',
        r3.cur && r3.cur.assistantCount > beforeCount && r3.cur.textLen > 0,
        'count=' + (r3.cur ? r3.cur.assistantCount : -1) + ' textLen=' + (r3.cur ? r3.cur.textLen : -1) +
        ' text=' + (r3.cur ? r3.cur.text.slice(0, 60) : ''));
      lc('中断后的回复没有报错', r3.cur && !r3.cur.hasError, r3.cur ? r3.cur.text.slice(0, 120) : '');
      console.log('  轮3 用时 ' + (r3.ms / 1000).toFixed(1) + 's  回复: ' +
        JSON.stringify(r3.cur ? r3.cur.text.slice(0, 80) : ''));

      // ---- 轮 4：切换对话再切回来，状态不残留 ----
      // 数一下"旧对话里到底有多少条用户消息"：轮 2 有重试的可能，所以写死数字会假失败
      const usersBefore = await exec(`document.querySelectorAll('.msg.user').length`);
      await exec(`document.querySelector('#btnNew').click()`);
      await sleep(900);
      const afterNew = await exec(`(function(){
        return {
          model: document.querySelector('#modelLabel').textContent.trim(),
          engine: document.querySelector('#engineState').textContent.trim(),
          welcome: !document.querySelector('#welcome').hidden,
          msgCount: document.querySelectorAll('.msg').length
        };
      })()`);
      lc('新建对话后进入空态（欢迎页回来了）', afterNew.welcome === true && afterNew.msgCount === 0,
        JSON.stringify(afterNew));
      lc('新建对话后引擎状态已复位（不残留上一个对话的模型名）',
        afterNew.model === '默认模型' || afterNew.model !== (r1.cur ? r1.cur.meta : '###'),
        JSON.stringify(afterNew));

      // ---- 轮 5：点回旧对话，历史必须从磁盘恢复 ----
      // 这一步覆盖的是「切走再切回」这条最常用的路径：selectSession 读的是
      // sessions/<id>.json，如果落盘的那一刻丢了最后一轮，或者结构对不上，
      // 用户看到的就是一片空白 —— 而单看代码完全看不出来。
      const backClicked = await exec(`(function(){
        var cs = document.querySelectorAll('.conv');
        if (cs.length < 2) return false;
        cs[1].click();   // 索引 0 是刚建的空对话，索引 1 才是聊过的那条
        return true;
      })()`);
      await sleep(1200);
      const back = await exec(`(function(){
        return {
          welcome: !document.querySelector('#welcome').hidden,
          msgCount: document.querySelectorAll('.msg').length,
          userCount: document.querySelectorAll('.msg.user').length,
          text: document.querySelector('#thread').innerText.slice(0, 160)
        };
      })()`);
      lc('切回旧对话后历史消息从磁盘恢复',
        backClicked && back.welcome === false && back.userCount === usersBefore && back.msgCount >= usersBefore,
        'msgs=' + back.msgCount + ' user=' + back.userCount + '（切走前 ' + usersBefore + '） | ' +
        JSON.stringify(back.text));

      /* ---- 轮 6：换成「配置档案」再发一轮（本功能的端到端验证）----
       *
       * 这是整块新功能唯一的真实证据链：
       *   导入一条档案 → 激活 → 引擎被回收 → 下一轮用 --settings 重新拉起 → 真拿到回复。
       * 前面那些断言只能证明"界面画出来了"，证明不了切换真的生效 ——
       * 而"界面显示 A、请求实际走 B"恰恰是这类功能最典型的坑。
       */
      const asstBefore6 = await exec(`document.querySelectorAll('.msg.assistant .body').length`);

      const imported = await exec(`window.api.profiles.importGlobal()`);
      lc('能把当前 ~/.claude/settings.json 收成一条档案',
        imported.ok === true && !!imported.profile && !!imported.profile.id,
        JSON.stringify(imported).slice(0, 200));

      const profId = imported.profile && imported.profile.id;
      const act = await exec(`window.api.profiles.activate(${JSON.stringify(profId)})`);
      lc('激活档案成功（并写出一份只含 env 的 --settings 文件）',
        act.ok === true && !!act.engineSettingsFile && fs.existsSync(act.engineSettingsFile),
        JSON.stringify({ ok: act.ok, file: act.engineSettingsFile, keys: act.envKeys, reason: act.reason }));
      if (act.engineSettingsFile && fs.existsSync(act.engineSettingsFile)) {
        const body = JSON.parse(fs.readFileSync(act.engineSettingsFile, 'utf8'));
        lc('--settings 文件里确实有 env（不是空壳）',
          !!body.env && Object.keys(body.env).length > 0, JSON.stringify(Object.keys(body.env || {})));
        lc('--settings 文件不含任何非 env 的键（不动用户其它设置）',
          Object.keys(body).length === 1 && Object.keys(body)[0] === 'env', JSON.stringify(Object.keys(body)));
      }

      // 界面必须立刻反映出「当前是哪个配置」，否则用户不知道切成功没有
      const chipAfter = await exec(`(function(){
        return { label: document.querySelector('#modelLabel').textContent.trim(),
                 title: document.querySelector('#chipModel').title };
      })()`);
      lc('顶栏立刻显示新配置名（切了看得出区别）',
        chipAfter.label.includes(imported.profile.name), JSON.stringify(chipAfter));

      await sendText('Reply with exactly: profile-ok');
      const r6 = await waitDone(120000, asstBefore6 + 1);
      lc('换成配置档案后仍能正常拿到回复（--settings 链路通）',
        r6.cur && r6.cur.assistantCount > asstBefore6 && r6.cur.textLen > 0 && !r6.cur.hasError,
        'count=' + (r6.cur ? r6.cur.assistantCount : -1) + ' text=' + (r6.cur ? r6.cur.text.slice(0, 80) : ''));

      const st6 = await exec(`window.api.engineStatus()`);
      lc('引擎启动时确实带上了配置档案（不是只改了个显示）',
        !!st6 && !!st6.profile && String(st6.profile).includes(imported.profile.name),
        JSON.stringify(st6));

      // 删掉档案后必须回到「不插手」的兜底状态，而不是把应用搞成没令牌
      const del6 = await exec(`window.api.profiles.remove(${JSON.stringify(profId)})`);
      lc('删除档案后回到「沿用全局设置」的兜底状态',
        del6.ok === true && del6.state.items.length === 0 && del6.state.envKeys.length === 0,
        JSON.stringify({ ok: del6.ok, items: del6.state.items.length, envKeys: del6.state.envKeys }));

      const profDir = path.join(app.getPath('userData'), 'profiles');

      /* ---- 轮 7：多条档案并存 + 真落盘 + 「下次启动还在」----
       *
       * 轮 6 只验了一条档案。真实使用里用户会存好几家供应商来回切，这里一次建 5 条、
       * 逐条激活，然后**直接读磁盘**核对两件事：
       *   · profiles.json 里的活动项
       *   · 每条档案的 --settings 文件是各自独立的一份，内容就是那条档案的 env
       * 只要「文件名或内容串了」，就会出现用户切到 B、请求实际走 A 的情况 ——
       * 而界面上完全看不出来（顶栏名字会老老实实地显示 B）。
       */
      const demoDefs = [
        { name: '轮7-甲', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-a', ANTHROPIC_MODEL: 'deepseek-v4-pro' } },
        { name: '轮7-乙', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-b', ANTHROPIC_MODEL: 'kimi-k2.7-code' } },
        { name: '轮7-丙', env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-c', ANTHROPIC_MODEL: 'glm-4.7' } },
        { name: '轮7-丁', env: { ANTHROPIC_BASE_URL: 'https://api.siliconflow.cn/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-d', ANTHROPIC_MODEL: 'deepseek-v3.2' } },
        { name: '轮7-戊', env: { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-demo-e', ANTHROPIC_MODEL: 'abab7' } },
      ];
      const savedIds = [];
      for (const d of demoDefs) {
        const r = await exec(`window.api.profiles.save(${JSON.stringify({ name: d.name, env: d.env, category: 'custom' })})`);
        if (r && r.ok && r.profile) savedIds.push(r.profile.id);
      }
      lc('一次能存下多条档案（5 条）', savedIds.length === 5, 'saved=' + savedIds.length);

      const settingsFiles = new Set();
      const mismatch = [];
      for (let i = 0; i < savedIds.length; i++) {
        const r = await exec(`window.api.profiles.activate(${JSON.stringify(savedIds[i])})`);
        const want = demoDefs[i];
        if (!r || !r.ok) { mismatch.push(want.name + ': activate 失败 ' + JSON.stringify(r)); continue; }
        const f = r.engineSettingsFile;
        settingsFiles.add(f);
        let env = {};
        try { env = JSON.parse(fs.readFileSync(f, 'utf8')).env || {}; } catch { env = {}; }
        const same = env.ANTHROPIC_BASE_URL === want.env.ANTHROPIC_BASE_URL &&
                     env.ANTHROPIC_AUTH_TOKEN === want.env.ANTHROPIC_AUTH_TOKEN &&
                     env.ANTHROPIC_MODEL === want.env.ANTHROPIC_MODEL;
        if (!same || (r.state && r.state.activeId !== savedIds[i])) {
          mismatch.push(want.name + ' → ' + JSON.stringify({ got: env.ANTHROPIC_BASE_URL, want: want.env.ANTHROPIC_BASE_URL, active: r.state && r.state.activeId }));
        }
      }
      lc('逐条激活：每条的 --settings 文件各自独立（不会串档）',
        settingsFiles.size === 5, 'distinct=' + settingsFiles.size);
      lc('逐条激活：--settings 内容就是那条档案自己的 env',
        mismatch.length === 0, mismatch.join(' | '));

      const diskState = snapshotFile(path.join(profDir, 'profiles.json'));
      lc('档案真的落到了磁盘上的 profiles.json',
        diskState.exists && diskState.size > 50, JSON.stringify(diskState));

      // 新建一个 store 实例重新读盘 = 模拟「关掉应用再打开」
      const Fresh = new profilesLib.ProfilesStore(profDir).init();
      const freshActive = Fresh.active();
      let diskActiveId = null;
      try { diskActiveId = JSON.parse(fs.readFileSync(path.join(profDir, 'profiles.json'), 'utf8')).activeId; } catch { /* 上面已断言 */ }
      lc('重新加载（模拟下次启动）：活动档案没丢，还是最后切到的那条',
        !!freshActive && freshActive.id === savedIds[savedIds.length - 1] && freshActive.id === diskActiveId,
        'fresh=' + (freshActive ? freshActive.name : null) + ' expect=' + demoDefs[demoDefs.length - 1].name);

      const freshArgs = Fresh.engineLaunchArgs(null);
      lc('重新加载后引擎参数仍带 --settings（重启后切换依然生效）',
        freshArgs.args.includes('--settings') && !!freshArgs.settingsFile && fs.existsSync(freshArgs.settingsFile),
        freshArgs.args.join(' '));
      lc('未开同步时用 --setting-sources project,local 挡掉用户级设置（防上一家供应商的变量漏进来）',
        freshArgs.args.join(' ').includes('--setting-sources project,local'),
        freshArgs.args.join(' '));

      /* ---- 轮 8：模型覆盖的边界（"覆盖着上一家的模型"是最容易踩的坑）----
       *
       * 场景：用户在设置里手动覆盖成 deepseek-v4-pro，然后切到 Moonshot。
       * 覆盖不清掉的话，之后每一轮请求都会因为「模型不存在」失败，而顶栏
       * 还老老实实显示着 deepseek-v4-pro —— 用户根本猜不到是这里的问题。
       */
      await exec(`window.api.setSettings({ model: 'deepseek-v4-pro' })`);
      await sleep(350);

      const keepRes = await exec(`window.api.profiles.activate(${JSON.stringify(savedIds[0])})`);
      lc('切到「含同名模型」的档案：覆盖被保留（不误清）',
        keepRes.ok === true && keepRes.overrideCleared === false && keepRes.modelOverride === 'deepseek-v4-pro',
        JSON.stringify({ cleared: keepRes.overrideCleared, model: keepRes.modelOverride }));

      const clearRes = await exec(`window.api.profiles.activate(${JSON.stringify(savedIds[1])})`);
      const eff8 = clearRes.state && clearRes.state.effectiveModel;
      lc('切到「不含该模型」的档案：覆盖被自动清掉并回落到新档案的模型',
        clearRes.ok === true && clearRes.overrideCleared === true &&
        clearRes.modelOverride === '' && eff8 === 'kimi-k2.7-code',
        JSON.stringify({ cleared: clearRes.overrideCleared, override: clearRes.modelOverride, effective: eff8 }));

      /* ---- 轮 9：真实供应商 + 过期令牌 → 必须是「读得懂的失败」----
       *
       * 这是用户最常遇到的一类事故（key 过期 / 余额没了）。断言点不在「失败」本身，
       * 而在**失败的样子**：
       *   · 有明确的错误文字（不是空白气泡、不是永远转圈）
       *   · 输入区回到可发送（不能卡在「生成中」）
       *   · 之后还能切回可用档案继续干活（不能一次失败就把应用搞废）
       * ⚠️ 令牌是故意写错的常量，不是探测出来的真 key —— 这里要的就是 401。
       */
      const badTok = await exec(`window.api.profiles.save(${JSON.stringify({
        name: '轮9-过期令牌',
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-smoke-invalid-token-0000', ANTHROPIC_MODEL: 'deepseek-flash' },
        category: 'custom',
      })})`);
      const badId = badTok.profile && badTok.profile.id;

      await exec(`window.api.profiles.activate(${JSON.stringify(badId)})`);
      await sleep(400);
      await ensureIdle('轮9前');
      const asstB9 = await exec(`document.querySelectorAll('.msg.assistant .body').length`);
      await sendText('回复两个字：收到');
      let r9 = null;
      let sawRetry9 = false;
      const t9 = Date.now();
      // ★ 上限 45 秒（以前写 120 秒，于是"卡住"看起来像"通过"）。
      // 修好之后这里应该 2 秒内就结束；留 45 秒是为了容忍机器慢，不是给卡死留余地。
      while (Date.now() - t9 < 45000) {
        await sleep(400);
        r9 = await probe();
        if (/正在重试/.test(r9.text)) sawRetry9 = true;
        if (r9.hasError) break;
        const busy = await exec(`document.querySelector('#btnSend').classList.contains('stop')`);
        if (!busy && r9.assistantCount > asstB9) {
          const t2 = Date.now();
          while (Date.now() - t2 < 4000) {
            await sleep(300);
            r9 = await probe();
            if (r9.hasError) break;
          }
          break;
        }
      }
      const r9ms = Date.now() - t9;
      const r9all = r9 ? r9.text + ' ' + r9.meta : '';
      lc('过期令牌：确实产生了一条助手消息（没有静默失败 / 卡死）',
        !!r9 && r9.assistantCount > asstB9,
        'count=' + (r9 ? r9.assistantCount : -1) + ' vs ' + asstB9 + ' @' + r9ms + 'ms');
      lc('★ 过期令牌：几秒内就给出明确失败（不再让用户干等十分钟）',
        !!r9 && r9.hasError && r9ms < 20000,
        'hasError=' + (r9 && r9.hasError) + ' @' + r9ms + 'ms');
      lc('过期令牌：错误里点明了是鉴权问题（401 / 令牌）',
        /401|令牌|鉴权/.test(r9all), JSON.stringify(r9all.slice(0, 260)));
      lc('过期令牌：给出了下一步该去哪改（模型配置 / 测试连接）',
        /模型配置|测试连接/.test(r9all), JSON.stringify(r9all.slice(0, 260)));
      lc('过期令牌：失败后输入区恢复可发送（没卡在「生成中」）',
        await exec(`document.querySelector('#btnSend').classList.contains('stop') === false`));
      // 用户看不到"正在重试"就只能干等 —— 这条覆盖的是「界面不是哑的」
      console.log('  轮9 重试提示是否出现过: ' + sawRetry9 + '  用时 ' + r9ms + 'ms');

      // 切回一条真能用的档案，证明「一次失败不会把应用搞废」
      const reImp = await exec(`window.api.profiles.importGlobal()`);
      await exec(`window.api.setSettings({ model: '' })`);
      await exec(`window.api.profiles.activate(${JSON.stringify(reImp.profile.id)})`);
      await sleep(400);
      await ensureIdle();
      const asstB9b = await exec(`document.querySelectorAll('.msg.assistant .body').length`);
      await sendText('Reply with exactly: recovered');
      const r9b = await waitDone(120000, asstB9b + 1);
      lc('失败之后切回可用档案，仍能正常拿到回复（可恢复）',
        !!r9b.cur && r9b.cur.assistantCount > asstB9b && r9b.cur.textLen > 0 && !r9b.cur.hasError,
        'count=' + (r9b.cur ? r9b.cur.assistantCount : -1) + ' text=' + (r9b.cur ? r9b.cur.text.slice(0, 80) : ''));

      /* ---- 轮 10：把地址填错（域名根本不存在）→ 会不会永远转圈 ----
       * 这是「手滑」最常见的形态。用户能接受报错，不能接受一直转。
       * 探测时原始 fetch 只需 13ms 就 failed，但 CLI 自己可能带重试 ——
       * 会不会把等待拖到几分钟，只有真发一轮才知道。
       */
      const badHost = await exec(`window.api.profiles.save(${JSON.stringify({
        name: '轮10-坏地址',
        env: { ANTHROPIC_BASE_URL: 'https://this-host-does-not-exist-zzz9.invalid/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x', ANTHROPIC_MODEL: 'whatever' },
        category: 'custom',
      })})`);
      await exec(`window.api.profiles.activate(${JSON.stringify(badHost.profile.id)})`);
      await sleep(400);
      await ensureIdle();
      const asstB10 = await exec(`document.querySelectorAll('.msg.assistant .body').length`);
      await sendText('回复两个字：收到');
      let r10 = null;
      let sawRetry10 = false;
      const t10 = Date.now();
      let lastDiag10 = 0;
      let ended10 = 0;
      while (Date.now() - t10 < 110000) {
        await sleep(500);
        r10 = await probe();
        // ★ 这一条是本次新加的：坏地址时 CLI 也会退避重试，用户必须能**看见**它在重试，
        // 否则界面就是一个不动的「生成中」，和卡死没有区别。
        if (/正在重试/.test(r10.text)) sawRetry10 = true;
        const el = Date.now() - t10;
        if (el - lastDiag10 >= 15000) {
          lastDiag10 = el;
          const busyD = await exec(`document.querySelector('#btnSend').classList.contains('stop')`);
          console.log('  [轮10诊断] ' + Math.round(el / 1000) + 's busy=' + busyD +
            ' hasError=' + r10.hasError + ' asst=' + r10.assistantCount + '/' + asstB10 +
            ' text=' + JSON.stringify(r10.text.slice(0, 70)));
        }
        if (r10.hasError) break;
        if (!(await exec(`document.querySelector('#btnSend').classList.contains('stop')`)) && r10.assistantCount > asstB10) {
          /**
           * ★ 别在这里立刻 break。
           *
           * 「引擎把 busy 置 false」和「错误提示画到 DOM 上」之间隔着一次
           * requestAnimationFrame —— 断言抢在重绘之前读 DOM，就会把
           * "已经报错了但还没画出来" 判成 "没报错"。
           * （2026-09-24 实测踩到：中止发生在 61 秒，断言在同一瞬间结束，
           *   于是明明修好了却报红。这是测试自己的 bug，不是产品 bug。）
           */
          if (!ended10) ended10 = Date.now();
          if (Date.now() - ended10 > 5000) break;
        }
      }
      const r10ms = Date.now() - t10;
      const r10all = r10 ? r10.text + ' ' + r10.meta : '';
      lc('★ 坏地址：重试过程对用户可见（不是不动的「生成中」）',
        sawRetry10, 'sawRetry=' + sawRetry10 + ' ms=' + r10ms);
      lc('★ 坏地址：在重试预算内自己停下并报错（不是无限转圈）',
        !!r10 && r10.hasError && r10ms < 100000, 'hasError=' + (r10 && r10.hasError) + ' ms=' + r10ms);
      // 收紧：必须出现**错误**提示，不能拿"正在重试"那条凑数
      lc('坏地址：错误提示里说明了原因和下一步（不是只留一句"正在重试"）',
        /连续重试|额度|域名|网络/.test(r10all) && /模型配置|测试连接/.test(r10all),
        JSON.stringify(r10all.slice(0, 300)));
      lc('坏地址：失败后输入区恢复可发送',
        await exec(`document.querySelector('#btnSend').classList.contains('stop') === false`));

      // 万一它还卡着，把这一轮掐掉，别影响后面的断言
      if (await exec(`document.querySelector('#btnSend').classList.contains('stop')`)) {
        await exec(`window.api.interrupt()`);
        await sleep(1500);
      }

      /* ---- 轮 10b：临时提示不能"粘"在界面上（2026-09-26 新增）----
       *
       * 上面那一轮里，日志出现过 `busy=false hasError=false` 而屏幕上还挂着
       * 「接口返回 502 server_error，正在重试（第 7/10 次）…」的一瞬。
       * 成因是 'retry' 与 'error'/'result'/'interrupted' 是**不同 IPC 事件**，
       * 中间有 rAF 间隙；用户若恰好此时点「停止生成」，收尾路径不摘这条提示，
       * 它就会永久留在界面上（按钮已变回"发送"、状态栏写着"就绪"）。
       *
       * 所以这里不测"某一帧"，而是直接测**收尾之后仍然干净** ——
       * 这才是不随帧率抖动的稳定判定。
       */
      await sleep(2500);
      const sticky = await exec(`(function(){
        var bubbles = document.querySelectorAll('.msg.assistant');
        var last = bubbles[bubbles.length - 1];
        var txt = last ? last.innerText : '';
        return {
          retry: /正在重试/.test(txt),
          canSend: document.querySelector('#btnSend').classList.contains('stop') === false,
          engineLabel: (document.querySelector('#engineState') || {}).textContent || '',
        };
      })()`);
      lc('★ 收尾之后不再残留「正在重试」提示（不会永久粘在气泡上）',
        !sticky.retry, JSON.stringify(sticky));
      lc('临时提示清理与"可发送"状态一致（不会一边可发送一边还写着重试中）',
        !(sticky.canSend && sticky.retry), JSON.stringify(sticky));

      /**
       * 主动停止后也必须清理干净。
       *
       * 这是上面那条的用户操作版：点「停止生成」走的是 interrupt() →
       * engine.intentify → 'interrupted' 事件。旧代码在这条路上只改了
       * status/meta，没有摘 retry 提示 —— 真用户点一下就复现了。
       */
      const before10c = await exec(`document.querySelectorAll('.msg.assistant').length`);
      await sendText('数到 100，每个数字单独一行');
      await sleep(2500);
      await exec(`window.api.interrupt()`);
      await sleep(2000);
      const stopClean = await exec(`(function(){
        var bubbles = document.querySelectorAll('.msg.assistant');
        var last = bubbles[bubbles.length - 1];
        var txt = last ? last.innerText : '';
        return {
          retry: /正在重试/.test(txt),
          interrupted: /已中断/.test(txt),
          canSend: document.querySelector('#btnSend').classList.contains('stop') === false,
          count: bubbles.length,
        };
      })()`);
      lc('停止生成后不残留「正在重试」提示',
        stopClean.count === before10c + 1 && !stopClean.retry, JSON.stringify(stopClean));
      lc('停止生成后输入区回到可发送（没卡在生成中）',
        stopClean.canSend, JSON.stringify(stopClean));

      /**
       * ---- 轮 10c：重复中止不能吐出两条错误（2026-09-26 新增）----
       *
       * `_abortTurn` 有两个入口，可能同一瞬间都进来：
       *   ① `_handleApiRetry` 同步判定"致命 / 预算已超"；
       *   ② `_retryTimer` 到点触发（异步）。
       * 旧代码没有幂等闸，重复进入会把同一条错误 emit 两遍（界面叠两条），
       * 而且第二次 dispose 时 `_retryInfo` 已被清空，"最后错误"会退化成
       * **"未知错误"** —— 用户拿到的信息反而更少。
       *
       * 注意：这一段**必须在主进程里跑**。渲染进程没有 Node 的 require，
       * 从 `exec()` 里 require 会直接抛 "require is not defined"
       * （2026-09-26 实测踩到，那次失败是测试自己的问题，不是产品的）。
       */
      const doubleAbort = (() => {
        try {
          const e = new ClaudeEngine({ exe: 'no-such-exe.exe', cwd: process.cwd() });
          const errs = [];
          e.on('event', (ev) => { if (ev.type === 'error') errs.push(ev.message); });
          // 造一个"已经在重试、且预算已超"的现场，然后连调两次。
          // _retryStartedAt 是**毫秒**时间戳（Date.now()），别写成秒 —— 写错会算出
          // "连续重试 1788603174 秒"这种荒唐文案（2026-09-26 实测踩到）。
          e._retryStartedAt = Date.now() - 5000;
          e._retryInfo = { status: 502, error: 'server_error', attempt: 7, max: 10 };
          e.busy = true;
          e._abortTurn('budget', 502, 7, 10);
          e._abortTurn('budget', 502, 7, 10);
          return { count: errs.length, msgs: errs.map((m) => m.slice(0, 80)) };
        } catch (err) {
          return { count: -1, err: String((err && err.message) || err) };
        }
      })();
      lc('★ 重复中止只报一次错（不会叠两条）',
        doubleAbort.count === 1, JSON.stringify(doubleAbort));
      lc('★ 重复中止后错误文案仍是有效信息（没有退化成"未知错误"）',
        doubleAbort.msgs && doubleAbort.msgs.length === 1 &&
        /连续重试/.test(doubleAbort.msgs[0]) && !/未知错误/.test(doubleAbort.msgs[0]),
        JSON.stringify(doubleAbort.msgs));

      /* ---- 轮 11：开启「同步写入全局配置」——写的是被重定向出来的副本 ----
       *
       * 没设重定向时这一轮**必须跳过**：开同步会去写 ~/.claude/settings.json，
       * 那正是我们绝不能拿来试的东西。跳过不是放水，是拒绝拿用户文件冒险。
       */
      if (settingsRedirect) {
        const before11 = (() => { try { return JSON.parse(fs.readFileSync(settingsRedirect, 'utf8')); } catch { return {}; } })();
        const keysBefore11 = Object.keys(before11).sort().join(',');
        await exec(`window.api.profiles.setSyncGlobal(true)`);
        await sleep(250);
        const on11 = await exec(`window.api.profiles.activate(${JSON.stringify(savedIds[0])})`);
        await sleep(350);
        let after11 = null;
        try { after11 = JSON.parse(fs.readFileSync(settingsRedirect, 'utf8')); } catch { after11 = null; }
        lc('开同步：env 真的写进了（重定向目标）配置文件',
          !!after11 && !!after11.env && after11.env.ANTHROPIC_BASE_URL === demoDefs[0].env.ANTHROPIC_BASE_URL &&
          after11.env.ANTHROPIC_MODEL === demoDefs[0].env.ANTHROPIC_MODEL,
          JSON.stringify(after11 && after11.env));
        lc('开同步：只替换 env 一个键，其它顶层键原样保留',
          !!after11 && Object.keys(after11).sort().join(',') === keysBefore11,
          'before=[' + keysBefore11 + '] after=[' + (after11 ? Object.keys(after11).sort().join(',') : 'null') + ']');
        lc('开同步：apply 返回里带上了 global 写入结果（写失败不会假装成功）',
          !!(on11 && on11.global && on11.global.file), JSON.stringify(on11 && on11.global));

        await exec(`window.api.profiles.setSyncGlobal(false)`);
        await sleep(250);
        const off11 = await exec(`window.api.profiles.state()`);
        lc('关掉同步后 state.syncGlobal 归 false', off11 && off11.syncGlobal === false, String(off11 && off11.syncGlobal));
      } else {
        lc('开同步写入全局配置：本轮已跳过（未重定向配置路径，不拿你的真实 ~/.claude/settings.json 冒险）',
          true, '设 CLAUDE_DESKTOP_SETTINGS_FILE 后重跑即会执行');
      }

      /* ---- 轮 12：「测试连接」按钮背后的 IPC ----
       * 用户点了按钮却毫无反应 / 一直转 —— 这类「按钮是装饰品」的问题
       * 只有真调一次才看得出来。
       */
      // 故意不给模型名：档案里只填了地址和令牌时，按钮必须照样能用。
      // 早先这里是直接返回「档案里没有指定模型，无法构造探测请求」= 按钮报废。
      const t12bad = await exec(`window.api.profiles.test({ env: { ANTHROPIC_BASE_URL: 'https://this-host-does-not-exist-zzz9.invalid/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x' } })`);
      lc('测试连接：档案没写模型名也能探（不再直接拒绝）',
        !!t12bad && t12bad.ok === false && typeof t12bad.reason === 'string' &&
        !/无法构造探测请求/.test(t12bad.reason) && t12bad.ms < 15000,
        JSON.stringify(t12bad).slice(0, 220));

      // 可达但令牌不对 → 必须给出状态码 + 「该改什么」
      const t12hint = await exec(`window.api.profiles.test({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-deliberately-wrong-0000' } })`);
      lc('测试连接：令牌不对时明确说是令牌问题（不是含糊的 404）',
        !!t12hint && t12hint.ok === false && t12hint.status === 401 &&
        typeof t12hint.hint === 'string' && /令牌/.test(t12hint.hint),
        JSON.stringify(t12hint).slice(0, 220));

      const t12ok = await exec(`window.api.profiles.test({ id: ${JSON.stringify(reImp.profile.id)} })`);
      lc('测试连接：对当前真的在用的档案返回成功（或官方登录判为无需测试）',
        !!t12ok && t12ok.ok === true,
        JSON.stringify({ ok: t12ok && t12ok.ok, skipped: t12ok && t12ok.skipped, ms: t12ok && t12ok.ms, reason: t12ok && t12ok.reason }));

      const t12skip = await exec(`window.api.profiles.test({ env: {} })`);
      lc('测试连接：官方登录（无地址无令牌）判为「无需测试」而不是报错',
        !!t12skip && t12skip.ok === true && t12skip.skipped === true, JSON.stringify(t12skip));

      const m12 = await exec(`window.api.profiles.models({ env: ${JSON.stringify({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x', ANTHROPIC_MODEL: 'deepseek-flash' })} })`);
      lc('模型列表：端点不给 /v1/models 时退回档案里的模型名（不会是空列表）',
        !!m12 && Array.isArray(m12.models) && m12.models.length > 0 && m12.models.includes('deepseek-flash'),
        JSON.stringify(m12).slice(0, 200));
      lc('测试连接：返回里没有泄漏完整令牌',
        !JSON.stringify(t12ok).includes('sk-') || !/sk-[A-Za-z0-9]{20,}/.test(JSON.stringify(t12ok)),
        JSON.stringify(t12ok).slice(0, 120));

      /* ---- 轮 13：全程安全断言 —— 用户的真实配置一个字节都没变 ----
       * 这是整轮测试里我最在意的一条。
       */
      const safetyAfter = snapshotFile(REAL_SETTINGS);
      lc('全程没动用户的 ~/.claude/settings.json（字节级一致）',
        safetyBefore.hash === safetyAfter.hash && safetyBefore.mtimeMs === safetyAfter.mtimeMs &&
        safetyBefore.exists === safetyAfter.exists,
        'before=' + JSON.stringify(safetyBefore) + ' after=' + JSON.stringify(safetyAfter));
      lc('没有往 ~/.claude-desktop-backups 里堆备份（备份走应用自己的目录）',
        countFiles(HOME_BACKUP_DIR) === backupsBefore,
        'before=' + backupsBefore + ' after=' + countFiles(HOME_BACKUP_DIR) + ' dir=' + HOME_BACKUP_DIR);
      lc('冒烟跑在一次性目录里（没污染真实 userData）',
        String(app.getPath('userData')).includes('smoke') || String(app.getPath('userData')) === (process.env.CLAUDE_DESKTOP_SMOKE_DIR || ''),
        app.getPath('userData'));

      for (const r of lr) {
        console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.name + (r.ok || !r.detail ? '' : '   ← ' + r.detail));
      }
      results.push(...lr);
    }

    /* ---- B2：技能管家（停用 / 恢复 必须字节级可逆）----
     *
     * 独立于 B（--live）：技能管家全程不碰 claude 引擎，所以只要
     * 有 --smoke 就该跑。它跑在一个重定向出来的临时技能目录上
     * （见 SKILLS_ROOT 上面的注释），绝不碰用户真实的 ~/.workbuddy/skills。
     */
    if (process.env.CLAUDE_DESKTOP_SKILLS_ROOT) {
      console.log('\n--- B2 技能管家（停用/恢复 可逆性）---');
      const sr = [];
      const sc = (n, c, d) => sr.push({ name: n, ok: !!c, detail: d });

      /**
       * 只读巡检开关：CLAUDE_DESKTOP_SKILLS_LIST=1 时只把解析结果打出来
       * （指向一份真实技能的**副本**时用来人工核对描述解析对不对），
       * 不做任何写操作。默认关，不影响常规冒烟。
       */
      if (process.env.CLAUDE_DESKTOP_SKILLS_LIST === '1') {
        const st = await exec(`window.api.skills.state()`);
        console.log('LIST available=' + st.available + ' enabled=' + st.enabled.length
          + ' disabled=' + st.disabled.length + ' root=' + st.skillsRoot);
        for (const it of st.enabled) {
          console.log('  · ' + it.name + '  [skillMd=' + it.hasSkillMd + ' files=' + it.files + ']');
          console.log('    desc: ' + (it.desc || '(空)'));
        }
        const withDesc = st.enabled.filter((x) => x.desc).length;
        sc('巡检：解析出的描述不是空的（占比 > 80%）',
          withDesc / Math.max(1, st.enabled.length) > 0.8,
          withDesc + '/' + st.enabled.length);
        sc('巡检：描述里没有把 frontmatter 的键名（如 description:）当正文吐出来',
          !st.enabled.some((x) => /^(name|description|agent_created)\s*:/.test(x.desc || '')),
          JSON.stringify(st.enabled.filter((x) => /^(name|description|agent_created)\s*:/.test(x.desc || '')).map((x) => [x.name, x.desc])));
        sc('巡检：没有技能的描述是被截断的 YAML 标记（| 或 >）',
          !st.enabled.some((x) => /^[|>][-+]?\s*$/.test(x.desc || '')),
          JSON.stringify(st.enabled.filter((x) => /^[|>]/.test(x.desc || '')).map((x) => [x.name, x.desc])));

        // ---- 中文简介：面板上到底还有没有"看不懂的英文" ----
        // 直接从 **DOM** 反推覆盖率，不去访问渲染进程的内部变量
        // （SKILL_ZH 是 app.js 的 IIFE 私有常量，外面拿不到 —— 也正因为拿不到，
        //   才不该为了测试把它挂到 window 上：那是往产品里塞测试钩子）。
        // 判据：每张卡片都该有 .sk-desc.zh；有中文的卡片数 == 卡片总数 即 100% 覆盖。
        await exec(`document.querySelector('#btnSkills').click(); true`);
        await sleep(700);
        const cardZh = await exec(`(function(){
          var cards = document.querySelectorAll('.sk-card');
          var zhTexts = document.querySelectorAll('.sk-desc.zh');
          var enTexts = document.querySelectorAll('.sk-desc-en');
          var badges = document.querySelectorAll('.sk-badge.tr');
          // 逐卡检查：哪些卡片没渲染出中文
          var noZh = [];
          cards.forEach(function (c) {
            if (!c.querySelector('.sk-desc.zh')) {
              var nm = c.querySelector('.sk-name');
              noZh.push(nm ? nm.textContent : '?');
            }
          });
          var first = cards[0];
          return {
            cards: cards.length,
            zhCount: zhTexts.length,
            enCount: enTexts.length,
            badgeCount: badges.length,
            noZh: noZh,
            sampleZh: first && first.querySelector('.sk-desc.zh') ? first.querySelector('.sk-desc.zh').textContent : null,
            sampleEn: first && first.querySelector('.sk-desc-en') ? first.querySelector('.sk-desc-en').textContent.slice(0, 60) : null,
            zhFont: zhTexts.length ? parseFloat(getComputedStyle(zhTexts[0]).fontSize) : 0,
            enFont: enTexts.length ? parseFloat(getComputedStyle(enTexts[0]).fontSize) : 0,
          };
        })()`);
        console.log('ZH 卡片渲染：' + JSON.stringify(cardZh).slice(0, 400));
        sc('中文简介：每张卡片都渲染出了中文说明（没有看不懂的英文简介）',
          cardZh.cards > 0 && cardZh.noZh.length === 0,
          '共 ' + cardZh.cards + ' 张，缺中文 ' + cardZh.noZh.length + ' 张：' + cardZh.noZh.join(', '));
        sc('中文简介：中文条数与卡片数一致（不是只翻译了一部分）',
          cardZh.zhCount === cardZh.cards, 'zh=' + cardZh.zhCount + ' cards=' + cardZh.cards);
        sc('中文简介：中文占主位（字号不小于英文原文那行）',
          cardZh.zhFont >= cardZh.enFont && cardZh.zhFont > 0,
          'zh=' + cardZh.zhFont + 'px en=' + cardZh.enFont + 'px');
        sc('中文简介：卡片上有「中文」标记',
          cardZh.badgeCount === cardZh.cards, 'badges=' + cardZh.badgeCount);
        sc('中文简介：原文也保留着（中文看不懂时能对照）',
          cardZh.enCount === cardZh.cards, 'en=' + cardZh.enCount);
        await exec(`document.querySelector('#btnCloseSkills').click(); true`);
        await sleep(200);

        for (const r of sr) console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.name + (r.ok || !r.detail ? '' : '   ← ' + r.detail));
        results.push(...sr);
        const failed0 = results.filter((r) => !r.ok);
        console.log('\nSMOKE: 通过 ' + (results.length - failed0.length) + ' 项，失败 ' + failed0.length + ' 项');
        if (failed0.length) console.log('失败项: ' + failed0.map((f) => f.name).join('; '));
        console.log('SMOKE_RESULT=' + (failed0.length ? 'FAIL' : 'PASS'));
        if (engine) { engine.dispose('probe-done'); engine = null; }
        app.exit(0);
        return;
      }

      /**
       * 全流程开关：CLAUDE_DESKTOP_SKILLS_REAL=1 时，对**当前根目录下的所有技能**
       * 做一次「全部停用 → 全部恢复」，并用 sha256 逐文件比对操作前后是否一致。
       * 用在真实技能目录的**副本**上，验证真实数据（27 个技能、259 个文件）也扛得住。
       */
      if (process.env.CLAUDE_DESKTOP_SKILLS_REAL === '1') {
        const print = (root) => {
          const acc = {};
          const walk = (dir, rel) => {
            let ents = [];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              const r = rel ? rel + '/' + e.name : e.name;
              const p = path.join(dir, e.name);
              if (e.isDirectory()) walk(p, r);
              else { try { acc[r] = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { acc[r] = 'ERR'; } }
            }
          };
          walk(root, '');
          return acc;
        };
        const b4 = print(SKILLS_ROOT);
        const st = await exec(`window.api.skills.state()`);
        const names = st.enabled.map((x) => x.name);
        console.log('REAL: 根目录 ' + st.skillsRoot + '，' + names.length + ' 个技能，'
          + Object.keys(b4).length + ' 个文件');

        const d = await exec(`window.api.skills.disable(${JSON.stringify(names)})`);
        sc('真实数据：全部停用成功', !!d && d.ok === true, JSON.stringify(d && d.results.filter((x) => !x.ok)));
        sc('真实数据：停用后 skills/ 空、停用区满',
          d.state.enabled.length === 0 && d.state.disabled.length === names.length,
          'en=' + d.state.enabled.length + ' dis=' + d.state.disabled.length);
        sc('真实数据：停用后 skills/ 目录里确实没有子目录了',
          fs.readdirSync(SKILLS_ROOT).filter((n) => !n.startsWith('.')).length === 0);

        const e2 = await exec(`window.api.skills.enable(${JSON.stringify(names)})`);
        sc('真实数据：全部恢复成功', !!e2 && e2.ok === true, JSON.stringify(e2 && e2.results.filter((x) => !x.ok)));
        const af = print(SKILLS_ROOT);
        sc('★ 真实数据：259 个文件往返之后逐文件 sha256 完全一致',
          JSON.stringify(af) === JSON.stringify(b4),
          'before=' + Object.keys(b4).length + ' after=' + Object.keys(af).length
          + ' diff=' + JSON.stringify(Object.keys(b4).filter((k) => b4[k] !== af[k]).slice(0, 5)));

        for (const r of sr) console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.name + (r.ok || !r.detail ? '' : '   ← ' + r.detail));
        results.push(...sr);
        const f1 = results.filter((r) => !r.ok);
        console.log('\nSMOKE: 通过 ' + (results.length - f1.length) + ' 项，失败 ' + f1.length + ' 项');
        if (f1.length) console.log('失败项: ' + f1.map((f) => f.name).join('; '));
        console.log('SMOKE_RESULT=' + (f1.length ? 'FAIL' : 'PASS'));
        if (engine) { engine.dispose('probe-done'); engine = null; }
        app.exit(0);
        return;
      }

      // 造 3 个假技能：一个正常、一个没 SKILL.md、一个带 frontmatter 描述。
      // 用真的 SKILL.md 内容，才能顺带验描述解析。
      const mk = (name, skillMd) => {
        const d = path.join(SKILLS_ROOT, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'README.txt'), 'payload of ' + name + '\n');
        if (skillMd !== null) fs.writeFileSync(path.join(d, 'SKILL.md'), skillMd);
      };
      mk('zz-demo-one', '---\nname: zz-demo-one\ndescription: 演示用的技能一，用来验证停用与恢复。\n---\n\n# Demo One\n\n正文若干。\n');
      mk('zz-demo-two', '---\nname: zz-demo-two\ndescription: |\n  折行描述：\n  第二行也要被读出来。\n---\n\n正文。\n');
      mk('zz-demo-bare', null);

      /** 整棵树的字节级指纹：{相对路径 → sha256}，而不是数文件个数。
       *  数个数会把"内容被换了但文件数没变"这种灾难性错误放过去。 */
      const treePrint = (root) => {
        const acc = {};
        const walk = (dir, rel) => {
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const r = rel ? rel + '/' + e.name : e.name;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, r);
            else {
              try {
                acc[r] = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
              } catch { acc[r] = 'ERR'; }
            }
          }
        };
        walk(root, '');
        return acc;
      };

      const beforePrint = treePrint(SKILLS_ROOT);
      const st0 = await exec(`window.api.skills.state()`);
      sc('技能管家：IPC 能取到状态且识别出 3 个技能',
        !!st0 && st0.available === true && st0.enabled.length === 3,
        'available=' + (st0 && st0.available) + ' n=' + (st0 && st0.enabled.length));
      sc('技能管家：SKILL.md 的 frontmatter 描述被解析出来了',
        !!(st0 && st0.enabled.find((x) => x.name === 'zz-demo-one' && /演示用的技能一/.test(x.desc))),
        JSON.stringify((st0 && st0.enabled || []).map((x) => [x.name, x.desc])).slice(0, 260));
      sc('技能管家：折行（| 块）描述也能读全',
        !!(st0 && st0.enabled.find((x) => x.name === 'zz-demo-two' && /第二行/.test(x.desc))),
        JSON.stringify((st0 && st0.enabled.find((x) => x.name === 'zz-demo-two') || {}).desc));
      sc('技能管家：没有 SKILL.md 的目录被标出来（而不是当普通技能混过去）',
        !!(st0 && st0.enabled.find((x) => x.name === 'zz-demo-bare' && x.hasSkillMd === false)));

      // ---- 路径穿越：这是本轮最该守住的一条 ----
      // 名字来自渲染进程 = 不可信输入。用 DOM 里那个真实入口试，不走后门。
      const tr1 = await exec(`window.api.skills.disable(['../../../etc'])`);
      sc('路径穿越：带 .. 的名字被拒绝，且没有报成功',
        !!tr1 && tr1.ok === false && tr1.results[0].ok === false,
        JSON.stringify(tr1 && tr1.results).slice(0, 200));
      const tr2 = await exec(`window.api.skills.disable(['a/b'])`);
      sc('路径穿越：带分隔符的名字被拒绝',
        !!tr2 && tr2.results[0].ok === false, JSON.stringify(tr2 && tr2.results).slice(0, 160));
      const tr3 = await exec(`window.api.skills.disable(['..'])`);
      sc('路径穿越：裸 .. 被拒绝', !!tr3 && tr3.results[0].ok === false);
      const tr4 = await exec(`window.api.skills.disable([''])`);
      sc('路径穿越：空名字被拒绝', !!tr4 && tr4.results[0].ok === false);
      sc('路径穿越：穿越尝试之后，技能目录纹丝未动（攻击没留下副作用）',
        JSON.stringify(treePrint(SKILLS_ROOT)) === JSON.stringify(beforePrint));

      // ---- 正向：停用 ----
      const dis = await exec(`window.api.skills.disable(['zz-demo-one','zz-demo-bare'])`);
      sc('停用 2 个技能：都成功', !!dis && dis.ok === true && dis.results.every((r) => r.ok),
        JSON.stringify(dis && dis.results).slice(0, 200));
      sc('停用后：skills/ 里只剩 1 个',
        !!dis && dis.state.enabled.length === 1, 'n=' + (dis && dis.state.enabled.length));
      sc('停用后：skills-disabled/ 里有 2 个（没从界面上消失）',
        !!dis && dis.state.disabled.length === 2, 'n=' + (dis && dis.state.disabled.length));
      sc('停用后：磁盘上 skills/ 确实少了那两个目录',
        !fs.existsSync(path.join(SKILLS_ROOT, 'zz-demo-one')) &&
        fs.existsSync(path.join(SKILLS_DISABLED_ROOT, 'zz-demo-one')));
      sc('停用是「挪」不是「删」：被停用的文件在停用区里完好',
        fs.existsSync(path.join(SKILLS_DISABLED_ROOT, 'zz-demo-one', 'README.txt')) &&
        fs.readFileSync(path.join(SKILLS_DISABLED_ROOT, 'zz-demo-bare', 'README.txt'), 'utf8').includes('payload of zz-demo-bare'));

      // 幂等：再停一次同一个，应该是"本来就停用了"而不是报错
      const disAgain = await exec(`window.api.skills.disable(['zz-demo-one'])`);
      sc('重复停用是幂等的（报 skipped，不当失败）',
        !!disAgain && disAgain.ok === true && !!disAgain.results[0].skipped,
        JSON.stringify(disAgain && disAgain.results).slice(0, 160));

      // ---- 恢复：必须字节级还原 ----
      const en = await exec(`window.api.skills.enable(['zz-demo-one','zz-demo-bare'])`);
      sc('全部恢复：都成功', !!en && en.ok === true, JSON.stringify(en && en.results).slice(0, 200));
      const afterPrint = treePrint(SKILLS_ROOT);
      sc('★ 恢复后 skills/ 与操作前**逐文件 sha256 完全一致**（可逆性）',
        JSON.stringify(afterPrint) === JSON.stringify(beforePrint),
        'before=' + Object.keys(beforePrint).length + ' files, after=' + Object.keys(afterPrint).length + ' files');
      sc('恢复后：停用区空了',
        fs.existsSync(SKILLS_DISABLED_ROOT) &&
        fs.readdirSync(SKILLS_DISABLED_ROOT).filter((n) => !n.startsWith('.')).length === 0);
      const enAgain = await exec(`window.api.skills.enable(['zz-demo-one'])`);
      sc('重复恢复也是幂等的（报 skipped，不当失败）',
        !!enAgain && enAgain.ok === true && !!enAgain.results[0].skipped,
        JSON.stringify(enAgain && enAgain.results).slice(0, 160));

      // ---- 界面：面板真的能打开、卡片真的渲染出来 ----
      await exec(`document.querySelector('#btnSkills').click(); true`);
      await sleep(500);
      const sk = await exec(`(function(){
        var m = document.querySelector('#skillsModal');
        var grid = document.querySelector('#skGrid');
        var cards = document.querySelectorAll('.sk-card');
        var r = m ? m.getBoundingClientRect() : null;
        return {
          open: !!m && !m.hidden,
          modalW: r ? Math.round(r.width) : 0,
          cards: cards.length,
          offCards: document.querySelectorAll('.sk-card.off').length,
          checks: document.querySelectorAll('#skGrid .sk-check').length,
          hasPower: !!document.querySelector('.sk-act'),
          counts: (document.querySelector('#skCounts') || {}).textContent || '',
          rootPath: (document.querySelector('#skRootPath') || {}).textContent || '',
          note: (document.querySelector('#skNote') || {}).textContent || '',
          restoreHidden: (document.querySelector('#btnRestoreAll') || {}).hidden,
          restoreRect: (function () {
            var b = document.querySelector('#btnRestoreAll');
            if (!b) return [0, 0, 0, 0];
            var r = b.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          })(),
          bulkHidden: (document.querySelector('#skBulk') || {}).hidden,
          bulkRect: (function () {
            var b = document.querySelector('#skBulk');
            if (!b) return [0, 0, 0, 0];
            var r = b.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          })(),
        };
      })()`);
      sc('技能面板能打开且有宽度（不是 hidden 的装饰品）',
        sk.open && sk.modalW > 400, JSON.stringify({ open: sk.open, w: sk.modalW }));
      sc('技能卡片渲染了 3 张，每张都有勾选框和操作按钮',
        sk.cards === 3 && sk.checks === 3 && sk.hasPower,
        'cards=' + sk.cards + ' checks=' + sk.checks);
      sc('计数行说的是人话（含「启用中」）', /启用中/.test(sk.counts), sk.counts);
      sc('页面上写清了「停用不删文件」', /不删|不删|挪到/.test(sk.note), sk.note.slice(0, 100));
      // ★ 用**几何尺寸**判隐藏，不只读 hidden 属性。
      //   属性为 true 但 CSS 把它又显示出来的情况真实存在：作者样式表的
      //   .btn{...} 与 UA 的 [hidden]{display:none} 特异度相同，谁声明了 display
      //   谁说了算。只断言 elem.hidden 会把"看得见却以为藏了"放过去。
      sc('没有停用项时「全部恢复」按钮真的看不见（几何尺寸为 0）',
        sk.restoreHidden === true && sk.restoreRect[2] === 0 && sk.restoreRect[3] === 0,
        JSON.stringify({ hidden: sk.restoreHidden, rect: sk.restoreRect }));
      sc('没有勾选时批量条真的看不见（几何尺寸为 0）',
        sk.bulkHidden === true && sk.bulkRect[3] === 0,
        JSON.stringify({ hidden: sk.bulkHidden, rect: sk.bulkRect }));

      // 勾一个 → 批量条出现；再点「取消选择」→ 又隐藏
      // 挑一个**启用中**的勾（此时停用按钮该出现、恢复按钮该藏起来）
      const pickOn = await exec(`(function(){
        var cards = document.querySelectorAll('#skGrid .sk-card');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].classList.contains('off')) continue;
          var c = cards[i].querySelector('.sk-check');
          c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      })()`);
      await sleep(250);
      const bulkOn = await exec(`(function(){
        var b = document.querySelector('#skBulk');
        var r = b.getBoundingClientRect();
        var d = document.querySelector('#btnSkBulkDisable');
        var en = document.querySelector('#btnSkBulkEnable');
        return {
          hidden: b.hidden, n: (document.querySelector('#skBulkN')||{}).textContent,
          h: Math.round(r.height),
          disableShown: !d.hidden && d.getBoundingClientRect().height > 0,
          enableShown: !en.hidden && en.getBoundingClientRect().height > 0,
        };
      })()`);
      sc('勾选后批量条出现（有真实高度）并显示选中数量',
        pickOn && bulkOn.hidden === false && bulkOn.h > 20 && bulkOn.n === '1',
        JSON.stringify(bulkOn));
      // 只勾了启用中的技能 → 只该出现「停用选中」，「恢复选中」应当藏起来
      sc('批量条按选中项状态显隐：只勾启用项时只出现「停用选中」',
        bulkOn.disableShown === true && bulkOn.enableShown === false,
        JSON.stringify({ disableShown: bulkOn.disableShown, enableShown: bulkOn.enableShown }));

      // 换成勾一个**已停用**的 → 该反过来。
      // ★ 注意：走到这里时上面那几步已经把停用项全恢复了，界面上**没有** .off 卡片。
      //   所以得先真的停用一个，再重开面板 —— 否则这段断言是在一个不存在的前提上做，
      //   会以"勾不上任何东西"的方式假失败（我第一次就是这么写错的）。
      await exec(`window.api.skills.disable(['zz-demo-one'])`);
      await sleep(300);
      await exec(`document.querySelector('#btnSkRefresh').click(); true`);
      await sleep(500);
      const pickOff = await exec(`(function(){
        document.querySelectorAll('#skGrid .sk-check').forEach(function (c) {
          c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
        });
        var cards = document.querySelectorAll('#skGrid .sk-card');
        for (var i = 0; i < cards.length; i++) {
          if (!cards[i].classList.contains('off')) continue;
          var c = cards[i].querySelector('.sk-check');
          c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      })()`);
      await sleep(300);
      const bulkOffSel = await exec(`(function(){
        var d = document.querySelector('#btnSkBulkDisable');
        var en = document.querySelector('#btnSkBulkEnable');
        return {
          disableShown: !d.hidden && d.getBoundingClientRect().height > 0,
          enableShown: !en.hidden && en.getBoundingClientRect().height > 0,
          n: (document.querySelector('#skBulkN')||{}).textContent,
        };
      })()`);
      sc('批量条按选中项状态显隐：只勾停用项时只出现「恢复选中」',
        pickOff === true && bulkOffSel.disableShown === false && bulkOffSel.enableShown === true,
        JSON.stringify(bulkOffSel) + ' pickOff=' + pickOff);

      await exec(`document.querySelector('#btnSkBulkClear').click(); true`);
      await sleep(250);
      const bulkOff = await exec(`(function(){
        var b = document.querySelector('#skBulk');
        return { hidden: b.hidden, h: Math.round(b.getBoundingClientRect().height),
                 checked: document.querySelectorAll('#skGrid .sk-check:checked').length };
      })()`);
      sc('点「取消选择」后批量条真的消失（高度归 0）且勾选被清空',
        bulkOff.hidden === true && bulkOff.h === 0 && bulkOff.checked === 0, JSON.stringify(bulkOff));

      await exec(`document.querySelector('#btnCloseSkills').click(); true`);
      await sleep(200);
      sc('面板能关掉', await exec(`document.querySelector('#skillsModal').hidden === true`));

      // ---- 收尾：把测试造的假技能清掉，不给用户留垃圾 ----
      // （这里是**测试自己造的**目录，删掉才是干净；用户真实技能不在此列）
      for (const zone of [SKILLS_ROOT, SKILLS_DISABLED_ROOT]) {
        for (const n of ['zz-demo-one', 'zz-demo-two', 'zz-demo-bare']) {
          const p = path.join(zone, n);
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
      }
      sc('测试造的假技能已清理干净（真实技能目录没留下测试残留）',
        !fs.existsSync(path.join(SKILLS_ROOT, 'zz-demo-one')) &&
        !fs.existsSync(path.join(SKILLS_DISABLED_ROOT, 'zz-demo-one')));

      for (const r of sr) {
        console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.name + (r.ok || !r.detail ? '' : '   ← ' + r.detail));
      }
      results.push(...sr);
    } else {
      console.log('\n--- B2 技能管家：本轮已跳过（未设 CLAUDE_DESKTOP_SKILLS_ROOT，不拿真实技能目录做实验）---');
    }

    const failed = results.filter((r) => !r.ok);
    console.log('\n============================================');
    console.log('SMOKE: 通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
    if (failed.length) console.log('失败项: ' + failed.map((f) => f.name).join('; '));
    console.log('SMOKE_RESULT=' + (failed.length ? 'FAIL' : 'PASS'));
  } catch (err) {
    console.log('SMOKE_RESULT=FAIL');
    console.log('异常: ' + (err && err.stack || err));
  }

  if (engine) { engine.dispose('smoke-done'); engine = null; }
  app.exit(0);
}


// ------------------------------------------------------------------ 截图模式

/**
 * --shot：抓一组界面 PNG 到 _probe/shots/，用来**用眼睛验收布局**。
 * 全程不弹窗（窗口保持 hidden）。
 */
async function runShots() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = path.join(__dirname, '_probe', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  const shot = async (name) => {
    // 先丢掉一帧再抓。hidden 窗口下第一次 capturePage 常常返回**上一帧**
    // （实测：切到浅色主题后抓到的还是深色图，两个 PNG 字节数一模一样）。
    // 丢掉一帧、让合成器先走一次，之后拿到的才是当前状态。
    await win.webContents.capturePage();
    await sleep(150);
    const img = await win.webContents.capturePage();
    const p = path.join(outDir, name + '.png');
    fs.writeFileSync(p, img.toPNG());
    const s = img.getSize();
    console.log('SHOT ' + name + '  ' + s.width + 'x' + s.height + '  ' +
      fs.statSync(p).size + ' bytes');
  };
  const sendText = (text) => exec(`(function(){
    var ta = document.querySelector('#input');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btnSend').click();
    return true;
  })()`);
  const waitIdle = async (maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(300);
      const meta = await exec(`(function(){
        var b = document.querySelectorAll('.msg.assistant .body');
        var last = b[b.length - 1];
        return last && last.querySelector('.meta-line') ? last.querySelector('.meta-line').innerText : '';
      })()`);
      if (meta) return true;
    }
    return false;
  };

  /**
   * 弹层到底开没开，别靠肉眼从小图里猜 —— 把 hidden / display / 位置 / 背景色
   * 和页面里捕获到的异常一起回读出来。截图第一次就吃了这个亏：
   * 我以为"没打开"，其实需要的是这几个数字。
   */
  const diag = async (label) => {
    const d = await exec(`(function(){
      var m = document.querySelector('#modal');
      var ps = document.querySelectorAll('.popover');
      var p = ps[ps.length - 1];
      var cs = p ? getComputedStyle(p) : null;
      var r = p ? p.getBoundingClientRect() : null;
      return JSON.stringify({
        theme: document.documentElement.dataset.theme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        modalHidden: m ? m.hidden : null,
        modalDisplay: m ? getComputedStyle(m).display : null,
        popovers: ps.length,
        popRect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        popPos: cs ? cs.position : null,
        popZ: cs ? cs.zIndex : null,
        popBg: cs ? cs.backgroundColor : null,
        popOpacity: cs ? cs.opacity : null,
        errs: window.__err || []
      });
    })()`);
    console.log('DIAG[' + label + '] ' + d);
    return d;
  };

  try {
    await exec(`window.__err = [];
      window.addEventListener('error', function (e) { window.__err.push(String(e.message)); });
      true`);

    // 等 boot() 把会话建出来
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const ready = await exec(`(function(){
        var c = document.querySelector('#cwdLabel');
        return !!document.querySelector('#convList') && !!c && c.textContent.trim() !== '\u2026';
      })()`);
      if (ready) break;
    }
    await sleep(700);

    /* ---- 先把演示档案建出来 ----
     * 必须在所有截图之前：空态只能看出「没有档案」，看不出列表排版、按钮换行、
     * 深浅色对比这些真正会出问题的地方。
     * 全部是构造数据（假令牌），最后会删干净，不会影响后面的真实回合。
     */
    await exec(`(async function(){
      await window.api.profiles.save({ activate: false, name: 'DeepSeek', category: 'cn_official',
        websiteUrl: 'https://platform.deepseek.com',
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
               ANTHROPIC_AUTH_TOKEN: 'sk-demo-0f3a9c1b7e5d2648',
               ANTHROPIC_MODEL: 'deepseek-flash',
               ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-pro',
               ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
               ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
               CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash' } });
      await window.api.profiles.save({ activate: false, name: 'Kimi（Moonshot）', category: 'cn_official',
        env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
               ANTHROPIC_AUTH_TOKEN: 'sk-demo-7c2e5a90b1d4f683',
               ANTHROPIC_MODEL: 'kimi-k2.7-code',
               ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code' } });
      await window.api.profiles.save({ activate: true, name: 'DeepSeek（当前）', category: 'cn_official',
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
               ANTHROPIC_AUTH_TOKEN: 'sk-demo-1a2b3c4d5e6f7788',
               ANTHROPIC_MODEL: 'deepseek-flash',
               ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-pro' } });
      return true;
    })()`);
    await sleep(800);
    await shot('01-welcome');

    // ---- 设置弹层（回到顶部，看整体）----
    await exec(`document.querySelector('#btnSettings').click(); true`);
    await sleep(600);
    await exec(`document.querySelector('.modal-body').scrollTop = 0; true`);
    await sleep(250);
    await diag('settings');
    await shot('02-settings');
    await exec(`document.querySelector('#btnCloseModal').click()`);
    await sleep(400);
    await diag('settings-closed');

    // ---- 顶栏「配置 · 模型」菜单 ----
    await exec(`document.querySelector('#chipModel').click()`);
    await sleep(500);
    await diag('model-menu');
    await shot('03-model-menu');
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(350);

    // ---- 设置里的档案区 ----
    await exec(`document.querySelector('#btnSettings').click(); true`);
    await sleep(500);
    await exec(`document.querySelector('#secProfiles').scrollIntoView({ block: 'start' }); true`);
    await sleep(500);
    await diag('profiles');
    await shot('04-profiles');

    // ---- 编辑器（展开态，看表单排版）----
    await exec(`(function(){
      var rows = document.querySelectorAll('.prof-item');
      for (var i = 0; i < rows.length; i++) {
        if (/^DeepSeek\\b/.test(rows[i].innerText)) {
          var bs = rows[i].querySelectorAll('.prof-acts .btn');
          for (var j = 0; j < bs.length; j++) if (bs[j].textContent === '编辑') { bs[j].click(); return true; }
        }
      }
      return false;
    })()`);
    await sleep(700);
    await exec(`document.querySelector('#profEditor').scrollIntoView({ block: 'start' }); true`);
    await sleep(400);
    await diag('profile-editor');
    await shot('05-profile-editor');
    // 顺带验证「测试连接」在这个假配置上会得到一条可读的失败信息（而不是静默无事）
    await exec(`(function(){
      var bs = document.querySelectorAll('#profEditor .prof-actions .btn');
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent === '测试连接') { bs[i].click(); return true; }
      return false;
    })()`);
    await sleep(3500);
    const testNote = await exec(`(function(){
      var e = document.querySelector('#profEditor .prof-test');
      return e ? e.textContent : '';
    })()`);
    console.log('DIAG[profile-test] ' + JSON.stringify(testNote));
    await shot('06-profile-test');
    await exec(`document.querySelector('#btnCloseModal').click()`);
    await sleep(500);

    // ---- 技能管家面板（有停用项 + 有勾选的完整形态）----
    // 先造两个假技能并停用一个，才能拍到"停用态卡片 + 全部恢复按钮"的真实样子。
    // 只动重定向后的临时目录；没设 CLAUDE_DESKTOP_SKILLS_ROOT 时整段跳过。
    if (process.env.CLAUDE_DESKTOP_SKILLS_ROOT) {
      for (const [n, md] of [
        ['zz-shot-alpha', '---\nname: zz-shot-alpha\ndescription: 截图用的技能甲 —— 验证卡片排版、描述换行与停用态样式。\n---\n\n正文。\n'],
        ['zz-shot-beta', '---\nname: zz-shot-beta\ndescription: 截图用的技能乙。\n---\n\n正文。\n'],
        ['zz-shot-gamma', null],
      ]) {
        const d = path.join(SKILLS_ROOT, n);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'README.md'), 'shot fixture\n');
        if (md) fs.writeFileSync(path.join(d, 'SKILL.md'), md);
      }
      fs.mkdirSync(SKILLS_DISABLED_ROOT, { recursive: true });
      const disSrc = path.join(SKILLS_ROOT, 'zz-shot-beta');
      if (fs.existsSync(disSrc)) fs.renameSync(disSrc, path.join(SKILLS_DISABLED_ROOT, 'zz-shot-beta'));
    }

    await exec(`document.querySelector('#btnSkills').click(); true`);
    await sleep(800);
    console.log('DIAG[skills] ' + await exec(`(function(){
      var m = document.querySelector('#skillsModal');
      var c = document.querySelectorAll('.sk-card');
      var r = m ? m.getBoundingClientRect() : null;
      return JSON.stringify({
        open: !!m && !m.hidden,
        w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
        cards: c.length, off: document.querySelectorAll('.sk-card.off').length,
        restoreHidden: (document.querySelector('#btnRestoreAll')||{}).hidden
      });
    })()`));
    await shot('08-skills');
    await exec(`(function(){
      var c = document.querySelectorAll('#skGrid .sk-check');
      if (c.length) { c[0].checked = true; c[0].dispatchEvent(new Event('change', { bubbles: true })); }
      return true;
    })()`);
    await sleep(400);
    await shot('09-skills-selected');
    await exec(`document.querySelector('#btnCloseSkills').click()`);
    await sleep(400);
    // 清理截图夹具（只删我们自己造的）
    for (const zone of [SKILLS_ROOT, SKILLS_DISABLED_ROOT]) {
      for (const n of ['zz-shot-alpha', 'zz-shot-beta', 'zz-shot-gamma']) {
        const p = path.join(zone, n);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      }
    }

    // ---- 权限菜单 ----
    await exec(`document.querySelector('#chipPerm').click()`);
    await sleep(600);
    await diag('permission-menu');
    await shot('07-permission-menu');
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(400);
    await diag('permission-closed');

    // ---- 浅色主题 ----
    // 主题切换按钮在设置弹层里，所以先把弹层打开再点 —— 跟用户的实际路径一致。
    // （另外：按钮上是 data-value，不是 data-theme，我第一版截图的脚本写错成
    //   data-theme，于是"切了浅色"其实一个都没点上，白白多跑了一轮。）
    await exec(`document.querySelector('#btnSettings').click(); true`);
    await sleep(400);
    await exec(`(function(){
      var b = document.querySelectorAll('#segTheme button');
      for (var i = 0; i < b.length; i++) if (b[i].dataset.value === 'light') b[i].click();
      return true;
    })()`);
    await sleep(900);
    await exec(`document.querySelector('.modal-body').scrollTop = 0; true`);
    await sleep(300);
    await diag('light-theme');
    await shot('08-settings-light');
    await exec(`document.querySelector('#secProfiles').scrollIntoView({ block: 'start' }); true`);
    await sleep(500);
    await shot('09-profiles-light');
    await exec(`document.querySelector('#btnCloseModal').click()`);
    await sleep(500);
    await shot('10-welcome-light');
    // 浅色下的模型菜单也要看一眼（弹层用的是 --bg-elev，两个主题差别最大的地方）
    await exec(`document.querySelector('#chipModel').click()`);
    await sleep(500);
    await shot('11-model-menu-light');
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(350);
    await exec(`document.querySelector('#btnSettings').click(); true`);
    await sleep(400);
    await exec(`(function(){
      var b = document.querySelectorAll('#segTheme button');
      for (var i = 0; i < b.length; i++) if (b[i].dataset.value === 'dark') b[i].click();
      return true;
    })()`);
    await sleep(600);
    await exec(`document.querySelector('#btnCloseModal').click()`);
    await sleep(500);

    // ---- 收尾：删掉演示档案 ----
    // 必须在真实回合之前：那几条是假令牌，留着会让后面两轮必然 401。
    await exec(`(async function(){
      var st = await window.api.profiles.state();
      for (var i = 0; i < st.items.length; i++) await window.api.profiles.remove(st.items[i].id);
      return true;
    })()`);
    await sleep(500);
    console.log('DIAG[profiles-cleaned] ' + await exec(
      `window.api.profiles.state().then(function(s){ return JSON.stringify({ items: s.items.length, envKeys: s.envKeys }); })`));

    // --ui-only：只迭代界面时跳过两次真实模型调用（省时省钱），界面截图照样出。
    // 要看完整链路就去掉这个参数。
    if (process.argv.includes('--ui-only')) {
      console.log('SHOT_DONE (ui-only，已跳过真实回合)');
      if (engine) { engine.dispose('shot-done'); engine = null; }
      app.exit(0);
      return;
    }

    // ---- 真实回合 1：Markdown ----
    await sendText('用一个二级标题「示例」、一个三项列表、一个 javascript 代码块回答我，代码里打印 hello。不要多余的话。');
    await waitIdle(120000);
    await sleep(900);
    await shot('12-chat-markdown');

    // ---- 真实回合 2：工具卡片 ----
    await sendText('用 Bash 工具执行 echo hello-claude，把返回的原始输出贴出来，并说明你做了什么。');
    await waitIdle(120000);
    await sleep(900);
    await exec(`(function(){
      var t = document.querySelectorAll('.tool');
      if (t.length) t[t.length - 1].querySelector('.tool-head').click();
      return t.length;
    })()`);
    await sleep(500);
    await shot('13-tool-card');
    console.log('DIAG[layout] ' + await exec(`(function(){
      var w = document.querySelector('#threadWrap');
      var ca = document.querySelector('.composer-area');
      var msgs = document.querySelectorAll('.msg');
      var last = msgs[msgs.length - 1];
      return JSON.stringify({
        gap: Math.round(w.scrollHeight - w.scrollTop - w.clientHeight),
        composerTop: ca ? Math.round(ca.getBoundingClientRect().top) : null,
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
        engineState: document.querySelector('#engineState').textContent.trim(),
        engineStateClass: document.querySelector('#engineState').className
      });
    })()`));

    console.log('SHOT_DONE');
  } catch (err) {
    console.log('SHOT_ERROR ' + (err && err.stack || err));
  }
  if (engine) { engine.dispose('shot-done'); engine = null; }
  app.exit(0);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notifySettingsChanged() {
  if (!win || win.isDestroyed()) return;
  try { win.setTitleBarOverlay(overlayColors()); } catch { /* older electron */ }
  nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';
  send('settings:changed', settings);
}

// -------------------------------------------------------------------- engine

function ensureEngine(sessionId) {
  const meta = store.meta(sessionId);
  if (!meta) throw new Error('对话不存在: ' + sessionId);

  if (engine && engineSessionId === sessionId && engine.status.alive) return engine;

  // 切换对话 → 回收上一个引擎（常驻进程占内存，只保留当前这个）
  if (engine) {
    engine.dispose('switched-session');
    engine.removeAllListeners();
    engine = null;
    engineSessionId = null;
  }

  const resolved = resolveClaude(settings.claudeExe);
  if (!resolved) {
    throw new Error(
      '找不到 claude 可执行文件。\n' +
      '已查找：VS Code / Cursor / Trae 扩展目录下的 anthropic.claude-code-*\\resources\\native-binary\\claude.exe\n' +
      '可在「设置」里手动指定路径。'
    );
  }

  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : currentWorkspace();

  // ---- 模型配置档案 ----
  // 实测（2026-09-24，_probe/probe_settings_flag.py）：`--settings <file>` 的优先级
  // 高于用户全局的 ~/.claude/settings.json，所以切换 provider 用不着改用户配置，
  // 只把那份「只含 env 的 settings」指过去就行。
  const launch = profiles ? profiles.engineLaunchArgs(null) : { args: [], settingsFile: null, env: {} };
  const profile = profiles ? profiles.active() : null;
  // 应用设置里的 model 是「档案之上的一层覆盖」：填了就用它，空则听档案的。
  const effectiveModel = settings.model || launch.env.ANTHROPIC_MODEL || null;
  // 覆盖模型名时，env 里也要一起改 —— 因为 claude 读的是 env，
  // 只给 --model 会出现「界面显示 A、请求实际走 B」这种最难查的错位。
  const extraEnv = { ...launch.env };
  if (settings.model && launch.env.ANTHROPIC_MODEL) {
    for (const k of profilesLib.MODEL_SLOTS.main) extraEnv[k] = settings.model;
    // 主模型改了、快速模型还是档案里那家的名字时，一并跟上，避免半套映射
    if (String(launch.env.ANTHROPIC_MODEL) === String(launch.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '')) {
      for (const k of profilesLib.MODEL_SLOTS.haiku) extraEnv[k] = settings.model;
    }
  }

  engine = new ClaudeEngine({
    exe: resolved.exe,
    cwd,
    permissionMode: settings.permissionMode,
    model: effectiveModel,
    resumeId: meta.claudeSessionId || null,
    extraArgs: launch.args,
    extraEnv,
    label: profile ? (profile.name + (effectiveModel ? ' · ' + effectiveModel : '')) : null,
  });
  engineSessionId = sessionId;

  engine.on('event', (ev) => {
    // 记住 claude 的 session id，下次 --resume 用
    if (ev.type === 'init' && ev.sessionId) {
      store.patch(sessionId, { claudeSessionId: ev.sessionId });
    }
    if (ev.type === 'exit' && !ev.intentional) {
      store.patch(sessionId, { lastExit: { code: ev.code, at: new Date().toISOString() } });
    }
    send('engine:event', { sessionId, ev });
  });

  engine.start();
  return engine;
}

/** 换配置（模型/权限模式/工作目录）后必须重起引擎才生效 */
function recycleEngine(reason) {
  if (!engine) return;
  engine.dispose(reason);
  engine.removeAllListeners();
  engine = null;
  engineSessionId = null;
}

// -------------------------------------------------------------------- skills

/**
 * 技能管家 —— 把 ~/.workbuddy/skills 下的技能「一键停用 / 恢复」。
 *
 * 三条硬约束（都是从既有的 Python 版技能管家搬过来的、踩过坑的结论）：
 *
 *   1. **停用 = 挪目录，不是删除。** `skills/<n>/` → `skills-disabled/<n>/`，
 *      同盘 `fs.renameSync` 是原子的。用户点错了随时能挪回来，且内容一个字节不丢。
 *   2. **停用区必须在被扫描目录之外。** 任何含 SKILL.md 的目录只要还在 `skills/` 里，
 *      就会被技能扫描器当成一个合法技能 —— 停用等于没停用。
 *   3. **路径必须几何校验，不靠清单文件。** 名字来自渲染进程，属于不可信输入。
 *      `safeJoinUnder()` 纯几何判定（拒绝分隔符 / 盘符 / `..`，realpath 必须是
 *      root 的严格子路径），清单被篡改也穿不出去。
 *
 * 另外 file:// 页面受 CSP `connect-src 'none'` 限制发不了网络请求，
 * 所以这里**只能走 IPC**，不能像独立网页版那样起 HTTP 服务。
 *
 * ★ 可重定向：冒烟测试绝不能拿用户真实的技能目录做实验（挪错一下就是几百个
 *   文件离家出走）。CLAUDE_DESKTOP_SKILLS_ROOT 存在时，两个根目录一起改指
 *   到那个临时目录下，被测代码路径一行不改 —— 和真跑时走的是同一段逻辑。
 */
let SKILLS_ROOT = path.join(os.homedir(), '.workbuddy', 'skills');
let SKILLS_DISABLED_ROOT = path.join(os.homedir(), '.workbuddy', 'skills-disabled');
if (process.env.CLAUDE_DESKTOP_SKILLS_ROOT) {
  SKILLS_ROOT = path.join(process.env.CLAUDE_DESKTOP_SKILLS_ROOT, 'skills');
  SKILLS_DISABLED_ROOT = path.join(process.env.CLAUDE_DESKTOP_SKILLS_ROOT, 'skills-disabled');
}

/**
 * 把 name 拼到 root 下，并要求结果**严格**是 root 的子路径。
 * 不合法一律返回 null —— 调用方必须自己判断，不要 catch。
 */
function safeJoinUnder(root, name) {
  if (typeof name !== 'string' || !name) return null;
  // 单个技能名不该长到离谱（Windows 目录名上限 255）
  if (name.length > 200) return null;
  // 分隔符、盘符、`..`、控制字符、Windows 保留名一律拒
  if (/[\\/\0]/.test(name)) return null;
  if (name === '.' || name === '..') return null;
  if (/[:*?"<>|]/.test(name)) return null;
  if (/[\x00-\x1f]/.test(name)) return null;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name)) return null;
  if (name.startsWith('.')) return null;      // 隐藏项（含清单）不给当技能名
  if (/[. ]$/.test(name)) return null;        // Windows 会静默去掉结尾的点/空格

  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, name);
  // 严格子路径：不能等于 root 本身
  if (target === rootAbs) return null;
  if (!target.startsWith(rootAbs + path.sep)) return null;
  return target;
}

/** 一个技能目录里能看出点意思的东西（用于卡片上的说明文字） */
function readSkillMeta(dir) {
  const out = { name: path.basename(dir), desc: '', hasSkillMd: false, files: 0 };
  try {
    out.files = fs.readdirSync(dir).length;
  } catch { /* 读不了就算了，卡片还是照显示 */ }
  const md = path.join(dir, 'SKILL.md');
  if (fs.existsSync(md)) {
    out.hasSkillMd = true;
    try {
      const raw = fs.readFileSync(md, 'utf8');
      // 只读前 8KB —— SKILL.md 可能很长，卡片只要个摘要
      const head = raw.slice(0, 8192);
      out.desc = parseFrontmatterDesc(head);
      if (!out.desc) {
        // 没有 frontmatter（或里面没写 description）就拿正文第一段有意义的文字
        const body = head.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
        const line = body.split(/\r?\n/).find((l) => l.trim() && !/^#/.test(l.trim()));
        if (line) out.desc = line.trim();
      }
    } catch { /* 解析失败就当没描述 */ }
  }
  out.desc = (out.desc || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return out;
}

/**
 * 从 SKILL.md 的 YAML frontmatter 里取 description。
 *
 * 为什么不用一个正则硬扛：我第一版就是那么写的 ——
 *   /^description:\s*([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|\r?\n---|$)/m
 * 在 `description: |` + 缩进折行的情况下，非贪婪的 `[\s\S]*?` 会立刻满足行尾 `$`，
 * 于是捕获到空串；接着代码回退到"抓正文第一行"，卡片上就显示了正文里那句
 * "正文。" —— 描述整个是错的。**测试是抓到了的（它报的就是"读到 正文。"）**，
 * 这不是测试写错，是产品 bug。
 *
 * 改成老老实实逐行扫：识别 `key: value` 与 `key: |` / `key: >` 两种形态，
 * 折行块把后续所有**缩进行**收进来。
 */
function parseFrontmatterDesc(head) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return '';
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!km || km[1] !== 'description') continue;
    let val = km[2].trim();
    // 折行 / 折叠块：`description: |` `description: >` `description: |-` 等
    if (/^[|>][-+]?\d*$/.test(val)) {
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        // 块内每一行都必须缩进；遇到不缩进的就是块结束
        if (lines[j].trim() === '') { block.push(''); continue; }
        if (!/^[ \t]/.test(lines[j])) break;
        block.push(lines[j].replace(/^[ \t]+/, ''));
      }
      return stripYaml(block.join('\n'));
    }
    // 行内值也可能很长，但那就是一行
    return stripYaml(val);
  }
  return '';
}

/** 去掉 YAML 的引号，并把折行块里的换行压成空格 */
function stripYaml(v) {
  let s = String(v || '');
  s = s.replace(/\r?\n\s+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
      (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

/** 列一个根目录下的技能（只看目录，忽略隐藏项 / 清单文件） */
function listSkillsUnder(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;   // 隐藏项与清单文件
    // 符号链接/联接一律跳过：跟进它会穿到 root 外面去，而停用/启用是 rename，
    // 对链接目标的行为不可预期。宁可不显示，也不做危险的事。
    if (e.isSymbolicLink()) continue;
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    // 空目录也列出来 —— 用户可能正想看它为什么没生效
    out.push({ ...readSkillMeta(full), dir: full });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

/**
 * 组装技能面板状态。
 * 关键点：**两个根目录都各自扫一次**。只扫 skills/ 的话，停用区的技能
 * 会从界面上彻底消失（用户会觉得"我明明点了停用，它去哪了"）。
 */
function skillsState() {
  const roots = { skillsRoot: SKILLS_ROOT, disabledRoot: SKILLS_DISABLED_ROOT };
  if (!fs.existsSync(SKILLS_ROOT)) {
    return {
      ...roots, available: false, enabled: [], disabled: [], manifest: null,
      note: '还没有 ' + SKILLS_ROOT + ' 目录 —— 装过技能之后这里才会有内容。',
    };
  }
  const enabled = listSkillsUnder(SKILLS_ROOT);
  const disabled = listSkillsUnder(SKILLS_DISABLED_ROOT);
  return { ...roots, available: true, enabled, disabled };
}

/**
 * 停用：skills/<n> → skills-disabled/<n>
 * 幂等、拒绝覆盖、不删任何东西。
 */
function skillsDisable(names) {
  const results = [];
  if (!fs.existsSync(SKILLS_DISABLED_ROOT)) fs.mkdirSync(SKILLS_DISABLED_ROOT, { recursive: true });
  for (const raw of names || []) {
    const src = safeJoinUnder(SKILLS_ROOT, raw);
    if (!src) { results.push({ name: raw, ok: false, reason: '名字非法，已拒绝（不允许路径分隔符或 ..）' }); continue; }
    const dst = safeJoinUnder(SKILLS_DISABLED_ROOT, raw);
    if (!dst) { results.push({ name: raw, ok: false, reason: '名字非法，已拒绝' }); continue; }
    if (!fs.existsSync(src)) {
      // 本来就停用了 —— 幂等返回成功，别报错吓人
      results.push({ name: raw, ok: true, skipped: '已经处于停用状态' });
      continue;
    }
    if (fs.existsSync(dst)) {
      results.push({ name: raw, ok: false, reason: '停用区已存在同名目录，没有覆盖它。请先手动处理。' });
      continue;
    }
    try {
      fs.renameSync(src, dst);
      results.push({ name: raw, ok: true });
    } catch (err) {
      results.push({ name: raw, ok: false, reason: err.code || String(err) });
    }
  }
  return results;
}

/** 启用：skills-disabled/<n> → skills/<n>（skillsDisable 的逆操作） */
function skillsEnable(names) {
  const results = [];
  if (!fs.existsSync(SKILLS_ROOT)) {
    try { fs.mkdirSync(SKILLS_ROOT, { recursive: true }); } catch { /* 下面逐个报错 */ }
  }
  for (const raw of names || []) {
    const dst = safeJoinUnder(SKILLS_ROOT, raw);
    if (!dst) { results.push({ name: raw, ok: false, reason: '名字非法，已拒绝' }); continue; }
    const src = safeJoinUnder(SKILLS_DISABLED_ROOT, raw);
    if (!src) { results.push({ name: raw, ok: false, reason: '名字非法，已拒绝' }); continue; }
    if (!fs.existsSync(src)) {
      results.push({ name: raw, ok: true, skipped: '本来就处于启用状态' });
      continue;
    }
    if (fs.existsSync(dst)) {
      results.push({ name: raw, ok: false, reason: '技能区已存在同名目录，没有覆盖它。' });
      continue;
    }
    try {
      fs.renameSync(src, dst);
      results.push({ name: raw, ok: true });
    } catch (err) {
      results.push({ name: raw, ok: false, reason: err.code || String(err) });
    }
  }
  return results;
}

/** 目录不存在时也返回 ok=false + note，让界面能给一句人话 */
function openDirSafe(dir, missingNote) {
  if (!fs.existsSync(dir)) return { ok: false, dir, note: missingNote || '目录不存在' };
  shell.openPath(dir);
  return { ok: true, dir };
}

// ------------------------------------------------------------------ profiles

/**
 * 组装界面需要的档案状态。
 *
 * items 里**带着完整 env**（含令牌）：编辑档案时必须回填原值，否则用户每改一次
 * 名字就要重贴一次 key。这是本地渲染进程、contextIsolation 开着、页面不加载任何
 * 远程内容，所以不外泄；列表摘要另外走 describeEnv 的掩码版本。
 */
function profilesState() {
  if (!profiles) {
    return {
      available: false, items: [], activeId: null, presets: [],
      syncGlobal: false, modelOverride: settings ? (settings.model || '') : '',
      effectiveModel: null, envKeys: [], engineRunning: false,
    };
  }
  const st = profiles.uiState();
  const active = profiles.active();
  const launch = profiles.engineLaunchArgs(null);
  return {
    ...st,
    available: true,
    activeName: active ? active.name : null,
    // 界面顶栏显示「真正生效的模型」：设置的覆盖优先，其次档案里写的
    effectiveModel: settings.model || (launch.env && launch.env.ANTHROPIC_MODEL) || null,
    modelOverride: settings.model || '',
    envKeys: Object.keys(launch.env || {}),
    engineRunning: !!(engine && engine.status.alive),
    engineProfile: engine ? engine.status.profile : null,
  };
}

function notifyProfilesChanged() {
  send('profiles:changed', profilesState());
}

/**
 * 让「模型覆盖」跟档案保持一致。
 * 覆盖的模型名如果在新档案里根本不存在（比如覆盖着 deepseek-v4-pro 却切到 Moonshot），
 * 继续留着只会得到一个必然失败的请求，所以这种时候直接清掉、回落到档案自己的模型。
 * @returns {boolean} 是否清掉了覆盖
 */
function syncModelOverrides(profile) {
  if (!profile || !settings.model) return false;
  const vals = Object.values(profile.env || {});
  if (vals.includes(settings.model)) return false;
  settings.model = '';
  saveSettings();
  return true;
}

// ----------------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:boot', () => {
    const resolved = resolveClaude(settings.claudeExe);
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      settings,
      permissionModes: PERMISSION_MODES,
      workspace: currentWorkspace(),
      claude: resolved
        ? { path: resolved.exe, source: resolved.source, ok: true }
        : { path: null, source: null, ok: false, candidates: listCandidates() },
      sessions: store.list(),
      profiles: profilesState(),
      dataDir: app.getPath('userData'),
    };
  });

  ipcMain.handle('sessions:list', () => store.list());

  ipcMain.handle('sessions:create', (_e, { cwd } = {}) => {
    const meta = store.create({ cwd: cwd || currentWorkspace() });
    return { meta, items: [] };
  });

  ipcMain.handle('sessions:get', (_e, { id }) => store.get(id));
  ipcMain.handle('sessions:rename', (_e, { id, title }) => store.rename(id, title));
  ipcMain.handle('sessions:delete', (_e, { id }) => {
    if (engineSessionId === id) {
      if (engine) { engine.dispose('session-deleted'); engine.removeAllListeners(); engine = null; }
      engineSessionId = null;
    }
    store.remove(id);
    return store.list();
  });
  ipcMain.handle('sessions:setItems', (_e, { id, items }) => {
    store.setItems(id, items);
    return store.list();   // 标题/时间可能变了，回给侧边栏刷新
  });

  ipcMain.handle('chat:send', (_e, { sessionId, text }) => {
    const eng = ensureEngine(sessionId);
    const turnId = eng.send(text);
    return { ok: true, turnId, status: eng.status };
  });

  ipcMain.handle('chat:interrupt', () => {
    if (!engine) return { ok: false };
    return { ok: engine.interrupt() };
  });

  ipcMain.handle('engine:status', () => (engine ? engine.status : { alive: false }));

  // ------------------------------------------------------------ 模型配置档案

  ipcMain.handle('profiles:state', () => profilesState());

  /**
   * 新增或保存一条档案。
   * 入参两种形态：
   *   · { simple: {baseUrl, token, model, fastModel, apiKey, extraEnv} } ← 界面表单
   *   · { env: {...} }                                                  ← 导入 / 高级编辑
   */
  ipcMain.handle('profiles:save', (_e, payload) => {
    if (!profiles) return { ok: false, reason: '档案存储未初始化' };
    const p = payload || {};
    const env = p.env && typeof p.env === 'object'
      ? p.env
      : envFromSimple(p.simple || {});
    const saved = profiles.upsert({
      id: p.id,
      name: p.name,
      category: p.category,
      websiteUrl: p.websiteUrl,
      notes: p.notes,
      env,
      source: p.source || 'manual',
    });
    let activated = false;
    if (p.activate) {
      profiles.apply(saved.id);
      syncModelOverrides();
      recycleEngine('profile-activated');
      activated = true;
    }
    notifyProfilesChanged();
    return { ok: true, profile: saved, activated, state: profilesState() };
  });

  ipcMain.handle('profiles:delete', (_e, { id } = {}) => {
    if (!profiles) return { ok: false };
    const wasActive = profiles.activeId === id;
    const ok = profiles.remove(id);
    if (ok && wasActive) recycleEngine('profile-removed');
    notifyProfilesChanged();
    return { ok, wasActive, state: profilesState() };
  });

  /**
   * 切到某条档案。
   * 同时处理「模型覆盖」：如果当前覆盖的模型名在新档案里不存在（例如
   * 覆盖着 deepseek-v4-pro 却切到 Moonshot），继续沿用会让请求必然报
   * 「模型不存在」—— 所以这种情况直接清掉覆盖，回落到新档案自己的模型。
   */
  ipcMain.handle('profiles:activate', (_e, { id } = {}) => {
    if (!profiles) return { ok: false, reason: '档案存储未初始化' };
    const res = profiles.apply(id);
    if (!res.ok) return res;
    const cleared = syncModelOverrides(res.profile);
    recycleEngine('profile-activated');
    notifyProfilesChanged();
    notifySettingsChanged();
    return { ...res, modelOverride: settings.model, overrideCleared: cleared, state: profilesState() };
  });

  ipcMain.handle('profiles:setSyncGlobal', (_e, { value } = {}) => {
    if (!profiles) return { ok: false };
    profiles.syncGlobal = !!value;
    notifyProfilesChanged();
    return { ok: true, syncGlobal: profiles.syncGlobal };
  });

  ipcMain.handle('profiles:test', async (_e, { id, env } = {}) => {
    let target = env;
    if (!target && id && profiles) {
      const p = profiles.get(id);
      target = p ? p.env : null;
    }
    if (!target && profiles) {
      const a = profiles.active();
      target = a ? a.env : null;
    }
    return testProfile(target || {});
  });

  ipcMain.handle('profiles:models', async (_e, { id, env } = {}) => {
    let target = env;
    if (!target && id && profiles) {
      const p = profiles.get(id);
      target = p ? p.env : null;
    }
    if (!target && profiles) {
      const a = profiles.active();
      target = a ? a.env : null;
    }
    const r = await listModels(target || {});
    // 端点不给列表就退回「档案里已经写着的模型名」——总比空列表有用
    if (!r.ok || !r.models.length) {
      const s = simpleFromEnv(target || {});
      const fallback = [s.model, s.fastModel].filter(Boolean);
      return { ...r, fallback, models: r.models && r.models.length ? r.models : fallback };
    }
    return r;
  });

  ipcMain.handle('profiles:importCcSwitch', (_e, { dbPath, makeActive } = {}) => {
    if (!profiles) return { ok: false, reason: '档案存储未初始化' };
    const r = importFromCcSwitch(dbPath);
    if (!r.ok) return r;
    const added = profiles.importItems(r.items, { makeActiveName: makeActive ? r.currentName : undefined });
    if (makeActive && r.currentName) {
      const hit = profiles.list().find((p) => p.name === r.currentName);
      if (hit) { profiles.apply(hit.id); syncModelOverrides(hit); }
    }
    recycleEngine('profile-imported');
    notifyProfilesChanged();
    return { ...r, added, total: profiles.list().length, state: profilesState() };
  });

  ipcMain.handle('profiles:importGlobal', () => {
    if (!profiles) return { ok: false, reason: '档案存储未初始化' };
    const r = importFromGlobal();
    const saved = profiles.upsert({
      name: r.item.name, category: r.item.category, env: r.item.env, source: 'claude-settings',
    });
    notifyProfilesChanged();
    return { ok: true, file: r.file, profile: saved, added: 1, state: profilesState() };
  });

  // 看看用户全局配置里现在是什么（用于「未启用同步时，全局配置仍是老供应商」的提示）
  ipcMain.handle('profiles:globalEnv', () => ({
    file: claudeSettingsPath(),
    summary: describeEnv(profilesLib.readGlobalEnv()),
  }));

  // ------------------------------------------------------------ 技能管家
  //
  // 停用 / 启用都是**挪目录**（同盘 rename，原子），不删任何文件。
  // 名字来自渲染进程，全部先过 safeJoinUnder() 再落盘。

  ipcMain.handle('skills:state', () => skillsState());

  ipcMain.handle('skills:disable', (_e, { names } = {}) => {
    if (!Array.isArray(names) || !names.length) return { ok: false, reason: '没有选中任何技能', results: [] };
    const results = skillsDisable(names);
    return { ok: results.every((r) => r.ok), results, state: skillsState() };
  });

  ipcMain.handle('skills:enable', (_e, { names } = {}) => {
    if (!Array.isArray(names) || !names.length) return { ok: false, reason: '没有选中任何技能', results: [] };
    const results = skillsEnable(names);
    return { ok: results.every((r) => r.ok), results, state: skillsState() };
  });

  ipcMain.handle('skills:reveal', (_e, { name, zone } = {}) => {
    const root = zone === 'disabled' ? SKILLS_DISABLED_ROOT : SKILLS_ROOT;
    const p = name ? safeJoinUnder(root, name) : null;
    if (name && !p) return { ok: false, reason: '名字非法' };
    if (!p || !fs.existsSync(p)) return openDirSafe(root, '目录还不存在');
    shell.showItemInFolder(p);
    return { ok: true, dir: p };
  });

  ipcMain.handle('skills:openRoot', (_e, { zone } = {}) => {
    const root = zone === 'disabled' ? SKILLS_DISABLED_ROOT : SKILLS_ROOT;
    return openDirSafe(root, '这个目录还不存在');
  });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = { ...settings };
    Object.assign(settings, patch || {});
    saveSettings();

    const needsRecycle =
      before.permissionMode !== settings.permissionMode ||
      before.model !== settings.model ||
      before.claudeExe !== settings.claudeExe;
    if (needsRecycle) recycleEngine('settings-changed');

    notifySettingsChanged();
    // 模型覆盖变了，顶栏那个「档案 · 模型」也要跟着变
    if (before.model !== settings.model) notifyProfilesChanged();
    return { settings, recycled: needsRecycle };
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录',
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('clipboard:write', (_e, text) => {
    require('electron').clipboard.writeText(String(text ?? ''));
    return true;
  });

  // 打开 claude 的「项目记忆」目录 —— 新对话为什么会记得旧事实，答案在这
  ipcMain.handle('memory:open', () => {
    const cwd = currentWorkspace();
    const slug = cwd.replace(/[:\\/]/g, '-');
    const dir = path.join(require('os').homedir(), '.claude', 'projects', slug, 'memory');
    if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true, dir }; }
    return { ok: false, dir, note: '该工作目录下还没有记忆文件' };
  });
}

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    loadSettings();
    nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';
    store = new SessionStore(path.join(app.getPath('userData'), 'data')).init();
    // 档案放在应用数据目录里（冒烟测试用一次性 userData 时会自然隔离，
    // 于是冒烟走得是"没有档案 → 继承用户全局配置"这条兜底路径，用的还是真令牌）
    profiles = new ProfilesStore(path.join(app.getPath('userData'), 'profiles')).init();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (engine) { engine.dispose('app-quit'); engine = null; }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (engine) { engine.dispose('app-quit'); engine = null; }
  });
}
