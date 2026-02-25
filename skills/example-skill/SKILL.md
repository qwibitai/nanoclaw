---
name: example-skill
description: Template and guide for creating skills. Demonstrates the standard skill structure with resources, docs, examples, and templates directories. Use this as a reference when building new protocol integrations.
---

# Example Skill Template

This skill serves as a template and guide for creating new skills. It demonstrates the standard structure and best practices used by all skills in this codebase.

## Overview

Every skill should provide:
- **Core Documentation** - Main concepts and quick start guide in SKILL.md
- **API References** - Detailed method/function documentation in `resources/`
- **Code Examples** - Working code samples in `examples/`
- **Starter Templates** - Ready-to-use setup files in `templates/`
- **Troubleshooting** - Common issues and solutions in `docs/`

## Required Structure

```
skill-name/
├── SKILL.md                    # Main skill file (required)
├── resources/                  # API references and detailed docs
│   ├── api-reference.md
│   └── program-addresses.md
├── examples/                   # Working code examples
│   └── feature-name/
│       └── example.ts
├── templates/                  # Starter templates
│   └── setup.ts
└── docs/                       # Guides and troubleshooting
    └── troubleshooting.md
```

## SKILL.md Format

### Frontmatter (Required)

Every SKILL.md must start with YAML frontmatter:

```yaml
---
name: skill-name
description: Brief description of what this skill covers. Should be 1-2 sentences explaining the protocol/tool and main features.
---
```

### Recommended Sections

```markdown
# Protocol Name Development Guide

Brief introduction paragraph.

## Overview

Bullet points of main features:
- **Feature 1** - Description
- **Feature 2** - Description

## Program IDs (for Solana protocols)

| Program | Address |
|---------|---------|
| Main Program | `address` |

## Quick Start

### Installation

\`\`\`bash
npm install package-name
\`\`\`

### Basic Setup

\`\`\`typescript
// Setup code example
\`\`\`

## Core Features

Document each major feature with:
- Explanation
- Code examples
- Important notes

## Best Practices

- Security considerations
- Performance tips
- Common patterns

## Resources

- Links to official docs
- GitHub repositories
- Community resources

## Skill Structure

Show the actual file structure of this skill.
```

## Writing Guidelines

### Code Examples

1. **Always include imports** - Show complete, runnable code
2. **Use TypeScript** - Prefer `.ts` files with proper types
3. **Add comments** - Explain non-obvious logic
4. **Handle errors** - Show proper error handling patterns
5. **Use real addresses** - Use actual program IDs, not placeholders

### Documentation Style

1. **Be concise** - Get to the point quickly
2. **Use tables** - For lists of methods, addresses, parameters
3. **Show, don't tell** - Prefer code examples over lengthy explanations
4. **Keep updated** - Include version info and update dates

### Resource Files

Create separate files in `resources/` for:
- Complete API method references
- Program addresses and PDAs
- Configuration options
- Type definitions

### Example Files

Examples in `examples/` should be:
- Self-contained and runnable
- Well-commented
- Cover common use cases
- Include error handling

### Template Files

Templates in `templates/` should be:
- Ready to copy and use
- Include configuration options
- Have placeholder values clearly marked
- Include all necessary imports

## Example Protocol Skill

Here's how a typical Solana protocol skill is structured:

```markdown
---
name: protocol-name
description: Complete guide for Protocol Name - description of what it does.
---

# Protocol Name Development Guide

## Overview

Protocol Name provides:
- **Feature A** - What it does
- **Feature B** - What it does

## Program IDs

| Program | Address |
|---------|---------|
| Main | \`ProgramAddress111111111111111111111\` |

## Quick Start

### Installation

\`\`\`bash
npm install @protocol/sdk
\`\`\`

### Basic Setup

\`\`\`typescript
import { Protocol } from '@protocol/sdk';

const protocol = new Protocol(connection);
\`\`\`

## Core Operations

### Operation 1

\`\`\`typescript
// Code example
\`\`\`

### Operation 2

\`\`\`typescript
// Code example
\`\`\`

## Best Practices

- Practice 1
- Practice 2

## Resources

- [Official Docs](https://docs.protocol.com)
- [GitHub](https://github.com/protocol/sdk)

## Skill Structure

\`\`\`
protocol-name/
├── SKILL.md
├── resources/
│   ├── api-reference.md
│   └── program-addresses.md
├── examples/
│   └── basic/
│       └── example.ts
├── templates/
│   └── setup.ts
└── docs/
    └── troubleshooting.md
\`\`\`
```

## Checklist for New Skills

- [ ] SKILL.md with proper frontmatter
- [ ] Overview section with feature list
- [ ] Program IDs table (for Solana protocols)
- [ ] Quick Start with installation and setup
- [ ] Core operations with code examples
- [ ] Best practices section
- [ ] Resources with external links
- [ ] Skill structure diagram
- [ ] `resources/` with API references
- [ ] `examples/` with working code
- [ ] `templates/` with starter template
- [ ] `docs/troubleshooting.md` with common issues

## Skill Structure

```
example-skill/
├── SKILL.md                    # This file
├── resources/
│   └── api-reference.md        # Example API reference format
├── examples/
│   └── basic/
│       └── example.ts          # Example code file
├── templates/
│   └── setup.ts                # Example template
└── docs/
    └── troubleshooting.md      # Example troubleshooting guide
```
