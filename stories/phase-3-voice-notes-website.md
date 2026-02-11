# Phase 3: Voice Notes & Static Website

**Goal**: Accept voice complaints via OpenAI Whisper transcription and launch the MLA's public website with WhatsApp bot link.

**Deliverable**: Constituents can send voice notes as complaints (transcribed by Whisper, oversized audio rejected). rahulkul.udyami.ai is live with MLA info and "File a Complaint" QR code.

---

## P3-S1: Deploy Whisper Pod on K8s Cluster

**As a** DevOps engineer
**I want** a faster-whisper pod deployed on the existing k8s cluster with an OpenAI-compatible REST API
**So that** voice notes can be transcribed locally without external API calls, supporting Hindi/Marathi/English

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S8 | Local development setup and end-to-end testing | Need a working bot foundation before adding voice infrastructure |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `faster-whisper` deployed as a pod in `tenant-rahulkul` namespace
2. [ ] Image: ARM64-compatible faster-whisper server
3. [ ] Model: `whisper-small` (good Hindi/Marathi/English accuracy, low resources)
4. [ ] Exposed as ClusterIP Service on port 9000 (internal only, not public)
5. [ ] REST API: `POST /v1/audio/transcriptions` (OpenAI-compatible endpoint)
6. [ ] CPU-only — no GPU required (runs on Mac Mini M4)
7. [ ] Resource limits: 512MB RAM, 1 CPU core
8. [ ] `kubectl get pods` shows whisper pod healthy
9. [ ] K8s manifests at `k8s/whisper/deployment.yaml` and `k8s/whisper/service.yaml`

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `k8s/whisper/deployment.yaml` | New | Whisper pod deployment manifest |
| `k8s/whisper/service.yaml` | New | ClusterIP service for whisper |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: K8s manifests are valid YAML
   - Test: deployment specifies correct image and resource limits
   - Test: service exposes port 9000 as ClusterIP
   - Test: whisper pod starts and reaches Ready state
   - Test: `POST /v1/audio/transcriptions` returns transcription for test audio
   - Test: Hindi audio transcribed correctly
   - Test: Marathi audio transcribed correctly
   - Test: English audio transcribed correctly
   - Edge case: pod restarts successfully after crash
2. **Run tests** — confirm they fail
3. **Implement** — K8s manifests and deploy
4. **Refactor** — optimize resource limits

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the Whisper deployment.
Use `/requesting-code-review` to validate:
- Image selection for ARM64
- Resource limits appropriateness
- Service networking approach

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify pod is healthy: `kubectl get pods -n tenant-rahulkul`
- Test transcription with sample audio files

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P3-S2: Voice Note Preprocessing and Validation

**As a** developer
**I want** a voice note handler that validates audio size/duration and sends valid files to Whisper for transcription
**So that** voice complaints are transcribed into text before being processed by the complaint agent, with oversized audio rejected gracefully

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P3-S1 | Deploy Whisper pod on k8s cluster | Need Whisper service running to send audio for transcription |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/voice.ts` created as voice note handler
2. [ ] Size guard: reject audio files > 1MB with message in user's language ("कृपया तुमची तक्रार २ मिनिटांत सांगा" / "Please keep your voice message under 2 minutes")
3. [ ] Duration guard: parse OGG header for duration, reject > 120 seconds
4. [ ] Voice note binary downloaded via Baileys `downloadMediaMessage()`
5. [ ] Audio sent to Whisper pod: `POST http://whisper-svc:9000/v1/audio/transcriptions` with language hint
6. [ ] Transcript text received from Whisper
7. [ ] `source: 'voice'` and `voice_message_id` logged in `conversations` table
8. [ ] Transcript passed as regular text to the complaint agent container
9. [ ] Voice complaint has same fields as text complaint (category, location, tracking ID)

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/voice.ts` | New | Voice note handler: validation, Whisper integration, transcript routing |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: audio file < 1MB accepted
   - Test: audio file > 1MB rejected with Marathi message for Marathi user
   - Test: audio file > 1MB rejected with Hindi message for Hindi user
   - Test: audio file > 1MB rejected with English message for English user
   - Test: audio duration < 120s accepted
   - Test: audio duration > 120s rejected with appropriate message
   - Test: valid audio sent to Whisper API and transcript received
   - Test: language hint passed to Whisper when user language is known
   - Test: transcript logged with `source: 'voice'` in conversations table
   - Test: transcript passed to complaint agent as regular text
   - Edge case: Whisper returns empty transcript — handled gracefully
   - Edge case: Whisper service unreachable — fallback message sent
2. **Run tests** — confirm they fail
3. **Implement** — voice handler
4. **Refactor** — clean up error handling

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the voice handler.
Use `/requesting-code-review` to validate:
- Audio validation approach
- Whisper API integration
- Error handling strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test with various audio file sizes and durations

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P3-S3: Modify WhatsApp Channel for Audio Messages

**As a** developer
**I want** the WhatsApp channel handler to detect audio messages and route them through the voice handler before the complaint agent
**So that** voice notes are automatically transcribed and processed as complaints

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P3-S2 | Voice note preprocessing and validation | Need the voice handler to route audio messages through |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/channels/whatsapp.ts` detects `audioMessage` type from Baileys `messages.upsert`
2. [ ] Audio metadata extracted: file size, duration (from message info), mimetype
3. [ ] Audio messages routed through `src/voice.ts` before the complaint handler
4. [ ] On Whisper failure: reply "मला तुमचा आवाज समजला नाही. कृपया लिहून पाठवा." (Marathi) / "I couldn't understand your voice message. Please type your complaint." (English)
5. [ ] Send a voice note (< 2 min) → bot transcribes via Whisper and registers complaint
6. [ ] Send a voice note (> 2 min) → bot rejects with polite message in user's language
7. [ ] Whisper failure gracefully falls back to "please type your complaint"

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/channels/whatsapp.ts` | Modify | Detect audioMessage, extract metadata, route through voice handler |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: audio message type detected from Baileys event
   - Test: file size extracted from audio message metadata
   - Test: duration extracted from audio message metadata
   - Test: audio message routed through `voice.ts` handler
   - Test: text message still routed directly to complaint handler (not through voice)
   - Test: Whisper failure returns fallback message in Marathi
   - Test: Whisper failure returns fallback message in English
   - Test: successful transcription results in complaint creation with tracking ID
   - Edge case: corrupted audio file handled gracefully
2. **Run tests** — confirm they fail
3. **Implement** — modify WhatsApp channel
4. **Refactor** — ensure clean audio routing path

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the audio message routing.
Use `/requesting-code-review` to validate:
- Audio detection and metadata extraction from Baileys
- Routing flow integration with existing pipeline
- Fallback message strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test with real voice notes if possible
- Verify text messages still work correctly

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P3-S4: Build Static Website with Astro

**As a** developer
**I want** a public-facing static website for the MLA built with Astro, with all content driven by markdown/YAML files
**So that** constituents can learn about their MLA, view initiatives, and easily file complaints via WhatsApp QR code

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S7 | Create tenant configuration system | Need tenant config for branding, MLA name, constituency info |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `website/` directory created in repo as Astro project
2. [ ] Hero section: MLA photo, constituency name, tagline
3. [ ] About section: brief bio, role, constituency info
4. [ ] Initiatives section: key achievements (configurable via markdown files)
5. [ ] News/Events section: feed from markdown files in `website/content/events/`
6. [ ] Photo Gallery section: grid layout, images from `website/public/gallery/`
7. [ ] File a Complaint section: WhatsApp bot link + QR code (`wa.me/{number}`)
8. [ ] Contact section: office address, phone, email, map embed
9. [ ] Footer: social media links
10. [ ] All content driven by markdown/YAML files (easy to update)
11. [ ] Responsive design, mobile-first
12. [ ] Marathi as primary language, English secondary
13. [ ] Site builds successfully with `npm run build` in `website/` directory

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `website/` | New | Entire Astro project directory |
| `website/astro.config.mjs` | New | Astro configuration |
| `website/src/pages/index.astro` | New | Main page with all sections |
| `website/src/components/` | New | Reusable UI components |
| `website/content/events/` | New | Markdown files for news/events |
| `website/public/gallery/` | New | Photo gallery images |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: Astro project builds without errors
   - Test: index page renders with hero section
   - Test: all required sections present in built HTML
   - Test: WhatsApp QR code link points to correct `wa.me` URL
   - Test: site is responsive (viewport meta tag, mobile styles)
   - Test: Marathi content displays correctly (Unicode rendering)
   - Test: event markdown files rendered correctly
   - Edge case: empty gallery directory handled gracefully
   - Edge case: missing event markdown files handled gracefully
2. **Run tests** — confirm they fail
3. **Implement** — build the Astro website
4. **Refactor** — optimize for performance

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the website structure.
Use `/requesting-code-review` to validate:
- Astro project structure
- Component architecture
- Content management approach
- Mobile-first responsive strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Preview site in browser
- Test on mobile viewport

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P3-S5: Website CI/CD Pipeline

**As a** DevOps engineer
**I want** a GitHub Actions workflow that auto-builds and deploys the Astro website on push
**So that** website updates are deployed automatically — dev branch to staging, main branch to production

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P3-S4 | Build static website with Astro | Need the Astro project to build and deploy |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `.github/workflows/website.yaml` created
2. [ ] Push to `dev` branch → build Astro → deploy to `dev.rahulkul.udyami.ai`
3. [ ] Push to `main` branch → build Astro → deploy to `rahulkul.udyami.ai`
4. [ ] Deployment target: nginx pod in existing k8s cluster
5. [ ] `dev.rahulkul.udyami.ai` updates on push to dev branch
6. [ ] Build failure stops deployment and reports error

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `.github/workflows/website.yaml` | New | CI/CD workflow for Astro website |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: workflow YAML is valid GitHub Actions syntax
   - Test: workflow triggers on push to `dev` branch
   - Test: workflow triggers on push to `main` branch
   - Test: workflow builds Astro project
   - Test: built assets deployed to correct target
   - Manual verification: push to dev and verify site updates
2. **Run tests** — confirm they fail
3. **Implement** — create workflow file
4. **Refactor** — optimize build steps

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the CI/CD pipeline.
Use `/requesting-code-review` to validate:
- Workflow trigger configuration
- Build and deploy strategy
- Secret management for k8s deployment

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test workflow with a sample push

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P3-S6: Kubernetes Deployment for Website

**As a** DevOps engineer
**I want** K8s manifests for the website pod with nginx, ingress routing, and TLS
**So that** the MLA's website is served from the existing k8s cluster with HTTPS and proper domain routing

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P3-S5 | Website CI/CD pipeline | Need the build pipeline to produce artifacts for k8s deployment |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `k8s/website/` directory with Deployment, Service, Ingress manifests
2. [ ] nginx pod serving Astro build output
3. [ ] Traefik ingress rules for domain routing (`rahulkul.udyami.ai`)
4. [ ] TLS via Let's Encrypt (cert-manager or Traefik ACME)
5. [ ] `rahulkul.udyami.ai` loads with all sections
6. [ ] Site is mobile-responsive when served from k8s

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `k8s/website/deployment.yaml` | New | nginx pod deployment |
| `k8s/website/service.yaml` | New | ClusterIP service |
| `k8s/website/ingress.yaml` | New | Traefik ingress rules with TLS |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: K8s manifests are valid YAML
   - Test: deployment specifies nginx image with correct mounts
   - Test: service exposes port 80
   - Test: ingress routes `rahulkul.udyami.ai` to website service
   - Test: TLS configured in ingress
   - Test: website pod reaches Ready state
   - Manual verification: site accessible via domain
2. **Run tests** — confirm they fail
3. **Implement** — K8s manifests
4. **Refactor** — optimize resource limits

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the k8s website deployment.
Use `/requesting-code-review` to validate:
- nginx configuration
- Ingress rules and TLS setup
- Resource limits

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify pod is healthy
- Test site via domain URL

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 3 is now complete — Phase 5 (Analytics) and Phase 8 (CMS) are unblocked.
