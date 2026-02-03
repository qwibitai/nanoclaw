---
name: convert-to-docker
description: This skill is deprecated. NanoClaw now uses Firecracker microVMs for isolation instead of Apple Container or Docker. Firecracker provides stronger isolation (each agent gets its own Linux kernel via KVM) than Docker (which shares the host kernel).
disable-model-invocation: true
---

# Convert to Docker (Deprecated)

This skill is **no longer applicable**. NanoClaw has been converted from Apple Container to **Firecracker microVMs**, which provide stronger isolation than Docker:

- **Firecracker**: Each agent gets its own Linux kernel via KVM (hypervisor-level isolation)
- **Docker**: Agents share the host kernel (namespace-level isolation)

The Firecracker conversion is already complete. See `src/firecracker-runner.ts` for the implementation.

If you need to modify the VM runtime, edit `src/firecracker-runner.ts` directly or use the `/debug` skill for troubleshooting.
