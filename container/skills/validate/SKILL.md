---
name: validate
description: Verify implementation against specifications
user-invocable: true
---

# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

## Initial Setup

When invoked:

1. **Determine context**:
   - Are you in an existing conversation where implementation just happened?
   - Or starting fresh and need to discover what was implemented?

2. **Locate the plan**:
   - If plan path provided, use it
   - Otherwise, check `plans/` directory for recent plans
   - Look for plans with checkmarks indicating implementation

3. **Respond appropriately**:
```
I'll validate the implementation against the plan.

[If in existing conversation]:
I'll verify the work we just completed.

[If starting fresh]:
Please provide the plan file to validate against, or I can check for recently implemented plans.
```

## Validation Process

### Step 1: Context Discovery

If starting fresh or need more context:

1. **Read the implementation plan** completely
2. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Identify key functionality to verify

3. **Spawn parallel research tasks** to discover implementation:
   ```
   Task 1 - Verify database changes:
   Research if migration [N] was added and schema changes match plan.
   Check: migration files, schema version, table structure
   Return: What was implemented vs what plan specified

   Task 2 - Verify code changes:
   Find all modified files related to [feature].
   Compare actual changes to plan specifications.
   Return: File-by-file comparison of planned vs actual

   Task 3 - Verify test coverage:
   Check if tests were added/modified as specified.
   Run test commands and capture results.
   Return: Test status and any missing coverage
   ```

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion

2. **Run automated verification**:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

3. **Assess manual criteria**:
   - List what needs manual testing
   - Provide clear steps for user verification

4. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

### Step 2.5: Goal-Backward Verification

Go beyond task completion -- verify the codebase actually delivers what was promised.

1. **Extract must-haves from the plan**:
   - Read each phase's "Success Criteria" and "Overview"
   - Identify observable truths: what must be TRUE from a user's perspective
   - Map each truth to required artifacts (files) and key links (connections)

2. **Three-level artifact analysis** for each required artifact:

   | Level | Check | Question |
   |-------|-------|----------|
   | **Exists** | File/function present | `Does the file exist? Is the function defined?` |
   | **Substantive** | Real code, not stub | `Is this actual implementation or placeholder?` |
   | **Wired** | Connected and used | `Is this imported, called, routed, rendered?` |

3. **Stub detection** -- flag these patterns as NOT substantive:
   - `return null`, `return {}`, `return undefined`
   - `// TODO`, `// FIXME`, `// placeholder`
   - `throw new Error("Not implemented")`
   - Empty function bodies, `pass` in Python
   - `onClick={() => {}}`, empty event handlers
   - `Response.json({ message: "Not implemented" })`
   - Functions defined but never imported/called

4. **Produce verification matrix**:

   ```markdown
   ## Goal-Backward Verification

   | Truth | Artifact | Exists | Substantive | Wired | Status |
   |-------|----------|--------|-------------|-------|--------|
   | User can login | src/auth/login.ts | Y | Y | Y | VERIFIED |
   | Session persists | src/auth/session.ts | Y | Y | N | ORPHANED |
   | Errors display | src/components/Error.tsx | Y | N | - | STUB |
   | Rate limited | src/middleware/rate.ts | N | - | - | MISSING |
   ```

5. **Gap structuring** -- for any non-VERIFIED items:
   ```markdown
   ### Gaps Found

   #### Gap 1: Session persistence (ORPHANED)
   - **Truth**: "Session persists across page reloads"
   - **Issue**: session.ts exists and is substantive but never imported in app routes
   - **Fix**: Import and wire session middleware in src/app.ts

   #### Gap 2: Error display (STUB)
   - **Truth**: "Errors display to user"
   - **Issue**: Error.tsx returns null -- placeholder component
   - **Fix**: Implement error rendering with message prop
   ```

6. **Include in validation report** (Step 4) under a "Goal-Backward Verification" section

### Step 3: Code Quality Review

Spawn parallel Task agents for thorough review:

```
Task 1: "Review implementation of [Phase 1 feature]"
- Check if implementation matches plan specifications
- Verify error handling and edge cases
- Look for potential bugs or issues
- Return specific findings with file:line references

Task 2: "Verify test coverage for [feature]"
- Check if tests were added as specified
- Verify test quality and coverage
- Look for missing test cases
- Return test file locations and coverage gaps

Task 3: "Check for regressions in [related component]"
- Verify existing functionality still works
- Check for breaking changes
- Look for unintended side effects
- Return any concerning changes
```

### Step 4: Generate Validation Report

Create comprehensive validation summary:

```markdown
# Validation Report: [Plan Name]

**Date**: [Current date and time]
**Plan**: plans/[plan_file].md
**Validation Type**: [Automated | Manual | Comprehensive]

## Implementation Status

### Phase Completion
Phase 1: [Name] - Fully implemented
Phase 2: [Name] - Fully implemented
Phase 3: [Name] - Partially implemented (see issues)

### Files Modified
`src/auth/oauth.js` - Added as specified
`src/config/auth.config.js` - Updated correctly
`tests/auth.test.js` - Missing test cases

## Automated Verification Results

### Build & Compilation
Build passes: `npm run build` (2.3s)
TypeScript: No errors

### Tests
Unit tests: 142 passing
Integration tests: 2 failing
  - Error in OAuth callback test (timeout)
  - Error in token refresh test (undefined variable)

### Code Quality
Linting: Clean (ESLint)
Coverage: 78% (target was 80%)

## Code Review Findings

### Matches Plan
- OAuth2 flow implemented correctly
- Token storage follows security requirements
- Error handling comprehensive

### Deviations from Plan
- Used different library than specified (passport vs manual)
  - Impact: Positive - more maintainable
- Added extra validation not in plan
  - Impact: Positive - improved security

### Potential Issues
**Performance**: Token validation happens on every request
  - Recommendation: Add caching layer

**Security**: Refresh tokens stored in localStorage
  - Recommendation: Use httpOnly cookies

**Missing**: Rate limiting not implemented
  - Required by plan Phase 2

## Manual Testing Required

The following require manual verification:

### User Interface
- [ ] OAuth login button appears correctly
- [ ] Redirect flow works smoothly
- [ ] Error messages display appropriately

### Integration Testing
- [ ] Works with Google OAuth provider
- [ ] Works with GitHub OAuth provider
- [ ] Token refresh happens seamlessly

### Performance Testing
- [ ] Login completes within 3 seconds
- [ ] Handles 100 concurrent logins

## Recommendations

### Immediate Actions
1. Fix failing integration tests
2. Add missing rate limiting
3. Increase test coverage to 80%

### Before Production
1. Move refresh tokens to secure storage
2. Add token validation caching
3. Complete manual testing checklist

### Nice to Have
1. Add OAuth provider abstraction
2. Implement token rotation
3. Add audit logging

## Summary

**Overall Status**: **Mostly Complete**

The implementation follows the plan well with some positive deviations. However, there are 2 failing tests and missing rate limiting that must be addressed before this can be considered complete.

**Next Steps**:
1. Fix the failing integration tests
2. Implement rate limiting (Phase 2 requirement)
3. Complete manual testing
4. Address security recommendations
```

Save to: `validation/YYYY-MM-DD_HH-MM-SS_planname.md`

## Interactive Mode

After presenting the report, ask:

```
Would you like me to:
1. Help fix the failing tests?
2. Implement the missing features?
3. Run specific additional checks?
4. Generate a checklist for manual testing?
```

## Best Practices

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Think critically** - Question if the implementation truly solves the problem
4. **Consider maintenance** - Will this be maintainable long-term?
5. **Be constructive** - Provide actionable recommendations

## Validation Checklist

Always verify:
- [ ] All phases marked complete are actually done
- [ ] Automated tests pass
- [ ] Code follows project conventions
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Performance is acceptable
- [ ] Security considerations addressed
- [ ] Documentation updated if needed

## Common Validation Commands

```bash
# JavaScript/TypeScript
npm test
npm run lint
npm run typecheck
npm run build

# Python
pytest
python -m pytest --cov
flake8
mypy

# Go
go test ./...
go vet ./...
golangci-lint run

# Rust
cargo test
cargo clippy
cargo fmt --check

# Generic
make test
make check
make lint
```

## When Validation Fails

If validation reveals issues:

1. **Categorize by severity**:
   - Blockers: Must fix before merge
   - Important: Should fix soon
   - Nice to have: Can be addressed later

2. **Provide fixes when possible**:
   - For simple issues, suggest the fix
   - For complex issues, outline an approach

3. **Update the plan**:
   - Add checkboxes for fixes needed
   - Note which phases need rework

Remember: Good validation catches issues before they reach production. Be constructive but thorough in identifying gaps or improvements.
