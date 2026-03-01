# Intent: container/build.sh modifications

## What changed
Changed the default container runtime from `docker` to `container` (Apple Container CLI).

## Key sections
- `CONTAINER_RUNTIME` default: `docker` → `container`
- All build/run commands use `${CONTAINER_RUNTIME}` variable (unchanged)

## Invariants
- The `CONTAINER_RUNTIME` environment variable override still works
- IMAGE_NAME and TAG logic unchanged
- Build and test echo commands unchanged

## Must-keep
- The `CONTAINER_RUNTIME` env var override pattern
- The test command echo at the end
