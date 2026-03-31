---
name: pymeshlab
description: Professional mesh cleanup and repair using PyMeshLab. Trigger on 'repair mesh', 'fix normals', 'decimate mesh', 'reduce polygons', 'smooth mesh', 'optimize for printing', 'fix manifold', 'fill holes', 'clean STL', or when the user has a mesh file that needs processing before printing or import.
---

# Mesh Cleanup with PyMeshLab

PyMeshLab provides 100+ professional-grade mesh processing filters from MeshLab. Use it to repair, optimize, and prepare meshes for 3D printing or import into game engines.

## Workflow

1. User provides or specifies an input mesh (STL, OBJ, PLY, etc.)
2. Write a Python script that applies the needed filters
3. Run: `python3 /workspace/group/repair.py`
4. Output: cleaned STL + a text report of changes made
5. Send both via `mcp__nanoclaw__send_files`

## Script Template — Full Print Prep Pipeline

```python
import pymeshlab
import os

INPUT  = "/workspace/group/input.stl"   # change as needed
OUTPUT = "/workspace/group/cleaned.stl"

ms = pymeshlab.MeshSet()
ms.load_new_mesh(INPUT)

original_faces = ms.current_mesh().face_number()
original_verts = ms.current_mesh().vertex_number()
report = []

# 1. Remove duplicate faces and vertices
ms.meshing_remove_duplicate_faces()
ms.meshing_remove_duplicate_vertices()
report.append("Removed duplicate faces/vertices")

# 2. Fix non-manifold edges and vertices
ms.meshing_repair_non_manifold_edges()
report.append("Repaired non-manifold edges")

# 3. Fix winding / normals
ms.apply_normal_normalization_per_vertex()
ms.meshing_re_orient_faces_coherently()
report.append("Normalized and reoriented normals")

# 4. Fill holes
ms.meshing_close_holes(maxholesize=30)
report.append("Filled holes (max size 30 edges)")

# 5. Remove isolated pieces (keep largest component)
ms.meshing_remove_connected_component_by_face_number(mincomponentsize=100)
report.append("Removed isolated small components")

# Save
ms.save_current_mesh(OUTPUT)

final_faces = ms.current_mesh().face_number()
final_verts = ms.current_mesh().vertex_number()

print("=== Mesh Repair Report ===")
for r in report:
    print(f"  ✓ {r}")
print(f"\nBefore: {original_verts} verts, {original_faces} faces")
print(f"After:  {final_verts} verts, {final_faces} faces")
print(f"\nSaved to: {OUTPUT}")
```

## Common Filters

### Cleanup
```python
ms.meshing_remove_duplicate_faces()
ms.meshing_remove_duplicate_vertices()
ms.meshing_remove_null_faces()
ms.meshing_remove_t_vertices()
ms.meshing_remove_unreferenced_vertices()
```

### Repair
```python
ms.meshing_repair_non_manifold_edges()
ms.meshing_repair_non_manifold_vertices()
ms.meshing_close_holes(maxholesize=30)    # close holes up to 30 edges
ms.meshing_re_orient_faces_coherently()   # fix winding
```

### Normals
```python
ms.apply_normal_normalization_per_vertex()
ms.apply_normal_smoothing_per_vertex()
```

### Simplification / Decimation
```python
# Reduce to target face count
ms.meshing_decimation_quadric_edge_collapse(
    targetfacenum=10000,
    qualitythr=0.3,
    preserveboundary=True,
    preservenormal=True
)

# Or reduce by percentage
ms.meshing_decimation_quadric_edge_collapse(
    targetperc=0.5   # keep 50% of faces
)
```

### Smoothing
```python
ms.apply_coord_laplacian_smoothing(stepsmoothnum=3)
ms.apply_coord_taubin_smoothing()  # smoother, less shrinkage
```

### Subdivision (increase detail)
```python
ms.meshing_surface_subdivision_midpoint(iterations=1)
ms.meshing_surface_subdivision_loop(iterations=1)
```

## Sending Output

Always send the cleaned mesh and a report:

```python
# Write report to file first
with open("/workspace/group/repair_report.txt", "w") as f:
    f.write(report_text)

mcp__nanoclaw__send_files(
  files=[
    {"path": "/workspace/group/cleaned.stl",       "name": "cleaned.stl"},
    {"path": "/workspace/group/repair_report.txt",  "name": "repair_report.txt"}
  ],
  caption="Mesh repaired — cleaned STL + report attached"
)
```

## Supported Input Formats

STL, OBJ, PLY, OFF, 3DS, COLLADA (.dae), X3D, and more. PyMeshLab handles all MeshLab-supported formats.

## Quick Reference — What to Apply When

- **Print prep (default)**: duplicate removal → non-manifold repair → hole fill → normal fix
- **Reduce file size / polygon count**: decimation_quadric_edge_collapse
- **Smooth rough surface**: laplacian or taubin smoothing
- **Fix inverted faces**: meshing_re_orient_faces_coherently
- **Clean scan data**: remove unreferenced vertices + isolated components + hole fill
