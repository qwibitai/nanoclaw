---
name: kstar-loop
description: "Knowledge-Situation-Task-Action-Result learning loop. Use when reflecting on completed tasks, recording what was learned, building skill profiles, or when user asks 'what did I learn', 'review my progress', 'kstar trace', or 'skill profile'."
---

# kstar-loop

Record and analyze **KSTAR learning traces** — structured records of learning experiences that build skill profiles over time.

## KSTAR Trace Format

After completing any significant task or learning activity, record a trace:

```json
{
  "id": "trace-YYYYMMDD-HHMMSS",
  "timestamp": "ISO-8601",
  "knowledge": {
    "prior": "What was known before this task",
    "gained": "What new knowledge was acquired",
    "assumptions": ["Assumptions made during the task"]
  },
  "situation": {
    "domain": "The domain context (e.g., 'machine-learning', 'data-analysis')",
    "context": "What prompted this task",
    "constraints": ["Time, tools, or knowledge constraints"]
  },
  "task": {
    "goal": "What needed to be accomplished",
    "type": "learn | apply | create | debug | research",
    "difficulty": "beginner | intermediate | advanced"
  },
  "action": {
    "approach": "Strategy used to accomplish the task",
    "tools": ["Tools and methods used"],
    "steps": ["Key steps taken"]
  },
  "result": {
    "outcome": "What was achieved",
    "success": true,
    "quality": 0.85,
    "insights": ["Key insights or surprises"],
    "improvements": ["What could be done differently next time"]
  }
}
```

## Storage

- Read/write traces to `notes/kstar-traces.json`
- Format: `{"traces": [...], "skillProfile": {...}}`

## Skill Profile Building

Periodically analyze accumulated traces to build a skill profile:

```json
{
  "skillProfile": {
    "domains": {
      "machine-learning": {
        "level": "intermediate",
        "traceCount": 15,
        "avgQuality": 0.82,
        "strengths": ["supervised learning", "feature engineering"],
        "growthAreas": ["deep learning", "model deployment"],
        "lastActivity": "ISO-8601"
      }
    },
    "overallStats": {
      "totalTraces": 42,
      "avgQuality": 0.78,
      "streakDays": 5,
      "topDomains": ["machine-learning", "data-analysis"]
    }
  }
}
```

## When to Record Traces

Proactively suggest recording a trace when:
- A module lesson is completed (link to run-module)
- A research task finishes (link to research-lookup)
- A paper section is written (link to scientific-writing)
- The user solves a coding challenge
- Any significant learning activity concludes

## Review Commands
- "Show my skill profile" → Display skill profile summary
- "Review recent traces" → List last 5 traces with key insights
- "What are my growth areas?" → Analyze gaps across domains
- "Learning streak" → Show consecutive days of learning activity
