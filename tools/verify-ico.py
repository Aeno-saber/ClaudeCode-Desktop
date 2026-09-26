#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验收 .ico：不只看文件头对不对，而是让 **Windows 自己**把图标取出来画一遍。

为什么非要做到这一步：
  自制的 ICO 结构写对了、能被自己的解析器读懂，并不等于 Explorer / 任务栏
  认得它。图标不对时的表现是"白纸"或空白，我在这里看不到 GUI，只能靠
  shell32 的回读结果来判定 —— ExtractIconExW 取不到、或者画出来是全透明，
  就是有问题。

判定：
  1) ExtractIconExW 返回的图标数量 > 0        —— 系统愿意解析
  2) DrawIconEx 画进 32x32 位图后，存在
     alpha>0 且颜色非纯黑的像素              —— 真的画出东西了，不是空白
"""

import ctypes
import ctypes.wintypes as wt
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
# ExtractIconExW 在 shell32 里，不在 user32 —— user32 上访问会直接
# AttributeError: function 'ExtractIconExW' not found（实测）。
shell32 = ctypes.windll.shell32

shell32.ExtractIconExW.argtypes = [wt.LPCWSTR, ctypes.c_int,
                                   ctypes.POINTER(wt.HICON), ctypes.POINTER(wt.HICON),
                                   wt.UINT]
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


def main():
    if len(sys.argv) < 2:
        print('用法: python tools/verify-ico.py <file.ico>')
        return 2
    path = sys.argv[1]

    large = wt.HICON()
    small = wt.HICON()
    n = shell32.ExtractIconExW(path, -1, None, None, 0)          # 先问一共有几个
    got = shell32.ExtractIconExW(path, 0, ctypes.byref(large), ctypes.byref(small), 1)
    print('ExtractIconExW 报告图标数: %d ；实际取出: %d' % (n, got))

    ok = n > 0
    if not ok:
        print('ICO_VERDICT=FAIL（系统解析不出图标）')
        return 1

    # 把大图标画到 32x32 的 32bpp DIB 上，看看有没有真像素
    size = 32
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = size
    bmi.bmiHeader.biHeight = -size                 # 负数 = 自上而下
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0                # BI_RGB

    hdc = user32.GetDC(None)
    bits = ctypes.c_void_p()
    hbm = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    memdc = gdi32.CreateCompatibleDC(hdc)
    old = gdi32.SelectObject(memdc, hbm)

    drawn = user32.DrawIconEx(memdc, 0, 0, large, size, size, 0, None, 3)   # DI_NORMAL
    buf = ctypes.string_at(bits, size * size * 4)

    opaque = sum(1 for i in range(3, len(buf), 4) if buf[i] > 0)
    colored = 0
    for i in range(0, len(buf), 4):
        if buf[i + 3] > 0 and (buf[i] or buf[i + 1] or buf[i + 2]):
            colored += 1

    gdi32.SelectObject(memdc, old)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(memdc)
    user32.ReleaseDC(None, hdc)
    if large:
        user32.DestroyIcon(large)
    if small:
        user32.DestroyIcon(small)

    total = size * size
    print('DrawIconEx 返回: %d（非 0 = 画成功）' % drawn)
    print('32x32 中不透明像素: %d/%d (%.1f%%)，其中带颜色的: %d'
          % (opaque, total, 100.0 * opaque / total, colored))

    good = drawn != 0 and colored > 40
    print('ICO_VERDICT=' + ('PASS' if good else 'FAIL'))
    return 0 if good else 1


if __name__ == '__main__':
    sys.exit(main())
