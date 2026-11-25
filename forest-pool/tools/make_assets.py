# Prepares Poly Haven downloads (CC0) and generated textures into assets/.
import os, sys, shutil, json
import numpy as np
from PIL import Image
SRC = '/tmp/claude-0/ph/dl'; OUT = 'assets'
Image.MAX_IMAGE_PIXELS = None
def jpg(src, dst, size, q=84):
    im = Image.open(src).convert('RGB')
    if im.size[0] != size: im = im.resize((size, size), Image.LANCZOS)
    im.save(dst, quality=q, optimize=True)
def texset(name, dsize, nsize, diffname=None):
    res = '2k' if os.path.exists(f'{SRC}/tex/{name}_nor_gl_2k.jpg') else '1k'
    d = diffname or f'{name}_diff_{res}.jpg'
    jpg(f'{SRC}/tex/{d}', f'{OUT}/{name}_diff.jpg', dsize)
    if nsize: jpg(f'{SRC}/tex/{name}_nor_gl_{res}.jpg', f'{OUT}/{name}_nor_gl.jpg', nsize, 86)
texset('forrest_ground_01', 2048, 1024)
texset('leaves_forest_ground', 2048, 1024)
texset('ganges_river_pebbles', 2048, 1024)
texset('brown_mud_leaves_01', 1024, 1024)
texset('japanese_hackberry_bark', 2048, 2048)
texset('tree_bark_03', 1024, 1024)
texset('mossy_rock', 1024, 1024)
texset('forest_leaves_02', 2048, 1024, 'forest_leaves_02_diffuse_2k.jpg')

def model(id, res, alpha=None, dsize=1024, nsize=1024, rough=False):
    s = f'{SRC}/models/{id}'; d = f'{OUT}/models/{id}'
    os.makedirs(d, exist_ok=True)
    g = json.load(open(f'{s}/{id}.gltf'))
    # geometry only: our own materials are built in code
    for k in ('images', 'textures', 'samplers'): g.pop(k, None)
    g['materials'] = [{'name': m['name']} for m in g['materials']]
    json.dump(g, open(f'{d}/{id}.gltf', 'w'))
    shutil.copy(f'{s}/{id}.bin', f'{d}/{id}.bin')
    diff = Image.open(f'{s}/textures/{id}_diff_{res}.jpg').convert('RGB')
    if diff.size[0] != dsize: diff = diff.resize((dsize, dsize), Image.LANCZOS)
    if alpha:
        a = Image.open(f'{SRC}/alpha/{alpha}')
        a = Image.fromarray((np.array(a).astype(np.float32) / 257).clip(0, 255).astype(np.uint8)).resize((dsize, dsize), Image.LANCZOS)
        # bleed colour under the cut-out so mips stay clean
        from scipy import ndimage
        rgb = np.array(diff).astype(np.float32); al = np.array(a) > 100
        acc = rgb * al[..., None]; w = al.astype(np.float32)
        for _ in range(16):
            b = ndimage.uniform_filter(acc, (5, 5, 1)); bw = ndimage.uniform_filter(w, 5)
            fill = (w < 0.5) & (bw > 1e-3)
            acc = np.where(fill[..., None], b / np.maximum(bw, 1e-6)[..., None], acc); w = np.where(fill, 1.0, w)
        acc = np.where((w < 0.5)[..., None], rgb[al].mean(0), acc)
        out = Image.fromarray(np.dstack([acc, np.array(a)]).astype(np.uint8), 'RGBA')
        out.save(f'{d}/diff.webp', quality=90, method=6, alpha_quality=95)
    else:
        diff.save(f'{d}/diff.jpg', quality=85, optimize=True)
    if nsize: jpg(f'{s}/textures/{id}_nor_gl_{res}.jpg', f'{d}/nor.jpg', nsize, 86)
    if rough: jpg(f'{s}/textures/{id}_rough_{res}.jpg', f'{d}/rough.jpg', 1024, 80)
model('rock_moss_set_01', '2k', dsize=2048, nsize=2048, rough=True)
model('rock_moss_set_02', '2k', dsize=2048, nsize=2048, rough=True)
model('dead_tree_trunk', '1k')
model('tree_stump_01', '1k')
model('dry_branches_medium_01', '1k')
model('fern_02', '2k', alpha='fern_02_alpha_2k.png', dsize=2048)
model('grass_medium_01', '1k', alpha='grass_medium_01_alpha_1k.png')
model('celandine_01', '1k', alpha='celandine_01_alpha_1k.png')

# Tileable water ripple normal map (two bands of FFT-filtered noise) and a foam mask.
def band(n, k0, k1, seed):
    r = np.random.RandomState(seed)
    f = np.fft.fft2(r.randn(n, n))
    ky, kx = np.meshgrid(np.fft.fftfreq(n) * n, np.fft.fftfreq(n) * n, indexing='ij')
    k = np.hypot(kx, ky)
    h = np.real(np.fft.ifft2(f * np.exp(-((k - k0) / k1) ** 2)))
    return h / h.std()
n = 512
h = band(n, 9, 5, 1) + 0.55 * band(n, 22, 9, 2) + 0.25 * band(n, 48, 16, 3)
gy, gx = np.gradient(h); s = 6.0
nx, ny = -gx * s, gy * s; nz = np.ones_like(nx); l = np.sqrt(nx * nx + ny * ny + nz * nz)
Image.fromarray((np.dstack([nx / l, ny / l, nz / l]) * 127.5 + 127.5).astype(np.uint8)).save(f'{OUT}/water_n.jpg', quality=90)
# foam: lacy cells (ridged noise) in R, fine bubbles in G, soft streak noise in B
c = np.abs(band(n, 14, 6, 5)); c = 1 - np.clip(c / 1.2, 0, 1); c = c ** 3
bub = np.clip(band(n, 70, 25, 6) * 0.5 + 0.5, 0, 1)
st = np.clip(band(n, 5, 3, 7) * 0.3 + 0.5, 0, 1)
Image.fromarray((np.dstack([c, bub, st]) * 255).astype(np.uint8)).save(f'{OUT}/foam.jpg', quality=88)
print('done')
