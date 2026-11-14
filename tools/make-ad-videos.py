# -*- coding: utf-8 -*-
"""
生成广告位用的循环视频背景。
纯程序绘制，不依赖任何素材：渐变流动 + 光带扫过 + 脉冲圆环，
首尾用周期函数对齐，循环播放无跳变。
"""

import os
import subprocess
import sys

import numpy as np
from PIL import Image

import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'ads')
TMP_DIR = os.path.join(ROOT, '_frames')

FPS = 24
DUR = 6
N = FPS * DUR


def ease_lerp(a, b, t):
    return a + (b - a) * t


def write_frames(name, frames):
    d = os.path.join(TMP_DIR, name)
    os.makedirs(d, exist_ok=True)
    for i, arr in enumerate(frames):
        Image.fromarray(arr).save(os.path.join(d, 'f%04d.png' % i))
    return d


def encode(name, frame_dir, w, h):
    mp4 = os.path.join(OUT_DIR, name + '.mp4')
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ff, '-y', '-loglevel', 'error',
        '-framerate', str(FPS),
        '-i', os.path.join(frame_dir, 'f%04d.png'),
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '27',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',
        mp4,
    ]
    subprocess.run(cmd, check=True)
    size = os.path.getsize(mp4)
    print('  %-16s %4dx%-4d  %6.0f KB' % (name + '.mp4', w, h, size / 1024.0))
    return mp4


# ---------------------------------------------------------------- 竖版 A
def gen_v_a(w=320, h=424):
    """深蓝灰 · 斜向光带扫过 · 右下脉冲圆环"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h

    for i in range(N):
        t = i / N
        d = nx * 0.6 + ny * 0.8
        wave = 0.5 + 0.5 * np.sin(2 * np.pi * (d * 0.9 - t))

        r = ease_lerp(36, 66, wave)
        g = ease_lerp(50, 86, wave)
        b = ease_lerp(72, 114, wave)
        img = np.stack([r, g, b], axis=-1)

        # 斜向扫光
        bx = (t * 1.5 - 0.25) * w
        dist = np.abs((xx * 0.75 + (h - yy) * 0.66) - bx)
        glow = np.clip(1 - dist / 58.0, 0, 1) ** 2.2
        img += glow[..., None] * np.array([68, 80, 98], np.float32)

        # 脉冲圆环
        cx, cy = w * 0.72, h * 0.80
        rad = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        rr = 56 + 9 * np.sin(2 * np.pi * t)
        ring = np.exp(-((rad - rr) ** 2) / (2 * 3.2 ** 2))
        img += ring[..., None] * np.array([46, 58, 72], np.float32)

        yield np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 竖版 B
def gen_v_b(w=320, h=424):
    """紫调 · 两团光斑缓慢游走 · 底部进度感亮条"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h

    for i in range(N):
        t = i / N
        base = 0.5 + 0.5 * np.sin(2 * np.pi * (nx * 0.45 + ny * 0.55 - t))

        r = ease_lerp(74, 96, base)
        g = ease_lerp(58, 76, base)
        b = ease_lerp(122, 152, base)
        img = np.stack([r, g, b], axis=-1)

        # 光斑 1
        c1x = w * (0.32 + 0.18 * np.sin(2 * np.pi * t))
        c1y = h * (0.30 + 0.12 * np.cos(2 * np.pi * t))
        d1 = np.sqrt((xx - c1x) ** 2 + (yy - c1y) ** 2)
        img += np.exp(-(d1 ** 2) / (2 * 88.0 ** 2))[..., None] * np.array([54, 30, 96], np.float32)

        # 光斑 2
        c2x = w * (0.72 + 0.14 * np.cos(2 * np.pi * t + 1.1))
        c2y = h * (0.66 + 0.14 * np.sin(2 * np.pi * t + 0.6))
        d2 = np.sqrt((xx - c2x) ** 2 + (yy - c2y) ** 2)
        img += np.exp(-(d2 ** 2) / (2 * 70.0 ** 2))[..., None] * np.array([92, 40, 110], np.float32)

        # 底部亮条从左往右填
        fill = (t * 1.05) * w
        bar = (yy > h - 26) & (yy < h - 22) & (xx < fill)
        img[bar] += np.array([96, 78, 140], np.float32)

        yield np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 竖版 C
def gen_v_c(w=320, h=424):
    """深青 · 网格缓慢平移 · 高亮区块滑动"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h

    for i in range(N):
        t = i / N
        wave = 0.5 + 0.5 * np.sin(2 * np.pi * (nx * 0.5 + (1 - ny) * 0.5 - t))

        r = ease_lerp(22, 38, wave)
        g = ease_lerp(62, 86, wave)
        b = ease_lerp(58, 78, wave)
        img = np.stack([r, g, b], axis=-1)

        # 网格（随 t 平移一个周期，保证循环）
        gx = (xx + t * 32) % 32
        gy = (yy + t * 32) % 32
        grid = (np.minimum(gx, 32 - gx) < 0.9) | (np.minimum(gy, 32 - gy) < 0.9)
        img[grid] += np.array([16, 26, 24], np.float32)

        # 高亮区块滑动
        hy = (t * 1.2 - 0.1) * h
        band = np.exp(-((yy - hy) ** 2) / (2 * 46.0 ** 2))
        img += band[..., None] * np.array([26, 66, 60], np.float32)

        yield np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 横版
def gen_h_a(w=480, h=270):
    """横版 · 红橙促销调 · 快速扫光"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h

    for i in range(N):
        t = i / N
        wave = 0.5 + 0.5 * np.sin(2 * np.pi * (nx * 0.7 + ny * 0.5 - t))

        r = ease_lerp(196, 226, wave)
        g = ease_lerp(64, 92, wave)
        b = ease_lerp(46, 62, wave)
        img = np.stack([r, g, b], axis=-1)

        bx = ((t * 2 - 0.5) % 1.0) * w * 1.4 - 0.2 * w
        dist = np.abs((xx * 0.9 + (h - yy) * 0.4) - bx)
        glow = np.clip(1 - dist / 46.0, 0, 1) ** 2
        img += glow[..., None] * np.array([78, 46, 30], np.float32)

        yield np.clip(img, 0, 255).astype(np.uint8)


def gen_h_b(w=480, h=270):
    """横版 · 蓝调工具风 · 网格 + 光斑"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h

    for i in range(N):
        t = i / N
        wave = 0.5 + 0.5 * np.sin(2 * np.pi * (nx * 0.6 + ny * 0.4 - t))

        r = ease_lerp(32, 52, wave)
        g = ease_lerp(74, 104, wave)
        b = ease_lerp(126, 168, wave)
        img = np.stack([r, g, b], axis=-1)

        cx = w * (0.30 + 0.22 * np.sin(2 * np.pi * t))
        cy = h * (0.45 + 0.20 * np.cos(2 * np.pi * t))
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        img += np.exp(-(d ** 2) / (2 * 110.0 ** 2))[..., None] * np.array([44, 62, 92], np.float32)

        gx = (xx + t * 28) % 28
        grid = np.minimum(gx, 28 - gx) < 0.8
        img[grid] += np.array([10, 16, 24], np.float32)

        yield np.clip(img, 0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    jobs = [
        ('ad_v_a', gen_v_a, 320, 424),
        ('ad_v_b', gen_v_b, 320, 424),
        ('ad_v_c', gen_v_c, 320, 424),
        ('ad_h_a', gen_h_a, 480, 270),
        ('ad_h_b', gen_h_b, 480, 270),
    ]

    print('生成广告视频：%d 个，每个 %ds @ %dfps' % (len(jobs), DUR, FPS))
    for name, gen, w, h in jobs:
        print(' 渲染', name, '...', flush=True)
        frames = list(gen(w, h))
        d = write_frames(name, frames)
        encode(name, d, w, h)

    print('完成，输出目录：', OUT_DIR)


if __name__ == '__main__':
    main()
