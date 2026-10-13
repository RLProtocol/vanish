"""Make asset logos background-free.

For each PNG in public/logos:
  1. flood-fill from the four corners, turning a solid baked-in backdrop (white or black) transparent,
     so only pixels connected to the edge are removed and the logo's own whites/blacks survive;
  2. trim transparent margins and re-centre on a square canvas;
  3. detect single-colour marks and record them in logos-meta.json so the site can draw
     them in the current text colour (visible in both dark and light themes).

    python web/scripts/clean-logos.py
"""
import json
import os
from collections import deque

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
LOGOS = os.path.join(HERE, "..", "public", "logos")
TOL = 60  # colour distance treated as "same backdrop"


def dist(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))


def remove_backdrop(img):
    w, h = img.size
    px = img.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    opaque = [c for c in corners if c[3] > 200]
    if len(opaque) < 3:
        return img, False  # already transparent around the edges
    bg = opaque[0]
    if any(dist(c, bg) > TOL for c in opaque):
        return img, False  # corners disagree: no uniform backdrop
    seen = bytearray(w * h)
    q = deque((x, y) for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        c = px[x, y]
        if c[3] > 0 and dist(c, bg) > TOL:
            continue
        px[x, y] = (c[0], c[1], c[2], 0)
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img, True


def trim_square(img, pad_ratio=0.06):
    bbox = img.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
    if not bbox:
        return img
    img = img.crop(bbox)
    side = int(max(img.size) * (1 + 2 * pad_ratio))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    return canvas.resize((256, 256), Image.LANCZOS) if side > 256 else canvas


def is_mono(img):
    """True when all visible pixels are (near) one neutral colour, e.g. a black or white wordmark."""
    cols = [p for p in img.getdata() if p[3] > 128]
    if not cols:
        return False
    neutral = sum(1 for r, g, b, _ in cols if max(r, g, b) - min(r, g, b) < 30)
    return neutral / len(cols) > 0.97


meta = {}
for name in sorted(os.listdir(LOGOS)):
    if not name.endswith(".png"):
        continue
    path = os.path.join(LOGOS, name)
    img = Image.open(path).convert("RGBA")
    img, removed = remove_backdrop(img)
    img = trim_square(img)
    mono = is_mono(img)
    img.save(path, optimize=True)
    meta[name[:-4]] = {"mono": mono}
    print(f"{name:10} backdrop {'removed' if removed else 'none   '}  {'mono' if mono else 'colour'}  {img.size}")

with open(os.path.join(LOGOS, "..", "..", "src", "logos-meta.json"), "w") as f:
    json.dump(meta, f, indent=2)
