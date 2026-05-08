// Utility functions and data structures

// Simple Quadtree implementation for spatial optimization
class Quadtree {
    constructor(boundary, capacity = 4) {
        this.boundary = boundary; // {x, y, width, height}
        this.capacity = capacity;
        this.vertices = [];
        this.divided = false;
    }

    subdivide() {
        const x = this.boundary.x;
        const y = this.boundary.y;
        const w = this.boundary.width / 2;
        const h = this.boundary.height / 2;

        const ne = { x: x + w, y: y, width: w, height: h };
        const nw = { x: x, y: y, width: w, height: h };
        const se = { x: x + w, y: y + h, width: w, height: h };
        const sw = { x: x, y: y + h, width: w, height: h };

        this.northeast = new Quadtree(ne, this.capacity);
        this.northwest = new Quadtree(nw, this.capacity);
        this.southeast = new Quadtree(se, this.capacity);
        this.southwest = new Quadtree(sw, this.capacity);

        this.divided = true;
    }

    insert(vertex) {
        if (!this.contains(vertex)) return false;

        if (this.vertices.length < this.capacity) {
            this.vertices.push(vertex);
            return true;
        }

        if (!this.divided) {
            this.subdivide();
        }

        return (
            this.northeast.insert(vertex) ||
            this.northwest.insert(vertex) ||
            this.southeast.insert(vertex) ||
            this.southwest.insert(vertex)
        );
    }

    contains(vertex) {
        return (
            vertex.x >= this.boundary.x &&
            vertex.x < this.boundary.x + this.boundary.width &&
            vertex.y >= this.boundary.y &&
            vertex.y < this.boundary.y + this.boundary.height
        );
    }

    query(range, found = []) {
        if (!this.intersects(range)) return found;

        for (let v of this.vertices) {
            if (this.inRange(v, range)) {
                found.push(v);
            }
        }

        if (this.divided) {
            this.northeast.query(range, found);
            this.northwest.query(range, found);
            this.southeast.query(range, found);
            this.southwest.query(range, found);
        }

        return found;
    }

    intersects(range) {
        return !(
            range.x - range.r > this.boundary.x + this.boundary.width ||
            range.x + range.r < this.boundary.x ||
            range.y - range.r > this.boundary.y + this.boundary.height ||
            range.y + range.r < this.boundary.y
        );
    }

    inRange(vertex, range) {
        const dx = vertex.x - range.x;
        const dy = vertex.y - range.y;
        return dx * dx + dy * dy <= range.r * range.r;
    }
}
