// Tiny replacement for p5.js globals used by the simulation files.
// Loaded BEFORE 11/12/13/15/21 so they see these as plain globals.

// --- p5 math helpers used inside sim files ---
window.random = function (a, b) {
    if (a === undefined) return Math.random();
    if (b === undefined) {
        if (Array.isArray(a)) return a[Math.floor(Math.random() * a.length)];
        return Math.random() * a;
    }
    return Math.random() * (b - a) + a;
};
window.floor = Math.floor;
window.ceil = Math.ceil;
window.round = Math.round;
window.sqrt = Math.sqrt;
window.abs = Math.abs;
window.min = Math.min;
window.max = Math.max;
window.dist = function (x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
};
window.atan2 = Math.atan2;
window.constrain = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
window.lerp = (a, b, t) => a + (b - a) * t;
window.map = (v, s1, e1, s2, e2) => s2 + ((v - s1) * (e2 - s2)) / (e1 - s1);
window.PI = Math.PI;
window.TWO_PI = 2 * Math.PI;
window.HALF_PI = Math.PI / 2;
window.RGB = "RGB";
window.HSB = "HSB";

// --- DOM shim that mimics p5's select() return value ---
window.select = function (selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    return {
        elt: el,
        value: () => el.value,
        checked: () => el.checked,
        html: (s) => {
            if (s !== undefined) el.innerHTML = s;
            return el.innerHTML;
        },
        style: (k, v) => { if (v !== undefined) el.style[k] = v; },
        addClass: (c) => el.classList.add(c),
        removeClass: (c) => el.classList.remove(c),
        hasClass: (c) => el.classList.contains(c),
    };
};

// --- Render-coupling callbacks the sim emits. Replace with no-ops; the 3D
//     renderer reads sim state directly each frame, so it doesn't need to
//     be told about per-vertex changes. The sim files all guard these with
//     `typeof X !== "undefined"`, so leaving them as no-ops here keeps the
//     guards happy without touching the sim code. ---
window.profStart = () => 0;
window.profEnd = () => 0;
window.redraw = () => {};
window.updateProgress = (msg) => { /* console.log("[sim]", msg); */ };
window.invalidateBuffers = () => {};

// Reference 10_sketch.js defines this global wrapper around the per-vertex
// method; pathfinding calls it after each route to refresh edge costs with
// new traffic counts. Mirror that here.
window.calculateMovementCosts = function () {
    for (const v of vertices) {
        v.calculateMovementCosts(modeChangeCost, waterTransportFactor);
    }
};
// Deliberately NOT defining redrawVertexQuads / presentationBuffer / patternAtlas
// — the pathfinding code skips its presentation update if those are undefined.

// --- Mutable global state the sim files read/write across files ---
window.topoData            = null;
window.vertices            = [];
window.vertexByIndex       = new Map();
window.tiles               = [];
window.edgeVertices        = [];
window.routes              = [];
window.settlements         = [];
window.castleVertices      = [];
window.habitable           = [];
window.farmerVertexIndices = new Set();
window.tradeDestination1   = null;
window.tradeDestination2   = null;
window.simulationStep      = 0;

// --- Tunables matching the reference UI defaults ---
window.waterLevel              = 14;
window.UnhabitableLevel        = 120;
window.modeChangeCost          = 50;
window.waterTransportFactor    = 1.0;
window.FARM_ELEVATION_THRESHOLD = 80;

// --- p5 width/height; populated from the loaded mapping at bootstrap. ---
window.width  = 0;
window.height = 0;

// --- Stubs that 21_saveLoad.js reads at save time. The reference uses these
//     to remember which city/scene the user was in; we don't have a multi-
//     city UI, so neutral defaults are fine. ---
window.appState    = 'simulation';
window.currentCity = 'rome';
