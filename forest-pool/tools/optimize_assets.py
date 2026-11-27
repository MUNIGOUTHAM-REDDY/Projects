# Build-time asset optimiser: assets/ (sources) -> .opt/ (what ships).
#   - every texture re-encoded as WebP, sized for where it is seen; a half-size set under m/ for phones
#   - twig-spray and bough atlases of both species packed into one atlas each (one draw batch per chunk)
#   - scanned models decimated by vertex clustering (their normal maps carry the detail) and unused pieces dropped;
#     written as compact glTF JSON with the buffer inlined (the host serves only web file types)
# usage: python3 tools/optimize_assets.py assets .opt
import sys, os, json, base64, struct, glob
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
SRC, OUT = sys.argv[1], sys.argv[2]

# texture -> (max edge on desktop, webp quality). First match wins.
RULES = [
    ('forrest_ground_01_diff', 2048, 78), ('ganges_river_pebbles_diff', 2048, 78), ('japanese_hackberry_bark_diff', 2048, 78),
    ('japanese_hackberry_bark_nor', 1024, 82), ('forrest_ground_01_nor', 1024, 82), ('ganges_river_pebbles_nor', 1024, 82),
    ('rock_moss_set_01/diff', 2048, 78), ('rock_moss_set_02/diff', 2048, 78), ('rock_moss_set_01/nor', 1024, 82), ('rock_moss_set_02/nor', 1024, 82),
    ('rough', 512, 75), ('fern_02/diff', 1024, 82), ('dry_branches_medium_01/diff', 512, 78), ('grass_medium_01/diff', 512, 85), ('celandine_01/diff', 512, 85),
    ('dry_branches_medium_01/nor', 256, 80), ('grass_medium_01/nor', 256, 80), ('celandine_01/nor', 256, 80),
    ('leaf_atlas', 1024, 90), ('water_n', 512, 85), ('foam', 512, 80), ('forrest_sand_01_diff', 512, 78), ('mossy_rock_diff', 512, 78),
    ('_nor', 512, 82), ('/nor', 512, 82), ('', 1024, 78),
]
UNUSED = ('aerial_grass_rock', 'river_small_rocks', 'forrest_sand_01_nor', 'brown_mud_leaves_01_nor', 'mossy_rock_nor', 'forest_leaves_02_nor',
          'spray_atlas', 'spray2_atlas', 'bough_atlas', 'bough2_atlas')

def rule(rel):
    for k, s, q in RULES:
        if k in rel: return s, q

def save(im, rel, size, q):
    for sub, scale in (('', 1.0), ('m/', 0.5)):
        dst = os.path.join(OUT, sub + os.path.splitext(rel)[0] + '.webp')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        s = size
        if sub:      # phones: half size, diffuse maps at most 512, normal/roughness maps and small props at most 256
            s = max(256, int(size * scale))
            if 'atlas' not in rel and '_all' not in rel: s = min(s, 256 if any(k in rel for k in ('nor', 'rough', 'water_n', 'foam', 'dead_tree', 'tree_stump', 'mossy_rock', 'dry_branches', 'grass_', 'celandine', 'sand', 'mud')) else 512)
        w, h = im.size
        k = min(1.0, s / max(w, h))
        o = im if k >= 1 else im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
        if o.mode == 'RGBA': o.save(dst, quality=q, method=6, alpha_quality=92, exact=True)
        else: o.convert('RGB').save(dst, quality=q, method=6)

for path in sorted(glob.glob(SRC + '/**/*.*', recursive=True)):
    rel = os.path.relpath(path, SRC)
    if not rel.lower().endswith(('.jpg', '.png', '.webp')): continue
    if any(os.path.basename(rel).startswith(u) for u in UNUSED): continue
    size, q = rule(rel)
    save(Image.open(path), rel, size, q)

# --- combined foliage atlases: species 1 on the left half, species 2 on the right -----------------
def combine(a, b, out, size, q):
    A, B = Image.open(f'{SRC}/{a}'), Image.open(f'{SRC}/{b}')
    B = B.resize(A.size, Image.LANCZOS) if B.size != A.size else B
    c = Image.new(A.mode, (A.size[0] * 2, A.size[1])); c.paste(A, (0, 0)); c.paste(B, (A.size[0], 0))
    save(c, out, size, q)
combine('spray_atlas.webp', 'spray2_atlas.webp', 'sprays_all.webp', 2048, 86)
combine('spray_atlas_n.jpg', 'spray2_atlas_n.jpg', 'sprays_all_n.webp', 1024, 82)
combine('bough_atlas.webp', 'bough2_atlas.webp', 'boughs_all.webp', 2048, 84)
combine('bough_atlas_n.jpg', 'bough2_atlas_n.jpg', 'boughs_all_n.webp', 1024, 80)

# --- models -----------------------------------------------------------------------------------------
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
def read(g, bin_, ai):
    a = g['accessors'][ai]; bv = g['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride', 0)
    if stride and stride != dt.itemsize * n:
        raw = np.frombuffer(bin_, np.uint8, count=stride * a['count'], offset=off).reshape(a['count'], stride)[:, :dt.itemsize * n]
        return np.ascontiguousarray(raw).view(dt).reshape(a['count'], n)
    return np.frombuffer(bin_, dt, count=a['count'] * n, offset=off).reshape(a['count'], n)

def cluster(P, N, U, I, cell):
    lo = P.min(0)
    c = np.floor((P - lo) / cell).astype(np.int64)
    cid = c[:, 0] + c[:, 1] * 4096 + c[:, 2] * 4096 * 4096
    ucell, cinv = np.unique(cid, return_inverse=True)
    cnt = np.bincount(cinv).astype(np.float64)[:, None]
    cpos = np.stack([np.bincount(cinv, P[:, k]) for k in range(3)], 1) / cnt
    # vertices of one cell that sit on different UV islands stay separate (same position, own UV)
    ub = np.floor(U * 6).astype(np.int64)
    gid = cinv.astype(np.int64) * 4096 + (ub[:, 0] % 64) * 64 + (ub[:, 1] % 64)
    ug, ginv = np.unique(gid, return_inverse=True)
    gc = np.bincount(ginv).astype(np.float64)[:, None]
    gU = np.stack([np.bincount(ginv, U[:, k]) for k in range(2)], 1) / gc
    gN = np.stack([np.bincount(ginv, N[:, k]) for k in range(3)], 1)
    gN /= np.maximum(np.linalg.norm(gN, axis=1, keepdims=True), 1e-9)
    gcell = (ug // 4096).astype(np.int64)
    gP = cpos[gcell]
    T = ginv[I.reshape(-1, 3)]
    tc = gcell[T]
    ok = (tc[:, 0] != tc[:, 1]) & (tc[:, 1] != tc[:, 2]) & (tc[:, 0] != tc[:, 2])
    T = T[ok]
    key = np.sort(gcell[T], 1)
    _, first = np.unique(key, axis=0, return_index=True)
    T = T[np.sort(first)]
    used, remap = np.unique(T, return_inverse=True)
    return gP[used].astype(np.float32), gN[used].astype(np.float32), gU[used].astype(np.float32), remap.reshape(-1, 3).astype(np.uint32)

def decimate(P, N, U, I, target):
    if len(I) // 3 <= target: return P, N, U, I.reshape(-1, 3).astype(np.uint32)
    lo, hi = 1e-4, float((P.max(0) - P.min(0)).max())
    best = None
    for _ in range(22):
        mid = (lo * hi) ** 0.5
        r = cluster(P, N, U, I, mid)
        if len(r[3]) > target: lo = mid
        else: hi = mid; best = r
    return best

# model -> (triangles per mesh, name filter or None)
MODELS = {
    'rock_moss_set_01': (1500, None), 'rock_moss_set_02': (1500, None), 'dead_tree_trunk': (5000, None), 'tree_stump_01': (2500, None),
    'dry_branches_medium_01': (280, None), 'fern_02': (10 ** 9, None), 'celandine_01': (10 ** 9, ('_a_', '_e_')),
    'grass_medium_01': (10 ** 9, ('tall_a', 'tiny_d')),
}
LIGHT = {'rock_moss_set_01': 420, 'rock_moss_set_02': 420, 'dead_tree_trunk': 1400, 'tree_stump_01': 700, 'dry_branches_medium_01': 110}
for sub_, mid, target, keep in [(s_, m_, (LIGHT.get(m_, t_) if s_ else t_), k_) for s_ in ('', 'm/') for m_, (t_, k_) in MODELS.items()]:
    d = f'{SRC}/models/{mid}'
    g = json.load(open(f'{d}/{mid}.gltf')); bin_ = open(f'{d}/{mid}.bin', 'rb').read()
    out = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'accessors': [], 'bufferViews': [], 'buffers': []}
    blob = bytearray(); tris = 0
    def push(arr, target_, typ, ct, minmax=False):
        global blob
        while len(blob) % 4: blob.append(0)
        b = arr.tobytes()
        out['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(b), 'target': target_})
        acc = {'bufferView': len(out['bufferViews']) - 1, 'componentType': ct, 'count': len(arr) if arr.ndim > 1 else arr.size, 'type': typ}
        if minmax: acc['min'] = [float(v) for v in arr.min(0)]; acc['max'] = [float(v) for v in arr.max(0)]
        blob += b; out['accessors'].append(acc); return len(out['accessors']) - 1
    for n in g['nodes']:
        if 'mesh' not in n: continue
        if keep and not any(k in n['name'] for k in keep): continue
        pr = g['meshes'][n['mesh']]['primitives'][0]
        P = read(g, bin_, pr['attributes']['POSITION']).astype(np.float64); N = read(g, bin_, pr['attributes']['NORMAL']).astype(np.float64)
        U = read(g, bin_, pr['attributes']['TEXCOORD_0']).astype(np.float64); I = read(g, bin_, pr['indices']).reshape(-1).astype(np.int64)
        P2, N2, U2, T = decimate(P, N, U, I, target)
        P2, N2, U2 = P2.astype(np.float32), N2.astype(np.float32), U2.astype(np.float32)
        idx = T.reshape(-1); it = np.uint16 if len(P2) < 65536 else np.uint32
        prim = {'attributes': {'POSITION': push(P2, 34962, 'VEC3', 5126, True), 'NORMAL': push(N2, 34962, 'VEC3', 5126), 'TEXCOORD_0': push(U2, 34962, 'VEC2', 5126)},
                'indices': push(idx.astype(it), 34963, 'SCALAR', 5123 if it == np.uint16 else 5125)}
        out['meshes'].append({'primitives': [prim]})
        node = {k: n[k] for k in ('name', 'translation', 'rotation', 'scale') if k in n}; node['mesh'] = len(out['meshes']) - 1
        out['nodes'].append(node); out['scenes'][0]['nodes'].append(len(out['nodes']) - 1); tris += len(idx) // 3
    out['buffers'] = [{'byteLength': len(blob), 'uri': 'data:application/octet-stream;base64,' + base64.b64encode(bytes(blob)).decode()}]
    os.makedirs(f'{OUT}/{sub_}models/{mid}', exist_ok=True)
    json.dump(out, open(f'{OUT}/{sub_}models/{mid}/{mid}.json', 'w'), separators=(',', ':'))
    print(f'{sub_}{mid}: {len(out["meshes"])} meshes, {tris} tris, {len(blob) / 1024:.0f} KB')
