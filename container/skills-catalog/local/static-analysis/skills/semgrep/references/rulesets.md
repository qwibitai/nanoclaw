# Semgrep Rulesets Reference

## Complete Ruleset Catalog

### Security-Focused Rulesets

| Ruleset | Description | Use Case |
|---------|-------------|----------|
| `p/security-audit` | Comprehensive vulnerability detection, higher false positives | Manual audits, security reviews |
| `p/secrets` | Hardcoded credentials, API keys, tokens | Always include |
| `p/owasp-top-ten` | OWASP Top 10 web application vulnerabilities | Web app security |
| `p/cwe-top-25` | CWE Top 25 most dangerous software weaknesses | General security |
| `p/sql-injection` | SQL injection patterns and tainted data flows | Database security |
| `p/insecure-transport` | Ensures code uses encrypted channels | Network security |
| `p/gitleaks` | Hard-coded credentials detection (gitleaks port) | Secrets scanning |
| `p/findsecbugs` | FindSecBugs rule pack for Java | Java security |
| `p/phpcs-security-audit` | PHP security audit rules | PHP security |

### CI/CD Rulesets

| Ruleset | Description | Use Case |
|---------|-------------|----------|
| `p/default` | Default ruleset, balanced coverage | First-time users |
| `p/ci` | High-confidence security + logic bugs, low FP | CI pipelines |
| `p/r2c-ci` | Low false positives, CI-safe | CI/CD blocking |
| `p/r2c` | Community favorite, curated by Semgrep (618k+ downloads) | General scanning |
| `p/auto` | Auto-selects rules based on detected languages/frameworks | Quick scans |
| `p/comment` | Comment-related rules | Code review |

### Third-Party Rulesets

| Ruleset | Description | Maintainer |
|---------|-------------|------------|
| `p/gitlab` | GitLab-maintained security rules | GitLab |

---

## Ruleset Selection Algorithm

Follow this algorithm to select rulesets based on detected languages and frameworks.

### Step 1: Always Include Security Baseline

```json
{
  "baseline": ["p/security-audit", "p/secrets"]
}
```

- `p/security-audit` - Comprehensive vulnerability detection (always include)
- `p/secrets` - Hardcoded credentials, API keys, tokens (always include)

### Step 2: Add Language-Specific Rulesets

For each detected language, add the primary ruleset. If a framework is detected, add its ruleset too.

**GA Languages (production-ready):**

| Detection | Primary Ruleset | Framework Rulesets | Pro Rule Count |
|-----------|-----------------|-------------------|----------------|
| `.py` | `p/python` | `p/django`, `p/flask`, `p/fastapi` | 710+ |
| `.js`, `.jsx` | `p/javascript` | `p/react`, `p/nodejs`, `p/express`, `p/nextjs`, `p/angular` | 250+ (JS), 70+ (JSX) |
| `.ts`, `.tsx` | `p/typescript` | `p/react`, `p/nodejs`, `p/express`, `p/nextjs`, `p/angular` | 230+ |
| `.go` | `p/golang` | `p/go` (alias) | 80+ |
| `.java` | `p/java` | `p/spring`, `p/findsecbugs` | 190+ |
| `.kt` | `p/kotlin` | `p/spring` | 60+ |
| `.rb` | `p/ruby` | `p/rails` | 40+ |
| `.php` | `p/php` | `p/symfony`, `p/laravel`, `p/phpcs-security-audit` | 50+ |
| `.c`, `.cpp`, `.h` | `p/c` | - | 150+ |
| `.rs` | `p/rust` | - | 40+ |
| `.cs` | `p/csharp` | - | 170+ |
| `.scala` | `p/scala` | - | Community |
| `.swift` | `p/swift` | - | 60+ |

**Beta Languages (Pro recommended):**

| Detection | Primary Ruleset | Notes |
|-----------|-----------------|-------|
| `.ex`, `.exs` | `p/elixir` | Requires Pro for best coverage |
| `.cls`, `.trigger` | `p/apex` | Salesforce; requires Pro |

**Experimental Languages:**

| Detection | Primary Ruleset | Notes |
|-----------|-----------------|-------|
| `.sol` | No official ruleset | Use Decurity third-party rules |
| `Dockerfile` | `p/dockerfile` | Limited rules |
| `.yaml`, `.yml` | `p/yaml` | K8s, GitHub Actions, docker-compose patterns |
| `.json` | `r/json.aws` | AWS IAM policies; use `r/json.*` for specific rules |
| Bash scripts | - | Community support |
| Cairo, Circom | - | Experimental, smart contracts |

**Framework detection hints:**

| Framework | Detection Signals | Ruleset |
|-----------|------------------|---------|
| Django | `settings.py`, `urls.py`, `django` in requirements | `p/django` |
| Flask | `flask` in requirements, `@app.route` | `p/flask` |
| FastAPI | `fastapi` in requirements, `@app.get/post` | `p/fastapi` |
| React | `package.json` with react dependency, `.jsx`/`.tsx` files | `p/react` |
| Next.js | `next.config.js`, `pages/` or `app/` directory | `p/nextjs` |
| Angular | `angular.json`, `@angular/` dependencies | `p/angular` |
| Express | `express` in package.json, `app.use()` patterns | `p/express` |
| NestJS | `@nestjs/` dependencies, `@Controller` decorators | `p/nodejs` |
| Spring | `pom.xml` with spring, `@SpringBootApplication` | `p/spring` |
| Rails | `Gemfile` with rails, `config/routes.rb` | `p/rails` |
| Laravel | `composer.json` with laravel, `artisan` | `p/laravel` |
| Symfony | `composer.json` with symfony, `config/packages/` | `p/symfony` |

### Step 3: Add Infrastructure Rulesets

| Detection | Ruleset | Description |
|-----------|---------|-------------|
| `Dockerfile` | `p/dockerfile` | Container security, best practices |
| `.tf`, `.hcl` | `p/terraform` | IaC misconfigurations, CIS benchmarks, AWS/Azure/GCP |
| k8s manifests | `p/kubernetes` | K8s security, RBAC issues |
| CloudFormation | `p/cloudformation` | AWS infrastructure security |
| GitHub Actions | `p/github-actions` | CI/CD security, secrets exposure |
| `.yaml`, `.yml` | `p/yaml` | Generic YAML patterns (K8s, docker-compose) |
| AWS IAM JSON | `r/json.aws` | IAM policy misconfigurations (use `--config r/json.aws`) |

### Step 4: Add Third-Party Rulesets

These are **NOT optional**. Include automatically when language matches:

| Languages | Source | Why Required |
|-----------|--------|--------------|
| Python, Go, Ruby, JS/TS, Terraform, HCL | [Trail of Bits](https://github.com/trailofbits/semgrep-rules) | Security audit patterns from real engagements (AGPLv3) |
| C, C++ | [0xdea](https://github.com/0xdea/semgrep-rules) | Memory safety, low-level vulnerabilities |
| Solidity, Cairo, Rust | [Decurity](https://github.com/Decurity/semgrep-smart-contracts) | Smart contract vulnerabilities, DeFi exploits |
| Go | [dgryski](https://github.com/dgryski/semgrep-go) | Additional Go-specific patterns |
| Android (Java/Kotlin) | [MindedSecurity](https://github.com/mindedsecurity/semgrep-rules-android-security) | OWASP MASTG-derived mobile security rules |
| Java, Go, JS/TS, C#, Python, PHP | [elttam](https://github.com/elttam/semgrep-rules) | Security consulting patterns |
| Dockerfile, PHP, Go, Java | [kondukto](https://github.com/kondukto-io/semgrep-rules) | Container and web app security |
| PHP, Kotlin, Java | [dotta](https://github.com/federicodotta/semgrep-rules) | Pentest-derived web/mobile app rules |
| Terraform, HCL | [HashiCorp](https://github.com/hashicorp-forge/semgrep-rules) | HashiCorp infrastructure patterns |
| Swift, Java, Cobol | [akabe1](https://github.com/akabe1/akabe1-semgrep-rules) | iOS and legacy system patterns |
| Java | [Atlassian Labs](https://github.com/atlassian-labs/atlassian-sast-ruleset) | Atlassian-maintained Java rules |
| Python, JS/TS, Java, Ruby, Go, PHP | [Apiiro](https://github.com/apiiro/malicious-code-ruleset) | Malicious code detection, supply chain |

### Step 5: Verify Rulesets

Before finalizing, verify official rulesets load:

```bash
# Quick validation (exits 0 if valid)
semgrep --config p/python --validate --metrics=off 2>&1 | head -3
```

Or browse the [Semgrep Registry](https://semgrep.dev/explore).

### Output Format

```json
{
  "baseline": ["p/security-audit", "p/secrets"],
  "python": ["p/python", "p/django"],
  "javascript": ["p/javascript", "p/react", "p/nodejs"],
  "docker": ["p/dockerfile"],
  "third_party": ["https://github.com/trailofbits/semgrep-rules"]
}
```
