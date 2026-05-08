/**
 * Save/Load System
 * Handles serialization and restoration of simulation state
 */

function saveSimulation() {
    if (!topoData || !vertices || vertices.length === 0) {
        updateProgress("No simulation data to save!");
        return;
    }

    updateProgress("Preparing save data...");

    // Create save data structure
    const saveData = {
        version: "1.0",
        timestamp: new Date().toISOString(),
        appState: appState,
        currentCity: currentCity,
        simulationStep: simulationStep,
        waterLevel: waterLevel,
        UnhabitableLevel: UnhabitableLevel,

        // Serialize settlements
        settlements: settlements.map((s) => ({
            vertexIndex: s.vertex.index,
            profession: s.profession,
            nr: s.nr,
            trafficWeight: s.trafficWeight,
        })),

        // Serialize castle vertices
        castleVertices: castleVertices.map((v) => v.index),

        // Serialize trade destinations
        tradeDestination1: tradeDestination1 ? tradeDestination1.index : null,
        tradeDestination2: tradeDestination2 ? tradeDestination2.index : null,

        // Serialize routes
        routes: routes.map((route) => ({
            start: route.start.index,
            end: route.end.index,
            path: route.path,
            trafficWeight: route.trafficWeight,
        })),

        // Serialize topoData without circular references
        topoData: {
            params: topoData.params,
            mapping: topoData.mapping,

            // Serialize vertices without circular references
            vertices: vertices.map((v) => ({
                index: v.index,
                hexCoords: {
                    x: v.hexX,
                    y: v.hexY,
                },
                elevation: v.elevation,
                // Store neighbor data as simple arrays of indices
                neighbors: v.neighbors.map((n) => ({
                    vertexIndex: n.vertexIndex,
                    distanceHexCoords: n.distanceHexCoords,
                    distanceCanvasPixels: n.distanceCanvasPixels,
                    horizontalDistanceMeters: n.horizontalDistanceMeters,
                    elevationDiff: n.elevationDiff,
                    slope: n.slope,
                    slopeAngle: n.slopeAngle,
                    slopePercent: n.slopePercent,
                    trafficCount: n.trafficCount || 0,
                })),
                adjacentFaces: v.adjacentFaces,
            })),

            // Serialize tiles
            tiles: topoData.tiles.map((t) => ({
                id: t.id,
                vertexIndices: t.vertexIndices,
                neighbors: t.neighbors,
                center: t.center,
                centerX: t.centerX,
                centerY: t.centerY,
                area: t.area,
            })),
        },
    };

    // Convert to JSON
    const jsonString = JSON.stringify(saveData, null, 2);

    // Create filename with timestamp
    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, -5);
    const filename = `simulation_${currentCity || "map"}_${timestamp}.json`;

    // Create download
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    updateProgress(`Simulation saved as ${filename}`);
}

function loadSimulation() {
    const fileInput = select("#loadFileInput");
    if (!fileInput) return;

    fileInput.elt.addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        updateProgress(`Loading ${file.name}...`);

        try {
            const text = await file.text();
            const saveData = JSON.parse(text);

            // Validate save data
            if (!saveData.version || !saveData.topoData) {
                throw new Error("Invalid save file format");
            }

            // Validate vertex data structure
            if (
                saveData.topoData.vertices &&
                saveData.topoData.vertices.length > 0
            ) {
                const firstVertex = saveData.topoData.vertices[0];
                if (
                    !firstVertex.hexCoords ||
                    typeof firstVertex.hexCoords.x === "undefined"
                ) {
                    throw new Error(
                        "This save file uses an old format. Please save a new file after this message."
                    );
                }
            }

            // Restore simulation state
            await restoreSimulation(saveData);

            updateProgress(`Simulation loaded: ${file.name}`);

            // Clear file input for next load
            event.target.value = "";
        } catch (error) {
            updateProgress(`Error loading file: ${error.message}`);
            console.error(error);
        }
    });
}

async function restoreSimulation(saveData) {
    // Hide title screen if showing
    if (appState === "TITLE") {
        hideTitleScreen();
    }

    // Restore global state
    appState = saveData.appState || "STATIC_MAP";
    currentCity = saveData.currentCity;
    simulationStep = saveData.simulationStep || 0;
    waterLevel = saveData.waterLevel || 10;
    UnhabitableLevel = saveData.UnhabitableLevel || 120;

    // Clear existing simulation
    settlements = [];
    settlementNr = 0;
    castleVertices = [];
    habitable = [];
    farmerVertexIndices = new Set();
    routes = [];
    travelers = [];
    isFirstAutoSpawn = true;

    // Stop auto-simulation if running
    if (autoSimulationActive) {
        toggleAutoSimulation();
    }

    // Restore topoData structure
    topoData = {
        params: saveData.topoData.params,
        mapping: saveData.topoData.mapping,
        vertices: saveData.topoData.vertices,
        tiles: saveData.topoData.tiles,
    };

    // Reconstruct vertices from saved topoData
    const scale = saveData.topoData.mapping.hexToCanvasScale || 1;
    const metersPerCanvasPixel = saveData.topoData.params
        ? saveData.topoData.params.metersPerCanvasPixel
        : 1;
    vertices = saveData.topoData.vertices.map((v) => {
        const vertex = new Vertex(v, scale, metersPerCanvasPixel);
        return vertex;
    });

    // Build index map for O(1) vertex lookups by index
    vertexByIndex = new Map();
    vertices.forEach((v) => vertexByIndex.set(v.index, v));

    // Reconstruct tiles from saved topoData
    tiles = saveData.topoData.tiles.map((t) => ({ ...t }));

    // Set water status for all vertices
    vertices.forEach((vertex) => {
        vertex.setWaterStatus(waterLevel);
    });

    // Update water level UI input to match loaded value
    const waterLevelInput = select("#waterLevel");
    if (waterLevelInput) {
        waterLevelInput.value(waterLevel);
    }

    console.log(
        `Restoring simulation with waterLevel: ${waterLevel}, routes: ${
            saveData.routes ? saveData.routes.length : 0
        }`
    );

    // Wait a frame for processing to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Restore settlements
    if (saveData.settlements && saveData.settlements.length > 0) {
        saveData.settlements.forEach((savedSettlement) => {
            const vertex = vertexByIndex.get(savedSettlement.vertexIndex);
            if (!vertex) return;

            const settlement = new Settlement(
                vertex,
                savedSettlement.profession
            );
            settlement.nr = savedSettlement.nr;
            settlement.trafficWeight = savedSettlement.trafficWeight;
            settlements.push(settlement);

            // Restore castle vertices
            if (savedSettlement.profession === "Lord") {
                castleVertices.push(vertex);
                settlement.createAnnexes();
            } else if (savedSettlement.profession === "Farmer") {
                settlement.createGardens();
            }
        });

        // Update settlementNr to continue from last number
        if (settlements.length > 0) {
            settlementNr = Math.max(...settlements.map((s) => s.nr)) + 1;
        }
    }

    // Restore trade destinations
    if (saveData.tradeDestination1 !== null) {
        tradeDestination1 = vertexByIndex.get(saveData.tradeDestination1);
    }
    if (saveData.tradeDestination2 !== null) {
        tradeDestination2 = vertexByIndex.get(saveData.tradeDestination2);
    }

    // Restore routes
    if (saveData.routes && saveData.routes.length > 0) {
        console.log(`Restoring ${saveData.routes.length} routes`);
        routes = saveData.routes.map((savedRoute) => {
            const start = vertexByIndex.get(savedRoute.start);
            const end = vertexByIndex.get(savedRoute.end);
            if (!start || !end) {
                console.warn(
                    `Could not find vertices for route: start=${savedRoute.start}, end=${savedRoute.end}`
                );
            }
            return {
                start: start,
                end: end,
                path: savedRoute.path,
                trafficWeight: savedRoute.trafficWeight,
            };
        });

        console.log(`Routes array now has ${routes.length} routes`);

        // Update traffic on routes
        routes.forEach((route, routeIndex) => {
            if (!route.start || !route.end) {
                console.warn(
                    `Route ${routeIndex} has missing start or end vertex`
                );
                return;
            }
            route.path.forEach((vertexIndex, i) => {
                const vertex = vertexByIndex.get(vertexIndex);
                if (vertex) {
                    vertex.traffic += route.trafficWeight;

                    // Update neighbor traffic counts
                    if (i < route.path.length - 1) {
                        const nextVertexIndex = route.path[i + 1];
                        const neighbor = vertex.neighbors.find(
                            (n) => n.vertexIndex === nextVertexIndex
                        );
                        if (neighbor) {
                            neighbor.trafficCount =
                                (neighbor.trafficCount || 0) +
                                route.trafficWeight;
                        }
                    }
                }
            });
        });
    }

    // Update simulation stats display
    updateSimStats();

    // Refresh all buffers
    invalidateBuffers("all");
    redraw();
}

// Initialize load functionality on setup
function initializeLoadSimulation() {
    loadSimulation();
}
