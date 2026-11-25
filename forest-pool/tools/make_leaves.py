# Procedural beech foliage textures.
#   leaf_atlas.webp / leaf_atlas_n.jpg : 4 single leaves (256x512 cells) for instanced leaf geometry
#   spray_atlas.webp / spray_atlas_n.jpg : 4 flat twig sprays (alternate leaves on zig-zag twigs), 2x2
#   bough_atlas.webp / bough_atlas_n.jpg : 2 whole branch ends built from the sprays, for distant trees
# Leaf outline maths is mirrored in src/foliage.js (leafHalfWidth).
import sys, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

OUT = sys.argv[1] if len(sys.argv) > 1 else 'assets'
rs = np.random.RandomState(7)
random.seed(11)

def fbm2(shape, scale, seed, octaves=4):
    r = np.random.RandomState(seed)
    out = np.zeros(shape, np.float32); amp = 1.0; tot = 0
    for o in range(octaves):
        n = max(2, int(round(scale * (2 ** o))))
        g = r.rand(n + 1, int(n * shape[1] / shape[0]) + 2).astype(np.float32)
        z = ndimage.zoom(g, (shape[0] / (g.shape[0] - 1), shape[1] / (g.shape[1] - 1)), order=3)[:shape[0], :shape[1]]
        out += amp * z; tot += amp; amp *= 0.5
    return out / tot

def half_width(t):
    t = np.clip(t, 0, 1)
    return 0.30 * np.power(np.maximum(np.sin(np.pi * np.power(t, 0.80)), 0), 0.85) * (1 - 0.22 * t * t)

LEAF_V0, LEAF_V1 = 0.07, 0.95   # base and tip of the blade in cell v (0 = bottom)

def make_leaf(variant, W=512, H=1024):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    v = 1 - (ys + 0.5) / H
    L = (LEAF_V1 - LEAF_V0)          # blade length in cell-height units
    t = (v - LEAF_V0) / L
    narrow = [1.0, 0.9, 1.06, 0.97][variant]
    bend = [0.0, 0.012, -0.01, 0.008][variant]
    x = ((xs + 0.5) / W - 0.5) * (W / H) / L          # lateral, in blade lengths
    x = x - bend * np.sin(np.pi * np.clip(t, 0, 1))
    ax = np.abs(x)
    nv = 8
    dt = 0.86 / nv
    slope = 0.95
    side = np.where(x > 0, 0.0, 0.35)
    phase = (t - slope * ax - 0.06) / dt + side
    fr = phase - np.floor(phase)
    hw = half_width(t) * narrow
    scal = 1 + 0.045 * np.cos(2 * np.pi * (phase - 0.15)) * np.clip(t * 4, 0, 1)
    edge = hw * scal - ax
    px = 1.0 / (H * L)
    alpha = np.clip(edge / (1.5 * px) + 0.5, 0, 1) * ((t > 0) & (t < 1))
    # veins
    dv = np.minimum(fr, 1 - fr) * dt * 0.72
    reach = np.clip(1 - ax / np.maximum(hw, 1e-4), 0, 1)
    vw = 0.0032 * (0.45 + 0.55 * reach)
    vein = np.exp(-(dv / vw) ** 2) * (phase > 0) * (phase < nv + 0.6)
    mid = np.exp(-(ax / (0.0075 * (1.05 - 0.75 * np.clip(t, 0, 1)))) ** 2)
    along = (ax / 0.72) * 34 + 2.5 * fbm2((H, W), 6, 30 + variant)
    tert = (np.abs(np.sin(np.pi * along)) < 0.16).astype(np.float32) * 0.5
    tert = ndimage.gaussian_filter(tert, 0.8)
    # height: lamina bulges between the secondary veins, veins and midrib sit in grooves
    pleat = np.power(np.sin(np.pi * fr), 0.8) * np.clip(reach * 3, 0, 1) * np.clip(ax / 0.03, 0, 1)
    height = 0.9 * pleat - 0.5 * vein - 0.9 * mid - 0.1 * tert + 0.5 * fbm2((H, W), 24, 50 + variant, 3)
    height += 0.6 * np.clip(1 - reach * 5, 0, 1)                 # slightly rolled margin
    height = ndimage.gaussian_filter(height, 1.4)
    gy, gx = np.gradient(height)
    strength = 9.0
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(gx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / ln, ny / ln, nz / ln], -1)
    # colour (sRGB)
    base = np.array([[62, 106, 30], [84, 124, 34], [48, 92, 28], [70, 108, 30]][variant], np.float32)
    lo = fbm2((H, W), 3, 70 + variant, 3) - 0.5
    hi = fbm2((H, W), 40, 90 + variant, 2) - 0.5
    col = base[None, None, :] * (1 + 0.32 * lo[..., None] + 0.12 * hi[..., None])
    col *= (0.9 + 0.2 * pleat[..., None])
    col[..., 0] += 26 * lo + 6; col[..., 2] -= 6 * lo
    veincol = np.array([138, 158, 74], np.float32)
    vm = np.clip(0.75 * vein + 0.95 * mid + 0.18 * tert, 0, 1)[..., None]
    col = col * (1 - vm) + veincol * vm
    col *= (0.82 + 0.18 * np.clip(reach * 6, 0, 1))[..., None]      # darker rim
    if variant == 3:  # an older leaf: yellowing patches, brown specks, a couple of insect holes
        blot = np.clip((fbm2((H, W), 5, 123, 3) - 0.56) * 9, 0, 1)[..., None]
        col = col * (1 - 0.75 * blot) + np.array([150, 138, 44], np.float32) * 0.75 * blot
        r = np.random.RandomState(5)
        for k in range(26):
            cx, cy, rad = r.randint(60, W - 60), r.randint(140, H - 140), r.uniform(3, 9)
            d = np.hypot(xs - cx, ys - cy)
            m = np.clip(1 - d / rad, 0, 1)[..., None] ** 0.5
            col = col * (1 - 0.8 * m) + np.array([86, 58, 30], np.float32) * 0.8 * m
        for cx, cy, rad in [(190, 420, 16), (330, 640, 11)]:
            d = np.hypot((xs - cx) * 1.3, ys - cy) + 6 * (fbm2((H, W), 30, 9, 2) - 0.5)
            alpha *= np.clip((d - rad) / 2, 0, 1)
            m = np.clip(1 - (d - rad) / 7, 0, 1)[..., None] * 0.7
            col = col * (1 - m) + np.array([92, 66, 34], np.float32) * m
    if variant == 1:
        col[..., 0] += 10; col[..., 1] += 8
    col = np.clip(col, 0, 255)
    rgba = np.dstack([col, alpha * 255]).astype(np.uint8)
    nrm = ((normal * 0.5 + 0.5) * 255).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA').resize((W // 2, H // 2), Image.LANCZOS), Image.fromarray(nrm, 'RGB').resize((W // 2, H // 2), Image.LANCZOS)

def bleed(rgba, iters=24):
    """Push colour outwards into transparent texels so mip-maps do not pick up a dark fringe."""
    a = np.array(rgba).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3:] / 255
    acc = rgb * (al > 0.5); wgt = (al > 0.5).astype(np.float32)
    for _ in range(iters):
        b = ndimage.uniform_filter(acc, (5, 5, 1)); w = ndimage.uniform_filter(wgt, (5, 5, 1))
        fill = (wgt < 0.5) & (w > 1e-3)
        acc = np.where(fill, b / np.maximum(w, 1e-6), acc); wgt = np.where(fill, 1.0, wgt)
    mean = rgb[al[..., 0] > 0.5].mean(0) if (al > 0.5).any() else np.zeros(3)
    acc = np.where(wgt < 0.5, mean, acc)
    return Image.fromarray(np.dstack([acc, a[..., 3:]]).astype(np.uint8), 'RGBA')

leaves = [make_leaf(i) for i in range(4)]
atlas = Image.new('RGBA', (1024, 512)); atlas_n = Image.new('RGB', (1024, 512), (128, 128, 255))
for i, (c, n) in enumerate(leaves):
    atlas.paste(bleed(c), (i * 256, 0)); atlas_n.paste(n, (i * 256, 0))
atlas.save(f'{OUT}/leaf_atlas.webp', quality=92, method=6)
atlas_n.save(f'{OUT}/leaf_atlas_n.jpg', quality=90)

# --- sprays -----------------------------------------------------------------
TWIG = (86, 72, 58)

def tint(im, hue, sat, val):
    a = im.getchannel('A')
    hsv = np.array(im.convert('RGB').convert('HSV')).astype(np.float32)
    hsv[..., 0] = np.clip(hsv[..., 0] + hue, 0, 255); hsv[..., 1] = np.clip(hsv[..., 1] * sat, 0, 255); hsv[..., 2] = np.clip(hsv[..., 2] * val, 0, 255)
    o = Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB'); o.putalpha(a); return o

class Canvas:
    def __init__(self, size):
        self.size = size
        self.col = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        self.nrm = Image.new('RGB', (size, size), (128, 128, 255))
        self.ops = []
    def twig(self, pts, w0, w1):
        d = ImageDraw.Draw(self.col); dn = ImageDraw.Draw(self.nrm)
        n = len(pts) - 1
        for i in range(n):
            w = w0 + (w1 - w0) * i / max(1, n - 1)
            k = 0.85 + 0.3 * random.random()
            c = tuple(int(v * k) for v in TWIG) + (255,)
            d.line([pts[i], pts[i + 1]], fill=c, width=max(1, int(round(w))))
            dn.line([pts[i], pts[i + 1]], fill=(128, 128, 255), width=max(1, int(round(w))))
            if w > 2.5: d.ellipse([pts[i][0] - w * 0.6, pts[i][1] - w * 0.6, pts[i][0] + w * 0.6, pts[i][1] + w * 0.6], fill=c)
    def leaf(self, x, y, ang, length, variant=None, petiole=0.1):
        """Base of the petiole at (x, y); ang = direction of the leaf, degrees CCW from +x (image y is down)."""
        v = random.randrange(4) if variant is None else variant
        if v == 3 and random.random() < 0.6: v = random.randrange(3)
        c, n = leaves[v]
        roll = math.radians(random.gauss(0, 24)); pitch = math.radians(random.gauss(8, 16))
        sw, sl = max(0.45, math.cos(roll)), max(0.6, math.cos(pitch))
        blade = length / (LEAF_V1 - LEAF_V0)
        h = max(8, int(blade * sl)); w = max(4, int(blade * 0.5 * sw))
        c2 = tint(c.resize((w, h), Image.LANCZOS), random.gauss(0, 2.2), random.uniform(0.85, 1.12), random.uniform(0.82, 1.14))
        n2 = n.resize((w, h), Image.LANCZOS)
        # petiole
        pl = length * petiole
        bx, by = x + math.cos(math.radians(ang)) * pl, y - math.sin(math.radians(ang)) * pl
        ImageDraw.Draw(self.col).line([(x, y), (bx, by)], fill=(120, 138, 62, 255), width=2)
        # pad so the blade base (cell v = LEAF_V0) is the rotation centre
        pad = Image.new('RGBA', (w * 2 + 2 * h, 2 * h), (0, 0, 0, 0)); padn = Image.new('RGB', pad.size, (128, 128, 255))
        ox, oy = pad.size[0] // 2 - w // 2, h - int(h * (1 - LEAF_V0))
        pad.paste(c2, (ox, oy)); padn.paste(n2, (ox, oy))
        rot = ang - 90
        pr = pad.rotate(rot, resample=Image.BICUBIC); pn = padn.rotate(rot, resample=Image.BICUBIC)
        # rotate normal vectors and add the leaf's own tilt
        nn = np.array(pn).astype(np.float32) / 127.5 - 1
        tx, ty = math.sin(roll) * 0.9, math.sin(pitch) * 0.9   # tilt in leaf space (x across, y along)
        nn[..., 0] += tx; nn[..., 1] += ty
        th = math.radians(rot); ct, st = math.cos(th), math.sin(th)
        rx = nn[..., 0] * ct - nn[..., 1] * st; ry = nn[..., 0] * st + nn[..., 1] * ct
        nn[..., 0], nn[..., 1] = rx, ry
        nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
        pn = Image.fromarray(((nn * 0.5 + 0.5) * 255).astype(np.uint8), 'RGB')
        px, py = int(bx - pad.size[0] / 2), int(by - pad.size[1] / 2)
        # contact shade under the new leaf
        sh = pr.getchannel('A').filter(ImageFilter.GaussianBlur(5)).point(lambda q: int(q * 0.42))
        dark = Image.new('RGBA', pr.size, (10, 22, 6, 0)); dark.putalpha(sh)
        box = (px + 3, py + 5)
        tmp = Image.new('RGBA', self.col.size, (0, 0, 0, 0)); tmp.paste(dark, box)
        ca = self.col.getchannel('A')
        tmp.putalpha(Image.fromarray(np.minimum(np.array(tmp.getchannel('A')), np.array(ca))))
        self.col.alpha_composite(tmp)
        layer = Image.new('RGBA', self.col.size, (0, 0, 0, 0)); layer.paste(pr, (px, py))
        self.col.alpha_composite(layer)
        self.nrm.paste(pn, (px, py), pr.getchannel('A'))

def shoot(cv, x, y, ang, length, leaf_len, depth=0, bare=0.0):
    """A zig-zag beech shoot with alternate leaves in one plane. Returns nothing; draws into cv."""
    inter = leaf_len * random.uniform(0.34, 0.44)
    n = max(3, int(length / inter))
    pts = [(x, y)]; a = ang; side = random.choice([-1, 1])
    nodes = []
    for i in range(n):
        a += side * random.uniform(5, 11) + random.gauss(0, 2)   # zig-zag
        step = inter * (1.0 - 0.35 * i / n)
        x += math.cos(math.radians(a)) * step; y -= math.sin(math.radians(a)) * step
        pts.append((x, y)); nodes.append((x, y, a, side, i / n))
        side = -side
    cv.twig(pts, 5.0 - 1.6 * depth if depth < 2 else 2, 1.2)
    order = list(range(len(nodes)))
    for i in order:
        nx, ny, na, sd, f = nodes[i]
        if f < bare:
            if depth < 2 and random.random() < 0.75:
                shoot(cv, nx, ny, na + sd * random.uniform(38, 58), length * random.uniform(0.34, 0.55) * (1 - 0.4 * f), leaf_len * 0.95, depth + 1, 0.0)
            continue
        la = na + sd * random.uniform(42, 68)
        ll = leaf_len * (0.72 + 0.4 * math.sin(math.pi * min(1, f * 1.15))) * random.uniform(0.88, 1.1)
        cv.leaf(nx, ny, la, ll)
    lx, ly = pts[-1]
    cv.leaf(lx, ly, a + random.gauss(0, 8), leaf_len * 0.8)

def make_spray(i, size=1024):
    cv = Canvas(size)
    leaf_len = size * 0.118
    # a main shoot whose lower part carries side shoots, as on a real branch end
    shoot(cv, size * 0.5, size * 0.985, 90 + random.gauss(0, 4), size * random.uniform(0.80, 0.86), leaf_len, 0, bare=[0.42, 0.5, 0.36, 0.46][i])
    return cv

sprays = [make_spray(i) for i in range(4)]
sa = Image.new('RGBA', (2048, 2048)); sn = Image.new('RGB', (2048, 2048), (128, 128, 255))
for i, cv in enumerate(sprays):
    pos = ((i % 2) * 1024, (i // 2) * 1024)
    sa.paste(bleed(cv.col, 30), pos); sn.paste(cv.nrm, pos)
sa.save(f'{OUT}/spray_atlas.webp', quality=90, method=6, alpha_quality=92)
sn.resize((1024, 1024), Image.LANCZOS).save(f'{OUT}/spray_atlas_n.jpg', quality=88)

# --- boughs (far LOD): a forking branch end carrying many sprays -------------
def rot_n(img_n, rot):
    nn = np.array(img_n).astype(np.float32) / 127.5 - 1
    th = math.radians(rot); ct, st = math.cos(th), math.sin(th)
    rx = nn[..., 0] * ct - nn[..., 1] * st; ry = nn[..., 0] * st + nn[..., 1] * ct
    nn[..., 0], nn[..., 1] = rx, ry
    return Image.fromarray(((np.clip(nn, -1, 1) * 0.5 + 0.5) * 255).astype(np.uint8), 'RGB')

def make_bough(seed, size=1024):
    random.seed(seed)
    col = Image.new('RGBA', (size, size), (0, 0, 0, 0)); nrm = Image.new('RGB', (size, size), (128, 128, 255))
    d = ImageDraw.Draw(col)
    def place(x, y, ang, s):
        cv = random.choice(sprays)
        w = int(size * s)
        c = tint(cv.col.resize((w, w), Image.LANCZOS), random.gauss(0, 1.5), 1.0, random.uniform(0.85, 1.1))
        n = cv.nrm.resize((w, w), Image.LANCZOS)
        pad = Image.new('RGBA', (2 * w, 2 * w), (0, 0, 0, 0)); padn = Image.new('RGB', (2 * w, 2 * w), (128, 128, 255))
        pad.paste(c, (w // 2, 0)); padn.paste(n, (w // 2, 0))        # spray base (bottom centre) at the pad centre
        rot = ang - 90
        pr = pad.rotate(rot, resample=Image.BICUBIC); pn = rot_n(padn.rotate(rot, resample=Image.BICUBIC), rot)
        layer = Image.new('RGBA', col.size, (0, 0, 0, 0)); layer.paste(pr, (int(x - w), int(y - w)))
        col.alpha_composite(layer); nrm.paste(pn, (int(x - w), int(y - w)), pr.getchannel('A'))
    def branch(x, y, ang, length, width, depth):
        n = max(3, int(length / (size * 0.085)))
        side = random.choice([-1, 1]); pts = [(x, y)]; nodes = []
        for i in range(n):
            ang += side * random.uniform(2, 7) + random.gauss(0, 3)
            st = length / n
            x += math.cos(math.radians(ang)) * st; y -= math.sin(math.radians(ang)) * st
            pts.append((x, y)); nodes.append((x, y, ang, side, (i + 1) / n)); side = -side
        for i in range(len(pts) - 1):
            w = max(1, int(width * (1 - 0.75 * i / len(pts))))
            d.line([pts[i], pts[i + 1]], fill=TWIG + (255,), width=w)
        for (nx, ny, na, sd, f) in nodes:
            if depth < 1 and f < 0.72 and random.random() < 0.8:
                branch(nx, ny, na + sd * random.uniform(35, 55), length * random.uniform(0.35, 0.5) * (1.1 - 0.5 * f), width * 0.55, depth + 1)
            if f > 0.25 or depth > 0:
                place(nx, ny, na + sd * random.uniform(30, 60), random.uniform(0.26, 0.34))
        place(pts[-1][0], pts[-1][1], ang, 0.34)
    branch(size * 0.5, size * 0.99, 90, size * 0.62, 9, 0)
    return col, nrm

ba = Image.new('RGBA', (2048, 1024)); bn = Image.new('RGB', (2048, 1024), (128, 128, 255))
for i in range(2):
    c, n = make_bough(100 + i)
    ba.paste(bleed(c, 30), (i * 1024, 0)); bn.paste(n, (i * 1024, 0))
ba.save(f'{OUT}/bough_atlas.webp', quality=88, method=6, alpha_quality=90)
bn.resize((1024, 512), Image.LANCZOS).save(f'{OUT}/bough_atlas_n.jpg', quality=88)

# preview sheet on a neutral background
def on_bg(im, bg=(120, 150, 190)):
    b = Image.new('RGBA', im.size, bg + (255,)); b.alpha_composite(im); return b.convert('RGB')
sheet = Image.new('RGB', (2048, 1536))
sheet.paste(on_bg(atlas), (0, 0)); sheet.paste(atlas_n, (1024, 0))
sheet.paste(on_bg(sa).resize((1024, 1024)), (0, 512)); sheet.paste(on_bg(ba).resize((1024, 512)), (1024, 512)); sheet.paste(sn.resize((1024, 1024)).crop((0, 0, 1024, 512)), (1024, 1024))
sheet.save(sys.argv[2] if len(sys.argv) > 2 else '/tmp/leaf_sheet.jpg', quality=88)
