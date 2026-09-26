'use strict';
/**
 * 定位 claude 可执行文件。
 *
 * 本机没有把 claude 装进 PATH（npm 版已被移除），唯一活着的二进制在 VS Code
 * 扩展目录里，而且路径带版本号、会随扩展升级而变化。所以这里按「修改时间倒序」
 * 挑最新的一份，而不是写死版本号 —— 扩展升级后无需改代码。
 *
 * 与 %USERPROFILE%\bin\claude.cmd 那个 shell shim 是同一套判定逻辑，
 * 但这里返回真实 exe 路径（我们要 spawn 它，而不是走 shell）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ROOTS = [
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  path.join(os.homedir(), '.cursor', 'extensions'),
  path.join(os.homedir(), '.windsurf', 'extensions'),
  path.join(os.homedir(), '.trae', 'extensions'),
  path.join(os.homedir(), '.trae-cn', 'extensions'),
];

const EXT_PREFIX = 'anthropic.claude-code-';
const REL = path.join('resources', 'native-binary', 'claude.exe');

function statSafe(p) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** 收集所有候选，带 mtime，按新到旧排序。 */
function listCandidates() {
  const found = [];
  const overrides = [
    process.env.CLAUDE_CODE_EXECUTABLE,
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
  ].filter(Boolean);

  for (const exe of overrides) {
    const st = statSafe(exe);
    if (st) found.push({ exe, mtime: st.mtimeMs, source: 'override' });
  }

  for (const root of EXT_ROOTS) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(EXT_PREFIX)) continue;
      const dir = path.join(root, ent.name);
      const exe = path.join(dir, REL);
      const st = statSafe(exe);
      if (st) found.push({ exe, mtime: st.mtimeMs, source: ent.name });
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

function resolveClaude(overridePath) {
  if (overridePath) {
    const st = statSafe(overridePath);
    if (st) return { exe: overridePath, source: 'settings', mtime: st.mtimeMs };
  }
  const list = listCandidates();
  return list[0] || null;
}

module.exports = { resolveClaude, listCandidates, EXT_ROOTS };
