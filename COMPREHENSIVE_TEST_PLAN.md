# Comprehensive Test Plan for SIROS ID Wallet

This document outlines the comprehensive test coverage plan for the SIROS ID wallet ecosystem, covering all major features across all transports.

## Test Infrastructure Overview

### sirosid-tests Structure
```
specs/
├── admin/           # Admin API tests (require ADMIN_TOKEN)
├── public/          # Public endpoint tests (no auth required)
├── shared/          # Reusable test definitions
├── vc/              # VC services tests (OpenID4VCI/VP)
└── webauthn/        # Browser-based WebAuthn tests
```

### sirosid-dev Environments
| Environment | Command | Services | Use Case |
|-------------|---------|----------|----------|
| Default | `make up` | mock-issuer, mock-verifier, mock-trust-pdp | Fast iteration |
| VC Services | `make up-vc` | vc-issuer, vc-verifier, vc-apigw, vc-registry | Real VC flows |
| go-trust Allow | `make up-vc-go-trust-allow` | Above + go-trust (allow mode) | Trust dev |
| go-trust Whitelist | `make up-vc-go-trust-whitelist` | Above + go-trust (whitelist) | Production-like |
| go-trust Deny | `make up-vc-go-trust-deny` | Above + go-trust (deny) | Negative tests |

## Transport Types

### 1. WebSocket Transport
- **Location**: `wallet-frontend/src/lib/transport/WebSocketTransport.ts`
- **Features**:
  - Persistent connection with real-time progress updates
  - Server-orchestrated multi-step flows
  - Sign request callbacks (generate_proof, sign_presentation)
  - Automatic reconnection with exponential backoff
  - Tenant-ID header support (X-Tenant-ID)
  - Authentication via Bearer token

### 2. HTTP Proxy Transport
- **Location**: `wallet-frontend/src/lib/transport/HttpProxyTransport.ts`
- **Features**:
  - Request-response pattern via REST API
  - Backend proxies requests to issuers/verifiers
  - Polling for progress updates
  - Simpler but higher latency

### 3. Direct Transport (Stub)
- **Location**: `wallet-frontend/src/lib/transport/DirectTransport.ts`
- **Status**: Not implemented (requires ecosystem CORS support)
- **Future**: Direct browser-to-issuer/verifier communication

## Feature Coverage Matrix

### Core User Flows
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| User Registration | ✓ | ✓ | N/A | Yes (shared) |
| User Login | ✓ | ✓ | N/A | Yes (shared) |
| PRF Verification | ✓ | ✓ | N/A | Yes (shared) |
| Multi-tenant | ✓ | ✓ | N/A | Yes (shared) |
| Cached User Login | ✓ | ✓ | N/A | Partial |

### OpenID4VCI (Credential Issuance)
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| Pre-authorized Code Flow | ✓ | ✓ | Stub | Yes (vc/) |
| Authorization Code Flow | ✓ | ✓ | Stub | No |
| TX Code Entry | ✓ | ✓ | Stub | No |
| Multi-credential Offer | ✓ | ✓ | Stub | Partial |
| Progress Updates | ✓ | Polling | N/A | No |
| Error Recovery | ✓ | ✓ | N/A | No |
| Credential Type: PID 1.8 | ✓ | ✓ | Stub | Yes |
| Credential Type: PID 1.5 | ✓ | ✓ | Stub | No |
| Credential Type: EHIC | ✓ | ✓ | Stub | Partial |
| Credential Type: Diploma | ✓ | ✓ | Stub | No |
| Credential Type: eduID | ✓ | ✓ | Stub | No |

### OpenID4VP (Credential Presentation)
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| Authorization Request | ✓ | ✓ | Stub | Yes (vc/) |
| Credential Selection UI | ✓ | ✓ | N/A | No |
| Selective Disclosure | ✓ | ✓ | Stub | No |
| VP Token Creation | ✓ | ✓ | N/A | Partial |
| OIDC Code Exchange | ✓ | ✓ | Stub | No |
| DID Client-ID Scheme | ✓ | N/A | N/A | **NEW - PR#41** |
| Trust Evaluation | ✓ | N/A | N/A | **NEW - PR#41** |

### AuthZEN Trust (PR #41 - NEW)
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| DELEGATE_TRUST_TO_BACKEND | ✓ | ✓ | N/A | No |
| Trust Evaluation Request | ✓ | N/A | N/A | No |
| Trust Decision Display | ✓ | N/A | N/A | No |
| Trust Framework Info | ✓ | N/A | N/A | No |
| Action Parameters | ✓ | N/A | N/A | No |
| Issuer Trust | ✓ | N/A | N/A | Partial (go-trust) |
| Verifier Trust | ✓ | N/A | N/A | Partial (go-trust) |

### Protocol Step Tracking (i18n)
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| Step Progress Reporting | ✓ | Polling | N/A | No |
| i18n Message Keys | ✓ | ✓ | N/A | No |
| Error Step Handling | ✓ | ✓ | N/A | No |
| User Input Steps | ✓ | ✓ | N/A | No |

### Multi-Tenant
| Feature | WebSocket | HTTP Proxy | Direct | Tests Exist |
|---------|-----------|------------|--------|-------------|
| Tenant URL Routing | ✓ | ✓ | N/A | Yes (shared) |
| Tenant Selector UI | ✓ | ✓ | N/A | Yes (shared) |
| Cross-tenant Isolation | ✓ | ✓ | N/A | Yes (shared) |
| Tenant-specific Config | ✓ | ✓ | N/A | Partial |
| X-Tenant-ID Header | ✓ | ✓ | N/A | **NEW - PR#41** |

## Test Gaps and New Tests Required

### 1. Transport-Specific Tests
**New file: `specs/shared/transport-modes.shared.ts`**
```typescript
// Tests that verify transport-specific behavior
- WebSocket connection lifecycle
- WebSocket reconnection handling
- HTTP proxy polling behavior
- Transport fallback (WS → HTTP)
- Transport mode configuration (TRANSPORT_MODE env var)
```

### 2. AuthZEN Trust Integration (PR #41)
**New file: `specs/vc/authzen-trust.spec.ts`**
```typescript
// AuthZEN-specific trust evaluation tests
- DELEGATE_TRUST_TO_BACKEND configuration
- Trust evaluation during OID4VP flow
- Trust framework display in UI
- Action parameters (credential type filtering)
- Integration with go-trust PDP
```

### 3. Protocol Step Tracking
**New file: `specs/shared/protocol-steps.shared.ts`**
```typescript
// Protocol step progress tracking tests
- Step progress reporting via WebSocket
- i18n message key resolution
- Error step handling
- User input step detection
- Step completion tracking
```

### 4. Credential Type Coverage
**Extend: `specs/vc/openid4vci.spec.ts`**
```typescript
// Add test cases for all credential types
- PID 1.5 (legacy format)
- EHIC (European Health Insurance Card)
- Diploma
- eduID
- Custom credential types via VCTM
```

### 5. End-to-End with Trust
**New file: `specs/vc/e2e-trust.spec.ts`**
```typescript
// Full E2E flows with trust evaluation
- Issue credential with issuer trust check
- Present credential with verifier trust check
- Trust rejection handling
- Trust framework enforcement
```

### 6. WebSocket-Specific Features
**New file: `specs/webauthn/websocket-transport.spec.ts`**
```typescript
// WebSocket transport-specific tests
- Connection establishment with auth token
- Sign request handling (generate_proof, sign_presentation)
- Real-time progress updates
- Reconnection after network issues
- Timeout handling
```

## Test Implementation Priority

### Phase 1: PR #41 Support (High Priority)
1. `specs/vc/authzen-trust.spec.ts` - AuthZEN trust evaluation
2. Add DELEGATE_TRUST_TO_BACKEND tests to existing trust specs
3. X-Tenant-ID header verification in WebSocket tests

### Phase 2: Transport Coverage (High Priority)
1. `specs/shared/transport-modes.shared.ts` - Transport abstraction tests
2. WebSocket-specific tests in `specs/webauthn/`
3. Transport fallback behavior

### Phase 3: Protocol Steps (Medium Priority)
1. `specs/shared/protocol-steps.shared.ts` - Step tracking
2. i18n message key verification
3. UI progress display tests

### Phase 4: Credential Expansion (Medium Priority)
1. Add all credential types to `openid4vci.spec.ts`
2. Selective disclosure tests in `openid4vp.spec.ts`
3. Multi-credential issuance tests

### Phase 5: E2E Consolidation (Lower Priority)
1. Migrate remaining wallet-e2e-tests patterns
2. Full E2E trust flows
3. Performance/stress tests

## Environment Variables for Testing

```bash
# Core URLs
FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:8080
ADMIN_URL=http://localhost:8081
ENGINE_URL=http://localhost:8082

# Admin Auth
ADMIN_TOKEN=e2e-test-admin-token-for-testing-purposes-only

# VC Services
ISSUER_URL=http://localhost:9000
VERIFIER_URL=http://localhost:9001
VC_APIGW_URL=http://localhost:9003
VC_REGISTRY_URL=http://localhost:9004

# Trust PDP
MOCK_PDP_URL=http://localhost:9091
GO_TRUST_ALLOW_URL=http://localhost:9095
GO_TRUST_WHITELIST_URL=http://localhost:9096
GO_TRUST_DENY_URL=http://localhost:9097

# Transport Mode
TRANSPORT_MODE=auto|websocket|http

# Service Expectations
EXPECT_VC_SERVICES=true|false
EXPECT_TRUST_MODE=allow|whitelist|deny

# WebAuthn
SOFT_FIDO2_PATH=/path/to/soft-fido2
```

## Running Tests

```bash
# All tests with mock services
make test

# VC services tests only
make test-vc

# Trust integration tests
make test-trust

# WebAuthn tests (CDP)
make test-webauthn-ci

# WebAuthn tests (soft-fido2)
SOFT_FIDO2_PATH=/path/to/soft-fido2 make test-webauthn-real

# Specific transport mode
TRANSPORT_MODE=websocket make test
TRANSPORT_MODE=http make test
```

## CI/CD Integration

The test suite is designed to run in CI/CD with different configurations:

1. **PR Builds**: Run public + admin tests with mock services
2. **Nightly**: Run full test suite with VC services
3. **Release**: Run all tests with go-trust in whitelist mode

## Dependencies for PR #41

Before PR #41 can be fully tested:
1. **go-wallet-backend AuthZEN endpoints PR** must be merged
2. **wallet-common AuthZEN client** must be on main
3. **sirosid-dev** must have go-trust compose files updated

## Next Actions

1. [ ] Create `specs/vc/authzen-trust.spec.ts` for PR #41 features
2. [ ] Create `specs/shared/transport-modes.shared.ts`
3. [ ] Add transport mode switching to existing tests
4. [ ] Update sirosid-dev with go-trust AuthZEN endpoints
5. [ ] Add comprehensive credential type tests
6. [ ] Implement protocol step tracking tests
