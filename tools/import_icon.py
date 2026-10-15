#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把一张图片（或从 PDF 渲染出来的图）转成符合 macOS 规范的 App 图标。

做三件事：
  1. 自动裁到「非透明内容」的包围盒
  2. 按 Apple 的图标网格缩放到 content/canvas 并居中
     —— macOS 上所有 App 图标共用同一张网格：1024 画布里内容占 824，
        这样在 Dock 里跟 Finder / Safari 摆在一起大小才一致
  3. 输出 build/icon.png（1024×1024，带透明通道）

用法：
  python3 tools/import_icon.py <源图片> [--canvas 1024] [--content 824]
  python3 tools/import_icon.py --from-pdf <文件.pdf>      # 先渲染 PDF 再处理

依赖 Pillow（用捆绑 Python 跑即可）。
"""

import argparse
import os
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")

# Apple 的 macOS App 图标网格
DEFAULT_CANVAS = 1024
DEFAULT_CONTENT = 824


def render_pdf(path, target_max=4096, out_dir=None):
    """把 PDF 第一页渲染成 PNG（sips 走 ImageIO，矢量重绘，不会糊）。"""
    out_dir = out_dir or tempfile.mkdtemp(prefix="icon-pdf-")
    out = os.path.join(out_dir, "page.png")
    subprocess.run(
        ["sips", "-s", "format", "png", "-Z", str(target_max), path, "--out", out],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return out


def content_bbox(image):
    """返回非透明像素的包围盒。"""
    alpha = image.split()[-1]
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    return box


def build_icon(source, canvas=DEFAULT_CANVAS, content=DEFAULT_CONTENT, out=None):
    image = Image.open(source).convert("RGBA")

    box = content_bbox(image)
    if box is None:
        raise SystemExit("源图里没有找到任何不透明内容")
    trimmed = image.crop(box)

    # 内容区是正方形：先把裁出来的部分居中放进正方形
    side = max(trimmed.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(trimmed, ((side - trimmed.width) // 2, (side - trimmed.height) // 2))

    # 缩放到 Apple 网格尺寸
    art = square.resize((content, content), Image.LANCZOS)

    icon = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    offset = (canvas - content) // 2
    icon.paste(art, (offset, offset))

    out = out or os.path.join(BUILD, "icon.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    icon.save(out, "PNG")

    # 再存一份「满版」的方形源图：
    #   macOS 用带边距的 icon.png（Apple 网格），Windows 的 .ico 用满版的
    square_out = os.path.join(os.path.dirname(out), "icon-square.png")
    square.resize((canvas, canvas), Image.LANCZOS).save(square_out, "PNG")

    print("源图      : %s (%dx%d)" % (source, image.width, image.height))
    print("裁切包围盒: %s → %dx%d" % (box, trimmed.width, trimmed.height))
    print("macOS 图标: %s (%dx%d，内容 %d，带 Apple 网格边距)" % (out, canvas, canvas, content))
    print("Windows 源: %s (%dx%d，满版，用于生成 .ico)" % (square_out, canvas, canvas))
    return out


def main():
    parser = argparse.ArgumentParser(description="生成 macOS App 图标")
    parser.add_argument("source", help="源图片；配合 --from-pdf 时是 PDF 路径")
    parser.add_argument("--from-pdf", action="store_true", help="先把 PDF 渲染成图片")
    parser.add_argument("--canvas", type=int, default=DEFAULT_CANVAS)
    parser.add_argument("--content", type=int, default=DEFAULT_CONTENT)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    src = args.source
    if args.from_pdf:
        src = render_pdf(src)

    build_icon(src, args.canvas, args.content, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
