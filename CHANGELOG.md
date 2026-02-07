# Changelog

All notable changes to this fork of NanoClaw will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2024-02-07

### 🎉 Major Release: Advanced Skills Architecture

This release introduces a complete overhaul of the Skills system, making NanoClaw more modular, secure, and developer-friendly.

### Added

#### Core Features
- **Shared Skills Directory** (`/skills/`) - All groups can now access common skills
- **Declarative Dependency Management** (`deps.json`) - Each skill declares its own dependencies
- **Multi-stage Docker Build** (`Dockerfile.skills`) - Efficient layer caching and conditional builds
- **Intelligent Build Script** - Auto-detects enabled skills and their dependencies
- **Development Mode** (`dev.sh`) - Live skill mounting for rapid development
- **Package Validation** - Security checks to prevent dependency injection attacks

#### New Files
- `skills/README.md` - Comprehensive skills documentation
- `skills/*/deps.json` - Dependency declarations for each skill
- `container/Dockerfile.skills` - Multi-stage build configuration
- `container/dev.sh` - Development mode helper script
- `container/docker-compose.dev.yml` - Development environment setup

### Changed

#### Architecture Improvements
- **Skills Location**: Moved from `.claude/skills/` to `/skills/` (top-level directory)
- **Container Mounts**: Added `/workspace/shared-skills` mount point for all groups
- **Build Process**: From monolithic to multi-stage with conditional dependencies
- **Dependency Installation**: From hardcoded to declarative via `deps.json`

#### Enhanced Files
- `container/build.sh` - Added skill detection, validation, and conditional building
- `src/container-runner.ts` - Added shared skills mounting for all containers
- `README.md` - Complete rewrite with detailed documentation

### Security

- **Package Name Validation**: Prevents command injection in dependency names
- **Read-Only Mounts**: Shared skills are mounted read-only in containers
- **Group Isolation**: Each group maintains separate writable skill directories

### Performance

- **Docker Layer Caching**: Multi-stage build reduces rebuild times
- **Conditional Dependencies**: Only installs what's needed (smaller images)
- **Shared Image**: Multiple bots can use the same container image

### Developer Experience

- **Hot Reload**: Development mode allows testing without rebuilding
- **Clear Documentation**: Comprehensive guides for adding and managing skills
- **Backward Compatibility**: `--original` flag to use original Dockerfile

## [1.0.0] - Original

### Initial Fork Features (from gavrielc/nanoclaw)

- WhatsApp integration via Baileys
- Docker container isolation
- Per-group memory (CLAUDE.md)
- Task scheduling (cron, interval, once)
- Basic skills in `.claude/skills/`
- Apple Container support (macOS)

---

## Migration Guide

### From Original to 2.0.0

1. **Update Repository**
   ```bash
   git pull origin main
   ```

2. **Move Custom Skills**
   ```bash
   # If you have custom skills in .claude/skills/
   mv .claude/skills/my-skill skills/
   ```

3. **Add deps.json to Skills**
   Create `deps.json` for each skill (see examples in `/skills/`)

4. **Rebuild Container**
   ```bash
   cd container
   ./build.sh
   ```

5. **Test**
   ```bash
   npm run dev
   # Or for production
   docker compose -f docker-compose.vps.yml up
   ```

### Breaking Changes

- Skills must now have `deps.json` files
- `.claude/skills/` directory is deprecated (use `/skills/`)
- Container image name changed to `nanoclaw-agent` (from `nanoclaw`)

### Deprecations

- `.claude/skills/` directory (moved to `/skills/`)
- Hardcoded dependencies in Dockerfile
- Single-stage Docker builds

---

## Roadmap

### Planned for Next Release

- [ ] Skills marketplace/registry
- [ ] Runtime dependency installation
- [ ] Skills versioning and updates
- [ ] Web UI for skill management
- [ ] Automated skill testing framework
- [ ] Skills sharing between forks

### Under Consideration

- GraphQL API for skill management
- Skills written in Rust/Go
- Plugin system for skill loaders
- Cloud-based skill storage

---

## Contributors

- Original author: [@gavrielc](https://github.com/gavrielc)
- Skills architecture: This fork contributors

---

## Support

For issues related to:
- **Original features**: [gavrielc/nanoclaw/issues](https://github.com/gavrielc/nanoclaw/issues)
- **Skills system**: [This fork's issues](https://github.com/yourusername/nanoclaw/issues)