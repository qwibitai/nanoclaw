---
name: qmd-memory
description: "Question-driven Memory Distillation. Create flashcards, review schedules, and concept maps from learning content. Use when user says 'remember this', 'make flashcards', 'review', 'quiz me', 'what did I learn about X', or after completing a learning session."
---

# qmd-memory

**Question-driven Memory Distillation** — transform learning into durable memory through questions, connections, and spaced review.

## The QMD Process

### 1. Question Formulation
Transform key concepts into questions at multiple levels:
- **Recall**: "What is [concept]?" / "Define [term]"
- **Understanding**: "Why does [concept] work this way?"
- **Application**: "How would you use [concept] to solve [problem]?"
- **Analysis**: "Compare [concept A] and [concept B]"
- **Synthesis**: "How do [concept A] and [concept B] connect?"

### 2. Memory Consolidation
Create flashcard entries:

```json
{
  "id": "card-YYYYMMDD-NNN",
  "created": "ISO-8601",
  "source": "module-name or topic",
  "question": "The question text",
  "answer": "The answer text",
  "level": "recall | understanding | application | analysis | synthesis",
  "tags": ["domain", "topic"],
  "schedule": {
    "nextReview": "ISO-8601",
    "interval": 1,
    "easeFactor": 2.5,
    "repetitions": 0,
    "lastReview": null
  }
}
```

### 3. Distillation
After accumulating cards, create concept maps:

```json
{
  "conceptMap": {
    "nodes": [
      {"id": "concept-1", "label": "Neural Networks", "domain": "ML"}
    ],
    "edges": [
      {"from": "concept-1", "to": "concept-2", "relation": "requires"}
    ]
  }
}
```

## Storage

- Flashcards: `notes/memory/cards.json`
- Concept maps: `notes/memory/concepts.json`
- Review log: `notes/memory/reviews.json`

## Spaced Repetition (SM-2 Algorithm)

When reviewing cards, update schedule based on quality of recall:
- **5 (Perfect)**: Increase interval significantly
- **4 (Correct, hesitation)**: Increase interval
- **3 (Correct, difficulty)**: Keep current interval
- **2 (Incorrect, remembered after hint)**: Reset to short interval
- **1 (Incorrect)**: Reset to 1 day
- **0 (No recall)**: Reset to 1 day, decrease ease factor

## Review Session

When user asks to review:
1. Find cards where `nextReview <= now`
2. Present cards one at a time
3. Ask user to attempt answer before revealing
4. Rate recall quality (0-5)
5. Update schedule using SM-2
6. After session, summarize: cards reviewed, accuracy, weak areas

## Auto-Generate Cards

After a learning session (run-module, scientific-writing, research-lookup):
- Offer to create 3-5 flashcards from key concepts
- Focus on understanding and application levels
- Tag with source module/topic for organization

## Commands
- "Quiz me on [topic]" → Start review session filtered by topic
- "Make flashcards from [content]" → Generate QMD cards
- "Review due cards" → Start spaced repetition session
- "Show concept map for [domain]" → Display connections
- "Memory stats" → Show total cards, review streak, weak areas
