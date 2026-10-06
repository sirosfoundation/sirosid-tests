/**
 * Auth endpoint helpers (session-mode AS + legacy tolerance)
 *
 * go-wallet-backend is removing the legacy HMAC authorization server
 * (go-wallet-backend #100 / #429 / #436). After removal:
 *
 *  - /user/{register,login}-webauthn-{begin,finish}, /user/session/refresh and
 *    /auth/passkey/* WITHOUT `X-Token-Mode: session` answer
 *    HTTP 410 `legacy_tokens_disabled`;
 *  - the finish responses no longer carry `appToken` / `refreshToken`;
 *  - the client authenticates with `/auth/passkey/{register,login}/{begin,finish}`
 *    + `X-Token-Mode: session` (a session cookie is set) and obtains a short-lived
 *    ES256 access token from `POST /auth/token`.
 *
 * This is what wallet-frontend does (src/lib/auth/auth-server/AuthServerClient.ts).
 *
 * The suite must keep working against backends where the legacy endpoints are
 * still enabled, so the matchers below accept BOTH URL families and the token
 * helper falls back to a legacy `appToken` only when one was actually returned.
 */

import type { APIRequestContext, Page } from '@playwright/test';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';

/**
 * Audience / permissions requested for the harness' own backend calls.
 *
 * The frontend asks for `rwlid` (AuthTokens.MANIFEST.backend), but a passkey
 * session is capped at `as.default_max_tac` (default `rwl`) and /auth/token
 * answers 403 for anything above that. The specs only read account info and
 * rename credentials, so ask for the narrowest set that works on a default
 * backend; override with BACKEND_TOKEN_TAC.
 */
export const BACKEND_TOKEN_AUDIENCE = 'wallet-backend';
export const BACKEND_TOKEN_TAC = process.env.BACKEND_TOKEN_TAC || 'rwl';

/** Header that selects session mode on the AS passkey endpoints. */
export const SESSION_MODE_HEADERS = { 'X-Token-Mode': 'session' } as const;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0];
  }
}

// Session-mode (AS) URLs and legacy URLs. Anchored on the path so unrelated
// URLs that merely contain these words do not match.
const REGISTER_BEGIN = /\/(auth\/passkey\/register\/begin|user\/register-webauthn-begin)$/;
const REGISTER_FINISH = /\/(auth\/passkey\/register\/finish|user\/register-webauthn-finish)$/;
const LOGIN_BEGIN = /\/(auth\/passkey\/login\/begin|user\/login-webauthn-begin)$/;
const LOGIN_FINISH = /\/(auth\/passkey\/login\/finish|user\/login-webauthn-finish)$/;

export const isRegisterBeginUrl = (url: string): boolean => REGISTER_BEGIN.test(pathOf(url));
export const isRegisterFinishUrl = (url: string): boolean => REGISTER_FINISH.test(pathOf(url));
export const isLoginBeginUrl = (url: string): boolean => LOGIN_BEGIN.test(pathOf(url));
export const isLoginFinishUrl = (url: string): boolean => LOGIN_FINISH.test(pathOf(url));

/** Playwright `waitForResponse` predicates. */
export const registerFinishResponse = (r: { url(): string }): boolean => isRegisterFinishUrl(r.url());
export const loginFinishResponse = (r: { url(): string }): boolean => isLoginFinishUrl(r.url());

/**
 * Obtain a bearer token for backend API calls.
 *
 * Preference order:
 *  1. Session mode: `POST /auth/token` using the session cookie that the
 *     browser context received from the passkey finish call (ES256 access token).
 *  2. A legacy `appToken` returned by the finish call, but only if (1) failed
 *     and the backend actually returned one (legacy-enabled backends).
 *
 * Returns null if neither is available; callers decide whether that is a
 * skip or a failure.
 */
export async function getBackendAccessToken(
  page: Page,
  opts: { tenantId?: string; legacyAppToken?: string; aud?: string; tac?: string } = {},
): Promise<string | null> {
  const tenantId = opts.tenantId || 'default';
  // context.request shares the browser context's cookie jar, so the AS
  // session cookie set by /auth/passkey/*/finish is sent along.
  const resp = await page.context().request.post(`${BACKEND_URL}/auth/token`, {
    headers: { ...SESSION_MODE_HEADERS, 'X-Tenant-ID': tenantId },
    data: {
      aud: opts.aud ?? BACKEND_TOKEN_AUDIENCE,
      tac: opts.tac ?? BACKEND_TOKEN_TAC,
      tenant_id: tenantId,
    },
  }).catch(() => null);

  if (resp && resp.ok()) {
    const body = await resp.json().catch(() => null);
    if (body && typeof body.access_token === 'string' && body.access_token) {
      return body.access_token;
    }
  }
  return opts.legacyAppToken || null;
}

/** Result of probing whether the target backend still serves the legacy endpoints. */
export interface LegacyAuthStatus {
  /** true: legacy endpoints answer normally; false: they answer 410 legacy_tokens_disabled */
  enabled: boolean;
  status: number;
}

/**
 * Detect whether the target backend still has the legacy HMAC AS enabled.
 *
 * LEGACY_AUTH=enabled|disabled forces the expectation (so CI against a known
 * backend cannot silently pass on the wrong branch); the default `auto`
 * probes `POST /user/register-webauthn-begin`.
 */
export async function detectLegacyAuth(request: APIRequestContext): Promise<LegacyAuthStatus> {
  const forced = (process.env.LEGACY_AUTH || 'auto').toLowerCase();
  const resp = await request.post(`${BACKEND_URL}/user/register-webauthn-begin`, { data: {} });
  const body = await resp.json().catch(() => ({}));
  const disabled = resp.status() === 410 && body?.error === 'legacy_tokens_disabled';
  if (forced === 'enabled' && disabled) {
    throw new Error('LEGACY_AUTH=enabled but the backend answered 410 legacy_tokens_disabled');
  }
  if (forced === 'disabled' && !disabled) {
    throw new Error(`LEGACY_AUTH=disabled but /user/register-webauthn-begin answered ${resp.status()}`);
  }
  return { enabled: !disabled, status: resp.status() };
}
