# sirosid-tests Makefile
#
# E2E test suites for SIROS ID wallet ecosystem.
#
# Quick Start (with sirosid-dev):
#   cd ../sirosid-dev && make up
#   make test
#
# Against Other Environments:
#   FRONTEND_URL=https://wallet.qa.siros.org \
#   BACKEND_URL=https://api.qa.siros.org \
#   make test-public

.PHONY: help install test test-public test-admin test-webauthn \
        test-ci test-soft-fido2 test-vc test-vc-issuance test-vc-verification \
        test-vc-trust test-vc-e2e lint clean

# =============================================================================
# Configuration - Override via environment
# =============================================================================

# Required for all tests
FRONTEND_URL ?= http://localhost:3000
BACKEND_URL ?= http://localhost:8080

# Required for admin tests
ENGINE_URL ?= http://localhost:8082
ADMIN_URL ?= http://localhost:8081
ADMIN_TOKEN ?= e2e-test-admin-token-for-testing-purposes-only

# Optional service URLs (mock services)
MOCK_ISSUER_URL ?= http://localhost:9000
MOCK_VERIFIER_URL ?= http://localhost:9001
TRUST_PDP_URL ?= http://localhost:9091
VCTM_REGISTRY_URL ?= http://localhost:8097

# VC Services URLs (production-like stack)
VC_ISSUER_URL ?= http://localhost:9000
VC_VERIFIER_URL ?= http://localhost:9001
VC_MOCKAS_URL ?= http://localhost:9002
VC_APIGW_URL ?= http://localhost:9003
VC_REGISTRY_URL ?= http://localhost:9004

# go-trust URLs
GO_TRUST_ALLOW_URL ?= http://localhost:9095
GO_TRUST_WHITELIST_URL ?= http://localhost:9096
GO_TRUST_DENY_URL ?= http://localhost:9097

# Transport mode: auto | http | websocket
TRANSPORT_MODE ?= auto

# Common environment for test execution
TEST_ENV := FRONTEND_URL=$(FRONTEND_URL) \
            BACKEND_URL=$(BACKEND_URL) \
            ENGINE_URL=$(ENGINE_URL) \
            ADMIN_URL=$(ADMIN_URL) \
            ADMIN_TOKEN=$(ADMIN_TOKEN) \
            ISSUER_URL=$(MOCK_ISSUER_URL) \
            VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            MOCK_ISSUER_URL=$(MOCK_ISSUER_URL) \
            MOCK_VERIFIER_URL=$(MOCK_VERIFIER_URL) \
            TRUST_PDP_URL=$(TRUST_PDP_URL) \
            MOCK_PDP_URL=$(TRUST_PDP_URL) \
            VCTM_REGISTRY_URL=$(VCTM_REGISTRY_URL) \
            VC_ISSUER_URL=$(VC_ISSUER_URL) \
            VC_VERIFIER_URL=$(VC_VERIFIER_URL) \
            VC_MOCKAS_URL=$(VC_MOCKAS_URL) \
            VC_APIGW_URL=$(VC_APIGW_URL) \
            VC_REGISTRY_URL=$(VC_REGISTRY_URL) \
            GO_TRUST_ALLOW_URL=$(GO_TRUST_ALLOW_URL) \
            GO_TRUST_WHITELIST_URL=$(GO_TRUST_WHITELIST_URL) \
            GO_TRUST_DENY_URL=$(GO_TRUST_DENY_URL) \
            TRANSPORT_MODE=$(TRANSPORT_MODE)

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

# =============================================================================
# Help
# =============================================================================

help: ## Show this help
	@echo "$(GREEN)sirosid-tests$(NC) - E2E Test Suites"
	@echo ""
	@echo "$(GREEN)Test Targets (Mock Services):$(NC)"
	@echo "  make test          # Run all tests (requires admin access)"
	@echo "  make test-public   # Public tests only (no admin required)"
	@echo "  make test-admin    # Admin tests only"
	@echo "  make test-webauthn # WebAuthn browser tests"
	@echo "  make test-ci       # CI mode (headless, reporter)"
	@echo ""
	@echo "$(GREEN)VC Services Tests (Production-like):$(NC)"
	@echo "  make test-vc              # All VC tests"
	@echo "  make test-vc-issuance     # OpenID4VCI issuance"
	@echo "  make test-vc-verification # OpenID4VP verification"
	@echo "  make test-vc-trust        # VC + go-trust integration"
	@echo "  make test-vc-e2e          # Full E2E flows"
	@echo ""
	@echo "$(GREEN)Environment Configuration:$(NC)"
	@echo "  FRONTEND_URL = $(FRONTEND_URL)"
	@echo "  BACKEND_URL  = $(BACKEND_URL)"
	@echo "  ADMIN_URL    = $(ADMIN_URL)"
	@echo "  VC_ISSUER_URL = $(VC_ISSUER_URL)"
	@echo "  VC_VERIFIER_URL = $(VC_VERIFIER_URL)"
	@echo ""
	@echo "$(GREEN)Usage Examples:$(NC)"
	@echo "  # Against sirosid-dev (default)"
	@echo "  make test"
	@echo ""
	@echo "  # Against QA"
	@echo "  FRONTEND_URL=https://wallet.qa.siros.org \\"
	@echo "  BACKEND_URL=https://api.qa.siros.org \\"
	@echo "  ADMIN_URL=https://admin.qa.siros.org \\"
	@echo "  ADMIN_TOKEN=\$$QA_TOKEN make test"
	@echo ""
	@echo "  # Against production (public only)"
	@echo "  FRONTEND_URL=https://wallet.siros.org \\"
	@echo "  BACKEND_URL=https://api.siros.org make test-public"
	@echo ""

# =============================================================================
# Installation
# =============================================================================

install: ## Install dependencies
	npm install
	npx playwright install chromium

# =============================================================================
# Test Targets
# =============================================================================

test: install ## Run all tests (requires admin access)
	@echo "$(GREEN)Running all tests...$(NC)"
	@echo "  Target: $(FRONTEND_URL)"
	$(TEST_ENV) npx playwright test

test-public: install ## Run public tests only (no admin required)
	@echo "$(GREEN)Running public tests...$(NC)"
	@echo "  Target: $(FRONTEND_URL)"
	$(TEST_ENV) npx playwright test specs/public/

test-admin: install ## Run admin tests only
	@echo "$(GREEN)Running admin tests...$(NC)"
	@echo "  Target: $(ADMIN_URL)"
	$(TEST_ENV) npx playwright test specs/admin/

test-webauthn: install ## Run WebAuthn browser tests
	@echo "$(GREEN)Running WebAuthn tests...$(NC)"
	$(TEST_ENV) npx playwright test specs/webauthn/ --config=playwright.webauthn-ci.config.ts

test-ci: install ## CI mode with reporter
	@echo "$(GREEN)Running tests in CI mode...$(NC)"
	$(TEST_ENV) npx playwright test --reporter=github

# =============================================================================
# Specific Test Files
# =============================================================================

test-registry: install ## Run registry tests
	$(TEST_ENV) npx playwright test specs/public/registry.spec.ts

test-go-trust: install ## Run go-trust API tests
	$(TEST_ENV) npx playwright test specs/public/go-trust.spec.ts

test-credential: install ## Run credential flow tests
	$(TEST_ENV) npx playwright test specs/webauthn/credential-flow.spec.ts --config=playwright.webauthn-ci.config.ts

test-tenant: install ## Run tenant selector tests
	$(TEST_ENV) npx playwright test specs/webauthn/tenant-selector.spec.ts --config=playwright.webauthn-ci.config.ts

test-trust-integration: install ## Run trust integration tests
	$(TEST_ENV) npx playwright test specs/webauthn/trust-integration.spec.ts --config=playwright.webauthn-ci.config.ts

# =============================================================================
# VC Services Tests (Production-like Stack)
# =============================================================================

test-vc: install ## Run all VC services tests
	@echo "$(GREEN)Running VC services tests...$(NC)"
	@echo "  VC Issuer: $(VC_ISSUER_URL)"
	@echo "  VC Verifier: $(VC_VERIFIER_URL)"
	@echo "  VC API GW: $(VC_APIGW_URL)"
	$(TEST_ENV) npx playwright test specs/vc/

test-vc-issuance: install ## Run OpenID4VCI credential issuance tests
	@echo "$(GREEN)Running VC issuance tests...$(NC)"
	$(TEST_ENV) npx playwright test specs/vc/openid4vci.spec.ts

test-vc-verification: install ## Run OpenID4VP credential verification tests
	@echo "$(GREEN)Running VC verification tests...$(NC)"
	$(TEST_ENV) npx playwright test specs/vc/openid4vp.spec.ts

test-vc-trust: install ## Run VC + go-trust integration tests
	@echo "$(GREEN)Running VC trust integration tests...$(NC)"
	@echo "  go-trust-allow: $(GO_TRUST_ALLOW_URL)"
	@echo "  go-trust-whitelist: $(GO_TRUST_WHITELIST_URL)"
	@echo "  go-trust-deny: $(GO_TRUST_DENY_URL)"
	$(TEST_ENV) npx playwright test specs/vc/trust-integration.spec.ts

test-vc-e2e: install ## Run full E2E credential flows
	@echo "$(GREEN)Running E2E credential flow tests...$(NC)"
	$(TEST_ENV) npx playwright test specs/vc/e2e-flows.spec.ts

check-vc-env: ## Verify VC services connectivity
	@echo "$(GREEN)Checking VC services...$(NC)"
	@curl -sf $(VC_ISSUER_URL)/.well-known/openid-credential-issuer >/dev/null && \
		echo "  $(GREEN)✓$(NC) VC Issuer: $(VC_ISSUER_URL)" || \
		echo "  $(RED)✗$(NC) VC Issuer: $(VC_ISSUER_URL)"
	@curl -sf $(VC_VERIFIER_URL)/.well-known/openid-configuration >/dev/null && \
		echo "  $(GREEN)✓$(NC) VC Verifier: $(VC_VERIFIER_URL)" || \
		echo "  $(RED)✗$(NC) VC Verifier: $(VC_VERIFIER_URL)"
	@curl -sf $(VC_APIGW_URL)/.well-known/oauth-authorization-server >/dev/null && \
		echo "  $(GREEN)✓$(NC) VC API GW: $(VC_APIGW_URL)" || \
		echo "  $(RED)✗$(NC) VC API GW: $(VC_APIGW_URL)"
	@curl -sf $(VC_REGISTRY_URL)/health >/dev/null && \
		echo "  $(GREEN)✓$(NC) VC Registry: $(VC_REGISTRY_URL)" || \
		echo "  $(RED)✗$(NC) VC Registry: $(VC_REGISTRY_URL)"
	@curl -sf $(GO_TRUST_ALLOW_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) go-trust-allow: $(GO_TRUST_ALLOW_URL)" || \
		echo "  $(YELLOW)○$(NC) go-trust-allow: not running"
	@curl -sf $(GO_TRUST_WHITELIST_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) go-trust-whitelist: $(GO_TRUST_WHITELIST_URL)" || \
		echo "  $(YELLOW)○$(NC) go-trust-whitelist: not running"
	@curl -sf $(GO_TRUST_DENY_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) go-trust-deny: $(GO_TRUST_DENY_URL)" || \
		echo "  $(YELLOW)○$(NC) go-trust-deny: not running"

# =============================================================================
# Soft-FIDO2 Mode (requires display)
# =============================================================================

test-soft-fido2: install ## Run with soft-fido2 authenticator
	@echo "$(GREEN)Running tests with soft-fido2...$(NC)"
	$(TEST_ENV) npx playwright test specs/webauthn/ --config=playwright.real-webauthn.config.ts

# =============================================================================
# Utilities
# =============================================================================

lint: ## Run linter
	npx eslint specs/ helpers/ --ext .ts

check-env: ## Verify environment connectivity
	@echo "$(GREEN)Checking environment...$(NC)"
	@curl -sf $(FRONTEND_URL) >/dev/null && \
		echo "  $(GREEN)✓$(NC) Frontend: $(FRONTEND_URL)" || \
		echo "  $(RED)✗$(NC) Frontend: $(FRONTEND_URL)"
	@curl -sf $(BACKEND_URL)/health >/dev/null && \
		echo "  $(GREEN)✓$(NC) Backend: $(BACKEND_URL)" || \
		echo "  $(RED)✗$(NC) Backend: $(BACKEND_URL)"
	@curl -sf $(ADMIN_URL)/health >/dev/null 2>&1 && \
		echo "  $(GREEN)✓$(NC) Admin: $(ADMIN_URL)" || \
		echo "  $(YELLOW)○$(NC) Admin: $(ADMIN_URL) (not reachable or no admin access)"

clean: ## Clean test artifacts
	rm -rf test-results/ playwright-report/ .playwright/
