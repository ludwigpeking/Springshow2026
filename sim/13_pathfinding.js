// Pathfinding-related global variables
let routes = [];

class Route {
    constructor(start, end, trafficWeight, path, isRandomTravel = false) {
        this.start = start;
        this.end = end;
        this.trafficWeight = trafficWeight;
        this.path = path; // Array of vertex indices
        this.totalDistance = 0;
        this.totalElevationGain = 0;
        this.isRandomTravel = isRandomTravel;
    }
}

function pathFinding(start, end, trafficWeight) {
    const __t0 = profStart();
    // Reset all vertices
    topoData.vertices.forEach((v) => {
        v.g = Infinity;
        v.h = 0;
        v.f = Infinity;
        v.from = null;
    });

    const downhillInput = select("#downhillFactor");
    const flatTerrainInput = select("#flatTerrainCost");
    const downhillFactor = downhillInput
        ? parseFloat(downhillInput.value())
        : 0.3;
    const flatTerrainCost = flatTerrainInput
        ? parseFloat(flatTerrainInput.value())
        : 2;

    let openSet = [];
    let closeSet = [];

    start.g = 0;
    start.h = calculateHeuristic(start, end);
    start.f = start.g + start.h;
    openSet.push(start);

    let current = start;

    while (openSet.length > 0 && current.index !== end.index) {
        openSet.sort((a, b) => a.f - b.f);
        current = openSet.shift();
        closeSet.push(current);

        for (let neighborData of current.neighbors) {
            const neighbor = vertexByIndex.get(neighborData.vertexIndex);
            if (!neighbor) continue;
            if (closeSet.includes(neighbor)) continue;

            // Skip vertices occupied by settlements (but allow as start/end points)
            // Routes can cross other routes, so occupiedByRoute vertices are allowed
            // Castle annexes are blocked UNLESS the path is from/to the lord itself
            if (neighbor.occupiedBy) {
                // Check if it's a regular settlement occupation
                if (
                    neighbor.index !== end.index &&
                    neighbor.index !== start.index
                ) {
                    continue;
                }
            } else if (neighbor.castleAnnex) {
                // Check if it's a castle annex - only allow if path involves the lord
                const isPathToFromLord =
                    (start.occupiedBy &&
                        start.occupiedBy === neighbor.castleAnnex) ||
                    (end.occupiedBy && end.occupiedBy === neighbor.castleAnnex);
                if (!isPathToFromLord && neighbor.index !== end.index) {
                    continue;
                }
            }

            // Use pre-calculated movement cost
            const moveCost = current.g + neighborData.moveCost;

            if (moveCost < neighbor.g) {
                neighbor.from = current;
                neighbor.g = moveCost;
                neighbor.h = calculateHeuristic(neighbor, end);
                neighbor.f = neighbor.g + neighbor.h;

                if (!openSet.includes(neighbor)) {
                    openSet.push(neighbor);
                }
            }
        }
    }

    if (current.index === end.index) {
        const path = [];
        let node = end;

        // First pass: collect all path vertices
        const pathVertices = new Set();
        let temp = end;
        while (temp) {
            pathVertices.add(temp.index);
            temp = temp.from;
        }

        // Second pass: add traffic to path vertices and mark as occupied by route
        node = end;
        while (node) {
            path.unshift(node.index);
            node.traffic += trafficWeight;
            node.trafficValue = node.traffic; // Update traffic value for merchant calculations
            node = node.from;
        }

        // Third pass: add traffic to neighbors (only once per neighbor per route)
        const neighborTrafficAdded = new Set();
        pathVertices.forEach((pathIndex) => {
            const pathVertex = vertexByIndex.get(pathIndex);
            if (pathVertex) {
                pathVertex.neighbors.forEach((neighborData) => {
                    const neighborIndex = neighborData.vertexIndex;
                    // Only add traffic if neighbor is not on the path AND hasn't been processed yet
                    if (
                        !pathVertices.has(neighborIndex) &&
                        !neighborTrafficAdded.has(neighborIndex)
                    ) {
                        const neighbor = vertexByIndex.get(neighborIndex);
                        if (neighbor) {
                            neighbor.traffic += trafficWeight * 0.5; // Neighbors get half the traffic
                            neighbor.trafficValue = neighbor.traffic; // Update traffic value for merchant calculations
                            neighborTrafficAdded.add(neighborIndex);
                        }
                    }
                });
            }
        });

        // Fourth pass: increment trafficCount on edges between consecutive path vertices
        for (let i = 0; i < path.length - 1; i++) {
            const currentIndex = path[i];
            const nextIndex = path[i + 1];
            const currentVertex = vertexByIndex.get(currentIndex);
            const nextVertex = vertexByIndex.get(nextIndex);

            if (currentVertex && nextVertex) {
                // Increment trafficCount on the edge from current to next
                const forwardEdge = currentVertex.neighbors.find(
                    (n) => n.vertexIndex === nextIndex,
                );
                if (forwardEdge) {
                    if (forwardEdge.trafficCount === undefined)
                        forwardEdge.trafficCount = 0;
                    forwardEdge.trafficCount += trafficWeight;
                }

                // Increment trafficCount on the edge from next to current (mutual)
                const backwardEdge = nextVertex.neighbors.find(
                    (n) => n.vertexIndex === currentIndex,
                );
                if (backwardEdge) {
                    if (backwardEdge.trafficCount === undefined)
                        backwardEdge.trafficCount = 0;
                    backwardEdge.trafficCount += trafficWeight;
                }
            }
        }

        // Fifth pass: mark ALL vertices as occupied if sum of edge trafficCount >= 12
        // This must check all vertices, not just path vertices, because trafficCount accumulates
        // Water tiles are NOT marked as occupied by routes
        const updatedVertices = [];
        topoData.vertices.forEach((vertex) => {
            if (!vertex.occupiedBy && vertex.elevation > waterLevel) {
                // Calculate sum of all edge traffic counts (same as Traffic Count debug layer)
                const totalEdgeTraffic = vertex.neighbors.reduce(
                    (sum, n) => sum + (n.trafficCount || 0),
                    0,
                );
                const wasOccupied = vertex.occupiedByRoute;
                if (totalEdgeTraffic >= 12) {
                    vertex.occupied = true;
                    vertex.occupiedByRoute = true;
                    if (!wasOccupied) {
                        updatedVertices.push(vertex);
                    }
                }
            }
        });

        // Update presentation layer for changed vertices
        if (
            updatedVertices.length > 0 &&
            typeof showPresentation !== "undefined" &&
            showPresentation &&
            typeof redrawVertexQuads !== "undefined" &&
            presentationBuffer &&
            patternAtlas
        ) {
            updatedVertices.forEach((vertex) => {
                redrawVertexQuads(
                    presentationBuffer,
                    patternAtlas,
                    vertex,
                    topoData.tiles,
                    vertexByIndex,
                );
            });
        }

        // Recalculate movement costs to apply traffic reduction
        calculateMovementCosts();

        profEnd("pathFinding", __t0);
        return path;
    }

    profEnd("pathFinding", __t0);
    return null;
}

function calculateHeuristic(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return sqrt(dx * dx + dy * dy);
}

function calculateRouteStats(route) {
    route.totalDistance = 0;
    route.totalElevationGain = 0;

    for (let i = 0; i < route.path.length - 1; i++) {
        const currentVertex = vertexByIndex.get(route.path[i]);
        const nextVertex = vertexByIndex.get(route.path[i + 1]);
        const neighborData = currentVertex.neighbors.find(
            (n) => n.vertexIndex === nextVertex.index,
        );

        if (neighborData) {
            route.totalDistance += neighborData.distance;
            if (neighborData.elevationDiff > 0) {
                route.totalElevationGain += neighborData.elevationDiff;
            }
        }
    }
}

function createRandomRoute() {
    if (!topoData || edgeVertices.length < 2) {
        alert("Please load map data first!");
        return;
    }

    const start = edgeVertices[floor(random(edgeVertices.length))];
    let end;
    let distance;

    do {
        end = edgeVertices[floor(random(edgeVertices.length))];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        distance = sqrt(dx * dx + dy * dy);
    } while (
        distance <
        topoData.mapping.hexWidth * topoData.mapping.hexToCanvasScale * 0.5
    );

    const trafficInput = select("#trafficWeight");
    const trafficWeight = trafficInput ? parseFloat(trafficInput.value()) : 12;

    updateProgress(
        `Finding route from vertex ${start.index} to ${end.index}...`,
    );

    const path = pathFinding(start, end, trafficWeight);

    if (path) {
        const route = new Route(start, end, trafficWeight, path);
        calculateRouteStats(route);
        routes.push(route);

        updateProgress(
            `Route created! Length: ${
                path.length
            } vertices, Distance: ${route.totalDistance.toFixed(0)}m`,
        );
        updateRouteStats();
        if (typeof invalidateBuffers !== "undefined")
            invalidateBuffers("static");
        redraw();
    } else {
        updateProgress("Failed to find route!");
    }
}

function createRandomTravel() {
    if (!settlements || settlements.length < 2) {
        alert("Need at least 2 settlements for random travel!");
        return;
    }

    // Pick two random settlements
    const settlement1 = settlements[floor(random(settlements.length))];
    let settlement2;
    do {
        settlement2 = settlements[floor(random(settlements.length))];
    } while (settlement1 === settlement2);

    const start = settlement1.vertex;
    const end = settlement2.vertex;
    const trafficWeight = 2;

    updateProgress(
        `Random travel from ${settlement1.profession} to ${settlement2.profession}...`,
    );

    const path = pathFinding(start, end, trafficWeight);

    if (path) {
        const route = new Route(start, end, trafficWeight, path, true);
        calculateRouteStats(route);
        routes.push(route);

        updateProgress(
            `Travel route created! Length: ${
                path.length
            } vertices, Distance: ${route.totalDistance.toFixed(0)}m`,
        );
        updateRouteStats();
        if (typeof invalidateBuffers !== "undefined")
            invalidateBuffers("static");
        redraw();
    } else {
        updateProgress("Failed to find travel route!");
    }
}

function createHardcodedRoute(startIndex, endIndex) {
    if (!topoData) return;

    const start = vertexByIndex.get(startIndex);
    const end = vertexByIndex.get(endIndex);

    if (!start || !end) {
        // console.error(`Could not find vertices ${startIndex} or ${endIndex}`);
        return;
    }

    // Set global trade destinations
    tradeDestination1 = start;
    tradeDestination2 = end;
    // console.log(`Trade destinations set: ${startIndex} and ${endIndex}`);

    const trafficInput = select("#trafficWeight");
    const trafficWeight = trafficInput ? parseFloat(trafficInput.value()) : 12;

    updateProgress(
        `Finding hardcoded route from vertex ${startIndex} to ${endIndex}...`,
    );

    const path = pathFinding(start, end, trafficWeight);

    if (path) {
        const route = new Route(start, end, trafficWeight, path);
        calculateRouteStats(route);
        routes.push(route);

        updateProgress(
            `Hardcoded route created! Length: ${
                path.length
            } vertices, Distance: ${route.totalDistance.toFixed(0)}m`,
        );
        updateRouteStats();
        if (typeof invalidateBuffers !== "undefined")
            invalidateBuffers("static");
    } else {
        updateProgress(
            `Failed to find hardcoded route from ${startIndex} to ${endIndex}!`,
        );
    }
}

function clearRoutes() {
    routes = [];
    if (topoData && topoData.vertices) {
        topoData.vertices.forEach((v) => {
            v.traffic = 0;
        });
    }
    updateRouteStats();
    if (typeof invalidateBuffers !== "undefined") invalidateBuffers("static");
    redraw();
    updateProgress("All routes cleared");
}

function updateRouteStats() {
    const statsEl = select("#route-stats");
    // Guard for minimal UIs (e.g., index-large.html) that omit the stats container
    if (!statsEl) return;

    if (routes.length === 0) {
        statsEl.html("No routes created yet");
        return;
    }

    let html = `<p><strong>Total Routes:</strong> ${routes.length}</p>`;

    routes.forEach((route, index) => {
        html += `
            <div class="stat-row">
                <strong>Route ${index + 1}:</strong>
                ${route.path.length} vertices, 
                ${route.totalDistance.toFixed(0)}m distance, 
                ${route.totalElevationGain.toFixed(0)}m elevation gain,
                weight: ${route.trafficWeight}
            </div>
        `;
    });

    statsEl.html(html);
}
