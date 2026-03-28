# Exam Packages

Exam packages are the content layer for LearnClaw.

Each package should provide enough structure that the assistant can deliver a reliable learning experience without generating the curriculum from scratch every time.

Recommended layout:

```text
exams/<exam>/
├── meta.json
├── syllabus.json
├── lessons/
├── quizzes/
├── plans/
├── resources.json
└── coaches.json
```

Design principles:

- prefer structured data over freeform prose where sequencing matters
- let the model personalize delivery, not invent the syllabus
- make graceful degradation possible on weaker models
- keep packages community-editable and easy to review in git

The first scaffold in this fork is `exams/upsc/meta.json`.