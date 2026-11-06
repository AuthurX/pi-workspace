#!/usr/bin/env python3
"""Generate assets/preview.png for the pi.dev gallery (pi.image field)."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 2            # supersample factor
W, H = 1600, 1000

JB = "/usr/share/fonts/TTF/JetBrainsMono-{w}.ttf"
NOTO = "/usr/share/fonts/noto-cjk/NotoSansCJK-{w}.ttc"

# pick Noto SC index inside the ttc
def noto_index():
    for i in range(8):
        try:
            f = ImageFont.truetype(NOTO.format(w="Regular"), 20, index=i)
            if "SC" in f.getname()[0]:
                return i
        except Exception:
            break
    return 0

SC_IDX = noto_index()

def jb(weight, size):
    return ImageFont.truetype(JB.format(w=weight), size * S)

def sc(weight, size):
    return ImageFont.truetype(NOTO.format(w=weight), size * S, index=SC_IDX)

F_BODY   = jb("Regular", 34)
F_MED    = jb("Medium", 34)
F_SEMI   = jb("SemiBold", 34)
F_TAB    = jb("Medium", 25)
F_SMALL  = jb("Regular", 24)
F_SMALLM = jb("Medium", 24)
F_BODY_C = sc("Regular", 34)
F_MED_C  = sc("Medium", 34)

# palette
BG_TOP    = (13, 19, 27)
BG_BOT    = (5, 8, 12)
WIN       = (13, 20, 28)
WIN_EDGE  = (34, 48, 65)
BAR       = (17, 26, 37)
SEP       = (27, 38, 52)
TAB_ACT   = (28, 42, 58)
GRID      = (255, 255, 255, 7)
TXT       = (218, 231, 242)
TXT_DIM   = (100, 116, 137)
TXT_DIM2  = (94, 113, 131)
GREEN     = (91, 228, 155)
CYAN      = (107, 213, 225)
AMBER     = (232, 196, 104)
PATHC     = (111, 168, 201)

def s(v):
    return int(round(v * S))

img = Image.new("RGB", (W * S, H * S), BG_TOP)

# --- background vertical gradient ---
px = img.load()
for y in range(H * S):
    t = y / (H * S)
    r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
    g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
    b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
    for x in range(W * S):
        px[x, y] = (r, g, b)

# --- ambient glows ---
def glow(cx, cy, rx, ry, color, alpha, blur):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([s(cx - rx), s(cy - ry), s(cx + rx), s(cy + ry)], fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(s(blur)))
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"), (0, 0))

glow(340, 130, 640, 380, (56, 224, 168), 26, 150)
glow(1420, 920, 660, 400, (116, 106, 255), 20, 160)

# --- faint grid ---
grid = Image.new("RGBA", img.size, (0, 0, 0, 0))
gd = ImageDraw.Draw(grid)
step = 44
for x in range(0, W + 1, step):
    gd.line([s(x), 0, s(x), s(H)], fill=GRID, width=1)
for y in range(0, H + 1, step):
    gd.line([0, s(y), s(W), s(y)], fill=GRID, width=1)
img = Image.alpha_composite(img.convert("RGBA"), grid)

# --- window shadow ---
WX0, WY0, WX1, WY1 = 72, 104, 1528, 864
RAD = 20
shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle([s(WX0), s(WY0 + 22), s(WX1), s(WY1 + 30)], radius=s(RAD), fill=(0, 0, 0, 130))
shadow = shadow.filter(ImageFilter.GaussianBlur(s(34)))
img = Image.alpha_composite(img, shadow)

d = ImageDraw.Draw(img)

# --- window body ---
d.rounded_rectangle([s(WX0), s(WY0), s(WX1), s(WY1)], radius=s(RAD), fill=WIN + (255,), outline=WIN_EDGE + (255,), width=s(1.5))

# --- title bar (rounded top only) ---
BAR_H = 66
d.rounded_rectangle([s(WX0), s(WY0), s(WX1), s(WY0 + BAR_H)], radius=s(RAD), fill=BAR + (255,))
d.rectangle([s(WX0), s(WY0 + BAR_H - RAD), s(WX1), s(WY0 + BAR_H)], fill=BAR + (255,))
d.line([s(WX0), s(WY0 + BAR_H), s(WX1), s(WY0 + BAR_H)], fill=SEP + (255,), width=s(1))

# traffic lights
for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    cx = 106 + i * 28
    d.ellipse([s(cx - 9), s(WY0 + BAR_H / 2 - 9), s(cx + 9), s(WY0 + BAR_H / 2 + 9)], fill=c + (255,))

def runs(x, y, parts, font_default=F_BODY):
    """draw (text, color[, font]) runs; returns logical x"""
    cur = x
    for part in parts:
        text, color = part[0], part[1]
        font = part[2] if len(part) > 2 else font_default
        d.text((s(cur), s(y)), text, font=font, fill=color + (255,))
        cur += d.textlength(text, font=font) / S
    return cur

def check(x, y):
    """hand-drawn green checkmark (Noto lacks U+2714); advances x"""
    w = 4
    pts = [(x + 2, y + 24), (x + 13, y + 34), (x + 34, y + 8)]
    d.line([(s(px_), s(py_)) for px_, py_ in pts], fill=GREEN + (255,), width=s(w), joint="curve")
    for ex, ey in (pts[0], pts[2]):
        d.ellipse([s(ex - w / 2), s(ey - w / 2), s(ex + w / 2), s(ey + w / 2)], fill=GREEN + (255,))
    return x + 46

# --- WezTerm-style tabs ---
TABS = [("pi · billing-fix", True), ("pi · docs-redesign", False), ("pi · api-gateway", False), ("pi · scratchpad", False)]
tab_h = 44
tx = 196
for label, active in TABS:
    tw = d.textlength(label, font=F_TAB) / S + 44
    y0 = WY0 + 11
    if active:
        d.rounded_rectangle([s(tx), s(y0), s(tx + tw), s(y0 + tab_h)], radius=s(10), fill=TAB_ACT + (255,))
        d.ellipse([s(tx + 16), s(y0 + tab_h / 2 - 4), s(tx + 16 + 8), s(y0 + tab_h / 2 + 4)], fill=GREEN + (255,))
        d.text((s(tx + 34), s(y0 + 8)), label, font=F_TAB, fill=TXT + (255,))
    else:
        d.text((s(tx + 22), s(y0 + 8)), label, font=F_TAB, fill=TXT_DIM + (255,))
    tx += tw + 6
d.text((s(tx + 18), s(WY0 + 19)), "+", font=F_TAB, fill=TXT_DIM + (255,))

# --- terminal content ---
LX = 116           # left padding (aligns with traffic lights)
LY = WY0 + BAR_H + 54
LH = 64

# line 1: prompt + command
runs(LX, LY, [("$ ", GREEN, F_SEMI), ("pi-workspace", TXT, F_SEMI), (" restore", CYAN, F_MED)])

# restored lines
rows = [
    ("pi · billing-fix", "~/work/app"),
    ("pi · docs-redesign", "~/work/docs"),
    ("pi · api-gateway", "~/work/api"),
    ("pi · scratchpad", "~/notes"),
]
y = LY + LH + 12
for name, path in rows:
    cx_ = check(LX, y + 4)
    runs(cx_, y, [
        (name, TXT, F_BODY_C),
        ("：已启动并确认（", TXT_DIM, F_BODY_C),
        (path, PATHC, F_BODY_C),
        ("）", TXT_DIM, F_BODY_C),
    ])
    y += LH

# summary
y += 6
runs(LX, y, [
    ("4", AMBER, F_SEMI),
    (" 个标签页已恢复", TXT_DIM, F_BODY_C),
    ("  ·  ", TXT_DIM2, F_BODY_C),
    ("0", GREEN, F_SEMI),
    (" 个跳过", TXT_DIM, F_BODY_C),
    ("  ·  1.2s", TXT_DIM2, F_BODY_C),
])
y += LH

# hint
runs(LX, y, [
    ("  → ", TXT_DIM2, F_BODY_C),
    ("Pi 内等价入口：", TXT_DIM, F_BODY_C),
    ("/all", CYAN, F_MED_C),
    ("  ·  ", TXT_DIM2, F_BODY_C),
    ("Ctrl+Shift+O", CYAN, F_MED_C),
])
y += LH + 4

# blinking cursor prompt
runs(LX, y, [("$ ", GREEN, F_SEMI)])
d.rectangle([s(LX + 34), s(y + 5), s(LX + 52), s(y + 40)], fill=GREEN + (235,))

# --- bottom brand strip ---
STRIP_H = 60
sy = WY1 - STRIP_H
d.line([s(WX0), s(sy), s(WX1), s(sy)], fill=SEP + (255,), width=s(1))
brand_end = runs(LX, sy + 17, [
    ("@ellieyujin", GREEN, F_SMALLM),
    ("/pi-reopen", TXT, F_SMALLM),
])
install = "$ pi install npm:@ellieyujin/pi-reopen"
iw = d.textlength(install, font=F_SMALL) / S
ix = WX1 - 116 - iw
d.text((s(ix), s(sy + 17)), install, font=F_SMALL, fill=TXT_DIM2 + (255,))
desc = "restore WezTerm tabs from WSL"
dw = d.textlength(desc, font=F_SMALL) / S
d.text((s((brand_end + ix - dw) / 2), s(sy + 17)), desc, font=F_SMALL, fill=TXT_DIM2 + (255,))

# --- finalize ---
img = img.convert("RGB").resize((W, H), Image.LANCZOS)
img.save(__file__.rsplit("/", 1)[0] + "/preview.png", optimize=True)
print("saved assets/preview.png", img.size)
