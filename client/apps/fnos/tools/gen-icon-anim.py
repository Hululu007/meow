#!/usr/bin/env python3
"""把应用图标生成「斜向扫光」动图（Animated WebP）。

为什么需要它：fnOS 的图标是静态文件直出，只能用**动图内容**做出扫光效果。
浏览器对 <img> 按字节嗅探格式，所以 .PNG 文件名装 WebP 内容照样播（真实案例：
米恋泥 fndesk 的 ICON.PNG 就是 35 帧动画 WebP，安装时 cp 覆盖根目录图标）。

时间轴照抄 fndesk 的观感：1s 静止 → 33 帧 × 20ms 斜扫 → 5s 收尾静止，无限循环。

用法：
    # meow fpk 的 256 图标（默认）
    python client/apps/fnos/tools/gen-icon-anim.py
    # 别的项目 / 别的尺寸（像素参数按 256 等比缩放）
    python client/apps/fnos/tools/gen-icon-anim.py \
        --src <源图.png> --out <输出.webp> --size 512

产物默认：client/apps/fnos/fpk/app/ui/images/icon_anim.webp
★ 生成后由 fpk/cmd/install_callback 与 upgrade_callback 覆盖到根目录 ICON*.PNG，
  见 client/apps/fnos/fpk/cmd/install_callback。
"""
import argparse
import math
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, '..', 'fpk', 'ICON_256.PNG')
DEFAULT_OUT = os.path.join(HERE, '..', 'fpk', 'app', 'ui', 'images', 'icon_anim.webp')

HOLD_START_MS = 1000
SWEEP_FRAMES = 33
FRAME_MS = 20
HOLD_END_MS = 5000
LOOP = 0  # 0 = 无限循环

# 光带剖面：一条 45° 宽带 + 一条窄高光核（纯宽带会像蒙了一层雾）
PEAK = 0.50
SIGMA = 34.0
CORE_PEAK = 0.22
CORE_SIGMA = 12.0
# 高光后面拖一条很淡的暗边：没有它，光带扫过白色猫头时完全看不见（整个图标是
# 白猫 + 青底，只有青色区域会变亮），观感会变成"两个角闪一下"。
# 峰值 0.18 —— 再高就像脏印子。
SHADE_PEAK = 0.18
SHADE_SIGMA = 24.0
SHADE_OFFSET = -42.0  # 沿扫光相反方向落后一点（拖在高光后面）

# 扫过区间（按 x+y 投影，0..2*(size-1)）：首末帧都要**看得见一点光**。
# ★ 区间若从完全在角落外开始，相邻帧会一模一样，PIL 写 WebP 时会把它们并进上一帧
#   （实测 35 帧被并成 31 帧、1000ms 变 1040ms）。所以两端都收进圆角外沿一点点。
START_P = 20.0
END_P = 492.0

REF_SIZE = 256.0  # 上面这些像素参数的基准尺寸


def band_alpha(p0, sigma, core_sigma, span):
    """按 x+y 投影给出一条 45° 光带的 alpha 查找表（索引 = x+y）。"""
    out = bytearray(span)
    for s in range(span):
        d = s - p0
        i = PEAK * math.exp(-((d / sigma) ** 2)) + CORE_PEAK * math.exp(-((d / core_sigma) ** 2))
        v = int(i * 255)
        out[s] = 255 if v > 255 else v
    return out


def shade_alpha(p0, sigma, offset, span):
    """高光后方的淡暗边（同样按 x+y 投影）。"""
    out = bytearray(span)
    for s in range(span):
        d = s - p0 - offset
        out[s] = int(SHADE_PEAK * math.exp(-((d / sigma) ** 2)) * 255)
    return out


def paint(lut, rgb, size, opaque):
    """按 alpha 查找表铺一层纯色；透明像素（圆角外）不铺。"""
    w, h = size
    layer = Image.new('RGBA', (w, h), rgb + (0,))
    lay = layer.load()
    for y in range(h):
        row = opaque[y]
        for x in range(w):
            if row[x]:
                a = lut[x + y]
                if a:
                    lay[x, y] = rgb + (a,)
    return layer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC, help='源图（正方形 PNG）')
    ap.add_argument('--out', default=DEFAULT_OUT, help='输出 .webp')
    ap.add_argument('--size', type=int, default=0, help='强制输出边长（留空用源图尺寸）')
    ap.add_argument('--loop', type=int, default=LOOP,
                    help='循环次数：0=无限（飞牛图标用），1=只扫一次（应用内 logo 用）')
    args = ap.parse_args()

    base = Image.open(args.src).convert('RGBA')
    if args.size and base.width != args.size:
        base = base.resize((args.size, args.size), Image.LANCZOS)
    w, h = base.size
    if w != h:
        raise SystemExit(f'源图必须是正方形，实际 {w}x{h}')
    size = (w, h)

    k = w / REF_SIZE
    sigma, core_sigma = SIGMA * k, CORE_SIGMA * k
    shade_sigma, shade_offset = SHADE_SIGMA * k, SHADE_OFFSET * k
    start_p, end_p = START_P * k, END_P * k
    span = 2 * (w - 1) + 1

    base_px = base.load()
    # 只让不透明处有光：透明圆角外不刷白
    opaque = [[base_px[x, y][3] > 0 for x in range(w)] for y in range(h)]

    frames = [base]
    for i in range(SWEEP_FRAMES):
        t = i / (SWEEP_FRAMES - 1)
        p0 = start_p + t * (end_p - start_p)
        frame = Image.alpha_composite(
            base, paint(shade_alpha(p0, shade_sigma, shade_offset, span), (18, 60, 70), size, opaque))
        frame = Image.alpha_composite(
            frame, paint(band_alpha(p0, sigma, core_sigma, span), (255, 255, 255), size, opaque))
        frames.append(frame)
    frames.append(base)

    durations = [HOLD_START_MS] + [FRAME_MS] * SWEEP_FRAMES + [HOLD_END_MS]
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=args.loop,
        quality=78,
        method=6,
    )
    print(f'{out}  {os.path.getsize(out)} bytes  {w}x{h}  frames={len(frames)}  '
          f'loop={HOLD_START_MS}+{SWEEP_FRAMES}x{FRAME_MS}+{HOLD_END_MS}ms')


if __name__ == '__main__':
    main()
