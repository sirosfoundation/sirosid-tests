# OIDF Conformance Suite Triage Report — 2026-05-15

## Summary

Ran OID4VCI and OID4VP conformance tests against the SIROS wallet stack using both **websocket** and **WMP** transports. All test setup issues were resolved (10 fixes). There is one remaining backend bug (BUG-1) that blocks both VCI and VP conformance.

| Suite  | Transport | Modules | Result |
|--------|-----------|---------|--------|
| OID4VCI | WebSocket | 3 | All FAILED (invalid_client at token exchange) |
| OID4VCI | WMP       | 3 | All FAILED (same — invalid_client at token exchange) |
| OID4VP  | WebSocket | 14 | All FAILED — "No matching credentials" (wallet has no issued credentials) |
| OID4VP  | WMP       | 14 | Same as websocket |

Transport does not affect conformance results — failures are identical on both transports.

---

## Test Setup Fixes Applied

### 1. RFC 8615 Well-Known URL Construction (3 files)
- **Files**: `pkg/issuermetadata/resolver.go`, `internal/metadata/issuer.go`, `internal/engine/oid4vci.go`
- **Problem**: Metadata URLs were constructed as `{issuer}/.well-known/openid-credential-issuer` instead of RFC 8615 format `{scheme}://{host}/.well-known/openid-credential-issuer{path}`
- **Fix**: Changed to proper RFC 8615 URL construction using `url.Parse()`
- **Status**: ✅ Fixed, metadata fetching confirmed working

### 2. Docker Image Tag Mismatch
- **Problem**: `docker build` was creating `wallet-backend:latest` but compose expects `wallet-backend-e2e-test:local`
- **Fix**: Use `docker compose build` instead of `docker build`
- **Status**: ✅ Fixed

### 3. VP Config: Missing Client JWKS
- **File**: `configs/conformance/vp-wallet-config.json`
- **Problem**: VP config only had `alias`, `description`, `server.authorization_endpoint`, `client.client_id`
- **Fix**: Added `client.jwks` with EC P-256 key pair
- **Status**: ✅ Fixed

### 4. VP Config: Missing x5c Certificate Chain
- **Problem**: For `x509_san_dns` client_id_scheme, the signing key must have an `x5c` entry with a certificate containing `SAN DNS:conformance.example.com`
- **Fix**: Generated self-signed EC cert with matching SAN DNS, added `x5c` to client JWKS
- **Status**: ✅ Fixed

### 5. VP Config: Missing DCQL Query
- **Problem**: Conformance suite requires `client.dcql` with credential query definitions
- **Fix**: Added DCQL query requesting `dc+sd-jwt` with `vct_values: ["urn:eudi:pid:1"]`
- **Status**: ✅ Fixed

### 6. VP Interaction URL Extraction
- **File**: `helpers/conformance-api.ts`
- **Problem**: `getWalletInteractionUrl()` didn't check the `redirect_to_authorization_endpoint` field in test log entries
- **Fix**: Added extraction of `redirect_to_authorization_endpoint` field
- **Status**: ✅ Fixed

### 7. VP Redirect Interception
- **File**: `specs/conformance/oid4vp-wallet.spec.ts`
- **Problem**: Browser URL fallback navigated to `/authorize` which returned 400 without proper params
- **Fix**: Added `page.request.fetch()` with `maxRedirects: 0` to capture `openid4vp://` redirect
- **Status**: ✅ Fixed (but not needed now that URL extraction works)

### 8. Soft-FIDO2 Dependency Removal
- **File**: `specs/conformance/oid4vp-wallet.spec.ts`
- **Problem**: VP test depended on `soft-fido2` WebAuthn emulator
- **Fix**: Replaced with CDP Virtual Authenticator (`WebAuthnHelper`)
- **Status**: ✅ Fixed

### 9. VCI client_auth_type Reverted
- **File**: `specs/conformance/oid4vci-wallet.spec.ts`
- **Problem**: Changed to `'none'` which is not a valid option for VCI wallet modules
- **Fix**: Reverted to `'private_key_jwt'`
- **Status**: ✅ Fixed

### 10. VP SPA Navigation (Session Preservation)
- **File**: `specs/conformance/oid4vp-wallet.spec.ts`
- **Problem**: `presentCredential()` used `page.goto()` to navigate to the VP callback URL, which caused a full page reload. This tore down the WebSocket connection and started a new session, leaving the in-progress VP flow orphaned on the old session. The backend would eventually close the old session (~65s later) with "session closed" error.
- **Fix**: Replaced `page.goto()` with SPA pushState navigation — same pattern used by VCI tests. Uses `window.history.pushState()` + `PopStateEvent` to inject VP params into the URL, which triggers `UriHandlerProvider` to navigate to `/cb` within the SPA without reloading.
- **Status**: ✅ Fixed — VP flow now progresses through all stages (parsing_request → evaluating_verifier_trust → credential_selection)

---

## Backend/Wallet Bugs Catalogued

### BUG-1: Token Exchange Lacks Client Authentication (CRITICAL)

**Affects**: All OID4VCI conformance modules (both transports)

**Symptom**: Token endpoint returns `401 invalid_client`

**Root Cause**: `go-wallet-backend/internal/engine/oid4vci.go` `exchangePreAuthCode()` (line ~996-1055) only sends:
- `grant_type=urn:ietf:params:oauth:grant-type:pre-authorized_code`
- `pre-authorized_code=<code>`
- `tx_code=<value>`

Missing:
- `client_id` parameter
- `client_assertion` (JWT signed with client key)
- `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`

The `CredentialIssuer` domain model has a `ClientID` field but **no `ClientJWK` field** — `private_key_jwt` authentication is entirely unimplemented.

**Conformance Requirement**: The VCI wallet test modules ONLY support `private_key_jwt`, `mtls`, or `client_attestation` — `none` is not an option.

**Impact**: Blocks all VCI conformance certification.

---

### BUG-2: ~~VP Authorization Request Processing Fails Silently~~ → RESOLVED (Test Setup)

**Status**: ✅ Resolved — was a test setup issue, not a wallet bug.

**Original symptom**: Wallet showed "Verification Error" for all VP modules.

**Root cause (was two problems)**:
1. **Session teardown from full page navigation** (test setup): `presentCredential()` used `page.goto()` which reloaded the SPA, tearing down the WebSocket session mid-flow. Fixed by using SPA pushState navigation (same pattern as VCI tests).
2. **No matching credentials** (expected): After fixing the session issue, the VP flow now progresses correctly through `parsing_request` → `evaluating_verifier_trust` → `credential_selection`, but fails at credential selection because the wallet has no issued credentials matching the DCQL query. This is a direct consequence of BUG-1 — VCI issuance fails, so no credentials exist for VP to present.

**VP flow is now working correctly** — trust evaluation passes, credential selection runs, the error is legitimate "No matching credentials". Once BUG-1 is fixed and VCI can issue credentials, VP should work.

---

### BUG-3: VP alternate-happy-flow Module Config Issue

**Affects**: `oid4vp-1final-wallet-alternate-happy-flow` module only

**Symptom**: Module goes from CREATED → CONFIGURED → RUNNING but never reaches WAITING (times out)

**Possible Cause**: This module may use `presentation_definition` format instead of DCQL, and our config only provides DCQL. Need to check if the variant needs a `presentation_definition` section as well.

**Impact**: Minor — 1 of 14 modules.

---

## Files Modified

### go-wallet-backend (branch: feat/wmp-integration)
- `pkg/issuermetadata/resolver.go` — RFC 8615 URL fix
- `internal/metadata/issuer.go` — RFC 8615 URL fix
- `internal/engine/oid4vci.go` — RFC 8615 URL fix for OAuth AS metadata

### sirosid-tests
- `configs/conformance/vp-wallet-config.json` — Complete VP config with JWKS, x5c, DCQL
- `helpers/conformance-api.ts` — VP interaction URL extraction
- `specs/conformance/oid4vci-wallet.spec.ts` — client_auth_type reverted to private_key_jwt
- `specs/conformance/oid4vp-wallet.spec.ts` — CDP VA, redirect interception, VP flow fixes

### sirosid-dev/mocks/trust-pdp (from earlier session)
- `index.mjs` / `index.ts` — reason format, action.name mapping
