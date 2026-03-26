# sirosid-tests

End-to-end test suites for the SIROS ID wallet ecosystem.

## Overview

This repository contains Playwright-based E2E tests that can run against any SIROS ID environment:

- **Local development** with mock services (sirosid-dev)
- **Local development** with production-like VC services (sirosid-dev + VC stack)
- **QA/Staging environments** (full test suite)
- **Production environments** (public tests only)
- **Any remote wallet** (subset of tests appropriate for external systems)

## Test Categories

| Category | Directory | Admin API Required | Description |
|----------|-----------|-------------------|-------------|
| **Public** | `specs/public/` | No | Tests that use only public endpoints |
| **Admin** | `specs/admin/` | Yes | Tests requiring admin API access |
| **WebAuthn** | `specs/webauthn/` | Yes | Browser-based credential flow tests |
| **VC Services** | `specs/vc/` | Yes | Production-like VC issuance/verification |

### Public Tests

These tests can run against any environment, including production and remote wallets:

- `registry.spec.ts` - VCTM registry endpoint tests
- `go-trust.spec.ts` - Trust PDP API tests  
- `api-compatibility.spec.ts` - Public API compatibility

### Admin Tests

These tests require `ADMIN_URL` and `ADMIN_TOKEN`:

- `admin-api.spec.ts` - Tenant/issuer/verifier CRUD
- `go-trust-credential.spec.ts` - Credential flows with trust evaluation

### WebAuthn Tests

Full browser-based tests with virtual authenticators:

- `user-flows.spec.ts` - Complete user registration and authentication
- `credential-flow.spec.ts` - Credential issuance and presentation
- `tenant-selector.spec.ts` - Multi-tenant routing
- `trust-integration.spec.ts` - Trust evaluation in credential flows

### VC Services Tests (Production-like)

Tests against the full VC stack (issuer, verifier, apigw, registry):

- `openid4vci.spec.ts` - OpenID4VCI credential issuance flows
- `openid4vp.spec.ts` - OpenID4VP credential verification flows
- `trust-integration.spec.ts` - go-trust PDP modes (allow/whitelist/deny)
- `e2e-flows.spec.ts` - Complete issue-then-verify flows

**Prerequisites:** Start sirosid-dev with VC services:
```bash
cd ../sirosid-dev && make up-vc
# Or with go-trust:
cd ../sirosid-dev && make up-vc-go-trust-allow
```

---

## Running Against Local Environments

### Option 1: Mock Services (Fastest for Development)

The default sirosid-dev stack uses lightweight mock services that simulate issuer/verifier behavior without full credential processing.

```bash
# Terminal 1: Start mock-based environment
cd ../sirosid-dev
make up

# Terminal 2: Run tests
cd ../sirosid-tests
make test
```

**Services Started:**
| Service | Port | Description |
|---------|------|-------------|
| wallet-frontend | 3000 | Web wallet UI |
| wallet-backend | 8080/8081/8082 | Backend + Admin + Engine |
| mock-issuer | 9000 | OpenID4VCI mock (instant credentials) |
| mock-verifier | 9001 | OpenID4VP mock |
| mock-trust-pdp | 9091 | Always-allow trust mock |

**Best for:**
- Rapid iteration during development
- Testing wallet UI flows
- Testing backend API integration
- CI pipelines (fast startup)

### Option 2: Production-like VC Services

For testing with real OpenID4VCI/VP credential issuance and verification:

```bash
# Terminal 1: Start VC services
cd ../sirosid-dev
make up-vc

# Terminal 2: Run tests
cd ../sirosid-tests
make test
```

**Additional Services (on top of wallet):**
| Service | HTTP Port | gRPC Port | Description |
|---------|-----------|-----------|-------------|
| vc-issuer | 9000 | 9090 | Full OpenID4VCI issuer |
| vc-verifier | 9001 | 9091 | OpenID4VP + OIDC |
| vc-mockas | 9002 | - | Mock authentication server |
| vc-apigw | 9003 | - | OAuth2 authorization server |
| vc-registry | 9004 | 9094 | Status lists and revocation |
| mongodb | 27017 | - | Credential storage |

**Best for:**
- Testing actual credential cryptography
- Testing status list / revocation
- Testing OIDC integration
- Pre-production validation

### Option 3: VC Services with Trust Evaluation

For testing trust policy enforcement during credential flows:

```bash
# Terminal 1: Start VC + go-trust (choose one)
cd ../sirosid-dev

# Allow-all mode (development)
make up-vc-go-trust-allow

# Whitelist mode (staging-like)
make up-vc-go-trust-whitelist

# Deny-all mode (negative testing)
make up-vc-go-trust-deny

# Terminal 2: Run trust-related tests
cd ../sirosid-tests
make test-trust-integration
```

**go-trust Service Ports:**
| Service | Port | Behavior |
|---------|------|----------|
| go-trust-allow | 9095 | Trusts all issuers/verifiers |
| go-trust-whitelist | 9096 | Only trusts configured entities |
| go-trust-deny | 9097 | Rejects all trust requests |

---

## Running Against Remote Wallets

### Which Tests Work Against Remote Systems?

Not all tests are appropriate for remote or production environments:

| Test Suite | Remote Wallet | Why |
|------------|---------------|-----|
| **Public tests** | ✅ Yes | Only use public APIs |
| **Admin tests** | ⚠️ If admin access | Requires admin token |
| **WebAuthn tests** | ⚠️ Conditional | Requires issuer/verifier URLs |

### Public-Only Testing (Safest for Remote)

Tests that don't modify state and only read public endpoints:

```bash
# Against QA environment
FRONTEND_URL=https://wallet.qa.siros.org \
BACKEND_URL=https://api.qa.siros.org \
make test-public

# Against production
FRONTEND_URL=https://wallet.siros.org \
BACKEND_URL=https://api.siros.org \
make test-public
```

**What gets tested:**
- Backend health endpoints
- API version compatibility
- Public configuration endpoints
- VCTM registry connectivity (if `VCTM_REGISTRY_URL` set)

### Full Testing (QA/Staging)

When you have admin access to the remote environment:

```bash
FRONTEND_URL=https://wallet.qa.siros.org \
BACKEND_URL=https://api.qa.siros.org \
ADMIN_URL=https://admin.qa.siros.org \
ADMIN_TOKEN=<your-qa-admin-token> \
make test
```

### Credential Flow Testing Against Remote Issuer/Verifier

To test credential flows using a remote wallet but local mock issuer/verifier:

```bash
# Start local mock services only
cd ../sirosid-dev && docker compose -f docker-compose.test.yml up -d mock-issuer mock-verifier mock-trust-pdp

# Test against remote wallet with local mocks
cd ../sirosid-tests
FRONTEND_URL=https://wallet.qa.siros.org \
BACKEND_URL=https://api.qa.siros.org \
ADMIN_URL=https://admin.qa.siros.org \
ADMIN_TOKEN=<your-qa-admin-token> \
MOCK_ISSUER_URL=http://localhost:9000 \
MOCK_VERIFIER_URL=http://localhost:9001 \
make test-credential
```

**Note:** This requires the remote wallet backend to be configured to reach your local machine (e.g., via ngrok or similar).

### Testing with Remote Issuers/Verifiers

To test against real external issuers and verifiers:

```bash
FRONTEND_URL=https://wallet.qa.siros.org \
BACKEND_URL=https://api.qa.siros.org \
ADMIN_URL=https://admin.qa.siros.org \
ADMIN_TOKEN=<your-qa-admin-token> \
ISSUER_URL=https://issuer.external.example.com \
VERIFIER_URL=https://verifier.external.example.com \
make test-credential
```

---

## Environment Variables Reference

### Core Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FRONTEND_URL` | Yes | `http://localhost:3000` | Wallet frontend URL |
| `BACKEND_URL` | Yes | `http://localhost:8080` | Backend API URL |
| `ENGINE_URL` | Optional | `http://localhost:8082` | Credential engine URL |

### Admin Access

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_URL` | Admin tests | `http://localhost:8081` | Admin API URL |
| `ADMIN_TOKEN` | Admin tests | (dev token) | Admin authentication token |

### Credential Services

| Variable | When Needed | Default | Description |
|----------|-------------|---------|-------------|
| `MOCK_ISSUER_URL` | Credential tests | `http://localhost:9000` | OpenID4VCI issuer |
| `MOCK_VERIFIER_URL` | Credential tests | `http://localhost:9001` | OpenID4VP verifier |
| `ISSUER_URL` | Alt for external | Same as MOCK_ISSUER_URL | External issuer URL |
| `VERIFIER_URL` | Alt for external | Same as MOCK_VERIFIER_URL | External verifier URL |

### Trust and Registry

| Variable | When Needed | Default | Description |
|----------|-------------|---------|-------------|
| `TRUST_PDP_URL` | Trust tests | `http://localhost:9091` | Trust PDP URL |
| `VCTM_REGISTRY_URL` | Registry tests | `http://localhost:8097` | VCTM registry URL |

### Test Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `TRANSPORT_MODE` | `auto`, `http`, `websocket` | `auto` | Backend transport |

---

## Make Targets

### Primary Test Commands

```bash
make install          # Install dependencies
make test             # Run all tests (requires admin access)
make test-public      # Run public tests only (no admin required)
make test-admin       # Run admin tests only
make test-webauthn    # Run WebAuthn browser tests
make test-ci          # CI mode (headless, reporter)
```

### VC Services Tests

```bash
make test-vc              # All VC services tests
make test-vc-issuance     # OpenID4VCI issuance tests
make test-vc-verification # OpenID4VP verification tests
make test-vc-trust        # VC + go-trust integration
make test-vc-e2e          # Full E2E credential flows
```

### Specific Test Suites

```bash
make test-registry           # VCTM registry tests
make test-go-trust           # Trust PDP API tests
make test-credential         # Credential flow tests
make test-tenant             # Tenant selector tests
make test-trust-integration  # Trust evaluation in flows
```

### Utilities

```bash
make check-env        # Verify environment connectivity
make check-vc-env     # Verify VC services connectivity
make lint             # Run linter
make clean            # Clean test artifacts
```

---

## Test Modes

### CDP Mode (Default, Headless)

Uses Chrome DevTools Protocol virtual authenticator:

```bash
make test
```

### Soft-FIDO2 Mode (Browser Display Required)

Uses soft-fido2 virtual authenticator with real browser:

```bash
make test-soft-fido2
```

---

## Directory Structure

```
sirosid-tests/
├── specs/
│   ├── public/                    # No admin API required
│   │   ├── registry.spec.ts
│   │   ├── go-trust.spec.ts
│   │   └── api-compatibility.spec.ts
│   ├── admin/                     # Requires ADMIN_TOKEN
│   │   ├── admin-api.spec.ts
│   │   └── go-trust-credential.spec.ts
│   ├── webauthn/                  # Browser-based tests
│   │   ├── user-flows.spec.ts
│   │   ├── credential-flow.spec.ts
│   │   ├── tenant-selector.spec.ts
│   │   └── trust-integration.spec.ts
│   ├── vc/                        # Production-like VC services
│   │   ├── openid4vci.spec.ts     # Credential issuance
│   │   ├── openid4vp.spec.ts      # Credential verification
│   │   ├── trust-integration.spec.ts  # go-trust modes
│   │   └── e2e-flows.spec.ts      # Complete flows
│   └── shared/                    # Shared test logic
│       ├── credential-flow.shared.ts
│       ├── user-flows.shared.ts
│       └── ...
├── helpers/                       # Test utilities
│   ├── vc-services.ts             # VC services API helper
│   ├── shared-helpers.ts
│   └── ...
├── playwright.config.ts           # Default config
├── playwright.webauthn-ci.config.ts
├── playwright.real-webauthn.config.ts
├── package.json
└── Makefile
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
jobs:
  # Public tests against QA (safe, no admin needed)
  test-public:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: make install
      - name: Test Public APIs
        run: make test-public
        env:
          FRONTEND_URL: https://wallet.qa.siros.org
          BACKEND_URL: https://api.qa.siros.org

  # Full tests against QA (requires secrets)
  test-full:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: make install
      - name: Test All
        run: make test-ci
        env:
          FRONTEND_URL: https://wallet.qa.siros.org
          BACKEND_URL: https://api.qa.siros.org
          ADMIN_URL: https://admin.qa.siros.org
          ADMIN_TOKEN: ${{ secrets.QA_ADMIN_TOKEN }}

  # Full stack with local services
  test-local:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          path: sirosid-tests
      - uses: actions/checkout@v4
        with:
          repository: sirosfoundation/sirosid-dev
          path: sirosid-dev
      - name: Start Environment
        run: cd sirosid-dev && make up
      - name: Run Tests
        run: cd sirosid-tests && make test-ci
```

---

## Troubleshooting

### Tests failing with "Connection refused"

```bash
# Check if services are running
make check-env

# Check specific service
curl http://localhost:8080/health
```

### WebAuthn tests timing out

WebAuthn tests require the CDP virtual authenticator. Ensure you're using:
```bash
make test-webauthn  # Uses correct playwright config
```

### Tests pass locally but fail in CI

Check environment variables are propagated:
```bash
echo $FRONTEND_URL $BACKEND_URL $ADMIN_URL
```

### Remote wallet can't reach local mocks

When testing remote wallet with local mock issuer/verifier, the wallet backend needs to reach your machine. Options:
1. Use ngrok: `ngrok http 9000`
2. Use a VPN if available
3. Deploy mocks to a reachable host

---

## See Also

- [sirosid-dev](https://github.com/sirosfoundation/sirosid-dev) - Local development environment
- [go-wallet-backend](https://github.com/sirosfoundation/go-wallet-backend) - Wallet backend
- [go-trust](https://github.com/sirosfoundation/go-trust) - Trust PDP
