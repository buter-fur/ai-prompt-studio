#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 App 图标 icon.png（1024×1024）。

图案：左上「A」文字方块 → 弧形箭头 → 右下「图片」方块 → 弧形箭头 → 回到左上
即「文字 ⇄ 图片」的循环，全部使用圆角图形。

用捆绑 Python 跑：<dsh python> tools/make_icon.py
"""

import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "build", "icon.png")

SIZE = 1024
INSET = 88
RADIUS = 238

C1 = (108, 140, 255)   # #6c8cff
C2 = (143, 108, 255)   # #8f6cff

WHITE = (255, 255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_path(draw, points, width, fill):
    """粗折线，端点与拐角都是圆的。"""
    radius = width / 2.0
    for i in range(len(points) - 1):
        draw.line([points[i], points[i + 1]], fill=fill, width=int(round(width)))
    for x, y in points:
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)


def chevron(draw, apex, direction, size, width, fill):
    """开口式箭头（两根圆头短线组成的 V）。"""
    ax, ay = apex
    if direction == "down":
        left = (ax - size, ay - size)
        right = (ax + size, ay - size)
    elif direction == "up":
        left = (ax - size, ay + size)
        right = (ax + size, ay + size)
    else:
        raise ValueError(direction)
    rounded_path(draw, [left, apex, right], width, fill)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # ---------------- 圆角方形渐变底 ----------------
    gradient = Image.new("RGB", (SIZE, SIZE))
    pen = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        pen.line([(0, y), (SIZE, y)], fill=lerp(C1, C2, t ** 0.85))

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [INSET, INSET, SIZE - INSET, SIZE - INSET], radius=RADIUS, fill=255
    )
    canvas.paste(gradient, (0, 0), mask)

    # 顶部柔光
    glow = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(glow).ellipse(
        [INSET - 140, INSET - 470, SIZE - INSET + 140, 620], fill=66
    )
    glow = glow.filter(ImageFilter.GaussianBlur(92))
    glow = Image.composite(glow, Image.new("L", (SIZE, SIZE), 0), mask)
    canvas.paste(Image.new("RGB", (SIZE, SIZE), (255, 255, 255)), (0, 0), glow)

    # ---------------- 图案 ----------------
    art = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)

    BOX_W = 36          # 方框线宽
    LETTER_W = 42       # 字母线宽
    ARROW_W = 38        # 箭头线宽
    MOUNT_W = 32        # 山峰线宽
    BOX_R = 62          # 方框圆角

    # 左上：文字方块
    ax0, ay0, ax1, ay1 = 156, 156, 468, 468
    draw.rounded_rectangle([ax0, ay0, ax1, ay1], radius=BOX_R, outline=WHITE, width=BOX_W)

    # 方块里的「A」
    cx = (ax0 + ax1) / 2
    top_y = ay0 + 76
    base_y = ay1 - 60
    half = 74
    left_leg = (cx - half, base_y)
    apex = (cx, top_y)
    right_leg = (cx + half, base_y)
    rounded_path(draw, [left_leg, apex, right_leg], LETTER_W, WHITE)
    cross_y = base_y - (base_y - top_y) * 0.36

    def leg_x(y, from_pt, to_pt):
        ratio = (y - from_pt[1]) / (to_pt[1] - from_pt[1])
        return from_pt[0] + (to_pt[0] - from_pt[0]) * ratio

    bar_l = leg_x(cross_y, left_leg, apex)
    bar_r = leg_x(cross_y, right_leg, apex)
    rounded_path(draw, [(bar_l + 6, cross_y), (bar_r - 6, cross_y)], LETTER_W * 0.82, WHITE)

    # 右下：图片方块
    bx0, by0, bx1, by1 = 556, 556, 868, 868
    draw.rounded_rectangle([bx0, by0, bx1, by1], radius=BOX_R, outline=WHITE, width=BOX_W)

    # 方块里的「太阳」
    sun_cx, sun_cy, sun_r = bx0 + 86, by0 + 84, 27
    draw.ellipse(
        [sun_cx - sun_r, sun_cy - sun_r, sun_cx + sun_r, sun_cy + sun_r],
        outline=WHITE, width=int(MOUNT_W * 0.9),
    )

    # 图片方块里的「山」：一大一小两个圆头山峰
    m_base = by1 - 74
    rounded_path(
        draw,
        [
            (bx0 + 52, m_base),
            (bx0 + 130, by0 + 122),      # 高峰
            (bx0 + 194, by0 + 216),      # 谷底
            (bx0 + 244, by0 + 156),      # 矮峰
            (bx1 - 40, m_base),
        ],
        MOUNT_W,
        WHITE,
    )

    # 右上：向右再向下的箭头
    rounded_path(draw, [(480, 296), (668, 296), (668, 402)], ARROW_W, WHITE)
    chevron(draw, (668, 424), "down", 46, ARROW_W, WHITE)

    # 左下：向左再向上的箭头
    rounded_path(draw, [(548, 730), (360, 730), (360, 624)], ARROW_W, WHITE)
    chevron(draw, (360, 602), "up", 46, ARROW_W, WHITE)

    # 轻微外发光，小尺寸下更清晰
    halo = art.split()[3].filter(ImageFilter.GaussianBlur(10))
    halo = halo.point(lambda v: int(v * 0.5))
    canvas.paste(Image.new("RGB", (SIZE, SIZE), (255, 255, 255)), (0, 0),
                 Image.composite(halo, Image.new("L", (SIZE, SIZE), 0), mask))
    canvas = Image.alpha_composite(canvas, art)

    canvas.save(OUT, "PNG")

    for name, px in (("icon-preview-256.png", 256), ("icon-preview-64.png", 64)):
        canvas.resize((px, px), Image.LANCZOS).save(os.path.join(ROOT, "build", name), "PNG")

    print("已生成:", OUT)


if __name__ == "__main__":
    main()
