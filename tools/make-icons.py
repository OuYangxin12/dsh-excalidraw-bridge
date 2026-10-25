"""Generate the Chrome extension icons (16/48/128 px) into extension/icons."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
os.makedirs(OUT, exist_ok=True)


def make(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # rounded square background with a simple vertical gradient
    radius = int(s * 0.24)
    for y in range(s):
        t = y / max(1, s - 1)
        r = int(59 + (122 - 59) * t)
        g = int(110 + (75 - 110) * t)
        b = int(246 + (255 - 246) * t)
        draw.rounded_rectangle([0, y, s - 1, y], radius=0, fill=(r, g, b, 255))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    image.putalpha(mask)
    # white "pen stroke": a stylised zig-zag line
    stroke = max(2, int(s * 0.09))
    points = [
        (int(s * 0.20), int(s * 0.68)),
        (int(s * 0.38), int(s * 0.34)),
        (int(s * 0.54), int(s * 0.60)),
        (int(s * 0.70), int(s * 0.30)),
        (int(s * 0.82), int(s * 0.52)),
    ]
    draw.line(points, fill=(255, 255, 255, 255), width=stroke, joint="curve")
    for x, y in (points[1], points[3]):
        rr = max(2, int(s * 0.055))
        draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 214, 102, 255) if (x, y) == points[1] else (255, 107, 154, 255))
    return image.resize((size, size), Image.LANCZOS)


for size in (16, 48, 128):
    path = os.path.join(OUT, f"icon-{size}.png")
    make(size).save(path, "PNG")
    print("wrote", path, os.path.getsize(path))
