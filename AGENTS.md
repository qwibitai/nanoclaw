# NanoClaw: Agent Quality Standards

**Project**: Personal Claude assistant with WhatsApp integration and isolated container agents  
**Tech Stack**: TypeScript, Node.js, SQLite, Apple Container  
**Philosophy**: Minimalism, security, and explicit requirements

---

## Minimalist Engineering Philosophy

**Every line of code is a liability.** Before creating anything:

- **LESS IS MORE**: Question necessity before creation
- **Challenge Everything**: Ask "Is this truly needed?" before implementing
- **Minimal Viable Solution**: Build the simplest thing that fully solves the problem
- **No Speculative Features**: Don't build for "future needs" - solve today's problem
- **Prefer Existing**: Reuse existing code/tools before creating new ones
- **One Purpose Per Component**: Each function/module should do one thing well

### Pre-Creation Challenge (MANDATORY)

Before creating ANY code, ask:
1. Is this explicitly required by the GitHub issue?
2. Can existing code/tools solve this instead?
3. What's the SIMPLEST way to meet the requirement?
4. Will removing this break core functionality?
5. Am I building for hypothetical future needs?

**If you cannot justify the necessity, DO NOT CREATE IT.**

---

## Context7: Documentation First

Before writing ANY code, check Context7 for current documentation:
- TypeScript/Node.js APIs and syntax
- Framework patterns and best practices
- Configuration options and type definitions

Training data may be outdated. Context7 provides authoritative, up-to-date documentation.

---

## Development Workflow

### Issue-Driven Development (NON-NEGOTIABLE)

All work must be driven by a GitHub issue:

```bash
# 1. Check issue requirements
gh issue view #123

# 2. Verify feature branch exists
git status  # Must NOT be on main/master

# 3. Implement according to issue scope
# Only implement what's explicitly listed in the issue

# 4. Verify locally (see Quality Gates)

# 5. Report completion to Project Manager
```

**Scope Control Protocol:**
- **READ**: Full GitHub issue content for requirements
- **VALIDATE**: Work matches issue scope exactly
- **REFUSE**: Any work not explicitly listed in issue
- **EXPAND**: Update issue before adding scope
- **COMPLETE**: Only when ALL requirements are met

---

## Pre-Push Quality Gates (LOCAL VERIFICATION)

**CI is for VERIFICATION, not DISCOVERY.**

Before any `git push`, ALL checks must pass locally:

### 1. TypeScript Type Checking
```bash
npm run typecheck
```
- Zero type errors required
- No `@ts-ignore` suppressions allowed
- Generic types must be properly constrained

### 2. Code Build
```bash
npm run build
```
- Compiles without errors
- Output goes to `dist/` directory

### 3. Linting (ESLint)
```bash
npm run lint 2>/dev/null || npx eslint src/ --fix
```
- Zero linting errors required
- Auto-fix where possible

### 4. Code Formatting (Prettier)
```bash
npx prettier --check src/ || npx prettier --write src/
```
- Consistent formatting across codebase

### 5. Manual Code Review
- No `TODO`, `FIXME`, `HACK`, `XXX` comments in source
- No stub functions returning empty values
- Complete error handling (no silent failures)
- Security implications reviewed (especially: mount paths, IPC, container spawning)

**Never push to "see if CI catches anything." Fix locally first.**

---

## Testing Standards

### Test Requirements

- **Coverage Threshold**: 80% minimum for new code
- **Approach**: Test-Driven Development (TDD) preferred
- **Framework**: vitest (lightweight, TypeScript-native)
- **Strategy**: Unit tests for utilities, integration tests for container/IPC logic

### Testing Checklist

- [ ] Tests written before implementation (TDD)
- [ ] Coverage ≥80% for new code
- [ ] Edge cases covered (null, empty, error conditions)
- [ ] No duplicate test logic
- [ ] Tests pass locally (0 failures)

### Running Tests

```bash
npm run test                    # Run all tests
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
npm run test -- src/foo.test   # Single file
```

### Writing Tests

```typescript
// Good: Clear intent, specific assertions
describe('ContainerRunner', () => {
  it('should spawn container with correct mounts', async () => {
    const runner = new ContainerRunner(config);
    const result = await runner.spawn(testGroup);
    
    expect(result.mounts).toContainEqual(
      expect.objectContaining({ source: '/tmp/test', target: '/mnt' })
    );
  });

  it('should fail if mount source does not exist', async () => {
    const runner = new ContainerRunner(config);
    
    await expect(
      runner.spawn({ ...testGroup, mountPath: '/nonexistent' })
    ).rejects.toThrow('Mount source not found');
  });
});
```

---

## Code Style & Conventions

### TypeScript Standards

**File Organization:**
- One class/interface per file (unless tightly coupled)
- Exports at end of file
- Imports grouped: stdlib → packages → local

**Type Safety:**
- Explicit return types on all functions
- Use `unknown` before `any`
- Avoid optional chaining abuse (prefer null checks)
- Use `const` by default, `let` only if reassignment needed

**Naming:**
- `CONSTANT_CASE` for immutable config values
- `camelCase` for variables/functions
- `PascalCase` for classes/interfaces
- Prefix internal methods with `_` (e.g., `_parseConfig`)

**Error Handling:**
```typescript
// Good: Explicit error handling
try {
  await container.spawn();
} catch (error) {
  if (error instanceof ContainerError) {
    logger.error('Container spawn failed', { error: error.message });
    throw new AppError('Failed to start agent', { cause: error });
  }
  throw error; // Re-throw unknown errors
}

// Bad: Silent failures
try {
  await container.spawn();
} catch (error) {
  console.log('oops');
}
```

**Security-Critical Areas** (extra scrutiny required):
- Mount path validation (use `path.resolve()`, check against whitelist)
- IPC message validation (validate sender, message format)
- Container environment variables (never hardcode secrets)
- Database queries (parameterized queries only)

### Module Size Limits

- **Hard limit**: 500 lines per file (exceptions require justification)
- **Ideal target**: 300 lines or fewer
- **Refactor trigger**: File exceeds 500 lines OR has 3+ distinct responsibilities

When a file approaches limits:
1. Extract cohesive chunks into separate modules
2. Move related utilities to dedicated file
3. Create sub-packages for large features

---

## Git Workflow

### Branch Naming

```
feature/issue-{NUMBER}-short-description  # New feature
fix/issue-{NUMBER}-short-description       # Bug fix
docs/issue-{NUMBER}-short-description      # Documentation
refactor/issue-{NUMBER}-short-description  # Code refactoring
```

Example: `feature/issue-42-whatsapp-group-routing`

### Conventional Commits

Format: `<type>(<scope>): <subject>`

```
feat(container): add memory limit configuration
fix(ipc): handle abrupt client disconnection gracefully
docs(setup): update install instructions for Node 20+
refactor(db): extract query building into separate module
test(config): add validation for trigger patterns
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation only
- `test` - Tests only (no source changes)
- `refactor` - Code refactoring (no behavior change)
- `perf` - Performance improvement
- `chore` - Build, deps, tooling

### Commit Guidelines

- Commits should be logical, focused units
- Each commit should pass quality gates independently
- Avoid committing unrelated changes together
- Commit message body explains WHY, not WHAT

```
# Good
feat(scheduler): add cron job retry logic

When a scheduled task fails, retry up to 3 times with exponential backoff.
This prevents transient network failures from losing task execution.

Fixes #45

# Bad
feat: fixed stuff and updated things
```

### Pull Request Process

1. Create feature branch: `git checkout -b feature/issue-42-...`
2. Pass all local quality gates
3. Push with descriptive commits
4. Create PR with reference to issue: `Closes #42`
5. Code review (assigned to @code-review-specialist)
6. Post-approval: rebase and merge (squash not recommended for audit trail)

---

## Documentation Policy

### The 200-PR Test

Before creating documentation, ask: **"Will this be true in 200 PRs?"**

- **YES** → Document the principle (WHY it matters)
- **NO** → Use code comments (WHAT/HOW it works)

### Forbidden Documentation

Never create:
- Implementation summaries (use git history instead)
- Issue drafts or RFC documents (create issues in GitHub)
- Fix notes or scratch files
- TODO lists (create GitHub issues instead)
- "Nice to have" guides (if truly needed, create issue first)

### Documentation That Lasts

- **CLAUDE.md**: Project overview, key files, dev commands
- **README.md**: Philosophy, setup, architecture overview
- **docs/REQUIREMENTS.md**: Architecture decisions (ADRs)
- **docs/CONTRIBUTING.md**: Developer guide (only if project is public)
- **Code comments**: Complex algorithms, security decisions, gotchas

### Code Comments: When & Why

```typescript
// Good: Explains WHY a non-obvious choice was made
// We use exponential backoff here instead of linear because container
// startup failures tend to be transient, and immediate retries often fail
const backoff = Math.pow(2, attemptCount) * 100;

// Bad: Obvious from code
const result = await db.query(sql); // Execute the query

// Bad: Outdated after refactor
// TODO: Fix this later
function validateConfig(cfg: unknown) {
  return true; // For now
}
```

---

## Commands Reference

### Development

```bash
# Start with live reload
npm run dev

# Type checking
npm run typecheck

# Build production output
npm run build

# View built output
node dist/index.js

# Rebuild container image
./container/build.sh

# Service management (macOS)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Testing (when added)

```bash
npm run test                    # Run all tests
npm run test:watch             # Watch mode for development
npm run test:coverage          # Generate coverage report
```

### Code Quality

```bash
npm run typecheck              # Check types
npm run lint 2>/dev/null || npx eslint src/ --fix
npx prettier --write src/      # Format code
```

### Git Operations

```bash
# Check issue requirements
gh issue view #123

# View recent commits
git log --oneline -10

# See what changed
git diff main...HEAD

# Verify nothing is staged before push
git status
```

---

## Security Considerations

This project handles sensitive operations that require extra scrutiny:

### Mount Path Security

- Always use `path.resolve()` and `path.normalize()` on mount paths
- Validate against a whitelist of allowed directories
- Never allow `..` or symlink escapes
- Log all mount operations for audit trail

### IPC Security

- Validate sender identity before processing messages
- Parameterize all IPC message structures
- Reject messages with unexpected fields
- Log suspicious patterns (repeated failures, invalid senders)

### Container Environment

- Never bake secrets into container images
- Pass secrets only through environment variables or mounted files
- Rotate secrets regularly
- Audit container access logs

### Error Messages

- Don't leak implementation details in error messages shown to users
- Log full details internally for debugging
- Be explicit about permission/security errors to admins

---

## Minimalist Practices in This Project

### What We DON'T Do

- ❌ Don't add middleware layers without clear necessity
- ❌ Don't create abstractions before they're needed (YAGNI)
- ❌ Don't add configuration options for "future flexibility"
- ❌ Don't log everything (be intentional about logging)
- ❌ Don't create utility functions for single-use code
- ❌ Don't add dependencies without trying stdlib first

### What We DO Do

- ✅ Use stdlib (fs, path, crypto) before npm packages
- ✅ Keep functions small and focused
- ✅ Question every new file/module addition
- ✅ Prefer boring, readable code over clever code
- ✅ Fail fast and explicitly (don't hide errors)
- ✅ Delete dead code without hesitation

---

## When to Escalate

### To Project Manager
- Scope uncertainty (issue requirements unclear)
- Architecture decisions needed (beyond current design)
- Dependencies on other team members
- Blocked on external resources

### To Code Review Specialist
- Code review needed before merge
- Security implications require expert review
- Complex refactoring needs architectural approval

### To Research Specialist
- Need investigation before implementation
- Architecture research required
- Performance benchmarking needed
- Proof of concept before commitment

---

## Quality Checklist (Final Before Push)

- [ ] All work matches GitHub issue scope exactly
- [ ] TypeScript compiles with zero errors (`npm run typecheck`)
- [ ] Builds successfully (`npm run build`)
- [ ] Code is formatted (`npx prettier --check src/`)
- [ ] All new code has 80%+ test coverage
- [ ] No `@ts-ignore`, `@eslint-disable`, or similar suppressions
- [ ] No TODO/FIXME/HACK comments in source
- [ ] Error handling is complete (no silent failures)
- [ ] Security review done for sensitive code (mounts, IPC, containers)
- [ ] Commits follow conventional commit format
- [ ] PR title references issue: "Closes #123"
- [ ] Local verification complete (tests pass, linting passes)
