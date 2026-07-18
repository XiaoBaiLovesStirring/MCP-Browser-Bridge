#!/usr/bin/env python3
"""
Generate the extension icons (icons/icon16.png, icon48.png, icon128.png)
using only the Python standard library (zlib + struct). No Pillow needed.

Design: dark rounded-square background with a blue rounded panel and a white
"bridge" glyph (two horizontal bars joined by a vertical link) symbolizing
the browser <-> MCP bridge.
"""
import os
import struct
import zlib

OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons"))


def make_png(width, height, rgba):
    """Encode RGBA bytes (row-major) into a PNG file content."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit, RGBA
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def lerp(a, b, t):
    return int(a + (b - a) * t)


def blend(fg, alpha, bg):
    """Alpha-blend fg over bg. fg/bg are (r,g,b)."""
    return (
        lerp(bg[0], fg[0], alpha),
        lerp(bg[1], fg[1], alpha),
        lerp(bg[2], fg[2], alpha),
    )


def rounded_rect_inside(x, y, x0, y0, x1, y1, rad):
    """Return coverage [0..1] for a rounded rect."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return 0.0
    # distance to nearest corner center
    cx = min(max(x, x0 + rad), x1 - rad)
    cy = min(max(y, y0 + rad), y1 - rad)
    dx = x - cx
    dy = y - cy
    d = (dx * dx + dy * dy) ** 0.5
    if d <= rad - 0.5:
        return 1.0
    if d >= rad + 0.5:
        return 0.0
    return rad + 0.5 - d  # linear ramp


def render(size):
    buf = bytearray(size * size * 4)
    # Outer rounded square: full canvas with small corner radius
    outer_rad = max(1.0, size * 0.18)
    # Inner blue panel
    m = size * 0.18
    panel_x0, panel_y0 = m, m
    panel_x1, panel_y1 = size - m, size - m
    panel_rad = max(1.0, size * 0.14)

    # Colors
    bg_top = (0x1a, 0x1f, 0x29)
    bg_bot = (0x0f, 0x11, 0x15)
    blue = (0x4f, 0x8c, 0xff)
    white = (0xff, 0xff, 0xff)

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            # background gradient (fallback)
            t = y / max(size - 1, 1)
            r, g, b = lerp(bg_top[0], bg_bot[0], t), lerp(bg_top[1], bg_bot[1], t), lerp(bg_top[2], bg_bot[2], t)

            # outer rounded mask (transparent outside)
            outer_cov = rounded_rect_inside(x, y, 0, 0, size - 1, size - 1, outer_rad)

            # blue panel coverage
            panel_cov = rounded_rect_inside(x, y, panel_x0, panel_y0, panel_x1, panel_y1, panel_rad)
            if panel_cov > 0:
                r, g, b = blend(blue, panel_cov, (r, g, b))

            # white "bridge" glyph: two horizontal bars joined by a vertical link
            bar_h = max(1.0, size * 0.085)
            bar_margin_x = size * 0.30
            top_bar_y = size * 0.38
            bot_bar_y = size * 0.54
            link_x0 = size * 0.47
            link_x1 = size * 0.53

            in_top_bar = (bar_margin_x <= x <= size - bar_margin_x) and (top_bar_y <= y <= top_bar_y + bar_h)
            in_bot_bar = (bar_margin_x <= x <= size - bar_margin_x) and (bot_bar_y <= y <= bot_bar_y + bar_h)
            in_link = (link_x0 <= x <= link_x1) and (top_bar_y <= y <= bot_bar_y + bar_h)
            if in_top_bar or in_bot_bar or in_link:
                r, g, b = white

            alpha = int(outer_cov * 255)
            buf[i] = r
            buf[i + 1] = g
            buf[i + 2] = b
            buf[i + 3] = alpha
    return bytes(buf)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        rgba = render(size)
        png = make_png(size, size, rgba)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(png)
        print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
