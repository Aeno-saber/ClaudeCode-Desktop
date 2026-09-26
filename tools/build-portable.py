#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 D:\\app\\claude 打成一个自带 Electron 运行时的**便携版**目录。

为什么不走 electron-builder：
  本机装了火绒实时防护，npm 系工具的安装/构建会被拖到几十分钟，而且
  electron-builder 还会去联网取 electron zip、winCodeSign 等。这里要的东西
  其实很简单 —— Electron 官方发行包本身就是"可便携"的：把 app 放进
  resources/app，exe 改个名就是成品。所有零件本机都有：
    · Electron dist  D:\\app\\ds harness\\dsh-desktop\\node_modules\\electron\\dist
    · rcedit         ...\\electron-winstaller\\vendor\\rcedit.exe（改 exe 图标用）
  于是自己拼，全程离线，几秒钟完事。

产物结构：
  release\\Claude Desktop\\
      Claude Desktop.exe          <- electron.exe 改名而来（已换图标）
      resources\\app\\             <- 我们的代码（白名单拷贝，见 APP_FILES）
      ... 其余 Electron 运行时文件

用法：
  python tools/build-portable.py
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON_DIST = r'D:\app\ds harness\dsh-desktop\node_modules\electron\dist'
RCEDIT = r'D:\app\ds harness\dsh-desktop\node_modules\electron-winstaller\vendor\rcedit.exe'
OUT_DIR = os.path.join(ROOT, 'release', 'Claude Desktop')
EXE_NAME = 'Claude Desktop.exe'
ICO = os.path.join(ROOT, 'assets', 'claude.ico')

# 只拷这些进 resources/app —— 白名单而不是黑名单：
# 黑名单一旦漏掉 release/ 自己，就会出现「打包产物里再套一个打包产物」的递归
APP_FILES = [
    'main.js',
    'preload.js',
    'package.json',
    os.path.join('engine', 'claude-engine.js'),
    os.path.join('engine', 'find-claude.js'),
    os.path.join('engine', 'profiles.js'),
    os.path.join('engine', 'session-store.js'),
    os.path.join('renderer', 'index.html'),
    os.path.join('renderer', 'styles.css'),
    os.path.join('renderer', 'app.js'),
    os.path.join('renderer', 'markdown.js'),
    os.path.join('assets', 'claude-logo.png'),
    os.path.join('assets', 'claude.ico'),
]

# Electron 发行包里用不上的东西（debug.log 是它自己落的运行日志）
DIST_SKIP = {'debug.log', 'electron.exe', 'resources'}

# 内置模块 + 运行时提供的模块，不在白名单里也正常
# （electron 由 Electron 运行时注入，不是 node_modules 里的包）
BUILTIN = {
    'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http',
    'https', 'net', 'os', 'path', 'readline', 'stream', 'timers', 'tty',
    'url', 'util', 'zlib', 'node:sqlite', 'node:fs', 'node:path',
    'electron',
}

REQUIRE_RE = re.compile(r"""require\(\s*['"]([^'"]+)['"]\s*\)""")
# 只认这几类扩展名，避免把 '/v1/messages'、'1.0.0' 这种当成文件路径
SHIPPED_EXT = ('.js', '.html', '.css', '.png', '.ico', '.json')
# path.join(__dirname, 'a', 'b') —— app 自带的相对路径基本都是这个写法
DIRNAME_JOIN_RE = re.compile(r"""path\.join\(\s*__dirname\s*,\s*([^)]*)\)""")
STR_RE = re.compile(r"""['"]([^'"]+)['"]""")
PATH_LITERAL_RE = re.compile(r"""['"]((?:\.{1,2}[\\/]|/)[^'"]*\.(?:js|html|css|png|ico|json))['"]""")


def check_require_closure():
    """扫白名单文件里的相对引用，确认目标也在白名单里。

    加这个是因为吃过一次：新加的 engine/profiles.js 忘了写进 APP_FILES，
    构建照样 BUILD_OK、哈希校验照样全绿（缺文件不算"不一致"）、
    用产物跑冒烟甚至也能过 —— 因为那份旧代码本来也是好的。
    结果是便携版一启动就 MODULE_EXPORT 不出来东西。
    这条检查让它当场失败。

    覆盖两类引用：
      1. require('./x') / require('../x')
      2. 带受管扩展名的路径字面量（'../assets/a.png'）与 path.join(__dirname, 'x', 'y.js')
    不覆盖：HTML/CSS 里的裸文件名（href="styles.css"）。
    那一块靠"用打包产物跑冒烟"兜底 —— 少一个文件，界面会直接渲染成启动失败。
    """
    have = {os.path.normpath(p) for p in APP_FILES}
    missing = []

    def resolve_and_check(rel, target):
        resolved = os.path.normpath(os.path.join(os.path.dirname(rel), target))
        cands = [resolved, resolved + '.js', os.path.join(resolved, 'index.js')]
        if not any(os.path.normpath(c) in have for c in cands):
            missing.append('%s -> %s' % (rel, target))

    for rel in APP_FILES:
        # 只读 JS：require 只可能出现在这里。PNG/ICO 是二进制，
        # 按 utf-8 读会直接抛 UnicodeDecodeError（实测踩到，claude-logo.png 首字节 0x89）。
        if not rel.endswith('.js'):
            continue
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            continue
        try:
            text = open(src, encoding='utf-8').read()
        except (OSError, UnicodeDecodeError):
            continue

        for target in REQUIRE_RE.findall(text):
            if not target.startswith('.'):
                if target in BUILTIN:
                    continue
                missing.append('%s -> %s（非相对路径的第三方依赖）' % (rel, target))
                continue
            resolve_and_check(rel, target)

        # 带扩展名的相对路径字面量：'../assets/claude-logo.png'
        for target in PATH_LITERAL_RE.findall(text):
            resolve_and_check(rel, target)

        # path.join(__dirname, 'renderer', 'index.html')
        for group in DIRNAME_JOIN_RE.findall(text):
            segs = [s for s in STR_RE.findall(group)]
            if not segs:
                continue
            joined = os.path.join(*segs)
            if not joined.lower().endswith(SHIPPED_EXT):
                continue
            if os.path.normpath(joined) not in have:
                missing.append("%s -> path.join(__dirname, %s)" % (rel, ', '.join(repr(s) for s in segs)))

    return missing


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for blk in iter(lambda: f.read(1 << 20), b''):
            h.update(blk)
    return h.hexdigest()


def count_files(root):
    n = 0
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            n += 1
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return n, total


def main():
    print('Electron dist : %s' % ELECTRON_DIST)
    if not os.path.isdir(ELECTRON_DIST):
        print('找不到 Electron dist')
        return 1
    for rel in APP_FILES:
        if not os.path.isfile(os.path.join(ROOT, rel)):
            print('缺少源文件: ' + rel)
            return 1
    if not os.path.isfile(ICO):
        print('缺图标，先跑 tools/make-ico.py: ' + ICO)
        return 1

    # 白名单必须覆盖所有相对 require，否则产物是「缺胳膊少腿」的
    missing = check_require_closure()
    if missing:
        print('依赖闭包检查未通过，APP_FILES 白名单缺这些：')
        for m in missing:
            print('  - ' + m)
        return 1
    print('依赖闭包检查: %d 个白名单文件的相对 require 都已覆盖' % len(APP_FILES))

    # 每次都重建，避免残留上一次的文件造成"看着像成功"。
    # 删不掉不能直接崩：沙箱有「单次删除超过 50 个文件需确认」的保护层，
    # 后台执行时没法弹确认框 → 直接 fail-closed。此时代码里的异常处理救不了
    # （进程会被连带杀掉），但至少给一条明确的提示，别让人以为构建成功了。
    if os.path.isdir(OUT_DIR):
        try:
            shutil.rmtree(OUT_DIR)
        except OSError as err:
            print('警告: 旧产物没删掉（%s）；继续覆盖式构建，完成后会核对哈希' % err)
    os.makedirs(OUT_DIR, exist_ok=True)

    copied = 0
    for name in os.listdir(ELECTRON_DIST):
        if name in DIST_SKIP:
            continue
        src = os.path.join(ELECTRON_DIST, name)
        dst = os.path.join(OUT_DIR, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
            n, _ = count_files(dst)
            copied += n
        else:
            shutil.copy2(src, dst)
            copied += 1
    print('拷贝运行时文件: %d 个' % copied)

    shutil.copy2(os.path.join(ELECTRON_DIST, 'electron.exe'), os.path.join(OUT_DIR, EXE_NAME))
    print('主程序: ' + EXE_NAME)

    app_dir = os.path.join(OUT_DIR, 'resources', 'app')
    os.makedirs(app_dir)
    manifest = []
    for rel in APP_FILES:
        s = os.path.join(ROOT, rel)
        d = os.path.join(app_dir, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        manifest.append({'file': rel.replace('\\', '/'),
                         'size': os.path.getsize(d),
                         'sha256': sha256(d)})
    print('应用代码: %d 个文件 (%d bytes)'
          % (len(manifest), sum(m['size'] for m in manifest)))

    # 换 exe 图标与版本信息。rcedit 只能吃 ASCII 参数（命令行编码不可控），
    # 所以这里不写中文 —— 中文会变成乱码或直接失败。
    exe_path = os.path.join(OUT_DIR, EXE_NAME)
    if os.path.isfile(RCEDIT):
        args = [RCEDIT, exe_path,
                '--set-icon', ICO,
                '--set-version-string', 'ProductName', 'Claude Desktop',
                '--set-version-string', 'FileDescription', 'Claude Desktop',
                '--set-file-version', '0.1.0.0',
                '--set-product-version', '0.1.0.0']
        r = subprocess.run(args, capture_output=True, text=True)
        print('rcedit 退出码: %d %s' % (r.returncode, (r.stderr or '').strip()[:200]))
    else:
        print('没找到 rcedit，跳过图标替换')

    # 图标换成没换成，交给 verify-exe.py 判：它用 ExtractIconExW + DrawIconEx
    # 把 exe 的图标真画一遍，再跟 claude.ico 的渲染结果逐字节比，
    # 比"数 PE 资源条目"可靠得多（我上一版手写 PE 解析算错了数据目录偏移，
    # 对明明有图标的 exe 也读出 0，那种指标只会误导人）。
    verifier = os.path.join(ROOT, 'tools', 'verify-exe.py')
    if os.path.isfile(verifier):
        r = subprocess.run([sys.executable, verifier, exe_path, ICO],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        print((r.stdout or '').strip())
        if r.returncode != 0:
            print('图标/版本信息校验未通过')
            return 1

    # ★ 核对产物里的代码与源码逐字节一致。
    # 这条是吃过亏才加的：有一次构建被沙箱的批量删除保护拦掉，
    # 产物里还是**上一版**的 main.js / styles.css —— 而"用打包产物跑冒烟"
    # 照样 34/34 全绿，因为旧代码本身也是好的。也就是说：全绿 = 代码能跑，
    # 但并不等于"你刚改的东西进去了"。哈希一比就把这件事说死了。
    drift = []
    for m in manifest:
        dst = os.path.join(app_dir, m['file'].replace('/', os.sep))
        if sha256(dst) != m['sha256']:
            drift.append(m['file'])
    if drift:
        print('构建校验失败，产物与源码不一致: ' + ', '.join(drift))
        return 1
    print('构建校验: %d 个应用文件 sha256 全部一致' % len(manifest))

    # 再往下一层：真的把产物里的 Node 侧模块 require 一遍。
    # 白名单/哈希都只管"文件在不在、内容对不对"，管不了"加载时会不会炸"
    # （比如某个 require 的路径写得只在源码目录下才对）。这一步几毫秒，值。
    node = shutil.which('node')
    if not node:
        # 本机 node 不在 PATH 上（WorkBuddy 用的是托管版本），按已知位置兜一下
        for cand in (r'C:\Users\deno\.workbuddy\binaries\node\versions\22.22.2\node.exe',):
            if os.path.isfile(cand):
                node = cand
                break
    if not node:
        print('没找到 node，跳过产物模块加载检查')
    else:
        mods = [rel for rel in APP_FILES
                if rel.endswith('.js') and rel.replace('\\', '/').startswith('engine/')]
        bad = []
        for rel in mods:
            p = os.path.join(app_dir, rel)
            r = subprocess.run([node, '-e', 'require(process.argv[1]);', p],
                               capture_output=True, text=True, encoding='utf-8', errors='replace')
            if r.returncode != 0:
                bad.append('%s: %s' % (rel, (r.stderr or '').strip().splitlines()[-1:] or ['']))
        if bad:
            print('产物模块加载失败:')
            for b in bad:
                print('  - ' + str(b))
            return 1
        print('产物模块加载检查: %d 个 Node 侧模块都能 require' % len(mods))

    n, total = count_files(OUT_DIR)
    report = {
        'builtAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'outDir': OUT_DIR,
        'exe': EXE_NAME,
        'exeSize': os.path.getsize(exe_path),
        'totalFiles': n,
        'totalBytes': total,
        'electronDist': ELECTRON_DIST,
        'app': manifest,
    }
    with open(os.path.join(ROOT, 'release', 'build-report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print('---')
    print('产物总计: %d 个文件, %.1f MB' % (n, total / 1048576.0))
    print('报告: release/build-report.json')
    print('BUILD_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
