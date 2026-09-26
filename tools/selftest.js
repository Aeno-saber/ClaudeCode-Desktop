'use strict';
/**
 * headless 自检：不启动 Electron，直接验证三块纯逻辑。
 *
 *   1. find-claude   —— 能不能定位到 claude.exe
 *   2. session-store —— 增删改查与落盘
 *   3. markdown      —— 渲染正确性 + XSS 转义 + 链接协议白名单
 *   4. profiles      —— 档案存储 / env 往返无损 / 只动 env 一个键 / 导入 / 连通性探测
 *   5. claude-engine —— ★ 真的连一次 API，验证：init / 逐字流 / 工具调用 /
 *                       多 message 周期的 block 索引不串位 / 中断
 *
 * 跑法： node tools/selftest.js            （全部）
 *        node tools/selftest.js --no-api   （跳过需要联网的引擎测试）
 *
 * 注意：第 4 节的「写全局配置」一律打在临时文件上，**不会**改动
 *       用户真实的 ~/.claude/settings.json。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NO_API = process.argv.includes('--no-api');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '\n      ' + detail : '')); }
}

function section(t) { console.log('\n== ' + t + ' =='); }

// ------------------------------------------------------------------ 1
function testFind() {
  section('1. find-claude');
  const { resolveClaude, listCandidates } = require('../engine/find-claude');
  const all = listCandidates();
  console.log('  找到 ' + all.length + ' 个候选:');
  for (const c of all.slice(0, 5)) console.log('    - ' + c.exe + '  (' + c.source + ')');
  ok('至少找到一个 claude.exe', all.length > 0);
  const r = resolveClaude();
  ok('resolveClaude() 返回结果', !!r);
  if (r) {
    ok('返回值是真实文件', fs.existsSync(r.exe));
    ok('去掉重名后按 mtime 选最新', all.length === 0 || r.mtime >= all[all.length - 1].mtime);
  }
  const bad = resolveClaude('D:\\definitely\\not\\here\\claude.exe');
  ok('指定不存在的路径时不误报存在', !bad || bad.source !== 'settings');
}

// ------------------------------------------------------------------ 2
function testStore() {
  section('2. session-store');
  const { SessionStore } = require('../engine/session-store');
  const base = path.join(os.tmpdir(), 'cd-selftest-store-' + Date.now());
  const st = new SessionStore(base).init();

  const a = st.create({ cwd: 'C:\\tmp' });
  ok('create 返回 meta 与 id', !!a.id && a.title === '新对话');

  const items = [
    { id: 'i1', kind: 'user', text: '帮我把这段代码改成 CLI 工具' },
    { id: 'i2', kind: 'assistant', status: 'done', blocks: [{ kind: 'text', bid: 'b1', text: '好的' }], meta: {} },
  ];
  st.setItems(a.id, items);
  const got = st.get(a.id);
  ok('setItems / get 往返一致', got.items.length === 2 && got.items[0].text === items[0].text);
  ok('标题按首条用户消息自动命名', /CLI/.test(got.meta.title), 'title=' + got.meta.title);
  ok('预览已生成', !!got.meta.preview);

  st.rename(a.id, '自定义标题');
  ok('rename 生效', st.meta(a.id).title === '自定义标题');

  const b = st.create({});
  st.setItems(b.id, [{ id: 'x', kind: 'user', text: 'b' }]);
  ok('list() 按 updatedAt 倒序（最新的在前）', st.list()[0].id === b.id);

  st.remove(a.id);
  ok('remove 后索引里没有了', !st.meta(a.id));
  ok('remove 后消息文件也没了', !fs.existsSync(path.join(base, 'sessions', a.id + '.json')));

  // 损坏的 index.json 不应让程序崩掉
  fs.writeFileSync(path.join(base, 'index.json'), '{ this is not json');
  const st2 = new SessionStore(base).init();
  ok('index.json 损坏时能优雅恢复', Array.isArray(st2.list()));

  fs.rmSync(base, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 3
function loadMarkdown() {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'markdown.js'), 'utf8');
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'markdown.js' });
  return sandbox.Markdown;
}

function testMarkdown() {
  section('3. markdown');
  const MD = loadMarkdown();
  const has = (src, needle) => MD.render(src).includes(needle);

  ok('标题', has('# A', '<h1>A</h1>'));
  ok('粗体', has('a **b** c', '<strong>b</strong>'));
  ok('斜体', has('a *b* c', '<em>b</em>'));
  ok('行内代码', has('use `npm i` now', '<code>npm i</code>'));
  ok('无序列表', has('- one\n- two', '<ul><li>one</li><li>two</li></ul>'));
  ok('有序列表', has('1. one\n2. two', '<ol>'));
  ok('引用', has('> quoted', '<blockquote>'));
  ok('分割线', has('---', '<hr>'));
  ok('表格', has('| a | b |\n| --- | --- |\n| 1 | 2 |', '<table>'));
  ok('任务列表', has('- [x] done', 'checked'));

  const fence = MD.render('```js\nconst a = 1; // hi\n```');
  ok('代码块生成 pre/code', fence.includes('<pre><code'));
  ok('代码块带语言标签', fence.includes('>js<'));
  ok('代码块有关键字着色', fence.includes('<span class="tk-kw">const</span>'));
  ok('代码块有行注释着色', fence.includes('tk-cmt'));
  ok('代码块有复制按钮', fence.includes('data-copy-code'));

  const py = MD.render('```python\n# note\ndef f(x):\n    return x\n```');
  ok('python 注释着色', py.includes('tk-cmt'));
  ok('python 关键字着色', py.includes('<span class="tk-kw">def</span>'));

  // 安全
  const xss = MD.render('<script>alert(1)</script>');
  ok('原始 HTML 被转义（无 <script> 标签）', !xss.includes('<script>') && xss.includes('&lt;script&gt;'));
  const img = MD.render('<img src=x onerror=alert(1)>');
  ok('img 注入被转义', !img.includes('<img') || !img.includes('onerror='));

  const jsLink = MD.render('[click](javascript:alert(1))');
  ok('javascript: 链接不被渲染成 a 标签', !jsLink.includes('href="javascript:'));

  const goodLink = MD.render('[ok](https://example.com/a?b=1&c=2)');
  ok('https 链接正常渲染', goodLink.includes('href="https://example.com/a?b=1&amp;c=2"'), goodLink);
  ok('URL 不出现双重转义 &amp;amp;', !goodLink.includes('&amp;amp;'), goodLink);

  const quotedUrl = MD.render('[x](https://e.com/?q=%22hi%22)');
  ok('URL 里的百分号编码保持原样', quotedUrl.includes('%22hi%22'), quotedUrl);

  const cross = MD.render('a  \nb');
  ok('换行不丢内容', cross.includes('a') && cross.includes('b'));

  const inlineInCode = MD.render('`**not bold**`');
  ok('行内代码里的 ** 不被当粗体', !inlineInCode.includes('<strong>'));
}

// ------------------------------------------------------------------ 4
async function testProfiles() {
  section('4. profiles（模型配置档案 / 供应商切换）');
  const P = require('../engine/profiles');

  // ---- 4.1 env 形状转换必须**无损** ----
  // 这一条是整块功能的地基：导入 cc-switch 的 12 个键 → 界面只显示 4 个友好字段
  // → 存回去还得是原来那 12 个键、连顺序都一样。少一个键就等于把用户的配置吃掉一块。
  // （sampleEnv 是「形如本机 cc-switch 里 DeepSeek 档案」的构造数据，令牌是假的；
  //   联网探测另用 P.readGlobalEnv() 取真实配置。）
  const sampleEnv = {
    ANTHROPIC_AUTH_TOKEN: 'sk-0123456789abcdef',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'deepseek-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-flash',
    ANTHROPIC_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
  };
  const sorted = P.sanitizeEnv(sampleEnv);
  const round = P.sanitizeEnv(P.envFromSimple(P.simpleFromEnv(sorted)));
  ok('simpleFromEnv → envFromSimple 往返无损',
    JSON.stringify(round) === JSON.stringify(sorted),
    'got=' + JSON.stringify(round));
  ok('往返后键顺序与 cc-switch 一致（字母序）',
    JSON.stringify(Object.keys(round)) === JSON.stringify(Object.keys(sampleEnv).sort()));

  const s = P.simpleFromEnv(sampleEnv);
  ok('友好字段抽对了 baseUrl', s.baseUrl === 'https://api.deepseek.com/anthropic', s.baseUrl);
  ok('友好字段抽对了主模型', s.model === 'deepseek-flash', s.model);
  ok('主/快模型相同时不重复显示', s.fastModel === '', s.fastModel);

  // 没有建模的键必须被原样留住（否则导入就丢配置）
  const withExtra = { ...sampleEnv, ANTHROPIC_CUSTOM_HEADERS: 'x=y', SOME_FUTURE_KEY: '1' };
  const rt2 = P.sanitizeEnv(P.envFromSimple(P.simpleFromEnv(withExtra)));
  ok('未建模的键在往返中不丢', rt2.ANTHROPIC_CUSTOM_HEADERS === 'x=y' && rt2.SOME_FUTURE_KEY === '1',
    JSON.stringify(rt2));

  ok('sanitizeEnv 丢掉空值', !('X' in P.sanitizeEnv({ X: '', Y: null, Z: 'v' })) &&
    P.sanitizeEnv({ X: '', Y: null, Z: 'v' }).Z === 'v');

  // ---- 4.2 摘要不能泄露 token ----
  const d = P.describeEnv(sampleEnv);
  ok('摘要不带完整令牌', !JSON.stringify(d).includes('sk-0123456789abcdef'), JSON.stringify(d));
  ok('摘要给出掩码提示', /^sk-01…/.test(d.tokenHint) && d.tokenHint.includes('…'), d.tokenHint);
  ok('摘要识别出主机名', d.host === 'api.deepseek.com', d.host);
  ok('摘要统计了有效 env 键数', d.envCount === 12, 'n=' + d.envCount);

  ok('按地址猜名字', P.nameFromEnv(sampleEnv) === 'DeepSeek', P.nameFromEnv(sampleEnv));
  ok('猜不出名字时返回空串而不是乱猜', P.nameFromEnv({}) === '');

  // ---- 4.3 存储 CRUD ----
  const base = path.join(os.tmpdir(), 'cd-selftest-profiles-' + Date.now());
  const st = new P.ProfilesStore(base).init();

  ok('初始化后没有档案时不报错', st.list().length === 0 && st.active() === null);

  // ★ 兜底：一条档案都没有 / 全被删掉时，引擎必须**完全不插手**
  // （否则用户会变成"没有令牌"的状态，一条消息都发不出去）
  const empty = st.engineLaunchArgs(null);
  ok('无档案时 engineLaunchArgs 返回空参数（不插手）',
    empty.args.length === 0 && empty.settingsFile === null && Object.keys(empty.env).length === 0,
    JSON.stringify(empty));

  const p1 = st.upsert({ name: 'DeepSeek', env: sampleEnv, category: 'cn_official' });
  ok('upsert 生成 id', !!p1.id);
  ok('第一条自动成为当前档案', st.activeId === p1.id);
  ok('list 返回副本（外部改不动内部状态）', (() => {
    const l = st.list(); l[0].name = 'HACKED'; return st.get(p1.id).name === 'DeepSeek';
  })());

  const p2 = st.upsert({ id: p1.id, name: 'DeepSeek（改名）', env: { ANTHROPIC_MODEL: 'deepseek-v4-pro' } });
  ok('同 id upsert 是更新而不是新增', st.list().length === 1, 'n=' + st.list().length);
  ok('更新保留 createdAt、刷新 updatedAt',
    !!p2.createdAt && !!p2.updatedAt);
  ok('更新后 env 被替换干净（不留上一版残留）',
    Object.keys(st.get(p1.id).env).length === 1, JSON.stringify(st.get(p1.id).env));

  const kimi = st.upsert({ name: 'Kimi', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-kimi1234567890', ANTHROPIC_MODEL: 'kimi-k2.7-code' } });
  ok('新增第二条后 active 不变（不乱切）', st.activeId === p1.id);

  // ---- 4.4 引擎启动参数 ----
  const launch = st.engineLaunchArgs(kimi.id);
  ok('engineLaunchArgs 给出 --settings', launch.args[0] === '--settings', JSON.stringify(launch.args));
  ok('engineLaunchArgs 指向的文件真的存在', !!launch.settingsFile && fs.existsSync(launch.settingsFile));
  const written = JSON.parse(fs.readFileSync(launch.settingsFile, 'utf8'));
  ok('--settings 文件内容 = {env: {...}}', !!written.env && written.env.ANTHROPIC_MODEL === 'kimi-k2.7-code',
    JSON.stringify(written));
  ok('未开同步时挡掉 user 级设置（避免上一家供应商的 env 漏进来）',
    launch.args.includes('--setting-sources') &&
    launch.args[launch.args.indexOf('--setting-sources') + 1] === 'project,local',
    JSON.stringify(launch.args));
  ok('不同档案写到不同文件（切换时不覆盖别人正在读的文件）',
    launch.settingsFile !== st.engineLaunchArgs(p1.id).settingsFile);

  st.syncGlobal = true;
  ok('开启全局同步后不再挡 user 级设置', !st.engineLaunchArgs(kimi.id).args.includes('--setting-sources'));
  st.syncGlobal = false;

  // ---- 4.5 写全局配置文件：只动 env 这一个键 ----
  // ★ 打在一个临时文件上，绝不碰用户真实的 ~/.claude/settings.json
  const fake = path.join(base, 'fake-claude-settings.json');
  const original = {
    env: { ANTHROPIC_MODEL: 'OLD-MODEL' },
    model: 'top-level-model-不许动',
    permissions: { allow: ['Bash'] },
    hooks: { PreToolUse: [] },
    nested: { deep: { keep: true } },
  };
  fs.writeFileSync(fake, JSON.stringify(original, null, 2), 'utf8');
  const applied = P.applyEnvToGlobal({ ANTHROPIC_MODEL: 'NEW' }, path.join(base, 'backups'), fake);
  const after = JSON.parse(fs.readFileSync(fake, 'utf8'));
  ok('env 被替换', after.env.ANTHROPIC_MODEL === 'NEW' && after.env.OLD === undefined);
  ok('其它顶层键一个不动',
    after.model === original.model &&
    JSON.stringify(after.permissions) === JSON.stringify(original.permissions) &&
    JSON.stringify(after.hooks) === JSON.stringify(original.hooks) &&
    JSON.stringify(after.nested) === JSON.stringify(original.nested),
    JSON.stringify(after));
  ok('写之前产生了备份', !!applied.backupPath && fs.existsSync(applied.backupPath));
  const bk = JSON.parse(fs.readFileSync(applied.backupPath, 'utf8'));
  ok('备份内容是**改动前**的原样', bk.env.ANTHROPIC_MODEL === 'OLD-MODEL', JSON.stringify(bk));

  P.applyEnvToGlobal({}, path.join(base, 'backups'), fake);
  const after2 = JSON.parse(fs.readFileSync(fake, 'utf8'));
  ok('空 env（官方档案）写成 {} 而不是删键', after2.env && Object.keys(after2.env).length === 0,
    JSON.stringify(after2.env));

  // 坏 JSON 也不能让程序炸掉
  fs.writeFileSync(fake, '{ 坏掉的 json');
  ok('原文件损坏时 applyEnvToGlobal 不抛异常', (() => {
    try { P.applyEnvToGlobal({ A: '1' }, path.join(base, 'backups'), fake); return true; }
    catch { return false; }
  })());

  // ---- 4.6 导入 ----
  const g = P.importFromGlobal();
  ok('importFromGlobal 返回一条可用档案', g.ok && !!g.item && typeof g.item.env === 'object');
  ok('importFromGlobal 的名字不是空的', !!g.item.name, g.item.name);

  const before = st.list().length;
  const added = st.importItems([g.item, g.item], {});
  ok('导入去重（同一条导两次只加一条）', added === 1 && st.list().length === before + 1,
    'added=' + added + ' total=' + st.list().length);

  let cc = { ok: false, reason: 'node:sqlite 不可用（Node 22 需要 --experimental-sqlite）' };
  try {
    require('node:sqlite');
    cc = P.importFromCcSwitch();
  } catch (err) {
    cc = { ok: false, reason: 'node:sqlite 不可用: ' + err.message };
  }
  if (cc.ok) {
    ok('从 cc-switch 读到档案', cc.items.length > 0, 'n=' + cc.items.length);
    ok('导入项的 env 是对象', cc.items.every((i) => i.env && typeof i.env === 'object'));
    const added2 = st.importItems(cc.items, { makeActiveName: cc.currentName });
    ok('cc-switch 档案能导入（且标明来源）',
      added2 >= 0 && st.list().some((x) => x.source === 'cc-switch'),
      'added=' + added2);
  } else {
    console.log('  ~ 跳过 cc-switch 导入: ' + cc.reason);
  }

  // ---- 4.7 删除 / 切换 ----
  const delId = st.list().find((x) => x.source === 'cc-switch');
  if (delId) {
    st.setActive(delId.id);
    ok('setActive 生效', st.activeId === delId.id);
    st.remove(delId.id);
    ok('删除当前档案后自动落到另一条（不会指向不存在的 id）',
      !!st.activeId && !!st.get(st.activeId), 'activeId=' + st.activeId);
  }
  st.remove(st.list()[0].id);
  while (st.list().length) st.remove(st.list()[0].id);   // 上面 cc-switch 导入过，条数不固定
  ok('删空之后 activeId 归零', st.activeId === null && st.active() === null,
    'activeId=' + st.activeId + ' n=' + st.list().length);
  ok('删空之后 engineLaunchArgs 又回到"不插手"', st.engineLaunchArgs(null).args.length === 0);

  // 落盘 / 重载
  st.upsert({ name: 'Persist', env: { ANTHROPIC_MODEL: 'x' } });
  const st2 = new P.ProfilesStore(base).init();
  ok('档案持久化并能重新载入', st2.list().some((x) => x.name === 'Persist'));

  fs.writeFileSync(path.join(base, 'profiles.json'), '{ 坏');
  ok('profiles.json 损坏时能优雅恢复（不抛异常）', (() => {
    try { return Array.isArray(new P.ProfilesStore(base).init().list()); } catch { return false; }
  })());

  // ---- 4.8 联网探测（真实请求，--no-api 时跳过）----
  if (NO_API) {
    console.log('  ~ 跳过连通性探测（--no-api）');
  } else {
    // ★ 用**真实**的全局配置来探测，而不是上面那个编出来的假 env。
    // 第一版就是拿假 token（sk-0123456789abcdef）去打真实端点，拿到 401 ——
    // 那不是探测逻辑的问题，是测试自己喂错了料，白白红一项。
    const netEnv = P.readGlobalEnv();
    if (!netEnv.ANTHROPIC_BASE_URL) {
      console.log('  ~ 跳过连通性探测（全局配置里没有自定义 API 地址）');
    } else {
      const t = await P.testProfile(netEnv);
      ok('对真实配置的连通性探测通过', t.ok, JSON.stringify(t));
      if (t.ok) ok('探测返回了耗时', typeof t.ms === 'number' && t.ms >= 0, 'ms=' + t.ms);

      const bad = await P.testProfile({ ...netEnv, ANTHROPIC_AUTH_TOKEN: 'sk-definitely-invalid-token-123' });
      ok('错令牌被识别为失败（不是假绿）', bad.ok === false, JSON.stringify(bad));
      ok('失败时带上了 HTTP 状态或明确原因', !!(bad.status || bad.reason), JSON.stringify(bad));
      ok('失败提示里不带完整令牌（只有掩码）',
        !JSON.stringify(bad).includes('sk-definitely-invalid-token-123'), JSON.stringify(bad));
    }

    /**
     * 档案里没写模型名时必须**照样能探**。
     *
     * 早先这里是直接 return「档案里没有指定模型，无法构造探测请求」—— 用户刚填完
     * 地址和令牌、兴冲冲点「测试连接」，得到的却是这么一句，按钮等于废掉。
     * 这一步真正要回答的是「地址通不通、令牌认不认」，模型名对不对是下一件事，
     * 所以用占位模型去探，并在结果里把 modelGuessed 标出来。
     */
    const nomodel = await P.testProfile({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'x',
    });
    ok('缺模型名也能探（不再用"无法构造探测请求"把按钮废掉）',
      !/无法构造探测请求/.test(nomodel.reason || ''), nomodel.reason);
    ok('缺模型名时用占位模型，并标明是猜的', nomodel.modelGuessed === true && !!nomodel.model, JSON.stringify(nomodel));
    ok('缺模型名时依然给出 HTTP 结论（真的发出去了请求）',
      nomodel.status != null, JSON.stringify(nomodel));
    // 401（令牌不对）必须翻译成"令牌问题"，而不是丢一个光秃秃的 401 让用户猜
    ok('状态码被翻译成人话提示（hint）',
      typeof nomodel.hint === 'string' && nomodel.hint.length > 0 && /令牌/.test(nomodel.hint),
      nomodel.hint);

    const official = await P.testProfile({});
    ok('官方档案（无地址无令牌）明确跳过而不是报红',
      official.ok === true && official.skipped === true, JSON.stringify(official));

    // 打不通的地址必须报「请求失败」而不是挂住
    const dead = await P.testProfile({
      ANTHROPIC_BASE_URL: 'https://127.0.0.1:9/nope',
      ANTHROPIC_AUTH_TOKEN: 'sk-x1234567890',
      ANTHROPIC_MODEL: 'm',
    }, { timeoutMs: 4000 });
    ok('打不通的地址在超时后返回失败（不会一直挂着）', dead.ok === false, JSON.stringify(dead));

    if (netEnv.ANTHROPIC_BASE_URL) {
      const lm = await P.listModels(netEnv);
      console.log('  ~ 模型列表: ok=' + lm.ok + ' n=' + (lm.models || []).length +
        (lm.reason ? ' reason=' + lm.reason : ''));
      ok('listModels 拿不到时返回空数组而不是抛异常（界面据此退回档案里的模型名）',
        Array.isArray(lm.models));
    }
  }

  fs.rmSync(base, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 5
/**
 * 5.0 引擎对 claude 自身「退避重试」的处理（纯离线，喂合成事件）。
 *
 * 背景：claude 对失败请求会自己重试最多 10 次。401 这种**重试不会变好**的，
 * 实测要拖十分钟才给用户一句错话；而它每几秒吐一行 api_retry，还会把
 * 静默看门狗无限续命。所以引擎必须自己识别 api_retry。
 */
function testEngineRetry() {
  section('5.0 claude-engine：api_retry 的处置（离线）');
  const { ClaudeEngine } = require('../engine/claude-engine');

  const mk = () => {
    const e = new ClaudeEngine({ exe: 'noop', cwd: process.cwd() });
    const seen = [];
    e.on('event', (x) => seen.push(x));
    e.busy = true;
    return { e, seen };
  };
  const retryLine = (status, over) => JSON.stringify({
    type: 'system', subtype: 'api_retry',
    attempt: 1, max_retries: 10, retry_delay_ms: 586,
    error_status: status, error: 'x', ...(over || {}),
  });

  const a = mk();
  a.e._handleLine(retryLine(401));
  ok('api_retry 被解析成 retry 事件（以前是被静默丢掉的）',
    a.seen.some((x) => x.type === 'retry'), a.seen.map((x) => x.type).join(','));
  ok('api_retry 带着状态码 / 次数一起给到界面',
    a.seen.some((x) => x.type === 'retry' && x.status === 401 && x.maxRetries === 10));
  ok('401 立刻判为致命（不再陪它重试十次）',
    a.seen.some((x) => x.type === 'retry' && x.fatal === true));
  ok('401 会主动终止这一轮并给出人话解释',
    a.seen.some((x) => x.type === 'error' && /鉴权失败/.test(x.message)));
  ok('401 的错误信息里指明了下一步（模型配置 / 测试连接）',
    a.seen.some((x) => x.type === 'error' && /模型配置/.test(x.message)));
  ok('终止后引擎不再是 busy（下一轮能重新拉起）', a.e.busy === false);

  const b = mk();
  b.e._handleLine(retryLine(429));
  ok('429（限流）只报告不终止 —— 它有可能自己好',
    b.seen.some((x) => x.type === 'retry') && !b.seen.some((x) => x.type === 'error'));

  const c = mk();
  c.e._handleLine(retryLine(502));
  ok('502 单次不终止（可能是真·暂时故障）', !c.seen.some((x) => x.type === 'error'));

  const d = mk();
  d.e._retryStartedAt = Date.now() - (ClaudeEngine.RETRY_BUDGET_MS + 1000);
  d.e._handleLine(retryLine(502));
  ok('502 一直重试到超预算后停下（否则用户要等十分钟）',
    d.seen.some((x) => x.type === 'error' && /连续重试/.test(x.message)));
  ok('超预算的错误里说明了常见原因',
    d.seen.some((x) => x.type === 'error' && /地址|网络|额度/.test(x.message)));

  const f = mk();
  f.e._handleLine(retryLine(403));
  ok('403 也按致命处理（权限问题重试没用）',
    f.seen.some((x) => x.type === 'error' && /403/.test(x.message)));

  // 普通输出必须照旧重置看门狗；只有 api_retry 不重置（否则看门狗永远不触发）
  const g = mk();
  g.e._handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: '.', tools: [] }));
  ok('init 事件仍会重置看门狗', g.e._watchdog !== null);
  g.e._clearWatchdog();   // 别让这个 150s 定时器把自检进程吊住
  const h = mk();
  h.e.busy = true;
  h.e._handleLine(retryLine(429));
  ok('api_retry 不重置看门狗（这是"用户干等十分钟"的根因）', h.e._watchdog === null);
}

function testEngine() {
  section('5. claude-engine（真实 API 调用）');
  const { ClaudeEngine } = require('../engine/claude-engine');
  const { resolveClaude } = require('../engine/find-claude');
  const resolved = resolveClaude();
  if (!resolved) { ok('找到 claude 可执行文件', false); return; }

  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-selftest-cwd-'));
    const log = [];
    const text = { full: '' };
    const tools = [];
    let initInfo = null;
    let cycles = 0;
    let done = 0;

    const eng = new ClaudeEngine({
      exe: resolved.exe,
      cwd,
      permissionMode: 'acceptEdits',
    });

    const timer = setTimeout(() => {
      console.log('  超时（150s），已收到事件类型: ' + [...new Set(log)].join(', '));
      ok('引擎在 150s 内跑完两轮', false);
      finish();
    }, 150000);

    function finish() {
      clearTimeout(timer);
      try { eng.dispose('selftest-done'); } catch { /* ignore */ }
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve();
    }

    eng.on('event', (ev) => {
      log.push(ev.type + (ev.op ? ':' + ev.op : ''));
      if (ev.type === 'init') initInfo = ev;
      if (ev.type === 'cycle') cycles++;
      if (ev.type === 'delta' && ev.kind === 'text') text.full += ev.text;
      if (ev.type === 'block' && ev.op === 'stop' && ev.block.type === 'tool_use') tools.push(ev.block);
      if (ev.type === 'error') console.log('  引擎报告错误: ' + ev.message);
      if (ev.type === 'stderr') console.log('    [stderr] ' + ev.line);
      if (ev.type === 'exit' && !ev.intentional) {
        console.log('  进程意外退出 code=' + ev.code);
        if (!done) { ok('进程未意外退出', false); done = 9; finish(); }
      }

      if (ev.type === 'init') {
        ok('收到 init 握手', true);
        ok('init 带 sessionId', !!ev.sessionId, JSON.stringify(ev.sessionId));
        ok('init 带 model', !!ev.model, 'model=' + ev.model);
        ok('init 报告 cwd 正确', String(ev.cwd).toLowerCase() === cwd.toLowerCase(),
          'got=' + ev.cwd + ' want=' + cwd);
      } else if (ev.type === 'result' && done === 1) {
        done = 2;
        ok('第 1 轮 result.isError === false', ev.isError === false, JSON.stringify(ev.errors));
        ok('第 1 轮至少产生 2 个 message 周期（说明工具调用后继续生成）', cycles >= 2, 'cycles=' + cycles);
        ok('捕获到 tool_use 块', tools.length >= 1, 'tools=' + tools.length);
        if (tools.length) {
          const t = tools[0];
          ok('tool_use 有 name', !!t.name, 'name=' + t.name);
          ok('tool_use 有 id（用于配对 tool_result）', !!t.id);
          ok('tool_use 的 input 已成功 JSON.parse（逐字拼装正确）',
            t.input && !t.input.__parse_error, JSON.stringify(t.input));
        }
        ok('捕获到 tool_result 回灌', log.includes('toolresult'));
        ok('逐字流拼出的文本非空', text.full.trim().length > 0, JSON.stringify(text.full.slice(0, 80)));

        // 第 2 轮：验证常驻进程上下文保留
        eng.send('我上一条让你执行的那条命令里，回显的字符串是什么？只回答那个字符串。');
      } else if (ev.type === 'result' && done === 2) {
        done = 3;
        ok('第 2 轮 result.isError === false', ev.isError === false);
        ok('常驻进程保留了上下文（答出 selftest-ok）', /selftest-ok/i.test(text.full),
          '文本=' + JSON.stringify(text.full.slice(0, 200)));
        finish();
      }
    });

    eng.start();

    // ★ 回归测试：必须在 init 之前就能 send。
    // 实测 claude 只在收到第一条输入后才发 system/init，若 send 被 ready 拦住就是死锁。
    let sentEarly = false;
    try {
      eng.send('用 Bash 工具执行 echo selftest-ok，然后用一句话告诉我输出。');
      sentEarly = true;
    } catch (err) {
      ok('init 之前允许 send（避免双向死锁）', false, err.message);
    }
    ok('init 之前允许 send（避免双向死锁）', sentEarly);
    if (sentEarly) done = 1;
  });
}

// ------------------------------------------------------------------ main
(async function main() {
  console.log('Claude Desktop 自检' + (NO_API ? '（跳过联网部分）' : ''));
  testFind();
  testStore();
  testMarkdown();
  await testProfiles();
  // 这一段是纯离线的（喂合成事件），所以它必须在 --no-api 判断**之前**跑，
  // 否则跳过联网时它就被一起跳过了 —— 那正是最需要它跑的时候。
  testEngineRetry();
  if (NO_API) {
    console.log('\n（--no-api：跳过 claude-engine 的联网部分）');
  } else {
    await testEngine();
  }

  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
