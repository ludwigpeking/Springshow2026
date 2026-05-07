"""
Build a 3D atlas GLB from per-tile OBJ assets.

Mirrors the logic of 2511_Hexagonal_World/assets/createAtlas.py, but in 3D:
takes the folder of base OBJ assets produced by chop_to_stl.rb and synthesises
the full 5^4 = 625 four-corner combinations by rotating and mirroring around
the vertical (Y) axis. The 2D operations translate to 3D as:

    rotate_image(-90°, image y-down)  ->  rotate -π/2 around Y (CW from above)
    mirror_image(FLIP_LEFT_RIGHT)     ->  scale X by -1  (flip across YZ plane)

Each generated pattern becomes one named glTF node (signature = node name)
with one child mesh per material in the source asset. Materials with the
same name across all 625 patterns collapse to one entry in the GLB, so the
"brick_red" material in tile A is the same Python object — and the same
glTF material — as the "brick_red" in tile Z.

Run from anywhere:
    pip install trimesh numpy
    python assets/build_3d_atlas.py

Inputs:  assets/stl_export/<sig>.obj   (output of chop_to_stl.rb)
         assets/stl_export/materials.mtl  (shared, also output of chop_to_stl.rb)
Output:  assets/atlas_3d.glb
"""

import math
import os
import sys

import numpy as np
import trimesh


# === CONFIG ===
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
SOURCE_DIR   = os.path.join(SCRIPT_DIR, "stl_export")
OUTPUT_GLB   = os.path.join(SCRIPT_DIR, "atlas_3d.glb")
TILE_SPACING = 60.0   # metres between adjacent atlas cells


# === SYMBOL MAPPING (matches createAtlas.py) ===
CHAR_TO_DIGIT = {'w': 0, 'r': 1, '1': 2, '2': 3, 'c': 4}
DIGIT_TO_CHAR = {0: 'w', 1: 'r', 2: '1', 3: '2', 4: 'c'}


# === PATTERN-STRING TRANSFORMS (matches createAtlas.py) ===
def rotate_pattern(p):
    # CW 90°: corner indices [TL,TR,BR,BL] = [0,1,2,3] -> [3,0,1,2]
    return p[3] + p[0] + p[1] + p[2]


def mirror_pattern(p):
    # Horizontal mirror: [0,1,2,3] -> [1,0,3,2]   (TL<->TR, BR<->BL)
    return p[1] + p[0] + p[3] + p[2]


# === 3D TRANSFORM MATRICES (Y-up world; viewed from +Y looking -Y) ===
def rot_y(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([
        [ c, 0,  s, 0],
        [ 0, 1,  0, 0],
        [-s, 0,  c, 0],
        [ 0, 0,  0, 1],
    ], dtype=float)


# CW 90° around Y when viewed from above is θ = -π/2 in right-handed coords.
ROT_CW_90 = rot_y(-math.pi / 2)

# Horizontal mirror = flip X. Determinant is -1, so trimesh.apply_transform
# automatically inverts face winding to keep normals pointing outward.
MIRROR_X = np.array([
    [-1, 0, 0, 0],
    [ 0, 1, 0, 0],
    [ 0, 0, 1, 0],
    [ 0, 0, 0, 1],
], dtype=float)


# === FILENAME GRID (same structure as createAtlas.py) ===
file_names_part1 = [
    ["wwww", "rrrr", "1111", "2222", "cccc"],
]

file_names_part2 = [
    ["wrwr", "w1w1", "w2w2", "wcwc"],
    ["r1r1", "r2r2", "rcrc", "1212", "1c1c", "2c2c"],
]

file_names_part3 = [
    ["wwrr", "ww11", "ww22", "wwcc", "rr11", "rr22", "rrcc"],
    ["1122", "11cc", "22cc"],
    ["wwrw", "ww1w", "ww2w", "wwcw", "rrwr", "rr1r", "rr2r", "rrcr"],
    ["11w1", "11r1", "1121", "11c1", "22w2", "22r2", "2212", "22c2"],
    ["ccwc", "ccrc", "cc1c", "cc2c"],
    ["w1wr", "w2wr", "wcwr", "w2w1", "wcw1", "wcw2"],
    ["r1rw", "r2rw", "rcrw", "r2r1", "rcr1", "rcr2"],
    ["1r1w", "121w", "1c1w", "121r", "1c1r", "1c12"],
    ["2r2w", "212w", "2c2w", "212r", "2c2r", "2c21"],
    ["crcw", "c1cw", "c2cw", "c1cr", "c2cr", "c2c1"],
]

file_names_part4 = [
    ["wr21", "wrc1", "wr2c", "wc21", "cr21"],
    ["w2r1", "wcr1", "w2rc", "w2c1", "c2r1"],
    ["wr12", "wr1c", "wrc2", "wc12", "cr12"],
    ["ww1r", "ww2r", "wwcr", "ww21", "wwc1", "wwc2"],
    ["rr1w", "rr2w", "rrcw", "rr21", "rrc1", "rrc2"],
    ["11rw", "112w", "11cw", "112r", "11cr", "11c2"],
    ["22rw", "221w", "22cw", "221r", "22cr", "22c1"],
    ["ccrw", "cc1w", "cc2w", "cc1r", "cc2r", "cc21"],
]


# === LOAD + SYNTHESIZE ALL 625 PATTERNS ===
# A pattern is now a *list* of trimesh.Trimesh: one per material in the source
# OBJ. trimesh splits multi-material OBJs into per-material meshes, each with
# its visual.material set, so iterating preserves the per-material grouping.
def load_obj(name):
    path = os.path.join(SOURCE_DIR, f"{name}.obj")
    if not os.path.exists(path):
        return None
    loaded = trimesh.load(path)
    if isinstance(loaded, trimesh.Scene):
        return [g for g in loaded.geometry.values()]
    return [loaded]


def transform_meshes(meshes, T):
    """Return new meshes with T applied. apply_transform with det<0 (mirror)
    auto-inverts winding inside trimesh, so normals stay outward."""
    out = []
    for m in meshes:
        nm = m.copy()
        nm.apply_transform(T)
        out.append(nm)
    return out


def expand_part(rows, rotations, mirror, meshes, missing_sources):
    """Apply the rotations (and optionally each mirror) to every base pattern in
    `rows`, accumulating into `meshes` keyed by signature. Each value is the
    list of per-material meshes for that signature."""
    for row in rows:
        for name in row:
            base = load_obj(name)
            if base is None:
                missing_sources.append(name)
                continue

            current = [m.copy() for m in base]
            current_pat = name

            for r in range(rotations):
                if current_pat not in meshes:
                    meshes[current_pat] = [m.copy() for m in current]

                if mirror:
                    mirrored = transform_meshes(current, MIRROR_X)
                    mirrored_pat = mirror_pattern(current_pat)
                    if mirrored_pat not in meshes:
                        meshes[mirrored_pat] = mirrored

                if r < rotations - 1:
                    current = transform_meshes(current, ROT_CW_90)
                    current_pat = rotate_pattern(current_pat)


def build_meshes():
    meshes = {}
    missing = []
    expand_part(file_names_part1, rotations=1, mirror=False, meshes=meshes, missing_sources=missing)
    expand_part(file_names_part2, rotations=2, mirror=False, meshes=meshes, missing_sources=missing)
    expand_part(file_names_part3, rotations=4, mirror=False, meshes=meshes, missing_sources=missing)
    expand_part(file_names_part4, rotations=4, mirror=True,  meshes=meshes, missing_sources=missing)
    return meshes, missing


# Make sure same-named materials across all loaded OBJs become the *same*
# Python Material object. trimesh's GLTF exporter writes one glTF material
# per unique Python object, so this collapses 625 copies of "brick_red" into
# a single material entry in the output GLB.
def dedupe_materials(meshes):
    cache = {}
    for mlist in meshes.values():
        for m in mlist:
            visual = getattr(m, "visual", None)
            if visual is None:
                continue
            mat = getattr(visual, "material", None)
            if mat is None:
                continue
            key = getattr(mat, "name", None) or id(mat)
            if key in cache:
                m.visual.material = cache[key]
            else:
                cache[key] = mat
    return len(cache)


# === PLACE ON GRID + EXPORT ===
# Each signature becomes a parent group node named with the 4-char signature.
# Per-material meshes for that signature are children of the group. From
# Three.js, `gltf.scene.getObjectByName('wrwr')` returns the parent Object3D
# and iterating its children yields one Mesh per material.
def place_and_export(meshes):
    scene = trimesh.Scene()
    base_frame = scene.graph.base_frame
    placed = 0
    missing_patterns = []

    for d0 in range(5):
        for d1 in range(5):
            for d2 in range(5):
                for d3 in range(5):
                    sig = (DIGIT_TO_CHAR[d0] + DIGIT_TO_CHAR[d1]
                           + DIGIT_TO_CHAR[d2] + DIGIT_TO_CHAR[d3])
                    col = d0 * 5 + d1
                    row = d2 * 5 + d3

                    if sig not in meshes:
                        missing_patterns.append(sig)
                        continue

                    T = np.eye(4)
                    T[0, 3] = col * TILE_SPACING
                    T[2, 3] = row * TILE_SPACING

                    # Create empty parent node at grid position; mesh children
                    # attach to it with identity transform.
                    scene.graph.update(frame_to=sig, frame_from=base_frame, matrix=T)
                    for idx, m in enumerate(meshes[sig]):
                        child_name = f"{sig}__{idx}" if len(meshes[sig]) > 1 else f"{sig}_mesh"
                        scene.add_geometry(
                            m,
                            node_name=child_name,
                            geom_name=child_name,
                            parent_node_name=sig,
                        )
                    placed += 1

    if placed == 0:
        print("No meshes placed; aborting.", file=sys.stderr)
        sys.exit(1)

    scene.export(OUTPUT_GLB)
    return placed, missing_patterns


# === MAIN ===
if __name__ == "__main__":
    if not os.path.isdir(SOURCE_DIR):
        print(f"ERROR: source folder not found: {SOURCE_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading OBJs from {SOURCE_DIR} ...")
    meshes, missing_sources = build_meshes()
    print(f"  {len(meshes)} unique 3D patterns generated")
    if missing_sources:
        print(f"  {len(missing_sources)} source OBJs missing — derived patterns will be skipped:")
        for n in missing_sources:
            print(f"    {n}.obj")

    n_materials = dedupe_materials(meshes)
    print(f"  {n_materials} unique materials after deduplication by name")

    print(f"\nPlacing on 25x25 grid (spacing={TILE_SPACING}m) ...")
    placed, missing_patterns = place_and_export(meshes)
    print(f"  {placed} / 625 patterns placed")
    if missing_patterns:
        print(f"  {len(missing_patterns)} patterns missing in atlas:")
        for sig in missing_patterns[:10]:
            print(f"    {sig}")
        if len(missing_patterns) > 10:
            print(f"    ... and {len(missing_patterns) - 10} more")

    print(f"\nExported {OUTPUT_GLB}")
