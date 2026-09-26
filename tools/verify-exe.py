#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收「打包好的 exe」两件事，都用 Windows 自己的 API 回答，不看文件大小猜：

  1) 图标是不是真的换成了 assets/claude.ico
     —— 把 exe 的第 0 号图标和 ico 的第 0 号图标都画到 32x32 位图上逐像素比。
        只比"有没有像素"会漏掉"图标换错了"这种情况。
  2) 版本信息（ProductName / FileVersion）是不是 rcedit 写进去的那份
     —— 这个决定任务栏和文件属性里显示什么。

用法：
  python tools/verify-exe.py "<exe路径>" "<对照.ico路径>"
"""

import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
shell32 = ctypes.windll.shell32
version = ctypes.windll.version

shell32.ExtractIconExW.argtypes = [wt.LPCWSTR, ctypes.c_int,
                                   ctypes.POINTER(wt.HICON), ctypes.POINTER(wt.HICON), wt.UINT]
shell32.ExtractIconExW.restype = wt.UINT
user32.DestroyIcon.argtypes = [wt.HICON]
user32.DrawIconEx.argtypes = [wt.HDC, ctypes.c_int, ctypes.c_int, wt.HICON,
                              ctypes.c_int, ctypes.c_int, wt.UINT, wt.HANDLE, wt.UINT]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wt.DWORD), ('biWidth', ctypes.c_long), ('biHeight', ctypes.c_long),
        ('biPlanes', wt.WORD), ('biBitCount', wt.WORD), ('biCompression', wt.DWORD),
        ('biSizeImage', wt.DWORD), ('biXPelsPerMeter', ctypes.c_long),
        ('biYPelsPerMeter', ctypes.c_long), ('biClrUsed', wt.DWORD), ('biClrImportant', wt.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wt.DWORD * 3)]


def render_icon(path, size=32):
    """取路径里第 0 号图标并画成 size*size 的 BGRA 缓冲。"""
    large = wt.HICON()
    small = wt.HICON()
    n = shell32.ExtractIconExW(path, 0, ctypes.byref(large), ctypes.byref(small), 1)
    if n == 0 or not large:
        return None
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = size
    bmi.bmiHeader.biHeight = -size
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32

    hdc = user32.GetDC(None)
    bits = ctypes.c_void_p()
    hbm = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    memdc = gdi32.CreateCompatibleDC(hdc)
    old = gdi32.SelectObject(memdc, hbm)
    user32.DrawIconEx(memdc, 0, 0, large, size, size, 0, None, 3)
    buf = bytes(ctypes.string_at(bits, size * size * 4))

    gdi32.SelectObject(memdc, old)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(memdc)
    user32.ReleaseDC(None, hdc)
    user32.DestroyIcon(large)
    if small:
        user32.DestroyIcon(small)
    return buf


def get_version_string(exe, key):
    r"""用 VerQueryValueW 读 \StringFileInfo\<lang>\<key>。lang 从翻译表里取。"""
    size = version.GetFileVersionInfoSizeW(exe, None)
    if not size:
        return None
    data = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(exe, 0, size, data):
        return None

    # 先问有哪些语言/代码页，别硬编码 040904B0
    buf = ctypes.c_void_p()
    length = wt.UINT()
    if not version.VerQueryValueW(data, u'\\VarFileInfo\\Translation',
                                  ctypes.byref(buf), ctypes.byref(length)):
        return None
    langs = []
    for i in range(length.value // 4):
        lo, hi = ctypes.cast(buf, ctypes.POINTER(wt.WORD))[2 * i], \
            ctypes.cast(buf, ctypes.POINTER(wt.WORD))[2 * i + 1]
        langs.append('%04X%04X' % (lo, hi))

    for lang in langs:
        sub = u'\\StringFileInfo\\%s\\%s' % (lang, key)
        if version.VerQueryValueW(data, sub, ctypes.byref(buf), ctypes.byref(length)) and length.value:
            return ctypes.wstring_at(buf.value, length.value).rstrip('\0')
    return None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    exe, ico = sys.argv[1], sys.argv[2]

    exe_buf = render_icon(exe)
    ico_buf = render_icon(ico)
    if exe_buf is None:
        print('从 exe 取不到图标（ExtractIconExW 返回 0）')
        return 1
    if ico_buf is None:
        print('从 ico 取不到图标')
        return 1

    diff = sum(1 for a, b in zip(exe_buf, ico_buf) if a != b)
    total = len(exe_buf)
    same = 100.0 * (total - diff) / total
    opaque = sum(1 for i in range(3, len(exe_buf), 4) if exe_buf[i] > 0)
    print('exe 图标 32x32 不透明像素: %d/%d' % (opaque, total // 4))
    print('与 claude.ico 渲染结果逐字节相同率: %.2f%%（不同字节 %d/%d）' % (same, diff, total))

    print('--- 版本信息 ---')
    ok_ver = True
    for key in ('ProductName', 'FileDescription', 'FileVersion', 'ProductVersion'):
        v = get_version_string(exe, key)
        print('  %-16s = %r' % (key, v))
        if key == 'ProductName' and v != 'Claude Desktop':
            ok_ver = False

    icon_ok = same > 99.0
    print('---')
    print('ICON_MATCH=' + ('YES' if icon_ok else 'NO'))
    print('EXE_VERDICT=' + ('PASS' if (icon_ok and ok_ver) else 'FAIL'))
    return 0 if (icon_ok and ok_ver) else 1


if __name__ == '__main__':
    sys.exit(main())
