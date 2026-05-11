# Authentication & Security — Detailed Design

## Authentication Strategy

### Primary: Google OAuth (Login + Incremental Consent)

Two-step OAuth. Step 1 logs you in. Step 2 grants Gmail access.

**Step 1 — Login (minimal scopes):**

```
User → "Continue with Google" → Google consent (openid, email, profile) → Callback
→ Upsert user in DB → Issue Draftly JWT → Dashboard (limited)
```

Scopes requested: `openid`, `email`, `profile`
User sees: "Draftly wants to see your name and email" — low friction, no scary permissions.

**Step 2 — Gmail Access (mail scopes):**

```
User → "Enable AI Replies" → Google consent (gmail.readonly, gmail.send) → Callback
→ Encrypt & store Gmail tokens → Create connection record → Trigger onboarding sync
```

Scopes requested: `gmail.readonly`, `gmail.send`
User sees: "Draftly wants to read and send email on your behalf" — they understand WHY because they've seen the dashboard.

**Why two steps, not one:**
- Combining login + mail permissions in one consent screen scares users (mail.send is a big ask).
- Google recommends incremental consent — ask for permissions when the feature needs them.
- Higher conversion: users who decline mail permissions can still have an account and come back later.
- Separate OAuth consent reviews from Google (sensitive scopes require review).

**Why two steps could be wrong:**
- If 100% of users will always connect Gmail immediately, the second step is friction.
- For Draftly, it's the right call because the dashboard shows value context before asking for mail access.

### Secondary: Email/Password (fallback)

Available at API level. Not promoted in UI.

| Use case | Why it exists |
|----------|---------------|
| Admin accounts | Admins may not use Google |
| CI/CD testing | Automated tests need predictable auth |
| Future non-Gmail users | If we add Outlook, user might not have Google |
| Development | Faster than OAuth flow during local dev |

Implementation: bcrypt (cost factor 12) for password hashing. Standard email validation. Minimum password length enforced.

---

## JWT Design

| Parameter | Value | Why |
|-----------|-------|-----|
| Algorithm | RS256 (asymmetric) | Public key can verify tokens without knowing the signing key. Safer for multi-service — Python can verify without the private key. |
| Access token TTL | 15 minutes | Short window — limits damage from token theft |
| Refresh token TTL | 7 days | Long enough for normal usage without re-login |
| Refresh token storage | Hashed in DB | Can be revoked server-side (unlike stateless JWT) |

**Access token payload:**

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "user",
  "iat": 1713456000,
  "exp": 1713456900
}
```

**Why RS256 over HS256:**
- HS256 uses a shared secret. Both Node and Python would need the same secret to verify tokens. If either is compromised, the secret is exposed.
- RS256: Node signs with private key, Python verifies with public key. Even if Python is compromised, attacker can't forge tokens.

**When RS256 is overkill:** Single-service architecture where only one process signs and verifies. HS256 is simpler then.

---

## OAuth PKCE Flow

All OAuth flows use PKCE (Proof Key for Code Exchange), even though we're a server-side app.

**Why PKCE for a server-side app:**
- Standard authorization code flow sends `client_secret` in the token exchange. If it leaks (logs, misconfigured proxy), attacker can exchange stolen auth codes.
- PKCE generates a random `code_verifier` per request. Even if the auth code is intercepted, it's useless without the verifier.
- Google recommends PKCE for all OAuth2 flows per latest security best practices (RFC 7636).
- Once we add a frontend SPA, PKCE is mandatory. Using it from the start avoids a migration.

---

## Encryption

### Token Encryption: AES-256-GCM

All OAuth tokens (access + refresh) are encrypted at the application layer before storage.

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key length | 256 bits (32 bytes) |
| IV | 12 bytes, randomly generated per encryption |
| Auth tag | 16 bytes (GCM provides authentication) |
| Key source | `SECRET_ENCRYPTION_KEY` environment variable |
| Storage format | `bytea` column: `IV (12) || ciphertext || auth_tag (16)` |

**Why AES-256-GCM specifically:**
- Case study requires AES encryption for stored tokens.
- GCM mode provides both confidentiality AND integrity (tamper detection via auth tag).
- Alternative: AES-256-CBC requires a separate HMAC for integrity. GCM combines both.

**Key management risks:**
- If encryption key is lost → all tokens are unrecoverable → all users must re-connect Gmail.
- If encryption key is compromised → all tokens are exposed.
- Mitigation: back up the key securely. Plan for key rotation (re-encrypt all tokens with new key).

### Password Hashing: bcrypt

| Property | Value |
|----------|-------|
| Algorithm | bcrypt |
| Cost factor | 12 |
| Salt | Automatically generated per password |

**Why bcrypt cost 12:**
- Cost 10: ~100ms per hash. Fast enough for brute force on stolen hashes.
- Cost 12: ~300ms per hash. Resistant to brute force while still acceptable for login latency.
- Cost 14: ~1.2s per hash. Would add noticeable delay to login. Only necessary for high-value targets.

---

## Rate Limiting

Five layers, from broadest to most specific:

### Layer 1: Per-IP (DDoS protection)

- **Limit**: Configurable via `RATE_LIMIT_IP_PER_MIN` (default: 200 requests/minute)
- **Scope**: Raw IP address
- **Applied**: Per-route (not globally), using `ipRateLimitMiddleware`
- **Backend**: Redis-backed via `rate-limiter-flexible`
- **Risk**: Shared IPs (corporate NAT) may hit limit for legitimate users. Per-user limits (Layer 2) are the primary protection.

### Layer 2: Per-User (abuse prevention)

- **Limit**: Configurable via `RATE_LIMIT_USER_PER_MIN` (default: 100 requests/minute)
- **Scope**: Authenticated user ID
- **Applied**: Per-route after authentication, using `userRateLimitMiddleware`
- **Backend**: Redis-backed via `rate-limiter-flexible`

> **Note:** The implementation uses two rate limit layers (IP + user) applied per-route rather than the five-layer system originally designed. Per-endpoint and cost-based limits are not yet implemented as separate middleware.

### Layer 3: Per-Endpoint (resource protection)

| Endpoint Group | Limit | Why |
|---------------|-------|-----|
| Auth (login, register) | 10/min per IP | Credential stuffing protection |
| Send operations | 10/min per user | Prevent spam sending |
| Regenerate draft | 5/min per user | Prevent LLM cost abuse |
| Manual sync | 5/min per user | Prevent Gmail quota abuse |
| Draft read/write | 60/min per user | Normal dashboard usage |
| History/usage read | 30/min per user | Light read endpoints |

### Layer 4: Cost-based (LLM budget)

- **Hourly**: 50,000 tokens/user
- **Daily**: 200,000 tokens/user
- **Stored**: Redis counter (hourly), DB aggregate (daily)
- **Purpose**: Even if request-level limits aren't hit, a single "regenerate" request can consume 5000+ tokens. Cost-based limits cap total LLM spend per user.

### Layer 5: External quota (Gmail API)

- Gmail API: ~250 quota units/user/second (Google-imposed)
- Our system respects this via queue rate limiting (20 sync jobs/min)
- If Google returns 429, we back off exponentially and respect the `Retry-After` header

### Rate limit response format

```json
HTTP 429 Too Many Requests
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please try again later.",
    "retryAfter": 30
  }
}
Headers:
  Retry-After: 30
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: 1713456930
```

---

## Data Isolation

Every database query is scoped by `user_id`. No user can access another user's data.

This is enforced at the **repository layer**, not the controller layer. Controllers pass `userId` from the JWT. Repositories always include `WHERE user_id = $userId`.

Why not just controller-level checks: A controller might forget. A repository that always scopes by user_id is a safety net. Defense in depth.

---

## PII Handling in Logs

| What | Logged? | Example |
|------|---------|---------|
| User ID | ✅ | `userId: "abc-123"` |
| Email address | ❌ Never | Redacted |
| Email body | ❌ Never | Redacted |
| Thread subject | ❌ Never (contains PII) | Redacted |
| Draft content | ❌ Never | Redacted |
| Thread ID | ✅ | `threadId: "def-456"` |
| Draft status | ✅ | `status: "approved"` |
| LLM token count | ✅ | `tokens: 4200` |
| Error messages | ✅ (sanitized) | Strip any email content from error strings |

---

## Security Headers (Helmet)

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `Strict-Transport-Security` | `max-age=31536000` | Forces HTTPS |
| `X-XSS-Protection` | `0` | Disabled (modern browsers don't need it; can cause issues) |
| `Content-Security-Policy` | `default-src 'self'` | Restricts resource loading |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |

---

## CORS Configuration

```typescript
const corsOptions = {
  origin: config.CORS_ORIGINS.split(',').map(s => s.trim()),
  // Default: 'http://localhost:3000,http://localhost:3001,http://localhost:5173'
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
  credentials: true,
};
```

CORS origins are configurable via the `CORS_ORIGINS` environment variable (comma-separated list).

---

## Secrets Management

### Development

`.env` file. Listed in `.gitignore`. `.env.example` committed with placeholder values.

Required secrets:
```
# Auth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
JWT_PRIVATE_KEY=           # RS256 PEM
JWT_PUBLIC_KEY=            # RS256 PEM

# Encryption
SECRET_ENCRYPTION_KEY=     # 32-byte hex string

# Database
DB_PASSWORD=

# LLM
GEMINI_API_KEY=            # Google AI Studio key
OPENROUTER_API_KEY=        # When available

# Redis
REDIS_URL=redis://localhost:6379
```

### Production (future)

- Secrets in platform-native secret store (Railway secrets, AWS Secrets Manager, Azure Key Vault)
- Environment variables injected at deploy time
- No `.env` files in production
