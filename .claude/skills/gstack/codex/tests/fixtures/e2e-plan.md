# E2E Test Plan

**Goal:** verify /codex implement end to end using a scripted fake codex.

**Architecture:** two tasks in one wave, each creates one file.

**Test command:** `test -r a.txt && test -r b.txt`

## Parallelization

- Wave 1: Tasks 1, 2

### Task 1: alpha file

**Files:**
- Create: `a.txt`

- [ ] **Step 1: Create a.txt**

Run: `test -r a.txt`

### Task 2: beta file

**Files:**
- Create: `b.txt`

- [ ] **Step 1: Create b.txt**

Run: `test -r b.txt`
