// Vertex class - encapsulates all vertex-related logic and properties
class Vertex {
    constructor(rawData, scale, metersPerCanvasPixel) {
        // Core identity
        this.index = rawData.index;

        // Hex coordinates (never change)
        this.hexX = rawData.hexCoords.x;
        this.hexY = rawData.hexCoords.y;

        // Canvas coordinates (never change after initialization)
        this.x = rawData.hexCoords.x * scale;
        this.y = rawData.hexCoords.y * scale;

        // Terrain properties (never change)
        this.elevation = rawData.elevation;
        this.neighbors = rawData.neighbors || [];

        // Convert neighbor distances to pixels
        this.neighbors.forEach((neighbor) => {
            neighbor.distance =
                neighbor.horizontalDistanceMeters / metersPerCanvasPixel;
            neighbor.trafficCount = 0; // Initialize traffic count
        });

        // Dynamic properties (change during simulation)
        this.water = false; // Set based on waterLevel
        this.traffic = 0;
        this.occupied = false;
        this.habitable = true;
        this.buffer = false;

        // Pathfinding properties
        this.g = Infinity;
        this.h = 0;
        this.f = Infinity;
        this.from = null;

        // Visualization
        this.surroundingTiles = [];

        // Simulation values
        this.defense = 0;
        this.farmValue = 0;
        this.merchantValue = 0;
        this._security = 1; // Private backing field
        this._trafficValue = 0; // Private backing field
        this.farmerValue = 0;
        this.steepness = 0;
        this.farmerNr = 0;
        this.floodedNeighbors = []; // Vertices reachable within movement cost budget
    }

    // Getter and setter for security with automatic merchant value recalculation
    get security() {
        return this._security;
    }

    set security(value) {
        this._security = value;
        this.updateMerchantValue();
    }

    // Getter and setter for trafficValue with automatic merchant value recalculation
    get trafficValue() {
        return this._trafficValue;
    }

    set trafficValue(value) {
        this._trafficValue = value;
        this.updateMerchantValue();
    }

    // Update merchant value based on current security and trafficValue
    updateMerchantValue() {
        this.merchantValue = this._security * this._trafficValue;
    }

    // Calculate farmer value based on nearby farm values and security
    calculateFarmerValue(nearbyFarmValue, nearbyFarmerCount) {
        if (!this.habitable || this.water) {
            this.farmerValue = 0;
            return;
        }
        // farmerValue = (nearby farm value / (1 + nearby farmers)) * sqrt(security)
        this.farmerValue =
            (nearbyFarmValue / (1 + nearbyFarmerCount)) *
            Math.sqrt(this._security);
    }

    // Calculate farm value based on terrain, water access, and steepness
    calculateFarmValue(hasWaterAccess, farmElevationThreshold) {
        if (this.water || this.elevation > farmElevationThreshold) {
            this.farmValue = 0;
            return;
        }

        let farmVal = 1;

        if (hasWaterAccess) farmVal *= 2;

        // Steepness bonus and penalties
        if (this.steepness >= 0.01 && this.steepness <= 0.05) {
            farmVal *= 2;
        }
        if (this.steepness > 0.12) {
            farmVal = 0;
        }

        this.farmValue = farmVal;
    }

    // Calculate defense value based on elevation and terrain roughness
    calculateDefense() {
        if (!this.habitable) {
            this.defense = 0;
            return;
        }

        // Defense increases with elevation and roughness
        // let defenseValue = this.elevation * 2;
        let defenseValue = this.elevation / 2;

        // Check neighbors for elevation difference (roughness)
        let totalElevDiff = 0;
        let neighborCount = 0;
        this.neighbors.forEach((neighbor) => {
            if (neighbor.elevationDiff !== undefined) {
                totalElevDiff -= neighbor.elevationDiff;
                neighborCount++;
            }
        });

        if (neighborCount > 0) {
            const avgRoughness = totalElevDiff / neighborCount;
            defenseValue += avgRoughness * 10;
        }

        this.defense = defenseValue;
    }

    // Calculate steepness (average absolute slope to neighbors)
    calculateSteepness() {
        if (!this.neighbors || this.neighbors.length === 0) {
            this.steepness = 0;
            this.slopeDirection = null;
            return;
        }

        let totalSlope = 0;
        let validNeighbors = 0;
        let sumX = 0;
        let sumY = 0;

        this.neighbors.forEach((neighbor) => {
            if (neighbor.slope !== undefined) {
                totalSlope += Math.abs(neighbor.slope);
                validNeighbors++;

                // Calculate slope direction (gradient vector)
                const neighborVertex = vertexByIndex.get(neighbor.vertexIndex);
                if (neighborVertex) {
                    const dx = neighborVertex.x - this.x;
                    const dy = neighborVertex.y - this.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist > 0) {
                        // Weight by slope magnitude, pointing downhill
                        const weight = neighbor.slope; // Positive if neighbor is higher
                        sumX += (dx / dist) * weight;
                        sumY += (dy / dist) * weight;
                    }
                }
            }
        });

        this.steepness = validNeighbors > 0 ? totalSlope / validNeighbors : 0;

        // Store slope direction as angle in radians (pointing downhill)
        if (sumX !== 0 || sumY !== 0) {
            this.slopeDirection = Math.atan2(sumY, sumX);
            this.slopeDirectionMagnitude = Math.sqrt(sumX * sumX + sumY * sumY);
        } else {
            this.slopeDirection = null;
            this.slopeDirectionMagnitude = 0;
        }
    }

    // Calculate terrain-based movement cost for each neighbor
    calculateMovementCosts(modeChangeCost, waterTransportFactor) {
        this.neighbors.forEach((neighbor) => {
            // Initialize trafficCount if not exists
            if (neighbor.trafficCount === undefined) {
                neighbor.trafficCount = 0;
            }

            // Get neighbor vertex via index map (O(1))
            const neighborVertex = vertexByIndex.get(neighbor.vertexIndex);
            if (!neighborVertex) return;

            const fromWater = this.water;
            const toWater = neighborVertex.water;
            const distance = neighbor.distance;
            const slope = neighbor.slope;

            let moveCost;

            if (!fromWater && !toWater) {
                // Land to land
                moveCost = distance * Math.pow(1 + 10 * Math.abs(slope), 4);
            } else if (fromWater !== toWater) {
                // Land to water or water to land
                moveCost = distance * (1 + modeChangeCost);
            } else {
                // Water to water
                moveCost = distance * waterTransportFactor;
            }

            // Apply traffic reduction: 1 traffic = 30% reduction, 100 traffic = 50% reduction
            if (neighbor.trafficCount > 0) {
                const trafficClamped = Math.min(neighbor.trafficCount, 100);
                // Lerp between 0.7 (30% reduction) and 0.5 (50% reduction)
                const reductionFactor = 0.7 - (trafficClamped / 100) * 0.2;
                moveCost *= reductionFactor;
            }

            neighbor.moveCost = moveCost;
        });
    }

    // Update water status based on water level
    setWaterStatus(waterLevel) {
        this.water = this.elevation <= waterLevel;
    }
}
