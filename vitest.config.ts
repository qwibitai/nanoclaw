import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'container/agent-runner/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        '**/*.d.ts',
        'src/types.ts',
        // Entry points (imperative main() with side effects) —
        // covered end-to-end by integration tests and manual runs.
        'src/index.ts',
        'container/agent-runner/src/index.ts',
        'container/agent-runner/src/main.ts',
        // Barrel file: just imports to trigger channel self-registration.
        'src/channels/index.ts',
        // Modules that wrap long-running I/O (spawned processes, SDK
        // `for await` loops, filesystem side effects in very specific
        // layouts) — unit testing them adds more mock scaffolding than
        // confidence. They're covered by integration tests and manual
        // run-through. When any of these is refactored to be purer,
        // drop its entry here.
        'src/host-runner.ts',
        'src/host-runner/setup.ts',
        'src/host-runner/build.ts',
        'container/agent-runner/src/query-runner.ts',
        'container/agent-runner/src/script-runner.ts',
        'container/agent-runner/src/workspace.ts',
        // Thin entry: reads env → creates server → connects stdio.
        // Only reachable when the subprocess is spawned (the MCP client
        // test spawns dist/ipc-mcp-stdio.js). The logic is in
        // ipc-mcp-stdio/ — fully covered by unit tests.
        'container/agent-runner/src/ipc-mcp-stdio.ts',
        // Orchestrator factories that wrap the full agent-spawn / message-
        // pipeline / polling loop. These are meaningfully covered by the
        // integration tests in src/__tests__/integration/ (which exercise
        // the flow end-to-end through a mocked host-runner) but v8
        // coverage collected in a vitest worker doesn't attribute those
        // factory-returned closures back to these source files. Listing
        // them here is explicit and reviewable — when they grow simple
        // enough for direct unit tests, drop the entry.
        'src/orchestrator/run-agent.ts',
        'src/orchestrator/process-group-messages.ts',
        'src/orchestrator/message-loop.ts',
        // Same family as the factories above — closures over OrchestratorState
        // that are exercised by integration tests but not attributable by v8.
        'src/orchestrator/channel-opts.ts',
        'src/orchestrator/webhook-bridge.ts',
        // Pure type-only module.
        'src/ipc/types.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      // Enforced quality bar after the full refactor (Phases A-H). The
      // excluded files above are all either (a) entry points / spawn wrappers,
      // (b) SDK for-await loops, or (c) factory-returned closures that v8
      // can't attribute. Every other source file contributes here.
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 80,
        statements: 90,
      },
    },
  },
});
