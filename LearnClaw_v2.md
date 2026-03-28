# LearnClaw v2
## Autonomous Personal Learning OS — Product Concept

*by Ekatra · March 2026*

---

## What It Is

LearnClaw is a personal learning engine that knows what you're trying to become — and works backward from that to structure everything automatically.

You tell it your exam and timeline. It becomes your autonomous study partner: builds the plan, delivers daily lessons, quizzes you, tracks what you're forgetting, and adjusts everything as you go.

**In one sentence:** *Tell it your goal. It runs your entire learning journey.*

---

## The Problem It Solves

Every learner preparing for a high-stakes exam faces the same five problems:

1. **They don't know what to study** — the syllabus is overwhelming, resources are scattered
2. **They don't know in what order** — wrong sequencing wastes weeks
3. **They study but forget** — no spaced repetition, no systematic revision
4. **Nobody holds them accountable** — motivation collapses without structure
5. **They can't measure progress honestly** — vague sense of "I've read a lot"

Existing tools solve one of these. NotebookLM answers questions from documents but never comes to you. Anki does spaced repetition but doesn't teach. Khan Academy teaches but doesn't know your exam or timeline. NanoClaw is autonomous but has no concept of learning. Knowt and Quizlet do flashcards but don't push to you or build a plan.

LearnClaw solves all five — unified, autonomous, and push-based.

---

## The Core Insight

**The rhythm is the product. The memory is the moat.**

Every other study tool is pull-based — you open the app when you remember to. LearnClaw pushes to you. It messages you. The friction of "what should I do today?" disappears. This converts intention into action without willpower.

The knowledge graph accumulated per learner over months is not replicable. It's not just memory — it's a detailed map of what each person knows vs. what they think they know, updated after every interaction, used to calculate exactly when they're about to forget something, and acted on autonomously.

Goals are the organizing layer — not documents, not tasks. Every lesson, quiz, and nudge is filtered through who you're trying to become.

---

## Design Principles

1. **Zero cost to the student by default.** Free models on OpenRouter. Student upgrades on their own terms.
2. **Zero infrastructure cost to Ekatra.** LLM inference is on the student's API key. Ekatra runs only the lightweight orchestration layer.
3. **80% there after 5 minutes.** Clone → setup → answer 3 questions → first lesson arrives tomorrow morning. No configuration.
4. **Prebuilt content carries the weight.** The less the model generates from scratch, the better the experience on free models. Pre-written lessons, pre-built quiz banks, and curated resource lists are model-agnostic.
5. **Graceful degradation.** If the free model is bad, send the raw pre-written lesson anyway. If the model fails to evaluate an answer, fall back to MCQ-only. The student never gets a broken experience.
6. **Revenue is embedded, not layered.** Every resource recommendation carries an affiliate link. Every coach suggestion carries a referral. The student never pays LearnClaw — but every interaction can generate revenue.

---

## Access Tiers

### Tier 1: Telegram Bot (primary — zero install)
Student messages the bot on Telegram. No install, no setup, no laptop required. Ekatra runs a shared multi-tenant instance. Each student gets their own namespace in SQLite.

**Cost to student:** $0 (free OpenRouter models)
**Cost to Ekatra:** ~$50/month VPS for 10,000 students (LLM cost is on student's key)

### Tier 2: Self-Hosted NanoClaw Fork (power users)
Student clones the repo, runs setup, pairs their own WhatsApp via Baileys. Full customization, private data, own API key. For the CS student or working professional who wants control.

**Cost to student:** Their own API key ($0–$15/month depending on model choice)
**Cost to Ekatra:** $0

### Tier 3: Institutional Deployment (B2B)
Coaching institute, university, or corporate L&D buys LearnClaw for their students/employees. Ekatra hosts, manages, provides analytics dashboard. Branded companion.

**Cost:** Per learner/month pricing. Ekatra's primary revenue stream.

---

## Model Tiers — Student's Choice

The LLM cost is entirely on the student's own account. LearnClaw connects to whatever they provide:

| Tier | Provider | Models | Monthly Cost | Features Unlocked |
|------|----------|--------|-------------|-------------------|
| Free | OpenRouter | Llama 3.1 8B, Gemma 2 | $0 | Daily lessons (pre-written), MCQ quizzes, current affairs, study plan, spaced repetition, resource recommendations |
| Upgrade | OpenRouter | Sonnet, Haiku, Mistral Large | $5–10 | Free-text answer evaluation, adaptive lesson personalization, deeper doubt-clearing |
| Premium | Anthropic API | Claude Sonnet / Opus | $10–20 | Mains answer writing practice + evaluation, Socratic conversations, cross-topic connection mapping, essay outlines |
| Power | Claude Code | Claude Agent SDK | Subscription | Self-hosted NanoClaw fork with full agent capabilities |

No feature toggle. No paywall on LearnClaw's side. The bot detects model quality on first setup via a calibration prompt and adjusts features automatically. Student upgrades their model → features unlock instantly.

---

## Onboarding Flow

### Tier 1 (Telegram — zero friction)

```
1. Student finds LearnClaw via friend/YouTube/Telegram group
2. Opens Telegram, searches @LearnClawBot
3. Sends /start
4. Bot: "To power your learning, I need an AI key.
        Here's how to get one free in 60 seconds:"
        [sends step-by-step screenshot guide for OpenRouter]
5. Student pastes API key
6. Onboarding conversation begins immediately
```

Total time to value: **under 5 minutes.**

### Tier 2 (Self-hosted — developer)

```
git clone https://github.com/ekatraone/learnclaw.git
cd learnclaw
claude
> /setup
```

Claude Code handles deps, Docker, WhatsApp pairing. Then onboarding conversation starts.

### The Onboarding Conversation

Three things extracted — conversation, not a form:

**1. Goal**
```
"I want to crack UPSC 2027"
"I'm preparing for USMLE Step 1"
"I need a 720+ on GMAT by March"
"I want to learn Python for data science"
```

**2. Current State**
```
"Starting from scratch"
"6 months in, weak on economy"
"Scored 580 on my practice GMAT"
```

**3. Constraints**
```
"2 hours every day, evenings"
"Working full time, weekends only"
"Exam is in 4 months"
```

On exam selection, LearnClaw loads the full pre-built exam package. Plan is adapted from a tested template, not generated from scratch. Resources are curated with real links.

```
Bot: Done. Your UPSC plan is ready.

     📋 Phase 1: NCERT Foundation (8 weeks)
     Starting tomorrow with Ancient India.

     I'll send you:
     → Daily lesson at 7 AM
     → Current affairs digest at 8 AM
     → Quiz at 9 PM
     → Weekly progress report on Sunday

     Your recommended books: [curated list with affiliate links]
     
     Want me to start now with a quick 5-min intro lesson?
```

---

## What Gets Auto-Generated

### WHO_I_AM.md
A living document updated as LearnClaw learns how the student thinks, struggles, and what examples resonate.

```markdown
Preparing for UPSC 2027 Prelims. Starting fresh.
4 hours daily, evenings after 7 PM.
Learns best through case studies, not definitions.
Struggles with factual recall (amendments, articles).
Responds better to evening quizzes than morning.
Weakest area: Economy. Strongest: Modern History.
```

### STUDY_PLAN.md
Phase-by-phase, adapted from exam package template. Auto-adjusts weekly.

### RESOURCE_LIST.md
Curated and sequenced from exam package. Every link is an affiliate/referral link where possible.

### HEARTBEAT.md
The autonomous engine — calculated from forgetting curves, available hours, and engagement patterns.

---

## Pre-Built Exam Packages — The Content Layer

This is what makes it "80% there." Each exam ships with structured data that the model enhances but doesn't generate from scratch:

```
/exams/upsc/
├── syllabus.json
│   Structured: subject → topic → subtopic
│   Each subtopic has:
│   - source_book + chapter
│   - weightage (last 10 years PYQ analysis)
│   - difficulty_rating
│   - common_misconceptions[]
│   - prerequisite_topics[]
│   - optimal_study_sequence_position
│
├── lessons/
│   Pre-written micro-lessons for high-weightage topics
│   ~200 lessons covering Prelims core
│   Stored as markdown, community-contributable
│   Model personalizes delivery, not generates from scratch
│   Fallback: raw lesson sent if model fails
│
├── quizzes/
│   Pre-built MCQ banks per topic (PYQ + original)
│   ~2000 questions, tagged by topic + difficulty
│   Delivered as Telegram polls (zero LLM calls to evaluate)
│   Model selects and sequences, not generates
│
├── current_affairs/
│   RSS feed URLs (The Hindu, Indian Express, PIB)
│   Syllabus-tag mapping rules
│   Template for daily digest format
│
├── plans/
│   6-month-prelims.json
│   12-month-complete.json
│   3-month-revision.json
│   Each: week-by-week topic sequence with resource mapping
│
├── resources.json
│   Books, courses, YouTube channels, mock tests
│   Each with: affiliate_link, priority_order,
│   when_to_start, estimated_hours
│   Examples:
│     - Amazon affiliate links for books
│     - Unacademy/TestBook referral codes for courses
│     - YouTube channels (free, no referral needed)
│
├── coaches.json
│   Verified tutors per subject area
│   booking_link, referral_code, hourly_rate
│   Expertise tags for matching to student weak areas
│
└── meta.json
    Exam name, conducting body, frequency,
    cutoff trends, topper strategy patterns
```

### Why Pre-Built Content Matters for Free Models

Free models (Llama 8B, Gemma 2) can:
- Select the right lesson from a bank and present it conversationally
- Run a quiz flow with pre-built MCQs
- Summarize RSS headlines
- Manage study plan state

Free models struggle with:
- Generating accurate curriculum from scratch
- Evaluating nuanced free-text answers
- Pedagogical adaptation for individual learning styles

**Design for the floor, delight at the ceiling.** Pre-written content ensures quality at every model tier.

### Launch Exam Set

| Exam | Market | Priority |
|------|--------|----------|
| UPSC CSE | Indian Civil Services — largest aspirant base | Week 1–2 |
| CAT | Indian MBA — second largest | Week 5–6 |
| JEE Main/Advanced | Indian Engineering | Community |
| NEET | Indian Medical | Community |
| GMAT | Global MBA | Community |
| GRE | Global Graduate | Community |
| USMLE Step 1/2 | US Medical Licensing | Community |
| CA Final | Chartered Accountancy | Community |
| CFA Level 1/2/3 | Finance Certification | Community |
| Custom | User-defined syllabus | Built-in |

Ekatra curates UPSC and CAT. Community contributes the rest via open-source exam package format.

---

## The Daily Experience

### Morning Lesson (autonomous trigger — 1 LLM call)

```
LearnClaw → Telegram, 7:00 AM

"Good morning Priya. Today: Article 356
(President's Rule). 8-minute lesson."

[Sends pre-written lesson, personalized by model]
[3-4 messages, plain language, real examples]
[Ends with: "Got it? Quiz tonight at 9."]
```

The lesson comes from the pre-written bank. The model adapts tone and examples to WHO_I_AM.md. If the model fails, the raw lesson is sent anyway.

### Current Affairs Digest (autonomous — 1 LLM call)

```
LearnClaw → Telegram, 8:00 AM

📰 Today's Exam-Relevant News:

1. [Economy] RBI monetary policy update
   → Links to: Indian Economy Ch 12
   → Prelims relevance: ⭐⭐⭐
   → Will quiz tonight

2. [Polity] SC ruling on Governor's powers
   → Links to: Laxmikant Ch 27-28
   → Mains relevance: GS2

3. [IR] India-ASEAN joint statement
   → Links to: International Relations

📝 Yesterday's revision: "Article 356 can be
   challenged — Bommai case (1994), 9-judge bench"
```

Sources: RSS feeds (no web scraping). Model summarizes and tags to syllabus. Falls back to headline-only if model fails.

### Evening Quiz (autonomous — zero LLM calls for MCQs)

```
LearnClaw → Telegram, 9:00 PM

"Quiz time. 3 questions, 5 minutes."

[Sends Telegram poll — native UI]
━━━━━━━━━━━━━━━━━━━━━
Article 356 deals with:
○ National Emergency
○ President's Rule in States  ← correct
○ Financial Emergency
○ Constitutional Amendment
━━━━━━━━━━━━━━━━━━━━━

[Student taps answer → instant result]
[No LLM call needed — deterministic evaluation]
[Pre-written explanation sent on wrong answer]
[SQLite updated: concept mastery, review schedule]
```

Telegram's native poll feature eliminates LLM calls for quiz evaluation entirely. Spaced repetition updates happen in SQLite without touching the model. Free-text answers (Mains practice) available only on paid model tiers.

### Sunday Weekly Report

```
LearnClaw → Telegram, 8:00 AM

📊 Week 6 Summary

Studied: 6/7 days (missed Thursday)
Quiz accuracy: 73% (up from 61%)
Lessons completed: 5

🟢 Strong: Ancient India, Fundamental Rights
🟡 Fading: Directive Principles (last seen 12 days ago)
🔴 Weak: Constitutional Amendments (3/4 wrong)

📅 Next week adjusted:
Mon: Re-teach Directive Principles (case studies)
Tue: Constitutional Amendments deep dive
Wed-Fri: Economy as scheduled

💡 You answer concept questions well but struggle
   with factual recall. Adding more factual drills.

📚 Suggested: [Unacademy video on amendments — referral link]

[Share your progress → shareable card for Telegram/WhatsApp/Instagram]
```

Weekly report uses template formatting + one small LLM call for the observation paragraph. Share card enables viral distribution.

---

## Mains Answer Writing (Paid Model Tier)

For UPSC Mains — the #1 skill gap no app solves well:

```
Weekend Mains Practice:

"Write a 150-word answer:
 Discuss the significance of the 73rd
 Constitutional Amendment in strengthening
 grassroots democracy."

[Student types or sends voice note]

LearnClaw evaluates:
✅ Good: Mentioned Panchayati Raj, reservation for women
⚠️ Missing: No mention of 11th Schedule, Article 243
⚠️ Structure: Introduction too long, conclusion missing
📝 Model answer framework provided
🎯 Score: 6/10 — improving from 4/10 three weeks ago
```

Only available on Sonnet/Opus tier — free models can't reliably evaluate answer quality.

---

## The Knowledge Graph

Every interaction updates a structured model:

```
concept: "Article 356"
  times_taught: 1
  times_quizzed: 3
  accuracy: 0.67
  last_seen: 2026-03-28
  forgetting_score: 0.43        ← SM-2, recalculated daily
  related: ["Federalism", "Governor's role",
            "Bommai case", "Emergency provisions"]
  misconception_detected: "Confused with Article 352"
  misconception_addressed: true
  best_explanation_style: "case_study"  ← learned from interactions
```

When `forgetting_score` drops below threshold → heartbeat fires a revision. Not because it's Tuesday. Because the math says you're about to forget it.

---

## Token Economy — Designed for Free Models

Daily LLM usage on free tier:

| Action | LLM Calls | Tokens | Notes |
|--------|-----------|--------|-------|
| Morning lesson | 1 | ~900 | Pre-written lesson + personalization prompt |
| Current affairs | 1 | ~1100 | RSS fetch (free) + summarization |
| Evening quiz (MCQ) | 0 | 0 | Telegram polls, deterministic evaluation |
| Ad-hoc questions | 1-3 | ~500 each | Student-initiated |
| Weekly report | 1 | ~800 | Template + observation paragraph |

**Daily total: 2-3 calls, ~2000 tokens.** Well within free model rate limits on OpenRouter. The design ensures Telegram's native features (polls, inline keyboards, document attachments) do the work that would otherwise require model inference.

---

## Revenue Model

Students don't pay LearnClaw. Revenue comes from:

### 1. Affiliate/Referral on Resources
Every book recommendation, course suggestion, and mock test link carries an affiliate code. Embedded in RESOURCE_LIST.md and contextual recommendations.

- Amazon Associates for books
- Unacademy, TestBook, Magoosh referral programs for courses
- Mock test series affiliate links

At 50,000+ active students recommending resources daily, this generates meaningful revenue.

### 2. Coach Marketplace Commissions
Curated tutors/coaches listed per exam and subject. Student books a session through LearnClaw's recommendation → LearnClaw takes 10-15% referral fee.

The coach gets qualified leads (LearnClaw knows the student's weak areas and can match intelligently). The student gets matched to relevant expertise.

### 3. Sponsored Exam Packages
A coaching institute sponsors the "CAT package" — their branding, their resource recommendations, their coaches featured. They pay Ekatra for the distribution channel. Student still gets free, high-quality content.

### 4. Institutional Licensing (Tier 3)
Coaching institutes, EdTech companies, government programs pay for branded deployments with analytics dashboards. Per learner/month pricing.

### 5. Premium Add-Ons (optional, never paywalled)
For students who want more: document ingestion (upload notes, LearnClaw integrates them), extended conversation history, voice-based tutoring. ₹199–499/month. Cheaper than a single coaching class.

### 6. Managed API Key
For students who can't set up OpenRouter: ₹99/month pass-through where Ekatra handles the API billing. Captures the non-technical majority.

---

## Document Ingestion (Paid Tier Feature)

Learners upload their own materials — syllabus PDFs, textbook chapters, past papers, handwritten notes. LearnClaw reads them against stated goals and integrates into the plan.

```
Priya uploads her UPSC mock exam paper.

LearnClaw: "Found 8 topics in this paper you
haven't covered. 3 appear repeatedly in past
exams — Cooperative Federalism, GST Council,
River Disputes. Prioritize these next week?"
```

Documents stored locally. Embeddings generated locally (nomic-embed, CPU-only for self-hosted; server-side for Telegram tier).

---

## Architecture

### Tier 1 Architecture (Telegram Bot — Multi-Tenant)

```
learnclaw/
├── bot.ts                # Telegram bot (grammy/telegraf)
│                         # Multi-tenant via user IDs
├── onboarding.ts         # Exam → level → schedule
│                         # Loads exam package, generates plan
├── model-router.ts       # Detects model quality via calibration
│                         # Routes features accordingly
├── heartbeat.ts          # setInterval per user
│                         # Morning lesson + evening quiz + news
├── lesson.ts             # Pulls pre-written lesson from package
│                         # Sends to model for personalization
│                         # Falls back to raw lesson on failure
├── quiz.ts               # Telegram polls for MCQ (zero LLM)
│                         # Free-text evaluation (paid models only)
├── news.ts               # RSS fetch + model summarize
│                         # Falls back to headlines-only
├── knowledge.ts          # SM-2 spaced repetition
│                         # Pure SQLite, no LLM needed
├── report.ts             # Template + minimal LLM for observations
├── share.ts              # Shareable progress cards for virality
├── referral.ts           # Affiliate link management + tracking
├── db.ts                 # SQLite multi-tenant
│                         # users, concepts, quiz_attempts,
│                         # lesson_history, review_schedule
└── /exams/               # Pre-built exam packages
    ├── upsc/
    ├── cat/
    ├── custom/
    └── format.md          # Spec for community contributions
```

Single Node.js process. One Telegram bot token. Multi-tenant via user IDs in SQLite. Heartbeat as setInterval checking what's due per user. No Docker needed. Node.js + SQLite on a $5 VPS.

### Tier 2 Architecture (Self-Hosted NanoClaw Fork)

```
BODY — NanoClaw fork (Node.js, single process)
  Container isolation, WhatsApp via Baileys,
  SQLite state, scheduled tasks, agent swarms

BRAIN — Claude Agent SDK (or OpenRouter)
  Lesson generation, quiz evaluation,
  plan adjustment, natural conversation

INTELLIGENCE — LearnClaw education layer
  Exam profiles, knowledge graph,
  spaced repetition, resource sequencing
```

Ships with learning-specific defaults baked in:
- Onboarding replaces generic NanoClaw /setup
- CLAUDE.md pre-structured with learner profile schema
- HEARTBEAT.md pre-written for learning cadence
- SQLite schema includes learning-specific tables
- Custom tools in src/tools/ (quiz, lesson, knowledge, plan)
- /sources mount for uploaded study materials

### Storage — All Local

```
SQLite              knowledge graph + session history
SQLite-vec          document embeddings (local vector search)
/sources/           uploaded PDFs, notes, past papers
Markdown files      WHO_I_AM, GOALS, STUDY_PLAN,
                    HEARTBEAT, RESOURCE_LIST
```

---

## Telegram-Native UX Design

Don't send walls of text. Use Telegram's native features:

- **Polls** for MCQ quizzes (native UI, zero LLM cost)
- **Inline keyboards** for branching ("Dive deeper?" / "Move on")
- **Document attachments** for weekly reports
- **Reply markup** for quick responses
- **Voice notes** for Mains answer submission (paid tier)
- **Share buttons** on progress cards for viral distribution
- **Channel/group** integration for study communities

### Virality Hooks

- **Share your plan:** When LearnClaw generates a study plan, offer a shareable image/link. Goes to Telegram study groups, WhatsApp statuses, Instagram stories.
- **Weekly progress card:** Visual card showing streak, accuracy, topics covered. Designed for social sharing.
- **Invite a study buddy:** Referral system — both students get a bonus quiz pack or resource recommendation.
- **Exam package contributions:** Students who finish an exam contribute back to the package (their study plan, what worked, common mistakes).

---

## Growth Strategy

### Discovery Channels
- UPSC/CAT Telegram study groups (massive, active)
- YouTube exam preparation channels (sponsor or create content)
- Reddit r/UPSC, r/Indian_Academia
- Word of mouth via share cards
- Coaching institute partnerships

### Retention Mechanics
- Daily push messages (the core loop — no willpower needed)
- Streak tracking (missed a day? LearnClaw notices and nudges)
- Spaced repetition creates compounding value (can't switch without losing your knowledge graph)
- Weekly reports show visible progress
- Coach recommendations at exactly the right moment (struggled 3 times on a topic → "Want expert help?")

---

## The Three Hard Problems (Updated)

### 1. Cold Start — Solved by Pre-Built Packages
Not a model problem anymore. The exam packages contain curated syllabi, resource sequences, lesson banks, and quiz banks. The model personalizes delivery, not generates curriculum. Community contributes updates. Ekatra curates quality.

### 2. Adaptive Plan Adjustment
When a learner consistently struggles, adding more of the same doesn't work. LearnClaw tracks misconception patterns:
- Accuracy below 50% for 3+ attempts → switch explanation strategy
- Try: analogy, worked example, diagram description, simplified prerequisite
- If still failing → suggest coach (referral revenue)
- Track which explanation styles work for this learner → update WHO_I_AM.md

### 3. Keeping the Loop Alive
The autonomous push-based delivery only works if the student stays engaged. Design the morning trigger to invite a reply. Streaks create habit. Weekly reports create accountability. Coach recommendations create escalation paths. Share cards create social pressure.

On Telegram (Tier 1): no template restrictions, no 24-hour window. Bot can message anytime. This is a major advantage over WhatsApp.

On WhatsApp (Tier 2 self-hosted): morning message requires reply → opens 24-hour window → evening quiz falls within it → cycle repeats.

---

## Build Sequence

```
Week 1–2: Core Telegram bot + UPSC package
  → Telegram bot with onboarding flow
  → OpenRouter integration (student's key)
  → UPSC exam package:
    - syllabus.json (full structure)
    - 100 pre-written lessons
    - 500 MCQs as Telegram polls
    - resources.json with affiliate links
  → Daily lesson + quiz heartbeat
  → SQLite multi-tenant storage
  → Deploy on $5 VPS or Railway
  → Landing page: learnclaw.org

Week 3–4: Current affairs + knowledge tracking
  → RSS-based daily news digest
  → SM-2 spaced repetition in quiz selection
  → Weekly progress report with share card
  → Affiliate links active in resource recommendations

Week 5–6: Second exam + community
  → CAT package (second largest market)
  → Open-source exam package format spec
  → GitHub template for contributing packages
  → Coach directory (manual curation, 10–20 coaches)

Week 7–8: Growth + NanoClaw fork
  → Referral system ("invite a study buddy")
  → NanoClaw/WhatsApp fork for self-hosters
  → One-click deploy script
  → Community contributions for JEE, NEET, GMAT

Week 9–10: Revenue activation
  → Coach marketplace with booking + commission
  → Sponsored exam package pilot with coaching institute
  → Premium features: document ingestion, voice
  → Managed API key option (₹99/month)

Week 11+: Scale
  → More exam packages via community
  → Model routing optimization for cost
  → Institutional deployment pilot (Tier 3)
  → Analytics dashboard for B2B
```

---

## Comparison

| | NotebookLM | Anki | Khanmigo | NanoClaw | Knowt/Quizlet | ChatGPT | **LearnClaw** |
|---|---|---|---|---|---|---|---|
| Push-based delivery | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Goal-aware planning | ✗ | ✗ | ✗ | ✗ | ✗ | Partial | ✓ |
| Spaced repetition | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ |
| Teaches (not just quizzes) | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| Exam-specific plans | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Current affairs autopilot | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Works on messaging apps | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Document ingestion | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Coach marketplace | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Free / zero install | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Local-first option | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Adapts over time | ✗ | Partial | Partial | ✗ | Partial | ✗ | ✓ |

---

## The Moat

Three layers of defensibility:

**1. The knowledge graph is unreplicable.** Six months of daily interaction produces a detailed map of what each student knows, which misconceptions they carry, how they learn best, what examples land, and where they are on the forgetting curve for every concept. No competitor can replicate this without the same six months.

**2. The content packages are community-built.** Once UPSC aspirants are contributing lessons, quiz questions, and study plan templates back to the open-source exam package, switching costs become community costs. This is the Anki decks model — the algorithm is open, the collective knowledge compounds.

**3. The revenue layer is embedded in the experience.** Affiliate links, coach referrals, and sponsored packages generate revenue without charging students. Competitors who charge students directly compete against free. Competitors who don't embed revenue can't sustain.

---

## What Ekatra Ships and Maintains

- Telegram bot orchestration layer (open source)
- Exam package format specification (open source)
- UPSC and CAT exam packages (curated by Ekatra, open source)
- Landing page, setup guide, onboarding videos
- Coach directory curation and quality control
- Affiliate link management
- Institutional deployment infrastructure (Tier 3)

## What the Community Builds

- Exam packages for other exams (JEE, NEET, GMAT, GRE, CFA, etc.)
- Translated lessons (Hindi, regional languages)
- Additional quiz banks and PYQ sets
- Coach listings
- NanoClaw fork improvements
- Integration with other platforms

---

*LearnClaw is built by Ekatra Learning Inc.*
*ekatra.one · a@ekatra.one*
