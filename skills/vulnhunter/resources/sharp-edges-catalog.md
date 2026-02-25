# Sharp Edges Catalog

Comprehensive catalog of dangerous patterns, footguns, and security anti-patterns organized by category.

## Memory Safety

### C/C++

| Function | Risk | Safer Alternative |
|----------|------|-------------------|
| `strcpy()` | Buffer overflow | `strncpy()`, `strlcpy()` |
| `strcat()` | Buffer overflow | `strncat()`, `strlcat()` |
| `sprintf()` | Buffer overflow | `snprintf()` |
| `gets()` | Buffer overflow (unbounded) | `fgets()` |
| `scanf("%s")` | Buffer overflow | `scanf("%Ns")` with limit |
| `memcpy()` | No bounds check | Validate size first |
| `alloca()` | Stack overflow | `malloc()` with checks |

### Use-After-Free Patterns
```c
// Dangerous: pointer used after free
free(ptr);
ptr->field = value;  // UAF

// Dangerous: double free
free(ptr);
// ... code ...
free(ptr);  // Double free

// Safe: null after free
free(ptr);
ptr = NULL;
```

## Cryptography

### Weak Algorithms (DO NOT USE)

| Algorithm | Risk | Replacement |
|-----------|------|-------------|
| MD5 | Collision attacks | SHA-256+ |
| SHA1 | Collision attacks | SHA-256+ |
| DES | Key size too small | AES-256 |
| 3DES | Performance + deprecation | AES-256 |
| RC4 | Multiple weaknesses | ChaCha20 |
| ECB mode | Pattern preservation | GCM, CBC |

### Cryptographic Footguns

```python
# BAD: Hardcoded IV
iv = b'\x00' * 16
cipher = AES.new(key, AES.MODE_CBC, iv)

# GOOD: Random IV
iv = os.urandom(16)
cipher = AES.new(key, AES.MODE_CBC, iv)
```

```python
# BAD: Predictable random for tokens
import random
token = random.randint(0, 2**32)

# GOOD: Cryptographically secure
import secrets
token = secrets.token_hex(32)
```

```javascript
// BAD: Math.random for security
const token = Math.random().toString(36);

// GOOD: Crypto API
const token = crypto.randomBytes(32).toString('hex');
```

## Authentication & Authorization

### Session Management
```python
# BAD: Predictable session IDs
session_id = str(user_id) + str(timestamp)

# BAD: Session fixation vulnerable
session_id = request.cookies.get('session')  # Use existing

# GOOD: Regenerate on auth state change
session.regenerate()
session_id = secrets.token_urlsafe(32)
```

### Authorization Bypass Patterns
```python
# BAD: Client-controlled authorization
is_admin = request.json.get('is_admin', False)

# BAD: Insecure direct object reference
def get_document(doc_id):
    return Document.query.get(doc_id)  # No ownership check

# GOOD: Always verify ownership
def get_document(doc_id, user):
    doc = Document.query.get(doc_id)
    if doc.owner_id != user.id:
        raise Forbidden()
    return doc
```

### Timing Attacks
```python
# BAD: Early return reveals validity
def check_token(token):
    if len(token) != 32:
        return False
    return token == expected_token  # String compare varies

# GOOD: Constant-time comparison
import hmac
def check_token(token):
    return hmac.compare_digest(token, expected_token)
```

## Injection Vulnerabilities

### SQL Injection
```python
# BAD: String concatenation
query = "SELECT * FROM users WHERE id = " + user_id
cursor.execute(query)

# BAD: Format strings
cursor.execute("SELECT * FROM users WHERE name = '%s'" % name)

# GOOD: Parameterized queries
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
```

### Command Injection
```python
# BAD: Shell with user input
os.system(f"ping {user_input}")
subprocess.call(f"convert {filename}", shell=True)

# GOOD: No shell, array arguments
subprocess.run(["ping", "-c", "4", validated_host], shell=False)
```

### Template Injection
```python
# BAD: User input in template
template = Template(user_input)
template.render()

# BAD: Format string injection
"Hello, {name}".format(**user_dict)

# GOOD: Sandboxed templates with escaping
env = Environment(autoescape=True)
template = env.from_string(static_template)
template.render(name=user_input)
```

## Deserialization

### Dangerous Deserializers

| Language | Dangerous | Safer |
|----------|-----------|-------|
| Python | `pickle.loads()` | JSON, `yaml.safe_load()` |
| Python | `yaml.load()` | `yaml.safe_load()` |
| Java | `ObjectInputStream` | JSON with allow-list |
| Ruby | `Marshal.load()` | JSON |
| PHP | `unserialize()` | `json_decode()` |
| .NET | `BinaryFormatter` | JSON with type validation |

```python
# BAD: Arbitrary code execution
import pickle
data = pickle.loads(untrusted_bytes)  # RCE!

# BAD: YAML code execution
import yaml
data = yaml.load(untrusted_string)  # RCE!

# GOOD: Safe alternatives
import json
data = json.loads(untrusted_string)

import yaml
data = yaml.safe_load(untrusted_string)
```

## Web Security

### Cross-Site Scripting (XSS)
```javascript
// BAD: Direct innerHTML
element.innerHTML = userInput;

// BAD: document.write
document.write(userInput);

// BAD: jQuery html()
$(element).html(userInput);

// GOOD: textContent (no parsing)
element.textContent = userInput;

// GOOD: DOMPurify for rich content
element.innerHTML = DOMPurify.sanitize(userInput);
```

### Cross-Origin Issues
```javascript
// BAD: Overly permissive CORS
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true  // Together = vulnerability

// BAD: postMessage without origin check
window.addEventListener('message', (e) => {
  handleData(e.data);  // No origin verification!
});

// GOOD: Verify origin
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://trusted.com') return;
  handleData(e.data);
});
```

## Smart Contracts (Solidity)

### Access Control
```solidity
// BAD: tx.origin for auth (phishable)
require(tx.origin == owner);

// GOOD: msg.sender
require(msg.sender == owner);
```

### Reentrancy
```solidity
// BAD: External call before state update
function withdraw() external {
    uint amount = balances[msg.sender];
    (bool success,) = msg.sender.call{value: amount}("");
    balances[msg.sender] = 0;  // Too late!
}

// GOOD: Checks-Effects-Interactions
function withdraw() external {
    uint amount = balances[msg.sender];
    balances[msg.sender] = 0;  // State update FIRST
    (bool success,) = msg.sender.call{value: amount}("");
    require(success);
}
```

### Integer Overflow (pre-0.8.0)
```solidity
// BAD (Solidity < 0.8): Overflow
uint256 balance = type(uint256).max;
balance += 1;  // Wraps to 0!

// GOOD: SafeMath or Solidity 0.8+
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
balance = balance.add(1);  // Reverts on overflow
```

### Frontrunning
```solidity
// VULNERABLE: Visible pending transactions can be frontrun
function buyToken(uint maxPrice) external {
    require(tokenPrice <= maxPrice);  // Attacker can sandwich
    // ...
}

// MITIGATION: Commit-reveal or private mempools
```

## Concurrency

### Race Conditions
```python
# BAD: TOCTOU (Time-of-check to time-of-use)
if os.path.exists(filepath):
    with open(filepath) as f:  # File could be changed!
        return f.read()

# GOOD: Handle atomically
try:
    with open(filepath) as f:
        return f.read()
except FileNotFoundError:
    return None
```

```python
# BAD: Non-atomic check-then-act
if balance >= amount:
    balance -= amount  # Race condition!

# GOOD: Atomic operation or lock
with balance_lock:
    if balance >= amount:
        balance -= amount
```

## Configuration

### Dangerous Defaults

| Setting | Dangerous Value | Secure Value |
|---------|-----------------|--------------|
| Debug mode | `DEBUG=True` | `DEBUG=False` in prod |
| Secret key | Hardcoded/default | Environment variable |
| CORS | `*` | Specific origins |
| Cookie | `Secure=False` | `Secure=True; HttpOnly; SameSite=Strict` |
| TLS verify | `verify=False` | `verify=True` |
| File permissions | `777` | Least privilege |

### Environment Exposure
```bash
# BAD: Secrets in code
API_KEY = "sk-abc123..."

# BAD: Secrets in docker-compose.yml (committed)
environment:
  - API_KEY=sk-abc123

# GOOD: External secret management
API_KEY = os.environ['API_KEY']
# Or use: AWS Secrets Manager, Vault, etc.
```
