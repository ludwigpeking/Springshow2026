import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }       from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass }         from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment }  from 'three/addons/environments/RoomEnvironment.js';

const countsEl = document.getElementById('counts');
function setStatus(html) { countsEl.innerHTML = html; }
setStatus('building scene...');

// ======================================================================
// Three.js scene scaffolding
// ======================================================================
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x182028);
// Fog removed for the near-orthographic camera — at FOV=4 / distance
// ~15400 it just tints the whole frame uniformly without adding any
// distance cue. Re-enable as `new Fog(...)` if you want haze later.
scene.fog        = null;

// FOV=12, distance ≈ 1800. View radius = 1800·tan(6°) ≈ 189 — the
// camera frames the centre of the hex tightly rather than the whole
// map. Pull back / orbit out via mouse wheel to see further.
const camera   = new THREE.PerspectiveCamera(12, innerWidth / innerHeight, 50, 4500);
camera.position.set(890, 1050, 1160);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
// Cap pixel ratio at 1.5 — on retina/4K screens devicePixelRatio is 2–3,
// which quadruples the pixel work for every pass (shadow, reflection,
// SSAO, main render). 1.5 still looks crisp; perf wins are large.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = false;            // toggled by advanced-lighting button
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;           // needed for the water-reflection clip plane
document.body.appendChild(renderer.domElement);

// PMREM-baked indoor-ish environment, used as `scene.environment` when
// advanced lighting is on. Provides soft, omnidirectional ambient light
// that responds correctly to MeshStandardMaterial's metalness/roughness.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const _envScene = new RoomEnvironment(renderer);
const ENV_MAP   = pmrem.fromScene(_envScene, 0.04).texture;
_envScene.dispose?.();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 50, 0);
// Auto-orbit around the hex centre. OrbitControls' formula:
//   anglePerFrame = (2π / 3600) · autoRotateSpeed  radians
// → speed = -1 → 0.1° / frame, clockwise viewed from above. Auto-rotate
// pauses while the user manually drags and resumes on release.
controls.autoRotate      = true;
controls.autoRotateSpeed = -1;

// EffectComposer used only when advanced lighting is on — keeps the simple
// path one render call. SSAOPass emulates the dark cracks ray-traced AO would
// produce in concave geometry (between buildings, under eaves, etc.).
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ssaoPass = new SSAOPass(scene, camera, innerWidth, innerHeight);
ssaoPass.kernelRadius = 16;        // larger = wider AO halo
ssaoPass.minDistance  = 0.005;
ssaoPass.maxDistance  = 0.1;
composer.addPass(ssaoPass);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    ssaoPass.setSize(innerWidth, innerHeight);
});

// Distinguish a click from an OrbitControls drag: only treat pointerup
// as a click when the cursor moved < 5 px and the press was < 350 ms.
let _downX = 0, _downY = 0, _downT = 0;
renderer.domElement.addEventListener('pointerdown', e => {
    _downX = e.clientX; _downY = e.clientY; _downT = performance.now();
});
renderer.domElement.addEventListener('pointerup', e => {
    if (performance.now() - _downT > 350) return;
    if (Math.abs(e.clientX - _downX) > 5) return;
    if (Math.abs(e.clientY - _downY) > 5) return;
    if (mouseMode === 'inspect') {
        const v = pickVertex(e.clientX, e.clientY);
        const t = pickTile(e.clientX, e.clientY);
        showInspectInfo(v, t);
        showInspectInfluence(v);
        return;
    }
    const v = pickVertex(e.clientX, e.clientY);
    if (v) applyMouseMode(v);
});

// When inspect-mode picks a vertex, paint translucent overlays on every
// tile that is reached by that vertex's CLOSE (vincinityNeighbors) and
// FAR (floodedNeighbors) influence sets — like the 2D reference's vertex
// inspector. Two merged BufferGeometries: one per range. Always-on-top.
const INFLUENCE_COLOR_FAR   = 0xff66cc;   // pink — wider, fainter
const INFLUENCE_COLOR_CLOSE = 0x66ddff;   // cyan — tighter, more opaque
function clearInspectOverlay() {
    while (inspectGroup.children.length) {
        const c = inspectGroup.children.pop();
        c.geometry?.dispose();
        c.material?.dispose();
        inspectGroup.remove(c);
    }
}
function showInspectInfluence(vertex) {
    clearInspectOverlay();
    if (!vertex) return;

    const closeSet = new Set([vertex.index]);
    if (Array.isArray(vertex.vincinityNeighbors)) {
        for (const v of vertex.vincinityNeighbors) closeSet.add(v.index);
    }
    const farSet = new Set([vertex.index]);
    if (Array.isArray(vertex.floodedNeighbors)) {
        for (const v of vertex.floodedNeighbors) farSet.add(v.index);
    }

    const closeTiles = [];
    const farOnlyTiles = [];
    for (const t of tiles) {
        let inClose = false, inFar = false;
        for (const idx of t.vertexIndices) {
            if (!inClose && closeSet.has(idx)) inClose = true;
            if (!inFar   && farSet.has(idx))   inFar   = true;
            if (inClose && inFar) break;
        }
        if (inClose) closeTiles.push(t);
        else if (inFar) farOnlyTiles.push(t);
    }

    const buildOverlay = (tileList, hexColor, opacity, lift, renderOrder) => {
        if (!tileList.length) return;
        const positions = [];
        const indices   = [];
        let v = 0;
        for (const t of tileList) {
            const v0 = vertexByIndex.get(t.vertexIndices[0]);
            const v1 = vertexByIndex.get(t.vertexIndices[1]);
            const v2 = vertexByIndex.get(t.vertexIndices[2]);
            const v3 = vertexByIndex.get(t.vertexIndices[3]);
            if (!v0 || !v1 || !v2 || !v3) continue;
            positions.push(
                worldXOf(v0), worldYOf(v0) + lift, worldZOf(v0),
                worldXOf(v1), worldYOf(v1) + lift, worldZOf(v1),
                worldXOf(v2), worldYOf(v2) + lift, worldZOf(v2),
                worldXOf(v3), worldYOf(v3) + lift, worldZOf(v3),
            );
            indices.push(v, v + 1, v + 2,  v, v + 2, v + 3);
            v += 4;
        }
        if (!v) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setIndex(indices);
        const mat = new THREE.MeshBasicMaterial({
            color:        hexColor,
            transparent:  true,
            opacity:      opacity,
            side:         THREE.DoubleSide,
            depthWrite:   false,
            depthTest:    false,
        });
        const mesh = new THREE.Mesh(g, mat);
        mesh.renderOrder = renderOrder;
        inspectGroup.add(mesh);
    };

    // Far first (lower renderOrder, drawn first), close on top.
    buildOverlay(farOnlyTiles, INFLUENCE_COLOR_FAR,   0.20, 1.5, 1100);
    buildOverlay(closeTiles,   INFLUENCE_COLOR_CLOSE, 0.45, 1.7, 1101);
}

function showInspectInfo(v, t) {
    const el = document.getElementById('inspectInfo');
    if (!el) return;
    if (!v && !t) { el.style.display = 'none'; return; }
    const lines = [];
    if (v) {
        const sym = getVertexSymbol(v);
        const occ = v.occupiedBy
            ? v.occupiedBy.profession
            : v.castleAnnex
                ? 'castle annex'
                : v.occupiedByRoute ? 'route' : '–';
        lines.push(
            `<b>vertex</b> #${v.index} → <b>"${sym}"</b>` +
            `<br>&nbsp;&nbsp;elev=${v.elevation.toFixed(1)} m` +
            `&nbsp;&nbsp;defense=${v.defense.toFixed(2)}` +
            `&nbsp;&nbsp;security=${(v._security ?? 0).toFixed(2)}` +
            `<br>&nbsp;&nbsp;occupied: ${occ}` +
            `&nbsp;&nbsp;water=${v.water}&nbsp;&nbsp;habitable=${v.habitable}`
        );
    }
    if (t) {
        const sig = tileSignature(t);
        lines.push(`<b>tile</b> #${t.id} → <b>"${sig}"</b>` +
                   `&nbsp;&nbsp;corners=[${t.vertexIndices.join(', ')}]`);
    }
    el.innerHTML = lines.join('<br>');
    el.style.display = 'block';
}
renderer.domElement.addEventListener('pointermove', e => {
    if (!mouseMode) { if (hoverMarker) hoverMarker.visible = false; return; }
    showHoverAt(pickVertex(e.clientX, e.clientY));
});

const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffeedd, 1.0);
sun.position.set(600, 1000, 400);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);
// Shadow camera frustum sized for the topo extent (~ ±900 in XZ, 0..600 in Y
// after exaggeration). Generous bias keeps acne off the gentle slopes.
sun.castShadow                 = true;
// 4096² shadow map — was 8192², which redraws ~5000 tiles into a
// 67 MiB texture every frame when day/night rotation is on. 4096² is
// 4× cheaper and still produces crisp shadows at this map's scale.
// (When rotation is paused, `shadowMap.autoUpdate = false` keeps this
// from re-rendering every frame, but only the steady-state cost — the
// allocation and any forced rebuild still benefits from the smaller size.)
sun.shadow.mapSize.set(4096, 4096);
// Tighten the shadow camera to the actual map extent — smaller frustum =
// better depth precision per shadow texel.
sun.shadow.camera.near         = 200;
sun.shadow.camera.far          = 2400;
sun.shadow.camera.left         = -700;
sun.shadow.camera.right        =  700;
sun.shadow.camera.top          =  700;
sun.shadow.camera.bottom       = -700;
// Bias must be ≫ depth precision step. With (far-near)/2^24 ≈ 1.3e-4 here,
// 1e-3 is comfortably above that. normalBias is in world units; ~0.5 hex-pixel
// keeps thin walls from self-shadowing without putting shadows on the wrong
// side. A small positive bias works better than negative for our orientation.
sun.shadow.bias                = -0.001;
sun.shadow.normalBias          = 0.5;
// Sky/ground-tinted ambient — the actually colour-tweakable handle for
// the day/night cycle's environmental light. PMREM env stays for IBL.
// (No "fill" DirectionalLight — the hemi covers that job, and a second
// directional light was producing a phantom specular highlight on water.)
const hemi = new THREE.HemisphereLight(0xb0d8ff, 0x222233, 0.0);
scene.add(hemi);

// Shadow-fill light: a non-shadow-casting twin of `sun`. Three.js r160
// has no LightShadow.intensity — this is how we emulate it. The two
// lights share total intensity:
//   sun.intensity        = total · shadowIntensity     (casts shadow)
//   shadowFill.intensity = total · (1 - shadowIntensity)  (no shadow)
// Lit fragments get both → full intensity. Shadowed fragments get only
// shadowFill → fraction (1 - shadowIntensity) of full.
const shadowFill = new THREE.DirectionalLight(0xffeedd, 0);
shadowFill.castShadow = false;
shadowFill.position.copy(sun.position);
shadowFill.target.position.set(0, 0, 0);
scene.add(shadowFill);
scene.add(shadowFill.target);

const settlementsGroup = new THREE.Group(); scene.add(settlementsGroup);
settlementsGroup.visible = false;            // off by default — tile assets show city already
const tilesGroup       = new THREE.Group(); scene.add(tilesGroup);
const routesGroup      = new THREE.Group(); scene.add(routesGroup);
routesGroup.visible    = false;            // off by default — toggle ⛓ in left column to show
const inspectGroup     = new THREE.Group(); scene.add(inspectGroup);   // close/far influence overlays
const cityLightsGroup  = new THREE.Group(); scene.add(cityLightsGroup); // night-time security-driven city lights

// SketchUp-style edge overlay. THREE.EdgesGeometry extracts crease edges
// (pairs of faces whose normals differ by more than EDGE_ANGLE_DEG) from
// each tile mesh and the topo, drawn as black LineSegments on top. Off
// by default — toggle 🔲 in the left column.
//
// Cheap strategy: edges are built per tile inside placeTileAsset and
// cached. syncTiles already short-circuits unchanged tiles via the
// signature map, so unchanged tiles keep their edges across spawns.
// When the overlay is turned off the cache is dropped; when it's turned
// on we lazily fill in edges for whichever tiles are currently placed.
const edgesGroup       = new THREE.Group(); scene.add(edgesGroup);
edgesGroup.visible     = false;
const _edgeMat         = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85 });
const EDGE_ANGLE_DEG   = 25;
let   edgesEnabled     = false;            // mirrors edgesGroup.visible
const tileEdgeObjects  = new Map();        // tile.id → edge host Group
// topoMesh deliberately gets no edges — its tessellation is the underlying
// Voronoi mesh, which would draw bold polygon outlines across all terrain.

// Materials that shouldn't show edges. The GLB strips material *names* so
// we can't filter by name; identify by the (Lambert) color hex instead.
// Hex values come from materials.mtl after sRGB → linear gamma:
//   'w'     ground  → e2e2bc  (cell-seam outlines)
//   'road'  strip   → c2bab6
//   'water' sea     → 88afb1  (Voronoi outlines under the sea)
const _EDGE_SKIP_COLORS = new Set(['e2e2bc', 'c2bab6', '88afb1']);

// Monochrome render mode: swap every tile-mesh material (except water)
// for a single white Lambert. Toggleable via the ⚪ button. The original
// material is stashed on userData so we can restore on toggle-off.
const _WATER_COLOR_HEX = '88afb1';
const monoMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
// monoMat.clippingPlanes is attached below, once _origClipPlane is declared.
let monoEnabled = false;
function _isWaterMat(m)  { return !!(m && m.color && m.color.getHexString() === _WATER_COLOR_HEX); }
function _applyMono(mesh) {
    if (!mesh.isMesh || !mesh.material || _isWaterMat(mesh.material)) return;
    if (!mesh.userData._origMat) mesh.userData._origMat = mesh.material;
    mesh.material = monoMat;
}
function _restoreMono(mesh) {
    if (mesh.userData._origMat) {
        mesh.material = mesh.userData._origMat;
        delete mesh.userData._origMat;
    }
}
function setMonoEnabled(on) {
    monoEnabled = on;
    tilesGroup.traverse(o => { if (o.isMesh) (on ? _applyMono : _restoreMono)(o); });
    // Reflections share geometry with the originals but use cloned
    // (clip-enabled) materials. Refresh so reflection colour tracks mono.
    if (reflEnabled) refreshAllReflectionMats();
}

// ======================================================================
// Water reflection. The above-water portion of every tile mesh is
// mirrored across the water plane and drawn beneath it, visible through
// the translucent water. Implementation notes:
//
//   - One Mesh per tile sub-mesh shares the *same BufferGeometry* as the
//     original; only an extra Mesh wrapper, a clipped material, and a
//     parent matrix per tile are allocated, so this is roughly a fixed
//     +50% on the tile-rendering cost.
//   - The reflectionsGroup carries the mirror transform (scale y = -1,
//     translate y = 2·waterY) — the originals are untouched.
//   - A world-space clipping plane keeps anything that would land
//     above-water clipped out, so submerged geometry never floats up
//     into the sky after the mirror.
//   - Reflections don't cast or receive shadow.
// ======================================================================
const reflectionsGroup       = new THREE.Group();
reflectionsGroup.matrixAutoUpdate = false;
reflectionsGroup.visible     = false;        // default off — toggled by 🪞 button
scene.add(reflectionsGroup);
const tileReflObjects        = new Map();              // tile.id → reflection host Group
// Two world-space clip planes, both anchored on the actual water plane Y.
//   _reflClipPlane: keeps y <  waterY → applied to reflection materials,
//                   trims off the parts of the mirror that would land
//                   above the water plane.
//   _origClipPlane: keeps y >= waterY → applied to *original* atlas
//                   materials, so the originals also stop at the water
//                   plane (and don't occlude the reflection from above
//                   through the translucent water).
const _reflClipPlane         = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const _origClipPlane         = new THREE.Plane(new THREE.Vector3(0,  1, 0), 0);
// Wire the original-side clip into the shared monoMat (defined earlier).
monoMat.clippingPlanes = [_origClipPlane];
const _reflMatCache          = new WeakMap();          // source material → clipped clone
let   reflEnabled            = false;                  // default off — toggled by 🪞 button
function _updateReflectionTransforms() {
    // Single source of truth: the `waterLevel` parameter that the ⚙
    // settings-panel slider (`iW`) writes to. The water mesh, both
    // clip planes, and the mirror transform all derive from this one
    // value, so the slider drives everything in lockstep.
    const waterY = window.waterLevel * elevScale;
    // Mirror across y = waterY: y' = 2·waterY - y.
    reflectionsGroup.matrix.set(
        1,  0, 0, 0,
        0, -1, 0, 2 * waterY,
        0,  0, 1, 0,
        0,  0, 0, 1,
    );
    reflectionsGroup.matrixWorldNeedsUpdate = true;
    // Refl plane:  -y + waterY > 0 → y < waterY (below water — reflection).
    _reflClipPlane.constant =  waterY;
    // Orig plane:   y - waterY > 0 → y > waterY (above water — originals).
    _origClipPlane.constant = -waterY;
}
function _getReflMat(srcMat) {
    if (_reflMatCache.has(srcMat)) return _reflMatCache.get(srcMat);
    // Darker copy of the source colour, with tone mapping BYPASSED.
    // The composer pass (advanced mode) applies ACES tone mapping which
    // boosts dark midtones back up — that's why `tint.multiplyScalar()`
    // alone looked unchanged. `toneMapped: false` tells three.js to emit
    // this fragment as-is, so the darkening actually shows on screen.
    // DIAGNOSTIC: force pure black so we can confirm this material is
    // actually what the reflection meshes are using. If reloaded and the
    // reflection still looks bright/coloured, the issue is upstream of
    // _getReflMat (probably the cache being skipped or the reflection
    // mesh using the original material somewhere).
    const tint = new THREE.Color(0x000000);
    const mat = new THREE.MeshBasicMaterial({
        color:          tint,
        side:           THREE.DoubleSide,
        toneMapped:     false,
        clippingPlanes: [_reflClipPlane],
        clipShadows:    false,
    });
    _reflMatCache.set(srcMat, mat);
    return mat;
}
function _buildReflHost(host) {
    const rHost = new THREE.Group();
    for (const m of host.children) {
        if (!m.isMesh || !m.geometry) continue;
        const refl = new THREE.Mesh(m.geometry, _getReflMat(m.material));
        refl.castShadow    = false;
        refl.receiveShadow = false;
        rHost.add(refl);
    }
    return rHost;
}
function _disposeReflHost(rHost) {
    // Geometries are shared with the originals — never dispose those here.
    // Materials are cached by source and re-used across tiles, so we leave
    // them too. Just detach the Group.
    reflectionsGroup.remove(rHost);
}
function disposeTileReflection(tileId) {
    const r = tileReflObjects.get(tileId);
    if (r) { _disposeReflHost(r); tileReflObjects.delete(tileId); }
}
function placeTileReflection(tileId, host) {
    disposeTileReflection(tileId);
    if (!reflEnabled) return;
    const rHost = _buildReflHost(host);
    rHost.userData._tileId = tileId;
    reflectionsGroup.add(rHost);
    tileReflObjects.set(tileId, rHost);
}
function clearAllTileReflections() {
    for (const rHost of tileReflObjects.values()) _disposeReflHost(rHost);
    tileReflObjects.clear();
}
// Rebuild every reflection mesh's material from the corresponding source
// material — called when monochrome flips, since reflection materials are
// clones of whichever material the original mesh is currently using.
function refreshAllReflectionMats() {
    for (const rHost of tileReflObjects.values()) {
        let i = 0;
        for (const tileMesh of (tileObjects.get(rHost.userData._tileId)?.children || [])) {
            if (!tileMesh.isMesh) continue;
            const refl = rHost.children[i++];
            if (refl) refl.material = _getReflMat(tileMesh.material);
        }
    }
}
function setReflectionsEnabled(on) {
    reflEnabled = on;
    reflectionsGroup.visible = on;
    if (!on) { clearAllTileReflections(); return; }
    _updateReflectionTransforms();
    for (const [tileId, host] of tileObjects.entries()) {
        if (tileReflObjects.has(tileId)) continue;
        const rHost = _buildReflHost(host);
        rHost.userData._tileId = tileId;
        reflectionsGroup.add(rHost);
        tileReflObjects.set(tileId, rHost);
    }
}
function _buildEdgeHost(host) {
    const eHost = new THREE.Group();
    for (const m of host.children) {
        if (!m.isMesh || !m.geometry || !m.material) continue;
        // If monochrome swapped the material, the real identity lives on
        // userData._origMat — filter against that so 'w' / 'road' / water
        // are still skipped under mono.
        const idMat = m.userData._origMat || m.material;
        const col   = idMat.color;
        const hex   = col ? col.getHexString() : '';
        if (_EDGE_SKIP_COLORS.has(hex)) continue;
        const eg = new THREE.EdgesGeometry(m.geometry, EDGE_ANGLE_DEG);
        eHost.add(new THREE.LineSegments(eg, _edgeMat));
    }
    return eHost;
}
function _disposeEdgeHost(eHost) {
    for (const c of eHost.children) c.geometry?.dispose();
    edgesGroup.remove(eHost);
}
// Drop a single tile's cached edges. Called whenever placeTileAsset is
// about to replace that tile's host meshes — the cached lines no longer
// match the new geometry.
function disposeTileEdges(tileId) {
    const e = tileEdgeObjects.get(tileId);
    if (e) { _disposeEdgeHost(e); tileEdgeObjects.delete(tileId); }
}
// Build (or rebuild) edges for one tile. No-op when the overlay is off,
// so placeTileAsset can call it unconditionally.
function placeTileEdges(tileId, host) {
    disposeTileEdges(tileId);
    if (!edgesEnabled) return;
    const eHost = _buildEdgeHost(host);
    edgesGroup.add(eHost);
    tileEdgeObjects.set(tileId, eHost);
}
// Drop every cached edge — used when callers wipe tileObjects directly
// (restartSimulation / rebuildGeometryAfterElevChange).
function clearAllTileEdges() {
    for (const eHost of tileEdgeObjects.values()) _disposeEdgeHost(eHost);
    tileEdgeObjects.clear();
}
// Toggle handler: just flip visibility and, on enable, lazily build the
// edges that aren't cached yet (i.e. all of them on first turn-on, or
// any tiles placed while the overlay was off).
function setEdgesEnabled(on) {
    edgesEnabled = on;
    edgesGroup.visible = on;
    if (!on) return;
    for (const [tileId, host] of tileObjects.entries()) {
        if (tileEdgeObjects.has(tileId)) continue;
        const eHost = _buildEdgeHost(host);
        edgesGroup.add(eHost);
        tileEdgeObjects.set(tileId, eHost);
    }
}

let topoMesh = null, waterMesh = null;
// Cached smooth topo normals, one per JSON vertex. Used by placeTileAsset
// to filter the bottom of each cube asset so that adjacent tiles share
// matching normals along their corner/edge boundaries — gets rid of the
// per-cell seam that looked like a faceted ground.
let topoSmoothNormals = null;
let cx = 0, cz = 0;
let elevScale = 0.3;
// Atlas asset model: 30 × 30 × 30 m block with origin at the BOTTOM CENTER —
// so local positions live in [-15, +15] × [0, 30] × [-15, +15]. The deformation
// below maps that bounding box into each cell's skewed prism on the topo.
const ASSET_HALF   = 15;   // m — half of the asset's footprint
const ASSET_HEIGHT = 30;   // m — vertical extent above ground
let atlasNodes = null;     // Map<sig, Object3D>  (loaded from atlas_3d.glb)
let initialized = false;

// ======================================================================
// World-space helpers (must agree with topo_test.html so settlements/topo
// line up). World X = hexX - cx, world Z = hexY - cz, world Y = elev * scale.
// ======================================================================
function worldXOf(v)    { return v.hexX - cx; }
function worldZOf(v)    { return v.hexY - cz; }
function worldYOf(v)    { return v.elevation * elevScale; }
function worldVec3(v, out) {
    out = out || new THREE.Vector3();
    return out.set(worldXOf(v), worldYOf(v), worldZOf(v));
}

// ======================================================================
// Topo mesh (smooth, indexed) — same approach as topo_test.html
// ======================================================================
function cacheTopoNormals() {
    if (!topoMesh) return;
    const norm = topoMesh.geometry.getAttribute('normal');
    const N = vertices.length;
    topoSmoothNormals = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        topoSmoothNormals[i*3]     = norm.getX(i);
        topoSmoothNormals[i*3 + 1] = norm.getY(i);
        topoSmoothNormals[i*3 + 2] = norm.getZ(i);
    }
}

function buildTopo() {
    const positions = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        positions[i*3]     = worldXOf(v);
        positions[i*3 + 1] = worldYOf(v);
        positions[i*3 + 2] = worldZOf(v);
    }
    const indices = new Uint32Array(tiles.length * 6);
    let o = 0;
    for (const t of tiles) {
        let i0 = t.vertexIndices[0], i1 = t.vertexIndices[1],
            i2 = t.vertexIndices[2], i3 = t.vertexIndices[3];
        // Force CCW-from-above for correct normals.
        const p0x = positions[i0*3], p0z = positions[i0*3 + 2];
        const e1x = positions[i1*3] - p0x, e1z = positions[i1*3 + 2] - p0z;
        const e2x = positions[i3*3] - p0x, e2z = positions[i3*3 + 2] - p0z;
        if (e1z * e2x - e1x * e2z < 0) { const tmp = i1; i1 = i3; i3 = tmp; }
        indices[o++] = i0; indices[o++] = i1; indices[o++] = i2;
        indices[o++] = i0; indices[o++] = i2; indices[o++] = i3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x3d5566, roughness: 0.95 });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    return m;
}

// ======================================================================
// Water plane sized to terrain extent; level driven by sim's `waterLevel`.
// ======================================================================
// Water plane shaped to the hexagonal map boundary (flat-top regular hex).
// 6-triangle fan around the hex centre — crops cleanly to the same outline
// as the topo so the water doesn't overflow into the surrounding "sand box".
// Geometry sits in world XZ; mesh.position.y rides waterLevel·elevScale.
function buildWater() {
    if (!topoData || !topoData.mapping) return null;

    const hexC = topoData.mapping.hexCenter;
    const R    = (topoData.mapping.hexBounds.maxX - topoData.mapping.hexBounds.minX) / 2;
    const cxw  = hexC.x - cx;
    const czw  = hexC.y - cz;

    // Simple translucent hex water plane in world XZ. No planar-reflection
    // pass, no shader: the custom dark mirror meshes underneath provide
    // the reflection, and the water plane just tints what's visible
    // through it. Cheap to render.
    const positions = [cxw, 0, czw];
    for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        positions.push(cxw + R * Math.cos(a), 0, czw + R * Math.sin(a));
    }
    const indices = [];
    for (let i = 0; i < 6; i++) {
        indices.push(0, 1 + i, 1 + ((i + 1) % 6));
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();

    const m = new THREE.MeshStandardMaterial({
        color:      0x3a7ca5,
        transparent: true,
        opacity:    0.35,
        side:       THREE.DoubleSide,
        // High roughness + near-zero metalness keeps the sun glint
        // diffuse instead of a tight specular highlight.
        metalness:  0.02,
        roughness:  0.85,
        // depthWrite must be false on a translucent surface so the dark
        // reflection meshes behind it actually show through and aren't
        // z-occluded by the water-plane's own depth.
        depthWrite: false,
    });

    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = waterLevel * elevScale;
    return mesh;
}
function _tickWater() {
    // Plain plane — no time uniform to update. Kept as a no-op so the
    // render loop's call site doesn't have to be conditional.
}

// ======================================================================
// Atlas loading
// ======================================================================
async function loadAtlas() {
    const gltf = await new GLTFLoader().loadAsync('assets/atlas_3d.glb');
    // Each pattern is a parent node named by 4-char signature; look them all up.
    atlasNodes = new Map();
    gltf.scene.traverse(o => {
        if (o.name && /^[wr12c]{4}$/.test(o.name)) atlasNodes.set(o.name, o);
    });
    // Bilinear deformation can produce mixed winding (the mesh's outward
    // normal flips wherever the local→world Jacobian's determinant flips
    // sign — happens naturally on skewed/inverted quads). Easiest fix: render
    // both sides. Materials are shared/deduped in the GLB, so this one pass
    // covers all tiles that reference the same material.
    //
    // For shadows: with side=DoubleSide, three.js defaults shadowSide to
    // FrontSide, so triangles whose winding got flipped don't cast shadows
    // (and the topo / neighbouring buildings show no shadow under them).
    // Setting shadowSide=DoubleSide forces both sides to contribute to the
    // shadow map at ~2× shadow-render cost — fine, and what we want here.
    // Some materials may arrive as MeshBasicMaterial (e.g. trimesh
    // emitting KHR_materials_unlit, or any glTF that lacks PBR data). Those
    // are *unlit* — they ignore lights entirely, so they wouldn't respond
    // to the day/night cycle. Convert to MeshStandardMaterial up front so
    // every atlas mesh participates in the lighting pipeline. Use a Map
    // so multiple meshes sharing the same original material get the same
    // replacement.
    // Convert EVERY atlas material to MeshLambertMaterial. Lambert is a
    // simple diffuse-only model — no metalness, no roughness, no IBL —
    // so it always responds to direct lights + AmbientLight + the
    // HemisphereLight in a predictable way. The Standard/Physical PBR
    // path has bitten us repeatedly when materials arrived with HDR
    // basecolor, sneaky emissive, high metalness, KHR_unlit, etc.;
    // Lambert sidesteps the whole pile.
    //
    // De-duplicated by reference so meshes that shared the same original
    // glTF material end up sharing the same Lambert replacement.
    const matSwap = new Map();
    gltf.scene.traverse(o => {
        if (!o.isMesh || !o.material) return;
        const orig = o.material;
        if (matSwap.has(orig)) { o.material = matSwap.get(orig); return; }

        // Clone & clamp baseColor — some exporters write > 1 floats (HDR)
        // which saturate every fragment regardless of incoming light.
        const baseColor = orig.color ? orig.color.clone() : new THREE.Color(0xcccccc);
        baseColor.r = Math.min(1, baseColor.r);
        baseColor.g = Math.min(1, baseColor.g);
        baseColor.b = Math.min(1, baseColor.b);

        const replacement = new THREE.MeshLambertMaterial({
            color:       baseColor,
            map:         orig.map || null,
            transparent: !!orig.transparent,
            opacity:     orig.opacity != null ? orig.opacity : 1,
            side:        THREE.DoubleSide,
            // Clip the original tile geometry at the water plane so the
            // underwater portion of every asset is removed (the water
            // plane + dark reflection take over below the waterline).
            clippingPlanes: [_origClipPlane],
            // emissive defaults to (0,0,0) on a fresh Lambert — exactly
            // what we want; no glTF-injected self-light will sneak in.
        });
        replacement.name = orig.name;
        matSwap.set(orig, replacement);
        o.material = replacement;

        console.log('atlas mat:', JSON.stringify(orig.name || '?'),
                    'origType=' + orig.type,
                    'origColor=' + (orig.color ? orig.color.getHexString() : '–'),
                    'origEmissive=' + (orig.emissive ? orig.emissive.getHexString() : '–'),
                    '→ Lambert ' + baseColor.getHexString());
    });
    console.log('atlas: converted', matSwap.size, 'unique materials → MeshLambertMaterial');
}

// ======================================================================
// Settlement markers (Phase 2)
// Lord/Farmer/Merchant → small color-coded sphere on the topo at the
// settlement's vertex. Rebuilt from scratch every sync — settlement count
// is small enough that this is cheap.
// ======================================================================
const PROF_COLOR = {
    Lord:     0xff8a3d,   // orange
    Farmer:   0x88ee66,   // green
    Merchant: 0xeebb33,   // yellow
};
const markerGeom = new THREE.SphereGeometry(2.5, 12, 8);
const markerMatCache = new Map();
function markerMat(profession) {
    if (!markerMatCache.has(profession)) {
        markerMatCache.set(profession, new THREE.MeshStandardMaterial({
            color: PROF_COLOR[profession] ?? 0xffffff, roughness: 0.5,
        }));
    }
    return markerMatCache.get(profession);
}

function syncSettlements() {
    // Marker drawing is disabled — tile assets already show the city.
    while (settlementsGroup.children.length) {
        settlementsGroup.remove(settlementsGroup.children[0]);
    }
}

// ======================================================================
// Edge-traffic rendering. Per-route lines are gone; each unique edge
// (vertex-to-neighbor pair) gets a flat quad on top of the topo whose
// width and colour are driven by that edge's accumulated `trafficCount`.
// All edges merge into one BufferGeometry → one draw call.
//
//   width = clamp(EDGE_WIDTH_MIN, EDGE_WIDTH_MAX, ln(1+trafficCount) · EDGE_WIDTH_SCALE)
//   colour interpolates EDGE_COLOR_LOW → EDGE_COLOR_HIGH on trafficCount/maxObserved
//
// Width uses a log scale so the regional trade route (often hundreds of
// trafficCount) doesn't dwarf the much smaller per-merchant feeders.
// Edges are de-duplicated by emitting only when v.index < neighbor.vertexIndex.
// ======================================================================
const EDGE_WIDTH_SCALE = 1.4;      // world units per ln(1+traffic)
const EDGE_WIDTH_MIN   = 0.3;
const EDGE_WIDTH_MAX   = 12;
const EDGE_LIFT        = 1.0;      // hover above the topo to avoid z-fight
const EDGE_COLOR_LOW   = 0xffe070; // light traffic
const EDGE_COLOR_HIGH  = 0xff2233; // heavy traffic

// ======================================================================
// Debug-value overlays (Phase 5)
// One re-usable mesh sitting just above the topo, vertex-coloured per the
// active debug layer. Layers are mutually exclusive — clicking the active
// layer's button turns it off; clicking another switches.
// ======================================================================
// Each layer's `stops` is a colour ramp interpolated from low (index 0) to
// high (last index). Two-colour ramps still work — just pass two stops.
const DEBUG_LAYERS = {
    // Classical hypsometric tints: deep ocean → coast → lowland green → tan → brown → snow.
    elevation:     { f: v => v.elevation,
                     stops: [0x081830, 0x2860a0, 0x60b0d0, 0xeeddaa, 0x88bb55, 0xddcc66, 0x886633, 0xeeeeee],
                     label: 'elevation' },
    // Yellow → green → blue, low (blue) to high (yellow) per request.
    defense:       { f: v => v.defense,
                     stops: [0x2244ff, 0x44ccff, 0x44dd66, 0xddee22, 0xffaa00],
                     label: 'defense' },
    security:      { f: v => v._security,         stops: [0x222244, 0x88ccff],         label: 'security' },
    farmValue:     { f: v => v.farmValue,         stops: [0x222222, 0x66aa44, 0xeeff66], label: 'farm value' },
    farmerValue:   { f: v => v.farmerValue,       stops: [0x222222, 0x44ddcc],         label: 'farmer value' },
    merchantValue: { f: v => v.merchantValue,     stops: [0x222222, 0xddaa22],         label: 'merchant value' },
    steepness:     { f: v => v.steepness,         stops: [0x224422, 0xddee44, 0xff2222], label: 'steepness' },
    trafficCount:  { f: v => v.neighbors.reduce((s,n)=>s+(n.trafficCount||0),0),
                                                  stops: [0x111111, 0xffaa00],         label: 'traffic' },
    habitable:     { f: v => v.habitable ? 1 : 0, stops: [0x553322, 0x44ff44],         label: 'habitable' },
    occupied:      { f: v => v.occupied  ? 1 : (v.occupiedByRoute ? 0.5 : 0),
                                                  stops: [0x222222, 0xff4488],         label: 'occupied' },
};

// Interpolate a multi-stop colour ramp at t∈[0,1]. Stops are evenly spaced.
function colorAtStop(stops, t, out) {
    const n = stops.length;
    if (n === 1) return out.set(stops[0]);
    const x = Math.max(0, Math.min(1, t)) * (n - 1);
    const i = Math.min(Math.floor(x), n - 2);
    const u = x - i;
    return out.set(stops[i]).lerp(_stopTmp.set(stops[i + 1]), u);
}
const _stopTmp = new THREE.Color();
let activeDebugLayer = null;
let debugMesh        = null;

function buildDebugMesh() {
    if (!topoMesh) return;
    const pos = topoMesh.geometry.getAttribute('position');
    const idx = topoMesh.geometry.getIndex();
    const N   = pos.count;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        positions[i*3]     = pos.getX(i);
        positions[i*3 + 1] = pos.getY(i) + 0.5;   // lift above topo
        positions[i*3 + 2] = pos.getZ(i);
    }
    const colors = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
    g.setIndex(idx.clone());
    const m = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest:  false,            // render on top of tiles/buildings
    });
    if (debugMesh) {
        debugMesh.geometry.dispose();
        scene.remove(debugMesh);
    }
    debugMesh = new THREE.Mesh(g, m);
    debugMesh.renderOrder = 1000;     // draw after everything else
    debugMesh.visible = activeDebugLayer != null;
    scene.add(debugMesh);
    if (activeDebugLayer) refreshDebugColors();
}

function refreshDebugColors() {
    if (!debugMesh || !activeDebugLayer) return;
    const layer = DEBUG_LAYERS[activeDebugLayer];
    if (!layer) return;

    // Simple min/max range. (We tried percentile-based clipping but the
    // dataset has long-tailed distributions where the simple range still
    // reads better; revisit if a layer's gradient looks crushed.)
    let lo = Infinity, hi = -Infinity;
    for (const v of vertices) {
        const x = layer.f(v);
        if (Number.isFinite(x)) {
            if (x < lo) lo = x;
            if (x > hi) hi = x;
        }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const span = hi - lo > 1e-9 ? hi - lo : 1;
    console.log(`[debug ${activeDebugLayer}] lo=${lo.toFixed(3)} hi=${hi.toFixed(3)} span=${span.toFixed(3)}`);

    const colors = debugMesh.geometry.getAttribute('color').array;
    const tmp = new THREE.Color();
    const stops = layer.stops || [layer.c0 ?? 0x000000, layer.c1 ?? 0xffffff];
    for (let i = 0; i < vertices.length; i++) {
        const x = layer.f(vertices[i]);
        const t = Number.isFinite(x) ? (x - lo) / span : 0;
        colorAtStop(stops, t, tmp);
        colors[i*3]     = tmp.r;
        colors[i*3 + 1] = tmp.g;
        colors[i*3 + 2] = tmp.b;
    }
    debugMesh.geometry.getAttribute('color').needsUpdate = true;
}

function setDebugLayer(name) {
    activeDebugLayer = (activeDebugLayer === name) ? null : name;
    if (debugMesh) {
        debugMesh.visible = activeDebugLayer != null;
        if (activeDebugLayer) refreshDebugColors();
    }
    // Mirror demo-mode behaviour: show the layer's label centered at the
    // bottom of the screen while the layer is active.
    const lbl = _demoLabelEl();
    if (lbl) {
        if (activeDebugLayer && DEBUG_LAYERS[activeDebugLayer]) {
            lbl.textContent = (DEBUG_LAYERS[activeDebugLayer].label || activeDebugLayer).toUpperCase();
            lbl.classList.add('show');
        } else {
            lbl.classList.remove('show');
        }
    }
    return activeDebugLayer;
}

// ======================================================================
// Demonstration mode — cycles through every debug layer with on-screen
// labels, like the reference 2D simulation's 🎬 button. Each layer
// shows for DEMO_LAYER_MS, then blank for DEMO_GAP_MS, then the next
// layer. Time-based (performance.now()) instead of frame-based, so the
// pacing is the same regardless of render framerate.
// ======================================================================
let demoMode        = false;
let demoPhaseStart  = 0;           // timestamp (ms) when current phase began
let demoLayerIdx    = 0;
let demoShowing     = true;        // true = a layer is on; false = gap
const DEMO_LAYER_MS = 2100;        // 2.1 s display per layer
const DEMO_GAP_MS   = 650;         // 0.65 s blank between layers
const DEMO_ORDER = [
    'elevation', 'defense', 'security', 'farmValue', 'farmerValue',
    'merchantValue', 'steepness', 'trafficCount', 'habitable', 'occupied',
];
function _demoLabelEl() { return document.getElementById('demoLabel'); }
function setDemoMode(on) {
    demoMode = !!on;
    if (demoMode) {
        demoPhaseStart = performance.now();
        demoLayerIdx   = 0;
        demoShowing    = true;
        const first = DEMO_ORDER[0];
        if (DEBUG_LAYERS[first]) {
            activeDebugLayer = first;
            if (debugMesh) {
                debugMesh.visible = true;
                refreshDebugColors();
            }
            const lbl = _demoLabelEl();
            if (lbl) { lbl.textContent = (DEBUG_LAYERS[first].label || first).toUpperCase(); lbl.classList.add('show'); }
        }
    } else {
        // Turn off the active demo layer and hide the label.
        if (activeDebugLayer && DEMO_ORDER.indexOf(activeDebugLayer) >= 0) {
            activeDebugLayer = null;
            if (debugMesh) debugMesh.visible = false;
        }
        const lbl = _demoLabelEl();
        if (lbl) lbl.classList.remove('show');
    }
    // Reflect on the layer-button row so the user sees what's active.
    const layerBtns = document.querySelectorAll('button[data-layer]');
    for (const b of layerBtns) {
        b.classList.toggle('armed', b.dataset.layer === activeDebugLayer);
    }
}
function tickDemoMode() {
    if (!demoMode) return;
    const elapsed = performance.now() - demoPhaseStart;
    if (demoShowing && elapsed >= DEMO_LAYER_MS) {
        demoPhaseStart = performance.now();
        demoShowing    = false;
        // hide layer + label during the gap
        if (debugMesh) debugMesh.visible = false;
        const lbl = _demoLabelEl();
        if (lbl) lbl.classList.remove('show');
    } else if (!demoShowing && elapsed >= DEMO_GAP_MS) {
        demoPhaseStart = performance.now();
        demoShowing    = true;
        demoLayerIdx   = (demoLayerIdx + 1) % DEMO_ORDER.length;
        const name     = DEMO_ORDER[demoLayerIdx];
        if (DEBUG_LAYERS[name]) {
            activeDebugLayer = name;
            if (debugMesh) {
                debugMesh.visible = true;
                refreshDebugColors();
            }
            const lbl = _demoLabelEl();
            if (lbl) { lbl.textContent = (DEBUG_LAYERS[name].label || name).toUpperCase(); lbl.classList.add('show'); }
            const layerBtns = document.querySelectorAll('button[data-layer]');
            for (const b of layerBtns) b.classList.toggle('armed', b.dataset.layer === name);
        }
    }
}

// ======================================================================
// Regional trade route (TODO #2). The 2D simulation hard-codes start/end
// vertices per city; here we pick them randomly each run, but only from
// "true edge" vertices — those that appear in only 1 or 2 tiles, i.e.
// sit on the outer boundary of the relaxed Voronoi mesh — and require
// the euclidean distance between the two endpoints to exceed the map's
// Z span (so the route always crosses the region rather than running
// along one edge). createHardcodedRoute sets tradeDestination1/2, which
// 15_settlement.js's createMerchant already reads to route every newly
// spawned merchant to those endpoints.
function findStrictEdgeVertices() {
    const tileCount = new Map();
    for (const t of tiles) {
        for (const idx of t.vertexIndices) {
            tileCount.set(idx, (tileCount.get(idx) || 0) + 1);
        }
    }
    const edges = [];
    for (const v of vertices) {
        if ((tileCount.get(v.index) || 0) <= 2) edges.push(v);
    }
    return edges;
}

// Quick console-side audit so you can confirm new merchants actually run
// pathfinding to the regional endpoints. From the devtools console:
//     auditMerchantRoutes()
// prints each Merchant settlement and how many of `routes` start at it
// AND end at tradeDestination1 or tradeDestination2. Anything reading 0
// is a settlement that didn't run the trade pathfinding.
window.auditMerchantRoutes = function () {
    const td1 = tradeDestination1 ? tradeDestination1.index : null;
    const td2 = tradeDestination2 ? tradeDestination2.index : null;
    if (td1 == null || td2 == null) {
        console.warn('tradeDestination1/2 are not set — call setupRegionalRoute()');
        return;
    }
    console.log('regional endpoints:', td1, '↔', td2);
    let zero = 0;
    for (const s of settlements) {
        if (s.profession !== 'Merchant') continue;
        const myIdx = s.vertex && s.vertex.index;
        let hits1 = 0, hits2 = 0;
        for (const r of routes) {
            if (!r.start || r.start.index !== myIdx) continue;
            if (r.end && r.end.index === td1) hits1++;
            if (r.end && r.end.index === td2) hits2++;
        }
        console.log(`  merchant @${myIdx}  →td1:${hits1}  →td2:${hits2}  (tw=${s.trafficWeight})`);
        if (hits1 === 0 && hits2 === 0) zero++;
    }
    console.log(zero === 0 ? 'all merchants routed to at least one endpoint ✓' :
                              `${zero} merchant(s) have no trade routes ✗`);
};

function setupRegionalRoute() {
    if (typeof createHardcodedRoute !== 'function') return false;
    const edges = findStrictEdgeVertices();
    if (edges.length < 2) {
        console.warn('regional route: <2 strict-edge vertices, skipping');
        return false;
    }
    let zMin = Infinity, zMax = -Infinity;
    for (const v of vertices) {
        if (v.hexY < zMin) zMin = v.hexY;
        if (v.hexY > zMax) zMax = v.hexY;
    }
    const zSpan = zMax - zMin;
    for (let attempt = 0; attempt < 200; attempt++) {
        const a = edges[Math.floor(Math.random() * edges.length)];
        const b = edges[Math.floor(Math.random() * edges.length)];
        if (a === b) continue;
        const dx = a.hexX - b.hexX, dy = a.hexY - b.hexY;
        if (Math.hypot(dx, dy) > zSpan) {
            try {
                createHardcodedRoute(a.index, b.index);
                console.log('regional trade route:', a.index, '↔', b.index,
                            '(', edges.length, 'edge vertices,',
                            'Δ=' + Math.hypot(dx, dy).toFixed(0),
                            'zSpan=' + zSpan.toFixed(0) + ')');
                return true;
            } catch (e) {
                console.warn('createHardcodedRoute failed:', e);
                return false;
            }
        }
    }
    console.warn('regional route: no valid endpoint pair found in 200 attempts');
    return false;
}

// ======================================================================
// Spawn step (matches the reference's runSimulationStep distribution).
// First step is always a Lord; subsequent steps roll the dice using
// user-controllable percentages. The reference uses 1% / 50% / 49%.
// ======================================================================
let isFirstSpawn = true;
const spawnProbs = { Lord: 1, Farmer: 50, Merchant: 49 };

function simStep() {
    if (typeof populateHabitableArray === 'function') populateHabitableArray();
    if (isFirstSpawn) {
        isFirstSpawn = false;
        if (typeof createLord === 'function') createLord();
        return;
    }
    const total = spawnProbs.Lord + spawnProbs.Farmer + spawnProbs.Merchant;
    if (total <= 0) return;
    const r = Math.random() * total;
    if      (r < spawnProbs.Farmer)                       createFarmer();
    else if (r < spawnProbs.Farmer + spawnProbs.Merchant) createMerchant();
    else                                                  createLord();
}
function simStepN(n) {
    for (let i = 0; i < n; i++) simStep();
    postSimStep();
}

// Auto-restart bookkeeping: capture the habitable-tile pool size once at
// the start of a session so we can detect when the city has filled most
// of it (≥ 60% used) and restart automatically during auto-spawn.
let initialHabitableCount = 0;
const AUTO_RESTART_FRACTION = 0.6;
let autoRestartEnabled = true;       // toggled by 🔁 bAutoRestart in right column

// Full clean-slate restart — same map, but every per-vertex sim value
// and every per-edge counter goes back to where it would be on a
// freshly-loaded JSON. The reference's clearSettlements + clearRoutes
// only handle some of this; the rest (occupiedByRoute, occupiedBy,
// attrition, farmerNr, _security, _trafficValue, neighbor.trafficCount,
// neighbor.travelCount) we wipe explicitly.
function restartSimulation() {
    // 1. Helper-driven clears (settlements, castleVertices, habitable,
    //    routes, vertex.traffic, defense, farmValue, merchantValue,
    //    security, farmerValue, occupied, buffer, castleAnnex, garden).
    if (typeof clearSettlements === 'function') clearSettlements();
    if (typeof clearRoutes      === 'function') clearRoutes();

    // 2. Per-vertex + per-edge fields the helpers miss.
    if (Array.isArray(vertices)) {
        for (const v of vertices) {
            v.occupiedBy      = null;
            v.occupiedByRoute = false;
            v.attrition       = 0;
            v.farmerNr        = 0;
            v._security       = 1;          // default baseline
            v._trafficValue   = 0;
            v.merchantValue   = 0;
            v.traffic         = 0;
            v.trafficValue    = 0;
            v.farmerValue     = 0;
            v.farmValue       = 0;
            v.defense         = 0;
            v.castleAnnex     = null;
            v.garden          = null;
            // Reset cached neighbour graphs so calculateFarmerValues
            // recomputes from scratch on the next spawn step.
            v.vincinityNeighbors = undefined;
            v.floodedNeighbors   = undefined;
            // Per-edge: traffic accumulation + path-dependency travel count
            if (Array.isArray(v.neighbors)) {
                for (const n of v.neighbors) {
                    n.trafficCount = 0;
                    n.travelCount  = 0;
                }
            }
        }
    }

    // 3. Re-derive simulation values from the now-clean vertex state.
    //    initializeSimulationValues recomputes steepness; initializeHabitable
    //    rebuilds the habitable[] pool and refreshes defense / farmValue
    //    starting from zero.
    if (typeof initializeSimulationValues === 'function') initializeSimulationValues();
    if (typeof initializeHabitable        === 'function') initializeHabitable();

    // 4. Re-establish the regional trade route (sets tradeDestination1/2
    //    afresh and creates a new hard-coded route in routes[]).
    if (typeof setupRegionalRoute === 'function') setupRegionalRoute();

    // 5. Top-level UI/sim flags.
    isFirstSpawn          = true;
    initialHabitableCount = 0;

    // 6. Visual rebuild — wipe tile cache, then let the syncs paint
    //    everything fresh from the freshly-zeroed state.
    if (typeof lastSigByTileId !== 'undefined' && lastSigByTileId.clear) {
        lastSigByTileId.clear();
    }
    if (typeof tileObjects !== 'undefined') {
        for (const obj of tileObjects.values()) tilesGroup.remove(obj);
        tileObjects.clear();
    }
    if (typeof clearAllTileEdges  === 'function') clearAllTileEdges();
    if (typeof clearAllTileReflections === 'function') clearAllTileReflections();
    if (typeof syncSettlements    === 'function') syncSettlements();
    if (typeof syncRoutes         === 'function') syncRoutes();
    if (typeof syncTiles          === 'function') syncTiles();
    if (typeof refreshDebugColors === 'function') refreshDebugColors();
    if (typeof buildCityLights    === 'function') buildCityLights();
    if (typeof window.__hudRefresh === 'function') window.__hudRefresh();
    if (advancedMode) renderer.shadowMap.needsUpdate = true;
    console.log('[sim] restarted: clean vertex state, new regional route');
}

// Post-step bookkeeping that the reference 2D sim doesn't do but the user
// asked for in the project TODO:
//   1. Farm value already includes a smooth high-ground penalty inside
//      Vertex.calculateFarmValue (12_vertex.js), so no extra work needed
//      here — leaving the hook in case more derived values are added.
//   2. Farmer settlements whose vertex.merchantValue exceeds a threshold
//      get upgraded to Merchants (the "trade routes turned a farm village
//      into a market town" arc) AND immediately generate the same trade
//      routes the original createMerchant would — to tradeDestination1/2
//      (the regional endpoints) and the first castle.
const FARMER_TO_MERCHANT_THRESHOLD = 200;
function spawnMerchantTradeRoutes(merchant) {
    if (!merchant.vertex || typeof pathFinding !== 'function') return;
    const tw = merchant.trafficWeight;
    const ends = [];
    if (tradeDestination1) ends.push({ to: tradeDestination1, w: tw });
    if (tradeDestination2) ends.push({ to: tradeDestination2, w: tw });
    if (castleVertices && castleVertices.length > 0) {
        ends.push({ to: castleVertices[0], w: tw * 2 });
    }
    for (const { to, w } of ends) {
        if (!to || to === merchant.vertex) continue;
        try {
            const path = pathFinding(merchant.vertex, to, w);
            if (path) routes.push(new Route(merchant.vertex, to, w, path));
        } catch (e) {
            console.warn('merchant trade-route pathfinding failed:', e);
        }
    }
}

function postSimStep() {
    for (const s of settlements) {
        if (s.profession === 'Farmer'
            && s.vertex
            && s.vertex.merchantValue > FARMER_TO_MERCHANT_THRESHOLD) {
            // Flip profession + traffic weight (Merchant = 2 in the
            // Settlement constructor; we have to mirror that here since
            // we're not constructing a new Settlement object).
            s.profession    = 'Merchant';
            s.trafficWeight = 2;
            // Drop the farmer's gardens — they become merchant stalls now.
            farmerVertexIndices.delete(s.vertex.index);
            const vincinity = s.vertex.vincinityNeighbors;
            if (Array.isArray(vincinity)) {
                for (const n of vincinity) n.garden = null;
            }
            // Generate the trade routes the merchant should have.
            spawnMerchantTradeRoutes(s);
        }
    }
}

// ======================================================================
// Mouse picking & click-to-place actions (Phase 6)
// Raycast against the topo, snap to the nearest vertex, then run the
// active mouse-mode action. These mirror placeCastle/placeFarmer/...
// from the reference's 20_UI.js, simplified.
// ======================================================================
const raycaster = new THREE.Raycaster();
const ndc       = new THREE.Vector2();
let hoverMarker = null;
let mouseMode   = null;
let pendingRoadStart = null;

// Cast a ray from screen coords. Hits whichever of (tilesGroup, topoMesh,
// settlementsGroup) is currently visible — the topo is hidden by default
// but the tile assets cover its surface, so we still get a usable hit.
function rayHitWorld(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const targets = [];
    if (tilesGroup       && tilesGroup.visible)       targets.push(tilesGroup);
    if (topoMesh         && topoMesh.visible)         targets.push(topoMesh);
    if (settlementsGroup && settlementsGroup.visible) targets.push(settlementsGroup);
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, true);
    return hits.length ? hits[0] : null;
}

function pickVertex(clientX, clientY) {
    const hit = rayHitWorld(clientX, clientY);
    if (!hit) return null;
    const p = hit.point;
    let best = null, bestD2 = Infinity;
    for (const v of vertices) {
        const dx = worldXOf(v) - p.x;
        const dy = worldYOf(v) - p.y;
        const dz = worldZOf(v) - p.z;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bestD2) { bestD2 = d2; best = v; }
    }
    return best;
}

// Click a tile mesh → walk up the parent chain until we find the host
// group whose userData.tile we set in placeTileAsset.
function pickTile(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(tilesGroup, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !(o.userData && o.userData.tile)) o = o.parent;
    return o ? o.userData.tile : null;
}

function ensureHoverMarker() {
    if (hoverMarker) return hoverMarker;
    const g = new THREE.RingGeometry(2.5, 4, 24);
    const m = new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
        depthTest: false,
    });
    hoverMarker = new THREE.Mesh(g, m);
    hoverMarker.rotation.x = -Math.PI / 2;
    hoverMarker.renderOrder = 999;
    scene.add(hoverMarker);
    return hoverMarker;
}

function showHoverAt(v) {
    const m = ensureHoverMarker();
    if (!v) { m.visible = false; return; }
    m.position.set(worldXOf(v), worldYOf(v) + 1.5, worldZOf(v));
    m.visible = true;
}

// --- Action wrappers (close cousins of 2511's 20_UI placeXxx) -----------
function placeCastle(v) {
    if (!v || v.water || v.occupied) return false;
    const lord = new Settlement(v, 'Lord');
    settlements.push(lord);
    castleVertices.push(v);
    if (typeof lord.createAnnexes === 'function') lord.createAnnexes();
    return true;
}
function placeFarmer(v) {
    if (!v || v.water || v.occupied) return false;
    const f = new Settlement(v, 'Farmer');
    settlements.push(f);
    if (typeof f.createGardens === 'function') f.createGardens();
    return true;
}
function placeMerchant(v) {
    if (!v || v.water || v.occupied) return false;
    const m = new Settlement(v, 'Merchant');
    settlements.push(m);
    return true;
}
function placeRoadAt(v) {
    // Single-click "road" just marks the vertex. Two-click pattern below
    // creates a real route between the two clicks via the existing A*.
    if (!v || v.water) return false;
    if (pendingRoadStart && pendingRoadStart !== v) {
        const start = pendingRoadStart;
        pendingRoadStart = null;
        try {
            createHardcodedRoute(start.index, v.index);
        } catch (e) { console.error('createHardcodedRoute failed:', e); }
        return true;
    }
    pendingRoadStart = v;
    return true;
}
function deleteAt(v) {
    if (!v) return false;
    const idx = settlements.findIndex(s => s.vertex && s.vertex.index === v.index);
    if (idx >= 0) {
        const s = settlements[idx];
        s.vertex.occupied   = false;
        s.vertex.occupiedBy = null;
        if (s.profession === 'Lord') {
            const ci = castleVertices.indexOf(s.vertex);
            if (ci >= 0) castleVertices.splice(ci, 1);
        }
        settlements.splice(idx, 1);
        return true;
    }
    if (v.occupiedByRoute) { v.occupiedByRoute = false; v.occupied = false; return true; }
    return false;
}

function applyMouseMode(v) {
    if (!v || !mouseMode) return false;
    let changed = false;
    switch (mouseMode) {
        case 'castle':   changed = placeCastle(v);  break;
        case 'farmer':   changed = placeFarmer(v);  break;
        case 'merchant': changed = placeMerchant(v); break;
        case 'road':     changed = placeRoadAt(v); break;
        case 'delete':   changed = deleteAt(v);    break;
    }
    if (changed) {
        syncSettlements();
        syncRoutes();
        syncTiles();
        refreshDebugColors();
        if (typeof window.__hudRefresh === 'function') window.__hudRefresh();
    }
    return changed;
}

// One mesh that holds every edge with traffic. Rebuilt fresh on each sync.
// City lights at night — same mesh layout as the topo (one vertex per
// JSON vertex, neighbours share corners), so colours interpolate smoothly
// across each cell. That's the "softer / more like street lighting" look
// the user wanted, vs. the previous per-tile flat quads.
//
// Brightness per vertex = sqrt(merchantValue / globalMax) so modest
// commerce still registers; an even-luminance curve.
//
// Lifted ~0.5 world units — above the asset ground (which sits at +0.3
// after TILE_LIFT) but well under building roofs. Depth-tested so
// buildings occlude the lights correctly: you see the glow on the
// streets between them, not bleeding through walls.
const CITY_LIGHTS_LIFT = 0.5;
function buildCityLights() {
    while (cityLightsGroup.children.length) {
        const c = cityLightsGroup.children.pop();
        c.geometry?.dispose();
        c.material?.dispose();
        cityLightsGroup.remove(c);
    }
    // Security has a baseline of 1 on every vertex; settlements boost it
    // above that. We light off the boost (security - 1) so the entire map
    // doesn't glow at the baseline — only settled areas.
    let maxSec = 0;
    for (const v of vertices) {
        const s = (v.security || 0) - 1;
        if (s > maxSec) maxSec = s;
    }
    if (maxSec <= 0) return;

    const N = vertices.length;
    const positions = new Float32Array(N * 3);
    const colors    = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const v = vertices[i];
        positions[i*3]     = worldXOf(v);
        positions[i*3 + 1] = worldYOf(v) + CITY_LIGHTS_LIFT;
        positions[i*3 + 2] = worldZOf(v);
        // Linear normalised security boost — well-guarded centres blaze,
        // edges of the security influence fade out. HDR brightness is
        // cranked through material.color so the linear ramp is fine.
        const s = Math.max(0, (v.security || 0) - 1);
        const intensity = s / maxSec;
        // Warm sodium-vapour street-light tint (deep amber).
        colors[i*3]     = 1.00 * intensity;
        colors[i*3 + 1] = 0.62 * intensity;
        colors[i*3 + 2] = 0.18 * intensity;
    }

    // Same triangulation as the topo: 2 tris per tile, with the same
    // CCW-from-above winding sniff so face normals don't fight.
    const indices = new Uint32Array(tiles.length * 6);
    let o = 0;
    for (const t of tiles) {
        let i0 = t.vertexIndices[0],
            i1 = t.vertexIndices[1],
            i2 = t.vertexIndices[2],
            i3 = t.vertexIndices[3];
        const p0x = positions[i0*3],     p0z = positions[i0*3 + 2];
        const e1x = positions[i1*3]     - p0x, e1z = positions[i1*3 + 2] - p0z;
        const e2x = positions[i3*3]     - p0x, e2z = positions[i3*3 + 2] - p0z;
        if (e1z * e2x - e1x * e2z < 0) { const tmp = i1; i1 = i3; i3 = tmp; }
        indices[o++] = i0; indices[o++] = i1; indices[o++] = i2;
        indices[o++] = i0; indices[o++] = i2; indices[o++] = i3;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));

    // material.color × vertex.color → final fragment colour.
    // Setting material.color above 1.0 (HDR) brightens beyond what
    // opacity can do, then ACES tone-maps it back into range.
    const b = lightCycle.cityLightsBrightness;
    const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        color:        new THREE.Color(b, b, b),
        blending:     THREE.AdditiveBlending,
        transparent:  true,
        opacity:      0,                     // driven by phase
        depthWrite:   false,
        // depthTest stays on — buildings should occlude street lights.
        side:         THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1500;
    cityLightsGroup.add(mesh);
}

function syncRoutes() {
    while (routesGroup.children.length) {
        const c = routesGroup.children[routesGroup.children.length - 1];
        routesGroup.remove(c);
        c.geometry?.dispose();
        c.material?.dispose();
    }

    // Find max traffic for colour normalisation.
    let maxTraffic = 0;
    for (const v of vertices) {
        for (const n of v.neighbors) {
            if (n.trafficCount > maxTraffic) maxTraffic = n.trafficCount;
        }
    }
    if (maxTraffic <= 0) return;

    const positions = [];
    const colors    = [];
    const indices   = [];
    let vCount = 0;

    const dir   = new THREE.Vector3();
    const perp  = new THREE.Vector3();
    const upY   = new THREE.Vector3(0, 1, 0);
    const cLow  = new THREE.Color(EDGE_COLOR_LOW);
    const cHigh = new THREE.Color(EDGE_COLOR_HIGH);
    const tmpC  = new THREE.Color();

    for (const v of vertices) {
        const ax = worldXOf(v);
        const ay = worldYOf(v);
        const az = worldZOf(v);
        for (const n of v.neighbors) {
            if (!(n.trafficCount > 0)) continue;
            // Each edge is symmetric; emit only from the lower-index end.
            if (v.index >= n.vertexIndex) continue;
            const u = vertexByIndex.get(n.vertexIndex);
            if (!u) continue;

            const bx = worldXOf(u);
            const by = worldYOf(u);
            const bz = worldZOf(u);

            // Perpendicular direction in the topo plane (around world Y).
            dir.set(bx - ax, 0, bz - az);
            const len = Math.hypot(dir.x, dir.z);
            if (len < 1e-6) continue;
            dir.x /= len; dir.z /= len;
            perp.crossVectors(upY, dir);   // unit length already

            // Logarithmic line weight: a 100×-busier edge is only ~5×
            // wider than a single-traversal edge, not 100× wider.
            const w = Math.min(
                EDGE_WIDTH_MAX,
                Math.max(EDGE_WIDTH_MIN, Math.log(1 + n.trafficCount) * EDGE_WIDTH_SCALE),
            );
            const half = w * 0.5;

            // 4 quad corners: A_left, A_right, B_right, B_left
            positions.push(
                ax + perp.x * half, ay + EDGE_LIFT, az + perp.z * half,
                ax - perp.x * half, ay + EDGE_LIFT, az - perp.z * half,
                bx - perp.x * half, by + EDGE_LIFT, bz - perp.z * half,
                bx + perp.x * half, by + EDGE_LIFT, bz + perp.z * half,
            );

            const t = Math.min(1, n.trafficCount / maxTraffic);
            tmpC.copy(cLow).lerp(cHigh, t);
            for (let k = 0; k < 4; k++) {
                colors.push(tmpC.r, tmpC.g, tmpC.b);
            }

            const i0 = vCount;
            indices.push(i0, i0 + 1, i0 + 2,  i0, i0 + 2, i0 + 3);
            vCount += 4;
        }
    }

    if (vCount === 0) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
    g.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side:         THREE.DoubleSide,
        transparent:  true,
        opacity:      0.92,
        depthWrite:   false,
    });

    const mesh = new THREE.Mesh(g, mat);
    routesGroup.add(mesh);
}

// ======================================================================
// Tile signatures + atlas placement (Phase 3)
// For every tile, compute the TL/TR/BR/BL signature from the four vertex
// occupation symbols. Skip 'wwww' (wilderness) for performance — only
// non-empty signatures get a 3D asset placed.
// ======================================================================
function getVertexSymbol(v) {
    if (!v) return 'w';
    if (v.occupiedBy) {
        const p = v.occupiedBy.profession;
        if (p === 'Lord')     return 'c';
        if (p === 'Merchant') return '2';
        if (p === 'Farmer')   return '1';
    }
    if (v.castleAnnex)    return 'c';
    if (v.occupiedByRoute) return 'r';
    return 'w';
}

function tileSignature(tile) {
    let s = '';
    for (let i = 0; i < 4; i++) {
        s += getVertexSymbol(vertexByIndex.get(tile.vertexIndices[i]));
    }
    return s;
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(),
      tmpC = new THREE.Vector3(), tmpD = new THREE.Vector3();

// One Object3D per tile; reused (just swap the asset child) when its
// signature changes. Skipped tiles have no entry.
const tileObjects = new Map();   // tile.id -> THREE.Object3D
let lastSigByTileId = new Map(); // tile.id -> last signature placed

// Bilinear deformation (clean skew): map every vertex of the atlas asset
// (local 30×30×30 box, origin at bottom centre) into the cell's skewed
// prism. The asset's bottom-corner verts land exactly on the quad's 4
// vertices at their real elevations; the asset's top is a translated
// copy of the bottom, offset by `ly * elevScale` in world Y. So the
// asset preserves its local height profile and simply rides the slope —
// no vertical stretching, no flat top added on max(corner.y).
//
//   local (lx, ly, lz) ∈ [-15, +15] × [0, 30] × [-15, +15]
//   s = (lx + 15) / 30          → [0,1] across the cell footprint X
//   t = (lz + 15) / 30          → [0,1] across the cell footprint Z
//   bottomP(s,t) = bilinear blend of the 4 corner positions in world space
//   final.xz = bottomP.xz
//   final.y  = bottomP.y + ly * elevScale
function placeTileAsset(tile, sig) {
    const node = atlasNodes && atlasNodes.get(sig);
    if (!node) {
        // Pattern absent from atlas (e.g. user hasn't modelled it). Clear
        // any previous content for this tile so stale assets don't linger.
        const obj = tileObjects.get(tile.id);
        if (obj) {
            for (const c of obj.children) c.geometry?.dispose();
            tilesGroup.remove(obj);
            tileObjects.delete(tile.id);
        }
        disposeTileEdges(tile.id);
        disposeTileReflection(tile.id);
        return;
    }

    // Pull the four corners in world space. The JSON's vertexIndices order
    // is a LABEL convention — [TL, TR, BR, BL] — not a geometric winding,
    // and we use it directly so the asset's local axes match the cell's
    // labels (matches 17_presentation.js in the 2D sim, which also reads
    // tileVertices[0..3] as tl/tr/br/bl with no reorder).
    //
    // Do NOT apply ensureCCWFromAbove-style swapping here. The topo builder
    // does that swap because its hard-coded triangulation needs face winding
    // flipped to produce upward normals; for the bilinear deformation the
    // asset's mesh keeps its own consistent winding, and any winding flip on
    // the corners would mirror the asset across the TL-BR diagonal — what
    // shows up visually as a 180° rotation on symmetric assets and an
    // outright mirror on asymmetric ones (e.g. roads, oriented buildings).
    const v0 = vertexByIndex.get(tile.vertexIndices[0]);
    const v1 = vertexByIndex.get(tile.vertexIndices[1]);
    const v2 = vertexByIndex.get(tile.vertexIndices[2]);
    const v3 = vertexByIndex.get(tile.vertexIndices[3]);
    if (!v0 || !v1 || !v2 || !v3) return;
    // Fully-submerged tiles get no asset at all. The water plane covers
    // the surface and the mirrored reflection lives just beneath it; an
    // underwater 'w' ground would otherwise block the reflection from
    // the camera's view through the translucent water.
    const _wL = window.waterLevel;
    if (v0.elevation <= _wL && v1.elevation <= _wL && v2.elevation <= _wL && v3.elevation <= _wL) {
        const obj = tileObjects.get(tile.id);
        if (obj) {
            for (const c of obj.children) c.geometry?.dispose();
            tilesGroup.remove(obj);
            tileObjects.delete(tile.id);
        }
        disposeTileEdges(tile.id);
        disposeTileReflection(tile.id);
        return;
    }
    const c0 = worldVec3(v0).clone();
    const c1 = worldVec3(v1).clone();
    const c2 = worldVec3(v2).clone();
    const c3 = worldVec3(v3).clone();
    // Lift each corner a hair above the topo so the asset's ground tris
    // don't z-fight with the topo mesh. ~0.3 world units on a topo whose
    // tile cells are ~16 hex-pixels wide is invisible from any angle.
    const TILE_LIFT = 0.3;
    c0.y += TILE_LIFT; c1.y += TILE_LIFT; c2.y += TILE_LIFT; c3.y += TILE_LIFT;

    // Reuse the host group if this tile already had one; dispose the old
    // deformed geometries to keep memory in check across re-syncs.
    let host = tileObjects.get(tile.id);
    if (!host) {
        host = new THREE.Group();
        host.userData.tile = tile;   // back-pointer for inspect-mode picking
        tilesGroup.add(host);
        tileObjects.set(tile.id, host);
    } else {
        while (host.children.length) {
            const c = host.children[host.children.length - 1];
            host.remove(c);
            c.geometry?.dispose();
        }
    }
    // The host stays at world origin — every vertex of the deformed mesh
    // is already in world coordinates after the deformation below.
    host.position.set(0, 0, 0);
    host.rotation.set(0, 0, 0);
    host.scale.setScalar(1);

    // The atlas node's children are Meshes whose `geometry.attributes.position`
    // are in raw asset-local space (build_3d_atlas.py baked any rotations/
    // mirrors into the verts; the parent's grid-offset translation lives on
    // the transform, not in the buffer — so we read positions directly).
    node.traverse((child) => {
        if (!child.isMesh) return;
        // Drop the per-asset 'water' surface mesh. It's the opaque block
        // sitting just under the water plane; without removing it the
        // reflection copies (mirrored below the water) would be hidden
        // behind it. The translucent waterMesh is the only thing we want
        // to see at water level — the reflection lives directly beneath.
        if (child.material && child.material.color
            && child.material.color.getHexString() === _WATER_COLOR_HEX) return;
        const srcPos = child.geometry.getAttribute('position');
        const srcIdx = child.geometry.getIndex();
        const N = srcPos.count;
        const out = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const lx = srcPos.getX(i);
            const ly = srcPos.getY(i);
            const lz = srcPos.getZ(i);
            const s = (lx + ASSET_HALF) / (ASSET_HALF * 2);
            const t = (lz + ASSET_HALF) / (ASSET_HALF * 2);
            const w00 = (1 - s) * (1 - t);
            const w10 =      s  * (1 - t);
            const w11 =      s  *      t;
            const w01 = (1 - s) *      t;
            const bx = w00*c0.x + w10*c1.x + w11*c2.x + w01*c3.x;
            const by = w00*c0.y + w10*c1.y + w11*c2.y + w01*c3.y;
            const bz = w00*c0.z + w10*c1.z + w11*c2.z + w01*c3.z;
            out[i*3]     = bx;
            out[i*3 + 1] = by + ly * elevScale;
            out[i*3 + 2] = bz;
        }
        const matName  = ((child.material && child.material.name) || '').toLowerCase();
        const isGround = matName === 'w';
        // One-time log of every distinct material name we see, so the
        // user can sanity-check that the ground really is named 'w'.
        window.__seenAtlasMats = window.__seenAtlasMats || new Set();
        if (!window.__seenAtlasMats.has(matName)) {
            window.__seenAtlasMats.add(matName);
            console.log('atlas material:', JSON.stringify(matName), isGround ? '(ground — winding fixed + fully smoothed)' : '(only bottom smoothed)');
        }

        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
        if (srcIdx) g.setIndex(srcIdx.clone());

        // Flip winding on every triangle whose geometric face points DOWN.
        // For ground meshes, all triangles. For non-ground meshes, only the
        // ground-band triangles (where every vertex has ly < 0.5) — wall
        // and roof tris are allowed to face down genuinely (a roof's
        // underside does, and we want the back-face shading to apply
        // correctly there).
        // Why this matters: a down-facing geometric triangle, viewed from
        // above through a DoubleSide material, is rendered as a back-face;
        // the shader flips its vertex normal for lighting; our smoothed
        // up-pointing normal becomes down → unlit → black patch.
        let flipped = 0, scanned = 0;
        if (srcIdx) {
            const idxArr = g.getIndex().array;
            const GROUND_LY_FLIP = 0.5;
            for (let ti = 0; ti < idxArr.length; ti += 3) {
                const a = idxArr[ti];
                const b = idxArr[ti + 1];
                const c = idxArr[ti + 2];
                if (!isGround) {
                    const lyA = srcPos.getY(a);
                    const lyB = srcPos.getY(b);
                    const lyC = srcPos.getY(c);
                    if (lyA > GROUND_LY_FLIP || lyB > GROUND_LY_FLIP || lyC > GROUND_LY_FLIP) continue;
                }
                const ax = out[a*3],     az = out[a*3 + 2];
                const bx = out[b*3],     bz = out[b*3 + 2];
                const cx = out[c*3],     cz = out[c*3 + 2];
                // Y of (b-a)×(c-a). Negative = face points down.
                const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
                scanned++;
                if (ny < 0) {
                    idxArr[ti + 1] = c;
                    idxArr[ti + 2] = b;
                    flipped++;
                }
            }
            g.getIndex().needsUpdate = true;
        }
        if (!window.__windingStats) {
            window.__windingStats = { total: 0, flipped: 0, scanned: 0 };
        }
        window.__windingStats.total++;
        window.__windingStats.flipped += flipped;
        window.__windingStats.scanned += scanned;

        g.computeVertexNormals();

        // Terrain-smoothing filter. The ground mesh's per-cell normals
        // (after the winding fix above) already point up, but each tile
        // computes its own — adjacent cells disagree at shared edges. We
        // override every ground-mesh vertex normal with a bilinear blend
        // of the cell's 4 corner topo normals; corners are shared with
        // neighbours, so adjacent tiles agree along edges → no seam.
        if (topoSmoothNormals) {

            const i0 = tile.vertexIndices[0];
            const i1 = tile.vertexIndices[1];
            const i2 = tile.vertexIndices[2];
            const i3 = tile.vertexIndices[3];
            const n0x = topoSmoothNormals[i0*3], n0y = topoSmoothNormals[i0*3+1], n0z = topoSmoothNormals[i0*3+2];
            const n1x = topoSmoothNormals[i1*3], n1y = topoSmoothNormals[i1*3+1], n1z = topoSmoothNormals[i1*3+2];
            const n2x = topoSmoothNormals[i2*3], n2y = topoSmoothNormals[i2*3+1], n2z = topoSmoothNormals[i2*3+2];
            const n3x = topoSmoothNormals[i3*3], n3y = topoSmoothNormals[i3*3+1], n3z = topoSmoothNormals[i3*3+2];
            const normAttr = g.getAttribute('normal');
            // Ground mesh: smooth ALL vertices regardless of local Y.
            // Non-ground mesh: smooth only the bottom band.
            const groundLy = isGround ? Infinity : 0.5;
            for (let i = 0; i < N; i++) {
                const ly = srcPos.getY(i);
                if (ly > groundLy) continue;
                const lx = srcPos.getX(i);
                const lz = srcPos.getZ(i);
                const s = (lx + ASSET_HALF) / (ASSET_HALF * 2);
                const t = (lz + ASSET_HALF) / (ASSET_HALF * 2);
                const w00 = (1 - s) * (1 - t);
                const w10 =      s  * (1 - t);
                const w11 =      s  *      t;
                const w01 = (1 - s) *      t;
                let nx = w00*n0x + w10*n1x + w11*n2x + w01*n3x;
                let ny = w00*n0y + w10*n1y + w11*n2y + w01*n3y;
                let nz = w00*n0z + w10*n1z + w11*n2z + w01*n3z;
                const len = Math.hypot(nx, ny, nz);
                if (len > 1e-9) { nx /= len; ny /= len; nz /= len; }
                normAttr.setXYZ(i, nx, ny, nz);
            }
            normAttr.needsUpdate = true;
        }

        const tileMesh = new THREE.Mesh(g, child.material);
        tileMesh.castShadow    = true;
        tileMesh.receiveShadow = true;
        host.add(tileMesh);
        if (monoEnabled) _applyMono(tileMesh);
    });
    // Cached edges (if any) are for the previous mesh set — replace them
    // now while we still know which tile id they belonged to. Cheap when
    // the overlay is off (placeTileEdges no-ops in that case).
    placeTileEdges(tile.id, host);
    // Same pattern for the mirrored reflection copy below the water.
    placeTileReflection(tile.id, host);
}

function syncTiles() {
    if (!atlasNodes) return { placed: 0, missing: 0 };
    let placed = 0, missing = 0;
    for (const tile of tiles) {
        const sig = tileSignature(tile);
        if (lastSigByTileId.get(tile.id) === sig) continue;
        lastSigByTileId.set(tile.id, sig);
        placeTileAsset(tile, sig);
        if (atlasNodes.has(sig)) placed++; else missing++;
    }
    return { placed, missing };
}

// ======================================================================
// Main init
// ======================================================================
async function init(topoUrl) {
    topoUrl = topoUrl || 'topo_json/large_rome.json';
    setStatus('fetching ' + topoUrl + ' ...');
    let json;
    try {
        json = await fetch(topoUrl).then(r => {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        });
    } catch (e) {
        setStatus('<b class="bad">fetch failed:</b> ' + e.message
            + '. serve via http (e.g. <code>python -m http.server</code>)');
        throw e;
    }

    // Center the world on the centroid of vertex hex coords.
    cx = 0; cz = 0;
    for (const v of json.vertices) { cx += v.hexCoords.x; cz += v.hexCoords.y; }
    cx /= json.vertices.length; cz /= json.vertices.length;

    // Aim the camera at the actual hex center (which the JSON gives us
    // directly — the centroid of relaxed vertices is close but not
    // identical), and pull it in for a tighter framing of the city.
    const hexC = json.mapping.hexCenter;
    const tx = hexC.x - cx;          // hex centre in our centered world space
    const tz = hexC.y - cz;
    controls.target.set(tx, 30, tz);
    // FOV=12, distance ≈ 1800. View radius ≈ 189 — frames the centre
    // of the hex tight rather than the full map. Mouse-wheel out to
    // see the borders.
    camera.position.set(tx + 890, 1050, tz + 1160);
    camera.lookAt(controls.target);
    controls.update();

    // Initialise the simulation.
    initSim(json);

    // Build base scene.
    topoMesh  = buildTopo();
    topoMesh.visible = false;   // tiles cover the topo; topo is debug-only
    scene.add(topoMesh);
    cacheTopoNormals();
    waterMesh = buildWater();  scene.add(waterMesh);
    buildDebugMesh();
    _updateReflectionTransforms();   // anchor the reflection mirror to current waterLevel

    setStatus('loading assets/atlas_3d.glb ...');
    try {
        await loadAtlas();
    } catch (e) {
        setStatus('<b class="bad">atlas load failed:</b> ' + e.message
            + '. continuing without asset rendering.');
        atlasNodes = null;
    }

    // Set up the regional trade route (sets tradeDestination1/2 so
    // newly-spawned merchants automatically route to those endpoints).
    setupRegionalRoute();

    // Initial tile sync — every cell starts as 'wwww' (wilderness), so all
    // 5096 tiles get an asset placed unless the user hasn't modelled wwww.
    // Doing this AFTER setupRegionalRoute means the regional route's
    // occupiedByRoute marks already feed into the per-tile signature.
    if (atlasNodes) {
        const t0 = performance.now();
        const r  = syncTiles();
        const t1 = performance.now();
        console.log(`initial syncTiles: ${(t1 - t0).toFixed(0)} ms, placed ${r?.placed} missing ${r?.missing}`);
    }
    syncRoutes();

    initialized = true;
    // Advanced lighting (day/night cycle, shadows, IBL) is on by default.
    // Calling this BEFORE setupHud so the ✨ button picks up the armed
    // state during its initial bindVisibility sync.
    setAdvancedMode(true);

    // Build the context object exposed to the HUD + render-loop modules
    // (sim/hud.js, sim/render_loop.js). Direct refs for constants and
    // mutable objects; getter/setter pairs for mutable primitives so the
    // other modules can read live values and write back through main.js.
    const app = {
        renderer, scene, camera, controls, sun, hemi, ambient, composer,
        waterMesh, topoMesh, tilesGroup, routesGroup,
        lightParams, lightAnchors, lightCycle, tileObjects, lastSigByTileId,
        spawnProbs,
        AUTO_RESTART_FRACTION,
        // sim wiring
        simStepN, syncSettlements, syncRoutes, syncTiles,
        refreshDebugColors, buildCityLights,
        restartSimulation, exportSceneOBJ,
        _updateReflectionTransforms, rebuildGeometryAfterElevChange,
        clearAllTileEdges, clearAllTileReflections,
        applyLightParams, setAdvancedMode, setDemoMode,
        setDebugLayer,
        setEdgesEnabled, setMonoEnabled, setReflectionsEnabled,
        clearInspectOverlay,
        updateSunPosition, applyPhaseLighting,
        tickDemoMode, _tickWater,
        recomputeCenter,
        // mutable primitives via accessors
        get elevScale()             { return elevScale; },
        set elevScale(v)            { elevScale = v; },
        get waterLevel()            { return waterLevel; },
        set waterLevel(v)           { waterLevel = v; },
        get mouseMode()             { return mouseMode; },
        set mouseMode(v)            { mouseMode = v; },
        get pendingRoadStart()      { return pendingRoadStart; },
        set pendingRoadStart(v)     { pendingRoadStart = v; },
        get autoRestartEnabled()    { return autoRestartEnabled; },
        set autoRestartEnabled(v)   { autoRestartEnabled = v; },
        get initialHabitableCount() { return initialHabitableCount; },
        set initialHabitableCount(v){ initialHabitableCount = v; },
        get monoEnabled()           { return monoEnabled; },
        get reflEnabled()           { return reflEnabled; },
        get edgesEnabled()          { return edgesEnabled; },
        get demoMode()              { return demoMode; },
        get advancedMode()          { return advancedMode; },
        get hoverMarker()           { return hoverMarker; },
    };
    window.setupHud(app);
    window.startRenderLoop(app);
}

// Recompute the world-space hex centre from the current vertex set. Used
// after loading a save to re-centre the scene on the loaded city.
function recomputeCenter() {
    cx = 0; cz = 0;
    for (const v of vertices) { cx += v.hexX; cz += v.hexY; }
    cx /= vertices.length; cz /= vertices.length;
}

// ======================================================================
// 3D-model export. Writes an Wavefront OBJ (+ companion MTL) of every
// visible tile mesh, plus topo / water if they're on. OBJ is the one
// portable format that opens cleanly in Blender, Unreal, Unity, SketchUp,
// and the common 3D-print slicers (Cura, PrusaSlicer, Bambu, Orca).
//
// Coords: world-space Y-up (three.js native). Each importer can re-axis
// on import; Blender's OBJ importer has an explicit axis dropdown.
// Materials: emits Kd/Ka/Ks/d per material. Skips textures — the atlas
// is colour-only.
// ======================================================================
function exportSceneOBJ() {
    const objLines = ['# city export — wavefront OBJ', 'mtllib city.mtl'];
    const mtlLines = ['# city export — materials (Kd colour only)'];
    const matNameByRef = new Map();   // material ref → unique sanitised name

    let vOffset = 1;   // OBJ indices are 1-based
    const _v = new THREE.Vector3();
    const _nm = new THREE.Matrix3();
    let meshCount = 0;
    let triCount  = 0;

    const sanitize = (s) => (s || 'mat').replace(/[^A-Za-z0-9_-]/g, '_');

    const recordMaterial = (mat) => {
        if (matNameByRef.has(mat)) return matNameByRef.get(mat);
        let base = sanitize(mat.name || `mat_${matNameByRef.size}`);
        let name = base, i = 1;
        const used = new Set(matNameByRef.values());
        while (used.has(name)) name = `${base}_${i++}`;
        matNameByRef.set(mat, name);
        const c = mat.color || new THREE.Color(0xcccccc);
        const op = (mat.opacity != null) ? mat.opacity : 1;
        mtlLines.push('', `newmtl ${name}`,
                      `Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`,
                      `Ka 0 0 0`, `Ks 0 0 0`, `d ${op.toFixed(4)}`, `illum 1`);
        return name;
    };

    const collectMesh = (mesh) => {
        if (!mesh.isMesh || !mesh.geometry) return;
        // Respect visibility — walk up the parent chain to honour group toggles.
        let cur = mesh;
        while (cur) { if (cur.visible === false) return; cur = cur.parent; }
        const g = mesh.geometry;
        const pos = g.getAttribute('position');
        const norm = g.getAttribute('normal');
        if (!pos) return;

        mesh.updateWorldMatrix(true, false);
        const wm = mesh.matrixWorld;
        _nm.getNormalMatrix(wm);

        for (let i = 0; i < pos.count; i++) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(wm);
            objLines.push(`v ${_v.x.toFixed(6)} ${_v.y.toFixed(6)} ${_v.z.toFixed(6)}`);
        }
        const hasN = !!norm;
        if (hasN) {
            for (let i = 0; i < norm.count; i++) {
                _v.fromBufferAttribute(norm, i).applyMatrix3(_nm);
                const len = Math.hypot(_v.x, _v.y, _v.z) || 1;
                objLines.push(`vn ${(_v.x/len).toFixed(6)} ${(_v.y/len).toFixed(6)} ${(_v.z/len).toFixed(6)}`);
            }
        }

        // Use the original (pre-mono) material so the export keeps colours
        // even with monochrome mode on.
        const mat = mesh.userData._origMat || mesh.material;
        const matName = recordMaterial(mat);
        objLines.push(`g mesh_${meshCount}`);
        objLines.push(`usemtl ${matName}`);

        const writeFace = (a, b, c) => {
            const A = a + vOffset, B = b + vOffset, C = c + vOffset;
            objLines.push(hasN
                ? `f ${A}//${A} ${B}//${B} ${C}//${C}`
                : `f ${A} ${B} ${C}`);
            triCount++;
        };
        const idx = g.getIndex();
        if (idx) {
            const ia = idx.array;
            for (let i = 0; i < ia.length; i += 3) writeFace(ia[i], ia[i+1], ia[i+2]);
        } else {
            for (let i = 0; i < pos.count; i += 3) writeFace(i, i+1, i+2);
        }
        vOffset += pos.count;
        meshCount++;
    };

    tilesGroup.traverse(collectMesh);
    if (topoMesh)  collectMesh(topoMesh);
    if (waterMesh) collectMesh(waterMesh);

    const download = (text, filename) => {
        const blob = new Blob([text], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a);
        a.click(); a.remove();
        URL.revokeObjectURL(url);
    };
    download(objLines.join('\n'), 'city.obj');
    download(mtlLines.join('\n'), 'city.mtl');
    console.log(`[export] ${meshCount} meshes, ${triCount} triangles, ${matNameByRef.size} materials → city.obj + city.mtl`);
}

// ======================================================================
// Geometry rebuild after elevation / water-level / save-load
// ======================================================================
function rebuildGeometryAfterElevChange() {
    if (topoMesh) {
        topoMesh.geometry.dispose();
        const m = topoMesh.material; scene.remove(topoMesh);
        topoMesh = buildTopo(); topoMesh.material = m; scene.add(topoMesh);
        cacheTopoNormals();
    }
    if (waterMesh) waterMesh.position.y = waterLevel * elevScale;
    // Reposition all settlement markers, routes, debug overlay, and tile assets.
    syncSettlements();
    syncRoutes();
    buildDebugMesh();
    lastSigByTileId.clear();
    for (const obj of tileObjects.values()) tilesGroup.remove(obj);
    tileObjects.clear();
    clearAllTileEdges();        // tile geometry rebuilt below
    clearAllTileReflections();
    _updateReflectionTransforms();
    syncTiles();
    buildCityLights();
}

// ======================================================================
// Advanced lighting toggle
// On  → shadow map + PMREM env + ACES tone mapping + SSAO post-pass.
//        Best visual quality, ~2-4× the GPU cost. Real-time only on
//        modern hardware; expect framerate drops with all 5096 tiles.
// Off → flat ambient + sun, no shadows, direct render. Cheap, fast.
// ======================================================================
let advancedMode = false;
let _shadowHelper = null;

// Lighting parameters — sliders in the HUD bind to these. setAdvancedMode
// resets them to mode-appropriate defaults; you can then tune from there.
const lightParams = {
    exposure:        1.74,
    envIntensity:    0.01,
    sun:             5.20,
    ambient:         0.86,
    shadowRadius:    1.5,
    shadowIntensity: 0.9,
    shadowBias:      -0.0008,
    sunAzimuth:      0,      // degrees; advances every frame in advanced mode
    sunAltitude:     25,
    rotationSpeed:   1.0,    // degrees per frame; 0 = paused
};

// Anchor colours for the day/night cycle. The phase function blends these
// based on the sun's azimuth: 150° day + 30° dusk + 150° night + 30° dawn = 360°.
// Editable from the lighting panel via colour pickers.
const lightAnchors = {
    daySun:    new THREE.Color(0xfff1d6),   // pale warm cream
    duskSun:   new THREE.Color(0xffd4b0),   // peach / soft salmon
    nightSun:  new THREE.Color(0x888888),   // middle grey — keeps the city legible at night
    dayEnv:    new THREE.Color(0xa6dcef),   // light sky blue
    duskEnv:   new THREE.Color(0x3879dc),   // saturated mid blue
    nightEnv:  new THREE.Color(0x1228a4),   // deep royal blue
};
const lightCycle = {
    sunIntensityDay:    1.00,
    sunIntensityDusk:   0.65,
    sunIntensityNight:  0.18,
    // Hemi is the cool sky-tint fill on upward-facing surfaces. Kept
    // modest so the dominant sun reads as the dominant light source —
    // pumping hemi up just flattens the whole map regardless of what
    // the sun is doing.
    hemiIntensityDay:   0.35,
    hemiIntensityDusk:  0.30,
    hemiIntensityNight: 0.20,
    nightLightsPeak:    1.00,   // city-lights overlay opacity at full night
    nightLightsTwilightPeak: 0.50,
    cityLightsBrightness: 2.4,   // HDR multiplier on the additive city-lights mesh
};

// Phase weights at a given azimuth. Always sums to 1.
//   0..210   day        (210°)
//   210..240 dusk       (30°)  day→twilight→night
//   240..330 night      (90°)
//   330..360 dawn       (30°)  night→twilight→day
function computePhase(azimuthDeg) {
    const a = ((azimuthDeg % 360) + 360) % 360;
    let dayW = 0, nightW = 0, twilightW = 0;
    if (a < 210) {
        dayW = 1;
    } else if (a < 240) {
        const t = (a - 210) / 30;
        if (t < 0.5) { const u = t * 2; dayW = 1 - u; twilightW = u; }
        else         { const u = (t - 0.5) * 2; twilightW = 1 - u; nightW = u; }
    } else if (a < 330) {
        nightW = 1;
    } else {
        const t = (a - 330) / 30;
        if (t < 0.5) { const u = t * 2; nightW = 1 - u; twilightW = u; }
        else         { const u = (t - 0.5) * 2; twilightW = 1 - u; dayW = u; }
    }
    return { dayW, nightW, twilightW };
}

const _tmpC = new THREE.Color();
function blendAnchors(target, day, dusk, night, w) {
    target.setRGB(0, 0, 0);
    _tmpC.copy(day).multiplyScalar(w.dayW);       target.add(_tmpC);
    _tmpC.copy(dusk).multiplyScalar(w.twilightW); target.add(_tmpC);
    _tmpC.copy(night).multiplyScalar(w.nightW);   target.add(_tmpC);
    return target;
}
const SUN_RADIUS = 1200;
function updateSunPosition() {
    const az = lightParams.sunAzimuth * Math.PI / 180;
    const al = lightParams.sunAltitude * Math.PI / 180;
    sun.position.set(
        SUN_RADIUS * Math.cos(al) * Math.sin(az),
        SUN_RADIUS * Math.sin(al),
        SUN_RADIUS * Math.cos(al) * Math.cos(az),
    );
    sun.target.updateMatrixWorld();
    // shadowFill rides along with the sun so the two directional
    // contributions cancel correctly on lit fragments.
    shadowFill.position.copy(sun.position);
    shadowFill.target.position.copy(sun.target.position);
    shadowFill.target.updateMatrixWorld();
    // In day mode, the shadow map needs to rebuild every frame because the
    // sun moves; otherwise we leave it on the static cache.
    if (advancedMode && renderer.shadowMap.autoUpdate === false) {
        renderer.shadowMap.needsUpdate = true;
    }
}

function applyLightParams() {
    updateSunPosition();
    // sun.shadow.intensity would be the proper knob but it's r166+; we
    // emulate it by splitting the directional light's intensity between
    // a shadow-caster and a non-shadow-caster — see applyPhaseLighting.
    renderer.toneMappingExposure = lightParams.exposure;
    // Env: gate scene.environment + drive contribution via per-material
    // envMapIntensity. This is more reliable than scene.environmentIntensity
    // which can be effectively binary on some material/render-path combos.
    scene.environment = (advancedMode && lightParams.envIntensity > 0) ? ENV_MAP : null;
    scene.environmentIntensity = 1.0;   // keep neutral; per-material does the scaling
    scene.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
            if ('envMapIntensity' in m) m.envMapIntensity = lightParams.envIntensity;
        }
    });
    sun.intensity                = lightParams.sun;
    ambient.intensity            = lightParams.ambient;
    sun.shadow.radius            = lightParams.shadowRadius;
    sun.shadow.bias              = lightParams.shadowBias;
    if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
}

function setAdvancedMode(on) {
    advancedMode = !!on;
    renderer.shadowMap.enabled = advancedMode;
    // When the sun rotates, the shadow direction changes every frame, so
    // we let three.js redraw the shadow map every frame. When rotationSpeed
    // is 0 (cycle paused), shadows can be cached.
    renderer.shadowMap.autoUpdate = advancedMode && lightParams.rotationSpeed > 0;
    if (advancedMode) renderer.shadowMap.needsUpdate = true;
    if (advancedMode) {
        // SDR palette — authored colors should ride at ~1:1. Linear tone
        // mapping passes them through unchanged until they clip; ACES
        // rolled off highlights and desaturated mids toward filmic gray,
        // which washed the painted SketchUp palette. Keep scene.environment
        // off by default — Hemi provides the cool sky tint, and the bright
        // RoomEnvironment was raising the floor on every face. envIntensity
        // is still a slider if the user wants it back.
        scene.environment       = null;
        renderer.toneMapping    = THREE.LinearToneMapping;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        Object.assign(lightParams, {
            // Dominant sun + quiet ambient = real outdoor contrast. With
            // ambient at 0.4 the shadow side was only ~0.5 below the lit
            // side; cutting ambient to 0.10 widens the lit/shadow gap to
            // roughly 4:1 on a sky-facing Lambert face. Hemi day intensity
            // (in lightCycle below) was likewise dialled down so the top
            // fill doesn't flatten the whole map.
            exposure: 1.0, envIntensity: 0.0, sun: 4.0, ambient: 0.10,
            shadowRadius: 1.5, sunAltitude: 25, rotationSpeed: 1.0,
            // Don't reset sunAzimuth — keep wherever the cycle was when last left.
        });
    } else {
        scene.environment       = null;
        renderer.toneMapping    = THREE.NoToneMapping;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        Object.assign(lightParams, {
            exposure: 1.0, envIntensity: 1.0, sun: 1.0, ambient: 0.4,
            shadowRadius: 1.5, sunAzimuth: 60, sunAltitude: 55,
            rotationSpeed: 0,
        });
        // Park the cycle: white sun, no hemi, no city lights, no shadow fill.
        sun.color.setRGB(1.0, 0.93, 0.86);
        hemi.color.setRGB(0.69, 0.85, 1.0);
        hemi.groundColor.setRGB(0.13, 0.13, 0.20);
        hemi.intensity = 0;
        shadowFill.intensity = 0;
        if (cityLightsGroup.children.length) {
            cityLightsGroup.children[0].material.opacity = 0;
            cityLightsGroup.children[0].visible = false;
        }
    }
    applyLightParams();
    if (advancedMode) applyPhaseLighting();
    if (typeof window.__hudSyncLighting === 'function') window.__hudSyncLighting();
    // Toggling shadowMap.enabled requires shaders to recompile.
    scene.traverse((o) => {
        if (o.isMesh && o.material) {
            if (Array.isArray(o.material)) o.material.forEach((m) => (m.needsUpdate = true));
            else                            o.material.needsUpdate = true;
        }
    });
}

// Apply the day/night-cycle lighting. Reads the current azimuth, blends
// sun and env anchor colours by phase, sets sun + hemi intensities,
// drives the city-lights overlay opacity. Cheap (~6 colour ops + a few
// scalar lerps) — safe to call every frame.
const _sunCol = new THREE.Color();
const _envCol = new THREE.Color();
const _grdCol = new THREE.Color();
function applyPhaseLighting() {
    const w = computePhase(lightParams.sunAzimuth);
    blendAnchors(_sunCol, lightAnchors.daySun, lightAnchors.duskSun, lightAnchors.nightSun, w);
    blendAnchors(_envCol, lightAnchors.dayEnv, lightAnchors.duskEnv, lightAnchors.nightEnv, w);
    sun.color.copy(_sunCol);
    shadowFill.color.copy(_sunCol);
    hemi.color.copy(_envCol);
    // Ground tint = a darker version of the sky tint so the hemi reads as
    // sky-colour above, dim earth-colour below.
    _grdCol.copy(_envCol).multiplyScalar(0.18);
    hemi.groundColor.copy(_grdCol);

    const sunPhaseI = w.dayW * lightCycle.sunIntensityDay
                    + w.twilightW * lightCycle.sunIntensityDusk
                    + w.nightW * lightCycle.sunIntensityNight;
    const totalI    = lightParams.sun * sunPhaseI;
    const shadowF   = Math.max(0, Math.min(1, lightParams.shadowIntensity));
    // Split the directional light into a shadow-casting half and a
    // non-shadow-casting half. shadowF=1 → all goes through the
    // shadow-caster (full pitch-black shadow). shadowF=0 → all goes
    // through the fill (no visible shadow).
    sun.intensity        = totalI * shadowF;
    shadowFill.intensity = totalI * (1 - shadowF);

    hemi.intensity = w.dayW * lightCycle.hemiIntensityDay
                   + w.twilightW * lightCycle.hemiIntensityDusk
                   + w.nightW * lightCycle.hemiIntensityNight;

    // City lights ride on the night/twilight weights — only visible after dark.
    const lightsAlpha = w.nightW * lightCycle.nightLightsPeak
                      + w.twilightW * lightCycle.nightLightsTwilightPeak;
    if (cityLightsGroup.children.length) {
        const m = cityLightsGroup.children[0].material;
        m.opacity = lightsAlpha;
        m.color.setRGB(
            lightCycle.cityLightsBrightness,
            lightCycle.cityLightsBrightness,
            lightCycle.cityLightsBrightness,
        );
        cityLightsGroup.children[0].visible = lightsAlpha > 0.005;
    }
}

// Debug: visualise the sun's shadow camera frustum. Call from the JS
// console: `window.toggleShadowHelper()`. If the box doesn't enclose the
// area where you expect shadows, the frustum needs widening.
window.toggleShadowHelper = function () {
    if (_shadowHelper) {
        scene.remove(_shadowHelper);
        _shadowHelper.dispose?.();
        _shadowHelper = null;
        return false;
    }
    _shadowHelper = new THREE.CameraHelper(sun.shadow.camera);
    scene.add(_shadowHelper);
    return true;
};

// Title-screen flow: hold init until the user picks a city. The audio
// element can only start after a user gesture (most browsers block
// autoplay until then), so the same click that picks the city also
// starts the music.
const titleScreen = document.getElementById('titleScreen');
const bgMusic     = document.getElementById('bgMusic');
const bAudio      = document.getElementById('bAudio');
let booted = false;

bgMusic.volume = 0.5;
function setAudioOn(on) {
    if (on) {
        bgMusic.play().catch(() => { /* autoplay blocked — wait for next gesture */ });
        bAudio.textContent = '🔊';
        bAudio.classList.add('armed');
    } else {
        bgMusic.pause();
        bAudio.textContent = '🔇';
        bAudio.classList.remove('armed');
    }
}
bAudio.onclick = () => setAudioOn(bgMusic.paused);

// Camera-orbit toggle. controls.autoRotate is initialised true (above),
// so the button starts armed; clicking flips it. OrbitControls already
// pauses autoRotate while the user is dragging and resumes on release.
const bOrbit = document.getElementById('bOrbit');
function syncOrbitButton() {
    bOrbit.classList.toggle('armed', controls.autoRotate);
}
syncOrbitButton();
bOrbit.onclick = () => { controls.autoRotate = !controls.autoRotate; syncOrbitButton(); };

for (const tile of document.querySelectorAll('.city-tile')) {
    tile.onclick = () => {
        if (booted) return;
        booted = true;
        titleScreen.classList.add('hidden');
        const url = tile.dataset.topo;
        setAudioOn(true);   // user gesture — autoplay is allowed now
        init(url).catch(e => {
            console.error(e);
            booted = false;
            titleScreen.classList.remove('hidden');
        });
    };
}
