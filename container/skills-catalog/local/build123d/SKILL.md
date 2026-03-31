---
name: build123d
description: Create parametric 3D models with Build123d (Python CAD on OpenCASCADE). Trigger on 'parametric model', 'Python CAD', 'complex geometry', 'STEP export', 'assembly model', 'build123d', or when the user needs advanced solid modeling beyond basic OpenSCAD primitives. Do NOT trigger for simple box/cylinder shapes where OpenSCAD suffices.
---

# 3D Modeling with Build123d

Build123d is a Python CAD library built on OpenCASCADE — more powerful than OpenSCAD for complex geometry, native STEP/STL export, and cleaner syntax for assemblies and parametric models.

## Workflow

1. Write a `.py` Build123d script to `/workspace/group/`
2. Run it: `python3 /workspace/group/model.py`
   - This exports `/workspace/group/model.stl` and `/workspace/group/model.step`
3. Render a preview PNG using trimesh:
   ```bash
   python3 -c "
   import trimesh
   mesh = trimesh.load('/workspace/group/model.stl')
   scene = mesh.scene()
   png = scene.save_image(resolution=[800,600])
   open('/workspace/group/render.png','wb').write(png)
   "
   ```
4. Package: `zip model.zip *.py *.stl *.step 2>/dev/null; true`
5. Send via `mcp__nanoclaw__send_files`

## Script Template

```python
from build123d import *
from build123d import export_stl, export_step

with BuildPart() as part:
    Box(50, 30, 20)
    fillet(part.edges(), radius=2)

export_stl(part.part, "/workspace/group/model.stl")
export_step(part.part, "/workspace/group/model.step")
print("Exported model.stl and model.step")
```

## Common Patterns

### Basic shapes
```python
Box(width, depth, height)
Cylinder(radius, height)
Sphere(radius)
```

### Boolean subtract (hole)
```python
with BuildPart() as part:
    Box(50, 50, 20)
    with Locations((0, 0, 10)):
        Cylinder(10, 25, mode=Mode.SUBTRACT)
```

### Fillets and chamfers
```python
fillet(part.edges(), radius=2)
chamfer(part.edges().filter_by(Axis.Z), length=1)
```

### Sketch-based extrusion
```python
with BuildPart() as part:
    with BuildSketch(Plane.XY):
        Rectangle(40, 20)
        Circle(8, mode=Mode.SUBTRACT)
    extrude(amount=15)
```

### Assemblies
```python
from build123d import Compound, Location
assembly = Compound(children=[base_part, other_part.moved(Location((20, 20, 10)))])
export_stl(assembly, "/workspace/group/assembly.stl")
export_step(assembly, "/workspace/group/assembly.step")
```

## Sending Output

```python
mcp__nanoclaw__send_files(
  files=[
    {"path": "/workspace/group/render.png", "name": "render.png"},
    {"path": "/workspace/group/model.zip",  "name": "model.zip"}
  ],
  caption="Here's your parametric model — STL + STEP included"
)
```

If render fails, send just the zip — STL + STEP open in Fusion 360, FreeCAD, SolidWorks.

## OpenSCAD vs Build123d

- **Build123d**: assemblies, fillets, STEP export, sketch workflows, CAD interop
- **OpenSCAD**: simple procedural geometry, fast iteration
