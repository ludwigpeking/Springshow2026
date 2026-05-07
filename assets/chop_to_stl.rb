# Run from SketchUp: Window > Ruby Console, then:
#   load "C:/Users/qli/Desktop/IT/2605_SpringShow/assets/chop_to_stl.rb"
#
# Slices a SketchUp model whose 3D assets are laid out on a regular grid into
# one OBJ file per tile (plus a shared MTL with every material in the model),
# using the TL-TR-BR-BL filename scheme from imageChopping.py.
#
# OBJ instead of STL because STL stores no material info — no colors, no
# texture refs, no per-face material assignments. With OBJ, every tile's
# `usemtl <name>` lines reference the same shared materials.mtl, so the
# downstream GLB build sees the same material name across tiles and can
# dedupe to one material entry.
#
# Grid spec (matches the spec in 2605_SpringShow/TODO.md):
#   first column centers at (15, 0, 0), spaced TILE_STEP apart in +X
#   first row    centers at (0, -15, 0), spaced TILE_STEP apart in -Y
#   tile (i, j) center: (TILE_OFFSET + TILE_STEP*i, -(TILE_OFFSET + TILE_STEP*j), 0)
#
# Each top-level Group / ComponentInstance is bucketed by its bounding-box
# center; bucket (i, j) is exported to FILE_NAMES[j][i] + ".obj".

require 'fileutils'

# === SETTINGS — edit these to match your model ===

# Set this to the unit your numeric coordinates are in.
# Choices: 1.mm, 1.cm, 1.m, 1.inch, 1.feet
UNIT          = 1.m

TILE_OFFSET   = 15.0       # first tile center offset (in UNIT)
TILE_STEP     = 60.0       # spacing between tile centers (in UNIT)

# SketchUp is Z-up; Three.js / glTF / most realtime engines are Y-up.
# true → rotate (x, y, z) -> (x, z, -y) on export so STLs drop into Y-up scenes
# unchanged. Set false if you want the raw SketchUp axes preserved.
TO_Y_UP       = true

# Where to write the per-tile STLs. Defaults to <skp_dir>/stl_export/
OUTPUT_DIR    = begin
  src  = Sketchup.active_model.path
  base = (src.nil? || src.empty?) ? Dir.pwd : File.dirname(src)
  File.join(base, "stl_export")
end

# === FILENAME GRID — same as imageChopping.py, .stl extension implied ===
FILE_NAMES = [
  # row 1
  %w[wwww rrrr 1111 2222 cccc],
  # row 2
  %w[wrwr w1w1 w2w2 wcwc],
  # row 3
  %w[r1r1 r2r2 rcrc 1212 1c1c 2c2c],
  # row 4
  %w[wwrr ww11 ww22 wwcc rr11 rr22 rrcc],
  # row 5
  %w[1122 11cc 22cc],
  # row 6
  %w[wwrw ww1w ww2w wwcw rrwr rr1r rr2r rrcr],
  # row 7
  %w[11w1 11r1 1121 11c1 22w2 22r2 2212 22c2],
  # row 8
  %w[ccwc ccrc cc1c cc2c],
  # row 9
  %w[w1wr w2wr wcwr w2w1 wcw1 wcw2],
  # row 10
  %w[r1rw r2rw rcrw r2r1 rcr1 rcr2],
  # row 11
  %w[1r1w 121w 1c1w 121r 1c1r 1c12],
  # row 12
  %w[2r2w 212w 2c2w 212r 2c2r 2c21],
  # row 13
  %w[crcw c1cw c2cw c1cr c2cr c2c1],
  # row 14
  %w[wr21 wrc1 wr2c wc21 cr21],
  # row 15
  %w[w2r1 wcr1 w2rc w2c1 c2r1],
  # row 16
  %w[wr12 wr1c wrc2 wc12 cr12],
  # row 17
  %w[ww1r ww2r wwcr ww21 wwc1 wwc2],
  # row 18
  %w[rr1w rr2w rrcw rr21 rrc1 rrc2],
  # row 19
  %w[11rw 112w 11cw 112r 11cr 11c2],
  # row 20
  %w[22rw 221w 22cw 221r 22cr 22c1],
  # row 21
  %w[ccrw cc1w cc2w cc1r cc2r cc21]
]

# === HELPERS ===

# Convert a SketchUp Length (internal inches) into a number of UNITs.
def to_user(length)
  length.to_f / UNIT.to_f
end

# Bucket a world-space point into a (column i, row j) tile, or nil if outside.
def tile_for_position(p)
  x_u = to_user(p.x)
  y_u = to_user(p.y)
  i = ((x_u + TILE_OFFSET) / TILE_STEP).floor
  j = ((TILE_OFFSET - y_u) / TILE_STEP).floor
  return nil if i < 0 || j < 0
  return nil if j >= FILE_NAMES.length
  return nil if i >= FILE_NAMES[j].length
  [i, j]
end

# Apply axis convention. SketchUp Z-up -> Y-up: (x, y, z) -> (x, z, -y).
def reorient(x, y, z)
  TO_Y_UP ? [x, z, -y] : [x, y, z]
end

# OBJ/MTL material names can't contain spaces or non-ASCII — sanitize.
def sanitize_name(name)
  return "_default" if name.nil? || name.to_s.empty?
  name.to_s.gsub(/[^A-Za-z0-9_-]/, "_")
end

# A face inherits its enclosing group/component's material when its own
# material is nil. Recurse into entities, threading the cascading material
# down, and accumulate triangles into `by_mat` keyed by material name.
def collect_by_material(entities, xform, parent_material, by_mat)
  entities.each do |e|
    case e
    when Sketchup::Face
      mat = e.material || parent_material
      mat_name = mat ? mat.name : "_default"
      mesh = e.mesh
      mesh.polygons.each do |poly|
        pts = poly.map { |k| mesh.point_at(k.abs).transform(xform) }
        (1..pts.length - 2).each do |k|
          (by_mat[mat_name] ||= []) << [pts[0], pts[k], pts[k + 1]]
        end
      end
    when Sketchup::Group
      child_mat = e.material || parent_material
      collect_by_material(e.entities, xform * e.transformation, child_mat, by_mat)
    when Sketchup::ComponentInstance
      child_mat = e.material || parent_material
      collect_by_material(e.definition.entities, xform * e.transformation, child_mat, by_mat)
    end
  end
end

# Write one shared MTL file with every material in the SketchUp model. Color
# only — textures/UVs are not handled here. Adds a "_default" material that
# faces with no assigned material fall back to.
def write_mtl(filepath)
  File.open(filepath, "w") do |f|
    f.puts "# Materials extracted from SketchUp model. Color only — textures not exported."
    f.puts ""
    Sketchup.active_model.materials.each do |m|
      c = m.color
      f.puts "newmtl #{sanitize_name(m.name)}"
      f.printf("Kd %.4f %.4f %.4f\n", c.red / 255.0, c.green / 255.0, c.blue / 255.0)
      f.puts "Ka 0 0 0"
      f.puts "Ks 0 0 0"
      f.printf("d %.4f\n", m.alpha)
      f.puts "illum 1"
      f.puts ""
    end
    f.puts "newmtl _default"
    f.puts "Kd 0.7 0.7 0.7"
    f.puts "Ka 0 0 0"
    f.puts "Ks 0 0 0"
    f.puts "d 1"
    f.puts "illum 1"
  end
end

# Write one ASCII OBJ file. All vertex coordinates come out in UNIT,
# re-centered on (cx_u, cy_u, 0) in the original SketchUp XY plane. Faces
# are grouped by material via `usemtl` blocks, all referencing the shared
# MTL whose relative path is `mtl_relative`.
def write_obj(by_mat, filepath, name, cx_u, cy_u, mtl_relative)
  vertices = []
  normals  = []
  faces_per_mat = {}

  by_mat.each do |mat_name, triangles|
    faces_per_mat[mat_name] = []
    triangles.each do |a, b, c|
      ux, uy, uz = b.x - a.x, b.y - a.y, b.z - a.z
      vx, vy, vz = c.x - a.x, c.y - a.y, c.z - a.z
      nx = uy * vz - uz * vy
      ny = uz * vx - ux * vz
      nz = ux * vy - uy * vx
      mlen = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if mlen > 0
        nx /= mlen; ny /= mlen; nz /= mlen
      else
        nx, ny, nz = 0.0, 0.0, 1.0
      end
      onx, ony, onz = reorient(nx, ny, nz)
      normals << [onx, ony, onz]
      n_idx = normals.length

      v_idx = [a, b, c].map do |p|
        xu = to_user(p.x) - cx_u
        yu = to_user(p.y) - cy_u
        zu = to_user(p.z)
        ox, oy, oz = reorient(xu, yu, zu)
        vertices << [ox, oy, oz]
        vertices.length
      end

      faces_per_mat[mat_name] << [v_idx[0], v_idx[1], v_idx[2], n_idx]
    end
  end

  File.open(filepath, "w") do |f|
    f.puts "mtllib #{mtl_relative}"
    f.puts "o #{name}"
    f.puts ""
    vertices.each { |v| f.printf("v %.6f %.6f %.6f\n", *v) }
    normals.each  { |n| f.printf("vn %.6f %.6f %.6f\n", *n) }
    f.puts ""
    faces_per_mat.each do |mat_name, faces|
      f.puts "usemtl #{sanitize_name(mat_name)}"
      faces.each do |v1, v2, v3, n|
        f.printf("f %d//%d %d//%d %d//%d\n", v1, n, v2, n, v3, n)
      end
    end
  end
end

# === MAIN ===

FileUtils.mkdir_p(OUTPUT_DIR)

buckets  = Hash.new { |h, k| h[k] = [] }
skipped  = 0
centers  = []

Sketchup.active_model.entities.each do |e|
  case e
  when Sketchup::Group, Sketchup::ComponentInstance, Sketchup::Face
    c = e.bounds.center
    centers << [c.x.to_f, c.y.to_f, c.z.to_f]   # raw inches (SketchUp internal)
    ij = tile_for_position(c)
    if ij
      buckets[ij] << e
    else
      skipped += 1
    end
  end
  # Edges and other entities are ignored.
end

puts "tiles populated: #{buckets.size}, entities skipped: #{skipped}"

# --- Diagnostics: when bucketing fails, print the actual coordinate range so
# you can pick the right UNIT / offset / step.
if buckets.empty? && !centers.empty?
  xs_in, ys_in, zs_in = centers.transpose
  puts ""
  puts "DIAGNOSTIC — no entity matched a tile. Center coordinates in SketchUp's"
  puts "internal inches (always inches, regardless of your model's display unit):"
  printf "  X range: %.3f to %.3f inches\n", xs_in.min, xs_in.max
  printf "  Y range: %.3f to %.3f inches\n", ys_in.min, ys_in.max
  printf "  Z range: %.3f to %.3f inches\n", zs_in.min, zs_in.max
  puts ""
  puts "  ...and the same values converted by the current UNIT (#{UNIT.to_f} in/UNIT):"
  xs_u = xs_in.map { |v| v / UNIT.to_f }
  ys_u = ys_in.map { |v| v / UNIT.to_f }
  printf "  X user: %.3f to %.3f   (grid expects ~  0 .. ~%d)\n",
         xs_u.min, xs_u.max, FILE_NAMES.map(&:length).max * TILE_STEP
  printf "  Y user: %.3f to %.3f   (grid expects ~-%d .. ~ 0)\n",
         ys_u.min, ys_u.max, FILE_NAMES.length * TILE_STEP
  puts ""
  puts "Pick the UNIT that makes 'X user' fall roughly into 0..#{(FILE_NAMES.map(&:length).max * TILE_STEP).to_i}"
  puts "and 'Y user' into -#{(FILE_NAMES.length * TILE_STEP).to_i}..0, then re-run."
  puts "First 5 entity centers (user units):"
  centers.first(5).each do |c|
    printf("  (%8.2f, %8.2f, %8.2f)\n",
           c[0] / UNIT.to_f, c[1] / UNIT.to_f, c[2] / UNIT.to_f)
  end
end

MTL_FILE_NAME = "materials.mtl"
write_mtl(File.join(OUTPUT_DIR, MTL_FILE_NAME))
puts "wrote shared #{MTL_FILE_NAME} (#{Sketchup.active_model.materials.length} materials + _default)"

written = 0
identity = Geom::Transformation.new
buckets.each do |(i, j), ents|
  name     = FILE_NAMES[j][i]
  filepath = File.join(OUTPUT_DIR, "#{name}.obj")

  by_mat = {}
  ents.each do |e|
    case e
    when Sketchup::Group
      collect_by_material(e.entities, e.transformation, e.material, by_mat)
    when Sketchup::ComponentInstance
      collect_by_material(e.definition.entities, e.transformation, e.material, by_mat)
    when Sketchup::Face
      collect_by_material([e], identity, nil, by_mat)
    end
  end

  cx_u =  TILE_OFFSET + TILE_STEP * i
  cy_u = -(TILE_OFFSET + TILE_STEP * j)
  write_obj(by_mat, filepath, name, cx_u, cy_u, MTL_FILE_NAME)

  total_tris = by_mat.values.map(&:length).inject(0, :+)
  puts "  wrote #{name}.obj  (#{total_tris} tris, #{by_mat.size} materials, from #{ents.size} entities)"
  written += 1
end

puts "done. #{written} OBJ files in #{OUTPUT_DIR}"
