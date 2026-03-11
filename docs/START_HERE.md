# Start Here: NanoClaw + This Fork

This guide helps you answer two questions quickly:

1. How does NanoClaw work in general?
2. What is unique about this fork, and should you fork this repo or upstream?

## Recommended Reading Path

1. **Conceptual overview (10-15 min)**
   Read [README.md](../README.md) first, especially:

- `About This Fork`
- `Philosophy`
- `What It Supports`

2. **Architecture deep dive (20-30 min)**
   Read [SPEC.md](./SPEC.md) for the execution model and data flow, then [ARCHITECTURE.md](./ARCHITECTURE.md) for the multi-arm operating model used in this fork.

3. **Security model (15-20 min)**
   Read [SECURITY.md](./SECURITY.md) to understand trust boundaries, mount protections, credential handling, and privilege differences between main vs non-main groups.

4. **Remix and fork selectively (10-20 min)**
   Read [FORK_OVERVIEW.md](./FORK_OVERVIEW.md) to understand intentional divergences, then [FORK_SYNC.md](./FORK_SYNC.md) for practical upstream sync workflow.

5. **Installation and private config model (10-20 min)**
   Read [INSTALLATION_MODEL.md](./INSTALLATION_MODEL.md) for code/config separation, group patterns, and long-lived deployment structure.

6. **Before contributing**
   Read [CONTRIBUTING.md](../CONTRIBUTING.md). Substantive code contributions should usually go to upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Fast Decision: Fork This Repo or Upstream?

- Choose this fork if you want Trevor's opinionated docs overlays and a friends/family remix starting point.
- Choose upstream if you want the canonical project baseline with minimal fork-specific guidance.

If you start here and later want a cleaner baseline, you can switch to upstream using the sync flow in [FORK_SYNC.md](./FORK_SYNC.md).

For roadmap status and planned fork-specific work, see [ROADMAP.md](../ROADMAP.md).
