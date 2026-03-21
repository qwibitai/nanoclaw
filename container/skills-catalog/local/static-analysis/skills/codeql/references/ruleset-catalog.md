# Ruleset Catalog

## Official CodeQL Suites

| Suite | False Positives | Use Case |
|-------|-----------------|----------|
| `security-extended` | Low | **Default** - Security audits |
| `security-and-quality` | Medium | Comprehensive review |
| `security-experimental` | Higher | Research, vulnerability hunting |

**Usage:** `codeql/<lang>-queries:codeql-suites/<lang>-security-extended.qls`

**Languages:** `cpp`, `csharp`, `go`, `java`, `javascript`, `python`, `ruby`, `swift`

---

## Trail of Bits Packs

| Pack | Language | Focus |
|------|----------|-------|
| `trailofbits/cpp-queries` | C/C++ | Memory safety, integer overflows |
| `trailofbits/go-queries` | Go | Concurrency, error handling |
| `trailofbits/java-queries` | Java | Security, code quality |

**Install:**
```bash
codeql pack download trailofbits/cpp-queries
codeql pack download trailofbits/go-queries
codeql pack download trailofbits/java-queries
```

---

## CodeQL Community Packs

| Pack | Language |
|------|----------|
| `GitHubSecurityLab/CodeQL-Community-Packs-JavaScript` | JavaScript/TypeScript |
| `GitHubSecurityLab/CodeQL-Community-Packs-Python` | Python |
| `GitHubSecurityLab/CodeQL-Community-Packs-Go` | Go |
| `GitHubSecurityLab/CodeQL-Community-Packs-Java` | Java |
| `GitHubSecurityLab/CodeQL-Community-Packs-CPP` | C/C++ |
| `GitHubSecurityLab/CodeQL-Community-Packs-CSharp` | C# |
| `GitHubSecurityLab/CodeQL-Community-Packs-Ruby` | Ruby |

**Install:**
```bash
codeql pack download GitHubSecurityLab/CodeQL-Community-Packs-<Lang>
```

**Source:** [github.com/GitHubSecurityLab/CodeQL-Community-Packs](https://github.com/GitHubSecurityLab/CodeQL-Community-Packs)

---

## Verify Installation

```bash
# List all installed packs
codeql resolve qlpacks

# Check specific packs
codeql resolve qlpacks | grep -E "(trailofbits|GitHubSecurityLab)"
```
