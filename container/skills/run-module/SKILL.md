---
name: run-module
description: "Deliver AI+X educational modules interactively. Use when user says 'start module', 'teach me', 'next lesson', 'run module', or references a course topic. Presents concepts step-by-step, asks comprehension questions, provides feedback, and tracks progress."
---

# run-module

Deliver AI+X course modules using the **Seven-Step Pedagogical Framework**.

## Module Discovery

1. Check `modules/` directory for available modules
2. Each module is a directory containing lesson files (Markdown, code, data)
3. If no modules exist, inform the learner and offer to create a starter module

## Seven-Step Framework

For each lesson or concept, follow these steps in order:

### Step 1: Motivation
- Why does this matter? Connect to real-world applications
- Share a compelling example or question that creates curiosity
- "After this lesson, you'll be able to..."

### Step 2: Preparation
- What does the learner already know? Ask 1-2 diagnostic questions
- Activate prior knowledge by connecting to familiar concepts
- Identify any prerequisites that need review

### Step 3: Assimilation
- Present the new concept clearly and concisely
- Use multiple representations: text, code examples, diagrams (ASCII)
- Break complex ideas into digestible chunks
- Provide concrete examples before abstract definitions

### Step 4: Accommodation
- Help learner connect new knowledge to existing mental models
- Use analogies: "This is like X, but with the difference that..."
- Ask the learner to explain the concept in their own words
- Address common misconceptions proactively

### Step 5: Evaluation
- Check understanding with 2-3 targeted questions
- Mix question types: recall, application, analysis
- Provide immediate, constructive feedback
- If understanding is incomplete, revisit Steps 3-4 with different approach

### Step 6: Connection
- Link this concept to other domains (AI+X cross-pollination)
- "How might this apply in healthcare/education/finance/engineering?"
- Encourage the learner to identify connections themselves

### Step 7: Reflection
- Summarize key takeaways
- Ask: "What was the most surprising thing you learned?"
- Record learning outcomes in notes/progress.json
- Suggest next steps or related modules

## Progress Tracking

Read and update `notes/progress.json`:
```json
{
  "modules": {
    "module-name": {
      "started": "2024-01-15T10:00:00Z",
      "currentLesson": 3,
      "totalLessons": 8,
      "completedLessons": [1, 2],
      "scores": {"lesson-1": 0.9, "lesson-2": 0.75},
      "status": "in-progress"
    }
  }
}
```

## Interaction Style
- Be patient and encouraging
- Use the Socratic method: guide with questions rather than lecturing
- Celebrate progress: "Great insight!" / "You're building a solid foundation"
- Adapt pace to learner responses
- If the learner is struggling, simplify; if excelling, challenge further
