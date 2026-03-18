---
name: openscad
description: Create 3D models with OpenSCAD. ONLY trigger when the user explicitly asks to 3D model, 3D print, or design a physical/printable object (e.g. "make a 3D model of X", "design a Gridfinity insert", "create something I can print"). Do NOT trigger for charts, images, diagrams, general "create" requests, or anything that doesn't specifically involve 3D geometry or printing.
---

# 3D Modeling with OpenSCAD

## IMPORTANT: File locations and sending

- **Always write files to `/home/node/work/`** — this is the writable workspace. Do NOT use `/workspace/group/` (root-owned, writes will fail) or `/tmp/` (not persistent)
- **You MUST use the `mcp__nanoclaw__send_files` tool** to send files to the user — do NOT just tell them where files are
- The `send_files` tool sends actual file attachments to the chat (images appear inline, ZIPs are downloadable)

## Workflow

1. Ensure the work directory exists: `mkdir -p /home/node/work`
2. Write `.scad` file(s) to `/home/node/work/`
3. Render preview: `scad-render /home/node/work/model.scad /home/node/work/render.png`
4. Package source: `cd /home/node/work && zip model.zip *.scad`
5. Send to chat: call `mcp__nanoclaw__send_files` with the render.png and model.zip

## Quick Example

```bash
# Ensure work directory exists
mkdir -p /home/node/work

# Write the model
cat > /home/node/work/coke_can.scad << 'SCAD'
$fn = 64;

module coke_can() {
    // Body
    color("red")
    cylinder(h = 122, r = 33, center = false);

    // Top rim
    translate([0, 0, 122])
    color("silver")
    cylinder(h = 2, r = 33, center = false);

    // Bottom
    color("silver")
    cylinder(h = 2, r = 33, center = false);
}

coke_can();
SCAD

# Render to PNG
scad-render /home/node/work/coke_can.scad /home/node/work/render.png

# Package and send
cd /home/node/work && zip model.zip *.scad
```

Then call `mcp__nanoclaw__send_files` with:
- files: `[{path: "/home/node/work/render.png", name: "render.png"}, {path: "/home/node/work/model.zip", name: "model.zip"}]`
- caption: "Here's your 3D model"

## OpenSCAD Language Reference

### Primitives

```scad
cube([width, depth, height]);
cube([10, 20, 30], center = true);

sphere(r = 10);
sphere(d = 20);  // diameter

cylinder(h = 20, r = 5);
cylinder(h = 20, r1 = 10, r2 = 5);  // cone
cylinder(h = 20, d = 10);

// Always set $fn for smooth curves
$fn = 64;  // 64 segments for circles
```

### Transformations

```scad
translate([x, y, z]) object();
rotate([x_deg, y_deg, z_deg]) object();
scale([x, y, z]) object();
mirror([1, 0, 0]) object();  // mirror along X
```

### Boolean Operations

```scad
union() { a(); b(); }         // combine
difference() { a(); b(); }    // subtract b from a
intersection() { a(); b(); }  // keep overlap only
```

### 2D to 3D

```scad
linear_extrude(height = 10) circle(r = 5);
rotate_extrude() translate([10, 0]) circle(r = 3);  // donut
```

### 2D Shapes

```scad
circle(r = 5);
square([10, 20], center = true);
polygon(points = [[0,0], [10,0], [5,10]]);
text("Hello", size = 10, font = "Liberation Sans");
```

### Modules and Variables

```scad
module bolt(length, diameter) {
    cylinder(h = length, d = diameter);
    translate([0, 0, length])
        cylinder(h = diameter * 0.6, d = diameter * 1.5);
}

bolt(20, 5);
bolt(length = 30, diameter = 8);
```

### Loops

```scad
for (i = [0:5]) translate([i * 10, 0, 0]) cube(5);
for (angle = [0:45:315]) rotate([0, 0, angle]) translate([20, 0, 0]) sphere(3);
```

### Color

```scad
color("red") cube(10);
color([0.2, 0.5, 0.8]) sphere(5);     // RGB 0-1
color([1, 0, 0, 0.5]) cube(10);        // RGBA with alpha
```

### Hull and Minkowski

```scad
hull() {                    // convex hull around children
    sphere(5);
    translate([20, 0, 0]) sphere(5);
}

minkowski() {               // rounded edges
    cube([10, 10, 5]);
    sphere(2);
}
```

### Import

```scad
import("part.stl");         // import STL
import("outline.svg");      // import SVG (2D)
```

## Rendering Tips

- Always set `$fn = 64` or higher for smooth curves
- Use `center = true` on primitives for easier positioning
- Keep models oriented with Z-up (OpenSCAD convention)
- For the preview render, default 1024x1024 is good. Use `scad-render model.scad render.png 2048,2048` for higher resolution
- Complex models with many booleans may take longer to render — keep it simple when possible

## Common Patterns

### Rounded Box

```scad
module rounded_box(size, radius) {
    minkowski() {
        cube([size.x - 2*radius, size.y - 2*radius, size.z - 2*radius], center = true);
        sphere(r = radius);
    }
}
```

### Threaded Rod (simplified)

```scad
module thread(length, diameter, pitch) {
    linear_extrude(height = length, twist = 360 * length / pitch)
        translate([diameter/2 - 0.5, 0]) circle(r = 0.5, $fn = 16);
}
```

### Hollow Cylinder (tube)

```scad
module tube(height, outer_r, wall) {
    difference() {
        cylinder(h = height, r = outer_r);
        translate([0, 0, -0.1])
            cylinder(h = height + 0.2, r = outer_r - wall);
    }
}
```
