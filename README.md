# ClaudeCode-Desktop

一个 Windows 桌面外壳，把本机的 **Claude Code CLI** 包上 ChatGPT 风格的界面。
自带 Electron 运行时（便携版双击即用），不用装 Node、不用联网登录。

> 本项目是**非官方的第三方外壳**，与 Anthropic 无关联。它只是给本机已安装的 `claude`
> 命令行程序套一层 GUI —— 对话能力、计费、账号全部来自你本机原有的 Claude Code。

---

## 它解决什么

本机装了 Claude Code CLI，但用起来一直是「终端里敲命令 → 看纯文本流式输出」。
这个壳子把那套流程搬进了一个正经的桌面窗口：

- **流式输出是真的流式** —— 逐字渲染，不是等结果回来一次性刷出
- **Markdown 渲染** —— 代码块带语法高亮、复制按钮、表格、列表
- **会话持久化** —— 关掉窗口再打开，历史还在，可以翻回去继续
- **模型配置档案** —— 顶栏一键切供应商 / 模型（DeepSeek、Kimi、Moonshot…），
  对标 cc-switch；默认**不改动**全局 `~/.claude/settings.json`
- **技能管家**（本项目独有）—— 面板里一览所有本地 skill，勾选就能停用 / 恢复

---

## 主要功能

### 1. ChatGPT 风格对话界面

三栏布局：左侧会话列表 + 右侧消息流。支持新建会话、重命名、删除、搜索历史。
消息渲染走自带的 `renderer/markdown.js`，代码块、表格、引用、列表都做了样式。

### 2. 流式输出与看门狗

引擎以子进程方式驱动 `claude` CLI，逐行读取 stdout 并推到渲染层。

内置两个防呆机制（这两个都是踩坑后补上的，见下文「已知限制」）：

- **静默看门狗** —— 长时间没有任何输出就判定卡死
- **重试预算** —— 401 / 403 立即终止并给出人话提示，其余错误走 60 秒预算

### 3. 模型配置档案

顶栏可切换「档案」。每个档案是一组环境变量：

```
ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL / ANTHROPIC_DEFAULT_OPUS_MODEL ...
```

要点：

- 支持从 **cc-switch** 只读导入已有配置
- **默认不写全局配置** —— 档案通过子进程环境变量注入，不动 `~/.claude/settings.json`
- 界面只显示 4 个友好字段（名称 / 地址 / 密钥 / 模型），但**存回去仍是完整的原始键集**，
  连顺序都保留 —— 少一个键就等于把用户的配置吃掉一块
- 密钥在列表和日志里**只显示掩码**（`sk-01…`），不落完整值
- 有「测试连接」按钮：能连通 / 令牌不对 / 地址打不通，分别给不同提示

### 4. 技能管家

面板里列出 `~/.workbuddy/skills/` 下的所有 skill，可以勾选后**一键停用 / 恢复**。

- **可逆**：停用 = 把目录改名挪到 `~/.workbuddy/skills-disabled/`，**不删除任何文件**。
  恢复就是挪回来，逐字节一致。
- **幂等**：重复停用 / 恢复会报 `skipped`，不会出错也不会重复挪。
- **路径穿越防御**：所有目录名都过一遍几何校验（拒分隔符、盘符、`..`、控制字符、
  Windows 保留名 CON/PRN/AUX/NUL、首尾点空格），并要求结果是被扫描目录的严格子路径。
- **只改显示层**：卡片上的中文简介是**界面内建的翻译表**，不改 `SKILL.md` 里的
  `description` —— 那个字段是给模型做技能匹配用的，改它会影响识别准确率。

---

## 运行要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| Claude Code CLI | 本机已安装并可用（`claude` 在 PATH 里，或已配置好账号） |
| Electron | 便携版自带；源码运行需要本机有 Electron 43.x |
| Node.js | 源码运行需要（仅用于 Electron 启动；CLI 本体不需要） |

**注意**：本项目**不提供** Claude Code CLI 本身，也不含任何账号或密钥。
你需要自己先把 Claude Code 装好并能正常对话。

---

## 怎么跑起来

### 方式 A：便携版（推荐）

解压后双击 `Claude Desktop.exe`。自带 Electron，不需要装任何东西。

### 方式 B：从源码运行

```cmd
git clone https://github.com/Aeno-saber/ClaudeCode-Desktop.git
cd ClaudeCode-Desktop
```

然后需要本机有一个 Electron。`start.cmd` 会自动去找：

1. 先看 `D:\app\ds harness\dsh-desktop\node_modules\electron\dist\electron.exe`
2. 找不到就扫 `D:\app\*\node_modules\electron\dist\electron.exe`，取最新的

> 这个搜索路径是为作者的机器写的（本机 Electron 来自另一个项目）。
> **换了机器请按实际情况改 `start.cmd` 里的路径**，或者直接 `npm i -D electron && npm start`。

正常启动：

```cmd
start.cmd
```

带 DevTools：

```cmd
start.cmd --dev
```

---

## 目录结构

```
.
├── main.js                    主进程：窗口、IPC、技能管家、冒烟测试入口
├── preload.js                 contextBridge 暴露的 API（contextIsolation 开启）
├── package.json
├── start.cmd                  启动器（纯 ASCII，避免 cmd OEM 代码页乱码）
├── engine/
│   ├── claude-engine.js       claude CLI 子进程驱动 + 流式解析 + 看门狗
│   ├── profiles.js            配置档案：读写 / 掩码 / 连通性测试 / cc-switch 导入
│   ├── find-claude.js         定位本机 claude CLI
│   └── session-store.js       会话持久化
├── renderer/
│   ├── index.html             界面骨架 + 内联 SVG 图标
│   ├── app.js                 界面逻辑（含技能管家的翻译表）
│   ├── markdown.js            Markdown → HTML 渲染
│   └── styles.css
├── assets/
│   ├── claude-logo.png
│   └── claude.ico
└── tools/
    ├── selftest.js            引擎与档案的单元自测
    ├── build-portable.py      打便携版（7z SFX）
    ├── make-ico.py            生成 .ico
    ├── verify-exe.py          校验打包产物
    └── verify-ico.py          校验图标资源条目数
```

---

## 架构要点

**进程隔离**：`contextIsolation: true` + `nodeIntegration: false`。渲染进程**没有** Node 权限，
所有能力走 `preload.js` 的 `contextBridge` 白名单。

**为什么技能管家走 IPC 而不是 HTTP 服务？**
`renderer/index.html` 里这条 CSP 会挡死渲染进程的一切网络请求：

```
connect-src 'none'
```

所以「起个本地 HTTP 服务让网页 fetch」的路子走不通，必须用 IPC 三段式：
`ipcMain.handle` → `contextBridge.exposeInMainWorld` → `window.api.xxx`。

**埋点冒烟测试**：主进程支持 `--smoke` 参数 —— 窗口不显示，但真实加载页面并回读 DOM 断言。
另有 `--shot` 模式用 `capturePage()` 抓截图，全程不弹窗。

测试用的目录重定向环境变量（**不会碰你真实的 skills 目录**）：

```cmd
set CLAUDE_DESKTOP_SKILLS_ROOT=C:\Temp\whatever
node tools/probe.js
```

---

## 已知限制

诚实列一下，这些都是实际踩过的：

**1. 换机器要改 `start.cmd`**
里面写死了作者机器的 Electron 搜索路径。见上文说明。

**2. 依赖本机 Electron**
便携版自带，但源码运行需要自备。没做 `npm install` 自动化的原因是作者机器上
装了火绒实时防护，会把依赖安装拖到 20~40 分钟，中途还可能因为「删旧目录再换新」
那一步被拦成 `拒绝访问`，导致 `node_modules` 半装。

**3. 401 退避曾经是个大坑（已修）**
令牌过期时 claude CLI 会把 401 退避重试 10 次（约十分钟），而「每行输出就重置」的
静默看门狗会被重试心跳无限续命 → 界面永远显示「生成中」。
现在 401 / 403 立刻终止并给人话，**十分钟 → 1.6 秒**。

**4. 地址填错也曾报成 502（已修）**
看着像暂时故障，同样会退避十分钟。现在靠重试预算兜住（60 秒）。

**5. 技能管家只认 `~/.workbuddy/skills/`**
路径写死。要换目录得改 `main.js` 里的 `SKILLS_ROOT`。

**6. 不支持多窗口 / 多标签**
单窗口单会话。

**7. 界面中文简介是手工维护的**
`renderer/app.js` 里的 `SKILL_ZH` 是一张写死的映射表（键 = 技能目录名）。
装了新 skill 不会自动有中文简介，会回落显示原始英文 `description`。

---

## 许可

MIT。

本项目与 Anthropic 无关联，是第三方非官方外壳。「Claude」为 Anthropic 的商标，
此处仅用于说明用途。
