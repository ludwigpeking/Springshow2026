// Simulation-related global variables
let settlements = [];
let settlementNr = 0;
let castleVertices = [];
let habitable = [];
let minBuffer = 5;
let professions = ["Lord", "Farmer", "Merchant"];
let farmerRange = 50; // in canvas pixels
let waterAccessDist = 200; // in canvas pixels
let FARM_ELEVATION_THRESHOLD = 150; // Elevation above which farming is not viable
let MIDDLE_RANGE = 200; // Movement cost budget for farmer value calculation (far influence)
let SHORT_RANGE  = 70;  // Movement cost budget for vicinity calculation (close influence)
let vertexQuadtree = null; // Quadtree for spatial queries
let farmerVertexIndices = new Set(); // Vertex indices currently occupied by Farmer settlements
// Note: tradeDestination1 and tradeDestination2 are defined in sketch.js

// Value system
// Lord: defense (from terrain); considers traffic
// Farmer: security, farm value
// Merchant: security, traffic

class Settlement {
    constructor(vertex, profession) {
        this.vertex = vertex;
        this.profession = profession;
        this.nr = settlementNr++;
        this.trafficWeight =
            profession === "Lord" ? 6 : profession === "Merchant" ? 2 : 1;
        this.color = this.getProfessionColor();

        vertex.occupied = true;
        vertex.occupiedBy = this;
        vertex.occupiedByRoute = false; // Settlement vertices can have routes start/end here
        vertex.attrition = 500;

        // Maintain farmer-vertex index set for fast lookup during value propagation
        if (profession === "Farmer") {
            farmerVertexIndices.add(vertex.index);
        }

        // Remove from habitable
        habitable = habitable.filter((v) => v.index !== vertex.index);
    }

    getProfessionColor() {
        switch (this.profession) {
            case "Lord":
                return { r: 255, g: 255, b: 255 };
            case "Farmer":
                return {
                    r: 120 + random(50),
                    g: 120 + random(50),
                    b: 50 + random(50),
                };
            case "Merchant":
                return {
                    r: 220 + random(35),
                    g: 130 + random(70),
                    b: 50 + random(50),
                };
            default:
                return { r: 200, g: 200, b: 200 };
        }
    }

    createAnnexes() {
        // Lord: Mark vicinity neighbors as castle annexes (occupied, blocked from pathfinding)
        if (
            this.vertex.vincinityNeighbors &&
            this.vertex.vincinityNeighbors.length > 0
        ) {
            this.vertex.vincinityNeighbors.forEach((v) => {
                v.occupied = true;
                v.castleAnnex = this; // Reference to the lord that owns this annex
                v.habitable = false;
                habitable = habitable.filter((hab) => hab.index !== v.index);
            });
        }
    }

    createGardens() {
        // Farmer: Mark vicinity neighbors as gardens (not occupied, open to pathfinding)
        // Only create gardens on unoccupied vertices
        if (
            this.vertex.vincinityNeighbors &&
            this.vertex.vincinityNeighbors.length > 0
        ) {
            this.vertex.vincinityNeighbors.forEach((v) => {
                if (!v.occupied) {
                    // console.log(v);
                    v.garden = this; // Reference to the farmer that owns this garden
                    // Do NOT mark as occupied - gardens are open to pathfinding and settlement
                }
            });
        }
    }

    show() {
        const v = this.vertex;
        colorMode(RGB);

        // Draw castle annexes for Lord (solid white)
        if (
            this.profession === "Lord" &&
            v.vincinityNeighbors &&
            v.vincinityNeighbors.length > 0
        ) {
            noStroke();
            fill(255, 255, 255); // Solid white for annexes
            v.vincinityNeighbors.forEach((annexVertex) => {
                if (
                    annexVertex.surroundingTiles &&
                    annexVertex.surroundingTiles.length > 0
                ) {
                    beginShape();
                    annexVertex.surroundingTiles.forEach((tile) => {
                        vertex(tile.centerX, tile.centerY);
                    });
                    endShape(CLOSE);
                }
            });
        }

        // Draw gardens for Farmer (green)
        if (
            this.profession === "Farmer" &&
            v.vincinityNeighbors &&
            v.vincinityNeighbors.length > 0
        ) {
            noStroke();
            fill(50, 255, 120); // Green for gardens
            v.vincinityNeighbors.forEach((gardenVertex) => {
                if (
                    gardenVertex.garden === this &&
                    gardenVertex.surroundingTiles &&
                    gardenVertex.surroundingTiles.length > 0
                ) {
                    beginShape();
                    gardenVertex.surroundingTiles.forEach((tile) => {
                        vertex(tile.centerX, tile.centerY);
                    });
                    endShape(CLOSE);
                }
            });
        }

        // Draw main settlement polygon
        if (this.profession === "Lord") {
            // Lord: solid white with black stroke
            stroke(0);
            strokeWeight(2);
            fill(255, 255, 255);
        } else {
            // Farmer and Merchant: colored polygon
            noStroke();
            fill(this.color.r, this.color.g, this.color.b);
        }

        beginShape();
        v.surroundingTiles.forEach((tile) => {
            vertex(tile.centerX, tile.centerY);
        });
        endShape(CLOSE);
    }

    drawSymbol() {
        // No longer drawing symbols - settlements are shown as polygons
    }
}

function initializeSimulationValues() {
    if (!vertices || vertices.length === 0) return;

    console.log("Initializing simulation values for debug visualization");

    // Initialize all vertex values
    vertices.forEach((vertex) => {
        vertex.security = 1; // Base security value of 1 to allow farmers/merchants before Lord
        vertex.trafficValue = vertex.traffic || 0;

        if (vertex.occupied === undefined) {
            vertex.occupied = false;
        }

        vertex.buffer = false;
        // Check both water and elevation for habitability
        if (vertex.elevation > UnhabitableLevel) {
            vertex.habitable = false;
        } else {
            vertex.habitable = !vertex.water;
        }
    });

    // Calculate steepness for each vertex
    let steepnessCount = 0;
    vertices.forEach((vertex) => {
        vertex.calculateSteepness();
        if (vertex.steepness > 0) steepnessCount++;
    });

    console.log(`Calculated steepness for ${steepnessCount} vertices`);

    // Calculate defense values using vertex method
    calculateDefenseValues();

    // Build quadtree for spatial queries BEFORE farm-value calculation
    // so the water-access lookup uses range queries instead of O(N) scans.
    console.log("Building quadtree for spatial optimization...");
    // Match the current canvas dimensions so all vertices are indexed
    const boundary = { x: 0, y: 0, width: width, height: height };
    vertexQuadtree = new Quadtree(boundary, 4);
    vertices.forEach((v) => {
        // Insert all vertices into quadtree for inspector tool
        vertexQuadtree.insert(v);
    });

    // Calculate initial farm values based on terrain (uses quadtree above)
    calculateInitialFarmValues();

    // Calculate initial farmer values (merchant values auto-update via setters)
    calculateFarmerValues();

    console.log("Simulation values initialized");
}

function calculateInitialFarmValues() {
    // Calculate farm value based on elevation and water access only.
    // Uses quadtree range query for O(log N) water lookup per vertex
    // when available; falls back to a linear scan if the quadtree hasn't
    // been built yet (only happens on first call before initializeSimulationValues).
    vertices.forEach((vertex) => {
        const hasWaterAccess = hasWaterWithin(vertex, waterAccessDist);
        vertex.calculateFarmValue(hasWaterAccess, FARM_ELEVATION_THRESHOLD);
        vertex.farmerNr = 0;
    });
}

// Returns true if any water vertex sits within `radius` canvas pixels of `vertex`.
function hasWaterWithin(vertex, radius) {
    if (vertexQuadtree) {
        const range = { x: vertex.x, y: vertex.y, r: radius };
        const candidates = vertexQuadtree.query(range);
        for (const v of candidates) {
            if (v.water) return true;
        }
        return false;
    }
    // Fallback: linear scan (cold path, runs once before quadtree exists)
    const radiusSq = radius * radius;
    for (const v of vertices) {
        if (!v.water) continue;
        const dx = v.x - vertex.x;
        const dy = v.y - vertex.y;
        if (dx * dx + dy * dy <= radiusSq) return true;
    }
    return false;
}

function initializeHabitable() {
    habitable = [];
    vertices.forEach((vertex) => {
        vertex.defense = 0;
        vertex.farmValue = 0;
        vertex.merchantValue = 0;
        vertex.security = 1; // Base security value of 1
        vertex.trafficValue = vertex.traffic || 0;
        vertex.farmerValue = 0;

        // Don't reset occupied if already set (e.g., by routes)
        if (vertex.occupied === undefined) {
            vertex.occupied = false;
        }

        vertex.buffer = false;
        vertex.habitable = !vertex.water; // Water vertices are not habitable

        // Only add to habitable if both habitable AND not occupied
        // occupiedByRoute flag is only set for vertices ON routes with traffic >= 12
        if (vertex.habitable && !vertex.occupied && !vertex.occupiedByRoute) {
            habitable.push(vertex);
        }
    });

    // Calculate defense values based on terrain
    calculateDefenseValues();

    // Calculate farm and farmer values so they're ready for settlement placement
    calculateInitialFarmValues();
    calculateFarmerValues();
}

// Populate habitable array without recalculating values (when values are already initialized)
function populateHabitableArray() {
    habitable = [];
    vertices.forEach((vertex) => {
        // Only add to habitable if habitable AND not occupied by anything (settlements or routes)
        // occupiedByRoute flag is only set for vertices ON routes with traffic >= 12
        if (vertex.habitable && !vertex.occupied && !vertex.occupiedByRoute) {
            habitable.push(vertex);
        }
    });
}

function calculateDefenseValues() {
    vertices.forEach((vertex) => {
        vertex.calculateDefense();
    });
}

function autoPopulate(steps) {
    if (!vertices || vertices.length === 0) {
        console.error("No vertices data available");
        alert("Please load map data first!");
        return;
    }

    console.log("Starting autoPopulate with", steps, "steps");
    console.log("Vertices available:", vertices.length);

    initializeHabitable();

    console.log("Habitable vertices:", habitable.length);

    // First create a Lord
    createLord();
    // console.log("Lord created, settlements:", settlements.length);

    // Then create other settlements
    for (let i = 0; i < steps; i++) {
        let dice = random(1);
        if (dice < 0.4) {
            createMerchant();
            // console.log("Merchant created, total:", settlements.length);
        } else {
            createFarmer();
            // console.log("Farmer created, total:", settlements.length);
        }
    }

    console.log("Final settlement count:", settlements.length);
    updateProgress(`Created ${settlements.length} settlements`);
    redraw();
}

function createLord() {
    if (!habitable || habitable.length === 0) {
        // console.error("No habitable vertices for Lord");
        return;
    }
    // console.log("Creating Lord from", habitable.length, "habitable vertices");

    // The map is a flat-top regular hexagon. Per the project TODO, the
    // first castle should sit at least R/3 from the border (where R is
    // the long radius of the hex), not just inside the rectangular
    // 50%-of-canvas bbox the original used.
    const _hexCx = topoData.mapping.hexCenter.x;
    const _hexCy = topoData.mapping.hexCenter.y;
    const _hexR  = (topoData.mapping.hexBounds.maxX - topoData.mapping.hexBounds.minX) / 2;
    const _apo   = _hexR * Math.sqrt(3) / 2;        // apothem (centre→edge)
    const _S     = Math.sqrt(3) / 2;
    const _margin = _hexR / 3;
    function _distToHexBorder(hx, hy) {
        const dx = hx - _hexCx, dy = hy - _hexCy;
        // Distance to each of the 6 hex edges (positive = inside).
        return Math.min(
            _apo - dy,
            _apo + dy,
            _apo - ( dx * _S + dy * 0.5),
            _apo - (-dx * _S + dy * 0.5),
            _apo - ( dx * _S - dy * 0.5),
            _apo - (-dx * _S - dy * 0.5),
        );
    }

    let centralHabitable = habitable.filter(
        (v) => _distToHexBorder(v.hexX, v.hexY) >= _margin,
    );

    if (centralHabitable.length === 0) {
        console.warn(
            `No habitable vertex ≥ R/3 (${_margin.toFixed(1)}) from hex border; using all habitable`,
        );
        centralHabitable = habitable.slice();
    }

    console.log(
        "Central habitable vertices (≥ R/3 from hex border):",
        centralHabitable.length,
    );

    // Farm and farmer values should already be calculated from initializeSimulationValues()
    // No need to recalculate them here

    // Find vertex with highest combined value (defense + 0.25 * farmerValue)
    centralHabitable.sort((a, b) => {
        const scoreA = a.defense + 0.3 * a.farmerValue;
        const scoreB = b.defense + 0.3 * b.farmerValue;
        return scoreB - scoreA;
    });
    const castleVertex = centralHabitable[0];

    console.log(
        "Castle vertex selected:",
        castleVertex.index,
        "defense:",
        castleVertex.defense,
        "position:",
        castleVertex.x.toFixed(0),
        castleVertex.y.toFixed(0),
    );

    const lord = new Settlement(castleVertex, "Lord");
    settlements.push(lord);
    castleVertices.push(castleVertex);

    console.log("Lord settlement created");

    lord.createAnnexes();

    // Create routes to trade destinations if they exist
    if (tradeDestination1) {
        const path1 = pathFinding(
            castleVertex,
            tradeDestination1,
            lord.trafficWeight,
        );
        if (path1) {
            const route1 = new Route(
                castleVertex,
                tradeDestination1,
                lord.trafficWeight,
                path1,
            );
            routes.push(route1);
        }
    }
    if (tradeDestination2) {
        const path2 = pathFinding(
            castleVertex,
            tradeDestination2,
            lord.trafficWeight,
        );
        if (path2) {
            const route2 = new Route(
                castleVertex,
                tradeDestination2,
                lord.trafficWeight,
                path2,
            );
            routes.push(route2);
        }
    }

    // Cast security to the realm - propagate to flooded neighbors only
    propagateSettlementInfluence(castleVertex.floodedNeighbors, 15);
}

function createFarmer() {
    if (habitable.length === 0) return;

    // No need to call calculateFarmValue() - farm values are already calculated
    // and don't change when we're just selecting a location

    // Find vertex with highest farmer value
    habitable.sort((a, b) => b.farmerValue - a.farmerValue);
    const farmerVertex = habitable[0];

    const farmer = new Settlement(farmerVertex, "Farmer");
    settlements.push(farmer);

    // Create route to castle if exists
    if (castleVertices.length > 0) {
        const path = pathFinding(
            farmerVertex,
            castleVertices[0],
            farmer.trafficWeight * 2,
        );
        if (path) {
            const route = new Route(
                farmerVertex,
                castleVertices[0],
                farmer.trafficWeight * 2,
                path,
            );
            routes.push(route);
        }
    }

    farmer.createGardens();

    // Increase security in vicinity neighbors only
    propagateSettlementInfluence(farmerVertex.vincinityNeighbors, 2);
}

function createMerchant() {
    if (habitable.length === 0) return;

    calculateMerchantValue();

    // Find vertex with highest merchant value
    habitable.sort((a, b) => b.merchantValue - a.merchantValue);
    const merchantVertex = habitable[0];

    const merchant = new Settlement(merchantVertex, "Merchant");
    settlements.push(merchant);

    // Create routes to trade destinations and castle
    if (tradeDestination1) {
        const path1 = pathFinding(
            merchantVertex,
            tradeDestination1,
            merchant.trafficWeight,
        );
        if (path1) {
            const route1 = new Route(
                merchantVertex,
                tradeDestination1,
                merchant.trafficWeight,
                path1,
            );
            routes.push(route1);
        }
    }
    if (tradeDestination2) {
        const path2 = pathFinding(
            merchantVertex,
            tradeDestination2,
            merchant.trafficWeight,
        );
        if (path2) {
            const route2 = new Route(
                merchantVertex,
                tradeDestination2,
                merchant.trafficWeight,
                path2,
            );
            routes.push(route2);
        }
    }
    if (castleVertices.length > 0) {
        const path3 = pathFinding(
            merchantVertex,
            castleVertices[0],
            merchant.trafficWeight * 2,
        );
        if (path3) {
            const route3 = new Route(
                merchantVertex,
                castleVertices[0],
                merchant.trafficWeight * 2,
                path3,
            );
            routes.push(route3);
        }
    }

    // Merchants don't create buffers - they are part of trade networks

    // Increase security in vicinity neighbors only
    propagateSettlementInfluence(merchantVertex.vincinityNeighbors, 1);
}

function calculateFarmValue() {
    // Calculate farm value based on elevation, water, and existing farmers.
    // Pre-collect farmer settlement positions once so the per-vertex density
    // check is over a small list rather than the full settlements array.
    const farmerSettlements = settlements.filter(
        (s) => s.profession === "Farmer",
    );
    const farmerRangeSq = farmerRange * farmerRange;

    vertices.forEach((vertex) => {
        const hasWaterAccess = hasWaterWithin(vertex, waterAccessDist);
        vertex.calculateFarmValue(hasWaterAccess, FARM_ELEVATION_THRESHOLD);

        let nearbyFarmers = 0;
        for (const s of farmerSettlements) {
            const dx = s.vertex.x - vertex.x;
            const dy = s.vertex.y - vertex.y;
            if (dx * dx + dy * dy <= farmerRangeSq) {
                nearbyFarmers++;
            }
        }

        vertex.farmerNr = nearbyFarmers;
        vertex.farmValue = vertex.farmValue / (1 + nearbyFarmers);
    });

    // Calculate farmer preference value
    calculateFarmerValues();
}

function calculateMerchantValue() {
    // This function is now just for traversing - actual calculation happens in vertex
    // console.log("calculateMerchantValue called (traversing vertices)");
    let count = 0;
    vertices.forEach((v) => {
        v.updateMerchantValue();
        if (v.merchantValue > 0) count++;
    });
    // console.log(`Updated merchant values: ${count} vertices with value > 0`);
}

function calculateFarmerValues() {
    const __t0 = profStart();
    if (!vertexQuadtree) {
        // console.warn("Quadtree not initialized, using fallback calculation");
        vertices.forEach((vertex) => {
            vertex.calculateFarmerValue(vertex.farmValue, 0);
        });
        profEnd("calculateFarmerValues", __t0);
        return;
    }

    vertices.forEach((vertex) => {
        // Calculate vicinity neighbors (smaller range)
        const vincinityVertices = findVerticesWithinMoveCost(
            vertex,
            SHORT_RANGE,
        );
        vertex.vincinityNeighbors = vincinityVertices;

        // Use movement-cost based flood fill to find nearby vertices
        const nearbyVertices = findVerticesWithinMoveCost(vertex, MIDDLE_RANGE);

        // Store flooded neighbors for visualization
        vertex.floodedNeighbors = nearbyVertices;

        // Sum farm values and count farmers in a single pass over nearbyVertices.
        // Farmer membership uses farmerVertexIndices Set for O(1) lookup.
        let totalFarmValue = 0;
        let farmerCount = 0;
        for (const v of nearbyVertices) {
            if (v.farmValue > 0) totalFarmValue += v.farmValue;
            if (farmerVertexIndices.has(v.index)) farmerCount++;
        }

        vertex.calculateFarmerValue(totalFarmValue, farmerCount);
    });
    profEnd("calculateFarmerValues", __t0);
}

// Apply a security boost to every affected vertex and recompute farmer values
// for them. The merchant-value update happens implicitly via the security
// setter on Vertex. Farmer count is read from the global farmerVertexIndices
// Set, avoiding the previous O(settlements × neighbors) per-vertex scan.
function propagateSettlementInfluence(affectedVertices, securityBoost) {
    if (!affectedVertices || affectedVertices.length === 0) return;
    const __t0 = profStart();

    for (const v of affectedVertices) {
        v.security += securityBoost;
    }

    for (const affectedVertex of affectedVertices) {
        const nearbyVertices = affectedVertex.floodedNeighbors || [];

        let totalFarmValue = 0;
        let farmerCount = 0;
        for (const v of nearbyVertices) {
            if (v.farmValue > 0) totalFarmValue += v.farmValue;
            if (farmerVertexIndices.has(v.index)) farmerCount++;
        }

        affectedVertex.calculateFarmerValue(totalFarmValue, farmerCount);
    }
    profEnd("propagateSettlementInfluence", __t0);
}

// Find all vertices reachable within a movement cost budget using flood fill
function findVerticesWithinMoveCost(startVertex, maxMoveCost) {
    const __t0 = profStart();
    const reachable = [];
    const visited = new Set();
    const queue = [{ vertex: startVertex, costSoFar: 0 }];

    visited.add(startVertex.index);
    reachable.push(startVertex);

    while (queue.length > 0) {
        const { vertex: current, costSoFar } = queue.shift();

        // Explore neighbors
        current.neighbors.forEach((neighbor) => {
            const neighborVertex = vertexByIndex.get(neighbor.vertexIndex);
            if (!neighborVertex) return;

            // Skip if already visited (pruning to avoid back-and-forth)
            if (visited.has(neighborVertex.index)) return;

            // Calculate cumulative cost to this neighbor
            const newCost = costSoFar + (neighbor.moveCost || Infinity);

            // Only continue if within budget
            if (newCost <= maxMoveCost) {
                visited.add(neighborVertex.index);
                reachable.push(neighborVertex);
                queue.push({ vertex: neighborVertex, costSoFar: newCost });
            }
        });
    }

    profEnd("findVerticesWithinMoveCost", __t0);
    return reachable;
}

function drawSettlements() {
    if (!settlements || settlements.length === 0) {
        return;
    }

    const __t0 = profStart();
    settlements.forEach((settlement, index) => {
        try {
            settlement.show();
        } catch (error) {
            console.error("Error drawing settlement", index, ":", error);
        }
    });
    profEnd("drawSettlements", __t0);
}

function clearSettlements() {
    settlements = [];
    settlementNr = 0;
    castleVertices = [];
    habitable = [];
    farmerVertexIndices = new Set();

    if (vertices) {
        vertices.forEach((v) => {
            v.occupied = false;
            v.buffer = false;
            v.castleAnnex = null;
            v.garden = null;
            v.habitable = !v.water;
            v.defense = 0;
            v.farmValue = 0;
            v.merchantValue = 0;
            v.security = 0;
            v.farmerValue = 0;
        });
    }
}
