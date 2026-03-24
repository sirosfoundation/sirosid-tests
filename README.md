# sirosid-tests

End-to-end test suites for the SIROS ID wallet ecosystem.

## Overview

This repository contains Playwright-based E2E tests that can run against any SIROS ID environment:

- **Local development** (sirosid-dev)
- **QA/Staging environments**
- **Production environments** (public tests only)

## Test Categories

| Category | Directory | Admin API Required | Description |
|----------|-----------|-------------------|-------------|
| **Public** | `specs/public/` | No | Tests that use only public endpoints |
| **Admin** | `specs/admin/` | Yes | Tests requiring admin API access |
| **WebAuthn** | `specs/webauthn/` | Yes | Browser-based credential flow tests |

### Public Tests

These tests can run against any environment, including production:

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

## Quick Start

### Against Local Development (sirosid-dev)

```bash
# Terminal 1: Start development environment
cd ../sirosid-dev && make up

# Terminal 2: Run tests
make test
```

### Against QA/Staging

```bash
export FRONTEND_URL=https://wallet.qa.siros.org
export BACKEND_URL=https://api.qa.siros.org
export ADMIN_URL=https://admin.qa.siros.org
export ADMIN_TOKEN=<your-qa-admin-token>

make test
```

### Against Production (Public Tests Only)

```bash
export FRONTEND_URL=https://wallet.siros.org
export BACKEND_URL=https://api.siros.org

make test-public
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FRONTEND_URL` | Yes | Wallet frontend URL |
| `BACKEND_URL` | Yes | Backend API URL |
| `ADMIN_URL` | Admin tests | Admin API URL |
| `ADMIN_TOKEN` | Admin tests | Admin authentication token |
| `ENGINE_URL` | Optional | Credential engine URL |
| `MOCK_ISSUER_URL` | Optional | Override issuer URL |
| `MOCK_VERIFIER_URL` | Optional | Override verifier URL |
| `TRUST_PDP_URL` | Optional | Trust PDP URL |
| `VCTM_REGISTRY_URL` | Optional | VCTM registry URL |

## Make Targets

```bash
make install          # Install dependencies
make test             # Run all tests (requires admin access)
make test-public      # Run public tests only (no admin required)
make test-admin       # Run admin tests only
make test-webauthn    # Run WebAuthn browser tests
make test-ci          # CI mode (headless, reporter)
make lint             # Run linter
make clean            # Clean test artifacts
```

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

## Directory Structure

```
sirosid-tests/
├── specs/
│   ├── public/         # No admin API required
│   │   ├── registry.spec.ts
│   │   ├── go-trust.spec.ts
│   │   └── api-compatibility.spec.ts
│   ├── admin/          # Requires ADMIN_TOKEN
│   │   ├── admin-api.spec.ts
│   │   └── go-trust-credential.spec.ts
│   ├── webauthn/       # Browser-based tests
│   │   ├── user-flows.spec.ts
│   │   ├── credential-flow.spec.ts
│   │   ├── tenant-selector.spec.ts
│   │   └── trust-integration.spec.ts
│   └── shared/         # Shared test logic
├── helpers/            # Test utilities
├── playwright.config.ts
├── package.json
└── Makefile
```

## CI/CD Integration

### GitHub Actions Example

```yaml
jobs:
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
```

## See Also

- [sirosid-dev](https://github.com/sirosfoundation/sirosid-dev) - Local development environment
- [go-wallet-backend](https://github.com/sirosfoundation/go-wallet-backend) - Wallet backend
- [go-trust](https://github.com/sirosfoundation/go-trust) - Trust PDP
