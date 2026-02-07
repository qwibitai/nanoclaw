# NanoClaw Skills System

This directory contains shared skills that all NanoClaw groups can access. Skills provide specialized functionality that extends NanoClaw's capabilities.

## 📁 Directory Structure

```
skills/
├── README.md              # This file
├── INSTALL.md            # Dependency installation guide
├── calculator/           # Math operations skill
│   ├── skill.md         # Skill documentation
│   ├── deps.json        # Dependency declaration
│   └── calculator.py    # Implementation
├── x-integration/        # X (Twitter) integration
│   ├── skill.md
│   ├── deps.json
│   ├── agent.ts        # Container-side tools
│   └── host.ts         # Host-side handler
└── {your-skill}/        # Your custom skill
```

## 🚀 Quick Start

### Using Existing Skills

Skills are automatically available to Claude when properly configured. Simply ask Claude to use a skill:

- "Calculate the square root of 144" → Uses calculator skill
- "Post a tweet" → Uses x-integration skill
- "Set up NanoClaw" → Uses setup skill

### Adding a New Skill

1. **Create skill directory:**
   ```bash
   mkdir skills/my-new-skill
   cd skills/my-new-skill
   ```

2. **Create skill.md (documentation):**
   ```markdown
   ---
   name: my-new-skill
   description: Brief description of what your skill does
   ---

   # My New Skill

   Usage instructions and examples...
   ```

3. **Create deps.json (dependencies):**
   ```json
   {
     "skill": "my-new-skill",
     "version": "1.0.0",
     "description": "What this skill does",
     "dependencies": {
       "system": [],
       "runtime": {
         "node": [],
         "python": [],
         "go": []
       }
     },
     "integration": {
       "container": {
         "files": ["implementation.py"],
         "target": "src/skills/my-new-skill/"
       }
     },
     "enabled": true,
     "builtin": false
   }
   ```

4. **Add implementation files** (Python, TypeScript, etc.)

5. **Rebuild container:**
   ```bash
   cd ../../container
   ./build.sh
   ```

6. **Test your skill:**
   ```bash
   ./dev.sh test my-new-skill
   ```

## 📦 Dependency Declaration (deps.json)

Each skill must have a `deps.json` file declaring its dependencies:

### Structure

```json
{
  "skill": "skill-name",
  "version": "1.0.0",
  "description": "Brief description",
  "dependencies": {
    "system": [
      {
        "type": "apt",
        "packages": ["package1", "package2"],
        "description": "Why these are needed"
      }
    ],
    "runtime": {
      "node": [
        {
          "packages": ["npm-package"],
          "global": false,
          "description": "Purpose"
        }
      ],
      "python": [
        {
          "packages": ["pip-package"],
          "pip_args": "--no-cache-dir",
          "description": "Purpose"
        }
      ],
      "go": [
        {
          "package": "github.com/user/package@latest",
          "description": "Purpose"
        }
      ]
    },
    "host": {
      "description": "Dependencies needed on host",
      "instructions": "Manual installation steps"
    }
  },
  "integration": {
    "container": {
      "files": ["file1.py", "file2.ts"],
      "target": "src/skills/skill-name/"
    },
    "host": {
      "files": ["host.ts"],
      "modifications": [
        {
          "file": "src/index.ts",
          "description": "Add handler to main router"
        }
      ]
    }
  },
  "enabled": true,
  "builtin": false,
  "author": "your-github-username",
  "license": "MIT"
}
```

### Field Descriptions

- **skill**: Unique identifier for the skill
- **version**: Semantic version (1.0.0)
- **description**: Brief description of functionality
- **dependencies**: Required packages and tools
  - **system**: System packages (apt, yum, etc.)
  - **runtime**: Language-specific packages
  - **host**: Dependencies for the host system
- **integration**: How the skill integrates with NanoClaw
  - **container**: Files that run in the container
  - **host**: Files that run on the host
- **enabled**: Whether this skill is active
- **builtin**: Whether this is a core NanoClaw skill
- **author**: Skill creator (GitHub username)
- **license**: License for the skill code

## 🛠️ Development Mode

For rapid skill development without rebuilding:

```bash
cd container

# Start development mode (mounts skills directory)
./dev.sh run

# Test a specific skill
./dev.sh test calculator

# Open shell for debugging
./dev.sh shell

# Validate all skills
./dev.sh validate
```

## 📋 Skill Types

### 1. Documentation Skills
Skills that provide instructions to Claude without code execution:
- `setup` - Installation and configuration
- `customize` - Modifying NanoClaw behavior
- `debug` - Troubleshooting issues

### 2. Tool Skills
Skills that provide executable tools:
- `calculator` - Python script for math
- `x-integration` - TypeScript browser automation

### 3. Integration Skills
Skills that modify NanoClaw itself:
- `add-gmail` - Adds Gmail integration
- `add-voice-transcription` - Adds voice support

## 🔒 Security

- Package names are validated to prevent injection attacks
- Skills run in isolated containers
- Shared skills are read-only in containers
- Each group has its own writable skill directory

## 🧪 Testing Skills

### Unit Testing
Create `test.json` in your skill directory:

```json
{
  "tests": [
    {
      "name": "basic_test",
      "input": {"arg": "value"},
      "expected": {"result": "expected"}
    }
  ]
}
```

### Integration Testing
```bash
# Test in development container
./dev.sh test my-skill

# Test with specific input
echo '{"prompt":"test my skill"}' | docker run -i nanoclaw-agent:latest
```

## 📚 Examples

### Simple Python Skill

```python
#!/usr/bin/env python3
# skills/my-tool/tool.py

import sys
import json

def main(args):
    # Your implementation
    result = {"success": True, "data": "result"}
    print(json.dumps(result))

if __name__ == "__main__":
    main(sys.argv[1:])
```

### TypeScript MCP Tool

```typescript
// skills/my-tool/agent.ts
import { tool } from '@anthropic-ai/claude-agent-sdk/mcp/create-server';
import { z } from 'zod';

export function createMyTools() {
  return [
    tool(
      'my_tool',
      'Description of tool',
      { param: z.string() },
      async (args) => {
        // Implementation
        return { result: 'success' };
      }
    )
  ];
}
```

## 🤝 Contributing

1. Fork the repository
2. Create your skill in `skills/`
3. Test thoroughly using `dev.sh`
4. Submit a PR with:
   - Complete `deps.json`
   - Clear `skill.md` documentation
   - Working implementation
   - Test cases if applicable

## 📖 Additional Resources

- [INSTALL.md](./INSTALL.md) - Dependency installation details
- [Container Documentation](../container/README.md) - Container architecture
- [Main README](../README.md) - Project overview

## ❓ Troubleshooting

### Skill not found
- Check `deps.json` exists and is valid JSON
- Ensure `"enabled": true`
- Rebuild container after adding skill

### Dependencies not installed
- Verify package names in `deps.json`
- Check build output for errors
- Use `--original` flag to test without skills

### Permission errors
- Skills directory should be readable
- Container runs as `node` user
- Check file permissions

## 📝 License

Skills in this directory are MIT licensed unless otherwise specified in their individual directories.