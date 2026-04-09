# NanoClaw Product Brief

## Problem
Users need a personal agent that is secure by default, easy to customize in code, and reliable across messaging channels.

## Core Outcomes
- Isolated per-group execution and memory.
- Predictable routing and session behavior.
- Fast customization through small, understandable code changes.

## Scope
- Core orchestrator behavior (`src/index.ts`, queues, routing, persistence).
- Container/host runtime behavior and safety boundaries.
- Channel integrations and skill-driven extensibility.

## Non-Goals
- Multi-tenant SaaS control plane.
- Large framework abstractions that hide behavior.

## Active Acceptance Criteria
Define these per feature run in `.factory/run.json` and related plan artifacts.
