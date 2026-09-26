#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 assets/claude-logo.png（266x266 RGBA）转成多尺寸 .ico，供 Windows 快捷方式 /
exe 使用。

为什么不装 Pillow：
  本机是隔离的托管 Python（3.13.12），没装 Pillow，为了一个图标去 pip install
  既慢又污染环境。PNG 的编解码只用 zlib + struct 就能做完，比装包快得多。

为什么不能直接把原图塞进 ICO：
  ICO 目录项里的宽高各占 **1 字节**（0 表示 256），266 填不进去；
  而且只放一个 256 的原图，任务栏 32px 下是缩略质量。所以在这里做一次
  双线性缩放，生成 256/128/64/48/32/16 六档（全部用 PNG 压缩存储，
  Vista 之后的 Windows 都支持）。

用法：
  python tools/make-ico.py <输入.png> <输出.ico>
"""

import struct
import sys
import zlib

SIZES = (256, 128, 64, 48, 32, 16)


# ------------------------------------------------------------------ PNG 解码

def png_decode(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('不是 PNG 文件')

    pos, idat, ihdr = 8, [], None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length          # 4 len + 4 type + body + 4 crc
        if ctype == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif ctype == b'IDAT':
            idat.append(body)
        elif ctype == b'IEND':
            break

    if ihdr is None:
        raise ValueError('PNG 缺少 IHDR')
    w, h, depth, color, comp, filt, interlace = ihdr
    if depth != 8 or color != 6 or interlace != 0:
        raise ValueError('只支持 8bit RGBA、非隔行的 PNG（本图是 %d/%d/%d）' % (depth, color, interlace))

    raw = zlib.decompress(b''.join(idat))
    stride = w * 4
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        # 逐像素还原 PNG 的五种行过滤器
        if ftype == 0:
            pass
        elif ftype == 1:                                  # Sub
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif ftype == 2:                                  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:                                  # Average
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:                                  # Paeth
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        else:
            raise ValueError('未知的行过滤器 %d (第 %d 行)' % (ftype, y))
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


# ------------------------------------------------------------------ 缩放/编码

def resize_bilinear(w, h, src, nw, nh):
    """双线性缩放。比例很小（266→256），但比最近邻干净，不至于把细节丢掉。"""
    out = bytearray(nw * nh * 4)
    xr = (w - 1) / max(nw - 1, 1)
    yr = (h - 1) / max(nh - 1, 1)
    for y in range(nh):
        fy = y * yr
        y0 = int(fy)
        y1 = min(y0 + 1, h - 1)
        wy = fy - y0
        row0 = y0 * w * 4
        row1 = y1 * w * 4
        base = y * nw * 4
        for x in range(nw):
            fx = x * xr
            x0 = int(fx)
            x1 = min(x0 + 1, w - 1)
            wx = fx - x0
            for c in range(4):
                a = src[row0 + x0 * 4 + c]
                b = src[row0 + x1 * 4 + c]
                cc = src[row1 + x0 * 4 + c]
                d = src[row1 + x1 * 4 + c]
                top = a + (b - a) * wx
                bot = cc + (d - cc) * wx
                out[base + x * 4 + c] = int(top + (bot - top) * wy + 0.5)
    return out


def chunk(ctype, body):
    return (struct.pack('>I', len(body)) + ctype + body
            + struct.pack('>I', zlib.crc32(ctype + body) & 0xFFFFFFFF))


def png_encode(w, h, rgba):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                   # 过滤器 0（None）
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))


def build_ico(images):
    """images: [(size, png_bytes)]，按尺寸从大到小给。"""
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b'', b''
    for size, blob in images:
        dim = 0 if size >= 256 else size            # 0 在 ICO 里表示 256
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    return header + entries + blobs


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src_path, dst_path = sys.argv[1], sys.argv[2]

    with open(src_path, 'rb') as f:
        w, h, rgba = png_decode(f.read())
    print('源图: %s  %dx%d RGBA' % (src_path, w, h))

    images = []
    for s in SIZES:
        small = resize_bilinear(w, h, rgba, s, s)
        images.append((s, png_encode(s, s, small)))
        print('  生成 %3dx%-3d  %6d bytes' % (s, s, len(images[-1][1])))

    ico = build_ico(images)
    with open(dst_path, 'wb') as f:
        f.write(ico)
    print('写出: %s  %d bytes, %d 个尺寸' % (dst_path, len(ico), len(SIZES)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
