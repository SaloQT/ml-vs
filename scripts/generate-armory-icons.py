#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "armory-icons"
SIZE = 128
SCALE = 4
W = SIZE * SCALE

CYAN = (90, 225, 255, 255)
BLUE = (70, 135, 255, 255)
VIOLET = (167, 139, 250, 255)
AMBER = (255, 184, 64, 255)
ROSE = (255, 91, 121, 255)
GREEN = (108, 240, 170, 255)
STEEL = (126, 148, 170, 255)
DARK = (22, 31, 46, 255)
PLATE = (48, 65, 86, 255)

ITEMS = {
    "pulse-laser": ("weapon", CYAN),
    "rail-cannon": ("weapon", AMBER),
    "scatter-core": ("weapon", ROSE),
    "coil-repeater": ("weapon", BLUE),
    "ion-lance": ("weapon", VIOLET),
    "flak-array": ("weapon", GREEN),
    "prism-carbine": ("weapon", VIOLET),
    "nova-mortar": ("weapon", AMBER),
    "scout-frame": ("hull", CYAN),
    "bulwark-frame": ("hull", AMBER),
    "standard-frame": ("hull", STEEL),
    "interceptor-frame": ("hull", BLUE),
    "aegis-frame": ("hull", GREEN),
    "reactor-frame": ("hull", ROSE),
    "magnet-rig": ("utility", CYAN),
    "targeting-suite": ("utility", ROSE),
    "repair-cache": ("utility", GREEN),
    "salvage-net": ("utility", AMBER),
    "overclock-relay": ("utility", VIOLET),
    "stabilizer-vanes": ("utility", BLUE),
    "reinforced-hull": ("upgrade", AMBER),
    "reactor-tuning": ("upgrade", ROSE),
    "combat-drills": ("upgrade", VIOLET),
    "nav-school": ("upgrade", BLUE),
    "scrap-charter": ("upgrade", AMBER),
    "field-medicine": ("upgrade", GREEN),
}


def s(value):
    return int(round(value * SCALE))


def scaled(points):
    return [(s(x), s(y)) for x, y in points]


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def poly(draw, points, fill, outline=None, width=2):
    draw.polygon(scaled(points), fill=fill)
    if outline:
        draw.line(scaled(points + [points[0]]), fill=outline, width=s(width), joint="curve")


def line(draw, points, fill, width=4):
    draw.line(scaled(points), fill=fill, width=s(width), joint="curve")


def ellipse(draw, box, fill, outline=None, width=2):
    draw.ellipse(tuple(s(v) for v in box), fill=fill, outline=outline, width=s(width))


def rect(draw, box, fill, outline=None, width=2, radius=0):
    xy = tuple(s(v) for v in box)
    draw.rounded_rectangle(xy, radius=s(radius), fill=fill, outline=outline, width=s(width))


def weapon(draw, name, accent):
    poly(draw, [(24, 70), (78, 36), (104, 48), (50, 84)], PLATE, STEEL, 2)
    poly(draw, [(74, 34), (110, 24), (100, 45), (70, 50)], mix(accent, PLATE, 0.2), accent, 2)
    rect(draw, (38, 72, 64, 88), DARK, STEEL, 2, 4)
    line(draw, [(30, 78), (95, 39)], accent, 5)
    ellipse(draw, (43, 54, 59, 70), accent, None)
    if name in {"rail-cannon", "nova-mortar"}:
        rect(draw, (76, 28, 112, 45), DARK, accent, 3, 7)
        ellipse(draw, (91, 45, 113, 67), mix(accent, (255, 255, 255, 255), 0.18), None)
    elif name in {"scatter-core", "flak-array"}:
        for y in (34, 46, 58):
            line(draw, [(72, y), (110, y - 10)], accent, 4)
    elif name == "prism-carbine":
        poly(draw, [(76, 30), (99, 37), (87, 56)], mix(VIOLET, (255, 255, 255, 255), 0.1), CYAN, 2)
    elif name == "coil-repeater":
        for x in (60, 69, 78):
            ellipse(draw, (x, 45, x + 12, 57), None, accent, 3)
    elif name == "ion-lance":
        line(draw, [(79, 32), (113, 20)], mix(accent, (255, 255, 255, 255), 0.28), 3)


def hull(draw, name, accent):
    poly(draw, [(64, 20), (102, 76), (64, 108), (26, 76)], DARK, STEEL, 2)
    poly(draw, [(64, 28), (89, 73), (64, 94), (39, 73)], PLATE, accent, 2)
    poly(draw, [(64, 20), (78, 72), (64, 101), (50, 72)], mix(accent, PLATE, 0.35), None)
    if "bulwark" in name or "reinforced" in name:
        rect(draw, (35, 63, 93, 83), mix(AMBER, PLATE, 0.55), AMBER, 2, 7)
    if "aegis" in name:
        ellipse(draw, (34, 34, 94, 102), None, GREEN, 4)
    if "interceptor" in name or "scout" in name:
        line(draw, [(30, 90), (16, 108)], accent, 5)
        line(draw, [(98, 90), (112, 108)], accent, 5)
    if "reactor" in name:
        ellipse(draw, (52, 58, 76, 82), ROSE, None)


def utility(draw, name, accent):
    ellipse(draw, (31, 31, 97, 97), DARK, STEEL, 2)
    rect(draw, (45, 45, 83, 83), PLATE, accent, 2, 8)
    if "magnet" in name:
        line(draw, [(45, 45), (45, 83), (83, 83), (83, 45)], accent, 7)
    elif "targeting" in name:
        ellipse(draw, (43, 43, 85, 85), None, accent, 4)
        line(draw, [(64, 34), (64, 94)], accent, 3)
        line(draw, [(34, 64), (94, 64)], accent, 3)
    elif "repair" in name or "medicine" in name:
        rect(draw, (57, 39, 71, 89), accent, None, radius=3)
        rect(draw, (39, 57, 89, 71), accent, None, radius=3)
    elif "salvage" in name or "scrap" in name:
        for x, y in [(46, 52), (66, 44), (73, 68), (54, 75)]:
            poly(draw, [(x, y - 9), (x + 10, y), (x, y + 9), (x - 10, y)], accent, AMBER, 1)
    elif "overclock" in name or "reactor-tuning" in name:
        line(draw, [(42, 74), (60, 38), (62, 62), (84, 52), (66, 90)], accent, 6)
    elif "stabilizer" in name or "nav" in name:
        poly(draw, [(64, 32), (84, 91), (64, 80), (44, 91)], accent, CYAN, 2)
    else:
        line(draw, [(42, 78), (86, 50)], accent, 5)


def upgrade(draw, name, accent):
    if "hull" in name:
        hull(draw, name, accent)
    elif "drills" in name:
        weapon(draw, "ion-lance", accent)
    else:
        utility(draw, name, accent)


def render_icon(name, kind, accent):
    image = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    ellipse(gd, (30, 30, 98, 98), (*accent[:3], 60), None)
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(5))))
    draw = ImageDraw.Draw(image)
    if kind == "weapon":
        weapon(draw, name, accent)
    elif kind == "hull":
        hull(draw, name, accent)
    elif kind == "utility":
        utility(draw, name, accent)
    else:
        upgrade(draw, name, accent)
    line(draw, [(34, 102), (94, 102)], (*accent[:3], 130), 2)
    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def validate(path):
    image = Image.open(path).convert("RGBA")
    if image.size != (SIZE, SIZE):
        raise ValueError(f"{path.name}: expected 128x128, got {image.size}")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"{path.name}: empty alpha")
    left, top, right, bottom = bbox
    if min(left, top, SIZE - right, SIZE - bottom) < 8:
        raise ValueError(f"{path.name}: silhouette padding too small: {bbox}")
    edge = 0
    for x in range(SIZE):
        edge += alpha.getpixel((x, 0)) + alpha.getpixel((x, SIZE - 1))
    for y in range(SIZE):
        edge += alpha.getpixel((0, y)) + alpha.getpixel((SIZE - 1, y))
    if edge:
        raise ValueError(f"{path.name}: non-transparent edge pixels")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (kind, accent) in ITEMS.items():
        path = OUT / f"{name}-128.png"
        render_icon(name, kind, accent).save(path)
        validate(path)
    print(f"generated and validated {len(ITEMS)} armory icons in {OUT}")


if __name__ == "__main__":
    main()
