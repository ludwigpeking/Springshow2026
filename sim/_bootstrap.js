// Bootstrap the simulation from a loaded topology JSON.
// Replicates the load path in 2511_Hexagonal_World/10_sketch.js — converts
// raw JSON vertices to Vertex instances, builds vertexByIndex, populates
// surroundingTiles, finds edge vertices, and seeds derived simulation
// values. Pure logic; no rendering.

window.initSim = function initSim(json) {
    topoData = json;

    const scale     = json.mapping.scale;
    const offsetX   = json.mapping.offsetX || 0;
    const offsetY   = json.mapping.offsetY || 0;
    const mppp      = json.mapping.metersPerCanvasPixel;
    width  = json.mapping.canvasWidth;
    height = json.mapping.canvasHeight;

    // 1. Wrap raw vertices in Vertex instances; replace topoData.vertices
    //    so the sim's `topoData.vertices.forEach(...)` resets see real Vertex objects.
    vertices = json.vertices.map((v) => new Vertex(v, scale, mppp));
    topoData.vertices = vertices;
    vertexByIndex = new Map();
    for (const v of vertices) vertexByIndex.set(v.index, v);

    // 2. Filter out steep neighbors (> 18% slope) — matches reference behaviour.
    vertices.forEach((v) => {
        v.neighbors = v.neighbors.filter((n) => Math.abs(n.slope) <= 0.18);
    });

    // 3. Tile centers in canvas pixels (the sim references centerX/centerY directly).
    tiles = json.tiles;
    tiles.forEach((tile) => {
        if (tile.center) {
            tile.centerX = tile.center.x * scale + offsetX;
            tile.centerY = tile.center.y * scale + offsetY;
        }
    });
    topoData.tiles = tiles;

    // 4. Initial water + habitability flags (later toggled via setWaterStatus / UnhabitableLevel sliders).
    vertices.forEach((v) => v.setWaterStatus(waterLevel));
    vertices.forEach((v) => {
        if (v.elevation > UnhabitableLevel) v.habitable = false;
    });

    // 5. surroundingTiles per vertex, sorted by angle around the vertex
    //    (used by settlement-vicinity propagation and visualisation).
    tiles.forEach((tile) => {
        tile.vertexIndices.forEach((vi) => {
            const v = vertexByIndex.get(vi);
            if (v && tile.centerX !== undefined && tile.centerY !== undefined) {
                v.surroundingTiles.push({
                    centerX: tile.centerX,
                    centerY: tile.centerY,
                    tile: tile,
                });
            }
        });
    });
    vertices.forEach((v) => {
        if (v.surroundingTiles.length > 0) {
            v.surroundingTiles.sort((a, b) => {
                const angA = Math.atan2(a.centerY - v.y, a.centerX - v.x);
                const angB = Math.atan2(b.centerY - v.y, b.centerX - v.x);
                return angA - angB;
            });
        }
    });

    // 6. Edge vertices = those near the hexBounds rectangle; used as random
    //    pathfinding endpoints for trade routes.
    edgeVertices = [];
    const bounds = json.mapping.hexBounds;
    const threshold = 10;
    vertices.forEach((v) => {
        if (
            Math.abs(v.hexX - bounds.minX) < threshold ||
            Math.abs(v.hexX - bounds.maxX) < threshold ||
            Math.abs(v.hexY - bounds.minY) < threshold ||
            Math.abs(v.hexY - bounds.maxY) < threshold
        ) {
            edgeVertices.push(v);
        }
    });

    // 7. Cache movement costs per neighbor edge (cheap, used by A*).
    vertices.forEach((v) => v.calculateMovementCosts(modeChangeCost, waterTransportFactor));

    // 8. Seed derived simulation values (defense/farm/etc.) so the first
    //    autoPopulate step sees populated arrays rather than zeros.
    if (typeof initializeSimulationValues === "function") {
        initializeSimulationValues();
    }
};
