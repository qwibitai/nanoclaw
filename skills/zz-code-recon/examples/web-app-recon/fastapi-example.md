# Example: FastAPI Application Recon

Complete reconnaissance walkthrough for a FastAPI-based web application.

## Scenario

You've been asked to audit a FastAPI application for an e-commerce platform. This example walks through the complete recon process.

## Phase 1: Initial Discovery

### 1.1 Project Structure
```bash
$ tree -L 2
.
├── README.md
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── requirements.txt
├── alembic/
│   └── versions/
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── config.py
│   ├── api/
│   ├── core/
│   ├── db/
│   ├── models/
│   ├── schemas/
│   └── services/
├── tests/
└── scripts/
```

### 1.2 Technology Identification
```bash
$ cat pyproject.toml
[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.100.0"
uvicorn = "^0.23.0"
sqlalchemy = "^2.0.0"
pydantic = "^2.0.0"
python-jose = "^3.3.0"
passlib = "^1.7.4"
bcrypt = "^4.0.0"
redis = "^4.6.0"
celery = "^5.3.0"
stripe = "^6.0.0"
```

### 1.3 Dependency Analysis

**Security-Critical Dependencies:**
| Package | Version | Purpose | Notes |
|---------|---------|---------|-------|
| python-jose | 3.3.0 | JWT handling | Check algorithm validation |
| passlib/bcrypt | 4.0.0 | Password hashing | Good choice |
| stripe | 6.0.0 | Payments | Review webhook handling |
| sqlalchemy | 2.0.0 | ORM | Check for raw queries |

## Phase 2: Architecture Mapping

### 2.1 Entry Point Discovery
```bash
$ grep -rn "@router\|@app\." app/api/ --include="*.py"

app/api/v1/auth.py:15:@router.post("/login")
app/api/v1/auth.py:32:@router.post("/register")
app/api/v1/auth.py:48:@router.post("/refresh")
app/api/v1/auth.py:62:@router.post("/logout")
app/api/v1/users.py:12:@router.get("/me")
app/api/v1/users.py:25:@router.put("/me")
app/api/v1/users.py:42:@router.get("/{user_id}")
app/api/v1/products.py:10:@router.get("/")
app/api/v1/products.py:22:@router.get("/{product_id}")
app/api/v1/orders.py:15:@router.post("/")
app/api/v1/orders.py:45:@router.get("/")
app/api/v1/orders.py:58:@router.get("/{order_id}")
app/api/v1/admin.py:12:@router.get("/users")
app/api/v1/admin.py:25:@router.delete("/users/{user_id}")
app/api/v1/webhooks.py:8:@router.post("/stripe")
```

### 2.2 Architecture Diagram
```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                             │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                     NGINX (Proxy)                           │
│              - TLS termination                              │
│              - Rate limiting                                │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                    FASTAPI APP                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Middleware                         │   │
│  │    - CORS        - Request ID     - Error Handler   │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌───────────┬───────────┼───────────┬───────────┐        │
│  │   Auth    │   Users   │  Products │  Orders   │        │
│  │   API     │   API     │   API     │   API     │        │
│  └─────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘        │
│        │           │           │           │               │
│  ┌─────▼───────────▼───────────▼───────────▼─────┐        │
│  │              Service Layer                     │        │
│  │    (Business Logic, Validation)               │        │
│  └─────────────────────┬─────────────────────────┘        │
└────────────────────────┼────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐ ┌───────▼──────┐ ┌───────▼──────┐
│  PostgreSQL  │ │    Redis     │ │   Celery     │
│  (Primary)   │ │   (Cache)    │ │  (Workers)   │
└──────────────┘ └──────────────┘ └───────┬──────┘
                                          │
                                  ┌───────▼──────┐
                                  │   Stripe     │
                                  │   (Payments) │
                                  └──────────────┘
```

### 2.3 Trust Boundaries
```
┌─────────────────────────────────────────────────────────────┐
│ UNTRUSTED: Internet                                         │
├─────────────────────────────────────────────────────────────┤
│ BOUNDARY 1: TLS + Rate Limiting (NGINX)                     │
├─────────────────────────────────────────────────────────────┤
│ SEMI-TRUSTED: Authenticated Users                           │
├─────────────────────────────────────────────────────────────┤
│ BOUNDARY 2: Role-Based Authorization                        │
├─────────────────────────────────────────────────────────────┤
│ TRUSTED: Admin Users                                        │
├─────────────────────────────────────────────────────────────┤
│ BOUNDARY 3: Database Access Controls                        │
├─────────────────────────────────────────────────────────────┤
│ INTERNAL: Database / Redis / Celery                         │
└─────────────────────────────────────────────────────────────┘
```

## Phase 3: Entry Point Analysis

### 3.1 Endpoint Inventory
| Method | Path | Auth | Rate Limit | Input | Handler |
|--------|------|------|------------|-------|---------|
| POST | /api/v1/auth/login | None | 5/min | JSON | auth.login |
| POST | /api/v1/auth/register | None | 3/min | JSON | auth.register |
| POST | /api/v1/auth/refresh | JWT | 10/min | Cookie | auth.refresh |
| GET | /api/v1/users/me | JWT | 60/min | None | users.get_me |
| PUT | /api/v1/users/me | JWT | 10/min | JSON | users.update_me |
| GET | /api/v1/users/{id} | JWT+Admin | 60/min | Path | users.get_user |
| GET | /api/v1/products | None | 100/min | Query | products.list |
| GET | /api/v1/products/{id} | None | 100/min | Path | products.get |
| POST | /api/v1/orders | JWT | 10/min | JSON | orders.create |
| GET | /api/v1/orders | JWT | 60/min | Query | orders.list |
| GET | /api/v1/orders/{id} | JWT | 60/min | Path | orders.get |
| GET | /api/v1/admin/users | JWT+Admin | 30/min | Query | admin.list_users |
| DELETE | /api/v1/admin/users/{id} | JWT+Admin | 5/min | Path | admin.delete_user |
| POST | /api/v1/webhooks/stripe | Sig Verify | 100/min | JSON | webhooks.stripe |

### 3.2 Authentication Deep Dive

**File:** `app/core/security.py`
```python
# JWT Configuration
ALGORITHM = "HS256"  # Note: Could be RS256 for better security
ACCESS_TOKEN_EXPIRE_MINUTES = 30
REFRESH_TOKEN_EXPIRE_DAYS = 7

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token: str):
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=401)
```

**Notes:**
- HS256 used (shared secret) - consider RS256 for separation
- Algorithm is validated (good - prevents alg:none attack)
- Token expiration implemented

### 3.3 Authorization Deep Dive

**File:** `app/core/dependencies.py`
```python
async def get_current_user(token: str = Depends(oauth2_scheme)):
    payload = verify_token(token)
    user_id = payload.get("sub")
    user = await user_service.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401)
    return user

async def require_admin(user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(status_code=403)
    return user
```

**Usage Example:**
```python
@router.get("/admin/users")
async def list_users(user: User = Depends(require_admin)):
    return await user_service.list_all()
```

## Phase 4: Critical Function Analysis

### 4.1 Order Creation Flow

**File:** `app/services/order_service.py:create_order()`

```python
async def create_order(user_id: int, order_data: OrderCreate) -> Order:
    # 1. Validate product availability
    for item in order_data.items:
        product = await product_repo.get(item.product_id)
        if product.stock < item.quantity:
            raise InsufficientStock(item.product_id)

    # 2. Calculate total
    total = sum(item.price * item.quantity for item in order_data.items)

    # 3. Create Stripe payment intent
    intent = stripe.PaymentIntent.create(
        amount=int(total * 100),
        currency="usd",
        customer=user.stripe_customer_id,
    )

    # 4. Create order
    order = await order_repo.create(
        user_id=user_id,
        items=order_data.items,
        total=total,
        payment_intent_id=intent.id,
        status="pending"
    )

    # 5. Reserve stock
    for item in order_data.items:
        await product_repo.decrement_stock(item.product_id, item.quantity)

    return order
```

**Security Considerations:**
- [ ] Race condition between stock check and decrement?
- [ ] Price from client vs. server-side lookup?
- [ ] Stripe error handling?
- [ ] Transaction atomicity?

### 4.2 Webhook Handler

**File:** `app/api/v1/webhooks.py`

```python
@router.post("/stripe")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
        )
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400)

    if event["type"] == "payment_intent.succeeded":
        payment_intent = event["data"]["object"]
        await order_service.mark_paid(payment_intent["id"])

    return {"status": "ok"}
```

**Security Considerations:**
- Signature verification present (good)
- Check for idempotency (replay protection)?
- Event type handling complete?

## Phase 5: Security Controls Summary

| Control | Implementation | Status | Notes |
|---------|----------------|--------|-------|
| Authentication | JWT (HS256) | Implemented | Consider RS256 |
| Authorization | Role-based decorator | Implemented | Check all endpoints |
| Password Storage | bcrypt | Implemented | Good |
| Input Validation | Pydantic | Implemented | Review schemas |
| Output Encoding | FastAPI auto | Implemented | Check custom responses |
| SQL Injection | SQLAlchemy ORM | Likely safe | Audit raw queries |
| Rate Limiting | NGINX | Implemented | Review limits |
| CORS | Middleware | Implemented | Check origins |
| Webhook Auth | Stripe signature | Implemented | Good |
| Error Handling | Exception handlers | Implemented | Check info leakage |

## High-Risk Areas Identified

1. **Order Creation Race Condition**
   - Location: `order_service.py:create_order()`
   - Concern: Stock check and decrement not atomic
   - Priority: High

2. **Admin Endpoint Coverage**
   - Location: `app/api/v1/admin.py`
   - Concern: Verify all admin endpoints require authentication
   - Priority: High

3. **Price Calculation**
   - Location: Order creation flow
   - Concern: Verify prices come from server, not client
   - Priority: Medium

4. **Stripe Webhook Idempotency**
   - Location: `webhooks.py`
   - Concern: Replay attacks possible?
   - Priority: Medium

## Open Questions

- [ ] Where is the SECRET_KEY stored? (check `config.py`)
- [ ] Are there any raw SQL queries? (`grep "text("`)
- [ ] How is user deletion handled? (soft delete? cascade?)
- [ ] Is there an admin panel beyond API endpoints?
- [ ] What monitoring/alerting exists for security events?

## Next Steps

1. Deep dive into order creation for race conditions
2. Map all SQL queries for injection risks
3. Test authentication edge cases
4. Review Stripe integration for payment bypass
5. Check admin endpoint authorization
