# Phase 8: WhatsApp CMS for Website Updates

**Goal**: MLA's team can update the website by sending WhatsApp messages to a content channel.

**Deliverable**: Send a photo with caption to admin group → appears on dev site → approve → goes live.

---

## P8-S1: Content Ingestion from WhatsApp

**As a** developer
**I want** the admin group handler to recognize CMS commands (`#gallery`, `#event`, `#achievement`, `#announcement`) and ingest content from WhatsApp messages
**So that** the MLA's team can add website content by simply sending messages to the admin WhatsApp group

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P3-S6 | Kubernetes deployment for website | Need the website running on k8s to update with CMS content |
| P5-S1 | Weekly constituency report | Need the admin handler infrastructure mature enough for CMS commands |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Photo + caption with `#gallery` → add to photo gallery
2. [ ] Photo + caption with `#event` → create news/event entry
3. [ ] Text with `#achievement` → add to achievements section
4. [ ] Text with `#announcement` → add to hero/banner area
5. [ ] Media files downloaded and stored
6. [ ] Markdown content files generated from messages
7. [ ] Invalid CMS command returns usage help

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/admin-handler.ts` | Extend | Add CMS command parsing and content ingestion |
| `src/cms/content-generator.ts` | New | Generate markdown/image files from WhatsApp messages |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `#gallery` command with photo creates gallery entry
   - Test: `#event` command with photo creates event markdown
   - Test: `#achievement` command creates achievement entry
   - Test: `#announcement` command updates hero section
   - Test: media file downloaded and stored in correct directory
   - Test: markdown file generated with correct frontmatter
   - Test: invalid command returns usage help
   - Edge case: message without photo but with `#gallery` tag — handled gracefully
   - Edge case: very long caption truncated appropriately
2. **Run tests** — confirm they fail
3. **Implement** — CMS content ingestion
4. **Refactor** — clean up content generation

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the CMS ingestion.
Use `/requesting-code-review` to validate:
- Command parsing approach
- Content file generation strategy
- Media storage location

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test each CMS command with sample content

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P8-S2: Auto-Commit to Dev Branch

**As a** developer
**I want** CMS content auto-committed to the dev branch, triggering a preview deployment
**So that** the MLA's team can preview website changes before they go live

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P8-S1 | Content ingestion from WhatsApp | Need content files generated before committing |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Bot generates content files (markdown + images)
2. [ ] Content auto-committed to `dev` branch of website repo
3. [ ] GitHub Actions builds and deploys to `dev.rahulkul.udyami.ai`
4. [ ] Bot sends preview link to admin group after commit

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/cms/git-publisher.ts` | New | Git commit and push to dev branch |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: content files committed to dev branch
   - Test: commit message includes CMS command details
   - Test: push to dev triggers CI/CD pipeline
   - Test: preview link sent to admin group
   - Edge case: git push failure handled with retry/error message
   - Edge case: concurrent CMS updates don't create merge conflicts
2. **Run tests** — confirm they fail
3. **Implement** — git publisher
4. **Refactor** — ensure safe git operations

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the auto-commit system.
Use `/requesting-code-review` to validate:
- Git authentication approach
- Branch management strategy
- Commit message format

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test end-to-end: CMS command → commit → preview

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P8-S3: Approval and Publish Flow

**As a** developer
**I want** an approval flow where `#approve` in the admin group merges dev to main, triggering production deploy
**So that** the MLA's team has a review step before website changes go live

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P8-S2 | Auto-commit to dev branch | Need dev preview before approval flow |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Admin reviews at `dev.rahulkul.udyami.ai`
2. [ ] `#approve` command in admin group triggers merge dev → main
3. [ ] Merge triggers production deploy via GitHub Actions
4. [ ] Bot confirms: "Website updated! Changes live at rahulkul.udyami.ai"
5. [ ] Full flow works end-to-end in < 5 minutes
6. [ ] `#approve` merges to main and site updates

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/cms/git-publisher.ts` | Extend | Add merge dev → main on approval |
| `src/admin-handler.ts` | Extend | Add `#approve` command handling |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `#approve` command triggers merge from dev to main
   - Test: merge triggers production deployment
   - Test: confirmation message sent to admin group
   - Test: full flow completes in under 5 minutes
   - Edge case: merge conflict handled with clear error message
   - Edge case: `#approve` with no pending changes returns appropriate message
2. **Run tests** — confirm they fail
3. **Implement** — approval and merge flow
4. **Refactor** — ensure safe merge operations

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the approval flow.
Use `/requesting-code-review` to validate:
- Merge strategy (fast-forward vs merge commit)
- Error handling for merge conflicts
- Timing requirements

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test full CMS → preview → approve → live flow

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P8-S4: Content Moderation

**As a** developer
**I want** uploaded images and text validated for appropriateness before publishing
**So that** inappropriate or harmful content is caught and flagged for explicit admin approval

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P8-S1 | Content ingestion from WhatsApp | Need content ingestion to add moderation layer to |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Uploaded images validated for file size and format
2. [ ] Claude (Sonnet) reviews caption/text for appropriateness
3. [ ] Potentially sensitive content flagged for explicit admin approval
4. [ ] Content moderation catches inappropriate uploads
5. [ ] Clean content proceeds to auto-commit without extra approval step

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/cms/content-moderator.ts` | New | Content moderation logic |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: valid image format (JPEG, PNG) accepted
   - Test: invalid image format rejected
   - Test: oversized image rejected with message
   - Test: appropriate text passes moderation
   - Test: inappropriate text flagged for review
   - Test: flagged content requires explicit admin approval before commit
   - Test: clean content auto-commits without delay
   - Edge case: moderation service failure — content held, not auto-published
2. **Run tests** — confirm they fail
3. **Implement** — content moderator
4. **Refactor** — tune moderation sensitivity

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan content moderation.
Use `/requesting-code-review` to validate:
- Moderation criteria
- Claude integration for text review
- Flagging workflow

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test with various content types

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 8 is now complete.
