#!/usr/bin/env python3
"""Draws Fretzpod's home-screen icons (a little iPod on purple).

Run from the repo root: python3 dev/make_icons.py
Writes app/icon-192.png, app/icon-512.png, app/icon-maskable-512.png and
app/apple-touch-icon.png. Drawn at 4x and scaled down for smooth edges.

"Maskable" icons get cropped to a circle or squircle by Android, so that one
keeps the iPod inside the middle 80% and fills the rest with background.
"""
from PIL import Image, ImageDraw, ImageFilter

OUT = "app"
BIG = 2048


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img


def draw(scale):
    """The iPod, drawn to fill `scale` of the canvas height."""
    img = gradient(BIG, (74, 38, 128), (24, 11, 46))
    layer = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    h = BIG * scale
    w = h * 0.6
    x0, y0 = (BIG - w) / 2, (BIG - h) / 2
    # shadow
    shadow = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x0, y0 + h * 0.03, x0 + w, y0 + h * 1.03], radius=w * 0.14, fill=(0, 0, 0, 140))
    layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(BIG * 0.02)))
    # body
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=w * 0.14, fill=(232, 233, 236), outline=(190, 192, 197), width=round(BIG * 0.004))
    # screen
    sx0, sy0 = x0 + w * 0.1, y0 + w * 0.1
    sw = w * 0.8
    sh = sw * 0.75
    d.rounded_rectangle([sx0 - w * 0.02, sy0 - w * 0.02, sx0 + sw + w * 0.02, sy0 + sh + w * 0.02], radius=w * 0.04, fill=(12, 12, 14))
    d.rectangle([sx0, sy0, sx0 + sw, sy0 + sh], fill=(255, 255, 255))
    bar = sh * 0.14
    d.rectangle([sx0, sy0, sx0 + sw, sy0 + bar], fill=(214, 216, 220))
    row = (sh - bar) / 5
    d.rectangle([sx0, sy0 + bar + row * 0.3, sx0 + sw * 0.5, sy0 + bar + row * 1.3], fill=(42, 116, 214))
    for k in range(1, 4):
        y = sy0 + bar + row * (k + 0.55)
        d.rectangle([sx0 + sw * 0.06, y, sx0 + sw * 0.38, y + row * 0.32], fill=(70, 72, 78))
    d.rectangle([sx0 + sw * 0.5, sy0 + bar, sx0 + sw, sy0 + sh], fill=(124, 58, 220))
    # wheel
    cx = x0 + w / 2
    cy = sy0 + sh + (y0 + h - (sy0 + sh)) / 2
    r = w * 0.36
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(250, 250, 251), outline=(196, 198, 203), width=round(BIG * 0.004))
    rc = r * 0.36
    d.ellipse([cx - rc, cy - rc, cx + rc, cy + rc], fill=(214, 216, 220), outline=(196, 198, 203), width=round(BIG * 0.003))
    img = img.convert("RGBA")
    img.alpha_composite(layer)
    return img.convert("RGB")


def main():
    plain = draw(0.78)
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")):
        plain.resize((size, size), Image.LANCZOS).save(f"{OUT}/{name}", optimize=True)
    draw(0.62).resize((512, 512), Image.LANCZOS).save(f"{OUT}/icon-maskable-512.png", optimize=True)


if __name__ == "__main__":
    main()
