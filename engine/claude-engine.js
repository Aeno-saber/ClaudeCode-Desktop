'use strict';
/**
 * ClaudeEngine — 托管一个常驻的 `claude` 子进程，做双向 stream-json 通信。
 *
 * 为什么用常驻进程而不是「每轮起一个」：
 *   实测（2026-09-24）进程启动 + 初始化约 2.8s，是每轮都要付的固定开销。
 *   常驻模式下首字延迟降到 ~0.8s，且上下文天然保留。
 *
 * 协议（v2.1.278 实测确认，非推测）：
 *   stdin  : {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n
 *   stdout : 每行一个 JSON 对象，类型有
 *            system/init | system/status | stream_event | assistant | user | result
 *
 *   stream_event 是原生 Anthropic SSE 事件：
 *     message_start                      ← 一条新 assistant 消息开始
 *     content_block_start {index, content_block:{type}}
 *     content_block_delta {index, delta:{type}}
 *     content_block_stop  {index}
 *     message_delta / message_stop
 *
 *   ★ 关键坑：content_block 的 index 在**每条 message 周期都会重置**。
 *     所以 block 必须用 (周期号 m, index i) 复合键标识，否则第二轮的
 *     block 0 会覆盖第一轮的 block 0。
 *
 *   ★ 另一个坑：tool_use 的参数是**逐字符**流式的，走 input_json_delta.partial_json，
 *     必须自己拼完再 JSON.parse —— 不能假设它一次到齐。
 *
 *   一轮对话可能包含**多个 message 周期**（调一次工具就多一个周期）。
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

class ClaudeEngine extends EventEmitter {
  /** 开始一轮之后，多久没有输出就判定为卡死（毫秒）。留足余量给慢模型 + 工具执行。 */
  static SILENCE_MS = 150000;

  /**
   * 重试再多也不会变好的状态码 —— 鉴权类，立刻停。
   *
   * ★ 这是实测出来的（2026-09-24）：令牌过期时 claude 会按 10 次指数退避重试
   * （586ms → 1046 → 2234 → 4441 → 8697 → 19517 → 39703 → …），一路加起来
   * 用户要对着「生成中」干等**约十分钟**才看到一句 401。
   * 更糟的是它每几秒吐一行 api_retry，而静默看门狗「每行输出就重置」——
   * 于是看门狗永远不会触发，界面看起来就是彻底卡死。
   */
  static FATAL_STATUSES = new Set([401, 403]);

  /**
   * 非鉴权类失败最多陪它重试多久（毫秒），超了就自己停下报错。
   *
   * 为什么需要这条：地址填错（域名解析不了）时，CLI 拿到的是 **502 server_error**，
   * 看起来像"暂时性故障"，于是照样退避重试十分钟。光靠状态码白名单盖不住这种情况，
   * 所以再加一道"总时长预算"。60 秒还没吐出任何内容，对聊天界面来说已经不叫"在工作"了，
   * 而此时离它放弃还有约 9 分钟。
   */
  static RETRY_BUDGET_MS = 60000;

  /**
   * @param {object} opts
   * @param {string} opts.exe        claude.exe 绝对路径
   * @param {string} opts.cwd        工作目录
   * @param {string} [opts.permissionMode]
   * @param {string|null} [opts.model]
   * @param {string|null} [opts.resumeId]    续接已有 claude session id
   * @param {string[]} [opts.addDirs]
   * @param {string[]} [opts.extraArgs]     额外 CLI 参数（档案模式用来传 --settings / --setting-sources）
   * @param {object}   [opts.extraEnv]      额外环境变量（档案里的 provider 配置）
   * @param {object}   [opts.label]         档案摘要，仅用于日志/事件里显示「当前用的是哪个」
   */
  constructor(opts) {
    super();
    this.opts = {
      exe: opts.exe,
      cwd: opts.cwd || os.homedir(),
      permissionMode: PERMISSION_MODES.includes(opts.permissionMode)
        ? opts.permissionMode : 'acceptEdits',
      model: opts.model || null,
      resumeId: opts.resumeId || null,
      addDirs: opts.addDirs || [],
      extraArgs: Array.isArray(opts.extraArgs) ? opts.extraArgs.slice() : [],
      extraEnv: opts.extraEnv && typeof opts.extraEnv === 'object' ? { ...opts.extraEnv } : {},
      label: opts.label || null,
    };

    this.proc = null;
    this.alive = false;
    this.ready = false;
    this.busy = false;

    this.sessionId = null;
    this.cycle = -1;          // 当前轮内的 message 周期号
    this.blocks = new Map();  // "m:i" -> block
    this.turnSeq = 0;
    this.currentTurn = null;
    this._watchdog = null;
    this._killedByUs = false;
    this._stderrTail = [];
    // 这一轮里 claude 自己开始退避重试的时刻（0 = 没在重试）
    this._retryStartedAt = 0;
    this._retryInfo = null;
    this._retryTimer = null;
    /** _abortTurn 的幂等闸：见 _abortTurn 里的说明 */
    this._aborting = false;
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.proc) return;
    const { exe, cwd, permissionMode, model, resumeId, addDirs } = this.opts;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      // 没有 SDK host 来接权限询问，所以明确声明「没人应答 → 询问类操作自动拒绝」，
      // 具体行为交给 --permission-mode 决定。不声明的话默认是 host，可能挂住。
      '--permission-prompts', 'none',
      '--permission-mode', permissionMode,
    ];
    if (permissionMode === 'bypassPermissions') {
      args.push('--allow-dangerously-skip-permissions');
    }
    if (model) args.push('--model', model);
    for (const d of addDirs) args.push('--add-dir', d);
    // 档案模式：--settings <file> 与 --setting-sources 在这里注入。
    // 实测（2026-09-24）--settings 的优先级高于全局 ~/.claude/settings.json，
    // 所以换 provider 不需要动用户的全局配置。
    for (const a of this.opts.extraArgs) args.push(a);

    if (resumeId) {
      args.push('--resume', resumeId);
    } else {
      this.sessionId = crypto.randomUUID();
      args.push('--session-id', this.sessionId);
    }

    const env = { ...process.env };
    // 沙箱/父进程可能带着这个变量，会让 Electron/Node 系程序行为异常，明确清掉。
    delete env.ELECTRON_RUN_AS_NODE;

    // ★ 档案的 env 必须在最后覆盖。
    // 注意实测结论：settings.json 的 env 会**盖过**进程环境变量，
    // 所以这里注入的主要意义是兜底 + 让 claude 自己读到的环境一致
    // （少数变量如 CLAUDE_CODE_* 只认进程环境）。
    for (const [k, v] of Object.entries(this.opts.extraEnv)) {
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }

    this.emit('event', { type: 'state', state: 'starting', exe, cwd });
    this.emit('event', { type: 'spawn', argv: args, cwd, profile: this.opts.label });

    try {
      this.proc = spawn(exe, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.emit('event', { type: 'error', message: '启动 claude 失败: ' + err.message });
      return;
    }

    this.alive = true;
    this._killedByUs = false;

    this._rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      const t = line.trim();
      if (t) this._handleLine(t);
    });

    const errRl = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });
    errRl.on('line', (line) => {
      const t = line.replace(/\s+$/, '');
      if (!t) return;
      this._stderrTail.push(t);
      if (this._stderrTail.length > 40) this._stderrTail.shift();
      this.emit('event', { type: 'stderr', line: t });
    });

    this.proc.on('error', (err) => {
      this.emit('event', { type: 'error', message: 'claude 进程错误: ' + err.message });
    });

    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      this.ready = false;
      this.busy = false;
      this._clearWatchdog();
      this.emit('event', {
        type: 'exit',
        code,
        signal,
        intentional: this._killedByUs,
        stderrTail: this._stderrTail.slice(-12),
      });
    });

    // 注意：这里**不设**「等待 init 超时」。
    // 实测确认 claude 只在收到第一条 stdin 消息后才发 system/init，
    // 空闲时永远等不到 init —— 那样设超时只会误报。
    // 真正的死锁检测交给 send() 之后启动的静默看门狗。
  }

  /**
   * 静默看门狗：一旦开始了一轮，就在每一行输出后重置计时；
   * 若持续 SILENCE_MS 没有输出，说明进程卡住了，主动报出来
   * （否则 UI 会一直显示「生成中…」，用户不知道发生了什么）。
   */
  _armWatchdog() {
    this._clearWatchdog();
    if (!this.busy) return;
    this._watchdog = setTimeout(() => {
      if (!this.busy) return;
      const tail = this._stderrTail.slice(-6).join('\n');
      this.emit('event', {
        type: 'error',
        message: 'claude 已 ' + (ClaudeEngine.SILENCE_MS / 1000) + ' 秒无任何输出，判定为卡住。\n' +
                 (tail ? 'stderr:\n' + tail : '（stderr 为空）'),
      });
      // 卡死的进程必须清掉，否则下一轮永远发不出去
      this.dispose('watchdog-timeout');
      this.busy = false;
      this.emit('event', { type: 'state', state: 'idle' });
    }, ClaudeEngine.SILENCE_MS);
  }

  _clearWatchdog() {
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  }

  /** 终止进程树（Windows 下 proc.kill 常常杀不干净 claude 拉起的子进程） */
  dispose(reason = 'disposed') {
    this._killedByUs = true;
    this._clearWatchdog();
    this._clearRetryTimer();
    // ★ 必须立刻把 alive 置 false。
    // 'exit' 事件是异步的，如果只等它来改状态，那么从 dispose() 到 exit 之间
    // 存在一个窗口：status.alive 仍为 true，但 proc 已经是 null。
    // 上层（ensureEngine）会据此复用一个空壳引擎，紧接着 send() 抛「引擎未运行」。
    this.alive = false;
    this.ready = false;
    this.busy = false;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) {
      this.proc = null;
      return;
    }
    this.emit('event', { type: 'state', state: 'stopping', reason });
    try {
      if (process.platform === 'win32') {
        // /T 连同子进程一起杀，/F 强制
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      try { proc.kill(); } catch { /* ignore */ }
    }
    this.proc = null;
  }

  /** 中断当前轮：杀进程，但保留 session，下一条消息用 --resume 接回来 */
  interrupt() {
    if (!this.busy) return false;
    const turnId = this.currentTurn;
    this.dispose('interrupted');
    this.busy = false;
    this.emit('event', { type: 'interrupted', turnId });
    this.emit('event', { type: 'state', state: 'idle' });
    return true;
  }

  // -------------------------------------------------------------------- input

  send(text) {
    if (!this.proc || !this.alive) throw new Error('引擎未运行');
    if (this.busy) throw new Error('上一轮还在进行中');
    if (typeof text !== 'string' || !text.trim()) throw new Error('内容为空');

    // ★ 这里**故意不检查 ready**。
    // 实测（2026-09-24）：在 --input-format stream-json 模式下，claude 必须
    // 先收到第一条 stdin 消息才会发 system/init —— 干等的话 20 秒一行输出都没有。
    // 早先写成「等 init 才允许 send」会导致双向死锁：我们等它握手，它等我们输入。
    this.busy = true;
    this.cycle = -1;
    this.blocks.clear();
    // 新一轮开始 → 重试预算重新计时（上一轮的预算不能吃掉这一轮），并放开中止闸
    this._retryStartedAt = 0;
    this._retryInfo = null;
    this._aborting = false;
    this._clearRetryTimer();
    const turnId = ++this.turnSeq;
    this.currentTurn = turnId;

    this.emit('event', { type: 'turn', turnId, phase: 'start', text });

    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      this.busy = false;
      this.emit('event', { type: 'error', message: '写入 stdin 失败: ' + err.message });
      throw err;
    }
    this._armWatchdog();
    this.emit('event', { type: 'state', state: 'busy' });
    return turnId;
  }

  // ------------------------------------------------------------------ parsing

  _handleLine(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      this._armWatchdog();
      this.emit('event', { type: 'raw', line: line.slice(0, 2000) });
      return;
    }

    /**
     * ★ api_retry 不算「有进度」，所以**不重置**静默看门狗。
     *
     * 这条是踩出来的：claude 重试时每几秒必来一行 api_retry，如果照旧处理，
     * 看门狗会被无限续命、永远不触发，界面就成了"永远在生成中"。
     * 正常输出（正文、思考、工具结果）才会重置计时。
     */
    if (!(d.type === 'system' && d.subtype === 'api_retry')) this._armWatchdog();

    switch (d.type) {
      case 'system':
        if (d.subtype === 'init') {
          this.ready = true;
          this.sessionId = d.session_id || this.sessionId;
          this.emit('event', {
            type: 'init',
            sessionId: this.sessionId,
            model: d.model,
            cwd: d.cwd,
            tools: Array.isArray(d.tools) ? d.tools : [],
            permissionMode: d.permissionMode || this.opts.permissionMode,
            apiKeySource: d.apiKeySource,
          });
          this.emit('event', { type: 'state', state: 'idle' });
        } else if (d.subtype === 'api_retry') {
          this._handleApiRetry(d);
        } else {
          this.emit('event', { type: 'system', subtype: d.subtype, data: d });
        }
        break;

      case 'stream_event':
        this._handleStreamEvent(d.event || {});
        break;

      case 'assistant':
        this.emit('event', {
          type: 'message',
          role: 'assistant',
          turnId: this.currentTurn,
          m: Math.max(this.cycle, 0),
          content: (d.message && d.message.content) || [],
          usage: (d.message && d.message.usage) || null,
          model: d.message && d.message.model,
          stopReason: d.message && d.message.stop_reason,
          parentToolUseId: d.parent_tool_use_id || null,
        });
        break;

      case 'user':
        this._handleUserEcho(d);
        break;

      case 'result':
        this._handleResult(d);
        break;

      default:
        this.emit('event', { type: 'unknown', subtype: d.subtype, data: d });
    }
  }

  /**
   * claude 自己发来的重试通知：{"type":"system","subtype":"api_retry",
   *   "attempt":1,"max_retries":10,"retry_delay_ms":586,
   *   "error_status":401,"error":"authentication_failed"}
   *
   * 以前这种事件被当成普通 system 事件**默默丢掉了**，于是用户在界面上
   * 只能看到一个空转的「生成中」。现在把它转成 retry 事件让界面实时显示，
   * 并且：鉴权类立刻停；其余的最多陪它到预算用完。
   */
  _handleApiRetry(d) {
    // 已经中止过这一轮（或正在中止）→ 忽略迟到的重试通知。
    // 杀进程是异步的，taskkill 发出后进程可能还会把缓冲区里剩下的几行吐出来。
    if (this._aborting) return;
    const status = d.error_status != null ? d.error_status : (d.status != null ? d.status : null);
    const attempt = d.attempt || 0;
    const max = d.max_retries || 0;
    if (!this._retryStartedAt) this._retryStartedAt = Date.now();
    this._retryInfo = { status, error: d.error || null, attempt, max };

    this.emit('event', {
      type: 'retry',
      attempt, maxRetries: max, status,
      error: d.error || null,
      delayMs: d.retry_delay_ms || 0,
      elapsedMs: Date.now() - this._retryStartedAt,
      fatal: ClaudeEngine.FATAL_STATUSES.has(status),
    });

    if (ClaudeEngine.FATAL_STATUSES.has(status)) {
      this._abortTurn('auth', status, attempt, max);
      return;
    }
    if (Date.now() - this._retryStartedAt >= ClaudeEngine.RETRY_BUDGET_MS) {
      this._abortTurn('budget', status, attempt, max);
      return;
    }
    // ★ 光靠"下一条重试通知到了再检查"是不够的：重试间隔是指数增长的
    // （…19s、39s、79s…），预算 60 秒可能被拖到第 79 秒才生效。
    // 所以直接用定时器把到点这件事钉死。
    if (!this._retryTimer) {
      const left = Math.max(1000, ClaudeEngine.RETRY_BUDGET_MS - (Date.now() - this._retryStartedAt));
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (!this.busy) return;
        const i = this._retryInfo || {};
        this._abortTurn('budget', i.status, i.attempt, i.max);
      }, left);
    }
  }

  /** 主动结束这一轮并给出人话解释（否则用户只会看到「生成中」永远不结束） */
  _abortTurn(kind, status, attempt, max) {
    /**
     * ★ 幂等保护（2026-09-26 补）。
     *
     * 这个方法有两个入口，可能在同一瞬间都进来：
     *   ① `_handleApiRetry` 里状态码致命 / 预算已超（同步路径）；
     *   ② `_retryTimer` 到点触发（异步路径）。
     * 原先没有这道闸，重复进来会**把同一条错误提示 emit 两遍** ——
     * 界面上就是同一句话叠两条。
     *
     * 更隐蔽的是它还会重复 dispose()：第一次已经把 _retryInfo 清成 null，
     * 第二次算出来的错误文案里"最后错误"就退化成**"未知错误"** ——
     * 用户拿到的信息反而比第一次更少。
     *
     * ★ 这道闸**只在 `send()` 里放开**，不在本方法末尾放开。
     *
     * 这是踩出来的（2026-09-26 第二轮实测）：一开始我把 `_aborting = false`
     * 写在方法末尾"收尾"，结果闸刚立起来就自己放开了，第二次调用照样进来 ——
     * 测试直接抓到 count=2 且第二条写着"未知错误"。
     * 本轮已经终结（进程都被杀了），此处没有"放开"的语义；
     * 下一轮由 send() 显式重置才是正确的位置。
     */
    if (this._aborting) return;
    this._aborting = true;
    /**
     * ★ `_retryStartedAt` 是**毫秒时间戳**（`Date.now()`），不是秒。
     * 下面这个除法原本写成 `Math.floor(Date.now()/1000)`，
     * 于是算出的"连续重试 N 秒"会变成十三位数（实测 1788603174 秒）。
     * 文案是给人看的，数字荒唐比不显示更糟。
     */
    const secs = Math.max(1, Math.round((Date.now() - this._retryStartedAt) / 1000));
    const info = this._retryInfo || {};
    let msg;
    if (kind === 'auth') {
      const head = status === 401
        ? '鉴权失败（401）：令牌无效、已过期，或者它不属于这个地址。'
        : '拒绝访问（403）：令牌没有调用权限，或者地址指向了别的服务。';
      msg = head +
        '\nclaude 默认会指数退避重试 ' + max + ' 次（实测会拖到十分钟以上），已直接停下。' +
        '\n请到「模型配置」里核对地址与令牌；改完可以先点「测试连接」，它会在 1 秒内给出结论。';
    } else {
      const last = info.status != null
        ? info.status + (info.error ? ' ' + info.error : '')
        : (info.error || '未知错误');
      msg = '连续重试 ' + secs + ' 秒仍未成功（已重试 ' + attempt + '/' + max + ' 次，最后错误：' + last + '），已停止重试。' +
        '\n常见原因：地址写错（例如少了 /anthropic 后缀）、域名解析不了、网络不通、或额度用尽。' +
        '\n可以在「模型配置」里点「测试连接」快速定位。';
    }
    // 先清定时器再 dispose：_abortTurn 自己就是被它触发的，
    // 留着它会让"重复中止"的窗口一直敞着（见上方幂等保护的说明）。
    this._clearRetryTimer();
    // dispose 顺带把 alive/ready/busy 归位，保证下一轮能重新拉起引擎。
    this.dispose('retry-abort-' + kind);
    this.busy = false;
    this._retryStartedAt = 0;
    this._retryInfo = null;
    // 注意：这里**不放** `_aborting`。闸只在 send() 里放开。
    this.emit('event', { type: 'error', message: msg });
    this.emit('event', { type: 'state', state: 'idle' });
  }

  _handleStreamEvent(ev) {
    const turnId = this.currentTurn;
    switch (ev.type) {
      case 'message_start':
        this.cycle += 1;
        this.blocks.clear();
        this.emit('event', { type: 'cycle', turnId, m: this.cycle });
        break;

      case 'content_block_start': {
        const cb = ev.content_block || {};
        const key = this.cycle + ':' + ev.index;
        const block = {
          type: cb.type,
          name: cb.name || null,
          id: cb.id || null,
          text: cb.text || '',
          thinking: cb.thinking || '',
          json: '',
          input: cb.input || null,
        };
        this.blocks.set(key, block);
        this.emit('event', {
          type: 'block', op: 'start', turnId, m: this.cycle, i: ev.index,
          block: { type: block.type, name: block.name, id: block.id },
        });
        break;
      }

      case 'content_block_delta': {
        const key = this.cycle + ':' + ev.index;
        const block = this.blocks.get(key);
        const delta = ev.delta || {};
        if (!block) break;
        if (delta.type === 'text_delta') {
          block.text += delta.text || '';
          this.emit('event', { type: 'delta', turnId, m: this.cycle, i: ev.index, kind: 'text', text: delta.text || '' });
        } else if (delta.type === 'input_json_delta') {
          block.json += delta.partial_json || '';
          this.emit('event', { type: 'delta', turnId, m: this.cycle, i: ev.index, kind: 'tool_json', text: delta.partial_json || '' });
        } else if (delta.type === 'thinking_delta') {
          block.thinking += delta.thinking || '';
          this.emit('event', { type: 'delta', turnId, m: this.cycle, i: ev.index, kind: 'thinking', text: delta.thinking || '' });
        } else if (delta.type === 'signature_delta') {
          // DeepSeek 端点只回签名、不回推理正文，这里不产生 UI 事件
        }
        break;
      }

      case 'content_block_stop': {
        const key = this.cycle + ':' + ev.index;
        const block = this.blocks.get(key);
        if (!block) break;
        if (block.type === 'tool_use' && block.json) {
          try {
            block.input = JSON.parse(block.json);
          } catch {
            block.input = { __raw: block.json, __parse_error: true };
          }
        }
        this.emit('event', {
          type: 'block', op: 'stop', turnId, m: this.cycle, i: ev.index,
          block: {
            type: block.type, name: block.name, id: block.id,
            text: block.text, thinking: block.thinking, input: block.input,
          },
        });
        break;
      }

      case 'message_delta':
        this.emit('event', {
          type: 'message_delta', turnId, m: this.cycle,
          stopReason: ev.delta && ev.delta.stop_reason,
          usage: ev.usage || null,
        });
        break;

      case 'message_stop':
        this.emit('event', { type: 'cycle_end', turnId, m: this.cycle });
        break;

      default:
        break;
    }
  }

  _handleUserEcho(d) {
    const content = (d.message && d.message.content) || [];
    if (!Array.isArray(content)) return;
    let hadToolResult = false;
    for (const b of content) {
      if (b && b.type === 'tool_result') {
        hadToolResult = true;
        this.emit('event', {
          type: 'toolresult',
          turnId: this.currentTurn,
          toolUseId: b.tool_use_id,
          isError: !!b.is_error,
          content: b.content,
        });
      }
    }
    if (!hadToolResult) {
      // --replay-user-messages 把用户原话回显了。UI 自己已经渲染过，这里只当投递回执。
      const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      this.emit('event', { type: 'user_echo', turnId: this.currentTurn, text });
    }
  }

  _handleResult(d) {
    const turnId = this.currentTurn;
    this.busy = false;
    this.currentTurn = null;
    this._clearWatchdog();
    this._clearRetryTimer();
    this.emit('event', {
      type: 'result',
      turnId,
      subtype: d.subtype,
      isError: !!d.is_error,
      durationMs: d.duration_ms,
      durationApiMs: d.duration_api_ms,
      numTurns: d.num_turns,
      costUsd: d.total_cost_usd,
      usage: d.usage || null,
      result: typeof d.result === 'string' ? d.result : null,
      sessionId: d.session_id || this.sessionId,
      permissionDenials: d.permission_denials || null,
      errors: d.errors || null,
    });
    this.emit('event', { type: 'state', state: 'idle' });
  }

  // ------------------------------------------------------------------ profile

  /**
   * 运行期切换档案。**必须已经 dispose 过**（或从未 start）才会生效，
   * 因为 env / --settings 只能在 spawn 时决定。
   * 上层（main.js）的做法是：切档案 → recycleEngine() → 下次 send 时用新 opts 重新 spawn。
   */
  setProfile({ extraArgs, extraEnv, label, model } = {}) {
    if (extraArgs !== undefined) {
      this.opts.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    }
    if (extraEnv !== undefined) {
      this.opts.extraEnv = extraEnv && typeof extraEnv === 'object' ? { ...extraEnv } : {};
    }
    if (label !== undefined) this.opts.label = label || null;
    if (model !== undefined) this.opts.model = model || null;
    return this.status;
  }

  get status() {
    return {
      alive: this.alive,
      ready: this.ready,
      busy: this.busy,
      sessionId: this.sessionId,
      permissionMode: this.opts.permissionMode,
      model: this.opts.model,
      cwd: this.opts.cwd,
      pid: this.proc ? this.proc.pid : null,
      profile: this.opts.label,
    };
  }
}

module.exports = { ClaudeEngine, PERMISSION_MODES };
